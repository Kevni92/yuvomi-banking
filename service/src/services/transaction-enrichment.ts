import type { DatabaseSync } from 'node:sqlite';
import { EnableBankingApiError, type EnableBankingClient } from '../enable-banking/client.js';
import type { EncryptionService } from '../security/encryption.js';
import { applyCategoryRulesForAccount } from './category-rules.js';
import { providerCounterpartyName } from './counterparty.js';
import { normalizeMerchantsForAccount } from './merchants.js';
import {
  mergeDetailPayload,
  readStoredProviderPayload,
  writeStoredProviderPayload
} from './provider-transaction-payload.js';

export const DEFAULT_MAX_DETAILS = 25;
export const DETAIL_CONCURRENCY = 3;

export interface EnrichAccountTransactionsOptions {
  database: DatabaseSync;
  client: EnableBankingClient;
  accountId: number;
  providerAccountId: string;
  encryption: EncryptionService;
  now?: Date;
  maxDetails?: number;
}

export interface EnrichAccountTransactionsResult {
  candidates: number;
  attempted: number;
  fetched: number;
  unavailable: number;
  failed: number;
  merchantsResolved: number;
}

interface Candidate {
  id: number;
  transaction_id: string | null;
  provider_detail_state: string;
  provider_detail_attempt_count: number;
  provider_detail_last_attempt_at: string | null;
  raw_payload_encrypted: string | null;
  direction: 'incoming' | 'outgoing';
}

export async function enrichAccountTransactions(options: EnrichAccountTransactionsOptions): Promise<EnrichAccountTransactionsResult> {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Enrichment time is invalid.');
  const limit = positiveLimit(options.maxDetails ?? DEFAULT_MAX_DETAILS);
  const candidates = candidatesForAccount(options.database, options.accountId, now).slice(0, limit);
  const result: EnrichAccountTransactionsResult = {
    candidates: candidates.length, attempted: 0, fetched: 0, unavailable: 0, failed: 0, merchantsResolved: 0
  };
  let stop = false;
  let index = 0;
  const workers = Array.from({ length: Math.min(DETAIL_CONCURRENCY, candidates.length) }, async () => {
    while (!stop) {
      const candidate = candidates[index++];
      if (!candidate) return;
      if (!candidate.transaction_id) {
        markUnavailable(options.database, candidate.id, now);
        result.unavailable += 1;
        continue;
      }
      result.attempted += 1;
      try {
        const detail = await options.client.getTransactionDetails(options.providerAccountId, candidate.transaction_id);
        persistDetail(options.database, candidate, detail, options.encryption, now);
        result.fetched += 1;
      } catch (error) {
        if (error instanceof EnableBankingApiError && error.status === 404) {
          markUnavailable(options.database, candidate.id, now);
          result.unavailable += 1;
        } else {
          markFailed(options.database, candidate.id, now);
          result.failed += 1;
          if (error instanceof EnableBankingApiError && error.status === 429) stop = true;
        }
      }
    }
  });
  await Promise.all(workers);
  result.merchantsResolved = normalizeMerchantsForAccount(options.database, options.accountId, now, options.encryption);
  applyCategoryRulesForAccount(options.database, options.accountId, now);
  return result;
}

export async function enrichTransactionById({
  database, client, transactionId, encryption, now = new Date()
}: {
  database: DatabaseSync;
  client: EnableBankingClient;
  transactionId: number;
  encryption: EncryptionService;
  now?: Date;
}): Promise<{ detailAvailable: boolean; detailFetched: boolean; merchantResolved: boolean; state: string }> {
  const row = database.prepare(`
    SELECT transactions.id, transactions.account_id, transactions.transaction_id,
           transactions.provider_detail_state, transactions.provider_detail_attempt_count,
           transactions.provider_detail_last_attempt_at, transactions.raw_payload_encrypted,
           transactions.direction,
           bank_accounts.provider_account_id
    FROM transactions JOIN bank_accounts ON bank_accounts.id = transactions.account_id
    WHERE transactions.id = ?
  `).get(transactionId) as (Candidate & { account_id: number; provider_account_id: string }) | undefined;
  if (!row?.transaction_id) {
    if (row) markUnavailable(database, row.id, now);
    return { detailAvailable: false, detailFetched: false, merchantResolved: false, state: 'unavailable' };
  }
  try {
    const detail = await client.getTransactionDetails(row.provider_account_id, row.transaction_id);
    persistDetail(database, row, detail, encryption, now);
    const merchantsResolved = normalizeMerchantsForAccount(database, row.account_id, now, encryption) > 0;
    applyCategoryRulesForAccount(database, row.account_id, now);
    return { detailAvailable: true, detailFetched: true, merchantResolved: merchantsResolved, state: 'fetched' };
  } catch (error) {
    if (error instanceof EnableBankingApiError && error.status === 404) {
      markUnavailable(database, row.id, now);
      return { detailAvailable: true, detailFetched: false, merchantResolved: false, state: 'unavailable' };
    }
    markFailed(database, row.id, now);
    throw error;
  }
}

