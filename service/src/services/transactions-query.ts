import type { DatabaseSync } from 'node:sqlite';
import type { EncryptionService } from '../security/encryption.js';

export type TransactionSort = 'date' | 'amount' | 'merchant' | 'account' | 'category' | 'status';
export type TransactionOrder = 'asc' | 'desc';
export type TransactionDirection = 'incoming' | 'outgoing';
export type TransactionStatus = 'BOOK' | 'PDNG' | 'UNKNOWN';

export interface TransactionQuery {
  userId: number;
  q?: string;
  accountId?: number;
  categoryId?: number;
  uncategorized?: boolean;
  direction?: TransactionDirection;
  status?: TransactionStatus;
  dateFrom?: string;
  dateTo?: string;
  sort: TransactionSort;
  order: TransactionOrder;
  limit: number;
  offset: number;
}

export interface PublicTransaction {
  id: number;
  account_id: number;
  account_display_name?: string | null;
  booking_date: string | null;
  value_date: string | null;
  transaction_date: string | null;
  amount: string;
  currency: string;
  direction: TransactionDirection;
  counterparty_name: string | null;
  purpose: string | null;
  merchant_name: string | null;
  merchant_key: string | null;
  merchant_logo_available: number;
  status: TransactionStatus;
  category_id: number | null;
  category_name: string | null;
  category_source: string | null;
  category_confidence: number | null;
  weekly_budget_override: string;
  category_weekly_budget_default: number | null;
}

export interface TransactionQueryResult {
  transactions: PublicTransaction[];
  total: number;
  limit: number;
  offset: number;
}

export interface TransactionDetail {
  transaction: Record<string, unknown>;
  account: Record<string, unknown>;
  bank: Record<string, unknown>;
  counterparty: Record<string, unknown> | null;
  provider_raw_available: boolean;
  provider_raw: unknown | null;
}

export class TransactionQueryValidationError extends Error {}

const SORT_SQL: Record<TransactionSort, string> = {
  date: 'COALESCE(transactions.booking_date, transactions.value_date, transactions.transaction_date)',
  amount: 'transactions.amount_cents',
  merchant: "COALESCE(transactions.merchant_name, transactions.counterparty_name, transactions.purpose, '') COLLATE NOCASE",
  account: "COALESCE(bank_accounts.display_name, '') COLLATE NOCASE",
  category: "COALESCE(categories.name, '') COLLATE NOCASE",
  status: 'transactions.status'
};

const PUBLIC_SELECT = `
  SELECT transactions.id, transactions.account_id,
         bank_accounts.display_name AS account_display_name,
         transactions.booking_date, transactions.value_date,
         transactions.transaction_date, transactions.amount_cents,
         transactions.currency, transactions.direction,
         transactions.counterparty_name, transactions.purpose,
         transactions.merchant_name, transactions.merchant_key, transactions.status,
         transactions.category_id, transactions.category_source,
         transactions.category_confidence,
         categories.name AS category_name,
         CASE WHEN merchant_logos.logo_key IS NULL THEN 0 ELSE 1 END AS merchant_logo_available,
         transactions.weekly_budget_override,
         categories.weekly_budget_default AS category_weekly_budget_default
`;

const JOINS = `
  FROM transactions
  JOIN bank_accounts ON bank_accounts.id = transactions.account_id
  JOIN enable_banking_connections
    ON enable_banking_connections.id = bank_accounts.connection_id
  LEFT JOIN categories ON categories.id = transactions.category_id
  LEFT JOIN merchant_logos ON merchant_logos.logo_key = transactions.merchant_key
`;

export function queryTransactions(
  database: DatabaseSync,
  query: TransactionQuery
): TransactionQueryResult {
  const { where, params } = buildWhere(query);
  const sortColumn = SORT_SQL[query.sort];
  const direction = query.order.toUpperCase();
  const rows = database.prepare(`
    ${PUBLIC_SELECT}
    ${JOINS}
    ${where}
    ORDER BY ${sortColumn} ${direction}, transactions.id ${direction}
    LIMIT ? OFFSET ?
  `).all(...params, query.limit, query.offset) as Array<Record<string, unknown>>;
  const totalRow = database.prepare(`
    SELECT COUNT(*) AS total
    ${JOINS}
    ${where}
  `).get(...params) as { total: number };

  return {
    transactions: rows.map(toPublicTransaction),
    total: Number(totalRow?.total ?? 0),
    limit: query.limit,
    offset: query.offset
  };
}

export function listPublicTransactions(
  database: DatabaseSync,
  userId: number,
  accountId: number
): Array<Record<string, unknown>> {
  return queryTransactions(database, {
    userId,
    accountId,
    sort: 'date',
    order: 'desc',
    limit: 100,
    offset: 0
  }).transactions.map(({ account_display_name: _accountDisplayName, account_id: _accountId, ...transaction }) => transaction);
}

