import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EncryptionService } from '../security/encryption.js';
import { readStoredProviderPayload } from './provider-transaction-payload.js';

export type TransactionDirection = 'incoming' | 'outgoing';

/**
 * Reads only the direction-specific provider party name. This deliberately
 * does not fall back to arbitrary payload fields: the account owner must not
 * accidentally become the displayed counterparty.
 */
export function providerCounterpartyName(
  transaction: unknown,
  direction: TransactionDirection
): string | null {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return null;
  const record = transaction as Record<string, unknown>;
  const party = record[direction === 'incoming' ? 'debtor' : 'creditor'];
  if (!party || typeof party !== 'object' || Array.isArray(party)) return null;
  const name = (party as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim()
    ? name.trim().slice(0, 2_000)
    : null;
}

/**
 * Repairs legacy transactions whose encrypted provider payload already
 * contains a direction-specific counterparty name. Existing names are never
 * overwritten, and this function never creates an IBAN-backed identity.
 */
export function backfillCounterpartyNamesFromProviderPayload({
  database,
  accountId,
  encryption,
  now = new Date()
}: {
  database: DatabaseSync;
  accountId: number;
  encryption: EncryptionService;
  now?: Date;
}): number {
  if (!Number.isSafeInteger(accountId) || accountId < 1 || Number.isNaN(now.getTime())) {
    throw new Error('Counterparty name backfill input is invalid.');
  }

  const rows = database.prepare(`
    SELECT id, direction, raw_payload_encrypted
    FROM transactions
    WHERE account_id = ?
      AND (counterparty_name IS NULL OR TRIM(counterparty_name) = '')
      AND raw_payload_encrypted IS NOT NULL
  `).all(accountId) as Array<{
    id: number;
    direction: TransactionDirection;
    raw_payload_encrypted: string | null;
  }>;
  const update = database.prepare(`
    UPDATE transactions
    SET counterparty_name = ?, updated_at = ?
    WHERE id = ?
      AND (counterparty_name IS NULL OR TRIM(counterparty_name) = '')
  `);
  const timestamp = now.toISOString();
  let updated = 0;

  for (const row of rows) {
    const payload = readStoredProviderPayload(row.raw_payload_encrypted, encryption);
    if (!payload) continue;
    const name = providerCounterpartyName(payload.detail, row.direction)
      ?? providerCounterpartyName(payload.list, row.direction);
    if (!name) continue;
    updated += Number(update.run(name, timestamp, row.id).changes);
  }

  return updated;
}

export function normalizeIban(iban: string): string {
  if (typeof iban !== 'string' || !iban.trim()) {
    throw new Error('IBAN must be a non-empty string.');
  }

  return iban.replace(/\s+/g, '').toUpperCase();
}

export function counterpartyId(iban: string, secret: string): string {
  if (!secret) throw new Error('COUNTERPARTY_HMAC_SECRET is not configured.');

  return crypto
    .createHmac('sha256', secret)
    .update(normalizeIban(iban), 'utf8')
    .digest('hex');
}

export function maskIban(iban: string): string {
  const normalized = normalizeIban(iban);
  if (normalized.length <= 8) return '••••';

  return `${normalized.slice(0, 4)}••••••${normalized.slice(-4)}`;
}
export interface CounterpartyRecord {
  counterparty_id: string;
  display_name: string | null;
  iban_encrypted: string | null;
}

export interface PublicCounterparty {
  counterparty_id: string;
  display_name: string | null;
  iban_masked: string | null;
}

/**
 * Builds the only counterparty shape that may be sent to a browser/API client.
 * The encrypted database column and the plaintext IBAN never leave this layer.
 */
export function toPublicCounterparty(
  record: CounterpartyRecord,
  encryption: EncryptionService
): PublicCounterparty {
  return {
    counterparty_id: record.counterparty_id,
    display_name: record.display_name,
    iban_masked: record.iban_encrypted
      ? maskIban(encryption.decrypt(record.iban_encrypted))
      : null
  };
}
