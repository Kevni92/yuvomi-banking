import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';

const NOW = new Date('2026-09-12T08:00:00.000Z');
function user(id: number, permission: 'read' | 'write') { return { id, permissions: { modules: { 'ext:banking': permission } } }; }
function headers() { return { 'content-type': 'application/json', origin: config.publicOrigin, cookie: 'yuvomi.sid=x; banking.csrf=x', 'x-banking-csrf': 'x' }; }
async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; origin: string }> {
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
async function close(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrateDatabase(db);
  db.prepare(`INSERT INTO enable_banking_connections (yuvomi_user_id, status, created_at, updated_at) VALUES (7, 'authorized', ?, ?)`)
    .run(NOW.toISOString(), NOW.toISOString());
  db.prepare(`INSERT INTO bank_accounts (connection_id, provider_account_id, display_name, currency, created_at, updated_at) VALUES (1, 'acc-1', 'Provider Name', 'EUR', ?, ?)`)
    .run(NOW.toISOString(), NOW.toISOString());
  return db;
}

test('account aliases and colors are local, validated and user-owned', async () => {
  const db = fixture();
  const { server, origin } = await listen(createApp({ database: db, resolveSession: async () => user(7, 'write'), clock: () => NOW }));
  try {
    const update = await fetch(`${origin}/api/extensions/banking/accounts/1/preferences`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ alias: '  Sparkasse   Hauptkonto ', color: '#a78bfa' })
    });
    assert.equal(update.status, 200);
    assert.deepEqual((await update.json()).data, { id: 1, alias: 'Sparkasse Hauptkonto', color: '#A78BFA' });
    const stored = db.prepare('SELECT display_name, alias, color_hex FROM bank_accounts WHERE id = 1').get() as Record<string, unknown>;
    assert.equal(stored.display_name, 'Provider Name');
    assert.equal(stored.alias, 'Sparkasse Hauptkonto');
    assert.equal(stored.color_hex, '#A78BFA');

    const listed = await fetch(`${origin}/api/extensions/banking/account-preferences`, { headers: { cookie: 'yuvomi.sid=x' } });
    assert.deepEqual((await listed.json()).data, [{ id: 1, alias: 'Sparkasse Hauptkonto', color: '#A78BFA' }]);

    const invalid = await fetch(`${origin}/api/extensions/banking/accounts/1/preferences`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ color: 'purple' })
    });
    assert.equal(invalid.status, 400);
  } finally { await close(server); db.close(); }
});

test('account preference writes do not reveal or mutate another users account', async () => {
  const db = fixture();
  const { server, origin } = await listen(createApp({ database: db, resolveSession: async () => user(8, 'write'), clock: () => NOW }));
  try {
    const response = await fetch(`${origin}/api/extensions/banking/accounts/1/preferences`, {
      method: 'PATCH', headers: headers(), body: JSON.stringify({ alias: 'Nope' })
    });
    assert.equal(response.status, 404);
    assert.equal(db.prepare('SELECT alias FROM bank_accounts WHERE id = 1').get()?.alias, null);
  } finally { await close(server); db.close(); }
});
