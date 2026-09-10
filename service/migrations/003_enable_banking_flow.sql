-- Phase 3 fields for the authorization callback correlation.

ALTER TABLE enable_banking_connections ADD COLUMN authorization_id TEXT;
ALTER TABLE enable_banking_connections ADD COLUMN state_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_state_hash
  ON enable_banking_connections(state_hash)
  WHERE state_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_connections_authorization_id
  ON enable_banking_connections(authorization_id);
