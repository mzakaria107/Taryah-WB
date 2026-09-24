-- Carrefour branch damage (توالف) daily entry system.
--
-- A dedicated "مروج" (promoter) account is assigned to one or more Carrefour
-- branches (carrefour_branch_reps) and logs that branch's damaged-quantity
-- count, broken down by item, once per day (carrefour_damage_reports /
-- carrefour_damage_report_items). Management reads the roll-up on the new
-- dynamic report page. Branches and the item catalog are both maintained by
-- hand from the settings panel — no external file feeds this, unlike every
-- other "توالف" figure in the app (quality_issues / sales_activity.bad_return_qty),
-- which are uploaded from NetSuite exports.

-- New role for promoter accounts. Added outside the rest of this file's
-- statements would be ideal, but a same-transaction ADD VALUE is fine as
-- long as nothing in THIS transaction inserts a row using it — and nothing
-- here does (page_permissions.role is plain VARCHAR, not the enum).
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'carrefour_rep';

-- ── Branch master (manually maintained) ──────────────────────
CREATE TABLE IF NOT EXISTS carrefour_branches (
  id           SERIAL PRIMARY KEY,
  branch_name  VARCHAR(200) NOT NULL,
  branch_code  VARCHAR(50)  UNIQUE,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Damage item catalog (manually maintained, picked from a dropdown so
--    the report can aggregate by item without free-text typos fragmenting it) ──
CREATE TABLE IF NOT EXISTS carrefour_damage_items (
  id          SERIAL PRIMARY KEY,
  item_name   VARCHAR(300) NOT NULL UNIQUE,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Branch ↔ promoter assignment (the "settings" screen) ─────
CREATE TABLE IF NOT EXISTS carrefour_branch_reps (
  id           SERIAL PRIMARY KEY,
  branch_id    INTEGER NOT NULL REFERENCES carrefour_branches(id) ON DELETE CASCADE,
  user_id      UUID    NOT NULL REFERENCES users(id)               ON DELETE CASCADE,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (branch_id, user_id)
);

-- ── Daily report header — one per branch per day ─────────────
CREATE TABLE IF NOT EXISTS carrefour_damage_reports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          INTEGER NOT NULL REFERENCES carrefour_branches(id),
  report_date        DATE    NOT NULL,
  submitted_by       UUID REFERENCES users(id),
  submitted_by_name  VARCHAR(200), -- denormalized so a later-deleted account doesn't erase authorship
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (branch_id, report_date)
);

-- ── Daily report lines — quantity per item ───────────────────
CREATE TABLE IF NOT EXISTS carrefour_damage_report_items (
  id          SERIAL PRIMARY KEY,
  report_id   UUID NOT NULL REFERENCES carrefour_damage_reports(id) ON DELETE CASCADE,
  item_id     INTEGER REFERENCES carrefour_damage_items(id),
  item_name   VARCHAR(300) NOT NULL, -- snapshot: a later item rename/delete must not corrupt history
  quantity    NUMERIC(14,2) NOT NULL DEFAULT 0,
  UNIQUE (report_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_cfr_branch_reps_branch  ON carrefour_branch_reps(branch_id);
CREATE INDEX IF NOT EXISTS idx_cfr_branch_reps_user    ON carrefour_branch_reps(user_id);
CREATE INDEX IF NOT EXISTS idx_cfr_reports_branch      ON carrefour_damage_reports(branch_id);
CREATE INDEX IF NOT EXISTS idx_cfr_reports_date        ON carrefour_damage_reports(report_date);
CREATE INDEX IF NOT EXISTS idx_cfr_report_items_report ON carrefour_damage_report_items(report_id);
CREATE INDEX IF NOT EXISTS idx_cfr_report_items_item   ON carrefour_damage_report_items(item_id);

-- ── Page permissions ──────────────────────────────────────────
-- Entry page: promoters get full access to log their own branches; admins
-- get full access too (can enter on behalf / manage settings). Nobody else.
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('carrefour_damage_entry', 'super_admin',    2),
  ('carrefour_damage_entry', 'it_admin',       2),
  ('carrefour_damage_entry', 'top_management', 0),
  ('carrefour_damage_entry', 'sales_manager',  0),
  ('carrefour_damage_entry', 'supervisor',     0),
  ('carrefour_damage_entry', 'region_manager', 0),
  ('carrefour_damage_entry', 'sales_rep',      0),
  ('carrefour_damage_entry', 'fridge_admin',   0),
  ('carrefour_damage_entry', 'accounts',       0),
  ('carrefour_damage_entry', 'viewer',         0),
  ('carrefour_damage_entry', 'carrefour_rep',  2)
ON CONFLICT DO NOTHING;

-- Report + settings page: management reads (view-only for most), admins
-- get full (settings: branches/items/assignment). Promoters don't see it —
-- they only log, they don't need the roll-up.
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('carrefour_damage_report', 'super_admin',    2),
  ('carrefour_damage_report', 'it_admin',       2),
  ('carrefour_damage_report', 'top_management', 1),
  ('carrefour_damage_report', 'sales_manager',  2),
  ('carrefour_damage_report', 'supervisor',     0),
  ('carrefour_damage_report', 'region_manager', 1),
  ('carrefour_damage_report', 'sales_rep',      0),
  ('carrefour_damage_report', 'fridge_admin',   0),
  ('carrefour_damage_report', 'accounts',       0),
  ('carrefour_damage_report', 'viewer',         0),
  ('carrefour_damage_report', 'carrefour_rep',  0)
ON CONFLICT DO NOTHING;
