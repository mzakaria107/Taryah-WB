-- Migration 019: Drop the CASCADE FK from sales_activity → invoices
--
-- REASON: upload.js uses TRUNCATE TABLE invoices CASCADE to replace all invoice
-- data on every upload.  The ON DELETE CASCADE FK added in 018 caused that
-- TRUNCATE to wipe the entire sales_activity table as a side-effect.
--
-- The logical relationship (invoice_number exists in both tables) is preserved
-- for queries; the compound index idx_invoices_customer_year keeps joins fast.

ALTER TABLE sales_activity
  DROP CONSTRAINT IF EXISTS fk_sa_invoice_number;
