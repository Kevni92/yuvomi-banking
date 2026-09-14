import type { DatabaseSync } from 'node:sqlite';
import {
  applyCategoryRulesForAccount
} from './category-rules.js';
import {
  queryTransactions,
  type PublicTransaction,
  type TransactionOrder,
  type TransactionQueryResult,
  type TransactionSort
} from './transactions-query.js';
export { resolvePayeeForTransaction, resolvePayeesForAccount } from './payee-resolution.js';
export type { PayeeResolutionResult } from './payee-resolution.js';

export type PayeeSort = 'name' | 'transaction_count' | 'last_date' | 'category';

export interface RecurringPayeeQuery {
  ownerId: number;
  payeeId?: number;
  recurring?: boolean;
  sort?: PayeeSort;
  order?: TransactionOrder;
  limit?: number;
  offset?: number;
}

export interface RecurringPayee {
  id: number;
  display_name: string;
  status: 'candidate' | 'confirmed' | 'ignored';
  identity_quality: 'candidate' | 'strong';
  booked_transaction_count: number;
  pending_transaction_count: number;
  account_count: number;
  first_booking_date: string | null;
  last_booking_date: string | null;
  last_amount: string | null;
  currency: string | null;
  category: { id: number; name: string; active: boolean } | null;
  manual_exception_count: number;
}

export interface RecurringPayeeListResult {
  payees: RecurringPayee[];
  total: number;
  limit: number;
  offset: number;
}

export interface PayeeTransactionsResult extends TransactionQueryResult {
  payee: RecurringPayee;
}

export class PayeeNotFoundError extends Error {}
export class PayeeValidationError extends Error {}
export class PayeeCategoryConflictError extends Error {}

const PAYEE_SORT_SQL: Record<PayeeSort, string> = {
  name: 'payees.display_name COLLATE NOCASE',
  transaction_count: 'booked_transaction_count',
  last_date: 'last_booking_date',
  category: "COALESCE(categories.name, '') COLLATE NOCASE"
};

