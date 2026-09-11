import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  parseTransactionQuery,
  getTransactionDetail,
  queryTransactions,
  TransactionQueryValidationError
} from '../services/transactions-query.js';
import type { EncryptionService } from '../security/encryption.js';
import { createEncryptionService } from '../security/encryption.js';
import {
  noStore,
  resolveAuthorizedUser,
  type SessionResolver
} from './route-security.js';

export function createTransactionRouter({
  database,
  resolveSession,
  encryption
}: {
  database: DatabaseSync;
  resolveSession: SessionResolver;
  encryption?: EncryptionService;
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

  router.get('/transactions/:transactionId', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const transactionId = positivePathId(request.params.transactionId);
    if (!transactionId) {
      noStore(response);
      response.status(404).json({ error: 'Transaction not found.' });
      return;
    }

    try {
      const detail = getTransactionDetail(database, user.id, transactionId, encryption ?? createEncryptionService());
      noStore(response);
      if (!detail) {
        response.status(404).json({ error: 'Transaction not found.' });
        return;
      }
      response.json({ data: detail });
    } catch {
      noStore(response);
      response.status(500).json({ error: 'Transaction details could not be loaded.' });
    }
  });

  return router;
}

function positivePathId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
