-- Local account presentation data. Provider display_name remains untouched so
-- reconnects/syncs can continue refreshing provider-owned metadata safely.

ALTER TABLE bank_accounts ADD COLUMN alias TEXT;
ALTER TABLE bank_accounts ADD COLUMN color_hex TEXT;
