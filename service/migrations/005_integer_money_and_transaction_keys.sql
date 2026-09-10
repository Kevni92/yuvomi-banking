-- Replace floating-point money columns with integer minor units and preserve
-- provider transaction IDs separately from the deduplication key.
-- Existing migrations are append-only and must not be edited.

-- transfer_suggestions references transactions, so preserve its rows while
-- the transactions table is rebuilt without the legacy REAL amount column.
CREATE TABLE transfer_suggestions_legacy AS
SELECT * FROM transfer_suggestions;

CREATE TABLE transactions_legacy AS
SELECT * FROM transactions;

DROP INDEX IF EXISTS idx_transactions_account_booking_date;
DROP INDEX IF EXISTS idx_transactions_category;
DROP INDEX IF EXISTS idx_transfer_suggestions_week_status;

DROP TABLE transfer_suggestions;
DROP TABLE transactions;

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  -- This is the stable local deduplication key. It is either an entry reference
  -- or a canonical fingerprint; it is not Enable Banking transaction_id.
  provider_transaction_id TEXT NOT NULL,
  entry_reference TEXT,
  transaction_id TEXT,
  booking_date TEXT,
  value_date TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
  counterparty_ref INTEGER REFERENCES counterparties(id) ON DELETE SET NULL,
  counterparty_name TEXT,
  purpose TEXT,
  merchant_name TEXT,
  mcc TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_source TEXT CHECK(category_source IN ('manual', 'counterparty_rule', 'merchant_rule', 'text_rule', 'ai')),
  category_confidence REAL,
  yuvomi_budget_entry_id INTEGER,
  raw_payload_encrypted TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, provider_transaction_id)
);

INSERT INTO transactions (
  id, account_id, provider_transaction_id, booking_date, value_date,
  amount_cents, currency, direction, counterparty_ref, counterparty_name,
  purpose, merchant_name, mcc, category_id, category_source,
  category_confidence, yuvomi_budget_entry_id, raw_payload_encrypted,
  created_at, updated_at
)
SELECT
  id, account_id, provider_transaction_id, booking_date, value_date,
  CAST(ROUND(amount * 100.0) AS INTEGER), currency, direction,
  counterparty_ref, counterparty_name, purpose, merchant_name, mcc,
  category_id, category_source, category_confidence, yuvomi_budget_entry_id,
  raw_payload_encrypted, created_at, updated_at
FROM transactions_legacy;

DROP TABLE transactions_legacy;

CREATE TABLE transfer_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  target_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  target_amount_cents INTEGER NOT NULL,
  computed_amount_cents INTEGER NOT NULL,
  deducted_amount_cents INTEGER NOT NULL DEFAULT 0,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK(status IN ('proposed', 'shown', 'completed', 'dismissed')),
  matched_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO transfer_suggestions (
  id, source_account_id, target_account_id, target_amount_cents,
  computed_amount_cents, deducted_amount_cents, week_start, week_end,
  purpose, status, matched_transaction_id, created_at, updated_at
)
SELECT
  id, source_account_id, target_account_id,
  CAST(ROUND(target_amount * 100.0) AS INTEGER),
  CAST(ROUND(computed_amount * 100.0) AS INTEGER),
  CAST(ROUND(deducted_amount * 100.0) AS INTEGER),
  week_start, week_end, purpose, status, matched_transaction_id,
  created_at, updated_at
FROM transfer_suggestions_legacy;

DROP TABLE transfer_suggestions_legacy;

CREATE INDEX IF NOT EXISTS idx_transactions_account_booking_date
  ON transactions(account_id, booking_date);

CREATE INDEX IF NOT EXISTS idx_transactions_category
  ON transactions(category_id);

CREATE INDEX IF NOT EXISTS idx_transfer_suggestions_week_status
  ON transfer_suggestions(week_start, status);
