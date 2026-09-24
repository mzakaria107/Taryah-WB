-- A friendly, unique, sequential number per report (per tab/table) so the
-- report page can reference "تقرير #47" instead of a UUID, and so the
-- detailed log can be grouped one row per report (click to expand its
-- items) instead of one row per item.
ALTER TABLE carrefour_damage_reports ADD COLUMN IF NOT EXISTS report_no SERIAL UNIQUE;
ALTER TABLE carrefour_stock_reports  ADD COLUMN IF NOT EXISTS report_no SERIAL UNIQUE;
ALTER TABLE carrefour_order_reports  ADD COLUMN IF NOT EXISTS report_no SERIAL UNIQUE;
