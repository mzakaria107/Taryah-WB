-- Migration 027: Add missing performance indexes

-- sales_activity.report_year standalone index
-- The existing idx_sa_month(month_num, report_year) cannot be used
-- for queries that filter by report_year alone (e.g. WHERE report_year = $1).
CREATE INDEX IF NOT EXISTS idx_sa_report_year ON sales_activity(report_year);

-- sales_activity.category_name for category-stats queries
CREATE INDEX IF NOT EXISTS idx_sa_category ON sales_activity(category_name);

-- customer_notes lookup by customer_id already exists (idx_customer_notes_cid),
-- but ensure customer_note_history also has a fast lookup
-- (idx_cnh_customer already exists from migration 012).

-- payments.customer_code already has idx_payments_customer_code.
-- payments.tran_date already has idx_payments_tran_date.

-- fridge_transfers.fridge_id already has idx_fridge_transfers_fridge.
-- No additional indexes needed here.
