import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';

const NOW = new Date('2026-09-21T10:00:00.000Z');

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; origin: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server has no address.');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  const timestamp = NOW.toISOString();
  database.prepare(`INSERT INTO enable_banking_connections (yuvomi_user_id, status, created_at, updated_at) VALUES (7, 'authorized', ?, ?), (99, 'authorized', ?, ?)`)
    .run(timestamp, timestamp, timestamp, timestamp);
  database.prepare(`INSERT INTO bank_accounts (connection_id, provider_account_id, created_at, updated_at) VALUES (1, 'owned', ?, ?), (2, 'other', ?, ?)`)
    .run(timestamp, timestamp, timestamp, timestamp);
  database.prepare(`INSERT INTO categories (name, type, created_at, updated_at) VALUES ('Shopping', 'expense', ?, ?)`)
    .run(timestamp, timestamp);
  database.prepare(`INSERT INTO transactions (account_id, provider_transaction_id, merchant_name, purpose, amount_cents, currency, direction, booking_date, status, created_at, updated_at) VALUES
    (1, 'owned-review', 'PayPal Europe', 'Google Payment Ireland', -1499, 'EUR', 'outgoing', '2026-09-21', 'BOOK', ?, ?),
    (2, 'foreign-review', 'Private merchant', 'Private purpose', -100, 'EUR', 'outgoing', '2026-09-21', 'BOOK', ?, ?)`)
    .run(timestamp, timestamp, timestamp, timestamp);
  database.prepare(`INSERT INTO ai_categorization_reviews (transaction_id, category_id, confidence, reason, suggested_category_name, suggested_category_type, status, created_at, updated_at) VALUES
    (1, 1, .65, 'Google-Play-Kauf erkannt.', NULL, NULL, 'pending', ?, ?),
    (2, NULL, .55, 'Private.', 'Versicherungen', 'expense', 'pending', ?, ?)`)
    .run(timestamp, timestamp, timestamp, timestamp);
  database.prepare(`INSERT INTO category_suggestions (yuvomi_user_id, suggested_name, suggested_type, reason, sample_count, status, created_at) VALUES (7, 'Versicherungen', 'expense', 'Wiederkehrende Zahlung.', 1, 'pending', ?)`)
    .run(timestamp);
  return database;
}

function headers(): Record<string, string> {
  return {
    'content-type': 'application/json', origin: config.publicOrigin,
    cookie: 'yuvomi.sid=test; banking.csrf=review-csrf', 'x-banking-csrf': 'review-csrf'
  };
}

test('review contract is enriched, scoped, and supports protected dismissal', async () => {
  const database = fixture();
  const { server, origin } = await listen(createApp({
    database, clock: () => NOW,
    resolveSession: async () => ({ id: 7, permissions: { modules: { 'ext:banking': 'write' } } })
  }));
  try {
    const reviews = await fetch(`${origin}/api/extensions/banking/categorization/reviews`, { headers: { cookie: 'yuvomi.sid=test' } });
    assert.equal(reviews.status, 200);
    assert.deepEqual((await reviews.json()).data, [{
      id: 1, transaction_id: 1,
      transaction: { merchant_name: 'PayPal Europe', counterparty_name: null, purpose: 'Google Payment Ireland', amount_cents: -1499, currency: 'EUR', direction: 'outgoing', booking_date: '2026-09-21' },
      proposal: { category_id: 1, category_name: 'Shopping', suggested_category_name: null, suggested_category_type: null, confidence: .65, confidence_level: 'low', reason: 'Google-Play-Kauf erkannt.' },
      can_accept_existing: true, requires_new_category: false, can_remember_counterparty: false
    }]);

    const summary = await fetch(`${origin}/api/extensions/banking/categorization/summary`, { headers: { cookie: 'yuvomi.sid=test' } });
    assert.deepEqual((await summary.json()).data, { uncategorized: 1, pending_reviews: 1, pending_category_suggestions: 1, ai_applied_total: 0 });

    const foreignDismiss = await fetch(`${origin}/api/extensions/banking/categorization/reviews/2/dismiss`, { method: 'POST', headers: headers(), body: '{}' });
    assert.equal(foreignDismiss.status, 404);
    const dismissed = await fetch(`${origin}/api/extensions/banking/categorization/reviews/1/dismiss`, { method: 'POST', headers: headers(), body: '{}' });
    assert.deepEqual((await dismissed.json()).data, { id: 1, status: 'dismissed' });
    assert.deepEqual({ ...(database.prepare('SELECT status, resolved_at FROM ai_categorization_reviews WHERE id = 1').get() as Record<string, unknown>) }, { status: 'dismissed', resolved_at: NOW.toISOString() });
  } finally { await close(server); database.close(); }
});

test('category suggestions expose review previews and allow a normalized custom name', async () => {
  const database = fixture();
  database.prepare(`UPDATE transactions SET account_id = 1 WHERE id = 2`).run();
  const { server, origin } = await listen(createApp({
    database, clock: () => NOW,
    resolveSession: async () => ({ id: 7, permissions: { modules: { 'ext:banking': 'write' } } })
  }));
  try {
    const suggestions = await fetch(`${origin}/api/extensions/banking/category-suggestions`, { headers: { cookie: 'yuvomi.sid=test' } });
    const listed = (await suggestions.json()).data[0];
    assert.equal(listed.matching_review_count, 1);
    assert.equal(listed.examples.length, 1);
    const accepted = await fetch(`${origin}/api/extensions/banking/category-suggestions/1/accept`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ name: '  ETF / Versicherungen  ' })
    });
    assert.deepEqual((await accepted.json()).data, {
      id: 1, status: 'accepted',
      category: { id: 2, name: 'ETF / Versicherungen', type: 'expense', created: true },
      matching_pending_reviews: 1
    });
  } finally { await close(server); database.close(); }
});
