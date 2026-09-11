import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { migrateDatabase } from '../src/db/database.js';
import { enqueuePushDelivery } from '../src/services/push-outbox.js';
import {
  sendDuePushDeliveries,
  type PushSender
} from '../src/services/push-delivery-worker.js';
import { upsertPushSubscription } from '../src/services/push-subscriptions.js';

const TEST_KEY = 'f1'.repeat(32);
const NOW = new Date('2026-09-11T14:00:00.000Z');

function fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  migrateDatabase(database);
  return database;
}

function seedDelivery(database: DatabaseSync, idempotencyKey: string): number {
  const subscription = upsertPushSubscription(database, {
    yuvomiUserId: 7,
    subscription: {
      endpoint: `https://fcm.googleapis.com/fcm/send/${idempotencyKey}`,
      keys: { p256dh: 'device_p256dh', auth: 'device_auth' }
    },
    now: NOW
  });
  enqueuePushDelivery(database, {
    subscriptionId: subscription.id,
    recipientYuvomiUserId: 7,
    idempotencyKey,
    notificationType: 'test',
    payload: {
      title: 'Test', body: 'Delivery', url: '/m/banking', tag: `test-${idempotencyKey}`
    },
    now: NOW
  });
  return subscription.id;
}

test('claims, sends and completes encrypted push deliveries exactly once', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = fixture();
  const sent: string[] = [];
  const sender: PushSender = {
    send: async (subscription, payload) => {
      sent.push(`${subscription.endpoint}:${payload.title}`);
    }
  };
  try {
    const subscriptionId = seedDelivery(database, 'send-once');
    assert.deepEqual(await sendDuePushDeliveries({ database, sender, now: NOW }), {
      sent: 1, retrying: 0, failed: 0, noSubscription: 0, idle: false
    });
    assert.equal(sent.length, 1);
    assert.deepEqual({ ...(database.prepare(`
      SELECT status, attempt_count, lease_owner, lease_expires_at FROM weekly_budget_notification_deliveries
    `).get() as Record<string, unknown>) }, {
      status: 'sent', attempt_count: 1, lease_owner: null, lease_expires_at: null
    });
    assert.equal(database.prepare(
      'SELECT last_success_at FROM banking_push_subscriptions WHERE id = ?'
    ).get(subscriptionId)?.last_success_at, NOW.toISOString());
    assert.deepEqual(await sendDuePushDeliveries({ database, sender, now: NOW }), {
      sent: 0, retrying: 0, failed: 0, noSubscription: 0, idle: true
    });
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});

test('retries transient failures with backoff and disables gone subscriptions', async () => {
  const previousKey = config.secrets.dataEncryptionKey;
  config.secrets.dataEncryptionKey = TEST_KEY;
  const database = fixture();
  try {
    const retrySubscriptionId = seedDelivery(database, 'retry-later');
    const transientSender: PushSender = {
      send: async () => { throw Object.assign(new Error('unavailable'), { statusCode: 503 }); }
    };
    assert.deepEqual(await sendDuePushDeliveries({ database, sender: transientSender, now: NOW }), {
      sent: 0, retrying: 1, failed: 0, noSubscription: 0, idle: false
    });
    const retry = database.prepare(`
      SELECT status, attempt_count, next_attempt_at, lease_owner FROM weekly_budget_notification_deliveries
    `).get() as Record<string, unknown>;
    assert.deepEqual({ ...retry }, {
      status: 'pending', attempt_count: 1,
      next_attempt_at: '2026-09-11T14:01:00.000Z', lease_owner: null
    });
    const successfulSender: PushSender = { send: async () => undefined };
    assert.equal((await sendDuePushDeliveries({
      database, sender: successfulSender, now: new Date('2026-09-11T14:01:00.000Z')
    })).sent, 1);
    assert.equal(database.prepare(
      'SELECT attempt_count FROM weekly_budget_notification_deliveries'
    ).get()?.attempt_count, 2);
    assert.equal(database.prepare(
      'SELECT status FROM banking_push_subscriptions WHERE id = ?'
    ).get(retrySubscriptionId)?.status, 'active');

    const goneSubscriptionId = seedDelivery(database, 'subscription-gone');
    const goneSender: PushSender = {
      send: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); }
    };
    assert.equal((await sendDuePushDeliveries({
      database, sender: goneSender, now: new Date('2026-09-11T14:02:00.000Z')
    })).noSubscription, 1);
    assert.equal(database.prepare(
      'SELECT status FROM banking_push_subscriptions WHERE id = ?'
    ).get(goneSubscriptionId)?.status, 'disabled');
    assert.deepEqual({ ...(database.prepare(`
      SELECT status, last_error_code, lease_owner FROM weekly_budget_notification_deliveries
      WHERE subscription_id = ?
    `).get(goneSubscriptionId) as Record<string, unknown>) }, {
      status: 'no_subscription', last_error_code: 'push_410', lease_owner: null
    });
  } finally {
    database.close();
    config.secrets.dataEncryptionKey = previousKey;
  }
});
