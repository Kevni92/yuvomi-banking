import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';
import { createEncryptionService } from '../src/security/encryption.js';
import { GiroCodeUnavailableError, loadWeeklyBudgetGiroCode } from '../src/services/girocode.js';
import {
  WeeklyBudgetRevisionConflictError,
  dismissWeeklyBudgetSuggestion,
  recalculateWeeklyBudgetPeriod,
  recordLateWeeklyBudgetCandidates
} from '../src/services/weekly-budget-revisions.js';

const TEST_KEY = 'ac'.repeat(32);
const TEST_HMAC = 'weekly-budget-revision-hmac';
const NOW = new Date('2026-09-15T10:00:00.000Z');
const SOURCE_IBAN = 'DE12500105170648489890';
const TARGET_IBAN = 'DE89370400440532013000';
const PURPOSE = 'WB 2026-09-14: 450,00 - 30,00 Direkt - 100,00 Budget = 320,00 EUR';

function fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const encryption = createEncryptionService(TEST_KEY);
  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (7, 'authorized', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, display_name, iban_encrypted,
      currency, created_at, updated_at
    ) VALUES
      (1, 'source', 'Main Current Account', ?, 'EUR', ?, ?),
      (1, 'target', 'Weekly Budget Account', ?, 'EUR', ?, ?)
  `).run(
    encryption.encrypt(SOURCE_IBAN), NOW.toISOString(), NOW.toISOString(),
    encryption.encrypt(TARGET_IBAN), NOW.toISOString(), NOW.toISOString()
  );
  database.prepare(`
    INSERT INTO categories (
      name, type, weekly_budget_default, created_at, updated_at
    ) VALUES ('Lebensmittel', 'expense', 1, ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO weekly_budget_configs (
      yuvomi_user_id, enabled, source_account_id, target_account_id,
      target_amount_cents, currency, cutoff_weekday, cutoff_time, timezone,
      effective_from_date, target_beneficiary_name, created_at, updated_at
    ) VALUES (7, 1, 1, 2, 45000, 'EUR', 7, '18:30', 'Europe/Berlin',
              '2026-09-07', 'Weekly Budget User', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO weekly_budget_periods (
      config_id, period_key, period_start_date, period_end_date,
      scheduled_cutoff_at, finalized_at, trigger, status,
      source_account_id, source_account_name, target_account_id,
      target_account_name, target_amount_cents, currency,
      target_balance_cents, direct_expense_cents, raw_computed_amount_cents,
      computed_amount_cents, overfunded_cents, calculation_version,
      cutoff_weekday, cutoff_time, timezone, purpose_prefix,
      target_beneficiary_name, target_iban_encrypted, created_at, updated_at
    ) VALUES (
      1, 'weekly-budget:1:2026-09-14T16:30:00.000Z',
      '2026-09-07', '2026-09-14', '2026-09-14T16:30:00.000Z',
      '2026-09-14T16:31:00.000Z', 'scheduled', 'finalized',
      1, 'Main Current Account', 2, 'Weekly Budget Account', 45000, 'EUR', 10000, 3000, 32000,
      32000, 0, 'weekly-budget-v1', 7, '18:30', 'Europe/Berlin', 'WB',
      'Weekly Budget User', ?, ?, ?
    )
  `).run(encryption.encrypt(TARGET_IBAN), NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, booking_date, amount_cents,
      currency, direction, counterparty_name, category_id,
      weekly_budget_override, status, created_at, updated_at
    ) VALUES (1, 'original-lidl', '2026-09-10', 3000, 'EUR', 'outgoing',
              'LIDL', 1, 'inherit', 'BOOK', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO weekly_budget_period_transactions (
      period_id, transaction_id, transaction_key, revision, state,
      amount_cents, currency, booking_date, counterparty_name,
      category_id, category_name, weekly_budget_override,
      decision_source, created_at
    ) VALUES (1, 1, 'original-lidl', 1, 'included', 3000, 'EUR',
              '2026-09-10', 'LIDL', 1, 'Lebensmittel', 'inherit',
              'category_default', ?)
  `).run(NOW.toISOString());
  database.prepare(`
    INSERT INTO transfer_suggestions (
      period_id, revision, source_account_id, target_account_id,
      target_amount_cents, target_balance_cents, computed_amount_cents,
      deducted_amount_cents, raw_computed_amount_cents, overfunded_cents,
      week_start, week_end, purpose, calculation_version, status,
      generated_at, created_at, updated_at
    ) VALUES (1, 1, 1, 2, 45000, 10000, 32000, 3000, 32000, 0,
              '2026-09-07', '2026-09-14', ?, 'weekly-budget-v1', 'proposed',
              '2026-09-14T16:31:00.000Z', ?, ?)
  `).run(PURPOSE, NOW.toISOString(), NOW.toISOString());
  return database;
}

