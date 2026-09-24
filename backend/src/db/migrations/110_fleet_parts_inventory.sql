-- Spare-parts INVENTORY (مخزون قطع الغيار) — turns the plain catalog from
-- 109_fleet_spare_parts.sql into a real stock-tracked store:
--   • "أمر توريد أرصدة مخزون" (fleet_part_supplies) — a receiving order: part,
--     quantity received, unit cost → adds to that part's running balance.
--   • Consuming a part during a logged maintenance service deducts from that
--     same running balance, linked to the vehicle (fleet_maintenance_log.
--     vehicle_id already ties every log row to a plate/vehicle — no extra
--     column needed for that link, it's inherent).
-- fleet_expenses.part_ids (109_fleet_spare_parts.sql) is UNCHANGED — a plain
-- "which parts were involved" tag with no quantity, since stock deduction was
-- only requested for the maintenance flow, not general expenses.

-- Cached running balance — same "denormalized current figure + a history
-- table backing it" pattern as fleet_vehicles.current_odometer_km /
-- fleet_odometer_readings. Can go negative (a part consumed before its
-- receiving order was ever logged, or bookkeeping catching up after the
-- fact) — the API surfaces that as a warning, never blocks the write, since
-- refusing to record a real repair just because inventory bookkeeping is
-- imperfect would be worse than an honest negative number.
ALTER TABLE fleet_spare_parts ADD COLUMN IF NOT EXISTS qty_on_hand NUMERIC(12,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS fleet_part_supplies (
  id               BIGSERIAL PRIMARY KEY,
  part_id          INTEGER NOT NULL REFERENCES fleet_spare_parts(id),
  supply_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  quantity         NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  unit_cost        NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_cost       NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
  notes            TEXT,
  created_by       UUID REFERENCES users(id),
  created_by_name  VARCHAR(200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fleet_part_supplies_part ON fleet_part_supplies(part_id, supply_date DESC);

-- Replaces fleet_maintenance_log.part_ids (a bare id list, no quantity —
-- added one turn ago, before quantity-based stock deduction was requested;
-- no real usage exists yet to migrate, only synthetic test rows already
-- cleaned up) with a quantity-aware [{ "part_id": 4, "qty": 2 }, …] array,
-- since deducting stock requires knowing HOW MANY of each part a service
-- consumed, not just which ones were touched.
ALTER TABLE fleet_maintenance_log DROP COLUMN IF EXISTS part_ids;
ALTER TABLE fleet_maintenance_log ADD COLUMN IF NOT EXISTS parts_used JSONB NOT NULL DEFAULT '[]'::jsonb;
