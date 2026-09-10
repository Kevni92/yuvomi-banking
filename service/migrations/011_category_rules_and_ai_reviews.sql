-- User-scoped categorization rules and auditable AI review results.
-- Existing migrations are append-only and must not be edited.

ALTER TABLE category_rules
  ADD COLUMN yuvomi_user_id INTEGER;

CREATE INDEX idx_category_rules_user_lookup
  ON category_rules(yuvomi_user_id, rule_type, enabled, priority, id);

CREATE TABLE ai_categorization_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  reason TEXT NOT NULL,
  suggested_category_name TEXT,
  suggested_category_type TEXT
    CHECK(suggested_category_type IS NULL OR suggested_category_type IN ('expense', 'income', 'transfer')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'applied', 'dismissed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX idx_ai_categorization_reviews_pending
  ON ai_categorization_reviews(status, updated_at DESC);
