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
import { upsertPushSubscription } from '../src/services/push-subscriptions.js';

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

function seedFinalizedPeriod(database: DatabaseSync): void {
  const encryption = createEncryptionService(TEST_KEY);
  const periodKey = 'weekly-budget:1:2026-09-13T16:30:00.000Z';
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
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO account_balance_snapshots (
      account_id, sync_run_key, provider_balance_type,
      normalized_balance_type, amount_cents, currency, observed_at,
      fetched_at, usable_for_weekly_budget, created_at
    ) VALUES
      (1, ?, 'ITAV', 'interim_available', 200000, 'EUR', ?, ?, 1, ?),
      (2, ?, 'ITAV', 'interim_available', 10000, 'EUR', ?, ?, 1, ?)
  `).run(
    `${periodKey}:source`, NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
    `${periodKey}:target`, NOW.toISOString(), NOW.toISOString(), NOW.toISOString()
  );
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, entry_reference, booking_date,
      amount_cents, currency, direction, counterparty_name,
      weekly_budget_override, status, created_at, updated_at
    ) VALUES (1, 'history-lidl', 'history-lidl', '2026-09-10', 3000,
              'EUR', 'outgoing', 'LIDL', 'include', 'BOOK', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO weekly_budget_periods (
      config_id, period_key, period_start_date, period_end_date,
      scheduled_cutoff_at, finalized_at, trigger, status,
      source_account_id, source_account_name, target_account_id,
      target_account_name, target_amount_cents, currency,
      target_balance_snapshot_id, target_balance_cents,
      direct_expense_cents, raw_computed_amount_cents,
      computed_amount_cents, overfunded_cents, calculation_version,
      source_sync_completed_at, target_sync_completed_at,
      cutoff_weekday, cutoff_time, timezone, purpose_prefix,
      target_beneficiary_name, target_iban_encrypted, created_at, updated_at
    ) VALUES (
      1, ?, '2026-09-06', '2026-09-13', '2026-09-13T16:30:00.000Z',
      ?, 'scheduled', 'finalized', 1, 'Sparkasse Girokonto', 2, 'N26',
      45000, 'EUR', 2, 10000, 3000, 32000, 32000, 0, 'weekly-budget-v1',
      ?, ?, 7, '18:30', 'Europe/Berlin', 'WB', 'Weekly Budget User', ?, ?, ?
    )
  `).run(
    periodKey,
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
    encryption.encrypt(TARGET_IBAN),
    NOW.toISOString(),
    NOW.toISOString()
  );
  database.prepare(`
    INSERT INTO weekly_budget_period_transactions (
      period_id, transaction_id, transaction_key, revision, state,
      amount_cents, currency, booking_date, counterparty_name,
      weekly_budget_override, decision_source, created_at
    ) VALUES (1, 1, 'history-lidl', 1, 'included', 3000, 'EUR',
              '2026-09-10', 'LIDL', 'include', 'transaction_override', ?)
  `).run(NOW.toISOString());
  database.prepare(`
    INSERT INTO transfer_suggestions (
      period_id, revision, source_account_id, target_account_id,
      target_amount_cents, target_balance_cents, computed_amount_cents,
      deducted_amount_cents, raw_computed_amount_cents, overfunded_cents,
      week_start, week_end, purpose, calculation_version, status,
      generated_at, created_at, updated_at
    ) VALUES (1, 1, 1, 2, 45000, 10000, 32000, 3000, 32000, 0,
              '2026-09-06', '2026-09-13',
              'WB 2026-09-13: 450,00 - 30,00 Direkt - 100,00 N26 = 320,00 EUR',
              'weekly-budget-v1', 'proposed', ?, ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO weekly_budget_job_runs (
      config_id, period_id, run_key, trigger, attempt, status,
      scheduled_for, started_at, finished_at, source_sync_status,
      target_sync_status, created_at, updated_at
    ) VALUES (1, 1, ?, 'scheduled', 1, 'succeeded',
              '2026-09-13T16:30:00.000Z', ?, ?, 'succeeded', 'succeeded', ?, ?)
  `).run(
    periodKey,
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
    NOW.toISOString()
  );
}

