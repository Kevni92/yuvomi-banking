import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { counterpartyId, normalizeIban } from '../services/counterparty.js';
import { applyCategoryRulesForAccount } from '../services/category-rules.js';
import { normalizeMerchantsForAccount } from '../services/merchants.js';
import {
  mergeListPayload,
  readStoredProviderPayload,
  writeStoredProviderPayload
} from '../services/provider-transaction-payload.js';
import type { EncryptionService } from '../security/encryption.js';

export type TransactionStatus = 'PDNG' | 'BOOK' | 'UNKNOWN';

export interface ProviderTransaction {
  entry_reference?: unknown;
  transaction_id?: unknown;
  status?: unknown;
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
  manageTransaction?: boolean;
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
  encryption,
  manageTransaction = true
}: ImportTransactionsOptions): ImportTransactionsResult {
  if (!Number.isInteger(accountId) || accountId < 1) {
    throw new Error('Banking account ID is invalid.');
  }
  if (!hmacSecret.trim()) {
    throw new Error('COUNTERPARTY_HMAC_SECRET is not configured.');
  }

  const result: ImportTransactionsResult = { inserted: 0, updated: 0 };
  const findByEntryReference = database.prepare(
    'SELECT id FROM transactions WHERE account_id = ? AND entry_reference = ? LIMIT 1'
  );
  const findByStableFingerprint = database.prepare(
    `SELECT id FROM transactions
     WHERE account_id = ? AND provider_transaction_id = ?
       AND (? IS NULL OR entry_reference IS NULL OR entry_reference = ?)
     LIMIT 1`
  );
  const findReconciliationCandidates = database.prepare(`
    SELECT transactions.id, transactions.provider_transaction_id,
           transactions.status, transactions.entry_reference, transactions.transaction_id,
           transactions.booking_date, transactions.value_date, transactions.transaction_date,
           transactions.amount_cents, transactions.currency, transactions.direction,
           transactions.counterparty_name, transactions.purpose, transactions.mcc,
           counterparties.counterparty_id
    FROM transactions
    LEFT JOIN counterparties ON counterparties.id = transactions.counterparty_ref
    WHERE transactions.account_id = ?
      AND (
        transactions.status = 'PDNG'
        OR transactions.provider_transaction_id LIKE 'fallback-%'
      )
  `);
  const findCounterparty = database.prepare(
    'SELECT id FROM counterparties WHERE counterparty_id = ?'
  );
  const existingPayload = database.prepare(`
    SELECT raw_payload_encrypted, provider_detail_state, transaction_id, status
    FROM transactions WHERE id = ?
  `);
  const upsertCounterparty = database.prepare(`
    INSERT INTO counterparties (
      counterparty_id, display_name, iban_encrypted, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(counterparty_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, counterparties.display_name),
      iban_encrypted = COALESCE(counterparties.iban_encrypted, excluded.iban_encrypted),
      updated_at = excluded.updated_at
  `);
  const insertTransaction = database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, entry_reference, transaction_id,
      booking_date, value_date, transaction_date, amount_cents, currency, direction,
      counterparty_ref, counterparty_name, purpose, mcc, status, raw_payload_encrypted,
      provider_detail_state, provider_note, reference_number, reference_number_schema,
      bank_transaction_code, counterparty_additional_identification,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateTransaction = database.prepare(`
    UPDATE transactions SET
      provider_transaction_id = ?,
      entry_reference = COALESCE(?, entry_reference),
      transaction_id = COALESCE(?, transaction_id),
      booking_date = COALESCE(?, booking_date),
      value_date = COALESCE(?, value_date),
      transaction_date = COALESCE(?, transaction_date),
      amount_cents = ?,
      currency = ?,
      direction = ?,
      counterparty_ref = COALESCE(?, counterparty_ref),
      counterparty_name = COALESCE(?, counterparty_name),
      purpose = COALESCE(?, purpose),
      mcc = COALESCE(?, mcc),
      raw_payload_encrypted = ?,
      provider_note = COALESCE(?, provider_note),
      reference_number = COALESCE(?, reference_number),
      reference_number_schema = COALESCE(?, reference_number_schema),
      bank_transaction_code = COALESCE(?, bank_transaction_code),
      counterparty_additional_identification = COALESCE(?, counterparty_additional_identification),
      provider_detail_state = ?,
      status = CASE
        WHEN ? = 'UNKNOWN' AND status IN ('PDNG', 'BOOK') THEN status
        ELSE ?
      END,
      updated_at = ?
    WHERE id = ?
  `);

  if (manageTransaction) database.exec('BEGIN IMMEDIATE;');
  try {
    for (const transaction of transactions) {
      const normalized = normalizeTransaction(transaction, hmacSecret, encryption);
      let existing = normalized.entryReference
        ? findByEntryReference.get(accountId, normalized.entryReference) as { id: number } | undefined
        : undefined;
      if (!existing) {
        existing = findByStableFingerprint.get(
          accountId,
          normalized.stableFingerprint,
          normalized.entryReference,
          normalized.entryReference
        ) as { id: number } | undefined;
      }
      if (!existing) {
        const candidates = findReconciliationCandidates.all(accountId) as unknown as ExistingTransaction[];
        existing = findReconciliationCandidate(candidates, normalized);
      }
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
      if (existing) {
        const previous = existingPayload.get(existing.id) as {
          raw_payload_encrypted: string | null;
          provider_detail_state: string;
          transaction_id: string | null;
          status: TransactionStatus;
        } | undefined;
        const rawPayloadEncrypted = writeStoredProviderPayload(
          mergeListPayload(readStoredProviderPayload(previous?.raw_payload_encrypted, encryption), transaction, timestamp),
          encryption
        );
        const detailState = importedDetailState(previous, normalized);
        updateTransaction.run(
          normalized.deduplicationKey,
          normalized.entryReference,
          normalized.transactionId,
          normalized.bookingDate,
          normalized.valueDate,
          normalized.transactionDate,
          normalized.amountCents,
          normalized.currency,
          normalized.direction,
          counterpartyRef,
          normalized.counterparty?.name ?? null,
          normalized.purpose,
          normalized.mcc,
          rawPayloadEncrypted,
          normalized.note,
          normalized.referenceNumber,
          normalized.referenceNumberSchema,
          normalized.bankTransactionCode,
          normalized.counterpartyAdditionalIdentification,
          detailState,
          normalized.status,
          normalized.status,
          timestamp,
          existing.id
        );
      } else {
        insertTransaction.run(
          accountId,
          normalized.deduplicationKey,
          normalized.entryReference,
          normalized.transactionId,
          normalized.bookingDate,
          normalized.valueDate,
          normalized.transactionDate,
          normalized.amountCents,
          normalized.currency,
          normalized.direction,
          counterpartyRef,
          normalized.counterparty?.name ?? null,
          normalized.purpose,
          normalized.mcc,
          normalized.status,
          normalized.rawPayloadEncrypted,
          normalized.detailState,
          normalized.note,
          normalized.referenceNumber,
          normalized.referenceNumberSchema,
          normalized.bankTransactionCode,
          normalized.counterpartyAdditionalIdentification,
          timestamp,
          timestamp
        );
      }

      if (existing) result.updated += 1;
      else result.inserted += 1;
    }
    // Resolve deterministic provider evidence before category rules, so rules
    // can use a merchant discovered from a list payload immediately.
    normalizeMerchantsForAccount(database, accountId, new Date(), encryption);
    // Rule application is part of the local import transaction so a newly
    // learned counterparty rule prevents a later OpenAI request immediately.
    applyCategoryRulesForAccount(database, accountId, new Date());
    if (manageTransaction) database.exec('COMMIT;');
  } catch (error) {
    if (manageTransaction) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // Preserve the original import error.
      }
    }
    throw error;
  }

  return result;
}

