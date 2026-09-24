-- One-time backfill: every contract saved BEFORE 115_discount_shop_contract_region.sql
-- added the column has region_name = NULL, showing "—" in the "المنطقة" column
-- even though the customer's region is perfectly resolvable right now via
-- customers.region_id. Runs once (migrations never re-run); only touches rows
-- that still have region_name IS NULL, so it never overwrites a real snapshot
-- a NEWER contract already saved with its own region_name at print time.
UPDATE discount_shop_contracts dc
SET region_name = reg.name_ar
FROM customers c
LEFT JOIN regions reg ON reg.id = c.region_id
WHERE c.customer_code = dc.customer_code
  AND dc.region_name IS NULL
  AND reg.name_ar IS NOT NULL;
