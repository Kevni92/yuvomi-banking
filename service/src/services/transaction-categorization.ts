import type { DatabaseSync } from 'node:sqlite';
import {
  type CategorizationCategory,
  type CategorizationClient,
  type CategorizationResult,
  type CategorizationTransaction,
  redactCategorizationText
} from '../openai/categorizer.js';
import { applyCategoryRulesForAccount } from './category-rules.js';

// Keep this threshold explicit: 0.75 is the current product decision. Revisit
// it (in particular against a more conservative 0.90) before production use.
export const AUTO_APPLY_CONFIDENCE = 0.75;
const BATCH_LIMIT = 25;

interface CandidateRow {
  id: number;
  counterparty_id: string | null;
  counterparty_name: string | null;
  merchant_name: string | null;
  purpose: string | null;
  amount_cents: number;
  currency: string;
  direction: string;
  mcc: string | null;
}

export interface CategorizationRunResult {
  submitted: number;
  applied: number;
  pendingReview: number;
  categorySuggestions: number;
}

export async function categorizeUnresolvedTransactions(
  database: DatabaseSync,
  yuvomiUserId: number,
  categorizer: CategorizationClient,
  now = new Date()
): Promise<CategorizationRunResult> {
  if (!Number.isSafeInteger(yuvomiUserId) || yuvomiUserId < 1) {
    throw new Error('Banking user ID is invalid.');
  }
  if (Number.isNaN(now.getTime())) throw new Error('Categorization time is invalid.');

  applyRulesForUser(database, yuvomiUserId, now);
  const categories = activeCategories(database);
  const candidates = unresolvedTransactions(database, yuvomiUserId);
  if (candidates.length === 0) {
    return { submitted: 0, applied: 0, pendingReview: 0, categorySuggestions: 0 };
  }
  const input = candidates.map(toSafeCategorizationTransaction);
  const responses = await categorizer.categorize({ categories, transactions: input, locale: 'de' });
  return persistCategorizationResults(database, yuvomiUserId, candidates, categories, responses, now);
}

function applyRulesForUser(database: DatabaseSync, yuvomiUserId: number, now: Date): void {
  const accountIds = database.prepare(`
    SELECT bank_accounts.id
    FROM bank_accounts
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    WHERE enable_banking_connections.yuvomi_user_id = ?
  `).all(yuvomiUserId) as Array<{ id: number }>;
  for (const account of accountIds) {
    applyCategoryRulesForAccount(database, Number(account.id), now);
  }
}

function activeCategories(database: DatabaseSync): CategorizationCategory[] {
  return database.prepare(`
    SELECT id, name, type FROM categories WHERE active = 1 ORDER BY name, id
  `).all().map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    type: row.type as CategorizationCategory['type']
  }));
}

function unresolvedTransactions(database: DatabaseSync, yuvomiUserId: number): CandidateRow[] {
  return database.prepare(`
    SELECT transactions.id, counterparties.counterparty_id,
           transactions.counterparty_name, transactions.merchant_name,
           transactions.purpose, transactions.amount_cents,
           transactions.currency, transactions.direction, transactions.mcc
    FROM transactions
    JOIN bank_accounts ON bank_accounts.id = transactions.account_id
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    LEFT JOIN counterparties ON counterparties.id = transactions.counterparty_ref
    WHERE enable_banking_connections.yuvomi_user_id = ?
      AND transactions.category_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ai_categorization_reviews
        WHERE ai_categorization_reviews.transaction_id = transactions.id
          AND ai_categorization_reviews.status IN ('pending', 'dismissed')
      )
    ORDER BY COALESCE(transactions.booking_date, transactions.value_date, transactions.transaction_date) DESC,
             transactions.id DESC
    LIMIT ?
  `).all(yuvomiUserId, BATCH_LIMIT) as unknown as CandidateRow[];
}

function toSafeCategorizationTransaction(row: CandidateRow): CategorizationTransaction {
  return {
    transaction_id: Number(row.id),
    counterparty_id: stringOrNull(row.counterparty_id),
    counterparty_name: redactCategorizationText(row.counterparty_name),
    merchant_name: redactCategorizationText(row.merchant_name),
    purpose: redactCategorizationText(row.purpose),
    amount_cents: Number(row.amount_cents),
    currency: String(row.currency),
    direction: row.direction === 'incoming' ? 'incoming' : 'outgoing',
    mcc: redactCategorizationText(row.mcc)
  };
}

