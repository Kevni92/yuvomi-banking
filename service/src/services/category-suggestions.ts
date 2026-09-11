import type { DatabaseSync } from 'node:sqlite';
import { isCategoryType, normalizeCategoryName, type CategoryType } from './categories.js';

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
  matchingPendingReviews: number;
}

export function acceptCategorySuggestion(
  database: DatabaseSync,
  input: { yuvomiUserId: number; suggestionId: number; name?: unknown; now?: Date }
): AcceptedCategorySuggestion {
  const now = input.now ?? new Date();
  assertInput(input.yuvomiUserId, input.suggestionId, now);
  const timestamp = now.toISOString();
  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;
    const suggestion = findPendingSuggestion(database, input.yuvomiUserId, input.suggestionId);
    const name = normalizeCategoryName(input.name ?? suggestion.suggested_name);
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
    const matchingPendingReviews = Number(database.prepare(`
      SELECT count(*) AS count
      FROM ai_categorization_reviews
      JOIN transactions ON transactions.id = ai_categorization_reviews.transaction_id
      JOIN bank_accounts ON bank_accounts.id = transactions.account_id
      JOIN enable_banking_connections ON enable_banking_connections.id = bank_accounts.connection_id
      WHERE enable_banking_connections.yuvomi_user_id = ?
        AND ai_categorization_reviews.status = 'pending'
        AND lower(ai_categorization_reviews.suggested_category_name) = lower(?)
        AND ai_categorization_reviews.suggested_category_type = ?
    `).get(input.yuvomiUserId, suggestion.suggested_name, suggestion.suggested_type)?.count ?? 0);
    database.exec('COMMIT;');
    transactionOpen = false;
    return {
      suggestionId: suggestion.id,
      category: {
        id: categoryId,
        name,
        type: suggestion.suggested_type,
        created
      },
      matchingPendingReviews
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

function rollback(database: DatabaseSync, transactionOpen: boolean): void {
  if (!transactionOpen) return;
  try {
    database.exec('ROLLBACK;');
  } catch {
    // Preserve the original failure.
  }
}
