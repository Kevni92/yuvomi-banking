import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import type { EnableBankingClient } from '../enable-banking/client.js';
import { persistAccountBalanceSnapshots } from '../enable-banking/balances.js';
import { importTransactions } from '../enable-banking/importer.js';
import { createEncryptionService } from '../security/encryption.js';
import {
  buildWeeklyBudgetTransferPurpose,
  calculateWeeklyBudgetTransfer
} from './weekly-budget.js';
import {
  collectWeeklyBudgetDirectExpenses,
  findWeeklyBudgetConfigById,
  type WeeklyBudgetConfigRow
} from './weekly-budget-overview.js';
import { weeklyBudgetPeriodEndingAt } from './weekly-budget-schedule.js';
import { buildEpcQrPayload, giroCodePayloadSha256 } from './girocode.js';
import { matchWeeklyBudgetTransfers } from './weekly-budget-transfer-matcher.js';

export type WeeklyBudgetRunTrigger = 'scheduled' | 'catch_up' | 'manual';

export interface WeeklyBudgetRunResult {
  runId: number;
  periodId: number;
  suggestionId: number;
  periodKey: string;
  revision: number;
  targetAmountCents: number;
  targetBalanceCents: number;
  directExpenseCents: number;
  transferAmountCents: number;
  overfundedCents: number;
  purpose: string;
  status: string;
  idempotentReplay: boolean;
}

interface RunnerAccount {
  id: number;
  providerAccountId: string;
  displayName: string | null;
  ibanEncrypted: string | null;
  currency: string;
}

interface ProviderAccountData {
  transactions: Array<Record<string, unknown>>;
  balances: Array<Record<string, unknown>>;
}

export class WeeklyBudgetRunInProgressError extends Error {}

