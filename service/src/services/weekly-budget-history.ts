import type { DatabaseSync } from 'node:sqlite';
import { createEncryptionService } from '../security/encryption.js';
import { maskIban } from './counterparty.js';
import { loadWeeklyBudgetGiroCode } from './girocode.js';

export class WeeklyBudgetPeriodNotFoundError extends Error {}

export function listWeeklyBudgetPeriods(
  database: DatabaseSync,
  yuvomiUserId: number,
  limit = 52
): Array<Record<string, unknown>> {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, 104)
    : 52;
  const rows = database.prepare(`
    SELECT weekly_budget_periods.id, weekly_budget_periods.period_key,
           weekly_budget_periods.period_start_date,
           weekly_budget_periods.period_end_date,
           weekly_budget_periods.scheduled_cutoff_at,
           weekly_budget_periods.finalized_at,
           weekly_budget_periods.trigger, weekly_budget_periods.status,
           weekly_budget_periods.source_account_name,
           weekly_budget_periods.target_account_name,
           weekly_budget_periods.target_amount_cents,
           weekly_budget_periods.target_balance_cents,
           weekly_budget_periods.direct_expense_cents,
           weekly_budget_periods.raw_computed_amount_cents,
           weekly_budget_periods.computed_amount_cents,
           weekly_budget_periods.overfunded_cents,
           weekly_budget_periods.currency,
           transfer_suggestions.id AS suggestion_id,
           transfer_suggestions.revision AS suggestion_revision,
           transfer_suggestions.status AS suggestion_status,
           transfer_suggestions.computed_amount_cents AS suggestion_computed_amount_cents,
           transfer_suggestions.purpose,
           transfer_suggestions.payload_sha256,
           transfer_suggestions.generated_at,
           transfer_suggestions.completed_at,
           transfer_suggestions.matched_source_transaction_id,
           transfer_suggestions.matched_target_transaction_id
    FROM weekly_budget_periods
    JOIN weekly_budget_configs
      ON weekly_budget_configs.id = weekly_budget_periods.config_id
    LEFT JOIN transfer_suggestions
      ON transfer_suggestions.period_id = weekly_budget_periods.id
     AND transfer_suggestions.revision = (
       SELECT MAX(latest.revision)
       FROM transfer_suggestions AS latest
       WHERE latest.period_id = weekly_budget_periods.id
     )
    WHERE weekly_budget_configs.yuvomi_user_id = ?
    ORDER BY weekly_budget_periods.scheduled_cutoff_at DESC,
             weekly_budget_periods.id DESC
    LIMIT ?
  `).all(yuvomiUserId, safeLimit) as Array<Record<string, unknown>>;
  return rows.map((row) => serializePeriodRow(row));
}

