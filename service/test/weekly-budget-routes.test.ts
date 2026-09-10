import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';
import { persistAccountBalanceSnapshots } from '../src/enable-banking/balances.js';
import { createEncryptionService } from '../src/security/encryption.js';
import { counterpartyId } from '../src/services/counterparty.js';

const TEST_KEY = 'cd'.repeat(32);
const TEST_HMAC = 'weekly-budget-route-hmac-secret';
const NOW = new Date('2026-09-10T10:00:00.000Z');
const SOURCE_IBAN = 'DE12500105170648489890';
const TARGET_IBAN = 'DE89370400440532013000';

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; origin: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server has no address.');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function writeUser() {
  return {
    id: 7,
    display_name: 'Weekly Budget User',
    role: 'parent',
    permissions: { modules: { 'ext:banking': 'write' as const } }
  };
}

function createFixture(): DatabaseSync {
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
      currency, account_type, created_at, updated_at
    ) VALUES
      (1, 'sparkasse', 'Sparkasse Girokonto', ?, 'EUR', 'CACC', ?, ?),
      (1, 'n26', 'N26', ?, 'EUR', 'CACC', ?, ?)
  `).run(
    encryption.encrypt(SOURCE_IBAN),
    NOW.toISOString(),
    NOW.toISOString(),
    encryption.encrypt(TARGET_IBAN),
    NOW.toISOString(),
    NOW.toISOString()
  );
  return database;
}

function mutationHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: config.publicOrigin,
    cookie: 'yuvomi.sid=test; banking.csrf=weekly-csrf',
    'x-banking-csrf': 'weekly-csrf'
  };
}

function settingsBody(): Record<string, unknown> {
  return {
    enabled: true,
    source_account_id: 1,
    target_account_id: 2,
    target_beneficiary_name: 'Weekly Budget User',
    target_amount_cents: 45000,
    cutoff_weekday: 7,
    cutoff_time: '18:30',
    timezone: 'Europe/Berlin',
    sync_time_1: '06:00',
    sync_time_2: '18:00',
    balance_stale_after_minutes: 840,
    notification_enabled: false,
    notification_user_id: null,
    notification_qr_preview: false,
    purpose_prefix: 'WB'
  };
}

test('protects and stores weekly-budget settings without exposing an IBAN', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = createFixture();
  const { server, origin } = await listen(createApp({
    database,
    resolveSession: async () => writeUser(),
    clock: () => NOW
  }));

  try {
    const denied = await fetch(`${origin}/api/extensions/banking/weekly-budget/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: 'yuvomi.sid=test' },
      body: JSON.stringify(settingsBody())
    });
    assert.equal(denied.status, 403);

    const saved = await fetch(`${origin}/api/extensions/banking/weekly-budget/settings`, {
      method: 'PUT',
      headers: mutationHeaders(),
      body: JSON.stringify(settingsBody())
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.data.target_amount_cents, 45000);
    assert.equal(savedBody.data.effective_from_date, '2026-09-10');
    assert.equal(savedBody.data.effective_from_at, NOW.toISOString());
    assert.deepEqual(savedBody.data.source_account, {
      id: 1,
      display_name: 'Sparkasse Girokonto'
    });
    assert.doesNotMatch(JSON.stringify(savedBody), /DE125001|DE893704|iban/i);

    const loaded = await fetch(`${origin}/api/extensions/banking/weekly-budget/settings`, {
      headers: { cookie: 'yuvomi.sid=test' }
    });
    assert.equal(loaded.status, 200);
    assert.equal((await loaded.json()).data.cutoff_time, '18:30');

    database.prepare(`
      INSERT INTO categories (name, type, created_at, updated_at)
      VALUES ('Lebensmittel', 'expense', ?, ?)
    `).run(NOW.toISOString(), NOW.toISOString());
    const category = await fetch(
      `${origin}/api/extensions/banking/categories/1/weekly-budget`,
      {
        method: 'PATCH',
        headers: mutationHeaders(),
        body: JSON.stringify({ weekly_budget_default: true })
      }
    );
    assert.equal(category.status, 200);
    assert.equal(database.prepare(
      'SELECT weekly_budget_default FROM categories WHERE id = 1'
    ).get()?.weekly_budget_default, 1);
    const categories = await fetch(`${origin}/api/extensions/banking/categories`, {
      headers: { cookie: 'yuvomi.sid=test' }
    });
    assert.equal(categories.status, 200);
    assert.deepEqual((await categories.json()).data, [{
      id: 1,
      name: 'Lebensmittel',
      type: 'expense',
      active: true,
      weekly_budget_default: true
    }]);
  } finally {
    await close(server);
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});

