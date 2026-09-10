-- Preserve the scheduling inputs used for every finalized period.
-- Existing migrations are append-only and must not be edited.

ALTER TABLE weekly_budget_periods ADD COLUMN cutoff_weekday INTEGER
  CHECK(cutoff_weekday IS NULL OR cutoff_weekday BETWEEN 1 AND 7);

ALTER TABLE weekly_budget_periods ADD COLUMN cutoff_time TEXT;

ALTER TABLE weekly_budget_periods ADD COLUMN timezone TEXT;

ALTER TABLE weekly_budget_periods ADD COLUMN purpose_prefix TEXT;

