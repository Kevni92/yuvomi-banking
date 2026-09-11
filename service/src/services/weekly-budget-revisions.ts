import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { createEncryptionService } from '../security/encryption.js';
import { counterpartyId } from './counterparty.js';
import {
  buildWeeklyBudgetTransferPurpose,
  calculateWeeklyBudgetTransfer,
  evaluateDirectExpense,
  type WeeklyBudgetOverride
} from './weekly-budget.js';
import { buildEpcQrPayload, giroCodePayloadSha256 } from './girocode.js';
import { matchWeeklyBudgetTransfers } from './weekly-budget-transfer-matcher.js';
import { enqueueWeeklyBudgetProposalDeliveries } from './push-outbox.js';

interface PeriodRow {
  id: number;
  config_id: number;
  period_key: string;
  period_start_date: string;
  period_end_date: string;
  source_account_id: number;
  source_account_name: string | null;
  target_account_id: number;
  target_account_name: string | null;
  target_amount_cents: number;
  target_balance_cents: number | null;
  currency: string;
  calculation_version: string;
  purpose_prefix: string | null;
  target_beneficiary_name: string | null;
  target_iban_encrypted: string | null;
}

interface CandidateTransactionRow {
  id: number;
  provider_transaction_id: string;
  booking_date: string | null;
  value_date: string | null;
  transaction_date: string | null;
  amount_cents: number;
  currency: string;
  direction: string;
  status: string;
  counterparty_id: string | null;
  counterparty_name: string | null;
  weekly_budget_override: string;
  category_id: number | null;
  category_name: string | null;
  weekly_budget_default: number | null;
}

interface PeriodTransactionRow {
  transaction_id: number | null;
  transaction_key: string;
  amount_cents: number;
  currency: string;
  booking_date: string;
  counterparty_name: string | null;
  category_id: number | null;
  category_name: string | null;
  weekly_budget_override: WeeklyBudgetOverride;
  decision_source: 'transaction_override' | 'category_default';
}

interface SuggestionRow {
  id: number;
  revision: number;
  status: string;
  matched_transaction_id: number | null;
  matched_source_transaction_id: number | null;
  matched_target_transaction_id: number | null;
}

export class WeeklyBudgetRevisionNotFoundError extends Error {}
export class WeeklyBudgetRevisionConflictError extends Error {}

export interface WeeklyBudgetRevisionResult {
  periodId: number;
  suggestionId: number;
  revision: number;
  directExpenseCents: number;
  transferAmountCents: number;
  status: 'proposed' | 'no_transfer';
}

/**
 * Runs lifecycle work after transactions have been imported. It intentionally
 * changes only lifecycle rows: completed transfer matches and explicitly
 * reviewable late candidates never rewrite a finalized calculation.
 */
export function reconcileWeeklyBudgetLifecycle(
  database: DatabaseSync,
  configId: number,
  now = new Date()
): { lateCandidateCount: number } {
  matchWeeklyBudgetTransfers(database, configId, now);
  return { lateCandidateCount: recordLateWeeklyBudgetCandidates(database, configId, now) };
}

