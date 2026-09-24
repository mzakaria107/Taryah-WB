-- Migration 081: Arabic customer name from the "Customer Name Arabic" column
-- of the "Customer List - CM" export.
--
-- Kept as its OWN column rather than overwriting customer_name: the export
-- carries both, the English one is what NetSuite keys reports on, and the
-- Arabic one is what the dashboard shows. Collapsing them would lose whichever
-- was not written last.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_name_ar VARCHAR(300);
