import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { counterpartyId, normalizeIban } from '../services/counterparty.js';
import type { EncryptionService } from '../security/encryption.js';

export interface ProviderTransaction {
  entry_reference?: unknown;
  transaction_id?: unknown;
  merchant_category_code?: unknown;
  transaction_amount?: {
    amount?: unknown;
    currency?: unknown;
  };
  creditor?: { name?: unknown };
  creditor_account?: { iban?: unknown };
  debtor?: { name?: unknown };
  debtor_account?: { iban?: unknown };
  credit_debit_indicator?: unknown;
  booking_date?: unknown;
  value_date?: unknown;
  transaction_date?: unknown;
  remittance_information?: unknown;
  [key: string]: unknown;
}

export interface ImportTransactionsOptions {
  database: DatabaseSync;
  accountId: number;
  transactions: ProviderTransaction[];
  hmacSecret: string;
  encryption: EncryptionService;
}

export interface ImportTransactionsResult {
  inserted: number;
  updated: number;
}

export function importTransactions({
  database,
  accountId,
  transactions,
  hmacSecret,
  encryption
}: ImportTransactionsOptions): ImportTransactionsResult {
  if (!Number.isInteger(accountId) || accountId < 1) {
    throw new Error('Banking account ID is invalid.');
  }
  if (!hmacSecret.trim()) {
    throw new Error('COUNTERPARTY_HMAC_SECRET is not configured.');
  }

  const result: ImportTransactionsResult = { inserted: 0, updated: 0 };
  const findExisting = database.prepare(
    'SELECT id FROM transactions WHERE account_id = ? AND provider_transaction_id = ?'
  );
  const findCounterparty = database.prepare(
    'SELECT id FROM counterparties WHERE counterparty_id = ?'
  );
  const upsertCounterparty = database.prepare(`
    INSERT INTO counterparties (
      counterparty_id, display_name, iban_encrypted, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(counterparty_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, counterparties.display_name),
      iban_encrypted = COALESCE(counterparties.iban_encrypted, excluded.iban_encrypted),
      updated_at = excluded.updated_at
  `);
  const upsertTransaction = database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, booking_date, value_date,
      amount, currency, direction, counterparty_ref, counterparty_name,
      purpose, mcc, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, provider_transaction_id) DO UPDATE SET
      booking_date = excluded.booking_date,
      value_date = excluded.value_date,
      amount = excluded.amount,
      currency = excluded.currency,
      direction = excluded.direction,
      counterparty_ref = excluded.counterparty_ref,
      counterparty_name = excluded.counterparty_name,
      purpose = excluded.purpose,
      mcc = excluded.mcc,
      updated_at = excluded.updated_at
  `);

  database.exec('BEGIN IMMEDIATE;');
  try {
    for (const transaction of transactions) {
      const normalized = normalizeTransaction(transaction, hmacSecret, encryption);
      const existing = findExisting.get(accountId, normalized.providerTransactionId);
      let counterpartyRef: number | null = null;

      if (normalized.counterparty) {
        const timestamp = new Date().toISOString();
        upsertCounterparty.run(
          normalized.counterparty.id,
          normalized.counterparty.name,
          normalized.counterparty.ibanEncrypted,
          timestamp,
          timestamp
        );
        const row = findCounterparty.get(normalized.counterparty.id) as { id: number } | undefined;
        counterpartyRef = row?.id ?? null;
      }

      const timestamp = new Date().toISOString();
      upsertTransaction.run(
        accountId,
        normalized.providerTransactionId,
        normalized.bookingDate,
        normalized.valueDate,
        normalized.amount,
        normalized.currency,
        normalized.direction,
        counterpartyRef,
        normalized.counterparty?.name ?? null,
        normalized.purpose,
        normalized.mcc,
        timestamp,
        timestamp
      );

      if (existing) result.updated += 1;
      else result.inserted += 1;
    }
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the original import error.
    }
    throw error;
  }

  return result;
}

interface NormalizedTransaction {
  providerTransactionId: string;
  bookingDate: string | null;
  valueDate: string | null;
  amount: number;
  currency: string;
  direction: 'incoming' | 'outgoing';
  counterparty: {
    id: string;
    name: string | null;
    ibanEncrypted: string;
  } | null;
  purpose: string | null;
  mcc: string | null;
}

function normalizeTransaction(
  transaction: ProviderTransaction,
  hmacSecret: string,
  encryption: EncryptionService
): NormalizedTransaction {
  const amountValue = transaction.transaction_amount?.amount;
  const amount = typeof amountValue === 'number' ? amountValue : Number(amountValue);
  if (!Number.isFinite(amount) || Math.abs(amount) > 1_000_000_000_000) {
    throw new Error('Provider transaction amount is invalid.');
  }

  const currency = stringValue(transaction.transaction_amount?.currency)?.toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error('Provider transaction currency is invalid.');
  }

  const indicator = stringValue(transaction.credit_debit_indicator);
  if (indicator !== 'CRDT' && indicator !== 'DBIT') {
    throw new Error('Provider transaction direction is invalid.');
  }
  const direction = indicator === 'CRDT' ? 'incoming' : 'outgoing';
  const counterpartySource = direction === 'incoming'
    ? { party: transaction.debtor, account: transaction.debtor_account }
    : { party: transaction.creditor, account: transaction.creditor_account };
  const iban = stringValue(counterpartySource.account?.iban);
  const name = stringValue(counterpartySource.party?.name);
  const counterparty = iban
    ? {
        id: counterpartyId(iban, hmacSecret),
        name,
        ibanEncrypted: encryption.encrypt(normalizeIban(iban))
      }
    : null;
  const bookingDate = dateValue(transaction.booking_date);
  const valueDate = dateValue(transaction.value_date);
  const purpose = purposeValue(transaction.remittance_information);
  const mcc = stringValue(transaction.merchant_category_code);
  const providerReference = stringValue(transaction.entry_reference);

  return {
    providerTransactionId: providerReference ?? fallbackTransactionId({
      amount,
      currency,
      direction,
      bookingDate,
      valueDate,
      counterpartyId: counterparty?.id ?? null,
      name,
      purpose,
      transactionId: stringValue(transaction.transaction_id)
    }),
    bookingDate,
    valueDate,
    amount,
    currency,
    direction,
    counterparty,
    purpose,
    mcc
  };
}

function fallbackTransactionId(value: Record<string, unknown>): string {
  return `fallback-${crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function dateValue(value: unknown): string | null {
  const date = stringValue(value);
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function purposeValue(value: unknown): string | null {
  if (!Array.isArray(value)) return stringValue(value)?.slice(0, 2_000) ?? null;
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 2_000) || null;
}
