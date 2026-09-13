import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type ObservationDirection = 'incoming' | 'outgoing';
export type ObservationStatus = 'PDNG' | 'BOOK' | 'UNKNOWN';

export interface ProviderObservationFields {
  status: ObservationStatus;
  direction: ObservationDirection;
  counterpartyName: string | null;
  purpose: string | null;
  providerMerchantName: string | null;
  bankTransactionCode: string | null;
}

interface MatchDescriptor extends ProviderObservationFields {
  entryReference: string | null;
  transactionId: string | null;
  amountCents: number | null;
  currency: string | null;
  dates: string[];
}

interface LocalCandidate {
  id: number;
  status: ObservationStatus;
  booking_date: string | null;
  value_date: string | null;
  transaction_date: string | null;
  counterparty_name: string | null;
  purpose: string | null;
}

export function captureProviderObservationsForAccount({
  database,
  accountId,
  transactions,
  now = new Date()
}: {
  database: DatabaseSync;
  accountId: number;
  transactions: Array<Record<string, unknown>>;
  now?: Date;
}): number {
  if (!Number.isSafeInteger(accountId) || accountId < 1 || Number.isNaN(now.getTime())) {
    throw new Error('Transaction observation input is invalid.');
  }
  const findByEntryReference = database.prepare(`
    SELECT id, status, booking_date, value_date, transaction_date, counterparty_name, purpose
    FROM transactions WHERE account_id = ? AND entry_reference = ? LIMIT 1
  `);
  const findByTransactionId = database.prepare(`
    SELECT id, status, booking_date, value_date, transaction_date, counterparty_name, purpose
    FROM transactions WHERE account_id = ? AND transaction_id = ?
    ORDER BY id DESC LIMIT 1
  `);
  const findCandidates = database.prepare(`
    SELECT id, status, booking_date, value_date, transaction_date, counterparty_name, purpose
    FROM transactions
    WHERE account_id = ? AND amount_cents = ? AND currency = ? AND direction = ?
    ORDER BY id DESC
  `);
  const insert = database.prepare(`
    INSERT OR IGNORE INTO transaction_observations (
      transaction_id, status, direction, observed_at,
      counterparty_name, purpose, provider_merchant_name,
      bank_transaction_code, observation_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const timestamp = now.toISOString();
  let inserted = 0;
  for (const transaction of transactions) {
    const descriptor = matchDescriptor(transaction);
    const local = resolveLocalTransaction(
      database,
      accountId,
      descriptor,
      findByEntryReference,
      findByTransactionId,
      findCandidates
    );
    if (!local) continue;
    const key = observationKey(descriptor);
    inserted += Number(insert.run(
      local.id,
      descriptor.status,
      descriptor.direction,
      timestamp,
      descriptor.counterpartyName,
      descriptor.purpose,
      descriptor.providerMerchantName,
      descriptor.bankTransactionCode,
      key,
      timestamp
    ).changes);
  }
  return inserted;
}

export function extractProviderObservation(
  transaction: Record<string, unknown>,
  fallbackDirection: ObservationDirection = 'outgoing',
  fallbackStatus: ObservationStatus = 'UNKNOWN'
): ProviderObservationFields {
  const direction = directionValue(transaction.credit_debit_indicator) ?? fallbackDirection;
  const partyKey = direction === 'incoming' ? 'debtor' : 'creditor';
  const party = recordValue(transaction[partyKey]);
  return {
    status: statusValue(transaction.status) ?? fallbackStatus,
    direction,
    counterpartyName: text(party?.name),
    purpose: purposeValue(transaction.remittance_information),
    providerMerchantName: explicitMerchantName(transaction),
    bankTransactionCode: stableValue(transaction.bank_transaction_code)
  };
}

export function explicitMerchantName(transaction: Record<string, unknown>): string | null {
  const direct = text(transaction.merchant_name) ?? text(transaction.card_acceptor_name);
  if (direct) return direct;
  return text(recordValue(transaction.merchant)?.name);
}

function matchDescriptor(transaction: Record<string, unknown>): MatchDescriptor {
  const observation = extractProviderObservation(transaction);
  const currency = text(recordValue(transaction.transaction_amount)?.currency)?.toUpperCase() ?? null;
  return {
    ...observation,
    entryReference: text(transaction.entry_reference),
    transactionId: text(transaction.transaction_id),
    amountCents: currency ? parseMinorUnits(recordValue(transaction.transaction_amount)?.amount, currency) : null,
    currency,
    dates: [transaction.booking_date, transaction.value_date, transaction.transaction_date]
      .map(dateValue)
      .filter((value): value is string => value !== null)
  };
}

function resolveLocalTransaction(
  database: DatabaseSync,
  accountId: number,
  descriptor: MatchDescriptor,
  findByEntryReference: ReturnType<DatabaseSync['prepare']>,
  findByTransactionId: ReturnType<DatabaseSync['prepare']>,
  findCandidates: ReturnType<DatabaseSync['prepare']>
): LocalCandidate | null {
  if (descriptor.entryReference) {
    const row = findByEntryReference.get(accountId, descriptor.entryReference) as LocalCandidate | undefined;
    if (row) return row;
  }
  if (descriptor.transactionId) {
    const row = findByTransactionId.get(accountId, descriptor.transactionId) as LocalCandidate | undefined;
    if (row) return row;
  }
  if (descriptor.amountCents === null || !descriptor.currency) return null;
  const candidates = findCandidates.all(
    accountId,
    descriptor.amountCents,
    descriptor.currency,
    descriptor.direction
  ) as unknown as LocalCandidate[];
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) return null;

  const ranked = candidates
    .map((candidate) => ({ candidate, score: candidateScore(candidate, descriptor) }))
    .sort((left, right) => right.score - left.score || right.candidate.id - left.candidate.id);
  if (ranked[0].score < 2 || (ranked[1] && ranked[0].score === ranked[1].score)) return null;
  return ranked[0].candidate;
}

function candidateScore(candidate: LocalCandidate, incoming: MatchDescriptor): number {
  let score = candidate.status === incoming.status ? 1 : 0;
  const candidateDates = [candidate.booking_date, candidate.value_date, candidate.transaction_date].filter(Boolean);
  if (incoming.dates.some((date) => candidateDates.includes(date))) score += 4;
  if (sameText(candidate.counterparty_name, incoming.counterpartyName)) score += 4;
  if (sameText(candidate.purpose, incoming.purpose)) score += 3;
  return score;
}

function observationKey(value: MatchDescriptor): string {
  const canonical = JSON.stringify({
    status: value.status,
    direction: value.direction,
    counterparty_name: normalizedText(value.counterpartyName),
    purpose: normalizedText(value.purpose),
    provider_merchant_name: normalizedText(value.providerMerchantName),
    bank_transaction_code: value.bankTransactionCode
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function sameText(left: string | null, right: string | null): boolean {
  const a = normalizedText(left);
  const b = normalizedText(right);
  return Boolean(a && b && a === b);
}

function normalizedText(value: string | null): string {
  return value
    ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
    : '';
}

function statusValue(value: unknown): ObservationStatus | null {
  const normalized = text(value)?.toUpperCase();
  if (normalized === 'PDNG' || normalized === 'BOOK') return normalized;
  return normalized ? 'UNKNOWN' : null;
}

function directionValue(value: unknown): ObservationDirection | null {
  const normalized = text(value)?.toUpperCase();
  if (normalized === 'CRDT') return 'incoming';
  if (normalized === 'DBIT') return 'outgoing';
  return null;
}

function purposeValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    const joined = value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(' ');
    return joined ? joined.slice(0, 2_000) : null;
  }
  return text(value);
}

function parseMinorUnits(value: unknown, currency: string): number | null {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
  if (!raw) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return null;
  const digits = currency === 'JPY' ? 0 : 2;
  const fraction = match[3] ?? '';
  if (fraction.length > digits && /[^0]/.test(fraction.slice(digits))) return null;
  const major = BigInt(match[2]);
  const minor = BigInt(fraction.slice(0, digits).padEnd(digits, '0') || '0');
  const units = major * (10n ** BigInt(digits)) + minor;
  const signed = match[1] === '-' ? -units : units;
  const result = Number(signed);
  return Number.isSafeInteger(result) ? Math.abs(result) : null;
}

function stableValue(value: unknown): string | null {
  if (typeof value === 'string') return text(value);
  const record = recordValue(value);
  if (!record) return null;
  return JSON.stringify({
    code: text(record.code),
    sub_code: text(record.sub_code ?? record.subCode),
    description: text(record.description)
  });
}

function dateValue(value: unknown): string | null {
  const result = text(value);
  if (!result) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(result) ? result.slice(0, 10) : result.slice(0, 100);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2_000) : null;
}