test('current overview applies transaction override before category and excludes internal transfers', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  const previousHmac = config.secrets.counterpartyHmac;
  config.secrets.dataEncryptionKey = TEST_KEY;
  config.secrets.counterpartyHmac = TEST_HMAC;
  const database = createFixture();
  const encryption = createEncryptionService(TEST_KEY);
  database.prepare(`
    INSERT INTO weekly_budget_configs (
      yuvomi_user_id, enabled, source_account_id, target_account_id,
      target_amount_cents, currency, cutoff_weekday, cutoff_time, timezone,
      sync_time_1, sync_time_2, balance_stale_after_minutes,
      notification_enabled, notification_qr_preview, purpose_prefix,
      effective_from_date, created_at, updated_at
    ) VALUES (7, 1, 1, 2, 45000, 'EUR', 7, '18:30', 'Europe/Berlin',
              '06:00', '18:00', 840, 0, 0, 'WB', '2026-09-06', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO categories (
      name, type, weekly_budget_default, created_at, updated_at
    ) VALUES
      ('Lebensmittel', 'expense', 0, ?, ?),
      ('Fixkosten', 'expense', 1, ?, ?)
  `).run(
    NOW.toISOString(), NOW.toISOString(),
    NOW.toISOString(), NOW.toISOString()
  );
  database.prepare(`
    INSERT INTO counterparties (
      counterparty_id, display_name, iban_encrypted, created_at, updated_at
    ) VALUES (?, 'N26', ?, ?, ?)
  `).run(
    counterpartyId(TARGET_IBAN, TEST_HMAC),
    encryption.encrypt(TARGET_IBAN),
    NOW.toISOString(),
    NOW.toISOString()
  );
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, booking_date, amount_cents,
      currency, direction, counterparty_name, category_id,
      weekly_budget_override, status, created_at, updated_at
    ) VALUES
      (1, 'lidl', '2026-09-09', 3000, 'EUR', 'outgoing', 'LIDL', 1,
       'include', 'BOOK', ?, ?),
      (1, 'insurance', '2026-09-09', 5000, 'EUR', 'outgoing', 'Insurance', 2,
       'exclude', 'BOOK', ?, ?),
      (1, 'internal-transfer', '2026-09-09', 10000, 'EUR', 'outgoing', 'N26', 2,
       'inherit', 'BOOK', ?, ?)
  `).run(
    NOW.toISOString(), NOW.toISOString(),
    NOW.toISOString(), NOW.toISOString(),
    NOW.toISOString(), NOW.toISOString()
  );
  database.prepare(
    'UPDATE transactions SET counterparty_ref = 1 WHERE provider_transaction_id = ?'
  ).run('internal-transfer');
  persistAccountBalanceSnapshots({
    database,
    accountId: 2,
    syncRunKey: 'current-overview-balance',
    fetchedAt: NOW,
    balances: [{
      balance_amount: { amount: '100.00', currency: 'EUR' },
      balance_type: 'ITAV',
      last_change_date_time: NOW.toISOString()
    }]
  });

  const { server, origin } = await listen(createApp({
    database,
    resolveSession: async () => writeUser(),
    clock: () => NOW
  }));
  try {
    const current = await fetch(`${origin}/api/extensions/banking/weekly-budget/current`, {
      headers: { cookie: 'yuvomi.sid=test' }
    });
    assert.equal(current.status, 200);
    const body = (await current.json()).data;
    assert.equal(body.available_to_spend_cents, 10000);
    assert.equal(body.direct_expense_cents, 3000);
    assert.equal(body.direct_expenses.length, 1);
    assert.equal(body.direct_expenses[0].decision_source, 'transaction_override');
    assert.equal(body.provisional_calculation.transfer_amount_cents, 32000);
    assert.deepEqual(body.period, {
      start_date: '2026-09-06',
      end_date: '2026-09-13',
      next_cutoff_at: '2026-09-13T16:30:00.000Z'
    });

    const override = await fetch(
      `${origin}/api/extensions/banking/transactions/2/weekly-budget`,
      {
        method: 'PATCH',
        headers: mutationHeaders(),
        body: JSON.stringify({ weekly_budget_override: 'include' })
      }
    );
    assert.equal(override.status, 200);
    const updatedCurrent = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/current`,
      { headers: { cookie: 'yuvomi.sid=test' } }
    );
    const updatedBody = (await updatedCurrent.json()).data;
    assert.equal(updatedBody.direct_expense_cents, 8000);
    assert.equal(updatedBody.provisional_calculation.transfer_amount_cents, 27000);

    database.prepare(`
      UPDATE account_balance_snapshots SET fetched_at = '2026-09-09T00:00:00.000Z'
    `).run();
    const staleCurrent = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/current`,
      { headers: { cookie: 'yuvomi.sid=test' } }
    );
    const staleBody = (await staleCurrent.json()).data;
    assert.equal(staleBody.available_to_spend_cents, 10000);
    assert.equal(staleBody.balance.stale, true);
    assert.equal(staleBody.provisional_calculation, null);
  } finally {
    await close(server);
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
    config.secrets.counterpartyHmac = previousHmac;
  }
});

test('does not allow a user to override another users transaction', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = createFixture();
  database.prepare(`
    INSERT INTO enable_banking_connections (
      yuvomi_user_id, status, created_at, updated_at
    ) VALUES (99, 'authorized', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO bank_accounts (
      connection_id, provider_account_id, currency, created_at, updated_at
    ) VALUES (2, 'other-user', 'EUR', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, amount_cents, currency, direction,
      status, created_at, updated_at
    ) VALUES (3, 'private', 100, 'EUR', 'outgoing', 'BOOK', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  const { server, origin } = await listen(createApp({
    database,
    resolveSession: async () => writeUser(),
    clock: () => NOW
  }));

  try {
    const crossUserSettings = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/settings`,
      {
        method: 'PUT',
        headers: mutationHeaders(),
        body: JSON.stringify({ ...settingsBody(), target_account_id: 3 })
      }
    );
    assert.equal(crossUserSettings.status, 400);
    assert.equal(database.prepare(
      'SELECT count(*) AS count FROM weekly_budget_configs'
    ).get()?.count, 0);

    const response = await fetch(
      `${origin}/api/extensions/banking/transactions/1/weekly-budget`,
      {
        method: 'PATCH',
        headers: mutationHeaders(),
        body: JSON.stringify({ weekly_budget_override: 'include' })
      }
    );
    assert.equal(response.status, 404);
    assert.equal(database.prepare(
      'SELECT weekly_budget_override FROM transactions WHERE id = 1'
    ).get()?.weekly_budget_override, 'inherit');
  } finally {
    await close(server);
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});
