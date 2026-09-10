import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';
import type { EnableBankingClient } from '../src/enable-banking/client.js';
import { createEncryptionService } from '../src/security/encryption.js';
import {
  latestDueDailySyncSlot,
  runDueScheduledAccountSyncJobs
} from '../src/services/scheduled-account-sync.js';

const TEST_KEY = 'fa'.repeat(32);
const TEST_HMAC = 'scheduled-account-sync-hmac';
const RUN_TIME = new Date('2026-09-10T04:01:00.000Z');

test('selects the latest due local sync slot', () => {
  assert.deepEqual(latestDueDailySyncSlot({
    now: RUN_TIME,
    syncTimes: ['06:00', '18:00'],
    timezone: 'Europe/Berlin'
  }), {
    localDate: '2026-09-10',
    slotTime: '06:00',
    scheduledAt: '2026-09-10T04:00:00.000Z'
  });
  assert.deepEqual(latestDueDailySyncSlot({
    now: new Date('2026-09-10T03:00:00.000Z'),
    syncTimes: ['06:00', '18:00'],
    timezone: 'Europe/Berlin'
  }), {
    localDate: '2026-09-09',
    slotTime: '18:00',
    scheduledAt: '2026-09-09T16:00:00.000Z'
  });
});

test('synchronizes both configured accounts atomically and only once per slot', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = syncFixture();
  const calls: Array<[string, string, string | undefined]> = [];
  const client = successfulClient(calls);
  try {
    const first = await runDueScheduledAccountSyncJobs({ database, client, now: RUN_TIME });
    assert.equal(first[0].state, 'succeeded');
    assert.equal(first[0].result?.sourceImportedCount, 1);
    assert.equal(first[0].result?.targetImportedCount, 0);
    assert.equal(calls.length, 4);
    assert.deepEqual(
      calls.filter((call) => call[1] === 'transactions').map((call) => call[2]),
      ['2026-08-27', '2026-08-27']
    );
    assert.equal(database.prepare('SELECT count(*) AS count FROM transactions').get()?.count, 1);
    assert.equal(database.prepare(
      'SELECT count(*) AS count FROM account_balance_snapshots'
    ).get()?.count, 2);
    assert.equal(database.prepare(
      'SELECT status FROM scheduled_account_sync_runs'
    ).get()?.status, 'succeeded');

    const replay = await runDueScheduledAccountSyncJobs({ database, client, now: RUN_TIME });
    assert.equal(replay[0].state, 'skipped');
    assert.equal(replay[0].reason, 'already_succeeded');
    assert.equal(calls.length, 4);
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});

