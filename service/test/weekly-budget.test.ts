import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDatabase } from '../src/db/database.js';
import {
  buildWeeklyBudgetTransferPurpose,
  calculateWeeklyBudgetTransfer,
  evaluateDirectExpense,
  formatEuroCents,
  resolveWeeklyBudgetDecision,
  selectEffectiveTransactionDate,
  type DirectExpenseCandidate
} from '../src/services/weekly-budget.js';

test('weekly-budget migrations add settings, overrides, history, and revisions', () => {
  const database = new DatabaseSync(':memory:');
  assert.deepEqual(migrateDatabase(database), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

  const categoryColumns = database.prepare('PRAGMA table_info(categories)').all() as Array<{
    name: string;
    dflt_value: string | null;
  }>;
  assert.equal(
    categoryColumns.find((column) => column.name === 'weekly_budget_default')?.dflt_value,
    '0'
  );
  const transactionColumns = database.prepare('PRAGMA table_info(transactions)').all() as Array<{
    name: string;
    dflt_value: string | null;
  }>;
  assert.equal(
    transactionColumns.find((column) => column.name === 'weekly_budget_override')?.dflt_value,
    "'inherit'"
  );
  const configColumns = new Set((database.prepare(
    'PRAGMA table_info(weekly_budget_configs)'
  ).all() as Array<{ name: string }>).map((row) => row.name));
  assert.ok(configColumns.has('target_beneficiary_name'));
  assert.ok(configColumns.has('effective_from_at'));

  const expectedTables = [
    'weekly_budget_configs',
    'account_balance_snapshots',
    'weekly_budget_periods',
    'weekly_budget_period_transactions',
    'weekly_budget_job_runs',
    'scheduled_account_sync_runs',
    'ai_categorization_reviews'
  ];
  const tableNames = new Set((database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all() as Array<{ name: string }>).map((row) => row.name));
  for (const tableName of expectedTables) assert.ok(tableNames.has(tableName));

  const periodColumns = new Set((database.prepare(
    'PRAGMA table_info(weekly_budget_periods)'
  ).all() as Array<{ name: string }>).map((row) => row.name));
  for (const column of [
    'cutoff_weekday',
    'cutoff_time',
    'timezone',
    'purpose_prefix',
    'target_beneficiary_name',
    'target_iban_encrypted'
  ]) {
    assert.ok(periodColumns.has(column), `Missing weekly_budget_periods.${column}`);
  }

  const suggestionColumns = new Set((database.prepare(
    'PRAGMA table_info(transfer_suggestions)'
  ).all() as Array<{ name: string }>).map((row) => row.name));
  for (const column of [
    'period_id',
    'revision',
    'target_balance_cents',
    'raw_computed_amount_cents',
    'overfunded_cents',
    'payload_sha256',
    'calculation_version',
    'matched_source_transaction_id',
    'matched_target_transaction_id',
    'generated_at',
    'completed_at'
  ]) assert.ok(suggestionColumns.has(column), `Missing transfer_suggestions.${column}`);

  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
});

test('weekly-budget migrations preserve legacy transfer suggestions', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  for (const [version, filename] of [
    [1, '001_init.sql'],
    [2, '002_phase2_indexes.sql'],
    [3, '003_enable_banking_flow.sql'],
    [4, '004_account_identity_and_consent_state.sql'],
    [5, '005_integer_money_and_transaction_keys.sql'],
    [6, '006_consent_validity_and_transaction_status.sql']
  ] as const) {
    database.exec(readFileSync(join(process.cwd(), 'migrations', filename), 'utf8'));
    database.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
    ).run(version, '2026-01-01T00:00:00.000Z');
  }

  database.prepare(`
    INSERT INTO enable_banking_connections (yuvomi_user_id, status, created_at, updated_at)
    VALUES (1, 'authorized', '2026-01-01', '2026-01-01')
  `).run();
  database.prepare(`
    INSERT INTO bank_accounts (connection_id, provider_account_id, created_at, updated_at)
    VALUES (1, 'legacy-account', '2026-01-01', '2026-01-01')
  `).run();
  database.prepare(`
    INSERT INTO transfer_suggestions (
      source_account_id, target_account_id, target_amount_cents,
      computed_amount_cents, deducted_amount_cents, week_start, week_end,
      purpose, status, created_at, updated_at
    ) VALUES (1, 1, 45000, 32000, 3000, '2026-09-07', '2026-09-14',
              'legacy-like', 'proposed', '2026-09-14', '2026-09-14')
  `).run();

  assert.deepEqual(migrateDatabase(database), [7, 8, 9, 10, 11]);
  const preservedSuggestion = database.prepare(`
    SELECT source_account_id, target_account_id, period_id, calculation_version
    FROM transfer_suggestions
  `).get() as Record<string, unknown>;
  assert.deepEqual({ ...preservedSuggestion }, {
    source_account_id: 1,
    target_account_id: 1,
    period_id: null,
    calculation_version: 'legacy-v1'
  });
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
});

test('transaction override takes priority over the category default', () => {
  assert.deepEqual(resolveWeeklyBudgetDecision('include', false), {
    included: true,
    source: 'transaction_override'
  });
  assert.deepEqual(resolveWeeklyBudgetDecision('exclude', true), {
    included: false,
    source: 'transaction_override'
  });
  assert.deepEqual(resolveWeeklyBudgetDecision('inherit', true), {
    included: true,
    source: 'category_default'
  });
  assert.deepEqual(resolveWeeklyBudgetDecision('inherit', false), {
    included: false,
    source: 'none'
  });
  assert.deepEqual(resolveWeeklyBudgetDecision('inherit', null), {
    included: false,
    source: 'none'
  });
});