interface NormalizedTransaction {
  deduplicationKey: string;
  stableFingerprint: string;
  entryReference: string | null;
  transactionId: string | null;
  status: TransactionStatus;
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
  note: string | null;
  detailState: 'available' | 'unavailable';
  rawPayloadEncrypted: string;
}

interface ExistingTransaction {
  id: number;
  provider_transaction_id: string;
  status: TransactionStatus;
  entry_reference: string | null;
  transaction_id: string | null;
  booking_date: string | null;
  value_date: string | null;
  transaction_date: string | null;
  amount_cents: number;
  currency: string;
  direction: 'incoming' | 'outgoing';
  counterparty_id: string | null;
  counterparty_name: string | null;
  purpose: string | null;
  mcc: string | null;
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
  const status = transactionStatus(transaction.status);
  const referenceNumber = stringValue(transaction.reference_number);
  const referenceNumberSchema = stringValue(transaction.reference_number_schema);
  const counterpartyAdditionalIdentification = additionalIdentificationValue(
    direction === 'incoming'
      ? transaction.debtor_account_additional_identification
      : transaction.creditor_account_additional_identification
  );
  const bankTransactionCode = stableValue(transaction.bank_transaction_code);
  const note = stringValue(transaction.note)?.slice(0, 2_000) ?? null;
  const normalized: NormalizedTransaction = {
    deduplicationKey: '',
    stableFingerprint: '',
    entryReference,
    transactionId,
    status,
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
    bankTransactionCode,
    note,
    detailState: transactionId ? 'available' : 'unavailable',
    rawPayloadEncrypted: writeStoredProviderPayload(
      mergeListPayload(null, transaction, new Date().toISOString()), encryption
    )
  };

