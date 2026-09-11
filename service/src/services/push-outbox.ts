import type { DatabaseSync } from 'node:sqlite';
import { createEncryptionService } from '../security/encryption.js';
import { formatEuroCents } from './weekly-budget.js';
import { createGiroCodeImageCapability } from './girocode-image-tokens.js';

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

export function enqueueWeeklyBudgetProposalDeliveries(
  database: DatabaseSync,
  input: {
    configId: number;
    periodKey: string;
    suggestionId: number;
    revision: number;
    targetAmountCents: number;
    directExpenseCents: number;
    targetBalanceCents: number;
    transferAmountCents: number;
    now: Date;
  }
): number {
  const config = database.prepare(`
    SELECT notification_enabled, notification_user_id, notification_qr_preview,
           cutoff_weekday, cutoff_time, timezone
    FROM weekly_budget_configs WHERE id = ?
  `).get(input.configId) as {
    notification_enabled: number;
    notification_user_id: number | null;
    notification_qr_preview: number;
    cutoff_weekday: number;
    cutoff_time: string;
    timezone: string;
  } | undefined;
  if (!config || !config.notification_enabled || !config.notification_user_id) return 0;
  const subscriptions = database.prepare(`
    SELECT id FROM banking_push_subscriptions
    WHERE yuvomi_user_id = ? AND status = 'active'
    ORDER BY id
  `).all(config.notification_user_id) as Array<{ id: number }>;
  const payload = weeklyBudgetPayload(input);
  if (config.notification_qr_preview && input.transferAmountCents > 0) {
    payload.image = createGiroCodeImageCapability(database, {
      suggestionId: input.suggestionId,
      cutoffWeekday: Number(config.cutoff_weekday),
      cutoffTime: String(config.cutoff_time),
      timezone: String(config.timezone),
      now: input.now
    }).imagePath;
  }
  let queued = 0;
  for (const subscription of subscriptions) {
    const result = enqueuePushDelivery(database, {
      suggestionId: input.suggestionId,
      subscriptionId: Number(subscription.id),
      recipientYuvomiUserId: Number(config.notification_user_id),
      idempotencyKey: `weekly-budget:${input.configId}:${input.periodKey}:revision:${input.revision}:subscription:${subscription.id}`,
      notificationType: 'proposal',
      payload,
      now: input.now
    });
    if (result.created) queued += 1;
  }
  return queued;
}

function weeklyBudgetPayload(input: {
  configId: number;
  periodKey: string;
  suggestionId: number;
  targetAmountCents: number;
  directExpenseCents: number;
  targetBalanceCents: number;
  transferAmountCents: number;
}): BankingPushPayload {
  const transferAmount = formatEuroCents(input.transferAmountCents);
  if (input.transferAmountCents === 0) {
    return {
      title: 'Wochenbudget: keine Überweisung nötig',
      body: 'Ziel und vorhandenes Guthaben decken die neue Woche ab.',
      url: `/m/banking?view=weekly-transfer&id=${input.suggestionId}`,
      tag: `banking-weekly-budget-${input.configId}-${input.periodKey}`
    };
  }
  return {
    title: `Wochenbudget: ${transferAmount} EUR überweisen`,
    body: `${formatEuroCents(input.targetAmountCents)} EUR - ${formatEuroCents(input.directExpenseCents)} EUR Direkt - ${formatEuroCents(input.targetBalanceCents)} EUR N26 = ${transferAmount} EUR`,
    url: `/m/banking?view=weekly-transfer&id=${input.suggestionId}`,
    tag: `banking-weekly-budget-${input.configId}-${input.periodKey}`
  };
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
  if (!/^[A-Za-z0-9:._-]{1,200}$/.test(input.idempotencyKey)) {
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
