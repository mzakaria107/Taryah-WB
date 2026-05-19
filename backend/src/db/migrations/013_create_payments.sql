-- ════════════════════════════════════════════════════════════════
-- 013_create_payments.sql
-- Stores daily sales-team payment transactions (cash/cheque/bank/POS)
-- Linked to invoices by invoice_number, keyed by document_number
-- Immune to invoice truncation — NO FK to invoices table
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_number VARCHAR(100) NOT NULL UNIQUE,   -- upsert key from Excel "Document Number"
  invoice_number  VARCHAR(100),                    -- links to invoices.invoice_number (soft ref)
  customer_code   VARCHAR(100),
  customer_name   VARCHAR(300),
  route_code      INTEGER,
  bank_name       VARCHAR(200),
  tran_date       DATE,
  journey_id      INTEGER,
  visit_key       INTEGER,
  transaction_key INTEGER,
  cash            NUMERIC(14,2) NOT NULL DEFAULT 0,
  cheque          NUMERIC(14,2) NOT NULL DEFAULT 0,
  bank_tran       NUMERIC(14,2) NOT NULL DEFAULT 0,
  pos             NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_paid      NUMERIC(14,2) GENERATED ALWAYS AS
                    (cash + cheque + bank_tran + pos) STORED,
  uploaded_at     TIMESTAMPTZ  DEFAULT NOW(),
  uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice_number ON payments(invoice_number);
CREATE INDEX IF NOT EXISTS idx_payments_customer_code  ON payments(customer_code);
CREATE INDEX IF NOT EXISTS idx_payments_tran_date      ON payments(tran_date);
CREATE INDEX IF NOT EXISTS idx_payments_document_number ON payments(document_number);
