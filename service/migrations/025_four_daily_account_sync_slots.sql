-- Add two further daily background-sync slots. Existing migrations are append-only.

ALTER TABLE weekly_budget_configs ADD COLUMN sync_time_3 TEXT NOT NULL DEFAULT '12:00'
  CHECK(
    sync_time_3 GLOB '[0-2][0-9]:[0-5][0-9]'
    AND sync_time_3 < '24:00'
  );

ALTER TABLE weekly_budget_configs ADD COLUMN sync_time_4 TEXT NOT NULL DEFAULT '23:30'
  CHECK(
    sync_time_4 GLOB '[0-2][0-9]:[0-5][0-9]'
    AND sync_time_4 < '24:00'
  );

-- Keep migrated rows distinct even when users previously chose one of the new defaults.
UPDATE weekly_budget_configs
SET sync_time_3 = CASE
  WHEN sync_time_1 <> '12:00' AND sync_time_2 <> '12:00' THEN '12:00'
  WHEN sync_time_1 <> '00:00' AND sync_time_2 <> '00:00' THEN '00:00'
  WHEN sync_time_1 <> '03:00' AND sync_time_2 <> '03:00' THEN '03:00'
  ELSE '09:00'
END;

UPDATE weekly_budget_configs
SET sync_time_4 = CASE
  WHEN sync_time_1 <> '23:30' AND sync_time_2 <> '23:30' AND sync_time_3 <> '23:30' THEN '23:30'
  WHEN sync_time_1 <> '18:00' AND sync_time_2 <> '18:00' AND sync_time_3 <> '18:00' THEN '18:00'
  WHEN sync_time_1 <> '06:00' AND sync_time_2 <> '06:00' AND sync_time_3 <> '06:00' THEN '06:00'
  ELSE '21:00'
END;