export function getWeeklyBudgetPeriod(
  database: DatabaseSync,
  yuvomiUserId: number,
  periodId: number
): Record<string, unknown> {
  if (!Number.isSafeInteger(periodId) || periodId < 1) {
    throw new WeeklyBudgetPeriodNotFoundError('Weekly-budget period was not found.');
  }
  const period = database.prepare(`
    SELECT weekly_budget_periods.*
    FROM weekly_budget_periods
    JOIN weekly_budget_configs
      ON weekly_budget_configs.id = weekly_budget_periods.config_id
    WHERE weekly_budget_periods.id = ?
      AND weekly_budget_configs.yuvomi_user_id = ?
    LIMIT 1
  `).get(periodId, yuvomiUserId) as Record<string, unknown> | undefined;
  if (!period) {
    throw new WeeklyBudgetPeriodNotFoundError('Weekly-budget period was not found.');
  }

  const balanceSnapshots = database.prepare(`
    SELECT id, account_id, sync_run_key, provider_balance_type,
           normalized_balance_type, amount_cents, currency, observed_at,
           fetched_at, usable_for_weekly_budget
    FROM account_balance_snapshots
    WHERE (
        account_id = ?
        AND sync_run_key = ? || ':source'
      ) OR (
        account_id = ?
        AND (
          sync_run_key = ? || ':target'
          OR id = ?
        )
      )
    ORDER BY account_id, usable_for_weekly_budget DESC,
             fetched_at DESC, id DESC
  `).all(
    numberOrNull(period.source_account_id),
    String(period.period_key),
    numberOrNull(period.target_account_id),
    String(period.period_key),
    numberOrNull(period.target_balance_snapshot_id)
  ) as Array<Record<string, unknown>>;
  const transactions = database.prepare(`
    SELECT id, transaction_id, transaction_key, revision, state,
           amount_cents, currency, booking_date, counterparty_name,
           category_id, category_name, weekly_budget_override,
           decision_source, created_at
    FROM weekly_budget_period_transactions
    WHERE period_id = ?
    ORDER BY revision, booking_date, id
  `).all(periodId) as Array<Record<string, unknown>>;
  const suggestions = database.prepare(`
    SELECT id, revision, target_amount_cents, target_balance_cents,
           computed_amount_cents, deducted_amount_cents,
           raw_computed_amount_cents, overfunded_cents, purpose,
           payload_sha256, calculation_version, status,
           matched_transaction_id, matched_source_transaction_id,
           matched_target_transaction_id,
           generated_at, completed_at, created_at, updated_at
    FROM transfer_suggestions
    WHERE period_id = ?
    ORDER BY revision DESC
  `).all(periodId) as Array<Record<string, unknown>>;
  const syncRuns = database.prepare(`
    SELECT id, run_key, trigger, attempt, status, scheduled_for,
           started_at, finished_at, source_sync_status,
           target_sync_status, error_code
    FROM weekly_budget_job_runs
    WHERE period_id = ?
    ORDER BY attempt, id
  `).all(periodId) as Array<Record<string, unknown>>;

  return {
    ...serializeDetailedPeriod(period),
    balance_snapshots: balanceSnapshots.map((snapshot) => ({
      ...snapshot,
      id: Number(snapshot.id),
      account_id: Number(snapshot.account_id),
      account_role: Number(snapshot.account_id) === Number(period.source_account_id)
        ? 'source'
        : 'target',
      amount_cents: numberOrNull(snapshot.amount_cents),
      usable_for_weekly_budget: Boolean(snapshot.usable_for_weekly_budget)
    })),
    transactions: transactions.map((transaction) => ({ ...transaction })),
    suggestions: suggestions.map((suggestion) => ({
      ...suggestion,
      transfer_state: transferState(
        numberOrNull(suggestion.matched_source_transaction_id),
        numberOrNull(suggestion.matched_target_transaction_id),
        String(suggestion.status)
      ),
      girocode: Number(suggestion.computed_amount_cents) > 0
        ? safeGiroCodeSummary(database, yuvomiUserId, Number(suggestion.id))
        : null
    })),
    sync_runs: syncRuns.map((run) => ({
      ...run,
      id: Number(run.id),
      attempt: Number(run.attempt)
    }))
  };
}

