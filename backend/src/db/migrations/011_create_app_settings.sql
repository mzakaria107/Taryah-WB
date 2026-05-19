CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB        NOT NULL DEFAULT '{}',
  updated_by TEXT,
  updated_at TIMESTAMPTZ  DEFAULT NOW()
);
