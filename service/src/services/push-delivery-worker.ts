import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import webpush from 'web-push';
import { config } from '../config.js';
import { createEncryptionService } from '../security/encryption.js';
import type { BankingPushPayload } from './push-outbox.js';
import type { BrowserPushSubscription } from './push-subscriptions.js';

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const LEASE_MS = 90_000;

export interface PushSender {
  send(subscription: BrowserPushSubscription, payload: BankingPushPayload): Promise<void>;
}

export interface PushDeliveryWorkerResult {
  sent: number;
  retrying: number;
  failed: number;
  noSubscription: number;
  idle: boolean;
}

interface ClaimedDelivery {
  id: number;
  subscriptionId: number | null;
  subscriptionEncrypted: string | null;
  subscriptionStatus: string | null;
  payloadEncrypted: string;
  attemptCount: number;
  leaseOwner: string;
}

export class VapidPushSender implements PushSender {
  private readonly vapidDetails: { subject: string; publicKey: string; privateKey: string };

  constructor(vapidDetails = configuredVapidDetails()) {
    if (!vapidDetails) throw new Error('VAPID configuration is unavailable.');
    this.vapidDetails = vapidDetails;
  }

  async send(subscription: BrowserPushSubscription, payload: BankingPushPayload): Promise<void> {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      vapidDetails: this.vapidDetails,
      TTL: 86_400,
      urgency: 'high',
      topic: topicForTag(payload.tag)
    });
  }
}

export function configuredVapidDetails(): {
  subject: string;
  publicKey: string;
  privateKey: string;
} | null {
  const { subject, publicKey, privateKey } = config.vapid;
  if (!subject || !publicKey || !privateKey) return null;
  if (!validVapidSubject(subject) || !base64urlValue(publicKey) || !base64urlValue(privateKey)) {
    throw new Error('VAPID configuration is invalid.');
  }
  return { subject, publicKey, privateKey };
}

export async function sendDuePushDeliveries({
  database,
  sender,
  now = new Date(),
  maxDeliveries = 20
}: {
  database: DatabaseSync;
  sender: PushSender;
  now?: Date;
  maxDeliveries?: number;
}): Promise<PushDeliveryWorkerResult> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('Push delivery time is invalid.');
  }
  if (!Number.isSafeInteger(maxDeliveries) || maxDeliveries < 1 || maxDeliveries > 100) {
    throw new Error('Push delivery batch size is invalid.');
  }
  const result: PushDeliveryWorkerResult = {
    sent: 0, retrying: 0, failed: 0, noSubscription: 0, idle: false
  };
  for (let index = 0; index < maxDeliveries; index += 1) {
    const delivery = claimDuePushDelivery(database, now);
    if (!delivery) {
      result.idle = index === 0;
      return result;
    }
    if (!delivery.subscriptionId || delivery.subscriptionStatus !== 'active' || !delivery.subscriptionEncrypted) {
      markNoSubscription(database, delivery, now, 'subscription_inactive');
      result.noSubscription += 1;
      continue;
    }
    try {
      const encryption = createEncryptionService();
      const subscription = JSON.parse(encryption.decrypt(delivery.subscriptionEncrypted)) as BrowserPushSubscription;
      const payload = JSON.parse(encryption.decrypt(delivery.payloadEncrypted)) as BankingPushPayload;
      await sender.send(subscription, payload);
      markSent(database, delivery, now);
      result.sent += 1;
    } catch (error) {
      const statusCode = pushStatusCode(error);
      if (statusCode === 404 || statusCode === 410) {
        disableInvalidSubscription(database, delivery, now, `push_${statusCode}`);
        result.noSubscription += 1;
      } else if (delivery.attemptCount >= RETRY_DELAYS_MS.length + 1 || invalidStoredPushData(error)) {
        markFailed(database, delivery, now, invalidStoredPushData(error) ? 'invalid_stored_push_data' : 'push_failed');
        result.failed += 1;
      } else {
        retryLater(database, delivery, now, retryDelay(delivery.attemptCount), statusCode);
        result.retrying += 1;
      }
    }
  }
  return result;
}

export function startPushDeliveryWorker({
  database,
  sender,
  pollIntervalMs = 30_000,
  clock = () => new Date(),
  onTickError = () => undefined
}: {
  database: DatabaseSync;
  sender: PushSender;
  pollIntervalMs?: number;
  clock?: () => Date;
  onTickError?: (error: unknown) => void;
}): { runNow: () => Promise<PushDeliveryWorkerResult>; stop: () => void } {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1_000) {
    throw new Error('Push delivery worker interval must be at least one second.');
  }
  let stopped = false;
  let activeRun: Promise<PushDeliveryWorkerResult> | null = null;
  const runNow = (): Promise<PushDeliveryWorkerResult> => {
    if (stopped) return Promise.resolve({ sent: 0, retrying: 0, failed: 0, noSubscription: 0, idle: true });
    if (activeRun) return activeRun;
    activeRun = sendDuePushDeliveries({ database, sender, now: clock() })
      .catch((error) => {
        onTickError(error);
        return { sent: 0, retrying: 0, failed: 0, noSubscription: 0, idle: true };
      })
      .finally(() => { activeRun = null; });
    return activeRun;
  };
  const timer = setInterval(() => { void runNow(); }, pollIntervalMs);
  timer.unref();
  void runNow();
  return { runNow, stop: () => { stopped = true; clearInterval(timer); } };
}

