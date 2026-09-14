import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  clearPayeeCategory,
  getRecurringPayee,
  listPayeeTransactions,
  listRecurringPayees,
  PayeeCategoryConflictError,
  PayeeNotFoundError,
  PayeeValidationError,
  setPayeeCategory
} from '../services/recurring-payees.js';
import type { PayeeSort } from '../services/recurring-payees.js';
import type { TransactionOrder, TransactionSort } from '../services/transactions-query.js';
import { mutationIsAllowed, noStore, resolveAuthorizedUser, type SessionResolver } from './route-security.js';

export function createPayeeRouter({
  database,
  resolveSession,
  clock = () => new Date()
}: {
  database: DatabaseSync;
  resolveSession: SessionResolver;
  clock?: () => Date;
}): express.Router {
  const router = express.Router();

  router.get('/payees', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    try {
      const result = listRecurringPayees(database, {
        ownerId: user.id,
        recurring: queryBoolean(request.query.recurring, true),
        sort: queryEnum<PayeeSort>(request.query.sort, ['name', 'transaction_count', 'last_date', 'category'], 'last_date'),
        order: queryEnum<TransactionOrder>(request.query.order, ['asc', 'desc'], 'desc'),
        limit: queryInteger(request.query.limit, 50, 1, 100),
        offset: queryInteger(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      });
      noStore(response);
      response.json({ data: {
        payees: result.payees,
        pagination: { total: result.total, limit: result.limit, offset: result.offset }
      } });
    } catch (error) {
      sendPayeeError(response, error, 'Payees could not be loaded.');
    }
  });

  router.get('/payees/:payeeId/transactions', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const payeeId = positivePathId(request.params.payeeId);
    if (!payeeId) {
      noStore(response);
      response.status(404).json({ error: 'Payee not found.' });
      return;
    }
    try {
      const payee = getRecurringPayee(database, user.id, payeeId);
      if (!payee) {
        noStore(response);
        response.status(404).json({ error: 'Payee not found.' });
        return;
      }
      const result = listPayeeTransactions(database, {
        ownerId: user.id,
        payeeId,
        sort: queryEnum<TransactionSort>(request.query.sort, ['date', 'amount', 'merchant', 'account', 'category', 'status'], 'date'),
        order: queryEnum<TransactionOrder>(request.query.order, ['asc', 'desc'], 'desc'),
        limit: queryInteger(request.query.limit, 25, 1, 100),
        offset: queryInteger(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      });
      noStore(response);
      response.json({ data: {
        payee,
        transactions: result.transactions,
        pagination: { total: result.total, limit: result.limit, offset: result.offset }
      } });
    } catch (error) {
      sendPayeeError(response, error, 'Payee transactions could not be loaded.');
    }
  });

  router.patch('/payees/:payeeId/category', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    const payeeId = positivePathId(request.params.payeeId);
    const categoryId = request.body?.category_id;
    const confirmCandidate = request.body?.confirm_candidate;
    if (!payeeId || !Number.isSafeInteger(categoryId) || Number(categoryId) < 1
      || (confirmCandidate !== undefined && typeof confirmCandidate !== 'boolean')) {
      noStore(response);
      response.status(400).json({ error: 'category_id must be a positive integer and confirm_candidate a boolean.' });
      return;
    }
    try {
      const result = setPayeeCategory(database, {
        ownerId: user.id,
        payeeId,
        categoryId: Number(categoryId),
        confirmCandidate,
        now: clock()
      });
      noStore(response);
      response.json({ data: result });
    } catch (error) {
      sendPayeeError(response, error, 'Payee category could not be updated.');
    }
  });

  router.delete('/payees/:payeeId/category', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    const payeeId = positivePathId(request.params.payeeId);
    if (!payeeId) {
      noStore(response);
      response.status(404).json({ error: 'Payee not found.' });
      return;
    }
    try {
      const result = clearPayeeCategory(database, { ownerId: user.id, payeeId, now: clock() });
      noStore(response);
      response.json({ data: result });
    } catch (error) {
      sendPayeeError(response, error, 'Payee category could not be removed.');
    }
  });

  return router;
}

function positivePathId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function queryInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new PayeeValidationError('Payee pagination is invalid.');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new PayeeValidationError('Payee pagination is invalid.');
  }
  return result;
}

function queryEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new PayeeValidationError('Payee query value is invalid.');
  return value as T;
}

function queryBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new PayeeValidationError('Payee query value is invalid.');
}

function sendPayeeError(response: express.Response, error: unknown, fallback: string): void {
  noStore(response);
  const status = error instanceof PayeeNotFoundError ? 404
    : error instanceof PayeeCategoryConflictError ? 409
      : error instanceof PayeeValidationError ? 400 : 500;
  response.status(status).json({ error: status === 500 ? fallback : error instanceof Error ? error.message : fallback });
}