/**
 * Returns the complete local representation of one transaction. This is
 * deliberately separate from the list query: the list never receives IBANs,
 * encrypted payloads, or provider raw data.
 */
export function getTransactionDetail(
  database: DatabaseSync,
  userId: number,
  transactionId: number,
  encryption: EncryptionService
): TransactionDetail | null {
  const row = database.prepare(`
    SELECT
      transactions.id, transactions.account_id, transactions.provider_transaction_id,
      transactions.entry_reference, transactions.transaction_id,
      transactions.booking_date, transactions.value_date, transactions.transaction_date,
      transactions.amount_cents, transactions.currency, transactions.direction,
      transactions.counterparty_name, transactions.purpose, transactions.merchant_name,
      transactions.merchant_key, transactions.mcc, transactions.status,
      transactions.category_id, transactions.category_source, transactions.category_confidence,
      transactions.weekly_budget_override, transactions.yuvomi_budget_entry_id,
      transactions.created_at, transactions.updated_at, transactions.raw_payload_encrypted,
      categories.name AS category_name,
      categories.weekly_budget_default AS category_weekly_budget_default,
      bank_accounts.display_name AS account_display_name,
      bank_accounts.currency AS account_currency,
      bank_accounts.account_type AS account_type,
      bank_accounts.provider_account_id,
      bank_accounts.iban_encrypted AS account_iban_encrypted,
      enable_banking_connections.aspsp_name,
      enable_banking_connections.aspsp_country,
      counterparties.counterparty_id,
      counterparties.display_name AS counterparty_display_name,
      counterparties.iban_encrypted AS counterparty_iban_encrypted,
      counterparties.normalized_merchant_name,
      counterparties.logo_key AS counterparty_logo_key
    FROM transactions
    JOIN bank_accounts ON bank_accounts.id = transactions.account_id
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    LEFT JOIN categories ON categories.id = transactions.category_id
    LEFT JOIN counterparties ON counterparties.id = transactions.counterparty_ref
    WHERE transactions.id = ? AND enable_banking_connections.yuvomi_user_id = ?
    LIMIT 1
  `).get(transactionId, userId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const amountCents = row.amount_cents;
  const transaction = {
    id: row.id,
    account_id: row.account_id,
    provider_transaction_id: row.provider_transaction_id,
    entry_reference: row.entry_reference,
    transaction_id: row.transaction_id,
    booking_date: row.booking_date,
    value_date: row.value_date,
    transaction_date: row.transaction_date,
    amount_cents: amountCents,
    amount: formatMinorUnits(amountCents, row.currency),
    currency: row.currency,
    direction: row.direction,
    counterparty_name: row.counterparty_name,
    purpose: row.purpose,
    merchant_name: row.merchant_name,
    merchant_key: row.merchant_key,
    mcc: row.mcc,
    status: row.status,
    category_id: row.category_id,
    category_name: row.category_name,
    category_source: row.category_source,
    category_confidence: row.category_confidence,
    weekly_budget_override: row.weekly_budget_override,
    category_weekly_budget_default: row.category_weekly_budget_default === null
      ? null : Boolean(row.category_weekly_budget_default),
    yuvomi_budget_entry_id: row.yuvomi_budget_entry_id,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  const account = {
    id: row.account_id,
    display_name: row.account_display_name,
    currency: row.account_currency,
    account_type: row.account_type,
    provider_account_id: row.provider_account_id,
    iban: decryptOrNull(row.account_iban_encrypted, encryption)
  };
  const counterparty = row.counterparty_id === null ? null : {
    counterparty_id: row.counterparty_id,
    display_name: row.counterparty_display_name,
    iban: decryptOrNull(row.counterparty_iban_encrypted, encryption),
    normalized_merchant_name: row.normalized_merchant_name,
    logo_key: row.counterparty_logo_key
  };
  const providerRaw = parseProviderRaw(row.raw_payload_encrypted, encryption);

  return {
    transaction,
    account,
    bank: { aspsp_name: row.aspsp_name, aspsp_country: row.aspsp_country },
    counterparty,
    provider_raw_available: providerRaw !== null,
    provider_raw: providerRaw
  };
}

function decryptOrNull(value: unknown, encryption: EncryptionService): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return encryption.decrypt(value);
  } catch {
    return null;
  }
}

function parseProviderRaw(value: unknown, encryption: EncryptionService): unknown | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(encryption.decrypt(value));
  } catch {
    return null;
  }
}

