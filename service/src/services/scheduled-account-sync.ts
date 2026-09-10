import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import type { EnableBankingClient } from '../enable-banking/client.js';
import { persistAccountBalanceSnapshots } from '../enable-banking/balances.js';
import { importTransactions } from '../enable-banking/importer.js';
import { createEncryptionService } from '../security/encryption.js';
import {
  findWeeklyBudgetConfigById,
  type WeeklyBudgetConfigRow
} from './weekly-budget-overview.js';
import {
  addCalendarDays,
  instantForLocalDateTime,
  localDateForInstant
} from './weekly-budget-schedule.js';
import { matchWeeklyBudgetTransfers } from './weekly-budget-transfer-matcher.js';

const RETRY_DELAYS_MS = [5, 15, 30].map((minutes) => minutes * 60_000);

interface ScheduledSyncConfig {
  id: number;
  sync_time_1: string;
  sync_time_2: string;
  timezone: string;
  effective_from_at: string | null;
  created_at: string;
}

interface ExistingSyncRun {
  attempt: number;
  status: string;
  trigger: ScheduledSyncTrigger;
  finished_at: string | null;
  lease_expires_at: string | null;
}

interface SyncAccount {
  id: number;
  providerAccountId: string;
  currency: string;
}

interface ProviderAccountData {
  transactions: Array<Record<string, unknown>>;
  balances: Array<Record<string, unknown>>;
}

export type ScheduledSyncTrigger = 'scheduled' | 'catch_up';

export interface DailySyncSlot {
  localDate: string;
  slotTime: string;
  scheduledAt: string;
}

export interface ScheduledAccountSyncResult {
  runId: number;
  configId: number;
  scheduledAt: string;
  sourceImportedCount: number;
  targetImportedCount: number;
  idempotentReplay: boolean;
}

export interface DueScheduledSyncOutcome {
  configId: number;
  scheduledAt: string;
  state: 'succeeded' | 'failed' | 'skipped';
  reason?:
    | 'not_activated'
    | 'already_succeeded'
    | 'covered_by_cutoff'
    | 'running'
    | 'retry_wait'
    | 'retry_exhausted';
  result?: ScheduledAccountSyncResult;
}

export function latestDueDailySyncSlot({
  now,
  syncTimes,
  timezone
}: {
  now: Date;
  syncTimes: [string, string];
  timezone: string;
}): DailySyncSlot {
  if (Number.isNaN(now.getTime())) throw new Error('Scheduler time is invalid.');
  const localDate = localDateForInstant(now, timezone);
  const today = slotsForDate(localDate, syncTimes, timezone)
    .filter((slot) => Date.parse(slot.scheduledAt) <= now.getTime());
  const candidates = today.length > 0
    ? today
    : slotsForDate(addCalendarDays(localDate, -1), syncTimes, timezone);
  candidates.sort((left, right) => Date.parse(right.scheduledAt) - Date.parse(left.scheduledAt));
  const result = candidates[0];
  if (!result) throw new Error('Daily account-sync schedule has no slots.');
  return result;
}

export async function runDueScheduledAccountSyncJobs({
  database,
  client,
  now = new Date()
}: {
  database: DatabaseSync;
  client: EnableBankingClient;
  now?: Date;
}): Promise<DueScheduledSyncOutcome[]> {
  if (Number.isNaN(now.getTime())) throw new Error('Scheduler time is invalid.');
  const configs = database.prepare(`
    SELECT id, sync_time_1, sync_time_2, timezone,
           effective_from_at, created_at
    FROM weekly_budget_configs
    WHERE enabled = 1
    ORDER BY id
  `).all() as unknown as ScheduledSyncConfig[];
  const outcomes: DueScheduledSyncOutcome[] = [];

  for (const syncConfig of configs) {
    const slot = latestDueDailySyncSlot({
      now,
      syncTimes: [syncConfig.sync_time_1, syncConfig.sync_time_2],
      timezone: syncConfig.timezone
    });
    const activationTime = Date.parse(syncConfig.effective_from_at ?? syncConfig.created_at);
    if (!Number.isFinite(activationTime) || Date.parse(slot.scheduledAt) <= activationTime) {
      outcomes.push({
        configId: Number(syncConfig.id),
        scheduledAt: slot.scheduledAt,
        state: 'skipped',
        reason: 'not_activated'
      });
      continue;
    }

    const runKey = `account-sync:${syncConfig.id}:${slot.scheduledAt}`;
    const existing = database.prepare(`
      SELECT attempt, status, trigger, finished_at, lease_expires_at
      FROM scheduled_account_sync_runs
      WHERE run_key = ?
    `).get(runKey) as ExistingSyncRun | undefined;
    const skipReason = existingSyncSkipReason(existing, now);
    if (skipReason) {
      outcomes.push({
        configId: Number(syncConfig.id),
        scheduledAt: slot.scheduledAt,
        state: 'skipped',
        reason: skipReason
      });
      continue;
    }

    if (!existing && cutoffAlreadyCoveredSlot(database, Number(syncConfig.id), slot.scheduledAt)) {
      recordCutoffCoveredSync(database, Number(syncConfig.id), runKey, slot, now);
      outcomes.push({
        configId: Number(syncConfig.id),
        scheduledAt: slot.scheduledAt,
        state: 'skipped',
        reason: 'covered_by_cutoff'
      });
      continue;
    }

    const ageMs = now.getTime() - Date.parse(slot.scheduledAt);
    const trigger: ScheduledSyncTrigger = existing?.trigger
      ?? (ageMs <= 2 * 60_000 ? 'scheduled' : 'catch_up');
    try {
      const result = await runScheduledAccountSync({
        database,
        client,
        configId: Number(syncConfig.id),
        slot,
        trigger,
        clock: () => now
      });
      outcomes.push({
        configId: Number(syncConfig.id),
        scheduledAt: slot.scheduledAt,
        state: 'succeeded',
        result
      });
    } catch {
      outcomes.push({
        configId: Number(syncConfig.id),
        scheduledAt: slot.scheduledAt,
        state: 'failed'
      });
    }
  }
  return outcomes;
}

