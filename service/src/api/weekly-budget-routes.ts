import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { createEncryptionService } from '../security/encryption.js';
import { normalizeIban } from '../services/counterparty.js';
import {
  buildCurrentWeeklyBudgetOverview,
  findWeeklyBudgetConfig,
  serializeWeeklyBudgetSettings
} from '../services/weekly-budget-overview.js';
import {
  assertTimeZone,
  localDateForInstant,
  weeklyBudgetWindow
} from '../services/weekly-budget-schedule.js';
import {
  mutationIsAllowed,
  noStore,
  resolveAuthorizedUser,
  type SessionResolver
} from './route-security.js';

export function createWeeklyBudgetRouter({
  database,
  resolveSession,
  clock = () => new Date()
}: {
  database: DatabaseSync;
  resolveSession: SessionResolver;
  clock?: () => Date;
}): express.Router {
  const router = express.Router();

  router.get('/weekly-budget/settings', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    const settings = findWeeklyBudgetConfig(database, user.id);
    noStore(response);
    response.json({ data: settings ? serializeWeeklyBudgetSettings(settings) : null });
  });

  router.put('/weekly-budget/settings', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;

    try {
      const input = parseSettingsInput(request.body);
      const accounts = ownedAccounts(database, user.id, [
        input.sourceAccountId,
        input.targetAccountId
      ]);
      if (accounts.length !== 2) {
        response.status(400).json({ error: 'Source and target accounts must belong to the current user.' });
        return;
      }
      if (accounts.some((account) =>
        account.currency !== 'EUR' || account.connection_status !== 'authorized'
      )) {
        response.status(400).json({ error: 'Weekly-budget accounts must be authorized EUR accounts.' });
        return;
      }
      const targetAccount = accounts.find((account) => account.id === input.targetAccountId);
      if (!targetAccount?.display_name || !targetAccount.iban_encrypted) {
        response.status(400).json({ error: 'Target account requires a recipient name and IBAN.' });
        return;
      }
      try {
        const iban = normalizeIban(createEncryptionService().decrypt(targetAccount.iban_encrypted));
        if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) {
          throw new Error('Invalid IBAN.');
        }
      } catch {
        response.status(400).json({ error: 'Target-account IBAN cannot be decrypted.' });
        return;
      }

      const now = clock();
      const existing = findWeeklyBudgetConfig(database, user.id);
      const effectiveFromDate = !existing || (!existing.enabled && input.enabled)
        ? localDateForInstant(now, input.timezone)
        : existing.effective_from_date;
      const nowIso = now.toISOString();
      if (existing) {
        database.prepare(`
          UPDATE weekly_budget_configs SET
            enabled = ?, source_account_id = ?, target_account_id = ?,
            target_amount_cents = ?, currency = 'EUR', cutoff_weekday = ?,
            cutoff_time = ?, timezone = ?, sync_time_1 = ?, sync_time_2 = ?,
            balance_stale_after_minutes = ?, notification_enabled = ?,
            notification_user_id = ?, notification_qr_preview = ?,
            purpose_prefix = ?, updated_at = ?
          WHERE id = ? AND yuvomi_user_id = ?
        `).run(
          input.enabled ? 1 : 0,
          input.sourceAccountId,
          input.targetAccountId,
          input.targetAmountCents,
          input.cutoffWeekday,
          input.cutoffTime,
          input.timezone,
          input.syncTime1,
          input.syncTime2,
          input.balanceStaleAfterMinutes,
          input.notificationEnabled ? 1 : 0,
          input.notificationUserId,
          input.notificationQrPreview ? 1 : 0,
          input.purposePrefix,
          nowIso,
          existing.id,
          user.id
        );
      } else {
        database.prepare(`
          INSERT INTO weekly_budget_configs (
            yuvomi_user_id, enabled, source_account_id, target_account_id,
            target_amount_cents, currency, cutoff_weekday, cutoff_time,
            timezone, sync_time_1, sync_time_2, balance_stale_after_minutes,
            notification_enabled, notification_user_id,
            notification_qr_preview, purpose_prefix, effective_from_date,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          user.id,
          input.enabled ? 1 : 0,
          input.sourceAccountId,
          input.targetAccountId,
          input.targetAmountCents,
          input.cutoffWeekday,
          input.cutoffTime,
          input.timezone,
          input.syncTime1,
          input.syncTime2,
          input.balanceStaleAfterMinutes,
          input.notificationEnabled ? 1 : 0,
          input.notificationUserId,
          input.notificationQrPreview ? 1 : 0,
          input.purposePrefix,
          effectiveFromDate,
          nowIso,
          nowIso
        );
      }

      const saved = findWeeklyBudgetConfig(database, user.id);
      if (!saved) throw new Error('Saved weekly-budget settings could not be read.');
      noStore(response);
      response.json({ data: serializeWeeklyBudgetSettings(saved) });
    } catch (error) {
      noStore(response);
      response.status(400).json({
        error: error instanceof SettingsValidationError
          ? error.message
          : 'Weekly-budget settings are invalid.'
      });
    }
  });

  router.get('/weekly-budget/current', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    try {
      const overview = buildCurrentWeeklyBudgetOverview(database, user.id, clock());
      noStore(response);
      response.json({ data: overview });
    } catch {
      noStore(response);
      response.status(500).json({ error: 'Current weekly budget could not be calculated.' });
    }
  });

  router.patch('/categories/:categoryId/weekly-budget', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    const categoryId = positivePathId(request.params.categoryId);
    if (!categoryId || typeof request.body?.weekly_budget_default !== 'boolean') {
      response.status(400).json({ error: 'A boolean weekly_budget_default is required.' });
      return;
    }
    const result = database.prepare(`
      UPDATE categories SET weekly_budget_default = ?, updated_at = ? WHERE id = ?
    `).run(request.body.weekly_budget_default ? 1 : 0, clock().toISOString(), categoryId);
    if (Number(result.changes) !== 1) {
      response.status(404).json({ error: 'Category not found.' });
      return;
    }
    noStore(response);
    response.json({ data: { id: categoryId, weekly_budget_default: request.body.weekly_budget_default } });
  });

  router.patch('/transactions/:transactionId/weekly-budget', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    const transactionId = positivePathId(request.params.transactionId);
    const override = request.body?.weekly_budget_override;
    if (!transactionId || !['inherit', 'include', 'exclude'].includes(override)) {
      response.status(400).json({
        error: 'weekly_budget_override must be inherit, include, or exclude.'
      });
      return;
    }
    const result = database.prepare(`
      UPDATE transactions SET weekly_budget_override = ?, updated_at = ?
      WHERE id = ? AND account_id IN (
        SELECT bank_accounts.id
        FROM bank_accounts
        JOIN enable_banking_connections
          ON enable_banking_connections.id = bank_accounts.connection_id
        WHERE enable_banking_connections.yuvomi_user_id = ?
      )
    `).run(override, clock().toISOString(), transactionId, user.id);
    if (Number(result.changes) !== 1) {
      response.status(404).json({ error: 'Transaction not found.' });
      return;
    }
    noStore(response);
    response.json({ data: { id: transactionId, weekly_budget_override: override } });
  });

  return router;
}

interface SettingsInput {
  enabled: boolean;
  sourceAccountId: number;
  targetAccountId: number;
  targetAmountCents: number;
  cutoffWeekday: number;
  cutoffTime: string;
  timezone: string;
  syncTime1: string;
  syncTime2: string;
  balanceStaleAfterMinutes: number;
  notificationEnabled: boolean;
  notificationUserId: number | null;
  notificationQrPreview: boolean;
  purposePrefix: string;
}

function parseSettingsInput(body: unknown): SettingsInput {
  try {
    return parseSettingsInputValue(body);
  } catch (error) {
    throw new SettingsValidationError(
      error instanceof Error ? error.message : 'Weekly-budget settings are invalid.'
    );
  }
}

function parseSettingsInputValue(body: unknown): SettingsInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Weekly-budget settings must be a JSON object.');
  }
  const value = body as Record<string, unknown>;
  const enabled = requiredBoolean(value.enabled, 'enabled');
  const sourceAccountId = requiredPositiveInteger(value.source_account_id, 'source_account_id');
  const targetAccountId = requiredPositiveInteger(value.target_account_id, 'target_account_id');
  if (sourceAccountId === targetAccountId) {
    throw new Error('Source and target accounts must differ.');
  }
  const targetAmountCents = requiredPositiveInteger(
    value.target_amount_cents,
    'target_amount_cents'
  );
  const cutoffWeekday = requiredPositiveInteger(value.cutoff_weekday, 'cutoff_weekday');
  const cutoffTime = timeValue(value.cutoff_time, 'cutoff_time');
  const timezone = stringValue(value.timezone ?? 'Europe/Berlin', 'timezone', 100);
  assertTimeZone(timezone);
  // Reuse the production schedule parser for weekday and local-time validation.
  weeklyBudgetWindow({
    now: new Date('2026-01-01T00:00:00.000Z'),
    cutoffWeekday,
    cutoffTime,
    timezone
  });
  const syncTime1 = timeValue(value.sync_time_1 ?? '06:00', 'sync_time_1');
  const syncTime2 = timeValue(value.sync_time_2 ?? '18:00', 'sync_time_2');
  if (syncTime1 === syncTime2) throw new Error('The two daily sync times must differ.');
  const balanceStaleAfterMinutes = value.balance_stale_after_minutes == null
    ? 840
    : requiredPositiveInteger(value.balance_stale_after_minutes, 'balance_stale_after_minutes');
  const notificationEnabled = value.notification_enabled == null
    ? false
    : requiredBoolean(value.notification_enabled, 'notification_enabled');
  const notificationUserId = value.notification_user_id == null
    ? null
    : requiredPositiveInteger(value.notification_user_id, 'notification_user_id');
  if (notificationEnabled && notificationUserId === null) {
    throw new Error('notification_user_id is required when notifications are enabled.');
  }
  const notificationQrPreview = value.notification_qr_preview == null
    ? false
    : requiredBoolean(value.notification_qr_preview, 'notification_qr_preview');
  const purposePrefix = stringValue(value.purpose_prefix ?? 'WB', 'purpose_prefix', 10);
  if (!/^[A-Za-z0-9]{1,10}$/.test(purposePrefix)) {
    throw new Error('purpose_prefix must contain only ASCII letters or digits.');
  }
  return {
    enabled,
    sourceAccountId,
    targetAccountId,
    targetAmountCents,
    cutoffWeekday,
    cutoffTime,
    timezone,
    syncTime1,
    syncTime2,
    balanceStaleAfterMinutes,
    notificationEnabled,
    notificationUserId,
    notificationQrPreview,
    purposePrefix
  };
}

class SettingsValidationError extends Error {}

function ownedAccounts(
  database: DatabaseSync,
  userId: number,
  accountIds: number[]
): Array<{
  id: number;
  display_name: string | null;
  iban_encrypted: string | null;
  currency: string | null;
  connection_status: string;
}> {
  return database.prepare(`
    SELECT bank_accounts.id, bank_accounts.display_name,
           bank_accounts.iban_encrypted, bank_accounts.currency,
           enable_banking_connections.status AS connection_status
    FROM bank_accounts
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    WHERE enable_banking_connections.yuvomi_user_id = ?
      AND bank_accounts.id IN (?, ?)
  `).all(userId, accountIds[0], accountIds[1]) as Array<{
    id: number;
    display_name: string | null;
    iban_encrypted: string | null;
    currency: string | null;
    connection_status: string;
  }>;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

function timeValue(value: unknown, name: string): string {
  const result = stringValue(value, name, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) {
    throw new Error(`${name} must use HH:mm.`);
  }
  return result;
}

function stringValue(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

function positivePathId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}
