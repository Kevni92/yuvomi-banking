import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { weeklyBudgetCutoffSchedule } from './weekly-budget-schedule.js';

const TOKEN_BYTES = 32;

export function createGiroCodeImageCapability(
  database: DatabaseSync,
  input: {
    suggestionId: number;
    cutoffWeekday: number;
    cutoffTime: string;
    timezone: string;
    now: Date;
  }
): { imagePath: string; expiresAt: string } {
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new Error('GiroCode image token time is invalid.');
  }
  const nextCutoff = new Date(weeklyBudgetCutoffSchedule({
    now: input.now,
    cutoffWeekday: input.cutoffWeekday,
    cutoffTime: input.cutoffTime,
    timezone: input.timezone
  }).nextCutoffAt);
  const expiresAt = new Date(Math.min(
    nextCutoff.getTime(),
    input.now.getTime() + 7 * 24 * 60 * 60 * 1_000
  ));
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  database.prepare(`
    INSERT INTO girocode_image_tokens (suggestion_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(input.suggestionId, tokenHash(token), expiresAt.toISOString(), input.now.toISOString());
  return {
    imagePath: `/api/extensions/banking/push/girocode-images/${token}`,
    expiresAt: expiresAt.toISOString()
  };
}

export function findGiroCodeImageToken(
  database: DatabaseSync,
  token: string,
  now = new Date()
): { suggestionId: number } | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Number.isNaN(now.getTime())) return null;
  const row = database.prepare(`
    SELECT suggestion_id FROM girocode_image_tokens
    WHERE token_hash = ? AND expires_at > ?
    LIMIT 1
  `).get(tokenHash(token), now.toISOString()) as { suggestion_id: number } | undefined;
  return row ? { suggestionId: Number(row.suggestion_id) } : null;
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}