export async function runScheduledAccountSync({
  database,
  client,
  configId,
  slot,
  trigger,
  clock = () => new Date()
}: {
  database: DatabaseSync;
  client: EnableBankingClient;
  configId: number;
  slot: DailySyncSlot;
  trigger: ScheduledSyncTrigger;
  clock?: () => Date;
}): Promise<ScheduledAccountSyncResult> {
  const budgetConfig = findWeeklyBudgetConfigById(database, configId);
  if (!budgetConfig?.enabled) throw new Error('Active weekly-budget configuration was not found.');
  const startedAt = clock();
  const runKey = `account-sync:${configId}:${slot.scheduledAt}`;
  const claimed = claimSyncRun(database, {
    configId,
    runKey,
    slot,
    trigger,
    now: startedAt
  });
  if (claimed.completedResult) return claimed.completedResult;

  const accounts = loadSyncAccounts(database, budgetConfig);
  const source = accounts.get(Number(budgetConfig.source_account_id));
  const target = accounts.get(Number(budgetConfig.target_account_id));
  if (!source || !target) {
    markSyncFailed(database, claimed.runId, clock(), 'account_unavailable', 'failed', 'failed');
    throw new Error('Configured weekly-budget accounts are unavailable.');
  }

  const dateFrom = addCalendarDays(slot.localDate, -14);
  const providerResults = await Promise.allSettled([
    fetchAccountData(client, source, dateFrom),
    fetchAccountData(client, target, dateFrom)
  ]);
  const sourceStatus = providerResults[0].status === 'fulfilled' ? 'succeeded' : 'failed';
  const targetStatus = providerResults[1].status === 'fulfilled' ? 'succeeded' : 'failed';
  if (providerResults[0].status !== 'fulfilled' || providerResults[1].status !== 'fulfilled') {
    markSyncFailed(database, claimed.runId, clock(), 'provider_sync_failed', sourceStatus, targetStatus);
    throw new Error('Scheduled account synchronization failed.');
  }

  const syncedAt = clock();
  const encryption = createEncryptionService();
  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;
    const sourceImport = importTransactions({
      database,
      accountId: source.id,
      transactions: providerResults[0].value.transactions,
      hmacSecret: config.secrets.counterpartyHmac,
      encryption,
      manageTransaction: false
    });
    const targetImport = importTransactions({
      database,
      accountId: target.id,
      transactions: providerResults[1].value.transactions,
      hmacSecret: config.secrets.counterpartyHmac,
      encryption,
      manageTransaction: false
    });
    matchWeeklyBudgetTransfers(database, configId, syncedAt);
    persistAccountBalanceSnapshots({
      database,
      accountId: source.id,
      balances: providerResults[0].value.balances,
      expectedCurrency: source.currency,
      fetchedAt: syncedAt,
      syncRunKey: `${runKey}:source`,
      manageTransaction: false
    });
    const targetBalances = persistAccountBalanceSnapshots({
      database,
      accountId: target.id,
      balances: providerResults[1].value.balances,
      expectedCurrency: target.currency,
      fetchedAt: syncedAt,
      syncRunKey: `${runKey}:target`,
      manageTransaction: false
    });
    if (!targetBalances.usableBalance) {
      throw new Error('Target account returned no usable EUR balance.');
    }

    database.prepare(`
      UPDATE bank_accounts SET last_synced_at = ?, updated_at = ? WHERE id IN (?, ?)
    `).run(syncedAt.toISOString(), syncedAt.toISOString(), source.id, target.id);
    const sourceImportedCount = sourceImport.inserted + sourceImport.updated;
    const targetImportedCount = targetImport.inserted + targetImport.updated;
    database.prepare(`
      UPDATE scheduled_account_sync_runs SET
        status = 'succeeded', finished_at = ?, lease_owner = NULL,
        lease_expires_at = NULL, source_sync_status = 'succeeded',
        target_sync_status = 'succeeded', source_imported_count = ?,
        target_imported_count = ?, error_code = NULL, error_message = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(
      syncedAt.toISOString(),
      sourceImportedCount,
      targetImportedCount,
      syncedAt.toISOString(),
      claimed.runId
    );
    database.exec('COMMIT;');
    transactionOpen = false;
    return {
      runId: claimed.runId,
      configId,
      scheduledAt: slot.scheduledAt,
      sourceImportedCount,
      targetImportedCount,
      idempotentReplay: false
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // Preserve the processing failure.
      }
    }
    markSyncFailed(database, claimed.runId, clock(), 'processing_failed', 'failed', 'failed');
    throw new Error('Scheduled account synchronization could not be persisted.', { cause: error });
  }
}

function slotsForDate(
  localDate: string,
  syncTimes: [string, string],
  timezone: string
): DailySyncSlot[] {
  return syncTimes.map((slotTime) => ({
    localDate,
    slotTime,
    scheduledAt: instantForLocalDateTime(localDate, slotTime, timezone)
  }));
}

function loadSyncAccounts(
  database: DatabaseSync,
  budgetConfig: WeeklyBudgetConfigRow
): Map<number, SyncAccount> {
  const rows = database.prepare(`
    SELECT bank_accounts.id, bank_accounts.provider_account_id,
           bank_accounts.currency, enable_banking_connections.yuvomi_user_id,
           enable_banking_connections.status AS connection_status
    FROM bank_accounts
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    WHERE bank_accounts.id IN (?, ?)
  `).all(
    budgetConfig.source_account_id,
    budgetConfig.target_account_id
  ) as Array<Record<string, unknown>>;
  const accounts = new Map<number, SyncAccount>();
  for (const row of rows) {
    if (
      Number(row.yuvomi_user_id) !== Number(budgetConfig.yuvomi_user_id)
      || row.connection_status !== 'authorized'
      || row.currency !== 'EUR'
    ) continue;
    accounts.set(Number(row.id), {
      id: Number(row.id),
      providerAccountId: String(row.provider_account_id),
      currency: String(row.currency)
    });
  }
  return accounts;
}

async function fetchAccountData(
  client: EnableBankingClient,
  account: SyncAccount,
  dateFrom: string
): Promise<ProviderAccountData> {
  const [transactions, balances] = await Promise.all([
    client.getAllAccountTransactions(account.providerAccountId, { dateFrom }),
    client.getAccountBalances(account.providerAccountId)
  ]);
  return { transactions: transactions.transactions, balances: balances.balances };
}

function claimSyncRun(
  database: DatabaseSync,
  input: {
    configId: number;
    runKey: string;
    slot: DailySyncSlot;
    trigger: ScheduledSyncTrigger;
    now: Date;
  }
): { runId: number; completedResult: ScheduledAccountSyncResult | null } {
  const nowIso = input.now.toISOString();
  const leaseOwner = crypto.randomUUID();
  const leaseExpiresAt = new Date(input.now.getTime() + 10 * 60_000).toISOString();
  const inserted = database.prepare(`
    INSERT OR IGNORE INTO scheduled_account_sync_runs (
      config_id, run_key, slot_time, trigger, attempt, status,
      scheduled_for, started_at, lease_owner, lease_expires_at,
      source_sync_status, target_sync_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 'running', ?, ?, ?, ?, 'pending', 'pending', ?, ?)
  `).run(
    input.configId,
    input.runKey,
    input.slot.slotTime,
    input.trigger,
    input.slot.scheduledAt,
    nowIso,
    leaseOwner,
    leaseExpiresAt,
    nowIso,
    nowIso
  );
  const existing = database.prepare(`
    SELECT id, status, lease_expires_at, source_imported_count,
           target_imported_count, scheduled_for
    FROM scheduled_account_sync_runs WHERE run_key = ?
  `).get(input.runKey) as Record<string, unknown> | undefined;
  if (!existing) throw new Error('Scheduled account-sync run could not be created.');
  if (Number(inserted.changes) === 1) {
    return { runId: Number(existing.id), completedResult: null };
  }
  if (existing.status === 'succeeded') {
    return {
      runId: Number(existing.id),
      completedResult: {
        runId: Number(existing.id),
        configId: input.configId,
        scheduledAt: String(existing.scheduled_for),
        sourceImportedCount: Number(existing.source_imported_count),
        targetImportedCount: Number(existing.target_imported_count),
        idempotentReplay: true
      }
    };
  }
  const leaseExpiry = typeof existing.lease_expires_at === 'string'
    ? Date.parse(existing.lease_expires_at)
    : Number.NaN;
  if (existing.status === 'running' && Number.isFinite(leaseExpiry) && leaseExpiry > input.now.getTime()) {
    throw new Error('Scheduled account synchronization is already running.');
  }
  const reclaimed = database.prepare(`
    UPDATE scheduled_account_sync_runs SET
      trigger = ?, attempt = attempt + 1, status = 'running',
      started_at = ?, finished_at = NULL, lease_owner = ?, lease_expires_at = ?,
      source_sync_status = 'pending', target_sync_status = 'pending',
      error_code = NULL, error_message = NULL, updated_at = ?
    WHERE id = ?
      AND status NOT IN ('succeeded', 'skipped')
      AND (status = 'failed' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).run(
    input.trigger,
    nowIso,
    leaseOwner,
    leaseExpiresAt,
    nowIso,
    Number(existing.id),
    nowIso
  );
  if (Number(reclaimed.changes) !== 1) {
    throw new Error('Scheduled account synchronization could not be claimed.');
  }
  return { runId: Number(existing.id), completedResult: null };
}

function existingSyncSkipReason(
  existing: ExistingSyncRun | undefined,
  now: Date
): DueScheduledSyncOutcome['reason'] | null {
  if (!existing) return null;
  if (existing.status === 'succeeded') return 'already_succeeded';
  if (existing.status === 'skipped') return 'covered_by_cutoff';
  if (existing.status === 'running') {
    const leaseExpiry = existing.lease_expires_at
      ? Date.parse(existing.lease_expires_at)
      : Number.NaN;
    return Number.isFinite(leaseExpiry) && leaseExpiry > now.getTime() ? 'running' : null;
  }
  if (existing.status !== 'failed') return 'running';
  if (existing.attempt >= RETRY_DELAYS_MS.length + 1) return 'retry_exhausted';
  const finishedAt = existing.finished_at ? Date.parse(existing.finished_at) : Number.NaN;
  if (!Number.isFinite(finishedAt)) return 'retry_wait';
  const delay = RETRY_DELAYS_MS[existing.attempt - 1];
  return now.getTime() >= finishedAt + delay ? null : 'retry_wait';
}

function cutoffAlreadyCoveredSlot(
  database: DatabaseSync,
  configId: number,
  scheduledAt: string
): boolean {
  return Boolean(database.prepare(`
    SELECT 1
    FROM weekly_budget_job_runs
    WHERE config_id = ? AND status = 'succeeded' AND finished_at >= ?
    LIMIT 1
  `).get(configId, scheduledAt));
}

function recordCutoffCoveredSync(
  database: DatabaseSync,
  configId: number,
  runKey: string,
  slot: DailySyncSlot,
  now: Date
): void {
  const nowIso = now.toISOString();
  database.prepare(`
    INSERT OR IGNORE INTO scheduled_account_sync_runs (
      config_id, run_key, slot_time, trigger, attempt, status,
      scheduled_for, started_at, finished_at, source_sync_status,
      target_sync_status, created_at, updated_at
    ) VALUES (?, ?, ?, 'catch_up', 1, 'skipped', ?, ?, ?, 'skipped', 'skipped', ?, ?)
  `).run(configId, runKey, slot.slotTime, slot.scheduledAt, nowIso, nowIso, nowIso, nowIso);
}

function markSyncFailed(
  database: DatabaseSync,
  runId: number,
  finishedAt: Date,
  errorCode: string,
  sourceStatus: 'succeeded' | 'failed',
  targetStatus: 'succeeded' | 'failed'
): void {
  const timestamp = Number.isNaN(finishedAt.getTime())
    ? new Date().toISOString()
    : finishedAt.toISOString();
  try {
    database.prepare(`
      UPDATE scheduled_account_sync_runs SET
        status = 'failed', finished_at = ?, lease_owner = NULL,
        lease_expires_at = NULL, source_sync_status = ?, target_sync_status = ?,
        error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ? AND status <> 'succeeded'
    `).run(
      timestamp,
      sourceStatus,
      targetStatus,
      errorCode,
      'Scheduled account synchronization failed. See server diagnostics.',
      timestamp,
      runId
    );
  } catch {
    // Never replace the original provider or persistence error.
  }
}
