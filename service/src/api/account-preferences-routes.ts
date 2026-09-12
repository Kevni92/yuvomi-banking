import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  mutationIsAllowed,
  noStore,
  resolveAuthorizedUser,
  type SessionResolver
} from './route-security.js';

export function createAccountPreferencesRouter({
  database,
  resolveSession,
  clock = () => new Date()
}: {
  database: DatabaseSync;
  resolveSession: SessionResolver;
  clock?: () => Date;
}): express.Router {
  const router = express.Router();

  router.get('/account-preferences', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const rows = database.prepare(`
      SELECT bank_accounts.id, bank_accounts.alias, bank_accounts.color_hex
      FROM bank_accounts
      JOIN enable_banking_connections
        ON enable_banking_connections.id = bank_accounts.connection_id
      WHERE enable_banking_connections.yuvomi_user_id = ?
      ORDER BY bank_accounts.id
    `).all(user.id) as Array<{ id: number; alias: string | null; color_hex: string | null }>;
    noStore(response);
    response.json({ data: rows.map((row) => ({
      id: Number(row.id),
      alias: row.alias ?? null,
      color: row.color_hex ?? null
    })) });
  });

  router.patch('/accounts/:accountId/preferences', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    const accountId = positivePathId(request.params.accountId);
    if (!accountId) {
      noStore(response);
      response.status(404).json({ error: 'Bank account not found.' });
      return;
    }

    try {
      const body = objectBody(request.body);
      const hasAlias = Object.hasOwn(body, 'alias');
      const hasColor = Object.hasOwn(body, 'color');
      if (!hasAlias && !hasColor) throw new PreferenceValidationError('At least one preference is required.');
      const existing = database.prepare(`
        SELECT bank_accounts.alias, bank_accounts.color_hex
        FROM bank_accounts
        JOIN enable_banking_connections
          ON enable_banking_connections.id = bank_accounts.connection_id
        WHERE bank_accounts.id = ? AND enable_banking_connections.yuvomi_user_id = ?
        LIMIT 1
      `).get(accountId, user.id) as { alias: string | null; color_hex: string | null } | undefined;
      if (!existing) {
        noStore(response);
        response.status(404).json({ error: 'Bank account not found.' });
        return;
      }

      const alias = hasAlias ? normalizeAlias(body.alias) : existing.alias;
      const color = hasColor ? normalizeColor(body.color) : existing.color_hex;
      const result = database.prepare(`
        UPDATE bank_accounts
        SET alias = ?, color_hex = ?, updated_at = ?
        WHERE id = ? AND connection_id IN (
          SELECT id FROM enable_banking_connections WHERE yuvomi_user_id = ?
        )
      `).run(alias, color, clock().toISOString(), accountId, user.id);
      if (Number(result.changes) !== 1) {
        noStore(response);
        response.status(404).json({ error: 'Bank account not found.' });
        return;
      }
      noStore(response);
      response.json({ data: { id: accountId, alias, color } });
    } catch (error) {
      noStore(response);
      response.status(error instanceof PreferenceValidationError ? 400 : 500).json({
        error: error instanceof PreferenceValidationError
          ? error.message
          : 'Account preferences could not be updated.'
      });
    }
  });

  return router;
}

class PreferenceValidationError extends Error {}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PreferenceValidationError('Account preferences must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function positivePathId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function normalizeAlias(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new PreferenceValidationError('Account alias is invalid.');
  const alias = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().replace(/\s+/g, ' ');
  if (!alias) return null;
  if (alias.length > 80) throw new PreferenceValidationError('Account alias must not exceed 80 characters.');
  return alias;
}

function normalizeColor(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new PreferenceValidationError('Account color must be a six-digit hex color.');
  }
  return value.toUpperCase();
}