function seedLateCandidate(database: DatabaseSync): void {
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, entry_reference, booking_date,
      amount_cents, currency, direction, counterparty_name,
      weekly_budget_override, status, created_at, updated_at
    ) VALUES (1, 'history-late-bakery', 'history-late-bakery', '2026-09-11',
              1000, 'EUR', 'outgoing', 'Bakery', 'include', 'BOOK', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO weekly_budget_period_transactions (
      period_id, transaction_id, transaction_key, revision, state,
      amount_cents, currency, booking_date, counterparty_name,
      weekly_budget_override, decision_source, created_at
    ) VALUES (1, 2, 'history-late-bakery', 1, 'late_candidate', 1000, 'EUR',
              '2026-09-11', 'Bakery', 'include', 'transaction_override', ?)
  `).run(NOW.toISOString());
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

    const unreachableRecipient = await fetch(`${origin}/api/extensions/banking/weekly-budget/settings`, {
      method: 'PUT',
      headers: mutationHeaders(),
      body: JSON.stringify({
        ...settingsBody(), notification_enabled: true, notification_user_id: 7
      })
    });
    assert.equal(unreachableRecipient.status, 400);

    upsertPushSubscription(database, {
      yuvomiUserId: 7,
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/settings-recipient',
        keys: { p256dh: 'settings_p256dh', auth: 'settings_auth' }
      },
      now: NOW
    });
    const reachableRecipient = await fetch(`${origin}/api/extensions/banking/weekly-budget/settings`, {
      method: 'PUT',
      headers: mutationHeaders(),
      body: JSON.stringify({
        ...settingsBody(), notification_enabled: true, notification_user_id: 7
      })
    });
    assert.equal(reachableRecipient.status, 200);
    assert.equal((await reachableRecipient.json()).data.notification_enabled, true);

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

test('learns an owned counterparty category rule only after a protected manual assignment', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = createFixture();
  database.prepare(`
    INSERT INTO categories (name, type, created_at, updated_at)
    VALUES ('Lebensmittel', 'expense', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO counterparties (counterparty_id, display_name, created_at, updated_at)
    VALUES ('category-rule-lidl', 'LIDL', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, amount_cents, currency, direction,
      counterparty_ref, status, created_at, updated_at
    ) VALUES
      (1, 'lidl-one', 1200, 'EUR', 'outgoing', 1, 'BOOK', ?, ?),
      (1, 'lidl-two', 3400, 'EUR', 'outgoing', 1, 'BOOK', ?, ?)
  `).run(
    NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString()
  );
  const { server, origin } = await listen(createApp({
    database,
    resolveSession: async () => writeUser(),
    clock: () => NOW
  }));
  try {
    const denied = await fetch(
      `${origin}/api/extensions/banking/transactions/1/category`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: 'yuvomi.sid=test' },
        body: JSON.stringify({ category_id: 1 })
      }
    );
    assert.equal(denied.status, 403);

    const assigned = await fetch(
      `${origin}/api/extensions/banking/transactions/1/category`,
      {
        method: 'PATCH',
        headers: mutationHeaders(),
        body: JSON.stringify({ category_id: 1, remember_counterparty: true })
      }
    );
    assert.equal(assigned.status, 200);
    assert.deepEqual((await assigned.json()).data, {
      id: 1,
      category_id: 1,
      category_source: 'manual',
      counterparty_rule_created: true,
      affected_transactions: 2
    });
    assert.deepEqual(
      database.prepare(`
        SELECT id, category_id, category_source FROM transactions ORDER BY id
      `).all().map((row) => ({ ...row })),
      [
        { id: 1, category_id: 1, category_source: 'manual' },
        { id: 2, category_id: 1, category_source: 'counterparty_rule' }
      ]
    );
    assert.deepEqual({ ...(database.prepare(`
      SELECT yuvomi_user_id, rule_type, match_value, category_id, source
      FROM category_rules
    `).get() as Record<string, unknown>) }, {
      yuvomi_user_id: 7,
      rule_type: 'counterparty',
      match_value: 'category-rule-lidl',
      category_id: 1,
      source: 'manual'
    });
  } finally {
    await close(server);
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});

test('serves auditable weekly-budget history only through the owning user', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = createFixture();
  seedFinalizedPeriod(database);
  const { server, origin } = await listen(createApp({
    database,
    resolveSession: async () => writeUser(),
    clock: () => NOW
  }));
  const { server: otherServer, origin: otherOrigin } = await listen(createApp({
    database,
    resolveSession: async () => ({ ...writeUser(), id: 99 }),
    clock: () => NOW
  }));

  try {
    const listResponse = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/periods?limit=1`,
      { headers: { cookie: 'yuvomi.sid=test' } }
    );
    assert.equal(listResponse.status, 200);
    assert.match(listResponse.headers.get('cache-control') ?? '', /no-store/);
    const list = (await listResponse.json()).data;
    assert.equal(list.length, 1);
    assert.equal(list[0].computed_amount_cents, 32000);
    assert.equal(list[0].latest_suggestion.revision, 1);
    assert.match(list[0].latest_suggestion.girocode_url, /\/1\/girocode\.png$/);

    const detailResponse = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/periods/1`,
      { headers: { cookie: 'yuvomi.sid=test' } }
    );
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()).data;
    assert.equal(detail.target_account.iban_masked, 'DE89••••••3000');
    assert.equal(detail.balance_snapshots.length, 2);
    assert.deepEqual(
      detail.balance_snapshots.map((snapshot: Record<string, unknown>) => snapshot.account_role),
      ['source', 'target']
    );
    assert.equal(detail.transactions[0].counterparty_name, 'LIDL');
    assert.equal(detail.suggestions[0].girocode.amount_cents, 32000);
    assert.equal(detail.sync_runs[0].source_sync_status, 'succeeded');
    assert.doesNotMatch(JSON.stringify(detail), new RegExp(TARGET_IBAN));
    assert.doesNotMatch(JSON.stringify(detail), /target_iban_encrypted/);

    const missingResponse = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/periods/999`,
      { headers: { cookie: 'yuvomi.sid=test' } }
    );
    assert.equal(missingResponse.status, 404);

    const otherListResponse = await fetch(
      `${otherOrigin}/api/extensions/banking/weekly-budget/periods`,
      { headers: { cookie: 'yuvomi.sid=other' } }
    );
    assert.equal(otherListResponse.status, 200);
    assert.deepEqual((await otherListResponse.json()).data, []);
    const otherDetailResponse = await fetch(
      `${otherOrigin}/api/extensions/banking/weekly-budget/periods/1`,
      { headers: { cookie: 'yuvomi.sid=other' } }
    );
    assert.equal(otherDetailResponse.status, 404);
  } finally {
    await close(server);
    await close(otherServer);
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});