function buildWhere(query: TransactionQuery): { where: string; params: Array<string | number> } {
  const clauses = ['enable_banking_connections.yuvomi_user_id = ?'];
  const params: Array<string | number> = [query.userId];

  if (query.q) {
    const search = `%${query.q}%`;
    clauses.push(`(
      LOWER(COALESCE(transactions.merchant_name, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(transactions.counterparty_name, '')) LIKE LOWER(?)
      OR LOWER(COALESCE(transactions.purpose, '')) LIKE LOWER(?)
    )`);
    params.push(search, search, search);
  }
  if (query.accountId !== undefined) {
    clauses.push('transactions.account_id = ?');
    params.push(query.accountId);
  }
  if (query.categoryId !== undefined) {
    clauses.push('transactions.category_id = ?');
    params.push(query.categoryId);
  }
  if (query.uncategorized) clauses.push('transactions.category_id IS NULL');
  if (query.direction) {
    clauses.push('transactions.direction = ?');
    params.push(query.direction);
  }
  if (query.status) {
    clauses.push('transactions.status = ?');
    params.push(query.status);
  }
  if (query.dateFrom) {
    clauses.push('COALESCE(transactions.booking_date, transactions.value_date, transactions.transaction_date) >= ?');
    params.push(query.dateFrom);
  }
  if (query.dateTo) {
    clauses.push('COALESCE(transactions.booking_date, transactions.value_date, transactions.transaction_date) <= ?');
    params.push(query.dateTo);
  }

  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

export function parseTransactionQuery(
  userId: number,
  raw: Record<string, unknown>
): TransactionQuery {
  const q = optionalString(raw.q, 'q', 200);
  const accountId = optionalPositiveInteger(raw.account_id, 'account_id');
  const categoryId = optionalPositiveInteger(raw.category_id, 'category_id');
  const uncategorizedValue = raw.uncategorized === undefined
    ? undefined
    : exactString(raw.uncategorized, 'uncategorized');
  if (uncategorizedValue !== undefined && uncategorizedValue !== '0' && uncategorizedValue !== '1') {
    throw new TransactionQueryValidationError('uncategorized is invalid.');
  }
  const uncategorized = uncategorizedValue === '1';
  if (categoryId !== undefined && uncategorized) {
    throw new TransactionQueryValidationError('category_id and uncategorized cannot be combined.');
  }

  const direction = optionalEnum(raw.direction, 'direction', ['incoming', 'outgoing'] as const);
  const status = optionalEnum(raw.status, 'status', ['BOOK', 'PDNG', 'UNKNOWN'] as const);
  const dateFrom = optionalDate(raw.date_from, 'date_from');
  const dateTo = optionalDate(raw.date_to, 'date_to');
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new TransactionQueryValidationError('date_from must not be after date_to.');
  }
  const sort = optionalEnum(raw.sort, 'sort', Object.keys(SORT_SQL) as TransactionSort[]) ?? 'date';
  const order = optionalEnum(raw.order, 'order', ['asc', 'desc'] as const) ?? 'desc';
  const limit = raw.limit === undefined ? 50 : requiredInteger(raw.limit, 'limit', 1, 100);
  const offset = raw.offset === undefined ? 0 : requiredInteger(raw.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);

  return {
    userId,
    ...(q ? { q } : {}),
    ...(accountId === undefined ? {} : { accountId }),
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(uncategorized ? { uncategorized: true } : {}),
    ...(direction ? { direction } : {}),
    ...(status ? { status } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    sort,
    order,
    limit,
    offset
  };
}

function toPublicTransaction({ amount_cents, ...row }: Record<string, unknown>): PublicTransaction {
  return {
    ...row,
    amount: formatMinorUnits(amount_cents, row.currency)
  } as PublicTransaction;
}

function formatMinorUnits(value: unknown, currency: unknown): string {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(amount)) return '';
  const code = typeof currency === 'string' ? currency.toUpperCase() : '';
  const minorDigits = code === 'JPY' ? 0 : 2;
  const negative = amount < 0;
  const absolute = Math.abs(amount).toString().padStart(minorDigits + 1, '0');
  if (minorDigits === 0) return `${negative ? '-' : ''}${absolute}`;
  const split = absolute.length - minorDigits;
  return `${negative ? '-' : ''}${absolute.slice(0, split)}.${absolute.slice(split)}`;
}

function exactString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TransactionQueryValidationError(`${name} is invalid.`);
  return value;
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const result = exactString(value, name).trim();
  if (result.length > maxLength) throw new TransactionQueryValidationError(`${name} is too long.`);
  return result || undefined;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredInteger(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function requiredInteger(value: unknown, name: string, min: number, max: number): number {
  const stringValue = exactString(value, name);
  if (!/^\d+$/.test(stringValue)) throw new TransactionQueryValidationError(`${name} is invalid.`);
  const result = Number(stringValue);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new TransactionQueryValidationError(`${name} is invalid.`);
  }
  return result;
}

function optionalDate(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const result = exactString(value, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new TransactionQueryValidationError(`${name} is invalid.`);
  }
  const [year, month, day] = result.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TransactionQueryValidationError(`${name} is invalid.`);
  }
  return result;
}

function optionalEnum<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[]
): T | undefined {
  if (value === undefined) return undefined;
  const result = exactString(value, name) as T;
  if (!allowed.includes(result)) throw new TransactionQueryValidationError(`${name} is invalid.`);
  return result;
}
