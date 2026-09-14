import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrateDatabase(db);
  db.exec(`
    INSERT INTO enable_banking_connections (id, yuvomi_user_id, status, created_at, updated_at)
      VALUES (1, 7, 'authorized', '2026-01-01', '2026-01-01'),
             (2, 8, 'authorized', '2026-01-01', '2026-01-01');
    INSERT INTO bank_accounts (id, connection_id, provider_account_id, display_name, created_at, updated_at)
      VALUES (1, 1, 'owner', 'Household', '2026-01-01', '2026-01-01'),
             (2, 2, 'other', 'Other', '2026-01-01', '2026-01-01');
    INSERT INTO categories (id, name, type, active, created_at, updated_at)
      VALUES (1, 'Household', 'expense', 1, '2026-01-01', '2026-01-01');
    INSERT INTO payees (id, yuvomi_user_id, display_name, display_name_source, status, created_at, updated_at)
      VALUES (1, 7, 'Example Utilities', 'provider.creditor_name', 'confirmed', '2026-01-01', '2026-01-01'),
             (2, 8, 'Private Payee', 'provider.creditor_name', 'confirmed', '2026-01-01', '2026-01-01');
    INSERT INTO transactions (
      account_id, provider_transaction_id, booking_date, amount_cents, currency,
      direction, status, payee_id, payee_match_state, created_at, updated_at
    ) VALUES
      (1, 'one', '2026-08-01', 1200, 'EUR', 'outgoing', 'BOOK', 1, 'matched', '2026-01-01', '2026-01-01'),
      (1, 'two', '2026-09-01', 1300, 'EUR', 'outgoing', 'BOOK', 1, 'matched', '2026-01-01', '2026-01-01'),
      (2, 'private', '2026-09-01', 900, 'EUR', 'outgoing', 'BOOK', 2, 'matched', '2026-01-01', '2026-01-01');
  `);
  return db;
}

function user(permission: 'read' | 'write' | 'none' = 'read') {
  return { id: 7, permissions: { modules: { 'ext:banking': permission } } };
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; origin: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address.');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function writeHeaders() {
  return {
    'content-type': 'application/json',
    origin: config.publicOrigin,
    cookie: 'banking.csrf=test-token',
    'x-banking-csrf': 'test-token'
  };
}

test('payee routes are owner-scoped, cache-disabled, and use the public transaction contract', async () => {
  const db = database();
  const { server, origin } = await listen(createApp({ database: db, resolveSession: async () => user('read') }));
  try {
    const list = await fetch(`${origin}/api/extensions/banking/payees`);
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    const listBody = await list.json();
    assert.equal(listBody.data.pagination.total, 1);
    assert.equal(listBody.data.payees[0].id, 1);
    assert.doesNotMatch(JSON.stringify(listBody), /iban|identifier_hash|raw_payload|Private Payee/i);

    const detail = await fetch(`${origin}/api/extensions/banking/payees/1/transactions`);
    assert.equal(detail.status, 200);
    assert.equal(detail.headers.get('cache-control'), 'no-store');
    const detailBody = await detail.json();
    assert.equal(detailBody.data.payee.id, 1);
    assert.deepEqual(detailBody.data.transactions.map((item: { id: number }) => item.id), [2, 1]);
    assert.equal(detailBody.data.transactions[0].account_display_name, 'Household');

    const foreign = await fetch(`${origin}/api/extensions/banking/payees/2/transactions`);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.headers.get('cache-control'), 'no-store');
  } finally {
    await close(server);
    db.close();
  }
});

test('payee category mutation requires write permission, Origin and CSRF', async () => {
  const db = database();
  let permission: 'read' | 'write' | 'none' = 'read';
  const { server, origin } = await listen(createApp({ database: db, resolveSession: async () => user(permission) }));
  try {
    const denied = await fetch(`${origin}/api/extensions/banking/payees/1/category`, {
      method: 'PATCH', headers: writeHeaders(), body: JSON.stringify({ category_id: 1 })
    });
    assert.equal(denied.status, 403);

    permission = 'write';
    const badOrigin = await fetch(`${origin}/api/extensions/banking/payees/1/category`, {
      method: 'PATCH', headers: { ...writeHeaders(), origin: 'https://attacker.invalid' }, body: JSON.stringify({ category_id: 1 })
    });
    assert.equal(badOrigin.status, 403);

    const updated = await fetch(`${origin}/api/extensions/banking/payees/1/category`, {
      method: 'PATCH', headers: writeHeaders(), body: JSON.stringify({ category_id: 1 })
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).data.category_id, 1);
    assert.equal(db.prepare(`SELECT category_id FROM payees WHERE id = 1`).get()?.category_id, 1);
  } finally {
    await close(server);
    db.close();
  }
});
