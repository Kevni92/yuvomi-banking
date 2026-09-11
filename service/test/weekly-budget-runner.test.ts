import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';
import type { EnableBankingClient } from '../src/enable-banking/client.js';
import { createEncryptionService } from '../src/security/encryption.js';
import { runWeeklyBudgetCutoff } from '../src/services/weekly-budget-runner.js';
import { upsertPushSubscription } from '../src/services/push-subscriptions.js';

const TEST_KEY = 'de'.repeat(32);
const TEST_HMAC = 'weekly-budget-runner-hmac-secret';
const RUN_TIME = new Date('2026-09-13T16:31:00.000Z');
const CUTOFF = new Date('2026-09-13T16:30:00.000Z');

function fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const encryption = createEncryptionService(TEST_KEY);
  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (7, 'authorized', ?, ?)
  `).run(RUN_TIME.toISOString(), RUN_TIME.toISOString());
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, display_name, iban_encrypted,
      currency, account_type, created_at, updated_at
    ) VALUES
      (1, 'sparkasse-provider', 'Sparkasse Girokonto', ?, 'EUR', 'CACC', ?, ?),
      (1, 'n26-provider', 'N26', ?, 'EUR', 'CACC', ?, ?)
  `).run(
    encryption.encrypt('DE12500105170648489890'),
    RUN_TIME.toISOString(),
    RUN_TIME.toISOString(),
    encryption.encrypt('DE89370400440532013000'),
    RUN_TIME.toISOString(),
    RUN_TIME.toISOString()
  );
  database.prepare(`
    INSERT INTO weekly_budget_configs (
      yuvomi_user_id, enabled, source_account_id, target_account_id,
      target_amount_cents, currency, cutoff_weekday, cutoff_time, timezone,
      sync_time_1, sync_time_2, balance_stale_after_minutes,
      notification_enabled, notification_qr_preview, purpose_prefix,
      effective_from_date, target_beneficiary_name, created_at, updated_at
    ) VALUES (7, 1, 1, 2, 45000, 'EUR', 7, '18:30', 'Europe/Berlin',
              '06:00', '18:00', 840, 0, 0, 'WB', '2026-09-06',
              'Weekly Budget User', ?, ?)
  `).run(RUN_TIME.toISOString(), RUN_TIME.toISOString());
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, entry_reference, booking_date,
      amount_cents, currency, direction, counterparty_name,
      weekly_budget_override, status, created_at, updated_at
    ) VALUES
      (1, 'lidl-reference', 'lidl-reference', '2026-09-10', 3000, 'EUR',
       'outgoing', 'LIDL', 'include', 'BOOK', ?, ?),
      (1, 'cutoff-day-reference', 'cutoff-day-reference', '2026-09-13', 500,
       'EUR', 'outgoing', 'Bakery', 'include', 'BOOK', ?, ?)
  `).run(
    RUN_TIME.toISOString(),
    RUN_TIME.toISOString(),
    RUN_TIME.toISOString(),
    RUN_TIME.toISOString()
  );
  return database;
}

function successfulClient(callCounter: { value: number }): EnableBankingClient {
  return {
    getAllAccountTransactions: async (accountId: string) => {
      callCounter.value += 1;
      if (accountId === 'sparkasse-provider') {
        return {
          pages: 1,
          transactions: [{
            status: 'BOOK',
            entry_reference: 'lidl-reference',
            transaction_id: 'lidl-provider-id',
            transaction_amount: { amount: '30.00', currency: 'EUR' },
            credit_debit_indicator: 'DBIT',
            booking_date: '2026-09-10',
            creditor: { name: 'LIDL' },
            creditor_account: { iban: 'DE75512108001245126199' }
          }, {
            status: 'BOOK',
            entry_reference: 'cutoff-day-reference',
            transaction_id: 'cutoff-day-provider-id',
            transaction_amount: { amount: '5.00', currency: 'EUR' },
            credit_debit_indicator: 'DBIT',
            booking_date: '2026-09-13',
            creditor: { name: 'Bakery' }
          }]
        };
      }
      assert.equal(accountId, 'n26-provider');
      return { pages: 1, transactions: [] };
    },
    getAccountBalances: async (accountId: string) => {
      callCounter.value += 1;
      return {
        balances: [{
          balance_amount: {
            amount: accountId === 'n26-provider' ? '100.00' : '2000.00',
            currency: 'EUR'
          },
          balance_type: 'ITAV',
          last_change_date_time: RUN_TIME.toISOString()
        }]
      };
    }
  } as unknown as EnableBankingClient;
}

test('fresh cutoff sync atomically finalizes the 450 - 30 - 100 = 320 period', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = fixture();
  const calls = { value: 0 };

  try {
    const result = await runWeeklyBudgetCutoff({
      database,
      client: successfulClient(calls),
      configId: 1,
      scheduledCutoffAt: CUTOFF,
      trigger: 'scheduled',
      clock: () => RUN_TIME
    });
    assert.equal(result.targetAmountCents, 45000);
    assert.equal(result.targetBalanceCents, 10000);
    assert.equal(result.directExpenseCents, 3000);
    assert.equal(result.transferAmountCents, 32000);
    assert.equal(result.status, 'proposed');
    assert.equal(result.purpose, 'WB 2026-09-13: 450,00 - 30,00 Direkt - 100,00 N26 = 320,00 EUR');
    assert.equal(result.idempotentReplay, false);
    assert.equal(calls.value, 4);

    assert.equal(database.prepare('SELECT count(*) AS count FROM weekly_budget_periods').get()?.count, 1);
    assert.equal(database.prepare('SELECT count(*) AS count FROM transfer_suggestions').get()?.count, 1);
    assert.equal(database.prepare(
      'SELECT count(*) AS count FROM weekly_budget_period_transactions'
    ).get()?.count, 1);
    assert.deepEqual({ ...(database.prepare(`
      SELECT period_start_date, period_end_date, target_balance_cents,
             direct_expense_cents, computed_amount_cents, cutoff_weekday,
             cutoff_time, timezone, target_beneficiary_name,
             target_iban_encrypted
      FROM weekly_budget_periods
    `).get() as Record<string, unknown>) }, {
      period_start_date: '2026-09-06',
      period_end_date: '2026-09-13',
      target_balance_cents: 10000,
      direct_expense_cents: 3000,
      computed_amount_cents: 32000,
      cutoff_weekday: 7,
      cutoff_time: '18:30',
      timezone: 'Europe/Berlin',
      target_beneficiary_name: 'Weekly Budget User',
      target_iban_encrypted: (database.prepare(
        'SELECT iban_encrypted FROM bank_accounts WHERE id = 2'
      ).get() as Record<string, unknown>).iban_encrypted
    });
    assert.match(String(database.prepare(
      'SELECT payload_sha256 FROM transfer_suggestions'
    ).get()?.payload_sha256), /^[a-f0-9]{64}$/);

    const replay = await runWeeklyBudgetCutoff({
      database,
      client: successfulClient(calls),
      configId: 1,
      scheduledCutoffAt: CUTOFF,
      trigger: 'catch_up',
      clock: () => RUN_TIME
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.suggestionId, result.suggestionId);
    assert.equal(calls.value, 4);
    assert.equal(database.prepare('SELECT count(*) AS count FROM weekly_budget_job_runs').get()?.count, 1);
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});

test('queues one encrypted idempotent push delivery for every active recipient device', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = fixture();
  const calls = { value: 0 };
  try {
    database.prepare(`
      UPDATE weekly_budget_configs SET notification_enabled = 1, notification_user_id = 9
      WHERE id = 1
    `).run();
    upsertPushSubscription(database, {
      yuvomiUserId: 9,
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/recipient-device',
        keys: { p256dh: 'recipient_p256dh', auth: 'recipient_auth' }
      },
      now: RUN_TIME
    });
    const result = await runWeeklyBudgetCutoff({
      database, client: successfulClient(calls), configId: 1,
      scheduledCutoffAt: CUTOFF, trigger: 'scheduled', clock: () => RUN_TIME
    });
    const delivery = database.prepare(`
      SELECT suggestion_id, subscription_id, recipient_yuvomi_user_id,
             idempotency_key, payload_encrypted, status
      FROM weekly_budget_notification_deliveries
    `).get() as Record<string, unknown>;
    assert.equal(delivery.suggestion_id, result.suggestionId);
    assert.equal(delivery.subscription_id, 1);
    assert.equal(delivery.recipient_yuvomi_user_id, 9);
    assert.equal(delivery.status, 'pending');
    assert.equal(
      delivery.idempotency_key,
      'weekly-budget:1:weekly-budget:1:2026-09-13T16:30:00.000Z:revision:1:subscription:1'
    );
    const payload = JSON.parse(createEncryptionService(TEST_KEY).decrypt(
      String(delivery.payload_encrypted)
    ));
    assert.deepEqual(payload, {
      title: 'Wochenbudget: 320,00 EUR überweisen',
      body: '450,00 EUR - 30,00 EUR Direkt - 100,00 EUR N26 = 320,00 EUR',
      url: `/m/banking?view=weekly-transfer&id=${result.suggestionId}`,
      tag: 'banking-weekly-budget-1-weekly-budget:1:2026-09-13T16:30:00.000Z'
    });

    const replay = await runWeeklyBudgetCutoff({
      database, client: successfulClient(calls), configId: 1,
      scheduledCutoffAt: CUTOFF, trigger: 'catch_up', clock: () => RUN_TIME
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(database.prepare(
      'SELECT count(*) AS count FROM weekly_budget_notification_deliveries'
    ).get()?.count, 1);
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});

test('a provider failure creates no snapshots, period, or suggestion', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = fixture();
  const client = {
    getAllAccountTransactions: async () => ({ pages: 1, transactions: [] }),
    getAccountBalances: async (accountId: string) => {
      if (accountId === 'n26-provider') throw new Error('sensitive provider failure');
      return { balances: [{
        balance_amount: { amount: '1.00', currency: 'EUR' },
        balance_type: 'ITAV'
      }] };
    }
  } as unknown as EnableBankingClient;

  try {
    await assert.rejects(runWeeklyBudgetCutoff({
      database,
      client,
      configId: 1,
      scheduledCutoffAt: CUTOFF,
      trigger: 'scheduled',
      clock: () => RUN_TIME
    }), /synchronization failed/);
    assert.equal(database.prepare('SELECT count(*) AS count FROM account_balance_snapshots').get()?.count, 0);
    assert.equal(database.prepare('SELECT count(*) AS count FROM weekly_budget_periods').get()?.count, 0);
    assert.equal(database.prepare('SELECT count(*) AS count FROM transfer_suggestions').get()?.count, 0);
    const run = database.prepare(`
      SELECT status, source_sync_status, target_sync_status, error_code, error_message
      FROM weekly_budget_job_runs
    `).get() as Record<string, unknown>;
    assert.equal(run.status, 'failed');
    assert.equal(run.source_sync_status, 'succeeded');
    assert.equal(run.target_sync_status, 'failed');
    assert.equal(run.error_code, 'provider_sync_failed');
    assert.doesNotMatch(String(run.error_message), /sensitive provider failure/);
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});

test('an unusable target balance rolls back imported data and snapshots', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = fixture();
  const client = {
    getAllAccountTransactions: async (accountId: string) => ({
      pages: 1,
      transactions: accountId === 'sparkasse-provider' ? [{
        status: 'BOOK',
        entry_reference: 'must-roll-back',
        transaction_amount: { amount: '1.00', currency: 'EUR' },
        credit_debit_indicator: 'DBIT',
        booking_date: '2026-09-10',
        creditor: { name: 'Rollback merchant' }
      }] : []
    }),
    getAccountBalances: async (accountId: string) => ({
      balances: [{
        balance_amount: { amount: '100.00', currency: 'EUR' },
        balance_type: accountId === 'n26-provider' ? 'OTHR' : 'ITAV'
      }]
    })
  } as unknown as EnableBankingClient;

  try {
    await assert.rejects(runWeeklyBudgetCutoff({
      database,
      client,
      configId: 1,
      scheduledCutoffAt: CUTOFF,
      trigger: 'scheduled',
      clock: () => RUN_TIME
    }), /processing failed/);
    assert.equal(database.prepare(
      "SELECT count(*) AS count FROM transactions WHERE provider_transaction_id = 'must-roll-back'"
    ).get()?.count, 0);
    assert.equal(database.prepare('SELECT count(*) AS count FROM account_balance_snapshots').get()?.count, 0);
    assert.equal(database.prepare('SELECT count(*) AS count FROM weekly_budget_periods').get()?.count, 0);
    assert.equal(database.prepare('SELECT count(*) AS count FROM transfer_suggestions').get()?.count, 0);
    assert.equal(database.prepare(
      'SELECT error_code FROM weekly_budget_job_runs'
    ).get()?.error_code, 'processing_failed');
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});