export function recordLateWeeklyBudgetCandidates(
  database: DatabaseSync,
  configId: number,
  now = new Date()
): number {
  if (!Number.isSafeInteger(configId) || configId < 1) {
    throw new Error('Weekly-budget configuration ID is invalid.');
  }
  if (Number.isNaN(now.getTime())) throw new Error('Late-candidate time is invalid.');

  const periods = database.prepare(`
    SELECT id, config_id, period_key, period_start_date, period_end_date,
           source_account_id, source_account_name, target_account_id,
           target_account_name, target_amount_cents, target_balance_cents,
           currency, calculation_version, purpose_prefix,
           target_beneficiary_name, target_iban_encrypted
    FROM weekly_budget_periods
    WHERE config_id = ? AND status = 'finalized'
    ORDER BY id
  `).all(configId) as unknown as PeriodRow[];
  const selectCandidates = database.prepare(`
    SELECT transactions.id, transactions.provider_transaction_id,
           transactions.booking_date, transactions.value_date,
           transactions.transaction_date, transactions.amount_cents,
           transactions.currency, transactions.direction, transactions.status,
           counterparties.counterparty_id, transactions.counterparty_name,
           transactions.weekly_budget_override,
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
  `);
  const existingSnapshot = database.prepare(`
    SELECT 1
    FROM weekly_budget_period_transactions
    WHERE period_id = ?
      AND (transaction_id = ? OR transaction_key = ?)
    LIMIT 1
  `);
  const latestRevision = database.prepare(`
    SELECT MAX(revision) AS revision
    FROM transfer_suggestions
    WHERE period_id = ?
  `);
  const matchedTransaction = database.prepare(`
    SELECT 1
    FROM transfer_suggestions
    WHERE period_id = ?
      AND (? IN (matched_transaction_id, matched_source_transaction_id, matched_target_transaction_id))
    LIMIT 1
  `);
  const insertCandidate = database.prepare(`
    INSERT OR IGNORE INTO weekly_budget_period_transactions (
      period_id, transaction_id, transaction_key, revision, state,
      amount_cents, currency, booking_date, counterparty_name,
      category_id, category_name, weekly_budget_override,
      decision_source, created_at
    ) VALUES (?, ?, ?, ?, 'late_candidate', ?, 'EUR', ?, ?, ?, ?, ?, ?, ?)
  `);
  const encryption = createEncryptionService();
  const timestamp = now.toISOString();
  let inserted = 0;

  for (const period of periods) {
    const latest = latestRevision.get(period.id) as { revision: number | null } | undefined;
    const revision = Number(latest?.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) continue;
    const internalCounterpartyId = encryptedCounterpartyId(encryption, period.target_iban_encrypted);
    // Without the period's target-account identity an internal transfer cannot
    // safely be distinguished from a direct expense.
    if (!internalCounterpartyId) continue;
    const rows = selectCandidates.all(
      period.source_account_id,
      period.period_start_date,
      period.period_end_date
    ) as unknown as CandidateTransactionRow[];
    for (const row of rows) {
      if (existingSnapshot.get(period.id, row.id, row.provider_transaction_id)) continue;
      if (matchedTransaction.get(period.id, row.id)) continue;
      if (!isDirectExpenseRow(row)) continue;
      const evaluation = evaluateDirectExpense({
        accountId: period.source_account_id,
        sourceAccountId: period.source_account_id,
        direction: row.direction,
        status: row.status,
        currency: row.currency,
        amountCents: row.amount_cents,
        bookingDate: row.booking_date,
        valueDate: row.value_date,
        transactionDate: row.transaction_date,
        transactionOverride: row.weekly_budget_override as WeeklyBudgetOverride,
        categoryDefault: row.weekly_budget_default === 1,
        isInternalTransfer: row.counterparty_id === internalCounterpartyId,
        isRefillTransfer: false,
        periodStartDate: period.period_start_date,
        periodEndDate: period.period_end_date
      });
      if (!evaluation.included || !evaluation.effectiveDate) continue;
      if (
        evaluation.decision.source !== 'transaction_override'
        && evaluation.decision.source !== 'category_default'
      ) continue;
      const result = insertCandidate.run(
        period.id,
        row.id,
        row.provider_transaction_id,
        revision,
        evaluation.amountCents,
        evaluation.effectiveDate,
        row.counterparty_name,
        row.category_id,
        row.category_name,
        row.weekly_budget_override,
        evaluation.decision.source,
        timestamp
      );
      inserted += Number(result.changes);
    }
  }
  return inserted;
}

