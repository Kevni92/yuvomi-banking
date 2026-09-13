import type { DatabaseSync } from 'node:sqlite';
import type { EncryptionService } from '../security/encryption.js';
import { counterpartyId } from './counterparty.js';
import { normalizeMerchant } from './merchants.js';
import {
  detectPaymentIntermediary,
  isPaymentProcessor,
  isTechnicalPaymentParty
} from './payment-intermediaries.js';
import { readStoredProviderPayload } from './provider-transaction-payload.js';
import { deriveTransactionSemantics } from './transaction-semantics.js';
import {
  extractProviderObservation,
  type ObservationDirection,
  type ObservationStatus
} from './transaction-observations.js';

interface TransactionRow {
  id: number;
  account_id: number;
  direction: ObservationDirection;
  status: ObservationStatus;
  counterparty_id: string | null;
  counterparty_name: string | null;
  purpose: string | null;
  merchant_name: string | null;
  merchant_key: string | null;
  merchant_resolution_method: string | null;
  merchant_evidence_source: string | null;
  bank_transaction_code: string | null;
  raw_payload_encrypted: string | null;
  yuvomi_user_id: number;
}

interface ObservationRow {
  transaction_id: number;
  status: ObservationStatus;
  direction: ObservationDirection;
  counterparty_name: string | null;
  purpose: string | null;
  provider_merchant_name: string | null;
  bank_transaction_code: string | null;
}

interface MerchantAlias {
  alias_normalized: string;
  display_name: string;
  merchant_key: string | null;
  priority: number;
}

interface ResolutionCandidate {
  entityType: 'merchant' | 'own_transfer' | 'counterparty';
  displayName: string;
  merchantKey: string | null;
  source: string;
  confidence: number;
}

export interface TransactionResolutionResult {
  considered: number;
  resolved: number;
  updatedTransactions: number;
}

