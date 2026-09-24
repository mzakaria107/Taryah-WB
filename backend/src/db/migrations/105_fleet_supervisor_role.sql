-- New role for the fleet-management page: "مشرف حركة" (fleet/traffic
-- supervisor) — the "central fleet coordinator" the feature was built
-- around (see 104_fleet_management.sql). Same pattern as carrefour_rep/
-- quality_returns_monitor: a same-transaction ADD VALUE is safe because
-- nothing in this transaction inserts a row using it — page_permissions.role
-- is plain VARCHAR, not the enum.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'fleet_supervisor';

-- Edit access to fleet_management only — this role has no other page in
-- scope, mirroring how carrefour_rep/quality_returns_monitor are each
-- scoped to just their own feature.
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('fleet_management', 'fleet_supervisor', 2)
ON CONFLICT (page_key, role) DO NOTHING;