function insertLateExpense(database: DatabaseSync): void {
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, booking_date, amount_cents,
      currency, direction, counterparty_name, category_id,
      weekly_budget_override, status, created_at, updated_at
    ) VALUES (1, 'late-bakery', '2026-09-12', 1000, 'EUR', 'outgoing',
              'Bakery', 1, 'inherit', 'BOOK', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
}

test('snapshots a late direct expense and creates an immutable replacement revision', () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = fixture();
  try {
    insertLateExpense(database);
    assert.equal(recordLateWeeklyBudgetCandidates(database, 1, NOW), 1);
    assert.deepEqual({ ...(database.prepare(`
      SELECT transaction_id, revision, state, amount_cents, decision_source
      FROM weekly_budget_period_transactions
      WHERE transaction_key = 'late-bakery'
    `).get() as Record<string, unknown>) }, {
      transaction_id: 2,
      revision: 1,
      state: 'late_candidate',
      amount_cents: 1000,
      decision_source: 'category_default'
    });
    assert.equal(recordLateWeeklyBudgetCandidates(database, 1, NOW), 0);

    const result = recalculateWeeklyBudgetPeriod(database, 7, 1, NOW);
    assert.deepEqual(result, {
      periodId: 1,
      suggestionId: 2,
      revision: 2,
      directExpenseCents: 4000,
      transferAmountCents: 31000,
      status: 'proposed'
    });
    assert.deepEqual({ ...(database.prepare(`
      SELECT direct_expense_cents, computed_amount_cents
      FROM weekly_budget_periods WHERE id = 1
    `).get() as Record<string, unknown>) }, {
      direct_expense_cents: 3000,
      computed_amount_cents: 32000
    });
    assert.deepEqual(
      database.prepare(`
        SELECT revision, status, deducted_amount_cents, computed_amount_cents
        FROM transfer_suggestions ORDER BY revision
      `).all().map((row) => ({ ...row })),
      [
        { revision: 1, status: 'superseded', deducted_amount_cents: 3000, computed_amount_cents: 32000 },
        { revision: 2, status: 'proposed', deducted_amount_cents: 4000, computed_amount_cents: 31000 }
      ]
    );
    assert.deepEqual(
      database.prepare(`
        SELECT transaction_key, state FROM weekly_budget_period_transactions
        WHERE revision = 2 ORDER BY transaction_key
      `).all().map((row) => ({ ...row })),
      [
        { transaction_key: 'late-bakery', state: 'included' },
        { transaction_key: 'original-lidl', state: 'included' }
      ]
    );
    assert.throws(
      () => loadWeeklyBudgetGiroCode(database, 7, 1),
      GiroCodeUnavailableError
    );
    assert.equal(loadWeeklyBudgetGiroCode(database, 7, 2).amountCents, 31000);
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});

test('does not revise or dismiss a proposal once a transfer booking was detected', () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = fixture();
  try {
    insertLateExpense(database);
    recordLateWeeklyBudgetCandidates(database, 1, NOW);
    database.prepare(`
      UPDATE transfer_suggestions SET matched_source_transaction_id = 1
      WHERE id = 1
    `).run();
    assert.throws(
      () => recalculateWeeklyBudgetPeriod(database, 7, 1, NOW),
      WeeklyBudgetRevisionConflictError
    );
    assert.throws(
      () => dismissWeeklyBudgetSuggestion(database, 7, 1, NOW),
      WeeklyBudgetRevisionConflictError
    );
    assert.equal(database.prepare(
      'SELECT status FROM transfer_suggestions WHERE id = 1'
    ).get()?.status, 'proposed');
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});

test('dismisses only the active unmatched transfer suggestion', () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = fixture();
  try {
    assert.deepEqual(dismissWeeklyBudgetSuggestion(database, 7, 1, NOW), {
      suggestionId: 1,
      status: 'dismissed'
    });
    assert.throws(
      () => loadWeeklyBudgetGiroCode(database, 7, 1),
      GiroCodeUnavailableError
    );
    assert.throws(
      () => dismissWeeklyBudgetSuggestion(database, 7, 1, NOW),
      WeeklyBudgetRevisionConflictError
    );
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});
