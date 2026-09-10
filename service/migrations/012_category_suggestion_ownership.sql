-- AI category suggestions are private to the Banking user who triggered them.
-- Existing unscoped suggestions remain historical and are intentionally not exposed.

ALTER TABLE category_suggestions
  ADD COLUMN yuvomi_user_id INTEGER;

CREATE INDEX idx_category_suggestions_user_status
  ON category_suggestions(yuvomi_user_id, status, created_at DESC);
