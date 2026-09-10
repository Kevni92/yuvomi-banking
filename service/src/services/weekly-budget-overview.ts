import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { latestUsableBalanceSnapshot } from '../enable-banking/balances.js';
import { createEncryptionService } from '../security/encryption.js';
import { counterpartyId } from './counterparty.js';
import {
  calculateWeeklyBudgetTransfer,
  evaluateDirectExpense,
  type WeeklyBudgetOverride
} from './weekly-budget.js';
import { weeklyBudgetWindow } from './weekly-budget-schedule.js';

export interface WeeklyBudgetConfigRow extends Record<string, unknown> {
  id: number;
  yuvomi_user_id: number;
  enabled: number;
  source_account_id: number;
  source_account_name: string | null;
  source_iban_encrypted: string | null;
  target_account_id: number;
  target_account_name: string | null;
  target_iban_encrypted: string | null;
  target_amount_cents: number;
  currency: string;
  cutoff_weekday: number;
  cutoff_time: string;
  timezone: string;
  sync_time_1: string;
  sync_time_2: string;
  balance_stale_after_minutes: number;
  notification_enabled: number;
  notification_user_id: number | null;
  notification_qr_preview: number;
  purpose_prefix: string;
  effective_from_date: string;
  created_at: string;
  updated_at: string;
}

interface TransactionRow extends Record<string, unknown> {
  id: number;
  provider_transaction_id: string;
  booking_date: string | null;
  value_date: string | null;
  transaction_date: string | null;
  amount_cents: number;
  currency: string;
  direction: 'incoming' | 'outgoing';
  status: 'PDNG' | 'BOOK' | 'UNKNOWN';
  counterparty_id: string | null;
  counterparty_name: string | null;
  category_id: number | null;
  category_name: string | null;
  weekly_budget_default: number | null;
  weekly_budget_override: WeeklyBudgetOverride;
}

export interface CollectedDirectExpense {
  transactionId: number;
  transactionKey: string;
  bookingDate: string;
  amountCents: number;
  currency: 'EUR';
  counterpartyName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  weeklyBudgetOverride: WeeklyBudgetOverride;
  decisionSource: 'transaction_override' | 'category_default';
}

export function findWeeklyBudgetConfig(
  database: DatabaseSync,
  yuvomiUserId: number,
  activeOnly = false
): WeeklyBudgetConfigRow | null {
  const row = database.prepare(`
    SELECT weekly_budget_configs.*,
           source_account.display_name AS source_account_name,
           source_account.iban_encrypted AS source_iban_encrypted,
           target_account.display_name AS target_account_name,
           target_account.iban_encrypted AS target_iban_encrypted
    FROM weekly_budget_configs
    JOIN bank_accounts AS source_account
      ON source_account.id = weekly_budget_configs.source_account_id
    JOIN bank_accounts AS target_account
      ON target_account.id = weekly_budget_configs.target_account_id
    WHERE weekly_budget_configs.yuvomi_user_id = ?
      AND (? = 0 OR weekly_budget_configs.enabled = 1)
    ORDER BY weekly_budget_configs.enabled DESC, weekly_budget_configs.id DESC
    LIMIT 1
  `).get(yuvomiUserId, activeOnly ? 1 : 0) as WeeklyBudgetConfigRow | undefined;
  return row ?? null;
}

export function findWeeklyBudgetConfigById(
  database: DatabaseSync,
  configId: number
): WeeklyBudgetConfigRow | null {
  const row = database.prepare(`
    SELECT weekly_budget_configs.*,
           source_account.display_name AS source_account_name,
           source_account.iban_encrypted AS source_iban_encrypted,
           target_account.display_name AS target_account_name,
           target_account.iban_encrypted AS target_iban_encrypted
    FROM weekly_budget_configs
    JOIN bank_accounts AS source_account
      ON source_account.id = weekly_budget_configs.source_account_id
    JOIN bank_accounts AS target_account
      ON target_account.id = weekly_budget_configs.target_account_id
    WHERE weekly_budget_configs.id = ?
    LIMIT 1
  `).get(configId) as WeeklyBudgetConfigRow | undefined;
  return row ?? null;
}