export function resolveTransactionsForAccount({
  database,
  accountId,
  encryption,
  hmacSecret,
  now = new Date()
}: {
  database: DatabaseSync;
  accountId: number;
  encryption: EncryptionService;
  hmacSecret: string;
  now?: Date;
}): TransactionResolutionResult {
  if (!Number.isSafeInteger(accountId) || accountId < 1 || Number.isNaN(now.getTime())) {
    throw new Error('Transaction resolution input is invalid.');
  }
  if (!hmacSecret.trim()) throw new Error('COUNTERPARTY_HMAC_SECRET is not configured.');

  const transactions = database.prepare(`
    SELECT transactions.id, transactions.account_id, transactions.direction,
           transactions.status, counterparties.counterparty_id,
           transactions.counterparty_name, transactions.purpose,
           transactions.merchant_name, transactions.merchant_key,
           transactions.merchant_resolution_method, transactions.merchant_evidence_source,
           transactions.bank_transaction_code, transactions.raw_payload_encrypted,
           enable_banking_connections.yuvomi_user_id
    FROM transactions
    JOIN bank_accounts ON bank_accounts.id = transactions.account_id
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    LEFT JOIN counterparties ON counterparties.id = transactions.counterparty_ref
    WHERE transactions.account_id = ?
  `).all(accountId) as unknown as TransactionRow[];
  if (!transactions.length) return { considered: 0, resolved: 0, updatedTransactions: 0 };

  const userId = Number(transactions[0].yuvomi_user_id);
  const observations = database.prepare(`
    SELECT transaction_observations.transaction_id, transaction_observations.status,
           transaction_observations.direction, transaction_observations.counterparty_name,
           transaction_observations.purpose, transaction_observations.provider_merchant_name,
           transaction_observations.bank_transaction_code
    FROM transaction_observations
    JOIN transactions ON transactions.id = transaction_observations.transaction_id
    WHERE transactions.account_id = ?
    ORDER BY transaction_observations.observed_at DESC, transaction_observations.id DESC
  `).all(accountId) as unknown as ObservationRow[];
  const observationsByTransaction = groupObservations(observations);
  const aliases = loadAliases(database);
  const ownAccounts = ownAccountIdentities(database, userId, encryption, hmacSecret);
  const timestamp = now.toISOString();
  const upsertResolution = database.prepare(`
    INSERT INTO transaction_resolutions (
      transaction_id, entity_type, display_name, merchant_key,
      payment_method, intermediary_name, source, confidence, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transaction_id) DO UPDATE SET
      entity_type = excluded.entity_type,
      display_name = excluded.display_name,
      merchant_key = excluded.merchant_key,
      payment_method = excluded.payment_method,
      intermediary_name = excluded.intermediary_name,
      source = excluded.source,
      confidence = excluded.confidence,
      resolved_at = excluded.resolved_at
  `);
  const updateTransaction = database.prepare(`
    UPDATE transactions SET
      merchant_name = ?, merchant_key = ?, merchant_evidence_source = ?,
      merchant_resolution_method = 'external_enrichment', updated_at = ?
    WHERE id = ? AND COALESCE(merchant_resolution_method, '') != 'manual'
      AND (
        COALESCE(merchant_name, '') != COALESCE(?, '')
        OR COALESCE(merchant_key, '') != COALESCE(?, '')
        OR COALESCE(merchant_evidence_source, '') != COALESCE(?, '')
        OR COALESCE(merchant_resolution_method, '') != 'external_enrichment'
      )
  `);

  let resolved = 0;
  let updatedTransactions = 0;
  for (const transaction of transactions) {
    const transactionObservations = observationsByTransaction.get(transaction.id) ?? [];
    const rawObservations = storedPayloadObservations(transaction, encryption);
    const allObservations = [...transactionObservations, ...rawObservations];
    const paymentMethod = resolvePaymentMethod(transaction, allObservations);
    const intermediary = resolveIntermediary(transaction, allObservations);
    const candidate = resolveCandidate(transaction, allObservations, aliases, ownAccounts);
    if (!candidate) continue;

    upsertResolution.run(
      transaction.id,
      candidate.entityType,
      candidate.displayName,
      candidate.merchantKey,
      paymentMethod,
      intermediary,
      candidate.source,
      candidate.confidence,
      timestamp
    );
    resolved += 1;

    if (transaction.merchant_resolution_method === 'manual') continue;
    updatedTransactions += Number(updateTransaction.run(
      candidate.displayName,
      candidate.merchantKey,
      candidate.source,
      timestamp,
      transaction.id,
      candidate.displayName,
      candidate.merchantKey,
      candidate.source
    ).changes);
  }

  return { considered: transactions.length, resolved, updatedTransactions };
}

export function resolveTransactionById({
  database,
  transactionId,
  encryption,
  hmacSecret,
  now = new Date()
}: {
  database: DatabaseSync;
  transactionId: number;
  encryption: EncryptionService;
  hmacSecret: string;
  now?: Date;
}): TransactionResolutionResult {
  const row = database.prepare('SELECT account_id FROM transactions WHERE id = ? LIMIT 1')
    .get(transactionId) as { account_id: number } | undefined;
  if (!row) return { considered: 0, resolved: 0, updatedTransactions: 0 };
  return resolveTransactionsForAccount({
    database,
    accountId: Number(row.account_id),
    encryption,
    hmacSecret,
    now
  });
}

