import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';
import type { EnableBankingClient } from '../src/enable-banking/client.js';
import { createEncryptionService } from '../src/security/encryption.js';
import { runDueScheduledAccountSyncJobs } from '../src/services/scheduled-account-sync.js';

const TEST_KEY = 'fa'.repeat(32);
const TEST_HMAC = 'daily-budget-summary-hmac';
const RUN_TIME = new Date('2026-09-10T04:01:00.000Z');

test('successful scheduled sync queues current budget summary for every active client once', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = fixture();
  const encryption = createEncryptionService(TEST_KEY);

  try {
    const first = await runDueScheduledAccountSyncJobs({
      database,
      client: balanceClient(),
      now: RUN_TIME
    });
    assert.equal(first[0].state, 'succeeded');

    const rows = database.prepare(`
      SELECT subscription_id, notification_type, idempotency_key, payload_encrypted
      FROM weekly_budget_notification_deliveries
      ORDER BY subscription_id
    `).all() as Array<{
      subscription_id: number;
      notification_type: string;
      idempotency_key: string;
      payload_encrypted: string;
    }>;

    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.subscription_id), [1, 2]);
    assert.ok(rows.every((row) => row.notification_type === 'daily_summary'));
    assert.ok(rows.every((row) => row.idempotency_key.includes('2026-09-10T04:00:00.000Z')));

    for (const row of rows) {
      const payload = JSON.parse(encryption.decrypt(row.payload_encrypted)) as {
        title: string;
        body: string;
        url: string;
        tag: string;
      };
      assert.equal(payload.title, 'Wochenbudget: 45,42 € verfügbar');
      assert.equal(payload.body, 'Muss noch 4 Tage reichen.');
      assert.equal(payload.url, '/m/banking');
      assert.equal(payload.tag, 'banking-weekly-budget-daily-summary-1');
    }

    const replay = await runDueScheduledAccountSyncJobs({
      database,
      client: balanceClient(),
      now: RUN_TIME
    });
    assert.equal(replay[0].state, 'skipped');
    assert.equal(replay[0].reason, 'already_succeeded');
    assert.equal(database.prepare(
      'SELECT COUNT(*) AS count FROM weekly_budget_notification_deliveries'
    ).get()?.count, 2);
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});

function fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const encryption = createEncryptionService(TEST_KEY);
  const createdAt = '2026-09-01T00:00:00.000Z';

  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (7, 'authorized', ?, ?)
  `).run(createdAt, createdAt);

  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, display_name, iban_encrypted,
      currency, account_type, created_at, updated_at
    ) VALUES
      (1, 'source', 'Main Current Account', ?, 'EUR', 'CACC', ?, ?),
      (1, 'target', 'Weekly Budget Account', ?, 'EUR', 'CACC', ?, ?)
  `).run(
    encryption.encrypt('DE12500105170648489890'), createdAt, createdAt,
    encryption.encrypt('DE89370400440532013000'), createdAt, createdAt
  );

  database.prepare(`
    INSERT INTO weekly_budget_configs (
      yuvomi_user_id, enabled, source_account_id, target_account_id,
      target_amount_cents, currency, cutoff_weekday, cutoff_time, timezone,
      sync_time_1, sync_time_2, notification_enabled, notification_user_id,
      notification_qr_preview, purpose_prefix, effective_from_date,
      effective_from_at, created_at, updated_at
    ) VALUES (7, 1, 1, 2, 45000, 'EUR', 7, '18:30', 'Europe/Berlin',
              '06:00', '18:00', 1, 7, 0, 'WB', '2026-09-01', ?, ?, ?)
  `).run(createdAt, createdAt, createdAt);

  const subscription = encryption.encrypt(JSON.stringify({
    endpoint: 'https://push.example.invalid/device',
    keys: { p256dh: 'test', auth: 'test' }
  }));
  const insertSubscription = database.prepare(`
    INSERT INTO banking_push_subscriptions (
      yuvomi_user_id, endpoint_fingerprint, subscription_encrypted,
      device_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertSubscription.run(7, 'device-a', subscription, 'Telefon', 'active', createdAt, createdAt);
  insertSubscription.run(7, 'device-b', subscription, 'Desktop', 'active', createdAt, createdAt);
  insertSubscription.run(7, 'device-c', subscription, 'Altgerät', 'disabled', createdAt, createdAt);

  return database;
}

function balanceClient(): EnableBankingClient {
  return {
    getAllAccountTransactions: async () => ({ pages: 1, transactions: [] }),
    getAccountBalances: async (accountId: string) => ({
      balances: [{
        balance_amount: {
          amount: accountId === 'target' ? '45.42' : '1000.00',
          currency: 'EUR'
        },
        balance_type: 'ITAV',
        last_change_date_time: RUN_TIME.toISOString()
      }]
    })
  } as unknown as EnableBankingClient;
}
