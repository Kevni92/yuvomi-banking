-- Banking owns its Web-Push channel. Subscription endpoints and keys are
-- encrypted before persistence; the endpoint fingerprint is only for dedupe.

CREATE TABLE banking_push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  yuvomi_user_id INTEGER NOT NULL,
  endpoint_fingerprint TEXT NOT NULL UNIQUE,
  subscription_encrypted TEXT NOT NULL,
  device_name TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  disabled_at TEXT,
  disabled_reason TEXT
);

CREATE INDEX idx_banking_push_subscriptions_active_user
  ON banking_push_subscriptions(yuvomi_user_id, status, id);

-- This is a durable outbox and delivery history. A later worker claims only
-- pending rows and can safely retry because the idempotency key is unique.
CREATE TABLE weekly_budget_notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id INTEGER REFERENCES transfer_suggestions(id) ON DELETE SET NULL,
  subscription_id INTEGER REFERENCES banking_push_subscriptions(id) ON DELETE SET NULL,
  recipient_yuvomi_user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  notification_type TEXT NOT NULL
    CHECK (notification_type IN ('proposal', 'sync_failed', 'test')),
  payload_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'no_subscription')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  sent_at TEXT,
  failed_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_weekly_budget_notification_deliveries_pending
  ON weekly_budget_notification_deliveries(status, next_attempt_at, id);

CREATE INDEX idx_weekly_budget_notification_deliveries_suggestion
  ON weekly_budget_notification_deliveries(suggestion_id, id);
