-- Standalone weekly-budget foundation.
-- Existing migrations are append-only and must not be edited.

ALTER TABLE categories
  ADD COLUMN weekly_budget_default INTEGER NOT NULL DEFAULT 0
    CHECK(weekly_budget_default IN (0, 1));

ALTER TABLE transactions
  ADD COLUMN weekly_budget_override TEXT NOT NULL DEFAULT 'inherit'
    CHECK(weekly_budget_override IN ('inherit', 'include', 'exclude'));

CREATE TABLE weekly_budget_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  yuvomi_user_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  source_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  target_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  target_amount_cents INTEGER NOT NULL CHECK(target_amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency = 'EUR'),
  cutoff_weekday INTEGER NOT NULL CHECK(cutoff_weekday BETWEEN 1 AND 7),
  cutoff_time TEXT NOT NULL
    CHECK(
      cutoff_time GLOB '[0-2][0-9]:[0-5][0-9]'
      AND cutoff_time < '24:00'
    ),
  timezone TEXT NOT NULL DEFAULT 'Europe/Berlin' CHECK(length(trim(timezone)) > 0),
  sync_time_1 TEXT NOT NULL DEFAULT '06:00'
    CHECK(
      sync_time_1 GLOB '[0-2][0-9]:[0-5][0-9]'
      AND sync_time_1 < '24:00'
    ),
  sync_time_2 TEXT NOT NULL DEFAULT '18:00'
    CHECK(
      sync_time_2 GLOB '[0-2][0-9]:[0-5][0-9]'
      AND sync_time_2 < '24:00'
    ),
  balance_stale_after_minutes INTEGER NOT NULL DEFAULT 840
    CHECK(balance_stale_after_minutes > 0),
  notification_enabled INTEGER NOT NULL DEFAULT 0
    CHECK(notification_enabled IN (0, 1)),
  notification_user_id INTEGER,
  notification_qr_preview INTEGER NOT NULL DEFAULT 0
    CHECK(notification_qr_preview IN (0, 1)),
  purpose_prefix TEXT NOT NULL DEFAULT 'WB'
    CHECK(length(trim(purpose_prefix)) BETWEEN 1 AND 10),
  effective_from_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(source_account_id <> target_account_id),
  CHECK(notification_enabled = 0 OR notification_user_id IS NOT NULL)
);

CREATE UNIQUE INDEX idx_weekly_budget_configs_active_user
  ON weekly_budget_configs(yuvomi_user_id)
  WHERE enabled = 1;

CREATE INDEX idx_weekly_budget_configs_accounts
  ON weekly_budget_configs(source_account_id, target_account_id);

CREATE TABLE account_balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  sync_run_key TEXT,
  provider_balance_type TEXT NOT NULL,
  normalized_balance_type TEXT NOT NULL
    CHECK(normalized_balance_type IN (
      'available', 'interim_available', 'closing_booked', 'expected', 'other'
    )),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  observed_at TEXT,
  fetched_at TEXT NOT NULL,
  usable_for_weekly_budget INTEGER NOT NULL DEFAULT 0
    CHECK(usable_for_weekly_budget IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(account_id, fetched_at, provider_balance_type)
);

CREATE INDEX idx_balance_snapshots_account_fetched
  ON account_balance_snapshots(account_id, fetched_at DESC);

CREATE INDEX idx_balance_snapshots_usable
  ON account_balance_snapshots(account_id, usable_for_weekly_budget, fetched_at DESC);

CREATE TABLE weekly_budget_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL REFERENCES weekly_budget_configs(id) ON DELETE RESTRICT,
  period_key TEXT NOT NULL,
  period_start_date TEXT NOT NULL,
  period_end_date TEXT NOT NULL,
  scheduled_cutoff_at TEXT NOT NULL,
  finalized_at TEXT,
  trigger TEXT NOT NULL CHECK(trigger IN ('scheduled', 'catch_up', 'manual')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open', 'finalized', 'failed')),
  source_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL,
  source_account_name TEXT,
  target_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL,
  target_account_name TEXT,
  target_amount_cents INTEGER NOT NULL CHECK(target_amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency = 'EUR'),
  target_balance_snapshot_id INTEGER
    REFERENCES account_balance_snapshots(id) ON DELETE SET NULL,
  target_balance_cents INTEGER,
  direct_expense_cents INTEGER NOT NULL DEFAULT 0 CHECK(direct_expense_cents >= 0),
  raw_computed_amount_cents INTEGER,
  computed_amount_cents INTEGER CHECK(computed_amount_cents >= 0),
  overfunded_cents INTEGER NOT NULL DEFAULT 0 CHECK(overfunded_cents >= 0),
  calculation_version TEXT NOT NULL,
  source_sync_completed_at TEXT,
  target_sync_completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(period_start_date < period_end_date),
  UNIQUE(config_id, period_key)
);