const validExpense: DirectExpenseCandidate = {
  accountId: 10,
  sourceAccountId: 10,
  direction: 'outgoing',
  status: 'BOOK',
  currency: 'EUR',
  amountCents: 3000,
  bookingDate: '2026-09-10',
  transactionOverride: 'inherit',
  categoryDefault: true,
  periodStartDate: '2026-09-07',
  periodEndDate: '2026-09-14'
};

test('eligible Sparkasse expense is included with a positive cent magnitude', () => {
  assert.deepEqual(evaluateDirectExpense({ ...validExpense, amountCents: -3000 }), {
    included: true,
    amountCents: 3000,
    effectiveDate: '2026-09-10',
    decision: { included: true, source: 'category_default' },
    exclusionReason: null
  });
});

test('technical exclusions beat weekly-budget membership', () => {
  const cases: Array<[Partial<DirectExpenseCandidate>, string]> = [
    [{ accountId: 11 }, 'wrong_account'],
    [{ direction: 'incoming' }, 'not_outgoing'],
    [{ status: 'PDNG' }, 'not_booked'],
    [{ currency: 'USD' }, 'not_eur'],
    [{ isInternalTransfer: true }, 'internal_transfer'],
    [{ isRefillTransfer: true }, 'refill_transfer'],
    [{ transactionOverride: 'exclude' }, 'not_weekly_budget'],
    [{ bookingDate: null }, 'missing_date'],
    [{ bookingDate: '2026-09-14' }, 'outside_period']
  ];

  for (const [change, exclusionReason] of cases) {
    const result = evaluateDirectExpense({ ...validExpense, ...change });
    assert.equal(result.included, false);
    assert.equal(result.exclusionReason, exclusionReason);
  }
});

test('effective transaction date uses booking, then value, then transaction date', () => {
  assert.equal(selectEffectiveTransactionDate({
    bookingDate: '2026-09-10',
    valueDate: '2026-09-09',
    transactionDate: '2026-09-08'
  }), '2026-09-10');
  assert.equal(selectEffectiveTransactionDate({
    valueDate: '2026-09-09',
    transactionDate: '2026-09-08'
  }), '2026-09-09');
  assert.equal(selectEffectiveTransactionDate({ transactionDate: '2026-09-08' }), '2026-09-08');
  assert.equal(selectEffectiveTransactionDate({}), null);
  assert.throws(
    () => selectEffectiveTransactionDate({ bookingDate: '2026-02-30' }),
    /valid calendar date/
  );
});

test('calculates 450 EUR minus 30 EUR direct expenses minus 100 EUR balance', () => {
  assert.deepEqual(calculateWeeklyBudgetTransfer({
    targetAmountCents: 45000,
    directExpenseCents: 3000,
    targetBalanceCents: 10000
  }), {
    targetAmountCents: 45000,
    directExpenseCents: 3000,
    targetBalanceCents: 10000,
    rawComputedAmountCents: 32000,
    transferAmountCents: 32000,
    overfundedCents: 0,
    calculationVersion: 'weekly-budget-v1'
  });
});

test('clamps an overfunded account to zero and records the overfunding', () => {
  assert.deepEqual(calculateWeeklyBudgetTransfer({
    targetAmountCents: 45000,
    directExpenseCents: 0,
    targetBalanceCents: 50000
  }), {
    targetAmountCents: 45000,
    directExpenseCents: 0,
    targetBalanceCents: 50000,
    rawComputedAmountCents: -5000,
    transferAmountCents: 0,
    overfundedCents: 5000,
    calculationVersion: 'weekly-budget-v1'
  });
});

test('negative N26 balance increases the transfer amount', () => {
  const calculation = calculateWeeklyBudgetTransfer({
    targetAmountCents: 45000,
    directExpenseCents: 3000,
    targetBalanceCents: -2000
  });
  assert.equal(calculation.rawComputedAmountCents, 44000);
  assert.equal(calculation.transferAmountCents, 44000);
});

test('builds the canonical auditable transfer purpose', () => {
  assert.equal(buildWeeklyBudgetTransferPurpose({
    cutoffDate: '2026-09-14',
    targetAmountCents: 45000,
    directExpenseCents: 3000,
    targetBalanceCents: 10000,
    transferAmountCents: 32000
  }), 'WB 2026-09-14: 450,00 - 30,00 Direkt - 100,00 N26 = 320,00 EUR');
  assert.equal(buildWeeklyBudgetTransferPurpose({
    cutoffDate: '2026-09-14',
    targetAmountCents: 45000,
    directExpenseCents: 3000,
    targetBalanceCents: -2000,
    transferAmountCents: 44000
  }), 'WB 2026-09-14: 450,00 - 30,00 Direkt - (-20,00 N26) = 440,00 EUR');
  assert.equal(formatEuroCents(-1), '-0,01');
  assert.throws(() => buildWeeklyBudgetTransferPurpose({
    cutoffDate: '2026-09-14',
    targetAmountCents: 45000,
    directExpenseCents: 3000,
    targetBalanceCents: 10000,
    transferAmountCents: 31999
  }), /does not match/);
});
