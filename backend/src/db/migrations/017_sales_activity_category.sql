-- Add category_name column to sales_activity for "Category Name English" CSV column
ALTER TABLE sales_activity
  ADD COLUMN IF NOT EXISTS category_name VARCHAR(200);
