import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { migrateDatabase } from '../src/db/database.js';

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
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function user(id = 7, permission: 'read' | 'write' | 'none' = 'read') {
  return {
    id,
    permissions: { modules: { 'ext:banking': permission } }
  };
}

function seedDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  database.exec(`
    INSERT INTO enable_banking_connections (id, yuvomi_user_id, status, created_at, updated_at)
      VALUES (1, 7, 'authorized', '2026-01-01', '2026-01-01'),
             (2, 8, 'authorized', '2026-01-01', '2026-01-01');
    INSERT INTO bank_accounts (id, connection_id, provider_account_id, display_name, currency, created_at, updated_at)
      VALUES (1, 1, 'provider-1', 'Household account', 'EUR', '2026-01-01', '2026-01-01'),
             (2, 2, 'provider-2', 'Other account', 'EUR', '2026-01-01', '2026-01-01');
    INSERT INTO categories (id, name, type, active, created_at, updated_at)
      VALUES (1, 'Groceries', 'expense', 1, '2026-01-01', '2026-01-01');
  `);
  const insert = database.prepare(`
    INSERT INTO transactions (
      account_id, provider_transaction_id, booking_date, value_date, amount_cents,
      currency, direction, counterparty_name, purpose, merchant_name, status,
      category_id, weekly_budget_override, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, 'inherit', '2026-01-01', '2026-01-01')
  `);
  insert.run(1, 'one', '2026-01-03', null, 1200, 'outgoing', 'Market', 'Weekly groceries', 'Fresh Market', 'BOOK', 1);
  insert.run(1, 'two', null, '2026-01-02', 3500, 'incoming', 'Employer', 'Salary September', null, 'BOOK', null);
  insert.run(1, 'three', '2026-01-01', null, 500, 'outgoing', 'Coffee Shop', 'Morning coffee', null, 'PDNG', null);
  insert.run(2, 'private', '2026-01-04', null, 9900, 'outgoing', 'Private', 'Should not leak', null, 'BOOK', null);
  return database;
}

test('global transaction route is owned, filterable, sortable and paginated', async () => {
  const database = seedDatabase();
  const { server, origin } = await listen(createApp({
    database,
    resolveSession: async () => user()
  }));
  try {
    const response = await fetch(`${origin}/api/extensions/banking/transactions?q=coffee&sort=amount&order=asc&limit=1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.pagination, { total: 1, limit: 1, offset: 0 });
    assert.equal(body.data.transactions[0].purpose, 'Morning coffee');
    assert.equal(body.data.transactions[0].account_display_name, 'Household account');
    assert.doesNotMatch(JSON.stringify(body), /provider-1|iban_encrypted|raw_payload|Should not leak/);

    const income = await fetch(`${origin}/api/extensions/banking/transactions?direction=incoming&date_from=2026-01-01&date_to=2026-01-03`);
    assert.deepEqual((await income.json()).data.transactions.map((item: { purpose: string }) => item.purpose), ['Salary September']);

    const otherAccount = await fetch(`${origin}/api/extensions/banking/transactions?account_id=2`);
    assert.deepEqual((await otherAccount.json()).data.pagination.total, 0);
  } finally {
    await close(server);
    database.close();
  }
});

test('global transaction route validates query values and permission', async () => {
  const database = seedDatabase();
  let currentUser = user(7, 'read');
  const { server, origin } = await listen(createApp({
    database,
    resolveSession: async () => currentUser
  }));
  try {
    const invalidSort = await fetch(`${origin}/api/extensions/banking/transactions?sort=id%20DESC`);
    assert.equal(invalidSort.status, 400);
    const conflictingFilters = await fetch(`${origin}/api/extensions/banking/transactions?category_id=1&uncategorized=1`);
    assert.equal(conflictingFilters.status, 400);
    const invalidDates = await fetch(`${origin}/api/extensions/banking/transactions?date_from=2026-02-01&date_to=2026-01-01`);
    assert.equal(invalidDates.status, 400);

    currentUser = user(7, 'none');
    const denied = await fetch(`${origin}/api/extensions/banking/transactions`);
    assert.equal(denied.status, 403);
  } finally {
    await close(server);
    database.close();
  }
});
