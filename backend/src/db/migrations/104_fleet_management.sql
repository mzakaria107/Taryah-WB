-- Fleet management system: a master vehicle registry (seeded from the
-- plate numbers already on sales_reps.vehicle_number, plus manually
-- added transport/farm trucks), weekly odometer readings, a per-vehicle
-- maintenance schedule derived from odometer deltas, a maintenance
-- history log, and expense tracking. One central fleet coordinator
-- updates all odometer readings weekly (per product decision — not
-- self-service by each rep), so no new user_role is needed: access is
-- granted via the existing page_permissions mechanism (PermissionsPage)
-- to whichever role/account should manage the fleet.

-- ── Vehicle master ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fleet_vehicles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_number        VARCHAR(50)  NOT NULL UNIQUE,
  category            VARCHAR(20)  CHECK (category IN ('ton_3', 'ton_5', 'ton_10', 'trailer', 'hino', 'staff_car')),
  -- NULL category = imported but not yet classified by the fleet admin
  -- (e.g. rep plate numbers seeded below, whose truck class isn't known
  -- from the plate alone).
  assignment_type     VARCHAR(20)  NOT NULL DEFAULT 'unassigned'
                       CHECK (assignment_type IN ('rep', 'region_transport', 'farm_slaughterhouse', 'unassigned')),
  assigned_rep_id     INTEGER      REFERENCES sales_reps(id) ON DELETE SET NULL,
  assignment_label    VARCHAR(200), -- free text for non-rep assignments, e.g. "نقل بضاعة - منطقة الرياض" / "مزرعة الدوادمي"
  make                VARCHAR(100),
  model                VARCHAR(100),
  model_year          INTEGER,
  status              VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'in_maintenance', 'inactive', 'sold')),
  current_odometer_km NUMERIC(10,1) NOT NULL DEFAULT 0,
  odometer_updated_at DATE,
  notes               TEXT,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Odometer readings — append-only weekly log ───────────────
