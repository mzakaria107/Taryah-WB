-- Extends spare-parts stock tracking (110_fleet_parts_inventory.sql) to the
-- EXPENSE logging flow too — per part selected on a "تسجيل مصروف" entry,
-- the admin now picks a quantity AND either:
--   • "خصم من رصيد المستودع" ON  — cost is pulled automatically from that
--     part's most recent supply price (fleet_part_supplies.unit_cost) and
--     the quantity is deducted from fleet_spare_parts.qty_on_hand, same
--     "never blocks, only warns on negative" rule as the maintenance flow.
--   • OFF — the part was bought outside inventory tracking for this one
--     expense, so quantity AND unit cost are entered by hand, and stock is
--     untouched.
-- Replaces fleet_expenses.part_ids (a bare id list with no quantity/cost,
-- added two turns ago before this was requested) — no real usage exists
-- yet to migrate, only synthetic test rows already cleaned up each time.
ALTER TABLE fleet_expenses DROP COLUMN IF EXISTS part_ids;
ALTER TABLE fleet_expenses ADD COLUMN IF NOT EXISTS parts_used JSONB NOT NULL DEFAULT '[]'::jsonb;
