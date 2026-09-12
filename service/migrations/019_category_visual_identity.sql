-- Add optional visual identity for Banking categories.
-- Values are validated by the service; NULL keeps legacy categories visually neutral.

ALTER TABLE categories ADD COLUMN icon_key TEXT;
ALTER TABLE categories ADD COLUMN color_hex TEXT;
