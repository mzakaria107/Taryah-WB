-- Adds "المنطقة" to the saved-contracts log ("سجل العقود المحفوظة"). Same
-- "frozen snapshot, not a live re-join" rule the rest of this table follows
-- for customer_name/customer_name_ar/avg_monthly_value/growth_pct/
-- target_value/tiers — a saved contract keeps showing the region the
-- customer was in when it was printed, even if the customer is later
-- reassigned to a different region in the customers master.
ALTER TABLE discount_shop_contracts ADD COLUMN IF NOT EXISTS region_name VARCHAR(200);
