import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  CategorizationUnavailableError,
  type CategorizationClient
} from '../openai/categorizer.js';
import { categorizeUnresolvedTransactions } from '../services/transaction-categorization.js';
import {
  acceptCategorySuggestion,
  CategorySuggestionNotFoundError,
  CategorySuggestionValidationError,
  dismissCategorySuggestion
} from '../services/category-suggestions.js';
import {
  mutationIsAllowed,
  noStore,
  resolveAuthorizedUser,
  type SessionResolver
} from './route-security.js';

export function createCategorizationRouter({
  database,
  resolveSession,
  categorizer,
  clock = () => new Date()
}: {
  database: DatabaseSync;
  resolveSession: SessionResolver;
  categorizer: CategorizationClient;
  clock?: () => Date;
}): express.Router {
  const router = express.Router();

  router.get('/categorization/reviews', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const reviews = database.prepare(`
      SELECT ai_categorization_reviews.id, ai_categorization_reviews.transaction_id,
             ai_categorization_reviews.category_id, ai_categorization_reviews.confidence,
             ai_categorization_reviews.reason,
             ai_categorization_reviews.suggested_category_name,
             ai_categorization_reviews.suggested_category_type,
             ai_categorization_reviews.status,
             COALESCE(categories.id, suggested_categories.id) AS resolved_category_id,
             COALESCE(categories.name, suggested_categories.name) AS category_name,
             transactions.counterparty_name, transactions.merchant_name,
             transactions.purpose, transactions.amount_cents, transactions.currency,
             transactions.direction,
             COALESCE(transactions.booking_date, transactions.value_date, transactions.transaction_date) AS booking_date,
             CASE WHEN counterparties.counterparty_id IS NULL THEN 0 ELSE 1 END AS can_remember_counterparty
      FROM ai_categorization_reviews
      JOIN transactions ON transactions.id = ai_categorization_reviews.transaction_id
      JOIN bank_accounts ON bank_accounts.id = transactions.account_id
      JOIN enable_banking_connections
        ON enable_banking_connections.id = bank_accounts.connection_id
      LEFT JOIN categories ON categories.id = ai_categorization_reviews.category_id
      LEFT JOIN categories AS suggested_categories
        ON ai_categorization_reviews.category_id IS NULL
        AND suggested_categories.active = 1
        AND lower(suggested_categories.name) = lower(ai_categorization_reviews.suggested_category_name)
        AND suggested_categories.type = ai_categorization_reviews.suggested_category_type
      LEFT JOIN counterparties ON counterparties.id = transactions.counterparty_ref
      WHERE enable_banking_connections.yuvomi_user_id = ?
        AND ai_categorization_reviews.status = 'pending'
      ORDER BY ai_categorization_reviews.updated_at DESC, ai_categorization_reviews.id DESC
      LIMIT 100
    `).all(user.id) as Array<Record<string, unknown>>;
    noStore(response);
    response.json({ data: reviews.map(serializeReview) });
  });

  router.post('/categorization/reviews/:reviewId/dismiss', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    const reviewId = positivePathId(request.params.reviewId);
    if (!reviewId) {
      noStore(response);
      response.status(404).json({ error: 'Categorization review was not found.' });
      return;
    }
    const timestamp = clock().toISOString();
    const result = database.prepare(`
      UPDATE ai_categorization_reviews SET status = 'dismissed', resolved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND transaction_id IN (
        SELECT transactions.id FROM transactions
        JOIN bank_accounts ON bank_accounts.id = transactions.account_id
        JOIN enable_banking_connections ON enable_banking_connections.id = bank_accounts.connection_id
        WHERE enable_banking_connections.yuvomi_user_id = ?
      )
    `).run(timestamp, timestamp, reviewId, user.id);
    noStore(response);
    if (Number(result.changes) !== 1) {
      response.status(404).json({ error: 'Categorization review was not found.' });
      return;
    }
    response.json({ data: { id: reviewId, status: 'dismissed' } });
  });

  router.get('/category-suggestions', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const suggestions = database.prepare(`
      SELECT id, suggested_name, suggested_type, reason, sample_count, created_at
      FROM category_suggestions
      WHERE yuvomi_user_id = ? AND status = 'pending'
      ORDER BY sample_count DESC, created_at DESC, id DESC
      LIMIT 100
    `).all(user.id) as Array<{ id: number; suggested_name: string; suggested_type: string; reason: string; sample_count: number; created_at: string }>;
    const previews = database.prepare(`
      SELECT transactions.id AS transaction_id, transactions.merchant_name, transactions.counterparty_name,
             transactions.purpose, transactions.amount_cents, transactions.currency,
             COALESCE(transactions.booking_date, transactions.value_date, transactions.transaction_date) AS booking_date
      FROM ai_categorization_reviews
      JOIN transactions ON transactions.id = ai_categorization_reviews.transaction_id
      JOIN bank_accounts ON bank_accounts.id = transactions.account_id
      JOIN enable_banking_connections ON enable_banking_connections.id = bank_accounts.connection_id
      WHERE enable_banking_connections.yuvomi_user_id = ?
        AND ai_categorization_reviews.status = 'pending'
        AND lower(ai_categorization_reviews.suggested_category_name) = lower(?)
        AND ai_categorization_reviews.suggested_category_type = ?
      ORDER BY ai_categorization_reviews.updated_at DESC, ai_categorization_reviews.id DESC LIMIT 3
    `);
    const counts = database.prepare(`
      SELECT count(*) AS count FROM ai_categorization_reviews
      JOIN transactions ON transactions.id = ai_categorization_reviews.transaction_id
      JOIN bank_accounts ON bank_accounts.id = transactions.account_id
      JOIN enable_banking_connections ON enable_banking_connections.id = bank_accounts.connection_id
      WHERE enable_banking_connections.yuvomi_user_id = ? AND ai_categorization_reviews.status = 'pending'
        AND lower(ai_categorization_reviews.suggested_category_name) = lower(?)
        AND ai_categorization_reviews.suggested_category_type = ?
    `);
    noStore(response);
    response.json({ data: suggestions.map((suggestion) => ({
      ...suggestion,
      matching_review_count: Number(counts.get(user.id, suggestion.suggested_name, suggestion.suggested_type)?.count ?? 0),
      examples: previews.all(user.id, suggestion.suggested_name, suggestion.suggested_type)
    })) });
  });

  router.post('/category-suggestions/:suggestionId/accept', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      const result = acceptCategorySuggestion(database, {
        yuvomiUserId: user.id,
        suggestionId: positivePathId(request.params.suggestionId) ?? 0,
        name: request.body?.name,
        now: clock()
      });
      noStore(response);
      response.json({
        data: {
          id: result.suggestionId,
          status: 'accepted',
          category: result.category,
          matching_pending_reviews: result.matchingPendingReviews
        }
      });
    } catch (error) {
      noStore(response);
      response.status(
        error instanceof CategorySuggestionNotFoundError ? 404
          : error instanceof CategorySuggestionValidationError ? 409
            : 500
      ).json({
        error: error instanceof Error
          ? error.message
          : 'Category suggestion could not be accepted.'
      });
    }
  });

  router.get('/categorization/summary', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const owned = `
      FROM transactions JOIN bank_accounts ON bank_accounts.id = transactions.account_id
      JOIN enable_banking_connections ON enable_banking_connections.id = bank_accounts.connection_id
      WHERE enable_banking_connections.yuvomi_user_id = ?`;
    const count = (query: string) => Number(database.prepare(query).get(user.id)?.count ?? 0);
    noStore(response);
    response.json({ data: {
      uncategorized: count(`SELECT count(*) AS count ${owned} AND transactions.category_id IS NULL`),
      pending_reviews: count(`SELECT count(*) AS count FROM ai_categorization_reviews JOIN transactions ON transactions.id = ai_categorization_reviews.transaction_id JOIN bank_accounts ON bank_accounts.id = transactions.account_id JOIN enable_banking_connections ON enable_banking_connections.id = bank_accounts.connection_id WHERE enable_banking_connections.yuvomi_user_id = ? AND ai_categorization_reviews.status = 'pending'`),
      pending_category_suggestions: count(`SELECT count(*) AS count FROM category_suggestions WHERE yuvomi_user_id = ? AND status = 'pending'`),
      ai_applied_total: count(`SELECT count(*) AS count ${owned} AND transactions.category_source = 'ai'`)
    } });
  });

  router.get('/categorization/applied', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const applied = database.prepare(`
      SELECT transactions.id AS transaction_id, transactions.merchant_name, transactions.counterparty_name,
             transactions.purpose, transactions.category_confidence, categories.name AS category_name
      FROM transactions JOIN bank_accounts ON bank_accounts.id = transactions.account_id
      JOIN enable_banking_connections ON enable_banking_connections.id = bank_accounts.connection_id
      LEFT JOIN categories ON categories.id = transactions.category_id
      WHERE enable_banking_connections.yuvomi_user_id = ? AND transactions.category_source = 'ai'
      ORDER BY transactions.updated_at DESC, transactions.id DESC LIMIT 20
    `).all(user.id);
    noStore(response);
    response.json({ data: applied });
  });

  router.post('/category-suggestions/:suggestionId/dismiss', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      dismissCategorySuggestion(database, {
        yuvomiUserId: user.id,
        suggestionId: positivePathId(request.params.suggestionId) ?? 0,
        now: clock()
      });
      noStore(response);
      response.json({ data: { id: positivePathId(request.params.suggestionId), status: 'rejected' } });
    } catch (error) {
      noStore(response);
      response.status(
        error instanceof CategorySuggestionNotFoundError ? 404
          : error instanceof CategorySuggestionValidationError ? 409
            : 500
      ).json({
        error: error instanceof Error
          ? error.message
          : 'Category suggestion could not be dismissed.'
      });
    }
  });

  router.post('/categorization/run', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      const result = await categorizeUnresolvedTransactions(
        database,
        user.id,
        categorizer,
        clock()
      );
      noStore(response);
      response.json({ data: result });
    } catch (error) {
      noStore(response);
      response.status(error instanceof CategorizationUnavailableError ? 503 : 409).json({
        error: error instanceof Error
          ? error.message
          : 'Transactions could not be categorized.'
      });
    }
  });

  return router;
}

