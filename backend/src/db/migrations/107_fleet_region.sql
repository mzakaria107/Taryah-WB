-- Manually-set region for vehicles NOT linked to a rep (transport/farm
-- trucks) — for a REP-linked vehicle, the region shown/filtered on is
-- always derived live from that rep's CURRENT sales_reps.region_id
-- (never copied/stored here), so it can never drift out of sync if the
-- rep gets reassigned to a different region later. This column is only
-- ever read when assignment_type <> 'rep'.
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS region_id INTEGER REFERENCES regions(id);
