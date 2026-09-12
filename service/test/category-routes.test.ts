import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';

const NOW = new Date('2026-09-11T10:00:00.000Z');
function database(): DatabaseSync { const db = new DatabaseSync(':memory:'); migrateDatabase(db); return db; }
async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; origin: string }> {
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
async function close(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function user(permission: 'read' | 'write') { return { id: 7, permissions: { modules: { 'ext:banking': permission } } }; }
function headers() { return { 'content-type': 'application/json', origin: config.publicOrigin, cookie: 'yuvomi.sid=x; banking.csrf=x', 'x-banking-csrf': 'x' }; }

test('category routes protect writes, expose visual identity, and retain the legacy weekly-budget endpoint', async () => {
  const db = database(); const { server, origin } = await listen(createApp({ database: db, resolveSession: async () => user('write'), clock: () => NOW }));
  try {
    const created = await fetch(`${origin}/api/extensions/banking/categories`, { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'Lebensmittel', type: 'expense', weekly_budget_default: true, icon: 'shopping-cart', color: '#22c55e' }) });
    assert.equal(created.status, 201);
    assert.deepEqual((await created.json()).data, { id: 1, name: 'Lebensmittel', type: 'expense', active: true, weekly_budget_default: true, icon: 'shopping-cart', color: '#22C55E' });
    const duplicate = await fetch(`${origin}/api/extensions/banking/categories`, { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'lebensmittel', type: 'expense' }) });
    assert.equal(duplicate.status, 409);
    const invalidVisual = await fetch(`${origin}/api/extensions/banking/categories/1`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ color: 'red' }) });
    assert.equal(invalidVisual.status, 400);
    const renamed = await fetch(`${origin}/api/extensions/banking/categories/1`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ name: 'Groceries', active: false, icon: 'shopping-bag', color: '#7c3aed' }) });
    assert.deepEqual((await renamed.json()).data, { id: 1, name: 'Groceries', type: 'expense', active: false, weekly_budget_default: true, icon: 'shopping-bag', color: '#7C3AED' });
    const legacy = await fetch(`${origin}/api/extensions/banking/categories/1/weekly-budget`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ weekly_budget_default: false }) });
    assert.deepEqual((await legacy.json()).data, { id: 1, weekly_budget_default: false });
  } finally { await close(server); db.close(); }
});

test('read users can list but cannot mutate categories', async () => {
  const db = database(); const { server, origin } = await listen(createApp({ database: db, resolveSession: async () => user('read'), clock: () => NOW }));
  try {
    assert.equal((await fetch(`${origin}/api/extensions/banking/categories`, { headers: { cookie: 'yuvomi.sid=x' } })).status, 200);
    assert.equal((await fetch(`${origin}/api/extensions/banking/categories`, { method: 'POST', headers: headers(), body: '{}' })).status, 403);
  } finally { await close(server); db.close(); }
});