test('protects period revision and dismissal actions and preserves their audit trail', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = createFixture();
  seedFinalizedPeriod(database);
  seedLateCandidate(database);
  const { server, origin } = await listen(createApp({
    database,
    resolveSession: async () => writeUser(),
    clock: () => NOW
  }));
  try {
    const denied = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/periods/1/recalculate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'yuvomi.sid=test' },
        body: '{}'
      }
    );
    assert.equal(denied.status, 403);

    const recalculated = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/periods/1/recalculate`,
      { method: 'POST', headers: mutationHeaders(), body: '{}' }
    );
    assert.equal(recalculated.status, 201);
    assert.deepEqual((await recalculated.json()).data, {
      periodId: 1,
      suggestionId: 2,
      revision: 2,
      directExpenseCents: 4000,
      transferAmountCents: 31000,
      status: 'proposed'
    });

    const history = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/periods`,
      { headers: { cookie: 'yuvomi.sid=test' } }
    );
    const period = (await history.json()).data[0];
    assert.equal(period.latest_suggestion.revision, 2);
    assert.equal(period.latest_suggestion.deducted_amount_cents, 4000);
    assert.equal(period.latest_suggestion.computed_amount_cents, 31000);
    assert.equal(period.latest_suggestion.can_dismiss, true);
    assert.equal(period.latest_suggestion.girocode_url.endsWith('/2/girocode.png'), true);

    const dismissed = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/transfers/2/dismiss`,
      { method: 'POST', headers: mutationHeaders(), body: '{}' }
    );
    assert.equal(dismissed.status, 200);
    assert.deepEqual((await dismissed.json()).data, { suggestionId: 2, status: 'dismissed' });

    const giroCode = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/transfers/2/girocode`,
      { headers: { cookie: 'yuvomi.sid=test' } }
    );
    assert.equal(giroCode.status, 409);
    const repeatedDismissal = await fetch(
      `${origin}/api/extensions/banking/weekly-budget/transfers/2/dismiss`,
      { method: 'POST', headers: mutationHeaders(), body: '{}' }
    );
    assert.equal(repeatedDismissal.status, 409);
    assert.deepEqual(
      database.prepare(`
        SELECT revision, status FROM transfer_suggestions WHERE period_id = 1 ORDER BY revision
      `).all().map((row) => ({ ...row })),
      [
        { revision: 1, status: 'superseded' },
        { revision: 2, status: 'dismissed' }
      ]
    );
  } finally {
    await close(server);
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});

