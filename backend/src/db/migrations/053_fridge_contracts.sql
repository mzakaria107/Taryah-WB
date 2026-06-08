-- Migration 053: fridge contract file attachments
-- Note: fridges.id is UUID, so fridge_id must be UUID too
CREATE TABLE IF NOT EXISTS fridge_contracts (
  id            SERIAL       PRIMARY KEY,
  fridge_id     UUID         NOT NULL REFERENCES fridges(id) ON DELETE CASCADE,
  original_name VARCHAR(500) NOT NULL,
  stored_name   VARCHAR(500) NOT NULL,
  file_size     INTEGER,
  mime_type     VARCHAR(150),
  uploaded_by   INTEGER,
  uploaded_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fridge_contracts_fridge ON fridge_contracts(fridge_id);
