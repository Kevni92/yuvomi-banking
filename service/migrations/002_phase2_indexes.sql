-- Phase 2 indexes for databases that already applied 001_init.sql.

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
