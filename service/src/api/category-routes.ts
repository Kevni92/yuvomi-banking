import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  CategoryConflictError,
  CategoryNotFoundError,
  CategoryValidationError,
  createCategory,
  listCategories,
  updateCategory,
  type BankingCategory
} from '../services/categories.js';
import { mutationIsAllowed, noStore, resolveAuthorizedUser, type SessionResolver } from './route-security.js';

export function createCategoryRouter({
  database, resolveSession, clock = () => new Date()
}: { database: DatabaseSync; resolveSession: SessionResolver; clock?: () => Date }): express.Router {
  const router = express.Router();

  router.get('/categories', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    noStore(response);
    response.json({ data: listCategories(database).map(serializeCategory) });
  });

  router.post('/categories', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      const body = objectBody(request.body);
      const category = createCategory(database, {
        name: body.name, type: body.type, weeklyBudgetDefault: body.weekly_budget_default, now: clock()
      });
      noStore(response);
      response.status(201).json({ data: serializeCategory(category) });
    } catch (error) { sendError(response, error); }
  });

  router.patch('/categories/:categoryId', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      const body = objectBody(request.body);
      if (Object.hasOwn(body, 'type')) throw new CategoryValidationError('Category type cannot be changed.');
      const category = updateCategory(database, categoryId(request.params.categoryId), {
        ...(Object.hasOwn(body, 'name') ? { name: body.name } : {}),
        ...(Object.hasOwn(body, 'active') ? { active: body.active } : {}),
        ...(Object.hasOwn(body, 'weekly_budget_default') ? { weeklyBudgetDefault: body.weekly_budget_default } : {}),
        now: clock()
      });
      noStore(response);
      response.json({ data: serializeCategory(category) });
    } catch (error) { sendError(response, error); }
  });

  router.patch('/categories/:categoryId/weekly-budget', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      const body = objectBody(request.body);
      if (!Object.hasOwn(body, 'weekly_budget_default')) {
        throw new CategoryValidationError('A boolean weekly_budget_default is required.');
      }
      const category = updateCategory(database, categoryId(request.params.categoryId), {
        weeklyBudgetDefault: body.weekly_budget_default, now: clock()
      });
      noStore(response);
      response.json({ data: { id: category.id, weekly_budget_default: category.weeklyBudgetDefault } });
    } catch (error) { sendError(response, error); }
  });
  return router;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CategoryValidationError('Category body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function categoryId(value: string): number {
  if (!/^\d+$/.test(value)) throw new CategoryNotFoundError('Category not found.');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new CategoryNotFoundError('Category not found.');
  return id;
}

function serializeCategory(category: BankingCategory): Record<string, unknown> {
  return {
    id: category.id, name: category.name, type: category.type, active: category.active,
    weekly_budget_default: category.weeklyBudgetDefault
  };
}

function sendError(response: express.Response, error: unknown): void {
  noStore(response);
  const status = error instanceof CategoryNotFoundError ? 404
    : error instanceof CategoryConflictError ? 409
      : error instanceof CategoryValidationError ? 400 : 500;
  response.status(status).json({ error: status === 500
    ? 'Category could not be updated.'
    : error instanceof Error ? error.message : 'Category request is invalid.' });
}
