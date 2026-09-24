-- Commission calculation: admin-configurable item weights (default,
-- applies to everyone) + per-person commission ceilings (reps AND
-- managers — supervisor/region_manager/sector_manager/sales_manager,
-- all stored in rep_managers, distinguished by person_type here).
CREATE TABLE IF NOT EXISTS commission_weights (
  item_key   TEXT PRIMARY KEY,
  weight_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO commission_weights (item_key, weight_pct) VALUES
  ('qty', 20), ('customers', 20), ('debt', 20), ('damage', 20), ('fridges', 20)
ON CONFLICT (item_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS commission_limits (
  person_type       TEXT NOT NULL CHECK (person_type IN ('rep', 'manager')),
  person_id         INTEGER NOT NULL,
  commission_limit  NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_by        UUID REFERENCES users(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (person_type, person_id)
);
