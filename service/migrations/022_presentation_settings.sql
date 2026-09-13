CREATE TABLE IF NOT EXISTS banking_presentation_settings (
  yuvomi_user_id INTEGER PRIMARY KEY CHECK (yuvomi_user_id > 0),
  transaction_title_mode TEXT NOT NULL DEFAULT 'smart'
    CHECK (transaction_title_mode IN ('smart', 'counterparty', 'transaction_type')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
