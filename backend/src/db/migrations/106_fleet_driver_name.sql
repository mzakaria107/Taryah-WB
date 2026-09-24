-- Optional free-text driver name for vehicles NOT linked to a registered
-- rep (region/farm transport trucks, unassigned) — there's no "driver"
-- entity in the system for these the way sales_reps is for rep vehicles,
-- so this is just a label, not a foreign key.
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS driver_name VARCHAR(200);