function persistCategorizationResults(
  database: DatabaseSync,
  yuvomiUserId: number,
  candidates: CandidateRow[],
  categories: CategorizationCategory[],
  responses: CategorizationResult[],
  now: Date
): CategorizationRunResult {
  const candidateIds = new Set(candidates.map((candidate) => Number(candidate.id)));
  const allowedCategoryIds = new Set(categories.map((category) => category.id));
  const uniqueResponses = new Map<number, CategorizationResult>();
  for (const response of responses) {
    if (candidateIds.has(response.transaction_id)) uniqueResponses.set(response.transaction_id, response);
  }
  const timestamp = now.toISOString();
  const updateCategorized = database.prepare(`
    UPDATE transactions SET category_id = ?, category_source = 'ai',
      category_confidence = ?, updated_at = ?
    WHERE id = ? AND category_id IS NULL AND account_id IN (
      SELECT bank_accounts.id
      FROM bank_accounts
      JOIN enable_banking_connections
        ON enable_banking_connections.id = bank_accounts.connection_id
      WHERE enable_banking_connections.yuvomi_user_id = ?
    )
  `);
  const upsertReview = database.prepare(`
    INSERT INTO ai_categorization_reviews (
      transaction_id, category_id, confidence, reason,
      suggested_category_name, suggested_category_type, status,
      created_at, updated_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
    ON CONFLICT(transaction_id) DO UPDATE SET
      category_id = excluded.category_id,
      confidence = excluded.confidence,
      reason = excluded.reason,
      suggested_category_name = excluded.suggested_category_name,
      suggested_category_type = excluded.suggested_category_type,
      status = 'pending', updated_at = excluded.updated_at, resolved_at = NULL
  `);
  const findSuggestion = database.prepare(`
    SELECT id, status FROM category_suggestions
    WHERE yuvomi_user_id = ? AND lower(suggested_name) = lower(?)
      AND suggested_type = ?
    LIMIT 1
  `);
  const incrementSuggestion = database.prepare(`
    UPDATE category_suggestions SET sample_count = sample_count + 1 WHERE id = ?
  `);
  const insertSuggestion = database.prepare(`
    INSERT INTO category_suggestions (
      yuvomi_user_id, suggested_name, suggested_type, reason, sample_count, status, created_at
    ) VALUES (?, ?, ?, ?, 1, 'pending', ?)
  `);

  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;
    let applied = 0;
    let pendingReview = 0;
    let categorySuggestions = 0;
    for (const candidate of candidates) {
      const response = uniqueResponses.get(Number(candidate.id));
      if (!response) continue;
      const categoryId = response.category_id && allowedCategoryIds.has(response.category_id)
        ? response.category_id
        : null;
      const suggested = response.suggested_category;
      if (categoryId !== null && response.confidence >= AUTO_APPLY_CONFIDENCE) {
        const changed = updateCategorized.run(
          categoryId,
          response.confidence,
          timestamp,
          candidate.id,
          yuvomiUserId
        );
        applied += Number(changed.changes);
      } else {
        upsertReview.run(
          candidate.id,
          categoryId,
          response.confidence,
          response.reason,
          suggested?.name ?? null,
          suggested?.type ?? null,
          timestamp,
          timestamp
        );
        pendingReview += 1;
      }
      if (suggested) {
        const existing = findSuggestion.get(
          yuvomiUserId,
          suggested.name,
          suggested.type
        ) as { id: number; status: string } | undefined;
        if (existing?.status === 'pending') {
          incrementSuggestion.run(existing.id);
          categorySuggestions += 1;
        } else if (!existing) {
          insertSuggestion.run(
            yuvomiUserId,
            suggested.name,
            suggested.type,
            response.reason,
            timestamp
          );
          categorySuggestions += 1;
        }
      }
    }
    database.exec('COMMIT;');
    transactionOpen = false;
    return {
      submitted: candidates.length,
      applied,
      pendingReview,
      categorySuggestions
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  }
}

function stringOrNull(value: string | null): string | null {
  return typeof value === 'string' && value ? value : null;
}