export function listRecurringPayees(
  database: DatabaseSync,
  query: RecurringPayeeQuery
): RecurringPayeeListResult {
  validateOwner(query.ownerId);
  const sort = query.sort ?? 'last_date';
  const order = query.order ?? 'desc';
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  if (query.payeeId !== undefined) validateId(query.payeeId, 'Payee ID');
  if (!Object.hasOwn(PAYEE_SORT_SQL, sort)) throw new PayeeValidationError('Payee sort is invalid.');
  if (!['asc', 'desc'].includes(order)) throw new PayeeValidationError('Payee order is invalid.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PayeeValidationError('Payee limit is invalid.');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new PayeeValidationError('Payee offset is invalid.');

  const recurringClause = query.recurring === false ? '' : 'HAVING booked_transaction_count >= 2';
  const rows = database.prepare(`
    WITH payee_stats AS (
      SELECT transactions.payee_id,
             SUM(CASE WHEN transactions.direction = 'outgoing' AND transactions.status = 'BOOK' THEN 1 ELSE 0 END) AS booked_transaction_count,
             SUM(CASE WHEN transactions.direction = 'outgoing' AND transactions.status = 'PDNG' THEN 1 ELSE 0 END) AS pending_transaction_count,
             COUNT(DISTINCT CASE WHEN transactions.direction = 'outgoing' THEN transactions.account_id END) AS account_count,
             MIN(CASE WHEN transactions.direction = 'outgoing' AND transactions.status = 'BOOK' THEN COALESCE(transactions.booking_date, transactions.value_date, transactions.transaction_date) END) AS first_booking_date,
             MAX(CASE WHEN transactions.direction = 'outgoing' AND transactions.status = 'BOOK' THEN COALESCE(transactions.booking_date, transactions.value_date, transactions.transaction_date) END) AS last_booking_date,
             COUNT(DISTINCT CASE WHEN transactions.direction = 'outgoing' AND transactions.status = 'BOOK' THEN transactions.currency END) AS currency_count,
             SUM(CASE WHEN transactions.direction = 'outgoing' AND transactions.status = 'BOOK' AND transactions.category_source = 'manual' THEN 1 ELSE 0 END) AS manual_exception_count
        FROM transactions
       WHERE transactions.payee_id IS NOT NULL
       GROUP BY transactions.payee_id
      ${recurringClause}
    )
    SELECT payees.id, payees.display_name, payees.status,
           CASE WHEN EXISTS (
             SELECT 1 FROM payee_identifiers
              WHERE payee_identifiers.payee_id = payees.id
                AND payee_identifiers.strength = 'strong'
           ) THEN 'strong' ELSE 'candidate' END AS identity_quality,
           payee_stats.booked_transaction_count, payee_stats.pending_transaction_count,
           payee_stats.account_count, payee_stats.first_booking_date,
           payee_stats.last_booking_date, payee_stats.currency_count,
           payee_stats.manual_exception_count,
           (
             SELECT transactions.amount_cents FROM transactions
              WHERE transactions.payee_id = payees.id
                AND transactions.direction = 'outgoing' AND transactions.status = 'BOOK'
              ORDER BY COALESCE(transactions.booking_date, transactions.value_date, transactions.transaction_date) DESC,
                       transactions.id DESC LIMIT 1
           ) AS last_amount_cents,
           (
             SELECT transactions.currency FROM transactions
              WHERE transactions.payee_id = payees.id
                AND transactions.direction = 'outgoing' AND transactions.status = 'BOOK'
              ORDER BY COALESCE(transactions.booking_date, transactions.value_date, transactions.transaction_date) DESC,
                       transactions.id DESC LIMIT 1
           ) AS last_currency,
           categories.id AS category_id, categories.name AS category_name,
           categories.active AS category_active
      FROM payees
      JOIN payee_stats ON payee_stats.payee_id = payees.id
      LEFT JOIN categories ON categories.id = payees.category_id
     WHERE payees.yuvomi_user_id = ? AND payees.status <> 'ignored'
       ${query.payeeId === undefined ? '' : 'AND payees.id = ?'}
     ORDER BY ${PAYEE_SORT_SQL[sort]} ${order.toUpperCase()}, payees.id ${order.toUpperCase()}
     LIMIT ? OFFSET ?
  `).all(...(query.payeeId === undefined ? [query.ownerId, limit, offset] : [query.ownerId, query.payeeId, limit, offset])) as Array<Record<string, unknown>>;
  const countRow = database.prepare(`
    SELECT COUNT(*) AS total
      FROM (
        SELECT payees.id
          FROM payees
          JOIN transactions ON transactions.payee_id = payees.id
         WHERE payees.yuvomi_user_id = ? AND payees.status <> 'ignored'
           ${query.payeeId === undefined ? '' : 'AND payees.id = ?'}
         GROUP BY payees.id
         ${query.recurring === false ? '' : 'HAVING SUM(CASE WHEN transactions.direction = \'outgoing\' AND transactions.status = \'BOOK\' THEN 1 ELSE 0 END) >= 2'}
      )
  `).get(...(query.payeeId === undefined ? [query.ownerId] : [query.ownerId, query.payeeId])) as { total: number };
  return { payees: rows.map(toRecurringPayee), total: Number(countRow?.total ?? 0), limit, offset };
}

export function getRecurringPayee(
  database: DatabaseSync,
  ownerId: number,
  payeeId: number
): RecurringPayee | null {
  const result = listRecurringPayees(database, {
    ownerId, payeeId, recurring: false, sort: 'name', order: 'asc', limit: 1, offset: 0
  });
  return result.payees.find((payee) => payee.id === payeeId) ?? null;
}

export function listPayeeTransactions(
  database: DatabaseSync,
  query: {
    ownerId: number;
    payeeId: number;
    sort?: TransactionSort;
    order?: TransactionOrder;
    limit?: number;
    offset?: number;
  }
): TransactionQueryResult {
  validateOwner(query.ownerId);
  if (!Number.isSafeInteger(query.payeeId) || query.payeeId < 1) throw new PayeeValidationError('Payee ID is invalid.');
  return queryTransactions(database, {
    userId: query.ownerId,
    payeeId: query.payeeId,
    sort: query.sort ?? 'date',
    order: query.order ?? 'desc',
    limit: query.limit ?? 25,
    offset: query.offset ?? 0
  });
}

export interface PayeeCategoryMutationResult {
  id: number;
  category_id: number | null;
  status: 'candidate' | 'confirmed' | 'ignored';
  affected_transactions: number;
  manual_exceptions: number;
  resolved_ai_reviews: number;
}

export function setPayeeCategory(
  database: DatabaseSync,
  input: { ownerId: number; payeeId: number; categoryId: number; confirmCandidate?: boolean; now?: Date }
): PayeeCategoryMutationResult {
  validateOwner(input.ownerId);
  validateId(input.payeeId, 'Payee ID');
  validateId(input.categoryId, 'Category ID');
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new PayeeValidationError('Payee category time is invalid.');
  const category = database.prepare(`
    SELECT id FROM categories WHERE id = ? AND active = 1 AND type = 'expense' LIMIT 1
  `).get(input.categoryId) as { id: number } | undefined;
  if (!category) throw new PayeeCategoryConflictError('Category must be an active expense category.');

  const timestamp = now.toISOString();
  let open = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    open = true;
    const payee = ownedPayee(database, input.ownerId, input.payeeId);
    if (payee.status === 'candidate' && input.confirmCandidate !== true) {
      throw new PayeeCategoryConflictError('Candidate recognition must be confirmed first.');
    }
    const status = payee.status === 'candidate' ? 'confirmed' : payee.status;
    database.prepare(`
      UPDATE payees SET category_id = ?, status = ?, confirmed_at = CASE WHEN ? = 'confirmed' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END, updated_at = ?
      WHERE id = ? AND yuvomi_user_id = ?
    `).run(input.categoryId, status, status, timestamp, timestamp, input.payeeId, input.ownerId);
    const changed = database.prepare(`
      UPDATE transactions SET category_id = ?, category_source = 'counterparty_rule',
             category_confidence = 1, category_origin_payee_id = ?, updated_at = ?
       WHERE payee_id = ? AND COALESCE(category_source, '') <> 'manual'
    `).run(input.categoryId, input.payeeId, timestamp, input.payeeId);
    const reviews = database.prepare(`
      UPDATE ai_categorization_reviews SET status = 'applied', updated_at = ?, resolved_at = ?
       WHERE status = 'pending' AND transaction_id IN (
         SELECT id FROM transactions WHERE payee_id = ?
       )
    `).run(timestamp, timestamp, input.payeeId);
    const exceptions = countManualExceptions(database, input.payeeId);
    database.exec('COMMIT;');
    open = false;
    return {
      id: input.payeeId,
      category_id: input.categoryId,
      status,
      affected_transactions: Number(changed.changes),
      manual_exceptions: exceptions,
      resolved_ai_reviews: Number(reviews.changes)
    };
  } catch (error) {
    if (open) rollback(database);
    throw error;
  }
}

