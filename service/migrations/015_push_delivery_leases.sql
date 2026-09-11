-- A delivery stays pending while leased. This supports crash recovery without
-- widening the externally visible delivery status vocabulary.

ALTER TABLE weekly_budget_notification_deliveries
  ADD COLUMN lease_owner TEXT;

ALTER TABLE weekly_budget_notification_deliveries
  ADD COLUMN lease_expires_at TEXT;

CREATE INDEX idx_weekly_budget_notification_deliveries_lease
  ON weekly_budget_notification_deliveries(status, next_attempt_at, lease_expires_at, id);