test('a scheduled sync links unique source and target transfer bookings', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = syncFixture();
  const purpose = 'WB 2026-09-06: 450,00 - 30,00 Direkt - 100,00 N26 = 320,00 EUR';
  database.prepare(`
    INSERT INTO weekly_budget_periods (
      config_id, period_key, period_start_date, period_end_date,
      scheduled_cutoff_at, finalized_at, trigger, status,
      source_account_id, target_account_id, target_amount_cents,
      target_balance_cents, direct_expense_cents, raw_computed_amount_cents,
      computed_amount_cents, calculation_version, timezone, created_at, updated_at
    ) VALUES (1, 'weekly-budget:1:2026-09-06T16:30:00.000Z',
              '2026-08-30', '2026-09-06', '2026-09-06T16:30:00.000Z',
              '2026-09-06T16:31:00.000Z', 'scheduled', 'finalized',
              1, 2, 45000, 10000, 3000, 32000, 32000,
              'weekly-budget-v1', 'Europe/Berlin',
              '2026-09-06T16:31:00.000Z', '2026-09-06T16:31:00.000Z')
  `).run();
  database.prepare(`
    INSERT INTO transfer_suggestions (
      period_id, revision, source_account_id, target_account_id,
      target_amount_cents, target_balance_cents, computed_amount_cents,
      deducted_amount_cents, raw_computed_amount_cents, week_start, week_end,
      purpose, calculation_version, status, generated_at, created_at, updated_at
    ) VALUES (1, 1, 1, 2, 45000, 10000, 32000, 3000, 32000,
              '2026-08-30', '2026-09-06', ?, 'weekly-budget-v1', 'proposed',
              '2026-09-06T16:31:00.000Z', '2026-09-06T16:31:00.000Z',
              '2026-09-06T16:31:00.000Z')
  `).run(purpose);
  const client = {
    getAllAccountTransactions: async (accountId: string) => ({
      pages: 1,
      transactions: accountId === 'source' ? [{
        status: 'BOOK',
        entry_reference: 'weekly-transfer-source',
        transaction_amount: { amount: '320.00', currency: 'EUR' },
        credit_debit_indicator: 'DBIT',
        booking_date: '2026-09-09',
        remittance_information: [purpose],
        creditor: { name: 'N26' },
        creditor_account: { iban: 'DE89370400440532013000' }
      }] : [{
        status: 'BOOK',
        entry_reference: 'weekly-transfer-target',
        transaction_amount: { amount: '320.00', currency: 'EUR' },
        credit_debit_indicator: 'CRDT',
        booking_date: '2026-09-09',
        remittance_information: [purpose],
        debtor: { name: 'Sparkasse' },
        debtor_account: { iban: 'DE12500105170648489890' }
      }]
    }),
    getAccountBalances: async () => ({ balances: [{
      balance_amount: { amount: '100.00', currency: 'EUR' },
      balance_type: 'ITAV',
      last_change_date_time: RUN_TIME.toISOString()
    }] })
  } as unknown as EnableBankingClient;

  try {
    const outcomes = await runDueScheduledAccountSyncJobs({ database, client, now: RUN_TIME });
    assert.equal(outcomes[0].state, 'succeeded');
    assert.deepEqual({ ...(database.prepare(`
      SELECT status, matched_source_transaction_id,
             matched_target_transaction_id, completed_at
      FROM transfer_suggestions WHERE id = 1
    `).get() as Record<string, unknown>) }, {
      status: 'completed',
      matched_source_transaction_id: 1,
      matched_target_transaction_id: 2,
      completed_at: RUN_TIME.toISOString()
    });
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});

test('rolls back a partial provider result and waits before retrying', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = syncFixture();
  let calls = 0;
  const client = {
    getAllAccountTransactions: async () => {
      calls += 1;
      return { pages: 1, transactions: [] };
    },
    getAccountBalances: async (accountId: string) => {
      calls += 1;
      if (accountId === 'target') throw new Error('provider unavailable');
      return { balances: [{
        balance_amount: { amount: '1000.00', currency: 'EUR' },
        balance_type: 'ITAV'
      }] };
    }
  } as unknown as EnableBankingClient;
  try {
    const first = await runDueScheduledAccountSyncJobs({ database, client, now: RUN_TIME });
    assert.equal(first[0].state, 'failed');
    assert.equal(database.prepare(
      'SELECT attempt FROM scheduled_account_sync_runs'
    ).get()?.attempt, 1);
    assert.equal(database.prepare(
      'SELECT count(*) AS count FROM account_balance_snapshots'
    ).get()?.count, 0);
    const callsAfterFailure = calls;

    const waiting = await runDueScheduledAccountSyncJobs({
      database,
      client,
      now: new Date(RUN_TIME.getTime() + 4 * 60_000)
    });
    assert.equal(waiting[0].reason, 'retry_wait');
    assert.equal(calls, callsAfterFailure);

    const retry = await runDueScheduledAccountSyncJobs({
      database,
      client,
      now: new Date(RUN_TIME.getTime() + 5 * 60_000)
    });
    assert.equal(retry[0].state, 'failed');
    assert.equal(database.prepare(
      'SELECT attempt FROM scheduled_account_sync_runs'
    ).get()?.attempt, 2);
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});

