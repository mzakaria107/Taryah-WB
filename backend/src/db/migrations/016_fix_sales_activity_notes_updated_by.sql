-- Add updated_by column to sales_activity_notes if it doesn't exist
-- (migration 014 created the table without this column; 015 couldn't add it via CREATE TABLE IF NOT EXISTS)
ALTER TABLE sales_activity_notes
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
