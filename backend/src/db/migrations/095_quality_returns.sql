-- New system: مرتجعات عيوب الجودة (quality-defect returns) — daily entry by
-- item × route within one region at a time, entered by a new dedicated
-- "مراقب مرتجعات جودة" role. Distinct from carrefour_damage_* (a different
-- business — Carrefour branches, not regions/routes) and from
-- quality_issues (a NetSuite-uploaded warehouse/QC report with no
-- route/rep dimension at all — see CLAUDE.md).
--
-- The item list is NOT a manually-maintained catalog like Carrefour's —
-- it's pulled live from sales_activity.item_name_en (65 distinct items,
-- small enough to render as full grid rows with no pagination), so it
-- never needs separate maintenance.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'quality_returns_monitor';

-- رقم السيارة — each rep's registered vehicle, editable from the existing
-- /rep-management page (no new page needed for this one field).
ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS vehicle_number VARCHAR(50);

-- Region ↔ monitor assignment (the "settings" screen), same shape as
-- carrefour_branch_reps.
CREATE TABLE IF NOT EXISTS quality_returns_region_monitors (
  id           SERIAL PRIMARY KEY,
  region_id    INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  user_id      UUID    NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (region_id, user_id)
);

-- One header row per region per day — the entry grid covers EVERY route in
-- the region at once (all its columns), saved in a single submission.
CREATE TABLE IF NOT EXISTS quality_returns_reports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id          INTEGER NOT NULL REFERENCES regions(id),
  report_date        DATE    NOT NULL,
  submitted_by       UUID REFERENCES users(id),
  submitted_by_name  VARCHAR(200),
  notes              TEXT,
  report_no          SERIAL UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (region_id, report_date)
);

-- One line per (route × item) with a recorded quantity/expiry — route_id
-- matches routes.route_id (the plain integer key already used app-wide,
-- see 065_sales_reps_route.sql), NOT a route master FK-enforced id, so a
-- route referenced by a rep but missing from `routes` can still be entered.
CREATE TABLE IF NOT EXISTS quality_returns_report_lines (
  id           BIGSERIAL PRIMARY KEY,
  report_id    UUID NOT NULL REFERENCES quality_returns_reports(id) ON DELETE CASCADE,
  route_id     INTEGER NOT NULL,
  item_name    VARCHAR(300) NOT NULL,
  quantity     NUMERIC(14,2) NOT NULL DEFAULT 0,
  expiry_date  DATE,
  notes        TEXT,
  UNIQUE (report_id, route_id, item_name)
);

CREATE INDEX IF NOT EXISTS idx_qr_region_monitors_region ON quality_returns_region_monitors(region_id);
CREATE INDEX IF NOT EXISTS idx_qr_region_monitors_user   ON quality_returns_region_monitors(user_id);
CREATE INDEX IF NOT EXISTS idx_qr_reports_region         ON quality_returns_reports(region_id);
CREATE INDEX IF NOT EXISTS idx_qr_reports_date           ON quality_returns_reports(report_date);
CREATE INDEX IF NOT EXISTS idx_qr_lines_report           ON quality_returns_report_lines(report_id);
CREATE INDEX IF NOT EXISTS idx_qr_lines_route            ON quality_returns_report_lines(route_id);

-- Page permissions: entry (monitor + admins only) and report/search
-- (management + admins; monitors don't need the roll-up).
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('quality_returns_entry', 'super_admin',    2),
  ('quality_returns_entry', 'it_admin',       2),
  ('quality_returns_entry', 'top_management', 0),
  ('quality_returns_entry', 'sales_manager',  0),
  ('quality_returns_entry', 'supervisor',     0),
  ('quality_returns_entry', 'region_manager', 0),
  ('quality_returns_entry', 'sales_rep',      0),
  ('quality_returns_entry', 'fridge_admin',   0),
  ('quality_returns_entry', 'accounts',       0),
  ('quality_returns_entry', 'viewer',         0),
  ('quality_returns_entry', 'carrefour_rep',  0),
  ('quality_returns_entry', 'quality_returns_monitor', 2)
ON CONFLICT DO NOTHING;

INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('quality_returns_report', 'super_admin',    2),
  ('quality_returns_report', 'it_admin',       2),
  ('quality_returns_report', 'top_management', 1),
  ('quality_returns_report', 'sales_manager',  2),
  ('quality_returns_report', 'supervisor',     0),
  ('quality_returns_report', 'region_manager', 1),
  ('quality_returns_report', 'sales_rep',      0),
  ('quality_returns_report', 'fridge_admin',   0),
  ('quality_returns_report', 'accounts',       0),
  ('quality_returns_report', 'viewer',         0),
  ('quality_returns_report', 'carrefour_rep',  0),
  ('quality_returns_report', 'quality_returns_monitor', 0)
ON CONFLICT DO NOTHING;
