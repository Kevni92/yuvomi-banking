-- Provider consent metadata and transaction lifecycle fields.
-- Existing migrations are append-only and must not be edited.

ALTER TABLE enable_banking_connections
  ADD COLUMN aspsp_maximum_consent_validity INTEGER;

ALTER TABLE transactions
  ADD COLUMN transaction_date TEXT;

ALTER TABLE transactions
  ADD COLUMN status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK(status IN ('PDNG', 'BOOK', 'UNKNOWN'));

CREATE INDEX IF NOT EXISTS idx_transactions_account_status
  ON transactions(account_id, status);
