-- Merchant identities are normalized locally; logo bytes remain in the local cache.

ALTER TABLE transactions
  ADD COLUMN merchant_key TEXT;

CREATE INDEX idx_transactions_merchant_key
  ON transactions(merchant_key);
