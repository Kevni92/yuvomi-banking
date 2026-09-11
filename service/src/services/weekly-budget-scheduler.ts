import type { DatabaseSync } from 'node:sqlite';
import type { EnableBankingClient } from '../enable-banking/client.js';
import {
  runWeeklyBudgetCutoff,
  type WeeklyBudgetRunResult,
  type WeeklyBudgetRunTrigger
} from './weekly-budget-runner.js';
import { weeklyBudgetCutoffSchedule } from './weekly-budget-schedule.js';
import {
  runDueScheduledAccountSyncJobs,
  type DueScheduledSyncOutcome
} from './scheduled-account-sync.js';
import { enqueueWeeklyBudgetSyncFailureDeliveries } from './push-outbox.js';

const RETRY_DELAYS_MS = [5, 15, 30].map((minutes) => minutes * 60_000);

interface SchedulableConfig {
  id: number;
  cutoff_weekday: number;
  cutoff_time: string;
  timezone: string;
  effective_from_date: string;
}

interface ExistingRun {
  attempt: number;
  status: string;
  trigger: WeeklyBudgetRunTrigger;
  finished_at: string | null;
  lease_expires_at: string | null;
}

export interface DueRunOutcome {
  configId: number;
  scheduledCutoffAt: string;
  state: 'succeeded' | 'failed' | 'skipped';
  reason?: 'not_activated' | 'already_succeeded' | 'running' | 'retry_wait' | 'retry_exhausted';
  result?: WeeklyBudgetRunResult;
}

export interface BankingSchedulerTickOutcome {
  cutoffs: DueRunOutcome[];
  accountSyncs: DueScheduledSyncOutcome[];
}

export async function runDueWeeklyBudgetJobs({
  database,
  client,
  now = new Date()
}: {
  database: DatabaseSync;
  client: EnableBankingClient;
  now?: Date;
}): Promise<DueRunOutcome[]> {
  if (Number.isNaN(now.getTime())) throw new Error('Scheduler time is invalid.');
  const configs = database.prepare(`
    SELECT id, cutoff_weekday, cutoff_time, timezone, effective_from_date
    FROM weekly_budget_configs
    WHERE enabled = 1
    ORDER BY id
  `).all() as unknown as SchedulableConfig[];
  const outcomes: DueRunOutcome[] = [];

  for (const config of configs) {
    const schedule = weeklyBudgetCutoffSchedule({
      now,
      cutoffWeekday: Number(config.cutoff_weekday),
      cutoffTime: config.cutoff_time,
      timezone: config.timezone
    });
    if (config.effective_from_date >= schedule.previousCutoffDate) {
      outcomes.push({
        configId: Number(config.id),
        scheduledCutoffAt: schedule.previousCutoffAt,
        state: 'skipped',
        reason: 'not_activated'
      });
      continue;
    }

    const runKey = `weekly-budget:${config.id}:${schedule.previousCutoffAt}`;
    const existing = database.prepare(`
      SELECT attempt, status, trigger, finished_at, lease_expires_at
      FROM weekly_budget_job_runs
      WHERE run_key = ?
    `).get(runKey) as ExistingRun | undefined;
    const skipReason = existingRunSkipReason(existing, now);
    if (skipReason) {
      if (skipReason === 'retry_exhausted') {
        enqueueWeeklyBudgetSyncFailureDeliveries(database, {
          configId: Number(config.id),
          scheduledCutoffAt: schedule.previousCutoffAt,
          now
        });
      }
      outcomes.push({
        configId: Number(config.id),
        scheduledCutoffAt: schedule.previousCutoffAt,
        state: 'skipped',
        reason: skipReason
      });
      continue;
    }

    const ageMs = now.getTime() - Date.parse(schedule.previousCutoffAt);
    const trigger: WeeklyBudgetRunTrigger = existing?.trigger
      ?? (ageMs <= 2 * 60_000 ? 'scheduled' : 'catch_up');
    try {
      const result = await runWeeklyBudgetCutoff({
        database,
        client,
        configId: Number(config.id),
        scheduledCutoffAt: new Date(schedule.previousCutoffAt),
        trigger,
        clock: () => now
      });
      outcomes.push({
        configId: Number(config.id),
        scheduledCutoffAt: schedule.previousCutoffAt,
        state: 'succeeded',
        result
      });
    } catch {
      if (weeklyBudgetRetryExhausted(database, runKey)) {
        enqueueWeeklyBudgetSyncFailureDeliveries(database, {
          configId: Number(config.id),
          scheduledCutoffAt: schedule.previousCutoffAt,
          now
        });
      }
      outcomes.push({
        configId: Number(config.id),
        scheduledCutoffAt: schedule.previousCutoffAt,
        state: 'failed'
      });
    }
  }
  return outcomes;
}

function weeklyBudgetRetryExhausted(database: DatabaseSync, runKey: string): boolean {
  const run = database.prepare(`
    SELECT attempt, status FROM weekly_budget_job_runs WHERE run_key = ?
  `).get(runKey) as { attempt: number; status: string } | undefined;
  return Boolean(
    run
    && run.status === 'failed'
    && Number(run.attempt) >= RETRY_DELAYS_MS.length + 1
  );
}

export function startWeeklyBudgetScheduler({
  database,
  client,
  pollIntervalMs = 30_000,
  clock = () => new Date(),
  onTickError = () => undefined
}: {
  database: DatabaseSync;
  client: EnableBankingClient;
  pollIntervalMs?: number;
  clock?: () => Date;
  onTickError?: (error: unknown) => void;
}): { runNow: () => Promise<BankingSchedulerTickOutcome>; stop: () => void } {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1_000) {
    throw new Error('Weekly-budget scheduler interval must be at least one second.');
  }
  let stopped = false;
  let activeRun: Promise<BankingSchedulerTickOutcome> | null = null;
  const runNow = (): Promise<BankingSchedulerTickOutcome> => {
    if (stopped) return Promise.resolve({ cutoffs: [], accountSyncs: [] });
    if (activeRun) return activeRun;
    const now = clock();
    activeRun = runDueWeeklyBudgetJobs({ database, client, now })
      .then(async (cutoffs) => ({
        cutoffs,
        accountSyncs: await runDueScheduledAccountSyncJobs({ database, client, now })
      }))
      .catch((error) => {
        onTickError(error);
        return { cutoffs: [], accountSyncs: [] };
      })
      .finally(() => {
        activeRun = null;
      });
    return activeRun;
  };
  const timer = setInterval(() => {
    void runNow();
  }, pollIntervalMs);
  timer.unref();
  void runNow();

  return {
    runNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}

function existingRunSkipReason(
  existing: ExistingRun | undefined,
  now: Date
): DueRunOutcome['reason'] | null {
  if (!existing) return null;
  if (existing.status === 'succeeded') return 'already_succeeded';
  if (existing.status === 'running') {
    const leaseExpiry = existing.lease_expires_at
      ? Date.parse(existing.lease_expires_at)
      : Number.NaN;
    if (Number.isFinite(leaseExpiry) && leaseExpiry > now.getTime()) return 'running';
    return null;
  }
  if (existing.status !== 'failed') return 'running';
  if (existing.attempt >= RETRY_DELAYS_MS.length + 1) return 'retry_exhausted';
  const finishedAt = existing.finished_at ? Date.parse(existing.finished_at) : Number.NaN;
  if (!Number.isFinite(finishedAt)) return 'retry_wait';
  const delay = RETRY_DELAYS_MS[existing.attempt - 1];
  return now.getTime() >= finishedAt + delay ? null : 'retry_wait';
}
