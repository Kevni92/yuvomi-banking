import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {
  disablePushSubscription,
  listPushRecipients,
  listPushSubscriptions,
  PushSubscriptionNotFoundError,
  PushSubscriptionValidationError,
  upsertPushSubscription
} from '../services/push-subscriptions.js';
import { enqueuePushDelivery } from '../services/push-outbox.js';
import { configuredVapidDetails } from '../services/push-delivery-worker.js';
import {
  mutationIsAllowed,
  noStore,
  resolveAuthorizedUser,
  type SessionResolver
} from './route-security.js';

export function createPushRouter({
  database,
  resolveSession,
  clock = () => new Date()
}: {
  database: DatabaseSync;
  resolveSession: SessionResolver;
  clock?: () => Date;
}): express.Router {
  const router = express.Router();

  router.get('/push/vapid-public-key', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    try {
      const vapid = configuredVapidDetails();
      if (!vapid) {
        noStore(response);
        response.status(503).json({ error: 'Banking push is not configured.' });
        return;
      }
      noStore(response);
      response.json({ data: { public_key: vapid.publicKey } });
    } catch {
      noStore(response);
      response.status(503).json({ error: 'Banking push is not configured.' });
    }
  });

  router.get('/push/subscriptions', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'read');
    if (!user) return;
    noStore(response);
    response.json({ data: listPushSubscriptions(database, user.id) });
  });

  // Recipient IDs are intended to be joined with Yuvomi's public user list in
  // the Settings UI. This endpoint is write-protected to avoid exposing who
  // has Banking notifications enabled to read-only Banking users.
  router.get('/push/recipients', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user) return;
    noStore(response);
    response.json({ data: listPushRecipients(database) });
  });

  router.post('/push/subscriptions', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      const result = upsertPushSubscription(database, {
        yuvomiUserId: user.id,
        subscription: request.body?.subscription ?? request.body,
        deviceName: request.body?.device_name,
        now: clock()
      });
      noStore(response);
      response.status(result.created ? 201 : 200).json({ data: result.subscription });
    } catch (error) {
      noStore(response);
      response.status(error instanceof PushSubscriptionValidationError ? 400 : 500).json({
        error: error instanceof Error ? error.message : 'Push subscription could not be stored.'
      });
    }
  });

  router.delete('/push/subscriptions/:subscriptionId', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      const id = positiveId(request.params.subscriptionId);
      if (!id) throw new PushSubscriptionNotFoundError('Active push subscription was not found.');
      disablePushSubscription(database, {
        yuvomiUserId: user.id,
        subscriptionId: id,
        now: clock()
      });
      noStore(response);
      response.status(204).end();
    } catch (error) {
      noStore(response);
      response.status(error instanceof PushSubscriptionNotFoundError ? 404 : 500).json({
        error: error instanceof Error ? error.message : 'Push subscription could not be removed.'
      });
    }
  });

  router.post('/push/test', async (request, response) => {
    const user = await resolveAuthorizedUser(request, response, resolveSession, 'write');
    if (!user || !mutationIsAllowed(request, response)) return;
    try {
      if (!configuredVapidDetails()) {
        noStore(response);
        response.status(503).json({ error: 'Banking push is not configured.' });
        return;
      }
      const now = clock();
      let queued = 0;
      for (const subscription of listPushSubscriptions(database, user.id)) {
        if (subscription.status !== 'active') continue;
        const result = enqueuePushDelivery(database, {
          subscriptionId: subscription.id,
          recipientYuvomiUserId: user.id,
          idempotencyKey: `push-test:${user.id}:${subscription.id}:${crypto.randomUUID()}`,
          notificationType: 'test',
          payload: {
            title: 'Banking-Benachrichtigung aktiv',
            body: 'Testnachricht des Wochenbudget-Moduls.',
            url: '/m/banking?view=weekly-budget',
            tag: `banking-push-test-${subscription.id}`
          },
          now
        });
        if (result.created) queued += 1;
      }
      noStore(response);
      response.json({ data: { queued } });
    } catch {
      noStore(response);
      response.status(503).json({ error: 'Banking push is not configured.' });
    }
  });

  return router;
}

function positiveId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
