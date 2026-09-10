-- Persist the two daily account-sync slots and their retry state.
-- Existing migrations are append-only and must not be edited.

ALTER TABLE weekly_budget_configs ADD COLUMN effective_from_at TEXT;

UPDATE weekly_budget_configs
SET effective_from_at = COALESCE(created_at, updated_at)
WHERE effective_from_at IS NULL;

CREATE TABLE scheduled_account_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL REFERENCES weekly_budget_configs(id) ON DELETE RESTRICT,
  run_key TEXT NOT NULL UNIQUE,
  slot_time TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('scheduled', 'catch_up')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running', 'succeeded', 'failed', 'skipped')),
  scheduled_for TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  source_sync_status TEXT
    CHECK(source_sync_status IS NULL OR source_sync_status IN ('pending', 'succeeded', 'failed', 'skipped')),
  target_sync_status TEXT
    CHECK(target_sync_status IS NULL OR target_sync_status IN ('pending', 'succeeded', 'failed', 'skipped')),
  source_imported_count INTEGER NOT NULL DEFAULT 0 CHECK(source_imported_count >= 0),
  target_imported_count INTEGER NOT NULL DEFAULT 0 CHECK(target_imported_count >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_scheduled_account_sync_runs_due
  ON scheduled_account_sync_runs(status, scheduled_for, lease_expires_at);

CREATE INDEX idx_scheduled_account_sync_runs_config
  ON scheduled_account_sync_runs(config_id, scheduled_for DESC);