function candidatesForAccount(database: DatabaseSync, accountId: number, now: Date): Candidate[] {
  const rows = database.prepare(`
    SELECT id, transaction_id, provider_detail_state, provider_detail_attempt_count,
           provider_detail_last_attempt_at, raw_payload_encrypted, direction
    FROM transactions
    WHERE account_id = ? AND transaction_id IS NOT NULL
      AND provider_detail_state <> 'fetched'
    ORDER BY CASE
      WHEN merchant_name IS NULL AND counterparty_name IS NULL AND (purpose IS NULL OR purpose = '') THEN 0
      WHEN merchant_key IS NULL THEN 1 ELSE 2 END,
      COALESCE(booking_date, value_date, transaction_date) DESC, id DESC
  `).all(accountId) as unknown as Candidate[];
  return rows.filter((row) => retryDue(row, now));
}

function retryDue(row: Candidate, now: Date): boolean {
  if (row.provider_detail_state !== 'failed') return true;
  const previous = row.provider_detail_last_attempt_at ? Date.parse(row.provider_detail_last_attempt_at) : Number.NaN;
  if (!Number.isFinite(previous)) return true;
  const pause = row.provider_detail_attempt_count <= 1 ? 0
    : row.provider_detail_attempt_count === 2 ? 6 * 60 * 60_000 : 24 * 60 * 60_000;
  return now.getTime() >= previous + pause;
}

function persistDetail(database: DatabaseSync, row: Candidate, detail: Record<string, unknown>, encryption: EncryptionService, now: Date): void {
  const timestamp = now.toISOString();
  const payload = mergeDetailPayload(readStoredProviderPayload(row.raw_payload_encrypted, encryption), detail, timestamp);
  database.prepare(`
    UPDATE transactions SET raw_payload_encrypted = ?, provider_detail_state = 'fetched',
      provider_detail_last_attempt_at = ?, provider_detail_fetched_at = ?,
      provider_detail_attempt_count = provider_detail_attempt_count + 1,
      counterparty_name = COALESCE(?, counterparty_name), purpose = COALESCE(?, purpose),
      mcc = COALESCE(?, mcc), provider_note = COALESCE(?, provider_note), reference_number = COALESCE(?, reference_number),
      reference_number_schema = COALESCE(?, reference_number_schema),
      bank_transaction_code = COALESCE(?, bank_transaction_code), updated_at = ?
    WHERE id = ?
  `).run(
    writeStoredProviderPayload(payload, encryption), timestamp, timestamp,
    counterpartyName(detail, row.direction), purpose(detail.remittance_information), string(detail.merchant_category_code),
    string(detail.note), string(detail.reference_number), string(detail.reference_number_schema),
    stableValue(detail.bank_transaction_code), timestamp, row.id
  );
}

function counterpartyName(detail: Record<string, unknown>, direction: Candidate['direction']): string | null {
  return providerCounterpartyName(detail, direction);
}

function purpose(value: unknown): string | null {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim()).filter(Boolean).join(' ').slice(0, 2_000) || null;
  }
  return string(value);
}

function markUnavailable(database: DatabaseSync, id: number, now: Date): void {
  database.prepare(`UPDATE transactions SET provider_detail_state = 'unavailable',
    provider_detail_last_attempt_at = ?, provider_detail_attempt_count = provider_detail_attempt_count + 1,
    updated_at = ? WHERE id = ?`).run(now.toISOString(), now.toISOString(), id);
}

function markFailed(database: DatabaseSync, id: number, now: Date): void {
  database.prepare(`UPDATE transactions SET provider_detail_state = 'failed',
    provider_detail_last_attempt_at = ?, provider_detail_attempt_count = provider_detail_attempt_count + 1,
    updated_at = ? WHERE id = ?`).run(now.toISOString(), now.toISOString(), id);
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2_000) : null;
}

function stableValue(value: unknown): string | null {
  if (!value || typeof value !== 'object') return string(value);
  const entry = value as Record<string, unknown>;
  return JSON.stringify({ code: string(entry.code), sub_code: string(entry.sub_code), description: string(entry.description) });
}

function positiveLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('Detail enrichment limit is invalid.');
  return value;
}
