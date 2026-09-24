-- Migration 055: Add item-level category columns to sales_activity.
-- The CSV now has one row per invoice-per-item instead of one row per invoice.
-- Unique key changes from (invoice_number, report_year)
--                      to (invoice_number, report_year, item_category_ar, item_name_en).

ALTER TABLE sales_activity
  ADD COLUMN IF NOT EXISTS item_category_ar VARCHAR(200) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS item_name_en     VARCHAR(300) NOT NULL DEFAULT '';

-- Replace old invoice-level unique constraint
ALTER TABLE sales_activity DROP CONSTRAINT IF EXISTS uq_sa_invoice;

ALTER TABLE sales_activity
  ADD CONSTRAINT uq_sa_invoice_item
  UNIQUE (invoice_number, report_year, item_category_ar, item_name_en);

CREATE INDEX IF NOT EXISTS idx_sa_item_cat  ON sales_activity(item_category_ar);
CREATE INDEX IF NOT EXISTS idx_sa_item_name ON sales_activity(item_name_en);