function serializeReview(review: Record<string, unknown>): Record<string, unknown> {
  const confidence = Number(review.confidence);
  const confidenceLevel = confidence >= 0.9 ? 'high' : confidence >= 0.75 ? 'medium' : 'low';
  const categoryId = Number.isSafeInteger(Number(review.resolved_category_id)) ? Number(review.resolved_category_id) : null;
  const suggestedName = typeof review.suggested_category_name === 'string' ? review.suggested_category_name : null;
  return {
    id: review.id,
    transaction_id: review.transaction_id,
    transaction: {
      merchant_name: review.merchant_name ?? null, counterparty_name: review.counterparty_name ?? null,
      purpose: review.purpose ?? null, amount_cents: review.amount_cents, currency: review.currency,
      direction: review.direction, booking_date: review.booking_date ?? null
    },
    proposal: {
      category_id: categoryId, category_name: review.category_name ?? null,
      suggested_category_name: suggestedName, suggested_category_type: review.suggested_category_type ?? null,
      confidence, confidence_level: confidenceLevel, reason: review.reason
    },
    can_accept_existing: categoryId !== null,
    requires_new_category: categoryId === null && Boolean(suggestedName),
    can_remember_counterparty: Boolean(review.can_remember_counterparty)
  };
}

function positivePathId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
