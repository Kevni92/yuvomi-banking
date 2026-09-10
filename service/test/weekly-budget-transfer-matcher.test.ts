import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';
import { createEncryptionService } from '../src/security/encryption.js';
import { counterpartyId } from '../src/services/counterparty.js';
import { matchWeeklyBudgetTransfers } from '../src/services/weekly-budget-transfer-matcher.js';

const TEST_KEY = 'ef'.repeat(32);
const TEST_HMAC = 'weekly-budget-transfer-match-hmac';
const SOURCE_IBAN = 'DE12500105170648489890';
const TARGET_IBAN = 'DE89370400440532013000';
const GENERATED_AT = '2026-09-13T16:31:00.000Z';
const PURPOSE = 'WB 2026-09-13: 450,00 - 30,00 Direkt - 100,00 N26 = 320,00 EUR';

function fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const encryption = createEncryptionService(TEST_KEY);
  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (7, 'authorized', ?, ?)
  `).run(GENERATED_AT, GENERATED_AT);
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, display_name, iban_encrypted,
      currency, created_at, updated_at
    ) VALUES
      (1, 'source', 'Sparkasse', ?, 'EUR', ?, ?),
      (1, 'target', 'N26', ?, 'EUR', ?, ?)
  `).run(
    encryption.encrypt(SOURCE_IBAN), GENERATED_AT, GENERATED_AT,
    encryption.encrypt(TARGET_IBAN), GENERATED_AT, GENERATED_AT
  );
  database.prepare(`
    INSERT INTO counterparties (
      counterparty_id, display_name, iban_encrypted, created_at, updated_at
    ) VALUES
      (?, 'Sparkasse', ?, ?, ?),
      (?, 'N26', ?, ?, ?)
  `).run(
    counterpartyId(SOURCE_IBAN, TEST_HMAC), encryption.encrypt(SOURCE_IBAN), GENERATED_AT, GENERATED_AT,
    counterpartyId(TARGET_IBAN, TEST_HMAC), encryption.encrypt(TARGET_IBAN), GENERATED_AT, GENERATED_AT
  );
  database.prepare(`
    INSERT INTO weekly_budget_configs (
      yuvomi_user_id, enabled, source_account_id, target_account_id,
      target_amount_cents, currency, cutoff_weekday, cutoff_time, timezone,
      effective_from_date, created_at, updated_at
    ) VALUES (7, 1, 1, 2, 45000, 'EUR', 7, '18:30', 'Europe/Berlin',
              '2026-09-06', ?, ?)
  `).run(GENERATED_AT, GENERATED_AT);
  database.prepare(`
    INSERT INTO weekly_budget_periods (
      config_id, period_key, period_start_date, period_end_date,
      scheduled_cutoff_at, finalized_at, trigger, status,
      source_account_id, target_account_id, target_amount_cents,
      target_balance_cents, direct_expense_cents, raw_computed_amount_cents,
      computed_amount_cents, calculation_version, timezone, created_at, updated_at
    ) VALUES (
      1, 'weekly-budget:1:2026-09-13T16:30:00.000Z',
      '2026-09-06', '2026-09-13', '2026-09-13T16:30:00.000Z', ?,
      'scheduled', 'finalized', 1, 2, 45000, 10000, 3000, 32000,
      32000, 'weekly-budget-v1', 'Europe/Berlin', ?, ?
    )
  `).run(GENERATED_AT, GENERATED_AT, GENERATED_AT);
  database.prepare(`
    INSERT INTO transfer_suggestions (
      period_id, revision, source_account_id, target_account_id,
      target_amount_cents, target_balance_cents, computed_amount_cents,
      deducted_amount_cents, raw_computed_amount_cents, week_start, week_end,
      purpose, calculation_version, status, generated_at, created_at, updated_at
    ) VALUES (1, 1, 1, 2, 45000, 10000, 32000, 3000, 32000,
              '2026-09-06', '2026-09-13', ?, 'weekly-budget-v1',
              'proposed', ?, ?, ?)
  `).run(PURPOSE, GENERATED_AT, GENERATED_AT, GENERATED_AT);
  return database;
}

function addTransaction(
  database: DatabaseSync,
  input: {
    key: string;
    accountId: number;
    direction: 'incoming' | 'outgoing';
    counterpartyRef: number;
    purpose?: string;
    amountCents?: number;
    bookingDate?: string;
  }
): void {
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, booking_date, amount_cents,
      currency, direction, counterparty_ref, purpose, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'EUR', ?, ?, ?, 'BOOK', ?, ?)
  `).run(
    input.accountId,
    input.key,
    input.bookingDate ?? '2026-09-14',
    input.amountCents ?? 32000,
    input.direction,
    input.counterpartyRef,
    input.purpose ?? `SEPA transfer ${PURPOSE}`,
    GENERATED_AT,
    GENERATED_AT
  );
}

test('matches unique source and target bookings and completes the suggestion idempotently', () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = fixture();
  try {
    addTransaction(database, {
      key: 'source-booking', accountId: 1, direction: 'outgoing', counterpartyRef: 2
    });
    addTransaction(database, {
      key: 'target-booking', accountId: 2, direction: 'incoming', counterpartyRef: 1
    });
    addTransaction(database, {
      key: 'wrong-purpose', accountId: 1, direction: 'outgoing', counterpartyRef: 2,
      purpose: 'Another transfer'
    });

    const outcomes = matchWeeklyBudgetTransfers(
      database,
      1,
      new Date('2026-09-14T12:00:00.000Z')
    );
    assert.deepEqual(outcomes, [{
      suggestionId: 1,
      source: 'matched',
      target: 'matched',
      state: 'target_arrived'
    }]);
    assert.deepEqual({ ...(database.prepare(`
      SELECT status, matched_source_transaction_id,
             matched_target_transaction_id, completed_at
      FROM transfer_suggestions WHERE id = 1
    `).get() as Record<string, unknown>) }, {
      status: 'completed',
      matched_source_transaction_id: 1,
      matched_target_transaction_id: 2,
      completed_at: '2026-09-14T12:00:00.000Z'
    });
    assert.deepEqual(matchWeeklyBudgetTransfers(database, 1), []);
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});

test('rejects an ambiguous account-side match without guessing', () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = fixture();
  try {
    addTransaction(database, {
      key: 'source-booking-a', accountId: 1, direction: 'outgoing', counterpartyRef: 2
    });
    addTransaction(database, {
      key: 'source-booking-b', accountId: 1, direction: 'outgoing', counterpartyRef: 2
    });

    const outcomes = matchWeeklyBudgetTransfers(database, 1);
    assert.deepEqual(outcomes, [{
      suggestionId: 1,
      source: 'ambiguous',
      target: 'not_found',
      state: 'proposed'
    }]);
    assert.deepEqual({ ...(database.prepare(`
      SELECT status, matched_source_transaction_id, matched_target_transaction_id
      FROM transfer_suggestions WHERE id = 1
    `).get() as Record<string, unknown>) }, {
      status: 'proposed',
      matched_source_transaction_id: null,
      matched_target_transaction_id: null
    });
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});
