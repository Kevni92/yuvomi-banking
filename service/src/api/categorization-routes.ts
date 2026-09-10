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
             categories.name AS category_name,
             transactions.counterparty_name, transactions.merchant_name,
             transactions.purpose
      FROM ai_categorization_reviews
      JOIN transactions ON transactions.id = ai_categorization_reviews.transaction_id
      JOIN bank_accounts ON bank_accounts.id = transactions.account_id
      JOIN enable_banking_connections
        ON enable_banking_connections.id = bank_accounts.connection_id
      LEFT JOIN categories ON categories.id = ai_categorization_reviews.category_id
      WHERE enable_banking_connections.yuvomi_user_id = ?
        AND ai_categorization_reviews.status = 'pending'
      ORDER BY ai_categorization_reviews.updated_at DESC, ai_categorization_reviews.id DESC
      LIMIT 100
    `).all(user.id) as Array<Record<string, unknown>>;
    noStore(response);
    response.json({ data: reviews.map((review) => ({ ...review })) });
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
    `).all(user.id) as Array<Record<string, unknown>>;
    noStore(response);
    response.json({ data: suggestions.map((suggestion) => ({ ...suggestion })) });
  });

  router.post('/category-suggestions/:suggestionId/accept', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      const result = acceptCategorySuggestion(database, {
        yuvomiUserId: user.id,
        suggestionId: positivePathId(request.params.suggestionId) ?? 0,
        now: clock()
      });
      noStore(response);
      response.json({
        data: {
          id: result.suggestionId,
          status: 'accepted',
          category: result.category
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

function positivePathId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
