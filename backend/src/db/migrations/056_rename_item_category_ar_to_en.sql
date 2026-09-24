-- Migration 056: Rename item_category_ar → item_category_en
-- The CSV column is "Item Category Name English", not Arabic.

-- Drop old unique constraint (dropping constraint also drops its underlying index)
ALTER TABLE sales_activity DROP CONSTRAINT IF EXISTS uq_sa_invoice_item;

-- Drop old index
DROP INDEX IF EXISTS idx_sa_item_cat;

-- Rename the column
ALTER TABLE sales_activity RENAME COLUMN item_category_ar TO item_category_en;

-- Recreate unique constraint with corrected column name
ALTER TABLE sales_activity
  ADD CONSTRAINT uq_sa_invoice_item
  UNIQUE (invoice_number, report_year, item_category_en, item_name_en);

-- Recreate index
CREATE INDEX IF NOT EXISTS idx_sa_item_cat ON sales_activity(item_category_en);
