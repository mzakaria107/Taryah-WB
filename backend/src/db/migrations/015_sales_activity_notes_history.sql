-- Sales activity notes: ensure table exists (idempotent)
CREATE TABLE IF NOT EXISTS sales_activity_notes (
  customer_code VARCHAR(50) PRIMARY KEY,
  note_text     TEXT        NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    UUID        REFERENCES users(id) ON DELETE SET NULL
);

-- History log: every save creates an immutable row — never deleted
CREATE TABLE IF NOT EXISTS sales_activity_notes_history (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code VARCHAR(50) NOT NULL,
  note_text     TEXT        NOT NULL DEFAULT '',
  saved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  saved_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  saved_by_name VARCHAR(100)          -- denormalized for display, survives user deletion
);

CREATE INDEX IF NOT EXISTS idx_san_history_code
  ON sales_activity_notes_history (customer_code, saved_at DESC);
