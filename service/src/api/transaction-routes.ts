import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  parseTransactionQuery,
  queryTransactions,
  TransactionQueryValidationError
} from '../services/transactions-query.js';
import {
  noStore,
  resolveAuthorizedUser,
  type SessionResolver
} from './route-security.js';

export function createTransactionRouter({
  database,
  resolveSession
}: {
  database: DatabaseSync;
  resolveSession: SessionResolver;
}): express.Router {
  const router = express.Router();

  router.get('/transactions', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;

    try {
      const query = parseTransactionQuery(user.id, request.query as Record<string, unknown>);
      const result = queryTransactions(database, query);
      noStore(response);
      response.json({
        data: {
          transactions: result.transactions,
          pagination: {
            total: result.total,
            limit: result.limit,
            offset: result.offset
          }
        }
      });
    } catch (error) {
      if (error instanceof TransactionQueryValidationError) {
        noStore(response);
        response.status(400).json({ error: error.message });
        return;
      }
      noStore(response);
      response.status(500).json({ error: 'Transactions could not be loaded.' });
    }
  });

  return router;
}
