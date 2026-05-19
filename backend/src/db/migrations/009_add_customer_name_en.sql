-- Store English customer name separately (from "Name English" Excel column)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS customer_name_en VARCHAR(300);

-- Also add sales rep name (from "First Name English" column)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS sales_rep_name VARCHAR(200);