export async function runWeeklyBudgetCutoff({
  database,
  client,
  configId,
  scheduledCutoffAt,
  trigger,
  clock = () => new Date()
}: {
  database: DatabaseSync;
  client: EnableBankingClient;
  configId: number;
  scheduledCutoffAt: Date;
  trigger: WeeklyBudgetRunTrigger;
  clock?: () => Date;
}): Promise<WeeklyBudgetRunResult> {
  if (!Number.isSafeInteger(configId) || configId < 1) {
    throw new Error('Weekly-budget configuration ID is invalid.');
  }
  const configRow = findWeeklyBudgetConfigById(database, configId);
  if (!configRow || !configRow.enabled) {
    throw new Error('Active weekly-budget configuration was not found.');
  }
  const period = weeklyBudgetPeriodEndingAt({
    scheduledCutoffAt,
    timezone: configRow.timezone,
    effectiveFromDate: configRow.effective_from_date
  });
  const periodKey = `weekly-budget:${configId}:${period.scheduledCutoffAt}`;
  const runKey = periodKey;
  const startedAt = clock();
  if (Number.isNaN(startedAt.getTime())) throw new Error('Weekly-budget run time is invalid.');
  const run = claimJobRun(database, {
    configId,
    runKey,
    scheduledFor: period.scheduledCutoffAt,
    trigger,
    now: startedAt
  });
  if (run.completedResult) return run.completedResult;

  const accounts = loadRunnerAccounts(database, configRow);
  const sourceAccount = accounts.get(Number(configRow.source_account_id));
  const targetAccount = accounts.get(Number(configRow.target_account_id));
  if (!sourceAccount || !targetAccount) {
    markRunFailed(database, run.runId, clock(), 'account_unavailable', 'failed', 'failed');
    throw new Error('Configured weekly-budget accounts are unavailable.');
  }

  const providerResults = await Promise.allSettled([
    fetchAccountData(client, sourceAccount, period.periodStartDate),
    fetchAccountData(client, targetAccount, period.periodStartDate)
  ]);
  const sourceSyncStatus = providerResults[0].status === 'fulfilled' ? 'succeeded' : 'failed';
  const targetSyncStatus = providerResults[1].status === 'fulfilled' ? 'succeeded' : 'failed';
  if (providerResults.some((result) => result.status === 'rejected')) {
    markRunFailed(
      database,
      run.runId,
      clock(),
      'provider_sync_failed',
      sourceSyncStatus,
      targetSyncStatus
    );
    throw new Error('Fresh weekly-budget account synchronization failed.');
  }

  if (providerResults[0].status !== 'fulfilled' || providerResults[1].status !== 'fulfilled') {
    throw new Error('Fresh weekly-budget account synchronization failed.');
  }

  const sourceData = providerResults[0].value;
  const targetData = providerResults[1].value;
  const syncedAt = clock();
  const encryption = createEncryptionService();
  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;
    importTransactions({
      database,
      accountId: sourceAccount.id,
      transactions: sourceData.transactions,
      hmacSecret: config.secrets.counterpartyHmac,
      encryption,
      manageTransaction: false
    });
    importTransactions({
      database,
      accountId: targetAccount.id,
      transactions: targetData.transactions,
      hmacSecret: config.secrets.counterpartyHmac,
      encryption,
      manageTransaction: false
    });
    matchWeeklyBudgetTransfers(database, configId, syncedAt);
    persistAccountBalanceSnapshots({
      database,
      accountId: sourceAccount.id,
      balances: sourceData.balances,
      expectedCurrency: sourceAccount.currency,
      fetchedAt: syncedAt,
      syncRunKey: `${runKey}:source`,
      manageTransaction: false
    });
    const targetBalances = persistAccountBalanceSnapshots({
      database,
      accountId: targetAccount.id,
      balances: targetData.balances,
      expectedCurrency: targetAccount.currency,
      fetchedAt: syncedAt,
      syncRunKey: `${runKey}:target`,
      manageTransaction: false
    });
    if (!targetBalances.usableBalance) {
      throw new Error('Target account returned no usable EUR balance.');
    }

    database.prepare(`
      UPDATE bank_accounts SET last_synced_at = ?, updated_at = ? WHERE id IN (?, ?)
    `).run(
      syncedAt.toISOString(),
      syncedAt.toISOString(),
      sourceAccount.id,
      targetAccount.id
    );
    const directExpenses = collectWeeklyBudgetDirectExpenses(
      database,
      configRow,
      period.periodStartDate,
      period.periodEndDate
    );
    const calculation = calculateWeeklyBudgetTransfer({
      targetAmountCents: Number(configRow.target_amount_cents),
      directExpenseCents: directExpenses.totalCents,
      targetBalanceCents: targetBalances.usableBalance.amountCents
    });
    const purpose = buildWeeklyBudgetTransferPurpose({
      cutoffDate: period.periodEndDate,
      targetAmountCents: calculation.targetAmountCents,
      directExpenseCents: calculation.directExpenseCents,
      targetBalanceCents: calculation.targetBalanceCents,
      transferAmountCents: calculation.transferAmountCents,
      prefix: configRow.purpose_prefix,
      targetAccountLabel: 'N26'
    });
    const beneficiaryName = configRow.target_beneficiary_name
      ?? targetAccount.displayName
      ?? '';
    if (!targetAccount.ibanEncrypted) {
      throw new Error('Target account has no IBAN for the GiroCode snapshot.');
    }
    const payloadSha256 = calculation.transferAmountCents > 0
      ? giroCodePayloadSha256(buildEpcQrPayload({
          beneficiaryName,
          iban: encryption.decrypt(targetAccount.ibanEncrypted),
          amountCents: calculation.transferAmountCents,
          remittance: purpose
        }))
      : null;
    const finalizedAt = clock().toISOString();
    const periodInsert = database.prepare(`
      INSERT INTO weekly_budget_periods (
        config_id, period_key, period_start_date, period_end_date,
        scheduled_cutoff_at, finalized_at, trigger, status,
        source_account_id, source_account_name, target_account_id,
        target_account_name, target_amount_cents, currency,
        target_balance_snapshot_id, target_balance_cents,
        direct_expense_cents, raw_computed_amount_cents,
        computed_amount_cents, overfunded_cents, calculation_version,
        source_sync_completed_at, target_sync_completed_at,
        cutoff_weekday, cutoff_time, timezone, purpose_prefix,
        target_beneficiary_name, target_iban_encrypted,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'finalized', ?, ?, ?, ?, ?, 'EUR',
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      configRow.id,
      periodKey,
      period.periodStartDate,
      period.periodEndDate,
      period.scheduledCutoffAt,
      finalizedAt,
      trigger,
      sourceAccount.id,
      sourceAccount.displayName,
      targetAccount.id,
      targetAccount.displayName,
      calculation.targetAmountCents,
      targetBalances.usableBalance.id,
      calculation.targetBalanceCents,
      calculation.directExpenseCents,
      calculation.rawComputedAmountCents,
      calculation.transferAmountCents,
      calculation.overfundedCents,
      calculation.calculationVersion,
      syncedAt.toISOString(),
      syncedAt.toISOString(),
      configRow.cutoff_weekday,
      configRow.cutoff_time,
      configRow.timezone,
      configRow.purpose_prefix,
      beneficiaryName,
      targetAccount.ibanEncrypted,
      finalizedAt,
      finalizedAt
    );
    const periodId = Number(periodInsert.lastInsertRowid);
    const insertExpense = database.prepare(`
      INSERT INTO weekly_budget_period_transactions (
        period_id, transaction_id, transaction_key, revision, state,
        amount_cents, currency, booking_date, counterparty_name,
        category_id, category_name, weekly_budget_override,
        decision_source, created_at
      ) VALUES (?, ?, ?, 1, 'included', ?, 'EUR', ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const expense of directExpenses.expenses) {
      insertExpense.run(
        periodId,
        expense.transactionId,
        expense.transactionKey,
        expense.amountCents,
        expense.bookingDate,
        expense.counterpartyName,
        expense.categoryId,
        expense.categoryName,
        expense.weeklyBudgetOverride,
        expense.decisionSource,
        finalizedAt
      );
    }
    const suggestionStatus = calculation.transferAmountCents === 0
      ? 'no_transfer'
      : 'proposed';
    const suggestionInsert = database.prepare(`
      INSERT INTO transfer_suggestions (
        period_id, revision, source_account_id, target_account_id,
        target_amount_cents, target_balance_cents, computed_amount_cents,
        deducted_amount_cents, raw_computed_amount_cents, overfunded_cents,
        week_start, week_end, purpose, calculation_version, status,
        payload_sha256, generated_at, created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      periodId,
      sourceAccount.id,
      targetAccount.id,
      calculation.targetAmountCents,
      calculation.targetBalanceCents,
      calculation.transferAmountCents,
      calculation.directExpenseCents,
      calculation.rawComputedAmountCents,
      calculation.overfundedCents,
      period.periodStartDate,
      period.periodEndDate,
      purpose,
      calculation.calculationVersion,
      suggestionStatus,
      payloadSha256,
      finalizedAt,
      finalizedAt,
      finalizedAt
    );
    const suggestionId = Number(suggestionInsert.lastInsertRowid);
    database.prepare(`
      UPDATE weekly_budget_job_runs SET
        period_id = ?, status = 'succeeded', finished_at = ?,
        lease_owner = NULL, lease_expires_at = NULL,
        source_sync_status = 'succeeded', target_sync_status = 'succeeded',
        error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(periodId, finalizedAt, finalizedAt, run.runId);
    database.exec('COMMIT;');
    transactionOpen = false;

    return {
      runId: run.runId,
      periodId,
      suggestionId,
      periodKey,
      revision: 1,
      targetAmountCents: calculation.targetAmountCents,
      targetBalanceCents: calculation.targetBalanceCents,
      directExpenseCents: calculation.directExpenseCents,
      transferAmountCents: calculation.transferAmountCents,
      overfundedCents: calculation.overfundedCents,
      purpose,
      status: suggestionStatus,
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
    markRunFailed(
      database,
      run.runId,
      clock(),
      'processing_failed',
      'succeeded',
      'succeeded'
    );
    throw new Error('Weekly-budget cutoff processing failed.', { cause: error });
  }
}

function claimJobRun(
  database: DatabaseSync,
  input: {
    configId: number;
    runKey: string;
    scheduledFor: string;
    trigger: WeeklyBudgetRunTrigger;
    now: Date;
  }
): { runId: number; completedResult: WeeklyBudgetRunResult | null } {
  const nowIso = input.now.toISOString();
  const leaseOwner = crypto.randomUUID();
  const leaseExpiresAt = new Date(input.now.getTime() + 10 * 60_000).toISOString();
  const inserted = database.prepare(`
    INSERT OR IGNORE INTO weekly_budget_job_runs (
      config_id, run_key, trigger, attempt, status, scheduled_for,
      started_at, lease_owner, lease_expires_at, source_sync_status,
      target_sync_status, created_at, updated_at
    ) VALUES (?, ?, ?, 1, 'running', ?, ?, ?, ?, 'pending', 'pending', ?, ?)
  `).run(
    input.configId,
    input.runKey,
    input.trigger,
    input.scheduledFor,
    nowIso,
    leaseOwner,
    leaseExpiresAt,
    nowIso,
    nowIso
  );
  const existing = database.prepare(`
    SELECT id, period_id, status, lease_expires_at
    FROM weekly_budget_job_runs WHERE run_key = ?
  `).get(input.runKey) as {
    id: number;
    period_id: number | null;
    status: string;
    lease_expires_at: string | null;
  } | undefined;
  if (!existing) throw new Error('Weekly-budget job run could not be created.');
  if (Number(inserted.changes) === 1) {
    return { runId: Number(existing.id), completedResult: null };
  }
  if (existing.status === 'succeeded' && existing.period_id) {
    return {
      runId: Number(existing.id),
      completedResult: readCompletedRunResult(database, Number(existing.id), Number(existing.period_id))
    };
  }
  const leaseExpiry = existing.lease_expires_at ? Date.parse(existing.lease_expires_at) : Number.NaN;
  if (existing.status === 'running' && Number.isFinite(leaseExpiry) && leaseExpiry > input.now.getTime()) {
    throw new WeeklyBudgetRunInProgressError('Weekly-budget cutoff is already running.');
  }
  const reclaimed = database.prepare(`
    UPDATE weekly_budget_job_runs SET
      trigger = ?, attempt = attempt + 1, status = 'running',
      started_at = ?, finished_at = NULL, lease_owner = ?, lease_expires_at = ?,
      source_sync_status = 'pending', target_sync_status = 'pending',
      error_code = NULL, error_message = NULL, updated_at = ?
    WHERE id = ? AND status <> 'succeeded'
  `).run(
    input.trigger,
    nowIso,
    leaseOwner,
    leaseExpiresAt,
    nowIso,
    existing.id
  );
  if (Number(reclaimed.changes) !== 1) {
    throw new WeeklyBudgetRunInProgressError('Weekly-budget cutoff could not be claimed.');
  }
  return { runId: Number(existing.id), completedResult: null };
}

function readCompletedRunResult(
  database: DatabaseSync,
  runId: number,
  periodId: number
): WeeklyBudgetRunResult {
  const row = database.prepare(`
    SELECT weekly_budget_periods.period_key,
           transfer_suggestions.id AS suggestion_id,
           transfer_suggestions.revision,
           transfer_suggestions.target_amount_cents,
           transfer_suggestions.target_balance_cents,
           transfer_suggestions.deducted_amount_cents,
           transfer_suggestions.computed_amount_cents,
           transfer_suggestions.overfunded_cents,
           transfer_suggestions.purpose,
           transfer_suggestions.status
    FROM weekly_budget_periods
    JOIN transfer_suggestions
      ON transfer_suggestions.period_id = weekly_budget_periods.id
    WHERE weekly_budget_periods.id = ?
    ORDER BY transfer_suggestions.revision DESC
    LIMIT 1
  `).get(periodId) as Record<string, unknown> | undefined;
  if (!row) throw new Error('Completed weekly-budget result could not be found.');
  return {
    runId,
    periodId,
    suggestionId: Number(row.suggestion_id),
    periodKey: String(row.period_key),
    revision: Number(row.revision),
    targetAmountCents: Number(row.target_amount_cents),
    targetBalanceCents: Number(row.target_balance_cents),
    directExpenseCents: Number(row.deducted_amount_cents),
    transferAmountCents: Number(row.computed_amount_cents),
    overfundedCents: Number(row.overfunded_cents),
    purpose: String(row.purpose),
    status: String(row.status),
    idempotentReplay: true
  };
}

function loadRunnerAccounts(
  database: DatabaseSync,
  configRow: WeeklyBudgetConfigRow
): Map<number, RunnerAccount> {
  const rows = database.prepare(`
    SELECT bank_accounts.id, bank_accounts.provider_account_id,
           bank_accounts.display_name, bank_accounts.iban_encrypted,
           bank_accounts.currency,
           enable_banking_connections.yuvomi_user_id,
           enable_banking_connections.status AS connection_status
    FROM bank_accounts
    JOIN enable_banking_connections
      ON enable_banking_connections.id = bank_accounts.connection_id
    WHERE bank_accounts.id IN (?, ?)
  `).all(
    configRow.source_account_id,
    configRow.target_account_id
  ) as Array<Record<string, unknown>>;
  const result = new Map<number, RunnerAccount>();
  for (const row of rows) {
    if (
      Number(row.yuvomi_user_id) !== Number(configRow.yuvomi_user_id)
      || row.connection_status !== 'authorized'
      || row.currency !== 'EUR'
    ) continue;
    result.set(Number(row.id), {
      id: Number(row.id),
      providerAccountId: String(row.provider_account_id),
      displayName: typeof row.display_name === 'string' ? row.display_name : null,
      ibanEncrypted: typeof row.iban_encrypted === 'string' ? row.iban_encrypted : null,
      currency: String(row.currency)
    });
  }
  return result;
}

async function fetchAccountData(
  client: EnableBankingClient,
  account: RunnerAccount,
  dateFrom: string
): Promise<ProviderAccountData> {
  const [transactions, balances] = await Promise.all([
    client.getAllAccountTransactions(account.providerAccountId, { dateFrom }),
    client.getAccountBalances(account.providerAccountId)
  ]);
  return {
    transactions: transactions.transactions,
    balances: balances.balances
  };
}

function markRunFailed(
  database: DatabaseSync,
  runId: number,
  finishedAt: Date,
  errorCode: string,
  sourceSyncStatus: 'succeeded' | 'failed',
  targetSyncStatus: 'succeeded' | 'failed'
): void {
  const timestamp = Number.isNaN(finishedAt.getTime())
    ? new Date().toISOString()
    : finishedAt.toISOString();
  try {
    database.prepare(`
      UPDATE weekly_budget_job_runs SET
        status = 'failed', finished_at = ?, lease_owner = NULL,
        lease_expires_at = NULL, source_sync_status = ?, target_sync_status = ?,
        error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ? AND status <> 'succeeded'
    `).run(
      timestamp,
      sourceSyncStatus,
      targetSyncStatus,
      errorCode,
      'Weekly-budget run failed. See server diagnostics.',
      timestamp,
      runId
    );
  } catch {
    // Never replace the original provider or processing error.
  }
}