  normalized.stableFingerprint = fallbackTransactionKey(normalized);
  normalized.deduplicationKey = entryReference ?? normalized.stableFingerprint;
  return normalized;
}

function importedDetailState(
  previous: { provider_detail_state: string; transaction_id: string | null; status: TransactionStatus } | undefined,
  incoming: NormalizedTransaction
): string {
  if (!incoming.transactionId) return 'unavailable';
  if (!previous || previous.transaction_id !== incoming.transactionId) return 'available';
  if (previous.status === 'PDNG' && incoming.status === 'BOOK') return 'available';
  return previous.provider_detail_state === 'unavailable' ? 'available' : previous.provider_detail_state;
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

function findReconciliationCandidate(
  candidates: ExistingTransaction[],
  incoming: NormalizedTransaction
): { id: number } | undefined {
  const matches = candidates.filter((candidate) => {
    if (isLegacyFallbackKey(candidate.provider_transaction_id)) {
      return matchesStrongly(candidate, incoming);
    }
    return incoming.status === 'BOOK'
      && candidate.status === 'PDNG'
      && matchesStrongly(candidate, incoming);
  });
  return matches.length === 1 ? { id: matches[0].id } : undefined;
}

/**
 * Pending/Booked reconciliation is intentionally conservative. A matching
 * amount alone is never enough: the exact party and purpose are required,
 * while MCC (when both sides provide it) acts as an additional consistency
 * check. Ambiguous candidates are left untouched and a second local row is
 * safer than silently combining two real payments.
 */
function matchesStrongly(
  existing: ExistingTransaction,
  incoming: NormalizedTransaction
): boolean {
  if (
    existing.amount_cents !== incoming.amountCents
    || existing.currency !== incoming.currency
    || existing.direction !== incoming.direction
  ) return false;

  const sameCounterparty = existing.counterparty_id && incoming.counterparty?.id
    ? existing.counterparty_id === incoming.counterparty.id
    : normalizeForFingerprint(existing.counterparty_name) !== null
      && normalizeForFingerprint(existing.counterparty_name)
        === normalizeForFingerprint(incoming.counterparty?.name ?? null);
  if (!sameCounterparty) return false;

  const existingPurpose = normalizeForFingerprint(existing.purpose);
  const incomingPurpose = normalizeForFingerprint(incoming.purpose);
  if (!existingPurpose || !incomingPurpose || existingPurpose !== incomingPurpose) return false;

  const existingMcc = normalizeForFingerprint(existing.mcc);
  const incomingMcc = normalizeForFingerprint(incoming.mcc);
  if (existingMcc && incomingMcc && existingMcc !== incomingMcc) return false;

  return datesArePlausible(existing, incoming);
}

function datesArePlausible(
  existing: ExistingTransaction,
  incoming: NormalizedTransaction
): boolean {
  const existingDates = [existing.booking_date, existing.value_date, existing.transaction_date]
    .map(parseDate)
    .filter((value): value is number => value !== null);
  const incomingDates = [incoming.bookingDate, incoming.valueDate, incoming.transactionDate]
    .map(parseDate)
    .filter((value): value is number => value !== null);
  if (existingDates.length === 0 || incomingDates.length === 0) return false;

  const windowMs = 7 * 24 * 60 * 60 * 1_000;
  return existingDates.some((existingDate) => incomingDates.some((incomingDate) =>
    Math.abs(existingDate - incomingDate) <= windowMs
  ));
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function isLegacyFallbackKey(value: string): boolean {
  return value.startsWith('fallback-');
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

export function normalizeForFingerprint(value: string | null): string | null {
  return value
    ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
    : null;
}

function transactionStatus(value: unknown): TransactionStatus {
  const status = stringValue(value)?.toUpperCase();
  if (status === 'PDNG' || status === 'BOOK') return status;
  return 'UNKNOWN';
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
