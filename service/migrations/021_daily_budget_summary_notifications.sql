-- Daily account-sync summaries use the existing durable Banking push outbox.
-- SQLite cannot widen a CHECK constraint in place, so rebuild the outbox while
-- preserving all delivery history and the lease columns added in migration 015.

CREATE TABLE weekly_budget_notification_deliveries_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id INTEGER REFERENCES transfer_suggestions(id) ON DELETE SET NULL,
  subscription_id INTEGER REFERENCES banking_push_subscriptions(id) ON DELETE SET NULL,
  recipient_yuvomi_user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  notification_type TEXT NOT NULL
    CHECK (notification_type IN ('proposal', 'sync_failed', 'test', 'daily_summary')),
  payload_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'no_subscription')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  sent_at TEXT,
  failed_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT
);

INSERT INTO weekly_budget_notification_deliveries_new (
  id, suggestion_id, subscription_id, recipient_yuvomi_user_id,
  idempotency_key, notification_type, payload_encrypted, status,
  attempt_count, next_attempt_at, sent_at, failed_at, last_error_code,
  created_at, updated_at, lease_owner, lease_expires_at
)
SELECT
  id, suggestion_id, subscription_id, recipient_yuvomi_user_id,
  idempotency_key, notification_type, payload_encrypted, status,
  attempt_count, next_attempt_at, sent_at, failed_at, last_error_code,
  created_at, updated_at, lease_owner, lease_expires_at
FROM weekly_budget_notification_deliveries;

DROP TABLE weekly_budget_notification_deliveries;
ALTER TABLE weekly_budget_notification_deliveries_new
  RENAME TO weekly_budget_notification_deliveries;

CREATE INDEX idx_weekly_budget_notification_deliveries_pending
  ON weekly_budget_notification_deliveries(status, next_attempt_at, id);

CREATE INDEX idx_weekly_budget_notification_deliveries_suggestion
  ON weekly_budget_notification_deliveries(suggestion_id, id);

CREATE INDEX idx_weekly_budget_notification_deliveries_lease
  ON weekly_budget_notification_deliveries(status, next_attempt_at, lease_expires_at, id);
