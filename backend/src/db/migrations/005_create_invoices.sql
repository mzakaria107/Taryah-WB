CREATE TABLE IF NOT EXISTS invoices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       VARCHAR(100) NOT NULL,
  customer_name     VARCHAR(300) NOT NULL,
  region_id         INTEGER REFERENCES regions(id) ON DELETE SET NULL,
  route_id          INTEGER,
  invoice_number    VARCHAR(100) NOT NULL,
  invoice_date      DATE,
  year              INTEGER,
  original_amount   DECIMAL(15,2) DEFAULT 0,
  paid_amount       DECIMAL(15,2) DEFAULT 0,
  balance           DECIMAL(15,2) DEFAULT 0,
  status            invoice_status NOT NULL DEFAULT 'unpaid',
  collection_rate   DECIMAL(5,2) DEFAULT 0,
  customer_type     VARCHAR(50),
  upload_batch_id   UUID REFERENCES upload_batches(id) ON DELETE SET NULL,
  updated_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_invoices_number ON invoices(invoice_number);
CREATE INDEX idx_invoices_region       ON invoices(region_id);
CREATE INDEX idx_invoices_year         ON invoices(year);
CREATE INDEX idx_invoices_status       ON invoices(status);
CREATE INDEX idx_invoices_customer_id  ON invoices(customer_id);
