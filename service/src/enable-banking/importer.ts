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
  reference_number?: unknown;
  reference_number_schema?: unknown;
  remittance_information?: unknown;
  creditor_account_additional_identification?: unknown;
  debtor_account_additional_identification?: unknown;
  bank_transaction_code?: unknown;
  note?: unknown;
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
      account_id, provider_transaction_id, entry_reference, transaction_id,
      booking_date, value_date, amount_cents, currency, direction,
      counterparty_ref, counterparty_name, purpose, mcc, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, provider_transaction_id) DO UPDATE SET
      entry_reference = COALESCE(excluded.entry_reference, transactions.entry_reference),
      transaction_id = COALESCE(excluded.transaction_id, transactions.transaction_id),
      booking_date = excluded.booking_date,
      value_date = excluded.value_date,
      amount_cents = excluded.amount_cents,
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
      const existing = findExisting.get(accountId, normalized.deduplicationKey);
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
        normalized.deduplicationKey,
        normalized.entryReference,
        normalized.transactionId,
        normalized.bookingDate,
        normalized.valueDate,
        normalized.amountCents,
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
  deduplicationKey: string;
  entryReference: string | null;
  transactionId: string | null;
  bookingDate: string | null;
  valueDate: string | null;
  amountCents: number;
  currency: string;
  direction: 'incoming' | 'outgoing';
  counterparty: {
    id: string;
    name: string | null;
    ibanEncrypted: string;
  } | null;
  purpose: string | null;
  mcc: string | null;
  transactionDate: string | null;
  referenceNumber: string | null;
  referenceNumberSchema: string | null;
  counterpartyAdditionalIdentification: string | null;
  bankTransactionCode: string | null;
}

function normalizeTransaction(
  transaction: ProviderTransaction,
  hmacSecret: string,
  encryption: EncryptionService
): NormalizedTransaction {
  const currency = stringValue(transaction.transaction_amount?.currency)?.toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error('Provider transaction currency is invalid.');
  }

  const amountCents = parseMinorUnits(transaction.transaction_amount?.amount, currency);
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
  const transactionDate = dateValue(transaction.transaction_date);
  const purpose = purposeValue(transaction.remittance_information);
  const mcc = stringValue(transaction.merchant_category_code);
  const entryReference = stringValue(transaction.entry_reference);
  const transactionId = stringValue(transaction.transaction_id);
  const referenceNumber = stringValue(transaction.reference_number);
  const referenceNumberSchema = stringValue(transaction.reference_number_schema);
  const counterpartyAdditionalIdentification = additionalIdentificationValue(
    direction === 'incoming'
      ? transaction.debtor_account_additional_identification
      : transaction.creditor_account_additional_identification
  );
  const bankTransactionCode = stableValue(transaction.bank_transaction_code);
  const normalized: NormalizedTransaction = {
    deduplicationKey: '',
    entryReference,
    transactionId,
    bookingDate,
    valueDate,
    amountCents,
    currency,
    direction,
    counterparty,
    purpose,
    mcc,
    transactionDate,
    referenceNumber,
    referenceNumberSchema,
    counterpartyAdditionalIdentification,
    bankTransactionCode
  };

  normalized.deduplicationKey = entryReference
    ? entryReference
    : fallbackTransactionKey(normalized);
  return normalized;
}

/** Parse provider decimal strings exactly into integer minor units. */
function parseMinorUnits(value: unknown, currency: string): number {
  const text = typeof value === 'number'
    ? (Number.isFinite(value) ? value.toString() : '')
    : stringValue(value) ?? '';
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error('Provider transaction amount is invalid.');

  // Banking currently stores EUR accounts, whose minor unit is the cent. Keep
  // the explicit currency argument so adding other currencies is deliberate.
  const minorDigits = currency === 'JPY' ? 0 : 2;
  const fraction = match[3] ?? '';
  if (fraction.length > minorDigits && /[^0]/.test(fraction.slice(minorDigits))) {
    throw new Error('Provider transaction amount has unsupported precision.');
  }
  const major = BigInt(match[2]);
  const minor = BigInt(
    fraction.slice(0, minorDigits).padEnd(minorDigits, '0') || '0'
  );
  const units = major * (10n ** BigInt(minorDigits)) + minor;
  const signedUnits = match[1] === '-' ? -units : units;
  const result = Number(signedUnits);
  if (!Number.isSafeInteger(result) || Math.abs(result) > 100_000_000_000_000) {
    throw new Error('Provider transaction amount is invalid.');
  }
  return result;
}

function fallbackTransactionKey(value: NormalizedTransaction): string {
  const canonical = JSON.stringify({
    amount_cents: value.amountCents,
    currency: value.currency,
    direction: value.direction,
    booking_date: value.bookingDate,
    value_date: value.valueDate,
    transaction_date: value.transactionDate,
    counterparty_id: value.counterparty?.id ?? null,
    counterparty_name: normalizeForFingerprint(value.counterparty?.name ?? null),
    purpose: normalizeForFingerprint(value.purpose),
    mcc: value.mcc,
    reference_number: value.referenceNumber,
    reference_number_schema: value.referenceNumberSchema,
    counterparty_additional_identification: value.counterpartyAdditionalIdentification,
    bank_transaction_code: value.bankTransactionCode
  });
  return `fingerprint:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
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

function normalizeForFingerprint(value: string | null): string | null {
  return value
    ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
    : null;
}

function additionalIdentificationValue(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return [stringValue(record.scheme_name), stringValue(record.identification)]
    .filter((part): part is string => Boolean(part))
    .join(':') || null;
}

function stableValue(value: unknown): string | null {
  if (!value || typeof value !== 'object') return stringValue(value);
  const record = value as Record<string, unknown>;
  return JSON.stringify({
    code: stringValue(record.code),
    sub_code: stringValue(record.sub_code),
    description: normalizeForFingerprint(stringValue(record.description))
  });
}
