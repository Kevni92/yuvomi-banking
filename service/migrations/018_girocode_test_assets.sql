-- Short-lived, capability-protected assets for the manual GiroCode test tool.
-- The EPC payload includes an IBAN and is therefore encrypted at rest.
CREATE TABLE girocode_test_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  yuvomi_user_id INTEGER NOT NULL,
  image_token_hash TEXT NOT NULL UNIQUE,
  browser_token_hash TEXT NOT NULL UNIQUE,
  payload_encrypted TEXT NOT NULL,
  beneficiary_name TEXT NOT NULL,
  iban_masked TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency = 'EUR'),
  remittance TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_girocode_test_assets_expiry
  ON girocode_test_assets(expires_at, id);
