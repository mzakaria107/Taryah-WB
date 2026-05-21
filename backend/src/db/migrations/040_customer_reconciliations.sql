-- Customer reconciliation files
CREATE TABLE IF NOT EXISTS customer_reconciliations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id VARCHAR(100) NOT NULL,
  file_name   VARCHAR(255) NOT NULL,
  file_path   TEXT         NOT NULL,
  file_size   INTEGER,
  mime_type   VARCHAR(100),
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ  DEFAULT NOW(),
  notes       TEXT
);

CREATE INDEX IF NOT EXISTS idx_recon_customer ON customer_reconciliations(customer_id);
CREATE INDEX IF NOT EXISTS idx_recon_uploaded ON customer_reconciliations(uploaded_at DESC);