function serializePeriodRow(row: Record<string, unknown>): Record<string, unknown> {
  const suggestionId = Number(row.suggestion_id);
  const matchedSourceTransactionId = numberOrNull(row.matched_source_transaction_id);
  const matchedTargetTransactionId = numberOrNull(row.matched_target_transaction_id);
  return {
    id: Number(row.id),
    period_key: row.period_key,
    period_start_date: row.period_start_date,
    period_end_date: row.period_end_date,
    scheduled_cutoff_at: row.scheduled_cutoff_at,
    finalized_at: row.finalized_at,
    trigger: row.trigger,
    status: row.status,
    source_account_name: row.source_account_name,
    target_account_name: row.target_account_name,
    target_amount_cents: numberOrNull(row.target_amount_cents),
    target_balance_cents: numberOrNull(row.target_balance_cents),
    direct_expense_cents: numberOrNull(row.direct_expense_cents),
    raw_computed_amount_cents: numberOrNull(row.raw_computed_amount_cents),
    computed_amount_cents: numberOrNull(row.computed_amount_cents),
    overfunded_cents: numberOrNull(row.overfunded_cents),
    currency: row.currency,
    latest_suggestion: Number.isSafeInteger(suggestionId) && suggestionId > 0
      ? {
          id: suggestionId,
          revision: Number(row.suggestion_revision),
          status: row.suggestion_status,
          purpose: row.purpose,
          payload_sha256: row.payload_sha256,
          generated_at: row.generated_at,
          completed_at: row.completed_at,
          matched_source_transaction_id: matchedSourceTransactionId,
          matched_target_transaction_id: matchedTargetTransactionId,
          transfer_state: transferState(
            matchedSourceTransactionId,
            matchedTargetTransactionId,
            String(row.suggestion_status)
          ),
          girocode_url: Number(row.suggestion_computed_amount_cents) > 0
            ? `/api/extensions/banking/weekly-budget/transfers/${suggestionId}/girocode.png`
            : null
        }
      : null
  };
}

function serializeDetailedPeriod(period: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Number(period.id),
    config_id: Number(period.config_id),
    period_key: period.period_key,
    period_start_date: period.period_start_date,
    period_end_date: period.period_end_date,
    scheduled_cutoff_at: period.scheduled_cutoff_at,
    finalized_at: period.finalized_at,
    trigger: period.trigger,
    status: period.status,
    source_account: {
      id: numberOrNull(period.source_account_id),
      display_name: period.source_account_name
    },
    target_account: {
      id: numberOrNull(period.target_account_id),
      display_name: period.target_account_name,
      beneficiary_name: period.target_beneficiary_name,
      iban_masked: maskedEncryptedIban(period.target_iban_encrypted)
    },
    target_amount_cents: numberOrNull(period.target_amount_cents),
    target_balance_cents: numberOrNull(period.target_balance_cents),
    direct_expense_cents: numberOrNull(period.direct_expense_cents),
    raw_computed_amount_cents: numberOrNull(period.raw_computed_amount_cents),
    computed_amount_cents: numberOrNull(period.computed_amount_cents),
    overfunded_cents: numberOrNull(period.overfunded_cents),
    currency: period.currency,
    calculation_version: period.calculation_version,
    source_sync_completed_at: period.source_sync_completed_at,
    target_sync_completed_at: period.target_sync_completed_at,
    cutoff_weekday: numberOrNull(period.cutoff_weekday),
    cutoff_time: period.cutoff_time,
    timezone: period.timezone,
    purpose_prefix: period.purpose_prefix,
    created_at: period.created_at,
    updated_at: period.updated_at
  };
}

function safeGiroCodeSummary(
  database: DatabaseSync,
  yuvomiUserId: number,
  suggestionId: number
): Record<string, unknown> | null {
  try {
    const giroCode = loadWeeklyBudgetGiroCode(database, yuvomiUserId, suggestionId);
    return {
      beneficiary_name: giroCode.beneficiaryName,
      iban_masked: giroCode.ibanMasked,
      amount_cents: giroCode.amountCents,
      currency: giroCode.currency,
      purpose: giroCode.purpose,
      payload_sha256: giroCode.payloadSha256,
      png_url: `/api/extensions/banking/weekly-budget/transfers/${suggestionId}/girocode.png`
    };
  } catch {
    return null;
  }
}

function maskedEncryptedIban(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return maskIban(createEncryptionService().decrypt(value));
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function transferState(
  sourceTransactionId: number | null,
  targetTransactionId: number | null,
  suggestionStatus: string
): string {
  if (suggestionStatus === 'no_transfer') return 'zero';
  if (suggestionStatus === 'dismissed' || suggestionStatus === 'superseded') {
    return suggestionStatus;
  }
  if (sourceTransactionId && targetTransactionId) return 'target_arrived';
  if (sourceTransactionId) return 'source_booked';
  if (targetTransactionId) return 'target_booked';
  return suggestionStatus;
}