export function collectWeeklyBudgetDirectExpenses(
  database: DatabaseSync,
  configRow: WeeklyBudgetConfigRow,
  periodStartDate: string,
  periodEndDate: string
): { totalCents: number; expenses: CollectedDirectExpense[] } {
  const internalCounterparties = ownAccountCounterpartyIds(configRow);
  const matchedTransfers = matchedTransferTransactionIds(database, configRow);
  const rows = database.prepare(`
    SELECT transactions.id, transactions.provider_transaction_id,
           transactions.booking_date, transactions.value_date,
           transactions.transaction_date, transactions.amount_cents,
           transactions.currency, transactions.direction, transactions.status,
           transactions.counterparty_name, transactions.weekly_budget_override,
           counterparties.counterparty_id,
           categories.id AS category_id, categories.name AS category_name,
           categories.weekly_budget_default
    FROM transactions
    LEFT JOIN counterparties ON counterparties.id = transactions.counterparty_ref
    LEFT JOIN categories ON categories.id = transactions.category_id
    WHERE transactions.account_id = ?
      AND COALESCE(
        transactions.booking_date,
        transactions.value_date,
        transactions.transaction_date
      ) >= ?
      AND COALESCE(
        transactions.booking_date,
        transactions.value_date,
        transactions.transaction_date
      ) < ?
    ORDER BY COALESCE(
      transactions.booking_date,
      transactions.value_date,
      transactions.transaction_date
    ), transactions.id
  `).all(
    configRow.source_account_id,
    periodStartDate,
    periodEndDate
  ) as unknown as TransactionRow[];

  let total = 0n;
  const expenses: CollectedDirectExpense[] = [];
  for (const row of rows) {
    const evaluation = evaluateDirectExpense({
      accountId: Number(configRow.source_account_id),
      sourceAccountId: Number(configRow.source_account_id),
      direction: row.direction,
      status: row.status,
      currency: row.currency,
      amountCents: Number(row.amount_cents),
      bookingDate: row.booking_date,
      valueDate: row.value_date,
      transactionDate: row.transaction_date,
      transactionOverride: row.weekly_budget_override,
      categoryDefault: row.weekly_budget_default === 1,
      isInternalTransfer: row.counterparty_id
        ? internalCounterparties.has(row.counterparty_id)
        : false,
      isRefillTransfer: matchedTransfers.has(Number(row.id)),
      periodStartDate,
      periodEndDate
    });
    if (!evaluation.included || !evaluation.effectiveDate) continue;
    if (
      evaluation.decision.source !== 'transaction_override'
      && evaluation.decision.source !== 'category_default'
    ) throw new Error('Included weekly-budget expense has no decision source.');

    total += BigInt(evaluation.amountCents);
    expenses.push({
      transactionId: Number(row.id),
      transactionKey: row.provider_transaction_id,
      bookingDate: evaluation.effectiveDate,
      amountCents: evaluation.amountCents,
      currency: 'EUR',
      counterpartyName: row.counterparty_name,
      categoryId: row.category_id == null ? null : Number(row.category_id),
      categoryName: row.category_name,
      weeklyBudgetOverride: row.weekly_budget_override,
      decisionSource: evaluation.decision.source
    });
  }
  const totalCents = Number(total);
  if (!Number.isSafeInteger(totalCents)) {
    throw new Error('Weekly direct expenses exceed the supported range.');
  }
  return { totalCents, expenses };
}

export function serializeWeeklyBudgetSettings(configRow: WeeklyBudgetConfigRow): Record<string, unknown> {
  return {
    id: Number(configRow.id),
    enabled: Boolean(configRow.enabled),
    source_account: {
      id: Number(configRow.source_account_id),
      display_name: configRow.source_account_name
    },
    target_account: {
      id: Number(configRow.target_account_id),
      display_name: configRow.target_account_name
    },
    target_amount_cents: Number(configRow.target_amount_cents),
    currency: configRow.currency,
    cutoff_weekday: Number(configRow.cutoff_weekday),
    cutoff_time: configRow.cutoff_time,
    timezone: configRow.timezone,
    sync_time_1: configRow.sync_time_1,
    sync_time_2: configRow.sync_time_2,
    balance_stale_after_minutes: Number(configRow.balance_stale_after_minutes),
    notification_enabled: Boolean(configRow.notification_enabled),
    notification_user_id: configRow.notification_user_id == null
      ? null
      : Number(configRow.notification_user_id),
    notification_qr_preview: Boolean(configRow.notification_qr_preview),
    purpose_prefix: configRow.purpose_prefix,
    effective_from_date: configRow.effective_from_date,
    created_at: configRow.created_at,
    updated_at: configRow.updated_at
  };
}

