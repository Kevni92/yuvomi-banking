import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createEncryptionService } from '../security/encryption.js';

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;
const MAX_DEVICE_NAME_LENGTH = 80;

export interface BrowserPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PublicPushSubscription {
  id: number;
  device_name: string | null;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
}

export class PushSubscriptionValidationError extends Error {}
export class PushSubscriptionNotFoundError extends Error {}

export function validateBrowserPushSubscription(value: unknown): BrowserPushSubscription {
  if (!isRecord(value) || !isRecord(value.keys)) {
    throw new PushSubscriptionValidationError('Push subscription is invalid.');
  }
  const endpoint = validEndpoint(value.endpoint);
  const p256dh = validKey(value.keys.p256dh);
  const auth = validKey(value.keys.auth);
  const expirationTime = value.expirationTime;
  if (expirationTime !== undefined && expirationTime !== null
    && (typeof expirationTime !== 'number'
      || !Number.isFinite(expirationTime) || expirationTime < 0)) {
    throw new PushSubscriptionValidationError('Push subscription expiration is invalid.');
  }
  return {
    endpoint,
    expirationTime: typeof expirationTime === 'number' ? expirationTime : null,
    keys: { p256dh, auth }
  };
}

export function upsertPushSubscription(
  database: DatabaseSync,
  input: {
    yuvomiUserId: number;
    subscription: unknown;
    deviceName?: unknown;
    now: Date;
  }
): { id: number; created: boolean; subscription: PublicPushSubscription } {
  const subscription = validateBrowserPushSubscription(input.subscription);
  const deviceName = optionalDeviceName(input.deviceName);
  const now = timestamp(input.now);
  const endpointFingerprint = fingerprint(subscription.endpoint);
  const encrypted = createEncryptionService().encrypt(JSON.stringify(subscription));

  database.exec('BEGIN IMMEDIATE;');
  try {
    const existing = database.prepare(`
      SELECT id FROM banking_push_subscriptions WHERE endpoint_fingerprint = ?
    `).get(endpointFingerprint) as { id: number } | undefined;
    let id: number;
    let created = false;
    if (existing) {
      id = Number(existing.id);
      database.prepare(`
        UPDATE banking_push_subscriptions SET
          yuvomi_user_id = ?, subscription_encrypted = ?, device_name = ?,
          status = 'active', updated_at = ?, disabled_at = NULL, disabled_reason = NULL
        WHERE id = ?
      `).run(input.yuvomiUserId, encrypted, deviceName, now, id);
    } else {
      const result = database.prepare(`
        INSERT INTO banking_push_subscriptions (
          yuvomi_user_id, endpoint_fingerprint, subscription_encrypted,
          device_name, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(input.yuvomiUserId, endpointFingerprint, encrypted, deviceName, now, now);
      id = Number(result.lastInsertRowid);
      created = true;
    }
    const row = findPublicPushSubscription(database, id);
    database.exec('COMMIT;');
    return { id, created, subscription: row };
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* preserve original error */ }
    throw error;
  }
}

export function listPushSubscriptions(
  database: DatabaseSync,
  yuvomiUserId: number
): PublicPushSubscription[] {
  return database.prepare(`
    SELECT id, device_name, status, created_at, updated_at, last_success_at
    FROM banking_push_subscriptions
    WHERE yuvomi_user_id = ?
    ORDER BY status ASC, updated_at DESC, id DESC
  `).all(yuvomiUserId).map(publicRow);
}

export function listPushRecipients(database: DatabaseSync): Array<{
  yuvomi_user_id: number;
  subscription_count: number;
}> {
  return database.prepare(`
    SELECT yuvomi_user_id, COUNT(*) AS subscription_count
    FROM banking_push_subscriptions
    WHERE status = 'active'
    GROUP BY yuvomi_user_id
    ORDER BY yuvomi_user_id ASC
  `).all().map((row) => ({
    yuvomi_user_id: Number((row as Record<string, unknown>).yuvomi_user_id),
    subscription_count: Number((row as Record<string, unknown>).subscription_count)
  }));
}

export function disablePushSubscription(
  database: DatabaseSync,
  input: { yuvomiUserId: number; subscriptionId: number; now: Date; reason?: string }
): void {
  const result = database.prepare(`
    UPDATE banking_push_subscriptions SET
      status = 'disabled', disabled_at = ?, disabled_reason = ?, updated_at = ?
    WHERE id = ? AND yuvomi_user_id = ? AND status = 'active'
  `).run(
    timestamp(input.now),
    input.reason ?? 'user_unsubscribed',
    timestamp(input.now),
    input.subscriptionId,
    input.yuvomiUserId
  );
  if (Number(result.changes) !== 1) {
    throw new PushSubscriptionNotFoundError('Active push subscription was not found.');
  }
}

export function activePushSubscriptionCount(database: DatabaseSync, yuvomiUserId: number): number {
  return Number(database.prepare(`
    SELECT COUNT(*) AS count FROM banking_push_subscriptions
    WHERE yuvomi_user_id = ? AND status = 'active'
  `).get(yuvomiUserId)?.count ?? 0);
}

function findPublicPushSubscription(database: DatabaseSync, id: number): PublicPushSubscription {
  const row = database.prepare(`
    SELECT id, device_name, status, created_at, updated_at, last_success_at
    FROM banking_push_subscriptions WHERE id = ?
  `).get(id);
  if (!row) throw new Error('Push subscription could not be stored.');
  return publicRow(row);
}

function publicRow(row: unknown): PublicPushSubscription {
  const value = row as Record<string, unknown>;
  return {
    id: Number(value.id),
    device_name: typeof value.device_name === 'string' ? value.device_name : null,
    status: value.status === 'disabled' ? 'disabled' : 'active',
    created_at: String(value.created_at),
    updated_at: String(value.updated_at),
    last_success_at: typeof value.last_success_at === 'string' ? value.last_success_at : null
  };
}

function validEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ENDPOINT_LENGTH) {
    throw new PushSubscriptionValidationError('Push subscription endpoint is invalid.');
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch {
    throw new PushSubscriptionValidationError('Push subscription endpoint is invalid.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname
    || isIpLiteral(parsed.hostname)) {
    throw new PushSubscriptionValidationError('Push subscription endpoint is invalid.');
  }
  return parsed.toString();
}

function validKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_KEY_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PushSubscriptionValidationError('Push subscription key is invalid.');
  }
  return value;
}

function optionalDeviceName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new PushSubscriptionValidationError('Push subscription device name is invalid.');
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > MAX_DEVICE_NAME_LENGTH) {
    throw new PushSubscriptionValidationError('Push subscription device name is invalid.');
  }
  return normalized;
}

function fingerprint(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint, 'utf8').digest('hex');
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

function timestamp(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new PushSubscriptionValidationError('Push subscription time is invalid.');
  return value.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
