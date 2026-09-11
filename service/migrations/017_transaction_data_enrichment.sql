-- Transaction data enrichment state and searchable, normalized provider fields.

ALTER TABLE transactions ADD COLUMN provider_detail_state TEXT NOT NULL DEFAULT 'unknown'
  CHECK(provider_detail_state IN ('unknown', 'available', 'fetched', 'unavailable', 'failed'));
ALTER TABLE transactions ADD COLUMN provider_detail_last_attempt_at TEXT;
ALTER TABLE transactions ADD COLUMN provider_detail_fetched_at TEXT;
ALTER TABLE transactions ADD COLUMN provider_detail_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN provider_note TEXT;
ALTER TABLE transactions ADD COLUMN reference_number TEXT;
ALTER TABLE transactions ADD COLUMN reference_number_schema TEXT;
ALTER TABLE transactions ADD COLUMN bank_transaction_code TEXT;
ALTER TABLE transactions ADD COLUMN counterparty_additional_identification TEXT;
ALTER TABLE transactions ADD COLUMN merchant_evidence_source TEXT;
ALTER TABLE transactions ADD COLUMN merchant_resolution_method TEXT
  CHECK(merchant_resolution_method IN ('provider_explicit', 'registry_alias', 'manual', 'external_enrichment'));

CREATE INDEX idx_transactions_provider_detail_candidates
  ON transactions(account_id, provider_detail_state, transaction_id);
