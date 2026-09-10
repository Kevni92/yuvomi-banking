-- Yuvomi Banking - Initial schema
--
-- Noch NICHT automatisch ausgeführt.
-- Codex soll in Phase 2 Migration Runner + konkrete SQLite-Schicht implementieren.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('expense', 'income', 'transfer')),
  yuvomi_category_key TEXT,
  yuvomi_subcategory_key TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enable_banking_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  yuvomi_user_id INTEGER NOT NULL,
  provider_session_id TEXT,
  aspsp_name TEXT,
  aspsp_country TEXT,
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES enable_banking_connections(id) ON DELETE CASCADE,
  provider_account_id TEXT NOT NULL,
  display_name TEXT,
  iban_encrypted TEXT,
  currency TEXT,
  account_type TEXT,
  yuvomi_budget_account_id INTEGER,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id, provider_account_id)
);

CREATE TABLE IF NOT EXISTS counterparties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  counterparty_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  iban_encrypted TEXT,
  normalized_merchant_name TEXT,
  logo_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  provider_transaction_id TEXT NOT NULL,
  booking_date TEXT,
  value_date TEXT,
  amount REAL NOT NULL,
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

CREATE TABLE IF NOT EXISTS category_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_type TEXT NOT NULL CHECK(rule_type IN ('counterparty', 'merchant', 'text')),
  match_value TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 100,
  source TEXT NOT NULL CHECK(source IN ('manual', 'learned', 'system')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS category_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggested_name TEXT NOT NULL,
  suggested_type TEXT NOT NULL,
  reason TEXT,
  sample_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS merchant_logos (
  logo_key TEXT PRIMARY KEY,
  merchant_name TEXT NOT NULL,
  source_domain TEXT,
  file_path TEXT,
  content_type TEXT,
  etag TEXT,
  fetched_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfer_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  target_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  target_amount REAL NOT NULL,
  computed_amount REAL NOT NULL,
  deducted_amount REAL NOT NULL DEFAULT 0,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK(status IN ('proposed', 'shown', 'completed', 'dismissed')),
  matched_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connections_user
  ON enable_banking_connections(yuvomi_user_id);

CREATE INDEX IF NOT EXISTS idx_connections_status_valid_until
  ON enable_banking_connections(status, valid_until);

CREATE INDEX IF NOT EXISTS idx_accounts_connection
  ON bank_accounts(connection_id);

CREATE INDEX IF NOT EXISTS idx_transactions_account_booking_date
  ON transactions(account_id, booking_date);

CREATE INDEX IF NOT EXISTS idx_transactions_category
  ON transactions(category_id);

CREATE INDEX IF NOT EXISTS idx_category_rules_lookup
  ON category_rules(rule_type, match_value, priority, enabled);

CREATE INDEX IF NOT EXISTS idx_suggestions_status
  ON category_suggestions(status);

CREATE INDEX IF NOT EXISTS idx_transfer_suggestions_week_status
  ON transfer_suggestions(week_start, status);
