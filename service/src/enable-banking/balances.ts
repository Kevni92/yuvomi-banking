import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type NormalizedBalanceType =
  | 'available'
  | 'interim_available'
  | 'closing_booked'
  | 'expected'
  | 'other';

export interface NormalizedBalance {
  providerBalanceType: string;
  normalizedBalanceType: NormalizedBalanceType;
  amountCents: number;
  currency: string;
  observedAt: string | null;
  usableForWeeklyBudget: boolean;
}

export interface StoredBalanceSnapshot extends NormalizedBalance {
  id: number;
  accountId: number;
  syncRunKey: string;
  fetchedAt: string;
}

export interface PersistBalancesOptions {
  database: DatabaseSync;
  accountId: number;
  balances: Array<Record<string, unknown>>;
  expectedCurrency?: string | null;
  fetchedAt?: Date;
  syncRunKey?: string;
}

interface RankedBalance extends Omit<NormalizedBalance, 'usableForWeeklyBudget'> {
  selectionPriority: number | null;
  providerIndex: number;
}

const BALANCE_PRIORITIES = new Map<string, {
  type: NormalizedBalanceType;
  priority: number;
}>([
  ['ITAV', { type: 'interim_available', priority: 10 }],
  ['CLAV', { type: 'available', priority: 20 }],
  ['XPCD', { type: 'expected', priority: 30 }],
  ['ITBD', { type: 'closing_booked', priority: 40 }],
  ['CLBD', { type: 'closing_booked', priority: 50 }]
]);

/**
 * Normalize the provider response and mark exactly one balance as usable.
 * Available/instant balances win over booked fallbacks. Unknown, forward,
 * opening and informational balances remain auditable but are never selected.
 */
export function normalizeAndSelectBalances(
  balances: Array<Record<string, unknown>>,
  expectedCurrency = 'EUR'
): NormalizedBalance[] {
  if (!Array.isArray(balances)) {
    throw new Error('Provider balances must be an array.');
  }
  const normalizedExpectedCurrency = expectedCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedExpectedCurrency)) {
    throw new Error('Expected balance currency is invalid.');
  }

  const byProviderType = new Map<string, RankedBalance>();
  balances.forEach((balance, providerIndex) => {
    const candidate = normalizeProviderBalance(balance, providerIndex);
    const existing = byProviderType.get(candidate.providerBalanceType);
    if (!existing || compareSameType(candidate, existing) < 0) {
      byProviderType.set(candidate.providerBalanceType, candidate);
    }
  });

  const candidates = [...byProviderType.values()].sort(
    (left, right) => left.providerIndex - right.providerIndex
  );
  const selected = candidates
    .filter((candidate) =>
      candidate.selectionPriority !== null
      && candidate.currency === normalizedExpectedCurrency
    )
    .sort(compareForSelection)[0];
  const selectedProviderIndex = selected?.providerIndex;

  return candidates.map(({ selectionPriority: _priority, providerIndex, ...balance }) => ({
    ...balance,
    usableForWeeklyBudget: providerIndex === selectedProviderIndex
  }));
}

export function persistAccountBalanceSnapshots({
  database,
  accountId,
  balances,
  expectedCurrency = 'EUR',
  fetchedAt = new Date(),
  syncRunKey = crypto.randomUUID()
}: PersistBalancesOptions): {
  snapshots: StoredBalanceSnapshot[];
  usableBalance: StoredBalanceSnapshot | null;
} {
  if (!Number.isSafeInteger(accountId) || accountId < 1) {
    throw new Error('Banking account ID is invalid.');
  }
  if (!syncRunKey.trim() || syncRunKey.length > 200) {
    throw new Error('Balance sync run key is invalid.');
  }
  if (Number.isNaN(fetchedAt.getTime())) {
    throw new Error('Balance fetch time is invalid.');
  }

  const normalized = normalizeAndSelectBalances(
    balances,
    expectedCurrency ?? 'EUR'
  );
  const fetchedAtIso = fetchedAt.toISOString();
  const createdAt = new Date().toISOString();
  const insert = database.prepare(`
    INSERT INTO account_balance_snapshots (
      account_id, sync_run_key, provider_balance_type, normalized_balance_type,
      amount_cents, currency, observed_at, fetched_at,
      usable_for_weekly_budget, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, fetched_at, provider_balance_type) DO UPDATE SET
      sync_run_key = excluded.sync_run_key,
      normalized_balance_type = excluded.normalized_balance_type,
      amount_cents = excluded.amount_cents,
      currency = excluded.currency,
      observed_at = excluded.observed_at,
      usable_for_weekly_budget = excluded.usable_for_weekly_budget
  `);
  const findStored = database.prepare(`
    SELECT id
    FROM account_balance_snapshots
    WHERE account_id = ? AND fetched_at = ? AND provider_balance_type = ?
  `);
  const stored: StoredBalanceSnapshot[] = [];

  database.exec('BEGIN IMMEDIATE;');
  try {
    for (const balance of normalized) {
      insert.run(
        accountId,
        syncRunKey,
        balance.providerBalanceType,
        balance.normalizedBalanceType,
        balance.amountCents,
        balance.currency,
        balance.observedAt,
        fetchedAtIso,
        balance.usableForWeeklyBudget ? 1 : 0,
        createdAt
      );
      const row = findStored.get(
        accountId,
        fetchedAtIso,
        balance.providerBalanceType
      ) as { id: number } | undefined;
      if (!row) throw new Error('Stored balance snapshot could not be found.');
      stored.push({
        ...balance,
        id: Number(row.id),
        accountId,
        syncRunKey,
        fetchedAt: fetchedAtIso
      });
    }
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }

  return {
    snapshots: stored,
    usableBalance: stored.find((balance) => balance.usableForWeeklyBudget) ?? null
  };
}