test('runs the categorization batch only through a protected write endpoint', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = createFixture();
  database.prepare(`
    INSERT INTO categories (name, type, created_at, updated_at)
    VALUES ('Lebensmittel', 'expense', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, amount_cents, currency, direction,
      purpose, status, created_at, updated_at
    ) VALUES (1, 'ai-route', 1000, 'EUR', 'outgoing', 'Supermarket', 'BOOK', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString());
  let calls = 0;
  const { server, origin } = await listen(createApp({
    database,
    resolveSession: async () => writeUser(),
    clock: () => NOW,
    categorizationClient: {
      categorize: async () => {
        calls += 1;
        return [{
          transaction_id: 1,
          category_id: 1,
          confidence: 0.9,
          reason: 'Groceries',
          suggested_category: null
        }];
      }
    }
  }));
  try {
    const denied = await fetch(`${origin}/api/extensions/banking/categorization/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'yuvomi.sid=test' },
      body: '{}'
    });
    assert.equal(denied.status, 403);
    assert.equal(calls, 0);

    const categorized = await fetch(`${origin}/api/extensions/banking/categorization/run`, {
      method: 'POST', headers: mutationHeaders(), body: '{}'
    });
    assert.equal(categorized.status, 200);
    assert.deepEqual((await categorized.json()).data, {
      submitted: 1,
      applied: 1,
      pendingReview: 0,
      categorySuggestions: 0
    });
    assert.equal(calls, 1);
    assert.deepEqual({ ...(database.prepare(`
      SELECT category_id, category_source, category_confidence FROM transactions WHERE id = 1
    `).get() as Record<string, unknown>) }, {
      category_id: 1,
      category_source: 'ai',
      category_confidence: 0.9
    });
  } finally {
    await close(server);
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});

test('only the owner can accept or dismiss a protected category suggestion', async () => {
  const database = createFixture();
  database.prepare(`
    INSERT INTO category_suggestions (
      yuvomi_user_id, suggested_name, suggested_type, reason, sample_count, status, created_at
    ) VALUES
      (7, 'Abonnements', 'expense', 'Recurring charge', 2, 'pending', ?),
      (7, 'Krypto', 'expense', 'Digital asset', 1, 'pending', ?),
      (99, 'Private other user category', 'expense', 'Other user', 1, 'pending', ?)
  `).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
  const { server, origin } = await listen(createApp({
    database,
    resolveSession: async () => writeUser(),
    clock: () => NOW
  }));
  try {
    const listed = await fetch(`${origin}/api/extensions/banking/category-suggestions`, {
      headers: { cookie: 'yuvomi.sid=test' }
    });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).data.map((row: { id: number }) => row.id), [1, 2]);

    const csrfDenied = await fetch(
      `${origin}/api/extensions/banking/category-suggestions/1/accept`,
      { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'yuvomi.sid=test' }, body: '{}' }
    );
    assert.equal(csrfDenied.status, 403);

    const accepted = await fetch(
      `${origin}/api/extensions/banking/category-suggestions/1/accept`,
      { method: 'POST', headers: mutationHeaders(), body: '{}' }
    );
    assert.equal(accepted.status, 200);
    assert.deepEqual((await accepted.json()).data, {
      id: 1,
      status: 'accepted',
      category: { id: 1, name: 'Abonnements', type: 'expense', created: true }
    });
    assert.equal(database.prepare('SELECT status FROM category_suggestions WHERE id = 1').get()?.status, 'accepted');

    const otherUser = await fetch(
      `${origin}/api/extensions/banking/category-suggestions/3/accept`,
      { method: 'POST', headers: mutationHeaders(), body: '{}' }
    );
    assert.equal(otherUser.status, 404);

    const dismissed = await fetch(
      `${origin}/api/extensions/banking/category-suggestions/2/dismiss`,
      { method: 'POST', headers: mutationHeaders(), body: '{}' }
    );
    assert.equal(dismissed.status, 200);
    assert.deepEqual((await dismissed.json()).data, { id: 2, status: 'rejected' });
    assert.equal(database.prepare('SELECT status FROM category_suggestions WHERE id = 2').get()?.status, 'rejected');
  } finally {
    await close(server);
    database.close();
  }
});
