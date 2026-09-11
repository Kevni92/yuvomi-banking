import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { migrateDatabase } from '../src/db/database.js';
import { createEncryptionService } from '../src/security/encryption.js';

const TEST_KEY = 'ab'.repeat(32);

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

function seed(encryption: ReturnType<typeof createEncryptionService>): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const now = '2026-09-11T10:00:00.000Z';
  database.prepare(`INSERT INTO enable_banking_connections (id, yuvomi_user_id, aspsp_name, aspsp_country, status, created_at, updated_at) VALUES (1, 7, 'Test Bank', 'DE', 'authorized', ?, ?), (2, 8, 'Other Bank', 'DE', 'authorized', ?, ?)`)
    .run(now, now, now, now);
  database.prepare(`INSERT INTO bank_accounts (id, connection_id, provider_account_id, display_name, iban_encrypted, currency, account_type, created_at, updated_at) VALUES (1, 1, 'provider-own', 'Own account', ?, 'EUR', 'CACC', ?, ?), (2, 2, 'provider-other', 'Other account', ?, 'EUR', 'CACC', ?, ?)`)
    .run(encryption.encrypt('DE00123456780000000001'), now, now, encryption.encrypt('DE00999999990000000002'), now, now);
  database.prepare(`INSERT INTO counterparties (id, counterparty_id, display_name, iban_encrypted, created_at, updated_at) VALUES (1, 'counterparty-hmac', 'Coffee Shop', ?, ?, ?)`)
    .run(encryption.encrypt('DE00333333330000000003'), now, now);
  database.prepare(`INSERT INTO categories (id, name, type, active, weekly_budget_default, created_at, updated_at) VALUES (1, 'Food', 'expense', 1, 1, ?, ?)`)
    .run(now, now);
  database.prepare(`INSERT INTO transactions (id, account_id, provider_transaction_id, entry_reference, transaction_id, booking_date, amount_cents, currency, direction, counterparty_ref, counterparty_name, purpose, merchant_name, mcc, status, category_id, category_source, category_confidence, weekly_budget_override, raw_payload_encrypted, created_at, updated_at) VALUES (1, 1, 'provider-key', 'entry-1', 'transaction-1', '2026-09-11', 1234, 'EUR', 'outgoing', 1, 'Coffee Shop', 'Morning coffee', 'Coffee Shop', '5814', 'BOOK', 1, 'manual', 1, 'inherit', ?, ?, ?), (2, 2, 'private', NULL, NULL, '2026-09-11', 999, 'EUR', 'outgoing', NULL, 'Private', 'Never leak', NULL, NULL, 'BOOK', NULL, NULL, NULL, 'inherit', NULL, ?, ?)`)
    .run(encryption.encrypt(JSON.stringify({ transaction_id: 'transaction-1', note: 'raw provider data' })), now, now, now, now);
  return database;
}

test('transaction detail is owner-scoped and exposes decrypted details only there', async () => {
  const encryption = createEncryptionService(TEST_KEY);
  const database = seed(encryption);
  let identity: { id: number; permissions: { modules: { 'ext:banking': 'read' | 'write' | 'none' } } } | null = { id: 7, permissions: { modules: { 'ext:banking': 'read' } } };
  const { server, origin } = await listen(createApp({ database, encryption, resolveSession: async () => identity }));
  try {
    let response = await fetch(`${origin}/api/extensions/banking/transactions/1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.account.iban, 'DE00123456780000000001');
    assert.equal(body.data.counterparty.iban, 'DE00333333330000000003');
    assert.deepEqual(body.data.provider_raw, { transaction_id: 'transaction-1', note: 'raw provider data' });
    assert.equal(body.data.provider_raw_available, true);
    assert.doesNotMatch(JSON.stringify(body), /raw_payload_encrypted|BANKING_DATA_ENCRYPTION_KEY|api_key|private_key/i);

    response = await fetch(`${origin}/api/extensions/banking/transactions`);
    const list = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(list, /DE00123456780000000001|DE00333333330000000003|raw provider data/);

    identity = { id: 7, permissions: { modules: { 'ext:banking': 'write' } } };
    assert.equal((await fetch(`${origin}/api/extensions/banking/transactions/1`)).status, 200);
    assert.equal((await fetch(`${origin}/api/extensions/banking/transactions/2`)).status, 404);
    assert.equal((await fetch(`${origin}/api/extensions/banking/transactions/999`)).status, 404);
    identity = { id: 7, permissions: { modules: { 'ext:banking': 'none' } } };
    assert.equal((await fetch(`${origin}/api/extensions/banking/transactions/1`)).status, 403);
    identity = null;
    assert.equal((await fetch(`${origin}/api/extensions/banking/transactions/1`)).status, 401);
  } finally {
    await close(server);
    database.close();
  }
});

test('transaction detail reports missing raw payload without fetching from the provider', async () => {
  const encryption = createEncryptionService(TEST_KEY);
  const database = seed(encryption);
  const { server, origin } = await listen(createApp({
    database, encryption,
    resolveSession: async () => ({ id: 7, permissions: { modules: { 'ext:banking': 'read' } } })
  }));
  try {
    const response = await fetch(`${origin}/api/extensions/banking/transactions/1`);
    assert.equal(response.status, 200);
    database.prepare('UPDATE transactions SET raw_payload_encrypted = NULL WHERE id = 1').run();
    const missing = await fetch(`${origin}/api/extensions/banking/transactions/1`);
    const body = await missing.json();
    assert.equal(body.data.provider_raw, null);
    assert.equal(body.data.provider_raw_available, false);
  } finally {
    await close(server);
    database.close();
  }
});
