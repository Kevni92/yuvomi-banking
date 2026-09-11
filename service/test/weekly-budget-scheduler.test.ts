import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';
import type { EnableBankingClient } from '../src/enable-banking/client.js';
import { createEncryptionService } from '../src/security/encryption.js';
import { upsertPushSubscription } from '../src/services/push-subscriptions.js';
import { runDueWeeklyBudgetJobs } from '../src/services/weekly-budget-scheduler.js';

const TEST_KEY = 'ad'.repeat(32);
const TEST_HMAC = 'weekly-budget-scheduler-hmac';
const CUTOFF = new Date('2026-09-13T16:30:00.000Z');
const RUN_TIME = new Date('2026-09-13T16:31:00.000Z');

function schedulerFixture(effectiveFromDate = '2026-09-06'): DatabaseSync {
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
      (1, 'source', 'Sparkasse', ?, 'EUR', 'CACC', ?, ?),
      (1, 'target', 'N26', ?, 'EUR', 'CACC', ?, ?)
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
      effective_from_date, created_at, updated_at
    ) VALUES (7, 1, 1, 2, 45000, 'EUR', 7, '18:30', 'Europe/Berlin',
              '06:00', '18:00', 840, 0, 0, 'WB', ?, ?, ?)
  `).run(effectiveFromDate, RUN_TIME.toISOString(), RUN_TIME.toISOString());
  return database;
}

function clientWithBalance(calls: { value: number }): EnableBankingClient {
  return {
    getAllAccountTransactions: async () => {
      calls.value += 1;
      return { pages: 1, transactions: [] };
    },
    getAccountBalances: async (accountId: string) => {
      calls.value += 1;
      return { balances: [{
        balance_amount: {
          amount: accountId === 'target' ? '100.00' : '1000.00',
          currency: 'EUR'
        },
        balance_type: 'ITAV',
        last_change_date_time: RUN_TIME.toISOString()
      }] };
    }
  } as unknown as EnableBankingClient;
}

test('scheduler runs the due cutoff once and skips the completed period afterwards', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = schedulerFixture();
  const calls = { value: 0 };

  try {
    const first = await runDueWeeklyBudgetJobs({
      database,
      client: clientWithBalance(calls),
      now: RUN_TIME
    });
    assert.equal(first.length, 1);
    assert.equal(first[0].state, 'succeeded');
    assert.equal(first[0].scheduledCutoffAt, CUTOFF.toISOString());
    assert.equal(first[0].result?.transferAmountCents, 35000);
    assert.equal(calls.value, 4);
    assert.equal(database.prepare(
      'SELECT trigger FROM weekly_budget_job_runs'
    ).get()?.trigger, 'scheduled');

    const second = await runDueWeeklyBudgetJobs({
      database,
      client: clientWithBalance(calls),
      now: RUN_TIME
    });
    assert.deepEqual(second.map((outcome) => [outcome.state, outcome.reason]), [
      ['skipped', 'already_succeeded']
    ]);
    assert.equal(calls.value, 4);
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});

test('scheduler does not backfill a cutoff from before activation', async () => {
  const database = schedulerFixture('2026-09-10');
  let calls = 0;
  const client = {
    getAllAccountTransactions: async () => {
      calls += 1;
      return { pages: 1, transactions: [] };
    },
    getAccountBalances: async () => {
      calls += 1;
      return { balances: [] };
    }
  } as unknown as EnableBankingClient;
  try {
    const outcomes = await runDueWeeklyBudgetJobs({
      database,
      client,
      now: new Date('2026-09-10T10:00:00.000Z')
    });
    assert.deepEqual(outcomes.map((outcome) => [outcome.state, outcome.reason]), [
      ['skipped', 'not_activated']
    ]);
    assert.equal(calls, 0);
    assert.equal(database.prepare(
      'SELECT count(*) AS count FROM weekly_budget_job_runs'
    ).get()?.count, 0);
  } finally {
    database.close();
  }
});

test('scheduler waits five minutes before the first retry', async () => {
  const database = schedulerFixture();
  let calls = 0;
  const failingClient = {
    getAllAccountTransactions: async () => {
      calls += 1;
      return { pages: 1, transactions: [] };
    },
    getAccountBalances: async (accountId: string) => {
      calls += 1;
      if (accountId === 'target') throw new Error('provider unavailable');
      return { balances: [{
        balance_amount: { amount: '1.00', currency: 'EUR' },
        balance_type: 'ITAV'
      }] };
    }
  } as unknown as EnableBankingClient;
  try {
    const first = await runDueWeeklyBudgetJobs({ database, client: failingClient, now: RUN_TIME });
    assert.equal(first[0].state, 'failed');
    assert.equal(database.prepare(
      'SELECT attempt FROM weekly_budget_job_runs'
    ).get()?.attempt, 1);
    const callsAfterFirst = calls;

    const tooEarly = await runDueWeeklyBudgetJobs({
      database,
      client: failingClient,
      now: new Date(RUN_TIME.getTime() + 4 * 60_000)
    });
    assert.equal(tooEarly[0].reason, 'retry_wait');
    assert.equal(calls, callsAfterFirst);

    const retry = await runDueWeeklyBudgetJobs({
      database,
      client: failingClient,
      now: new Date(RUN_TIME.getTime() + 5 * 60_000)
    });
    assert.equal(retry[0].state, 'failed');
    assert.equal(database.prepare(
      'SELECT attempt FROM weekly_budget_job_runs'
    ).get()?.attempt, 2);
    assert.ok(calls > callsAfterFirst);
  } finally {
    database.close();
  }
});

test('queues one data-free sync-failure notification after the final cutoff retry', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = schedulerFixture();
  const failingClient = {
    getAllAccountTransactions: async () => ({ pages: 1, transactions: [] }),
    getAccountBalances: async (accountId: string) => {
      if (accountId === 'target') throw new Error('provider unavailable');
      return { balances: [{
        balance_amount: { amount: '1.00', currency: 'EUR' },
        balance_type: 'ITAV'
      }] };
    }
  } as unknown as EnableBankingClient;
  upsertPushSubscription(database, {
    yuvomiUserId: 7,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/final-cutoff-failure',
      keys: { p256dh: 'BOGUS_P256DH_base64url', auth: 'BOGUS_AUTH_base64url' }
    },
    now: RUN_TIME
  });
  database.prepare(`
    UPDATE weekly_budget_configs
    SET notification_enabled = 1, notification_user_id = 7
    WHERE id = 1
  `).run();
  try {
    const retryTimes = [0, 5, 20, 50].map((minutes) =>
      new Date(RUN_TIME.getTime() + minutes * 60_000)
    );
    for (const now of retryTimes) {
      const outcome = await runDueWeeklyBudgetJobs({ database, client: failingClient, now });
      assert.equal(outcome[0].state, 'failed');
    }
    const delivery = database.prepare(`
      SELECT suggestion_id, notification_type, idempotency_key, payload_encrypted
      FROM weekly_budget_notification_deliveries
    `).get() as Record<string, unknown>;
    assert.equal(delivery.suggestion_id, null);
    assert.equal(delivery.notification_type, 'sync_failed');
    assert.match(String(delivery.idempotency_key), /sync-failed/);
    const payload = JSON.parse(createEncryptionService(TEST_KEY).decrypt(String(delivery.payload_encrypted))) as {
      title: string;
      body: string;
      url: string;
    };
    assert.equal(payload.title, 'Wochenbudget konnte nicht berechnet werden');
    assert.match(payload.body, /mehreren Versuchen fehlgeschlagen/);
    assert.doesNotMatch(payload.body, /EUR|N26|Direkt/);
    assert.equal(payload.url, '/m/banking?view=weekly-budget');

    const exhausted = await runDueWeeklyBudgetJobs({
      database,
      client: failingClient,
      now: new Date(RUN_TIME.getTime() + 51 * 60_000)
    });
    assert.equal(exhausted[0].reason, 'retry_exhausted');
    assert.equal(database.prepare(
      'SELECT count(*) AS count FROM weekly_budget_notification_deliveries'
    ).get()?.count, 1);
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});