export function clearPayeeCategory(
  database: DatabaseSync,
  input: { ownerId: number; payeeId: number; now?: Date }
): PayeeCategoryMutationResult {
  validateOwner(input.ownerId);
  validateId(input.payeeId, 'Payee ID');
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new PayeeValidationError('Payee category time is invalid.');
  const timestamp = now.toISOString();
  let open = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    open = true;
    const payee = ownedPayee(database, input.ownerId, input.payeeId);
    database.prepare(`UPDATE payees SET category_id = NULL, updated_at = ? WHERE id = ? AND yuvomi_user_id = ?`)
      .run(timestamp, input.payeeId, input.ownerId);
    const changed = database.prepare(`
      UPDATE transactions SET category_id = NULL, category_source = NULL,
             category_confidence = NULL, category_origin_payee_id = NULL, updated_at = ?
       WHERE payee_id = ? AND category_origin_payee_id = ? AND COALESCE(category_source, '') <> 'manual'
    `).run(timestamp, input.payeeId, input.payeeId);
    const exceptions = countManualExceptions(database, input.payeeId);
    database.exec('COMMIT;');
    open = false;

    // Re-run lower-priority local rules after the explicit Payee default is
    // removed. No provider call or AI request is made here.
    const accountIds = database.prepare(`
      SELECT DISTINCT account_id FROM transactions WHERE payee_id = ?
    `).all(input.payeeId) as Array<{ account_id: number }>;
    let reapplied = 0;
    for (const account of accountIds) reapplied += applyCategoryRulesForAccount(database, Number(account.account_id), now);
    return {
      id: input.payeeId,
      category_id: null,
      status: payee.status as PayeeCategoryMutationResult['status'],
      affected_transactions: Number(changed.changes) + reapplied,
      manual_exceptions: exceptions,
      resolved_ai_reviews: 0
    };
  } catch (error) {
    if (open) rollback(database);
    throw error;
  }
}