CREATE INDEX idx_weekly_budget_periods_history
  ON weekly_budget_periods(config_id, scheduled_cutoff_at DESC);

CREATE INDEX idx_weekly_budget_periods_status
  ON weekly_budget_periods(status, scheduled_cutoff_at);

CREATE TABLE weekly_budget_period_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES weekly_budget_periods(id) ON DELETE RESTRICT,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  transaction_key TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  state TEXT NOT NULL
    CHECK(state IN ('included', 'late_candidate', 'removed_in_revision')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency = 'EUR'),
  booking_date TEXT NOT NULL,
  counterparty_name TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_name TEXT,
  weekly_budget_override TEXT NOT NULL
    CHECK(weekly_budget_override IN ('inherit', 'include', 'exclude')),
  decision_source TEXT NOT NULL
    CHECK(decision_source IN ('transaction_override', 'category_default')),
  created_at TEXT NOT NULL,
  UNIQUE(period_id, transaction_key, revision, state)
);

CREATE INDEX idx_weekly_budget_period_transactions_period
  ON weekly_budget_period_transactions(period_id, revision, state);

CREATE INDEX idx_weekly_budget_period_transactions_transaction
  ON weekly_budget_period_transactions(transaction_id);

CREATE INDEX idx_transactions_weekly_budget_period_lookup
  ON transactions(account_id, status, booking_date, weekly_budget_override);

CREATE TABLE weekly_budget_job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL REFERENCES weekly_budget_configs(id) ON DELETE RESTRICT,
  period_id INTEGER REFERENCES weekly_budget_periods(id) ON DELETE SET NULL,
  run_key TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL CHECK(trigger IN ('scheduled', 'catch_up', 'manual')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  scheduled_for TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  source_sync_status TEXT
    CHECK(source_sync_status IS NULL OR source_sync_status IN ('pending', 'succeeded', 'failed')),
  target_sync_status TEXT
    CHECK(target_sync_status IS NULL OR target_sync_status IN ('pending', 'succeeded', 'failed')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_weekly_budget_job_runs_due
  ON weekly_budget_job_runs(status, scheduled_for, lease_expires_at);

-- Rebuild suggestions so calculations can be revisioned without losing legacy
-- records. period_id remains nullable only for suggestions from pre-v7 data.
CREATE TABLE transfer_suggestions_v7 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER REFERENCES weekly_budget_periods(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  source_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  target_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  target_amount_cents INTEGER NOT NULL
    CHECK(period_id IS NULL OR target_amount_cents > 0),
  target_balance_cents INTEGER,
  computed_amount_cents INTEGER NOT NULL
    CHECK(period_id IS NULL OR computed_amount_cents >= 0),
  deducted_amount_cents INTEGER NOT NULL DEFAULT 0
    CHECK(period_id IS NULL OR deducted_amount_cents >= 0),
  raw_computed_amount_cents INTEGER,
  overfunded_cents INTEGER NOT NULL DEFAULT 0
    CHECK(period_id IS NULL OR overfunded_cents >= 0),
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  purpose TEXT,
  payload_sha256 TEXT,
  calculation_version TEXT NOT NULL DEFAULT 'legacy-v1',
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK(status IN (
      'proposed', 'shown', 'notified', 'completed', 'dismissed',
      'superseded', 'failed', 'no_transfer'
    )),
  matched_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  matched_source_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  matched_target_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  generated_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(period_id IS NULL OR source_account_id <> target_account_id),
  CHECK(period_id IS NULL OR week_start < week_end),
  UNIQUE(period_id, revision)
);

INSERT INTO transfer_suggestions_v7 (
  id, source_account_id, target_account_id, target_amount_cents,
  computed_amount_cents, deducted_amount_cents, week_start, week_end,
  purpose, status, matched_transaction_id, generated_at, created_at, updated_at
)
SELECT
  id, source_account_id, target_account_id, target_amount_cents,
  computed_amount_cents, deducted_amount_cents, week_start, week_end,
  purpose, status, matched_transaction_id, created_at, created_at, updated_at
FROM transfer_suggestions;

DROP INDEX IF EXISTS idx_transfer_suggestions_week_status;
DROP TABLE transfer_suggestions;
ALTER TABLE transfer_suggestions_v7 RENAME TO transfer_suggestions;

CREATE INDEX idx_transfer_suggestions_week_status
  ON transfer_suggestions(week_start, status);

CREATE INDEX idx_transfer_suggestions_period_revision
  ON transfer_suggestions(period_id, revision DESC);
