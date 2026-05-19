-- Migration 018: Link sales_activity.invoice_number → invoices.invoice_number
-- Establishes a proper FK relationship so we can query invoice history
-- for returning customer detection.

-- Add FK constraint (all existing records already match — verified before migration)
ALTER TABLE sales_activity
  ADD CONSTRAINT fk_sa_invoice_number
  FOREIGN KEY (invoice_number)
  REFERENCES invoices(invoice_number)
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- Index to speed up the returning-customer join query:
--   invoices WHERE customer_id = ANY(...) AND year < N
-- idx_invoices_customer_id already exists, but add year compound index
CREATE INDEX IF NOT EXISTS idx_invoices_customer_year
  ON invoices (customer_id, year);
