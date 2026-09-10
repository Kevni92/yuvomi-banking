import type { DatabaseSync } from 'node:sqlite';

type CategoryType = 'expense' | 'income' | 'transfer';

export class CategorySuggestionNotFoundError extends Error {}
export class CategorySuggestionValidationError extends Error {}

export interface AcceptedCategorySuggestion {
  suggestionId: number;
  category: {
    id: number;
    name: string;
    type: CategoryType;
    created: boolean;
  };
}

export function acceptCategorySuggestion(
  database: DatabaseSync,
  input: { yuvomiUserId: number; suggestionId: number; now?: Date }
): AcceptedCategorySuggestion {
  const now = input.now ?? new Date();
  assertInput(input.yuvomiUserId, input.suggestionId, now);
  const timestamp = now.toISOString();
  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;
    const suggestion = findPendingSuggestion(database, input.yuvomiUserId, input.suggestionId);
    const name = normalizeCategoryName(suggestion.suggested_name);
    if (!name || name.length > 80 || !isCategoryType(suggestion.suggested_type)) {
      throw new CategorySuggestionValidationError('Category suggestion is invalid.');
    }

    const existing = database.prepare(`
      SELECT id, active FROM categories
      WHERE lower(name) = lower(?) AND type = ?
      ORDER BY id
      LIMIT 1
    `).get(name, suggestion.suggested_type) as { id: number; active: number } | undefined;
    let categoryId: number;
    let created = false;
    if (existing) {
      categoryId = Number(existing.id);
      if (!existing.active) {
        database.prepare(`
          UPDATE categories SET active = 1, updated_at = ? WHERE id = ?
        `).run(timestamp, categoryId);
      }
    } else {
      const result = database.prepare(`
        INSERT INTO categories (name, type, active, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `).run(name, suggestion.suggested_type, timestamp, timestamp);
      categoryId = Number(result.lastInsertRowid);
      created = true;
    }
    decideSuggestion(database, suggestion.id, 'accepted', timestamp);
    database.exec('COMMIT;');
    transactionOpen = false;
    return {
      suggestionId: suggestion.id,
      category: {
        id: categoryId,
        name,
        type: suggestion.suggested_type,
        created
      }
    };
  } catch (error) {
    rollback(database, transactionOpen);
    throw error;
  }
}

export function dismissCategorySuggestion(
  database: DatabaseSync,
  input: { yuvomiUserId: number; suggestionId: number; now?: Date }
): void {
  const now = input.now ?? new Date();
  assertInput(input.yuvomiUserId, input.suggestionId, now);
  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;
    const suggestion = findPendingSuggestion(database, input.yuvomiUserId, input.suggestionId);
    decideSuggestion(database, suggestion.id, 'rejected', now.toISOString());
    database.exec('COMMIT;');
    transactionOpen = false;
  } catch (error) {
    rollback(database, transactionOpen);
    throw error;
  }
}

function findPendingSuggestion(
  database: DatabaseSync,
  yuvomiUserId: number,
  suggestionId: number
): { id: number; suggested_name: string; suggested_type: string } {
  const row = database.prepare(`
    SELECT id, suggested_name, suggested_type
    FROM category_suggestions
    WHERE id = ? AND yuvomi_user_id = ? AND status = 'pending'
    LIMIT 1
  `).get(suggestionId, yuvomiUserId) as {
    id: number;
    suggested_name: string;
    suggested_type: string;
  } | undefined;
  if (!row) throw new CategorySuggestionNotFoundError('Category suggestion was not found.');
  return row;
}

function decideSuggestion(
  database: DatabaseSync,
  suggestionId: number,
  status: 'accepted' | 'rejected',
  timestamp: string
): void {
  database.prepare(`
    UPDATE category_suggestions SET status = ?, decided_at = ? WHERE id = ?
  `).run(status, timestamp, suggestionId);
}

function assertInput(yuvomiUserId: number, suggestionId: number, now: Date): void {
  if (
    !Number.isSafeInteger(yuvomiUserId) || yuvomiUserId < 1
    || !Number.isSafeInteger(suggestionId) || suggestionId < 1
    || Number.isNaN(now.getTime())
  ) {
    throw new CategorySuggestionValidationError('Category suggestion input is invalid.');
  }
}

function normalizeCategoryName(value: string): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/g, ' ')
    : '';
}

function isCategoryType(value: string): value is CategoryType {
  return value === 'expense' || value === 'income' || value === 'transfer';
}

function rollback(database: DatabaseSync, transactionOpen: boolean): void {
  if (!transactionOpen) return;
  try {
    database.exec('ROLLBACK;');
  } catch {
    // Preserve the original failure.
  }
}
