-- Note history: immutable log of every note save (customer & invoice)
CREATE TABLE IF NOT EXISTS note_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  UUID         REFERENCES invoices(id) ON DELETE CASCADE,
  customer_id VARCHAR(50),
  note_type   VARCHAR(20)  NOT NULL DEFAULT 'invoice',
  note_text   TEXT         NOT NULL DEFAULT '',
  user_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_history_customer ON note_history (customer_id);
CREATE INDEX IF NOT EXISTS idx_note_history_invoice  ON note_history (invoice_id);
CREATE INDEX IF NOT EXISTS idx_note_history_created  ON note_history (created_at DESC);
