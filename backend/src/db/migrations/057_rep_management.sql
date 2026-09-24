-- Migration 057: Sales rep hierarchy + monthly targets
-- rep_managers: supervisors, region managers, sector managers, sales managers
-- sales_reps: reps linked to hierarchy and region
-- sales_rep_targets: monthly qty/customer/collection/credit targets per rep

CREATE TABLE IF NOT EXISTS rep_managers (
  id          SERIAL       PRIMARY KEY,
  name_ar     VARCHAR(200) NOT NULL,
  name_en     VARCHAR(200),
  role        VARCHAR(50)  NOT NULL
              CHECK (role IN ('supervisor','region_manager','sector_manager','sales_manager')),
  region_id   INTEGER      REFERENCES regions(id) ON DELETE SET NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rep_managers_role ON rep_managers(role);
CREATE INDEX IF NOT EXISTS idx_rep_managers_region ON rep_managers(region_id);

CREATE TABLE IF NOT EXISTS sales_reps (
  id                 SERIAL       PRIMARY KEY,
  name_ar            VARCHAR(200) NOT NULL,
  name_en            VARCHAR(200),
  netsuite_name      VARCHAR(300),        -- exact name in sales_activity / invoices
  region_id          INTEGER      REFERENCES regions(id) ON DELETE SET NULL,
  supervisor_id      INTEGER      REFERENCES rep_managers(id) ON DELETE SET NULL,
  region_manager_id  INTEGER      REFERENCES rep_managers(id) ON DELETE SET NULL,
  sector_manager_id  INTEGER      REFERENCES rep_managers(id) ON DELETE SET NULL,
  sales_manager_id   INTEGER      REFERENCES rep_managers(id) ON DELETE SET NULL,
  is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_reps_region ON sales_reps(region_id);
CREATE INDEX IF NOT EXISTS idx_sales_reps_netsuite ON sales_reps(netsuite_name);

CREATE TABLE IF NOT EXISTS sales_rep_targets (
  id                  SERIAL          PRIMARY KEY,
  rep_id              INTEGER         NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  year                SMALLINT        NOT NULL,
  month               SMALLINT        NOT NULL CHECK (month BETWEEN 1 AND 12),
  qty_target          INTEGER         NOT NULL DEFAULT 0,
  customer_target     INTEGER         NOT NULL DEFAULT 0,
  collection_target   NUMERIC(15,2)   NOT NULL DEFAULT 0,
  credit_limit        NUMERIC(15,2)   NOT NULL DEFAULT 0,
  UNIQUE (rep_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_srt_rep_period ON sales_rep_targets(rep_id, year, month);

-- Page permissions
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('rep_management',        'super_admin',    2),
  ('rep_management',        'it_admin',       2),
  ('rep_management',        'sales_manager',  1),
  ('rep_management',        'top_management', 1),
  ('rep_management',        'region_manager', 1),
  ('rep_management',        'viewer',         1),
  ('rep_management',        'accounts',       0),
  ('performance_dashboard', 'super_admin',    2),
  ('performance_dashboard', 'it_admin',       2),
  ('performance_dashboard', 'sales_manager',  1),
  ('performance_dashboard', 'top_management', 1),
  ('performance_dashboard', 'region_manager', 1),
  ('performance_dashboard', 'viewer',         1),
  ('performance_dashboard', 'accounts',       1)
ON CONFLICT (page_key, role) DO NOTHING;
