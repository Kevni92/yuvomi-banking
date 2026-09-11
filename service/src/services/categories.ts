import type { DatabaseSync } from 'node:sqlite';

export type CategoryType = 'expense' | 'income' | 'transfer';

export interface BankingCategory {
  id: number;
  name: string;
  type: CategoryType;
  active: boolean;
  weeklyBudgetDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export class CategoryNotFoundError extends Error {}
export class CategoryValidationError extends Error {}
export class CategoryConflictError extends Error {}

export function normalizeCategoryName(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().replace(/\s+/g, ' ')
    : '';
}

export function isCategoryType(value: unknown): value is CategoryType {
  return value === 'expense' || value === 'income' || value === 'transfer';
}

export function listCategories(
  database: DatabaseSync,
  { includeInactive = true }: { includeInactive?: boolean } = {}
): BankingCategory[] {
  const rows = database.prepare(`
    SELECT id, name, type, active, weekly_budget_default, created_at, updated_at
    FROM categories
    ${includeInactive ? '' : 'WHERE active = 1'}
    ORDER BY active DESC,
      CASE type WHEN 'expense' THEN 1 WHEN 'income' THEN 2 WHEN 'transfer' THEN 3 END,
      name COLLATE NOCASE, id
  `).all() as unknown as CategoryRow[];
  return rows.map(toCategory);
}

export function createCategory(
  database: DatabaseSync,
  input: { name: unknown; type: unknown; weeklyBudgetDefault?: unknown; now?: Date }
): BankingCategory {
  const name = validateName(input.name);
  if (!isCategoryType(input.type)) throw new CategoryValidationError('Category type is invalid.');
  const weeklyBudgetDefault = validateWeeklyBudgetDefault(input.weeklyBudgetDefault ?? false, input.type, true);
  const timestamp = timestampFor(input.now);
  let open = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    open = true;
    assertNameAvailable(database, name, input.type);
    const result = database.prepare(`
      INSERT INTO categories (name, type, active, weekly_budget_default, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?)
    `).run(name, input.type, weeklyBudgetDefault ? 1 : 0, timestamp, timestamp);
    const category = findCategory(database, Number(result.lastInsertRowid));
    database.exec('COMMIT;');
    open = false;
    return category;
  } catch (error) {
    rollback(database, open);
    throw error;
  }
}

export function updateCategory(
  database: DatabaseSync,
  categoryId: number,
  input: { name?: unknown; active?: unknown; weeklyBudgetDefault?: unknown; now?: Date }
): BankingCategory {
  if (!Number.isSafeInteger(categoryId) || categoryId < 1) {
    throw new CategoryNotFoundError('Category not found.');
  }
  const fields = Object.keys(input).filter((key) => key !== 'now');
  if (fields.length === 0) throw new CategoryValidationError('At least one category field is required.');
  if (fields.some((key) => !['name', 'active', 'weeklyBudgetDefault'].includes(key))) {
    throw new CategoryValidationError('Category fields are invalid.');
  }
  const timestamp = timestampFor(input.now);
  let open = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    open = true;
    const existing = findCategory(database, categoryId);
    const name = Object.hasOwn(input, 'name') ? validateName(input.name) : existing.name;
    const active = Object.hasOwn(input, 'active') ? validateActive(input.active) : existing.active;
    const weeklyBudgetDefault = Object.hasOwn(input, 'weeklyBudgetDefault')
      ? validateWeeklyBudgetDefault(input.weeklyBudgetDefault, existing.type)
      : existing.weeklyBudgetDefault;
    if (Object.hasOwn(input, 'name')) assertNameAvailable(database, name, existing.type, categoryId);
    database.prepare(`
      UPDATE categories
      SET name = ?, active = ?, weekly_budget_default = ?, updated_at = ?
      WHERE id = ?
    `).run(name, active ? 1 : 0, weeklyBudgetDefault ? 1 : 0, timestamp, categoryId);
    const category = findCategory(database, categoryId);
    database.exec('COMMIT;');
    open = false;
    return category;
  } catch (error) {
    rollback(database, open);
    throw error;
  }
}

interface CategoryRow {
  id: number;
  name: string;
  type: string;
  active: number;
  weekly_budget_default: number;
  created_at: string;
  updated_at: string;
}

function toCategory(row: CategoryRow): BankingCategory {
  if (!isCategoryType(row.type)) throw new CategoryValidationError('Stored category type is invalid.');
  return {
    id: Number(row.id), name: row.name, type: row.type,
    active: Boolean(row.active), weeklyBudgetDefault: Boolean(row.weekly_budget_default),
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function findCategory(database: DatabaseSync, categoryId: number): BankingCategory {
  const row = database.prepare(`
    SELECT id, name, type, active, weekly_budget_default, created_at, updated_at
    FROM categories WHERE id = ?
  `).get(categoryId) as CategoryRow | undefined;
  if (!row) throw new CategoryNotFoundError('Category not found.');
  return toCategory(row);
}

function validateName(value: unknown): string {
  const name = normalizeCategoryName(value);
  if (!name) throw new CategoryValidationError('Category name is required.');
  if (name.length > 80) throw new CategoryValidationError('Category name must not exceed 80 characters.');
  return name;
}

function validateActive(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new CategoryValidationError('Category active must be a boolean.');
  return value;
}

function validateWeeklyBudgetDefault(
  value: unknown,
  type: CategoryType,
  normalizeForNonExpense = false
): boolean {
  if (typeof value !== 'boolean') {
    throw new CategoryValidationError('Category weekly_budget_default must be a boolean.');
  }
  if (value && type !== 'expense') {
    if (normalizeForNonExpense) return false;
    throw new CategoryValidationError('Only expense categories can be included in the weekly budget by default.');
  }
  return value;
}

function assertNameAvailable(database: DatabaseSync, name: string, type: CategoryType, exceptId?: number): void {
  const row = database.prepare(`
    SELECT id, active FROM categories
    WHERE name = ? COLLATE NOCASE AND type = ? ${exceptId ? 'AND id <> ?' : ''}
    ORDER BY id LIMIT 1
  `).get(...(exceptId ? [name, type, exceptId] : [name, type])) as { id: number; active: number } | undefined;
  if (!row) return;
  throw new CategoryConflictError(row.active
    ? 'A category with this name and type already exists.'
    : 'A matching inactive category already exists and can be reactivated.');
}

function timestampFor(value: Date | undefined): string {
  const now = value ?? new Date();
  if (Number.isNaN(now.getTime())) throw new CategoryValidationError('Category time is invalid.');
  return now.toISOString();
}

function rollback(database: DatabaseSync, open: boolean): void {
  if (!open) return;
  try { database.exec('ROLLBACK;'); } catch { /* preserve original error */ }
}
