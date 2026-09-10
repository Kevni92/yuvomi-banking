import crypto from 'node:crypto';
import type { EncryptionService } from '../security/encryption.js';

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
