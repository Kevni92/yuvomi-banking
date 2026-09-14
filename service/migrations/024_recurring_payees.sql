-- Stable, owner-scoped payee identities for recurring outgoing transactions.
-- This migration is append-only. It deliberately does not rebuild transactions.

CREATE TABLE payees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  yuvomi_user_id INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  display_name_source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK(status IN ('candidate', 'confirmed', 'ignored')),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, yuvomi_user_id)
);

CREATE INDEX idx_payees_owner_status
  ON payees(yuvomi_user_id, status, id);

CREATE TABLE payee_identifiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payee_id INTEGER NOT NULL,
  yuvomi_user_id INTEGER NOT NULL,
  identifier_type TEXT NOT NULL
    CHECK(identifier_type IN (
      'sepa_creditor_id',
      'counterparty_iban',
      'account_additional_id',
      'merchant_key',
      'resolved_merchant_name',
      'counterparty_name'
    )),
  identifier_hash TEXT NOT NULL,
  strength TEXT NOT NULL CHECK(strength IN ('strong', 'candidate')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY(payee_id, yuvomi_user_id)
    REFERENCES payees(id, yuvomi_user_id) ON DELETE CASCADE,
  UNIQUE(yuvomi_user_id, identifier_type, identifier_hash)
);

CREATE INDEX idx_payee_identifiers_payee
  ON payee_identifiers(payee_id, strength, id);

CREATE TABLE transaction_payee_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL
    REFERENCES transactions(id) ON DELETE CASCADE,
  identifier_type TEXT NOT NULL
    CHECK(identifier_type IN (
      'sepa_creditor_id',
      'counterparty_iban',
      'account_additional_id',
      'merchant_key',
      'resolved_merchant_name',
      'counterparty_name'
    )),
  identifier_hash TEXT NOT NULL,
  strength TEXT NOT NULL CHECK(strength IN ('strong', 'candidate', 'context')),
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(transaction_id, identifier_type, identifier_hash, source)
);

CREATE INDEX idx_transaction_payee_evidence_lookup
  ON transaction_payee_evidence(identifier_type, identifier_hash, transaction_id);

ALTER TABLE transactions ADD COLUMN payee_id INTEGER
  REFERENCES payees(id) ON DELETE SET NULL;

ALTER TABLE transactions ADD COLUMN payee_match_state TEXT NOT NULL DEFAULT 'unresolved'
  CHECK(payee_match_state IN ('unresolved', 'matched', 'ambiguous', 'excluded'));

ALTER TABLE transactions ADD COLUMN payee_match_method TEXT;
ALTER TABLE transactions ADD COLUMN payee_match_confidence REAL;
ALTER TABLE transactions ADD COLUMN category_origin_payee_id INTEGER
  REFERENCES payees(id) ON DELETE SET NULL;

CREATE INDEX idx_transactions_payee_booked
  ON transactions(payee_id, direction, status, booking_date, id);

CREATE INDEX idx_transactions_category_origin_payee
  ON transactions(category_origin_payee_id, id);
