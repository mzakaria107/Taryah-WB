-- Add route code prefix (first 2 digits of Route Code) to regions
-- e.g. prefix 11 → الرياض, prefix 12 → جدة, etc.
ALTER TABLE regions
  ADD COLUMN IF NOT EXISTS route_prefix INTEGER UNIQUE;

CREATE INDEX IF NOT EXISTS idx_regions_route_prefix ON regions(route_prefix);