-- fleet_vehicles.current_odometer_km/odometer_updated_at are denormalized
-- copies of the latest row here (kept in sync by the API, not a DB
-- trigger, matching this app's convention of doing such logic in the
-- route handler) so dashboard/list queries don't need a correlated
-- subquery per vehicle.
CREATE TABLE IF NOT EXISTS fleet_odometer_readings (
  id               BIGSERIAL PRIMARY KEY,
  vehicle_id       UUID NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
  reading_km       NUMERIC(10,1) NOT NULL,
  reading_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  recorded_by      UUID REFERENCES users(id),
  recorded_by_name VARCHAR(200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fleet_odo_vehicle ON fleet_odometer_readings(vehicle_id, reading_date DESC);

-- ── Maintenance type catalog (admin-maintained) ──────────────
-- default_interval_km is a starting point seeded below with generic,
-- editable values — the user has no company-specific standard yet, so
-- these are meant to be tuned from the settings panel, not treated as
-- fixed policy.
CREATE TABLE IF NOT EXISTS fleet_maintenance_types (
  id                   SERIAL PRIMARY KEY,
  name                 VARCHAR(150) NOT NULL,
  category             VARCHAR(20), -- NULL = applies to every vehicle category
  default_interval_km  NUMERIC(10,1) NOT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order           INTEGER NOT NULL DEFAULT 0
);

-- ── Per-vehicle maintenance schedule ──────────────────────────
-- One row per (vehicle, maintenance type). interval_km starts as a copy
-- of the type's default but can be overridden per vehicle (e.g. an
-- older truck serviced more often). "Due" is computed at read time as
-- current_odometer_km - last_service_km >= interval_km — no stored
-- "next_due_km" column, so it never goes stale if last_service_km or
-- interval_km changes.
CREATE TABLE IF NOT EXISTS fleet_maintenance_schedule (
  id                  BIGSERIAL PRIMARY KEY,
  vehicle_id          UUID NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
  maintenance_type_id INTEGER NOT NULL REFERENCES fleet_maintenance_types(id) ON DELETE CASCADE,
  interval_km         NUMERIC(10,1) NOT NULL,
  last_service_km     NUMERIC(10,1) NOT NULL DEFAULT 0,
  last_service_date   DATE,
  UNIQUE (vehicle_id, maintenance_type_id)
);

-- ── Maintenance history (append-only) ────────────────────────
-- Recording a row here is also how last_service_km/last_service_date on
-- fleet_maintenance_schedule gets rolled forward (done by the API, so
-- the "due" calculation always reflects the latest actual service).
CREATE TABLE IF NOT EXISTS fleet_maintenance_log (
  id                   BIGSERIAL PRIMARY KEY,
  vehicle_id           UUID NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
  maintenance_type_id  INTEGER NOT NULL REFERENCES fleet_maintenance_types(id),
  service_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  odometer_km          NUMERIC(10,1) NOT NULL,
  cost                 NUMERIC(12,2) NOT NULL DEFAULT 0,
  vendor               VARCHAR(200),
  notes                TEXT,
  created_by           UUID REFERENCES users(id),
  created_by_name      VARCHAR(200),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fleet_maint_log_vehicle ON fleet_maintenance_log(vehicle_id, service_date DESC);

-- ── Vehicle expenses (fuel, repairs, insurance, license, tires, …) ──
CREATE TABLE IF NOT EXISTS fleet_expenses (
  id               BIGSERIAL PRIMARY KEY,
  vehicle_id       UUID NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
  expense_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  category         VARCHAR(30) NOT NULL CHECK (category IN ('fuel', 'repair', 'tires', 'insurance', 'license', 'other')),
  amount           NUMERIC(12,2) NOT NULL,
  notes            TEXT,
  created_by       UUID REFERENCES users(id),
  created_by_name  VARCHAR(200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fleet_expenses_vehicle ON fleet_expenses(vehicle_id, expense_date DESC);

-- ── Seed maintenance types with generic, admin-editable intervals ────
INSERT INTO fleet_maintenance_types (name, category, default_interval_km, sort_order) VALUES
  ('تغيير زيت المحرك',        NULL,       6000,  1),
  ('فحص وتبديل الإطارات',      NULL,       15000, 2),
  ('فحص الفرامل',              NULL,       10000, 3),
  ('صيانة دورية شاملة',        NULL,       20000, 4),
  ('فحص وتغيير فلاتر الهواء والوقود', NULL, 12000, 5)
ON CONFLICT DO NOTHING;

-- ── Seed the vehicle master from the plate numbers already on file for
--    sales reps (sales_reps.vehicle_number) — category left NULL
--    (unclassified) since a plate number alone doesn't reveal truck
--    class; the fleet admin classifies these from the vehicle list. ────
INSERT INTO fleet_vehicles (plate_number, assignment_type, assigned_rep_id)
SELECT DISTINCT ON (sr.vehicle_number) sr.vehicle_number, 'rep', sr.id
FROM sales_reps sr
WHERE sr.vehicle_number IS NOT NULL AND TRIM(sr.vehicle_number) <> ''
ORDER BY sr.vehicle_number, sr.id
ON CONFLICT (plate_number) DO NOTHING;

-- ── Seed a maintenance schedule row per (existing vehicle, active type)
--    at the type's default interval, last_service_km = 0 (unknown
--    history — the fleet admin can correct this per vehicle later). ──
INSERT INTO fleet_maintenance_schedule (vehicle_id, maintenance_type_id, interval_km, last_service_km)
SELECT v.id, t.id, t.default_interval_km, 0
FROM fleet_vehicles v
CROSS JOIN fleet_maintenance_types t
WHERE t.is_active = TRUE
ON CONFLICT (vehicle_id, maintenance_type_id) DO NOTHING;

-- ── Page permission entry (reuses the existing page_permissions /
--    PermissionsPage mechanism — no new user_role). access_level 2 = edit,
--    matching the SMALLINT convention from 032_page_permissions.sql. ──
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('fleet_management', 'super_admin', 2),
  ('fleet_management', 'it_admin',    2)
ON CONFLICT (page_key, role) DO NOTHING;
