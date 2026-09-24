-- Fleet-only "regions" — e.g. a physical warehouse/depot used purely for
-- classifying fleet vehicles (fleet_vehicles.region_id), NOT a real sales
-- branch. Reuses the shared `regions` table (so the existing
-- fleet_vehicles.region_id FK and the effective-region COALESCE join in
-- fleet.js need zero changes) but flags such rows so every OTHER region
-- picker across the app (user/rep region assignment, quality
-- returns/issues filters, collections, sales tasks, summary, fridges,
-- region-performance) can exclude them — a fleet warehouse must never be
-- selectable as a real sales region or show up as an empty phantom row in
-- a sales report. Only GET /api/fleet/regions and the fleet vehicle-Excel
-- importer (both fleet.js) intentionally see the full, unfiltered list.
ALTER TABLE regions ADD COLUMN IF NOT EXISTS fleet_only BOOLEAN NOT NULL DEFAULT false;

INSERT INTO regions (name_ar, name_en, fleet_only)
SELECT 'مستودع شقراء', 'مستودع شقراء', true
WHERE NOT EXISTS (SELECT 1 FROM regions WHERE name_ar = 'مستودع شقراء' AND fleet_only = true);
