-- Snapshot the payment recipient used by each generated GiroCode.
-- Existing migrations are append-only and must not be edited.

ALTER TABLE weekly_budget_configs ADD COLUMN target_beneficiary_name TEXT
  CHECK(
    target_beneficiary_name IS NULL
    OR length(trim(target_beneficiary_name)) BETWEEN 1 AND 70
  );

UPDATE weekly_budget_configs
SET target_beneficiary_name = (
  SELECT CASE
    WHEN length(trim(COALESCE(bank_accounts.display_name, ''))) > 0
      THEN substr(trim(bank_accounts.display_name), 1, 70)
    ELSE NULL
  END
  FROM bank_accounts
  WHERE bank_accounts.id = weekly_budget_configs.target_account_id
)
WHERE target_beneficiary_name IS NULL;

ALTER TABLE weekly_budget_periods ADD COLUMN target_beneficiary_name TEXT;
ALTER TABLE weekly_budget_periods ADD COLUMN target_iban_encrypted TEXT;

UPDATE weekly_budget_periods
SET target_beneficiary_name = COALESCE(
      (
        SELECT weekly_budget_configs.target_beneficiary_name
        FROM weekly_budget_configs
        WHERE weekly_budget_configs.id = weekly_budget_periods.config_id
      ),
      target_account_name
    ),
    target_iban_encrypted = (
      SELECT bank_accounts.iban_encrypted
      FROM bank_accounts
      WHERE bank_accounts.id = weekly_budget_periods.target_account_id
    )
WHERE target_beneficiary_name IS NULL OR target_iban_encrypted IS NULL;