function claimDuePushDelivery(database: DatabaseSync, now: Date): ClaimedDelivery | null {
  const nowIso = now.toISOString();
  const owner = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
  database.exec('BEGIN IMMEDIATE;');
  try {
    const row = database.prepare(`
      SELECT deliveries.id, deliveries.subscription_id, deliveries.payload_encrypted,
             deliveries.attempt_count, subscriptions.subscription_encrypted,
             subscriptions.status AS subscription_status
      FROM weekly_budget_notification_deliveries AS deliveries
      LEFT JOIN banking_push_subscriptions AS subscriptions
        ON subscriptions.id = deliveries.subscription_id
      WHERE deliveries.status = 'pending'
        AND (deliveries.next_attempt_at IS NULL OR deliveries.next_attempt_at <= ?)
        AND (deliveries.lease_expires_at IS NULL OR deliveries.lease_expires_at <= ?)
      ORDER BY deliveries.next_attempt_at ASC, deliveries.id ASC
      LIMIT 1
    `).get(nowIso, nowIso) as Record<string, unknown> | undefined;
    if (!row) {
      database.exec('COMMIT;');
      return null;
    }
    const updated = database.prepare(`
      UPDATE weekly_budget_notification_deliveries SET
        lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1,
        updated_at = ?
      WHERE id = ? AND status = 'pending'
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(owner, expiresAt, nowIso, Number(row.id), nowIso);
    if (Number(updated.changes) !== 1) {
      database.exec('COMMIT;');
      return null;
    }
    database.exec('COMMIT;');
    return {
      id: Number(row.id),
      subscriptionId: typeof row.subscription_id === 'number' ? row.subscription_id : null,
      subscriptionEncrypted: typeof row.subscription_encrypted === 'string' ? row.subscription_encrypted : null,
      subscriptionStatus: typeof row.subscription_status === 'string' ? row.subscription_status : null,
      payloadEncrypted: String(row.payload_encrypted),
      attemptCount: Number(row.attempt_count) + 1,
      leaseOwner: owner
    };
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* preserve original error */ }
    throw error;
  }
}

function markSent(database: DatabaseSync, delivery: ClaimedDelivery, now: Date): void {
  const timestamp = now.toISOString();
  const result = database.prepare(`
    UPDATE weekly_budget_notification_deliveries SET
      status = 'sent', sent_at = ?, next_attempt_at = NULL,
      lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
    WHERE id = ? AND status = 'pending' AND lease_owner = ?
  `).run(timestamp, timestamp, delivery.id, delivery.leaseOwner);
  if (Number(result.changes) !== 1) throw new Error('Push delivery lease was lost.');
  if (delivery.subscriptionId) {
    database.prepare(`
      UPDATE banking_push_subscriptions SET last_success_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `).run(timestamp, timestamp, delivery.subscriptionId);
  }
}

function retryLater(
  database: DatabaseSync,
  delivery: ClaimedDelivery,
  now: Date,
  delayMs: number,
  statusCode: number | null
): void {
  updateClaimedDelivery(database, delivery, now, {
    status: 'pending',
    nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
    errorCode: statusCode ? `push_${statusCode}` : 'push_retry'
  });
}

function markFailed(database: DatabaseSync, delivery: ClaimedDelivery, now: Date, errorCode: string): void {
  updateClaimedDelivery(database, delivery, now, {
    status: 'failed', nextAttemptAt: null, errorCode, failedAt: now.toISOString()
  });
}

function markNoSubscription(
  database: DatabaseSync,
  delivery: ClaimedDelivery,
  now: Date,
  errorCode: string
): void {
  updateClaimedDelivery(database, delivery, now, {
    status: 'no_subscription', nextAttemptAt: null, errorCode, failedAt: now.toISOString()
  });
}

function disableInvalidSubscription(
  database: DatabaseSync,
  delivery: ClaimedDelivery,
  now: Date,
  errorCode: string
): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    if (delivery.subscriptionId) {
      database.prepare(`
        UPDATE banking_push_subscriptions SET
          status = 'disabled', disabled_at = ?, disabled_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(now.toISOString(), errorCode, now.toISOString(), delivery.subscriptionId);
    }
    updateClaimedDelivery(database, delivery, now, {
      status: 'no_subscription', nextAttemptAt: null, errorCode, failedAt: now.toISOString()
    });
    database.exec('COMMIT;');
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* preserve original error */ }
    throw error;
  }
}

function updateClaimedDelivery(
  database: DatabaseSync,
  delivery: ClaimedDelivery,
  now: Date,
  input: { status: 'pending' | 'failed' | 'no_subscription'; nextAttemptAt: string | null; errorCode: string; failedAt?: string }
): void {
  const result = database.prepare(`
    UPDATE weekly_budget_notification_deliveries SET
      status = ?, next_attempt_at = ?, failed_at = COALESCE(?, failed_at),
      last_error_code = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'pending' AND lease_owner = ?
  `).run(
    input.status, input.nextAttemptAt, input.failedAt ?? null,
    input.errorCode, now.toISOString(), delivery.id, delivery.leaseOwner
  );
  if (Number(result.changes) !== 1) throw new Error('Push delivery lease was lost.');
}

function retryDelay(attemptCount: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attemptCount - 1, 0), RETRY_DELAYS_MS.length - 1)];
}

function pushStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function invalidStoredPushData(error: unknown): boolean {
  return error instanceof Error && /Invalid encrypted value|Unexpected token/.test(error.message);
}

function validVapidSubject(subject: string): boolean {
  try {
    const url = new URL(subject);
    return (url.protocol === 'mailto:' && Boolean(url.pathname)) || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function base64urlValue(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,200}$/.test(value);
}

function topicForTag(tag: string): string {
  return crypto.createHash('sha256').update(tag, 'utf8').digest('base64url').slice(0, 32);
}