export function recalculateWeeklyBudgetPeriod(
  database: DatabaseSync,
  yuvomiUserId: number,
  periodId: number,
  now = new Date()
): WeeklyBudgetRevisionResult {
  if (!Number.isSafeInteger(periodId) || periodId < 1) {
    throw new WeeklyBudgetRevisionNotFoundError('Weekly-budget period was not found.');
  }
  if (Number.isNaN(now.getTime())) throw new Error('Weekly-budget revision time is invalid.');

  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;
    const period = loadOwnedPeriod(database, yuvomiUserId, periodId);
    const latest = loadLatestSuggestion(database, periodId);
    assertRevisionIsAllowed(latest);
    const pendingCandidates = loadPeriodTransactions(database, periodId, latest.revision, 'late_candidate');
    if (pendingCandidates.length === 0) {
      throw new WeeklyBudgetRevisionConflictError('No late candidate is waiting for recalculation.');
    }
    const included = loadPeriodTransactions(database, periodId, latest.revision, 'included');
    const revisedExpenses = [...included, ...pendingCandidates];
    const directExpenseCents = sumExpenses(revisedExpenses);
    const targetBalanceCents = integerValue(period.target_balance_cents, 'Period target balance');
    const calculation = calculateWeeklyBudgetTransfer({
      targetAmountCents: integerValue(period.target_amount_cents, 'Period weekly target'),
      directExpenseCents,
      targetBalanceCents
    });
    const purpose = buildWeeklyBudgetTransferPurpose({
      cutoffDate: period.period_end_date,
      targetAmountCents: calculation.targetAmountCents,
      directExpenseCents: calculation.directExpenseCents,
      targetBalanceCents: calculation.targetBalanceCents,
      transferAmountCents: calculation.transferAmountCents,
      prefix: period.purpose_prefix ?? 'WB'
    });
    const payloadSha256 = payloadFingerprint(period, calculation.transferAmountCents, purpose);
    const revision = latest.revision + 1;
    const timestamp = now.toISOString();
    const updated = database.prepare(`
      UPDATE transfer_suggestions SET status = 'superseded', updated_at = ?
      WHERE id = ?
        AND status NOT IN ('dismissed', 'superseded', 'failed')
        AND matched_source_transaction_id IS NULL
        AND matched_target_transaction_id IS NULL
        AND matched_transaction_id IS NULL
    `).run(timestamp, latest.id);
    if (Number(updated.changes) !== 1) {
      throw new WeeklyBudgetRevisionConflictError('The transfer suggestion can no longer be recalculated.');
    }
    const suggestionStatus = calculation.transferAmountCents === 0 ? 'no_transfer' : 'proposed';
    const suggestionInsert = database.prepare(`
      INSERT INTO transfer_suggestions (
        period_id, revision, source_account_id, target_account_id,
        target_amount_cents, target_balance_cents, computed_amount_cents,
        deducted_amount_cents, raw_computed_amount_cents, overfunded_cents,
        week_start, week_end, purpose, calculation_version, status,
        payload_sha256, generated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      periodId,
      revision,
      period.source_account_id,
      period.target_account_id,
      calculation.targetAmountCents,
      calculation.targetBalanceCents,
      calculation.transferAmountCents,
      calculation.directExpenseCents,
      calculation.rawComputedAmountCents,
      calculation.overfundedCents,
      period.period_start_date,
      period.period_end_date,
      purpose,
      calculation.calculationVersion,
      suggestionStatus,
      payloadSha256,
      timestamp,
      timestamp,
      timestamp
    );
    const suggestionId = Number(suggestionInsert.lastInsertRowid);
    enqueueWeeklyBudgetProposalDeliveries(database, {
      configId: period.config_id,
      periodKey: period.period_key,
      suggestionId,
      revision,
      targetAmountCents: calculation.targetAmountCents,
      directExpenseCents: calculation.directExpenseCents,
      targetBalanceCents: calculation.targetBalanceCents,
      transferAmountCents: calculation.transferAmountCents,
      now
    });
    const insertSnapshot = database.prepare(`
      INSERT INTO weekly_budget_period_transactions (
        period_id, transaction_id, transaction_key, revision, state,
        amount_cents, currency, booking_date, counterparty_name,
        category_id, category_name, weekly_budget_override,
        decision_source, created_at
      ) VALUES (?, ?, ?, ?, 'included', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const expense of revisedExpenses) {
      insertSnapshot.run(
        periodId,
        expense.transaction_id,
        expense.transaction_key,
        revision,
        expense.amount_cents,
        expense.currency,
        expense.booking_date,
        expense.counterparty_name,
        expense.category_id,
        expense.category_name,
        expense.weekly_budget_override,
        expense.decision_source,
        timestamp
      );
    }
    database.exec('COMMIT;');
    transactionOpen = false;
    return {
      periodId,
      suggestionId,
      revision,
      directExpenseCents,
      transferAmountCents: calculation.transferAmountCents,
      status: suggestionStatus
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  }
}

export function dismissWeeklyBudgetSuggestion(
  database: DatabaseSync,
  yuvomiUserId: number,
  suggestionId: number,
  now = new Date()
): { suggestionId: number; status: 'dismissed' } {
  if (!Number.isSafeInteger(suggestionId) || suggestionId < 1) {
    throw new WeeklyBudgetRevisionNotFoundError('Transfer suggestion was not found.');
  }
  if (Number.isNaN(now.getTime())) throw new Error('Transfer-suggestion dismissal time is invalid.');
  const suggestion = database.prepare(`
    SELECT transfer_suggestions.id, transfer_suggestions.period_id,
           transfer_suggestions.revision, transfer_suggestions.status,
           transfer_suggestions.matched_transaction_id,
           transfer_suggestions.matched_source_transaction_id,
           transfer_suggestions.matched_target_transaction_id
    FROM transfer_suggestions
    JOIN weekly_budget_periods ON weekly_budget_periods.id = transfer_suggestions.period_id
    JOIN weekly_budget_configs ON weekly_budget_configs.id = weekly_budget_periods.config_id
    WHERE transfer_suggestions.id = ? AND weekly_budget_configs.yuvomi_user_id = ?
    LIMIT 1
  `).get(suggestionId, yuvomiUserId) as SuggestionRow & { period_id: number } | undefined;
  if (!suggestion) {
    throw new WeeklyBudgetRevisionNotFoundError('Transfer suggestion was not found.');
  }
  const latest = loadLatestSuggestion(database, Number(suggestion.period_id));
  if (latest.id !== suggestionId) {
    throw new WeeklyBudgetRevisionConflictError('Only the active transfer suggestion can be dismissed.');
  }
  assertRevisionIsAllowed(suggestion);
  if (suggestion.status === 'no_transfer') {
    throw new WeeklyBudgetRevisionConflictError('A zero transfer cannot be dismissed.');
  }
  const result = database.prepare(`
    UPDATE transfer_suggestions SET status = 'dismissed', updated_at = ?
    WHERE id = ?
      AND status IN ('proposed', 'shown', 'notified')
      AND matched_source_transaction_id IS NULL
      AND matched_target_transaction_id IS NULL
      AND matched_transaction_id IS NULL
  `).run(now.toISOString(), suggestionId);
  if (Number(result.changes) !== 1) {
    throw new WeeklyBudgetRevisionConflictError('The transfer suggestion can no longer be dismissed.');
  }
  return { suggestionId, status: 'dismissed' };
}

function loadOwnedPeriod(
  database: DatabaseSync,
  yuvomiUserId: number,
  periodId: number
): PeriodRow {
  const period = database.prepare(`
    SELECT weekly_budget_periods.id, weekly_budget_periods.config_id,
           weekly_budget_periods.period_key, weekly_budget_periods.period_start_date,
           weekly_budget_periods.period_end_date, weekly_budget_periods.source_account_id,
           weekly_budget_periods.source_account_name, weekly_budget_periods.target_account_id,
           weekly_budget_periods.target_account_name, weekly_budget_periods.target_amount_cents,
           weekly_budget_periods.target_balance_cents, weekly_budget_periods.currency,
           weekly_budget_periods.calculation_version, weekly_budget_periods.purpose_prefix,
           weekly_budget_periods.target_beneficiary_name,
           weekly_budget_periods.target_iban_encrypted
    FROM weekly_budget_periods
    JOIN weekly_budget_configs ON weekly_budget_configs.id = weekly_budget_periods.config_id
    WHERE weekly_budget_periods.id = ?
      AND weekly_budget_configs.yuvomi_user_id = ?
      AND weekly_budget_periods.status = 'finalized'
    LIMIT 1
  `).get(periodId, yuvomiUserId) as PeriodRow | undefined;
  if (!period) throw new WeeklyBudgetRevisionNotFoundError('Weekly-budget period was not found.');
  return period;
}

function loadLatestSuggestion(database: DatabaseSync, periodId: number): SuggestionRow {
  const suggestion = database.prepare(`
    SELECT id, revision, status, matched_source_transaction_id,
           matched_target_transaction_id, matched_transaction_id
    FROM transfer_suggestions
    WHERE period_id = ?
    ORDER BY revision DESC
    LIMIT 1
  `).get(periodId) as SuggestionRow | undefined;
  if (!suggestion) {
    throw new WeeklyBudgetRevisionConflictError('The period has no transfer suggestion.');
  }
  return suggestion;
}

function loadPeriodTransactions(
  database: DatabaseSync,
  periodId: number,
  revision: number,
  state: 'included' | 'late_candidate'
): PeriodTransactionRow[] {
  return database.prepare(`
    SELECT transaction_id, transaction_key, amount_cents, currency, booking_date,
           counterparty_name, category_id, category_name, weekly_budget_override,
           decision_source
    FROM weekly_budget_period_transactions
    WHERE period_id = ? AND revision = ? AND state = ?
    ORDER BY booking_date, id
  `).all(periodId, revision, state) as unknown as PeriodTransactionRow[];
}

function assertRevisionIsAllowed(suggestion: SuggestionRow): void {
  if (
    suggestion.matched_transaction_id
    || suggestion.matched_source_transaction_id
    || suggestion.matched_target_transaction_id
  ) {
    throw new WeeklyBudgetRevisionConflictError(
      'A transfer has already been detected for this suggestion.'
    );
  }
  if (['dismissed', 'superseded', 'failed'].includes(suggestion.status)) {
    throw new WeeklyBudgetRevisionConflictError('The transfer suggestion is no longer active.');
  }
}

function isDirectExpenseRow(
  row: CandidateTransactionRow
): row is CandidateTransactionRow & {
  direction: 'incoming' | 'outgoing';
  status: 'PDNG' | 'BOOK' | 'UNKNOWN';
  weekly_budget_override: WeeklyBudgetOverride;
} {
  return (
    (row.direction === 'incoming' || row.direction === 'outgoing')
    && (row.status === 'PDNG' || row.status === 'BOOK' || row.status === 'UNKNOWN')
    && (row.weekly_budget_override === 'inherit'
      || row.weekly_budget_override === 'include'
      || row.weekly_budget_override === 'exclude')
  );
}

function encryptedCounterpartyId(
  encryption: ReturnType<typeof createEncryptionService>,
  encryptedIban: string | null
): string | null {
  if (!encryptedIban) return null;
  try {
    return counterpartyId(encryption.decrypt(encryptedIban), config.secrets.counterpartyHmac);
  } catch {
    return null;
  }
}

function payloadFingerprint(period: PeriodRow, amountCents: number, purpose: string): string | null {
  if (amountCents === 0) return null;
  if (!period.target_iban_encrypted) {
    throw new WeeklyBudgetRevisionConflictError('Target-account IBAN snapshot is unavailable.');
  }
  const beneficiaryName = period.target_beneficiary_name ?? period.target_account_name ?? '';
  try {
    const iban = createEncryptionService().decrypt(period.target_iban_encrypted);
    return giroCodePayloadSha256(buildEpcQrPayload({
      beneficiaryName,
      iban,
      amountCents,
      remittance: purpose
    }));
  } catch {
    throw new WeeklyBudgetRevisionConflictError('A GiroCode cannot be generated for this revision.');
  }
}

function sumExpenses(expenses: PeriodTransactionRow[]): number {
  let total = 0n;
  for (const expense of expenses) total += BigInt(expense.amount_cents);
  const result = Number(total);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new WeeklyBudgetRevisionConflictError('Revised direct expenses are invalid.');
  }
  return result;
}

function integerValue(value: number | null, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new WeeklyBudgetRevisionConflictError(`${label} is unavailable.`);
  }
  return Number(value);
}
