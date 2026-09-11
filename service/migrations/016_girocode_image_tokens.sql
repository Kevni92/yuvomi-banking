-- Capability tokens grant only one short-lived GiroCode PNG and are stored
-- hashed because the image contains payment data.

CREATE TABLE girocode_image_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id INTEGER NOT NULL REFERENCES transfer_suggestions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_girocode_image_tokens_expiry
  ON girocode_image_tokens(expires_at, id);