export function applyPayeeCategoriesForAccount(database: DatabaseSync, accountId: number, now = new Date()): number {
  validateId(accountId, 'Bank account ID');
  if (Number.isNaN(now.getTime())) throw new PayeeValidationError('Payee category time is invalid.');
  const result = database.prepare(`
    UPDATE transactions SET category_id = payees.category_id,
      category_source = 'counterparty_rule', category_confidence = 1,
      category_origin_payee_id = payees.id, updated_at = ?
    FROM payees
    JOIN categories ON categories.id = payees.category_id
    WHERE transactions.account_id = ?
      AND transactions.payee_id = payees.id
      AND transactions.payee_match_state = 'matched'
      AND payees.status = 'confirmed'
      AND categories.active = 1 AND categories.type = 'expense'
      AND payees.category_id IS NOT NULL
      AND COALESCE(transactions.category_source, '') <> 'manual'
  `).run(now.toISOString(), accountId);
  return Number(result.changes);
}

export function applyPayeeCategoriesForOwner(database: DatabaseSync, ownerId: number, now = new Date()): number {
  validateOwner(ownerId);
  const accounts = database.prepare(`
    SELECT bank_accounts.id FROM bank_accounts
    JOIN enable_banking_connections ON enable_banking_connections.id = bank_accounts.connection_id
    WHERE enable_banking_connections.yuvomi_user_id = ?
  `).all(ownerId) as Array<{ id: number }>;
  return accounts.reduce((total, account) => total + applyPayeeCategoriesForAccount(database, Number(account.id), now), 0);
}

function ownedPayee(database: DatabaseSync, ownerId: number, payeeId: number): { status: 'candidate' | 'confirmed' | 'ignored' } {
  const row = database.prepare(`SELECT status FROM payees WHERE id = ? AND yuvomi_user_id = ? LIMIT 1`)
    .get(payeeId, ownerId) as { status: 'candidate' | 'confirmed' | 'ignored' } | undefined;
  if (!row) throw new PayeeNotFoundError('Payee not found.');
  return row;
}

function countManualExceptions(database: DatabaseSync, payeeId: number): number {
  const row = database.prepare(`
    SELECT COUNT(*) AS count FROM transactions
     WHERE payee_id = ? AND direction = 'outgoing' AND status = 'BOOK' AND category_source = 'manual'
  `).get(payeeId) as { count: number };
  return Number(row?.count ?? 0);
}

function toRecurringPayee(row: Record<string, unknown>): RecurringPayee {
  const currencyCount = Number(row.currency_count ?? 0);
  const categoryId = row.category_id === null || row.category_id === undefined ? null : Number(row.category_id);
  return {
    id: Number(row.id),
    display_name: String(row.display_name),
    status: row.status as RecurringPayee['status'],
    identity_quality: row.identity_quality === 'strong' ? 'strong' : 'candidate',
    booked_transaction_count: Number(row.booked_transaction_count ?? 0),
    pending_transaction_count: Number(row.pending_transaction_count ?? 0),
    account_count: Number(row.account_count ?? 0),
    first_booking_date: stringOrNull(row.first_booking_date),
    last_booking_date: stringOrNull(row.last_booking_date),
    last_amount: currencyCount === 1 ? formatMinorUnits(row.last_amount_cents, row.last_currency) : null,
    currency: currencyCount === 1 ? stringOrNull(row.last_currency) : null,
    category: categoryId === null ? null : {
      id: categoryId,
      name: String(row.category_name),
      active: Boolean(row.category_active)
    },
    manual_exception_count: Number(row.manual_exception_count ?? 0)
  };
}

function formatMinorUnits(value: unknown, currency: unknown): string | null {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(amount)) return null;
  const code = typeof currency === 'string' ? currency.toUpperCase() : '';
  const digits = code === 'JPY' ? 0 : 2;
  const absolute = Math.abs(amount).toString().padStart(digits + 1, '0');
  if (digits === 0) return `${amount < 0 ? '-' : ''}${absolute}`;
  const split = absolute.length - digits;
  return `${amount < 0 ? '-' : ''}${absolute.slice(0, split)}.${absolute.slice(split)}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function validateOwner(ownerId: number): void {
  validateId(ownerId, 'Banking owner ID');
}

function validateId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new PayeeValidationError(`${label} is invalid.`);
}

function rollback(database: DatabaseSync): void {
  try { database.exec('ROLLBACK;'); } catch { /* preserve original error */ }
}
