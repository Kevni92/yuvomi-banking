import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  mutationIsAllowed,
  noStore,
  resolveAuthorizedUser,
  type SessionResolver
} from './route-security.js';

const DEFAULTS = ['06:00', '18:00', '12:00', '23:30'] as const;

interface SyncTimeRow {
  sync_time_1: string;
  sync_time_2: string;
  sync_time_3: string;
  sync_time_4: string;
}

export function createWeeklyBudgetSyncTimesRouter({
  database,
  resolveSession,
  clock = () => new Date()
}: {
  database: DatabaseSync;
  resolveSession: SessionResolver;
  clock?: () => Date;
}): express.Router {
  const router = express.Router();

  router.get('/weekly-budget/sync-times', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const row = loadSyncTimes(database, user.id);
    noStore(response);
    response.json({ data: row ?? defaultPayload() });
  });

  router.put('/weekly-budget/sync-times', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      const times = parseSyncTimes(request.body);
      const result = database.prepare(`
        UPDATE weekly_budget_configs SET
          sync_time_1 = ?, sync_time_2 = ?, sync_time_3 = ?, sync_time_4 = ?, updated_at = ?
        WHERE yuvomi_user_id = ?
      `).run(...times, clock().toISOString(), user.id);
      if (Number(result.changes) !== 1) {
        noStore(response);
        response.status(404).json({ error: 'Weekly-budget settings are not configured.' });
        return;
      }
      noStore(response);
      response.json({ data: loadSyncTimes(database, user.id) });
    } catch (error) {
      noStore(response);
      response.status(400).json({
        error: error instanceof Error ? error.message : 'Daily sync times are invalid.'
      });
    }
  });

  return router;
}

function loadSyncTimes(database: DatabaseSync, userId: number): SyncTimeRow | null {
  return (database.prepare(`
    SELECT sync_time_1, sync_time_2, sync_time_3, sync_time_4
    FROM weekly_budget_configs
    WHERE yuvomi_user_id = ?
    ORDER BY enabled DESC, id DESC
    LIMIT 1
  `).get(userId) as SyncTimeRow | undefined) ?? null;
}

function parseSyncTimes(body: unknown): [string, string, string, string] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Daily sync times must be a JSON object.');
  }
  const value = body as Record<string, unknown>;
  const times = [
    timeValue(value.sync_time_1, 'sync_time_1'),
    timeValue(value.sync_time_2, 'sync_time_2'),
    timeValue(value.sync_time_3, 'sync_time_3'),
    timeValue(value.sync_time_4, 'sync_time_4')
  ] as [string, string, string, string];
  if (new Set(times).size !== 4) {
    throw new Error('The four daily sync times must differ.');
  }
  return times;
}

function timeValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${name} must use HH:mm.`);
  }
  return value;
}

function defaultPayload(): SyncTimeRow {
  return {
    sync_time_1: DEFAULTS[0],
    sync_time_2: DEFAULTS[1],
    sync_time_3: DEFAULTS[2],
    sync_time_4: DEFAULTS[3]
  };
}
