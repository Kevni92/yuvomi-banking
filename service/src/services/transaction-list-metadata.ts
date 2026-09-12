import type { DatabaseSync } from 'node:sqlite';
import type { PublicTransaction } from './transactions-query.js';

export type PublicTransactionWithListMetadata = PublicTransaction & {
  transaction_time: string | null;
  new_since_last_sync: number;
};

/**
 * Adds presentation-only metadata to the already ownership-filtered transaction
 * list. `created_at` is the first local import timestamp: existing transactions
 * keep it when later syncs update them. `bank_accounts.last_synced_at` is written
 * with the start time of the latest successful account sync, so a transaction
 * created on/after that marker was first discovered by that latest fetch.
 */
export function decorateTransactionListMetadata(
  database: DatabaseSync,
  userId: number,
  transactions: PublicTransaction[]
): PublicTransactionWithListMetadata[] {
  if (!transactions.length) return [];

  const ids = transactions
    .map((transaction) => Number(transaction.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) {
    return transactions.map((transaction) => ({
      ...transaction,
      transaction_time: inferTransactionTime(transaction),
      new_since_last_sync: 0
    }));
  }

  const placeholders = ids.map(() => '?').join(', ');
  const rows = database.prepare(`
    SELECT transactions.id, transactions.created_at, bank_accounts.last_synced_at
    FROM transactions
    JOIN bank_accounts ON bank_accounts.id = transactions.account_id
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    WHERE enable_banking_connections.yuvomi_user_id = ?
      AND transactions.id IN (${placeholders})
  `).all(userId, ...ids) as Array<{
    id: number;
    created_at: string | null;
    last_synced_at: string | null;
  }>;
  const metadata = new Map(rows.map((row) => [Number(row.id), row]));

  return transactions.map((transaction) => {
    const row = metadata.get(Number(transaction.id));
    return {
      ...transaction,
      transaction_time: inferTransactionTime(transaction),
      new_since_last_sync: row && isAtOrAfter(row.created_at, row.last_synced_at) ? 1 : 0
    };
  });
}

/**
 * Enable Banking often supplies only a booking date. Some banks nevertheless
 * include the actual card-payment time in deterministic provider text. Expose a
 * time only when such evidence exists; never substitute the import/sync time.
 */
export function inferTransactionTime(transaction: Partial<PublicTransaction>): string | null {
  const candidates = [
    transaction.transaction_date,
    transaction.purpose,
    transaction.counterparty_name,
    transaction.merchant_name
  ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));

  for (const value of candidates) {
    const iso = /T([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/i.exec(value);
    if (iso) return `${iso[1]}:${iso[2]}`;

    const uhr = /(?:^|\D)([01]?\d|2[0-3])[.:]([0-5]\d)(?:[.:][0-5]\d)?\s*UHR\b/i.exec(value);
    if (uhr) return `${uhr[1].padStart(2, '0')}:${uhr[2]}`;

    const dated = /\b\d{1,2}[.\/-]\d{1,2}(?:[.\/-]\d{2,4})?[ /T]+([01]?\d|2[0-3])[.:]([0-5]\d)(?:[.:][0-5]\d)?\b/i.exec(value);
    if (dated) return `${dated[1].padStart(2, '0')}:${dated[2]}`;
  }
  return null;
}

export function isAtOrAfter(firstSeen: unknown, syncStarted: unknown): boolean {
  if (typeof firstSeen !== 'string' || typeof syncStarted !== 'string') return false;
  const firstSeenMs = Date.parse(firstSeen);
  const syncStartedMs = Date.parse(syncStarted);
  return Number.isFinite(firstSeenMs) && Number.isFinite(syncStartedMs) && firstSeenMs >= syncStartedMs;
}