export function buildCurrentWeeklyBudgetOverview(
  database: DatabaseSync,
  yuvomiUserId: number,
  now = new Date()
): Record<string, unknown> {
  const configRow = findWeeklyBudgetConfig(database, yuvomiUserId);
  if (!configRow) return { configured: false };
  if (!configRow.enabled) {
    return {
      configured: true,
      enabled: false,
      settings: serializeWeeklyBudgetSettings(configRow)
    };
  }

  const window = weeklyBudgetWindow({
    now,
    cutoffWeekday: Number(configRow.cutoff_weekday),
    cutoffTime: configRow.cutoff_time,
    timezone: configRow.timezone,
    effectiveFromDate: configRow.effective_from_date
  });
  const collected = collectWeeklyBudgetDirectExpenses(
    database,
    configRow,
    window.periodStartDate,
    window.periodEndDate
  );
  const directExpenseCents = collected.totalCents;
  const directExpenses = collected.expenses.map((expense) => ({
    transaction_id: expense.transactionId,
    booking_date: expense.bookingDate,
    amount_cents: expense.amountCents,
    counterparty_name: expense.counterpartyName,
    category_id: expense.categoryId,
    category_name: expense.categoryName,
    decision_source: expense.decisionSource
  }));

  const balance = latestUsableBalanceSnapshot(database, Number(configRow.target_account_id));
  const fetchedAt = balance ? Date.parse(balance.fetchedAt) : Number.NaN;
  const balanceAgeMs = now.getTime() - fetchedAt;
  const balanceStale = !balance
    || !Number.isFinite(fetchedAt)
    || balanceAgeMs > Number(configRow.balance_stale_after_minutes) * 60_000
    || balanceAgeMs < -5 * 60_000;
  const calculation = balance && !balanceStale
    ? calculateWeeklyBudgetTransfer({
        targetAmountCents: Number(configRow.target_amount_cents),
        directExpenseCents,
        targetBalanceCents: balance.amountCents
      })
    : null;

  const latestSuggestion = database.prepare(`
    SELECT transfer_suggestions.id, transfer_suggestions.revision,
           transfer_suggestions.target_amount_cents,
           transfer_suggestions.target_balance_cents,
           transfer_suggestions.deducted_amount_cents,
           transfer_suggestions.computed_amount_cents,
           transfer_suggestions.status, transfer_suggestions.purpose,
           transfer_suggestions.generated_at,
           weekly_budget_periods.period_key
    FROM transfer_suggestions
    JOIN weekly_budget_periods
      ON weekly_budget_periods.id = transfer_suggestions.period_id
    WHERE weekly_budget_periods.config_id = ?
    ORDER BY weekly_budget_periods.scheduled_cutoff_at DESC,
             transfer_suggestions.revision DESC
    LIMIT 1
  `).get(configRow.id) as Record<string, unknown> | undefined;

  return {
    configured: true,
    settings: serializeWeeklyBudgetSettings(configRow),
    period: {
      start_date: window.periodStartDate,
      end_date: window.periodEndDate,
      next_cutoff_at: window.nextCutoffAt
    },
    available_to_spend_cents: balance?.amountCents ?? null,
    balance: balance
      ? {
          snapshot_id: balance.id,
          amount_cents: balance.amountCents,
          currency: balance.currency,
          balance_type: balance.providerBalanceType,
          observed_at: balance.observedAt,
          fetched_at: balance.fetchedAt,
          stale: balanceStale
        }
      : null,
    direct_expense_cents: directExpenseCents,
    direct_expenses: directExpenses,
    provisional_calculation: calculation
      ? {
          target_amount_cents: calculation.targetAmountCents,
          direct_expense_cents: calculation.directExpenseCents,
          target_balance_cents: calculation.targetBalanceCents,
          raw_computed_amount_cents: calculation.rawComputedAmountCents,
          transfer_amount_cents: calculation.transferAmountCents,
          overfunded_cents: calculation.overfundedCents,
          calculation_version: calculation.calculationVersion
        }
      : null,
    latest_suggestion: latestSuggestion ? { ...latestSuggestion } : null
  };
}

function ownAccountCounterpartyIds(configRow: WeeklyBudgetConfigRow): Set<string> {
  const encryptedIbans = [
    configRow.source_iban_encrypted,
    configRow.target_iban_encrypted
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (encryptedIbans.length === 0) return new Set();

  const encryption = createEncryptionService();
  return new Set(encryptedIbans.map((encryptedIban) =>
    counterpartyId(encryption.decrypt(encryptedIban), config.secrets.counterpartyHmac)
  ));
}

function matchedTransferTransactionIds(
  database: DatabaseSync,
  configRow: WeeklyBudgetConfigRow
): Set<number> {
  const rows = database.prepare(`
    SELECT matched_transaction_id, matched_source_transaction_id,
           matched_target_transaction_id
    FROM transfer_suggestions
    WHERE source_account_id = ? AND target_account_id = ?
  `).all(
    configRow.source_account_id,
    configRow.target_account_id
  ) as Array<Record<string, unknown>>;
  const ids = new Set<number>();
  for (const row of rows) {
    for (const value of [
      row.matched_transaction_id,
      row.matched_source_transaction_id,
      row.matched_target_transaction_id
    ]) {
      if (typeof value === 'number' && Number.isSafeInteger(value)) ids.add(value);
    }
  }
  return ids;
}