test('does not duplicate a slot already covered by a successful cutoff sync', async () => {
  const database = syncFixture();
  database.prepare(`
    INSERT INTO weekly_budget_job_runs (
      config_id, run_key, trigger, status, scheduled_for,
      started_at, finished_at, source_sync_status, target_sync_status,
      created_at, updated_at
    ) VALUES (1, 'weekly-budget:1:covered', 'catch_up', 'succeeded',
              '2026-09-10T03:30:00.000Z', ?, ?, 'succeeded', 'succeeded', ?, ?)
  `).run(
    '2026-09-10T04:00:00.000Z',
    RUN_TIME.toISOString(),
    '2026-09-10T04:00:00.000Z',
    RUN_TIME.toISOString()
  );
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
    const outcomes = await runDueScheduledAccountSyncJobs({ database, client, now: RUN_TIME });
    assert.equal(outcomes[0].reason, 'covered_by_cutoff');
    assert.equal(calls, 0);
    assert.equal(database.prepare(
      'SELECT status FROM scheduled_account_sync_runs'
    ).get()?.status, 'skipped');
  } finally {
    database.close();
  }
});

test('does not backfill a daily slot from before activation', async () => {
  const database = syncFixture();
  database.prepare(
    'UPDATE weekly_budget_configs SET effective_from_at = ? WHERE id = 1'
  ).run(RUN_TIME.toISOString());
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
    const outcomes = await runDueScheduledAccountSyncJobs({ database, client, now: RUN_TIME });
    assert.equal(outcomes[0].reason, 'not_activated');
    assert.equal(calls, 0);
    assert.equal(database.prepare(
      'SELECT count(*) AS count FROM scheduled_account_sync_runs'
    ).get()?.count, 0);
  } finally {
    database.close();
  }
});

function syncFixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const encryption = createEncryptionService(TEST_KEY);
  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (7, 'authorized', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
  `).run();
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, display_name, iban_encrypted,
      currency, account_type, created_at, updated_at
    ) VALUES
      (1, 'source', 'Sparkasse', ?, 'EUR', 'CACC', ?, ?),
      (1, 'target', 'N26', ?, 'EUR', 'CACC', ?, ?)
  `).run(
    encryption.encrypt('DE12500105170648489890'),
    '2026-09-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z',
    encryption.encrypt('DE89370400440532013000'),
    '2026-09-01T00:00:00.000Z',
    '2026-09-01T00:00:00.000Z'
  );
  database.prepare(`
    INSERT INTO weekly_budget_configs (
      yuvomi_user_id, enabled, source_account_id, target_account_id,
      target_amount_cents, currency, cutoff_weekday, cutoff_time, timezone,
      sync_time_1, sync_time_2, notification_enabled,
      notification_qr_preview, purpose_prefix, effective_from_date,
      effective_from_at, created_at, updated_at
    ) VALUES (7, 1, 1, 2, 45000, 'EUR', 7, '18:30', 'Europe/Berlin',
              '06:00', '18:00', 0, 0, 'WB', '2026-09-01',
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
              '2026-09-01T00:00:00.000Z')
  `).run();
  return database;
}

function successfulClient(
  calls: Array<[string, string, string | undefined]>
): EnableBankingClient {
  return {
    getAllAccountTransactions: async (accountId: string, query: { dateFrom?: string }) => {
      calls.push([accountId, 'transactions', query.dateFrom]);
      return {
        pages: 1,
        transactions: accountId === 'source' ? [{
          status: 'BOOK',
          entry_reference: 'lidl-daily-sync',
          transaction_amount: { amount: '30.00', currency: 'EUR' },
          credit_debit_indicator: 'DBIT',
          booking_date: '2026-09-09',
          creditor: { name: 'LIDL' },
          creditor_account: { iban: 'DE75512108001245126199' }
        }] : []
      };
    },
    getAccountBalances: async (accountId: string) => {
      calls.push([accountId, 'balances', undefined]);
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
