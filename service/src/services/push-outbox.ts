import type { DatabaseSync } from 'node:sqlite';
import { createEncryptionService } from '../security/encryption.js';

export type BankingNotificationType = 'proposal' | 'sync_failed' | 'test';

export interface BankingPushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  image?: string;
}

export function enqueuePushDelivery(
  database: DatabaseSync,
  input: {
    suggestionId?: number | null;
    subscriptionId?: number | null;
    recipientYuvomiUserId: number;
    idempotencyKey: string;
    notificationType: BankingNotificationType;
    payload: BankingPushPayload;
    now: Date;
  }
): { id: number; created: boolean } {
  validateOutboxInput(input);
  const now = input.now.toISOString();
  const encrypted = createEncryptionService().encrypt(JSON.stringify(input.payload));
  const result = database.prepare(`
    INSERT INTO weekly_budget_notification_deliveries (
      suggestion_id, subscription_id, recipient_yuvomi_user_id, idempotency_key,
      notification_type, payload_encrypted, status, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `).run(
    input.suggestionId ?? null,
    input.subscriptionId ?? null,
    input.recipientYuvomiUserId,
    input.idempotencyKey,
    input.notificationType,
    encrypted,
    now,
    now,
    now
  );
  if (Number(result.changes) === 1) return { id: Number(result.lastInsertRowid), created: true };
  const row = database.prepare(`
    SELECT id FROM weekly_budget_notification_deliveries WHERE idempotency_key = ?
  `).get(input.idempotencyKey) as { id: number } | undefined;
  if (!row) throw new Error('Notification delivery could not be queued.');
  return { id: Number(row.id), created: false };
}

function validateOutboxInput(input: {
  recipientYuvomiUserId: number;
  idempotencyKey: string;
  notificationType: BankingNotificationType;
  payload: BankingPushPayload;
  now: Date;
}): void {
  if (!Number.isSafeInteger(input.recipientYuvomiUserId) || input.recipientYuvomiUserId < 1) {
    throw new Error('Notification recipient is invalid.');
  }
  if (!/^[A-Za-z0-9:_-]{1,200}$/.test(input.idempotencyKey)) {
    throw new Error('Notification idempotency key is invalid.');
  }
  if (!['proposal', 'sync_failed', 'test'].includes(input.notificationType)) {
    throw new Error('Notification type is invalid.');
  }
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new Error('Notification time is invalid.');
  }
  for (const key of ['title', 'body', 'url', 'tag'] as const) {
    if (typeof input.payload[key] !== 'string' || !input.payload[key]) {
      throw new Error('Notification payload is invalid.');
    }
  }
}
