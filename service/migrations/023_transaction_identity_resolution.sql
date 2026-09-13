-- Preserve provider observations across PDNG -> BOOK reconciliation and keep
-- resolved display identities separate from provider-owned transaction fields.

CREATE TABLE transaction_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('PDNG', 'BOOK', 'UNKNOWN')),
  direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
  observed_at TEXT NOT NULL,
  counterparty_name TEXT,
  purpose TEXT,
  provider_merchant_name TEXT,
  bank_transaction_code TEXT,
  observation_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(transaction_id, observation_key)
);

CREATE INDEX idx_transaction_observations_transaction
  ON transaction_observations(transaction_id, observed_at);

CREATE TABLE transaction_resolutions (
  transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL
    CHECK(entity_type IN ('merchant', 'own_transfer', 'counterparty')),
  display_name TEXT NOT NULL,
  merchant_key TEXT,
  payment_method TEXT,
  intermediary_name TEXT,
  source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  resolved_at TEXT NOT NULL
);

CREATE TABLE merchant_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  merchant_key TEXT,
  source TEXT NOT NULL DEFAULT 'system'
    CHECK(source IN ('system', 'manual', 'learned')),
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_merchant_aliases_enabled_priority
  ON merchant_aliases(enabled, priority, id);

-- Safe, reusable aliases. Payment intermediaries such as PayPal are
-- deliberately not merchant aliases because they can settle many merchants.
INSERT OR IGNORE INTO merchant_aliases (
  alias_normalized, display_name, merchant_key, source, priority, enabled,
  created_at, updated_at
) VALUES
  ('amazon digital germany gmbh', 'Amazon', 'amazon', 'system', 50, 1,
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('google payment ireland limited', 'Google Payment', NULL, 'system', 50, 1,
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
