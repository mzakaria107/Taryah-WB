-- Migration 079: user notes on a fridge, with a permanent audit trail.
-- Same two-table shape as sales_activity_notes (015): one CURRENT note per
-- fridge for the list column, plus an append-only history so nothing a user
-- wrote is ever overwritten out of existence.
CREATE TABLE IF NOT EXISTS fridge_notes (
  fridge_id       UUID        PRIMARY KEY REFERENCES fridges(id) ON DELETE CASCADE,
  note_text       TEXT        NOT NULL DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name VARCHAR(200)   -- denormalized: survives the user being deleted
);

-- Every save appends a row here; rows are never updated or deleted. The FK
-- cascades because deleting a fridge deletes the asset itself — an orphan note
-- would be unreachable from anywhere in the UI.
CREATE TABLE IF NOT EXISTS fridge_notes_history (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fridge_id     UUID        NOT NULL REFERENCES fridges(id) ON DELETE CASCADE,
  note_text     TEXT        NOT NULL DEFAULT '',
  saved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  saved_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  saved_by_name VARCHAR(200)
);

CREATE INDEX IF NOT EXISTS idx_fridge_notes_history_fridge
  ON fridge_notes_history (fridge_id, saved_at DESC);
