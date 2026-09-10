-- Stable account identity and one-time authorization state handling.
-- Existing migrations are append-only and must not be edited.

ALTER TABLE bank_accounts ADD COLUMN identification_hash TEXT;
ALTER TABLE enable_banking_connections ADD COLUMN state_expires_at TEXT;
ALTER TABLE enable_banking_connections ADD COLUMN state_claimed_at TEXT;

-- Keep old pending states usable during a rolling upgrade, but give them the
-- same short lifetime as newly created authorization states.
UPDATE enable_banking_connections
SET state_expires_at = datetime(updated_at, '+15 minutes')
WHERE status = 'pending'
  AND state_hash IS NOT NULL
  AND state_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_identification_hash
  ON bank_accounts(identification_hash);

CREATE INDEX IF NOT EXISTS idx_connections_pending_state
  ON enable_banking_connections(state_hash, status, state_expires_at);