function resolveCandidate(
  transaction: TransactionRow,
  observations: ObservationRow[],
  aliases: MerchantAlias[],
  ownAccounts: Map<string, { id: number; name: string }>
): ResolutionCandidate | null {
  if (transaction.counterparty_id) {
    const own = ownAccounts.get(transaction.counterparty_id);
    if (own && own.id !== transaction.account_id) {
      return {
        entityType: 'own_transfer',
        displayName: `Umbuchung → ${own.name}`,
        merchantKey: null,
        source: 'own_account',
        confidence: 1
      };
    }
  }

  if (transaction.merchant_resolution_method === 'manual' && transaction.merchant_name) {
    return {
      entityType: 'merchant',
      displayName: transaction.merchant_name,
      merchantKey: transaction.merchant_key,
      source: transaction.merchant_evidence_source || 'manual',
      confidence: 1
    };
  }

  const candidates: ResolutionCandidate[] = [];
  if (transaction.merchant_name && !isRejectedMerchant(transaction.merchant_name)) {
    candidates.push(canonicalizeCandidate({
      entityType: 'merchant',
      displayName: transaction.merchant_name,
      merchantKey: transaction.merchant_key,
      source: transaction.merchant_evidence_source || 'local_registry',
      confidence: transaction.merchant_resolution_method === 'external_enrichment' ? 0.93 : 0.98
    }, aliases));
  }

  for (const observation of observations) {
    if (observation.provider_merchant_name && !isRejectedMerchant(observation.provider_merchant_name)) {
      candidates.push(canonicalizeCandidate({
        entityType: 'merchant',
        displayName: cleanMerchantLabel(observation.provider_merchant_name),
        merchantKey: null,
        source: `observation.${statusLabel(observation.status)}.provider_merchant`,
        confidence: observation.status === 'BOOK' ? 0.99 : 0.97
      }, aliases));
    }

    const descriptor = extractCardDescriptorMerchant(observation.counterparty_name);
    if (descriptor && !isRejectedMerchant(descriptor)) {
      candidates.push(canonicalizeCandidate({
        entityType: 'merchant',
        displayName: descriptor,
        merchantKey: null,
        source: `observation.${statusLabel(observation.status)}.counterparty_name`,
        confidence: observation.status === 'PDNG' ? 0.95 : 0.91
      }, aliases));
    }

    const remittanceMerchant = extractRemittanceMerchant(observation.purpose);
    if (remittanceMerchant && !isRejectedMerchant(remittanceMerchant)) {
      candidates.push(canonicalizeCandidate({
        entityType: 'merchant',
        displayName: remittanceMerchant,
        merchantKey: null,
        source: `observation.${statusLabel(observation.status)}.purpose`,
        confidence: 0.93
      }, aliases));
    }
  }

  const currentRemittance = extractRemittanceMerchant(transaction.purpose);
  if (currentRemittance && !isRejectedMerchant(currentRemittance)) {
    candidates.push(canonicalizeCandidate({
      entityType: 'merchant',
      displayName: currentRemittance,
      merchantKey: null,
      source: 'transaction.purpose',
      confidence: 0.92
    }, aliases));
  }

  const valid = candidates
    .filter((candidate) => Boolean(candidate.displayName.trim()))
    .sort((left, right) => right.confidence - left.confidence || sourceRank(left.source) - sourceRank(right.source));
  return valid[0] ?? null;
}

function canonicalizeCandidate(candidate: ResolutionCandidate, aliases: MerchantAlias[]): ResolutionCandidate {
  const normalized = normalizeAlias(candidate.displayName);
  const alias = aliases.find((entry) => normalized === entry.alias_normalized)
    ?? aliases.find((entry) => (` ${normalized} `).includes(` ${entry.alias_normalized} `));
  if (alias) {
    return {
      ...candidate,
      displayName: alias.display_name,
      merchantKey: alias.merchant_key,
      confidence: Math.max(candidate.confidence, 0.96)
    };
  }
  const registry = normalizeMerchant(candidate.displayName);
  return registry
    ? { ...candidate, displayName: registry.name, merchantKey: registry.key, confidence: Math.max(candidate.confidence, 0.97) }
    : candidate;
}

function storedPayloadObservations(transaction: TransactionRow, encryption: EncryptionService): ObservationRow[] {
  const payload = readStoredProviderPayload(transaction.raw_payload_encrypted, encryption);
  if (!payload) return [];
  const rows: ObservationRow[] = [];
  for (const source of [payload.list, payload.detail]) {
    if (!source || !Object.keys(source).length) continue;
    const extracted = extractProviderObservation(source, transaction.direction, transaction.status);
    rows.push({
      transaction_id: transaction.id,
      status: extracted.status,
      direction: extracted.direction,
      counterparty_name: extracted.counterpartyName,
      purpose: extracted.purpose,
      provider_merchant_name: extracted.providerMerchantName,
      bank_transaction_code: extracted.bankTransactionCode
    });
  }
  return rows;
}

