-- Net revenue per line item, sourced from Excel column "Total net sales revenue"
ALTER TABLE sales_activity
  ADD COLUMN IF NOT EXISTS net_revenue NUMERIC(14,2) NOT NULL DEFAULT 0;
