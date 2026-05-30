-- Add bad_return_qty column to sales_activity
-- Stores the "Total Bad Return Qty" (صافي المرتجعات) per invoice row

ALTER TABLE sales_activity
  ADD COLUMN IF NOT EXISTS bad_return_qty INTEGER NOT NULL DEFAULT 0;