function resolvePaymentMethod(transaction: TransactionRow, observations: ObservationRow[]): string | null {
  const values = [transaction.bank_transaction_code, ...observations.map((row) => row.bank_transaction_code)];
  for (const value of values) {
    const method = deriveTransactionSemantics(value).paymentMethod;
    if (method) return method;
  }
  return null;
}

function resolveIntermediary(transaction: TransactionRow, observations: ObservationRow[]): string | null {
  const values = [transaction.counterparty_name, ...observations.map((row) => row.counterparty_name)];
  const detected = detectPaymentIntermediary(...values);
  return detected?.name ?? null;
}

function ownAccountIdentities(
  database: DatabaseSync,
  yuvomiUserId: number,
  encryption: EncryptionService,
  hmacSecret: string
): Map<string, { id: number; name: string }> {
  const rows = database.prepare(`
    SELECT bank_accounts.id, bank_accounts.display_name, bank_accounts.alias,
           bank_accounts.iban_encrypted
    FROM bank_accounts
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    WHERE enable_banking_connections.yuvomi_user_id = ?
      AND bank_accounts.iban_encrypted IS NOT NULL
  `).all(yuvomiUserId) as Array<{
    id: number;
    display_name: string | null;
    alias: string | null;
    iban_encrypted: string;
  }>;
  const result = new Map<string, { id: number; name: string }>();
  for (const row of rows) {
    try {
      const iban = encryption.decrypt(row.iban_encrypted);
      result.set(counterpartyId(iban, hmacSecret), {
        id: Number(row.id),
        name: row.alias?.trim() || row.display_name?.trim() || `Konto ${row.id}`
      });
    } catch {
      // A broken encrypted account must not prevent resolving other transactions.
    }
  }
  return result;
}

function loadAliases(database: DatabaseSync): MerchantAlias[] {
  return database.prepare(`
    SELECT alias_normalized, display_name, merchant_key, priority
    FROM merchant_aliases
    WHERE enabled = 1
    ORDER BY priority, length(alias_normalized) DESC, id
  `).all() as unknown as MerchantAlias[];
}

function groupObservations(rows: ObservationRow[]): Map<number, ObservationRow[]> {
  const result = new Map<number, ObservationRow[]>();
  for (const row of rows) {
    const group = result.get(Number(row.transaction_id)) ?? [];
    group.push(row);
    result.set(Number(row.transaction_id), group);
  }
  return result;
}

function extractCardDescriptorMerchant(value: string | null): string | null {
  if (!value || isTechnicalPaymentParty(value) || isPaymentProcessor(value)) return null;
  const text = value.trim();
  const star = /^[A-Z0-9][A-Z0-9 ._-]{1,12}\*([^*]{2,100})$/i.exec(text);
  if (!star) return null;
  return cleanMerchantLabel(star[1]);
}

function extractRemittanceMerchant(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  const patterns = [
    /(?:ihr\s+)?einkauf\s+bei\s+(.+?)(?=\s+(?:referenz|reference|ref\.?|transaktion|transaction)\b|[;,]|$)/i,
    /(?:merchant|haendler|händler)\s*[:=-]\s*(.+?)(?=[;,]|$)/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    const candidate = match?.[1] ? cleanMerchantLabel(match[1]) : null;
    if (candidate) return candidate;
  }
  return null;
}

function cleanMerchantLabel(value: string): string {
  return value
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+(?:DE\d{3,}|[A-Z]{0,4}\d{5,}[A-Z0-9-]*)\s*$/i, '')
    .replace(/[;,.:\-\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

function isRejectedMerchant(value: string): boolean {
  return isTechnicalPaymentParty(value) || isPaymentProcessor(value) || value.trim().length < 2;
}

function normalizeAlias(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function statusLabel(status: ObservationStatus): string {
  return status === 'PDNG' ? 'pending' : status === 'BOOK' ? 'booked' : 'unknown';
}

function sourceRank(source: string): number {
  if (source === 'own_account') return 0;
  if (source.includes('provider_merchant')) return 1;
  if (source.includes('pending.counterparty_name')) return 2;
  if (source.includes('.purpose')) return 3;
  return 4;
}