export function latestUsableBalanceSnapshot(
  database: DatabaseSync,
  accountId: number
): StoredBalanceSnapshot | null {
  if (!Number.isSafeInteger(accountId) || accountId < 1) {
    throw new Error('Banking account ID is invalid.');
  }
  const row = database.prepare(`
    SELECT id, account_id, sync_run_key, provider_balance_type,
           normalized_balance_type, amount_cents, currency, observed_at,
           fetched_at, usable_for_weekly_budget
    FROM account_balance_snapshots
    WHERE account_id = ? AND usable_for_weekly_budget = 1
    ORDER BY fetched_at DESC, id DESC
    LIMIT 1
  `).get(accountId) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    syncRunKey: String(row.sync_run_key ?? ''),
    providerBalanceType: String(row.provider_balance_type),
    normalizedBalanceType: row.normalized_balance_type as NormalizedBalanceType,
    amountCents: Number(row.amount_cents),
    currency: String(row.currency),
    observedAt: typeof row.observed_at === 'string' ? row.observed_at : null,
    fetchedAt: String(row.fetched_at),
    usableForWeeklyBudget: Boolean(row.usable_for_weekly_budget)
  };
}

function normalizeProviderBalance(
  balance: Record<string, unknown>,
  providerIndex: number
): RankedBalance {
  if (!balance || typeof balance !== 'object' || Array.isArray(balance)) {
    throw new Error(`Provider balance at index ${providerIndex} is invalid.`);
  }
  const amountContainer = recordValue(balance.balance_amount)
    ?? recordValue(balance.balanceAmount);
  const amount = amountContainer?.amount ?? balance.amount;
  const currency = stringValue(amountContainer?.currency ?? balance.currency)?.toUpperCase();
  const providerBalanceType = stringValue(
    balance.balance_type ?? balance.balanceType ?? balance.type
  )?.toUpperCase();
  if (!providerBalanceType || !/^[A-Z0-9_-]{2,40}$/.test(providerBalanceType)) {
    throw new Error(`Provider balance type at index ${providerIndex} is invalid.`);
  }
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Provider balance currency at index ${providerIndex} is invalid.`);
  }

  let amountCents = parseBalanceAmount(amount, currency);
  const creditDebitIndicator = stringValue(
    balance.credit_debit_indicator ?? balance.creditDebitIndicator
  )?.toUpperCase();
  if (creditDebitIndicator && creditDebitIndicator !== 'CRDT' && creditDebitIndicator !== 'DBIT') {
    throw new Error(`Provider balance direction at index ${providerIndex} is invalid.`);
  }
  if (creditDebitIndicator === 'CRDT') amountCents = Math.abs(amountCents);
  if (creditDebitIndicator === 'DBIT') amountCents = -Math.abs(amountCents);

  const mapping = BALANCE_PRIORITIES.get(providerBalanceType);
  return {
    providerBalanceType,
    normalizedBalanceType: mapping?.type ?? 'other',
    amountCents,
    currency,
    observedAt: normalizeObservedAt(
      balance.last_change_date_time
      ?? balance.lastChangeDateTime
      ?? balance.reference_date
      ?? balance.referenceDate
      ?? null
    ),
    selectionPriority: mapping?.priority ?? null,
    providerIndex
  };
}

function compareForSelection(left: RankedBalance, right: RankedBalance): number {
  const priority = (left.selectionPriority ?? Number.MAX_SAFE_INTEGER)
    - (right.selectionPriority ?? Number.MAX_SAFE_INTEGER);
  if (priority !== 0) return priority;
  return compareObservationDescending(left, right);
}

function compareSameType(left: RankedBalance, right: RankedBalance): number {
  return compareObservationDescending(left, right);
}

function compareObservationDescending(left: RankedBalance, right: RankedBalance): number {
  const leftTime = observationTime(left.observedAt);
  const rightTime = observationTime(right.observedAt);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return left.providerIndex - right.providerIndex;
}

function observationTime(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function normalizeObservedAt(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = Date.parse(`${text}T00:00:00.000Z`);
    return Number.isNaN(parsed) ? null : text;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function parseBalanceAmount(value: unknown, currency: string): number {
  const text = typeof value === 'number'
    ? (Number.isFinite(value) ? value.toString() : '')
    : stringValue(value) ?? '';
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error('Provider balance amount is invalid.');

  const minorDigits = currency === 'JPY' ? 0 : 2;
  const fraction = match[3] ?? '';
  if (fraction.length > minorDigits && /[^0]/.test(fraction.slice(minorDigits))) {
    throw new Error('Provider balance amount has unsupported precision.');
  }
  const scale = 10n ** BigInt(minorDigits);
  const units = BigInt(match[2]) * scale
    + BigInt(fraction.slice(0, minorDigits).padEnd(minorDigits, '0') || '0');
  const signed = match[1] === '-' ? -units : units;
  const result = Number(signed);
  if (!Number.isSafeInteger(result) || Math.abs(result) > 100_000_000_000_000) {
    throw new Error('Provider balance amount is invalid.');
  }
  return result;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
