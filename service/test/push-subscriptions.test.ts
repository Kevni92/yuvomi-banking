import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';
import { enqueuePushDelivery } from '../src/services/push-outbox.js';
import {
  disablePushSubscription,
  listPushRecipients,
  listPushSubscriptions,
  PushSubscriptionValidationError,
  upsertPushSubscription,
  validateBrowserPushSubscription
} from '../src/services/push-subscriptions.js';
import { createServer, type Server } from 'node:http';

const TEST_KEY = 'ef'.repeat(32);
const NOW = new Date('2026-09-11T12:00:00.000Z');
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-device-opaque-token',
  expirationTime: null,
  keys: { p256dh: 'BOGUS_P256DH_base64url', auth: 'BOGUS_AUTH_base64url' }
};

function fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  return database;
}

test('stores browser subscriptions encrypted and exposes only safe metadata', () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = fixture();
  try {
    const stored = upsertPushSubscription(database, {
      yuvomiUserId: 7, subscription, deviceName: '  Firefox  desktop ', now: NOW
    });
    assert.equal(stored.created, true);
    assert.deepEqual(stored.subscription, {
      id: 1,
      device_name: 'Firefox desktop',
      status: 'active',
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      last_success_at: null
    });
    const raw = database.prepare(`
      SELECT endpoint_fingerprint, subscription_encrypted FROM banking_push_subscriptions
    `).get() as { endpoint_fingerprint: string; subscription_encrypted: string };
    assert.match(raw.endpoint_fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(raw.subscription_encrypted, /fcm\.googleapis|P256DH|AUTH/);
    assert.doesNotMatch(JSON.stringify(listPushSubscriptions(database, 7)), /endpoint|p256dh|auth/i);
    assert.deepEqual(listPushRecipients(database), [{ yuvomi_user_id: 7, subscription_count: 1 }]);

    const updated = upsertPushSubscription(database, {
      yuvomiUserId: 8, subscription, deviceName: 'Phone', now: new Date('2026-09-11T13:00:00.000Z')
    });
    assert.equal(updated.created, false);
    assert.equal(updated.id, 1);
    assert.deepEqual(listPushSubscriptions(database, 7), []);
    assert.equal(listPushSubscriptions(database, 8)[0]?.device_name, 'Phone');

    disablePushSubscription(database, { yuvomiUserId: 8, subscriptionId: 1, now: NOW });
    assert.deepEqual(listPushRecipients(database), []);
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});

test('rejects unsafe browser push subscription shapes', () => {
  assert.throws(
    () => validateBrowserPushSubscription({ ...subscription, endpoint: 'http://push.example.test/x' }),
    PushSubscriptionValidationError
  );
  assert.throws(
    () => validateBrowserPushSubscription({ ...subscription, endpoint: 'https://127.0.0.1/x' }),
    PushSubscriptionValidationError
  );
  assert.throws(
    () => validateBrowserPushSubscription({ ...subscription, keys: { p256dh: 'a=', auth: 'ok' } }),
    PushSubscriptionValidationError
  );
});

test('notification outbox encrypts payloads and deduplicates its idempotency key', () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = fixture();
  try {
    const input = {
      recipientYuvomiUserId: 7,
      idempotencyKey: 'weekly-budget:1:2026-09-13:revision:1:subscription:9',
      notificationType: 'proposal' as const,
      payload: {
        title: 'Wochenbudget: 320,00 EUR überweisen',
        body: '450,00 EUR - 30,00 EUR Direkt - 100,00 EUR Budget-Konto = 320,00 EUR',
        url: '/m/banking?view=weekly-transfer&id=12',
        tag: 'banking-weekly-budget-1-weekly-budget-1-2026-09-13'
      },
      now: NOW
    };
    const first = enqueuePushDelivery(database, input);
    const replay = enqueuePushDelivery(database, input);
    assert.deepEqual(first, { id: 1, created: true });
    assert.deepEqual(replay, { id: 1, created: false });
    const row = database.prepare(`
      SELECT payload_encrypted, status, attempt_count
      FROM weekly_budget_notification_deliveries
    `).get() as { payload_encrypted: string; status: string; attempt_count: number };
    assert.doesNotMatch(row.payload_encrypted, /Wochenbudget|weekly-transfer/);
    assert.deepEqual({ status: row.status, attempt_count: row.attempt_count }, {
      status: 'pending', attempt_count: 0
    });
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});

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

test('push routes require write CSRF and keep subscriptions user-scoped', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = fixture();
  let userId = 7;
  const { server, origin } = await listen(createApp({
    database,
    resolveSession: async () => ({
      id: userId, display_name: 'User', role: 'parent',
      permissions: { modules: { 'ext:banking': 'write' as const } }
    }),
    clock: () => NOW
  }));
  const headers = {
    'content-type': 'application/json', origin: config.publicOrigin,
    cookie: 'yuvomi.sid=test; banking.csrf=push-csrf', 'x-banking-csrf': 'push-csrf'
  };
  try {
    const denied = await fetch(`${origin}/api/extensions/banking/push/subscriptions`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: 'yuvomi.sid=test' },
      body: JSON.stringify({ subscription })
    });
    assert.equal(denied.status, 403);

    const created = await fetch(`${origin}/api/extensions/banking/push/subscriptions`, {
      method: 'POST', headers, body: JSON.stringify({ subscription, device_name: 'Browser' })
    });
    assert.equal(created.status, 201);
    assert.doesNotMatch(JSON.stringify(await created.json()), /fcm\.googleapis|p256dh|auth/i);

    userId = 8;
    const otherList = await fetch(`${origin}/api/extensions/banking/push/subscriptions`, {
      headers: { cookie: 'yuvomi.sid=test' }
    });
    assert.deepEqual((await otherList.json()).data, []);
    const forbiddenDelete = await fetch(`${origin}/api/extensions/banking/push/subscriptions/1`, {
      method: 'DELETE', headers
    });
    assert.equal(forbiddenDelete.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});
