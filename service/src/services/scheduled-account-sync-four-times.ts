import type { DatabaseSync } from 'node:sqlite';
import type { EnableBankingClient } from '../enable-banking/client.js';
import {
  runScheduledAccountSync,
  type DailySyncSlot,
  type DueScheduledSyncOutcome,
  type ScheduledSyncTrigger
} from './scheduled-account-sync.js';
import {
  addCalendarDays,
  instantForLocalDateTime,
  localDateForInstant
} from './weekly-budget-schedule.js';

export type { DueScheduledSyncOutcome } from './scheduled-account-sync.js';

const RETRY_DELAYS_MS = [5, 15, 30].map((minutes) => minutes * 60_000);

interface ScheduledSyncConfig {
  id: number;
  sync_time_1: string;
  sync_time_2: string;
  sync_time_3: string;
  sync_time_4: string;
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

export function latestDueDailySyncSlotFourTimes({
  now,
  syncTimes,
  timezone
}: {
  now: Date;
  syncTimes: readonly string[];
  timezone: string;
}): DailySyncSlot {
  if (Number.isNaN(now.getTime())) throw new Error('Scheduler time is invalid.');
  const uniqueTimes = [...new Set(syncTimes)].filter(Boolean);
  if (!uniqueTimes.length) throw new Error('Daily account-sync schedule has no slots.');
  const localDate = localDateForInstant(now, timezone);
  const today = slotsForDate(localDate, uniqueTimes, timezone)
    .filter((slot) => Date.parse(slot.scheduledAt) <= now.getTime());
  const candidates = today.length > 0
    ? today
    : slotsForDate(addCalendarDays(localDate, -1), uniqueTimes, timezone);
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
    SELECT id, sync_time_1, sync_time_2, sync_time_3, sync_time_4, timezone,
           effective_from_at, created_at
    FROM weekly_budget_configs
    WHERE enabled = 1
    ORDER BY id
  `).all() as unknown as ScheduledSyncConfig[];
  const outcomes: DueScheduledSyncOutcome[] = [];

  for (const syncConfig of configs) {
    const slot = latestDueDailySyncSlotFourTimes({
      now,
      syncTimes: [
        syncConfig.sync_time_1,
        syncConfig.sync_time_2,
        syncConfig.sync_time_3,
        syncConfig.sync_time_4
      ],
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

function slotsForDate(
  localDate: string,
  syncTimes: readonly string[],
  timezone: string
): DailySyncSlot[] {
  return syncTimes.map((slotTime) => ({
    localDate,
    slotTime,
    scheduledAt: instantForLocalDateTime(localDate, slotTime, timezone)
  }));
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
