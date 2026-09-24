-- Which routes show as columns in the entry grid, per region — a region
-- with 11 routes makes an unusable number of columns if all show at once.
-- Deliberately its OWN table, not a column on the shared `routes` table:
-- `routes` is used by rep-management/invoices/etc, and "active in this
-- grid" is a quality-returns-only concept that must not affect anything
-- else reading that table.
CREATE TABLE IF NOT EXISTS quality_returns_route_settings (
  route_id    INTEGER PRIMARY KEY REFERENCES routes(route_id) ON DELETE CASCADE,
  is_active   BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: only the first 5 routes per region (by route_id) start active, per
-- the initial request — everything else starts inactive and is turned on
-- from the entry page's admin route-toggle panel as needed.
INSERT INTO quality_returns_route_settings (route_id, is_active)
SELECT route_id, TRUE
FROM (
  SELECT route_id, ROW_NUMBER() OVER (PARTITION BY region_id ORDER BY route_id) AS rn
  FROM routes
  WHERE region_id IS NOT NULL
) ranked
WHERE rn <= 5
ON CONFLICT (route_id) DO NOTHING;
