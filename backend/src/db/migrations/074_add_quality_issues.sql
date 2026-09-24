-- Quality issues (توالف الجودة) — uploaded from NetSuite "Quality Issues
-- Quantity and Cost" report. Distinct from sales_activity.bad_return_qty:
-- this tracks priced quality-adjustment line items (qty + cost) per region/item.
CREATE TABLE IF NOT EXISTS quality_issues (
  id               UUID PRIMARY KEY,
  region_id        INTEGER REFERENCES regions(id),
  region_name_ar   TEXT NOT NULL,   -- parsed Arabic region name (e.g. 'الرياض')
  location_raw     TEXT,            -- full "Location: Name" cell as exported
  item_type        TEXT,
  item_name        TEXT,
  issue_date       DATE,
  document_number  TEXT,
  memo             TEXT,
  quantity         NUMERIC,
  pct_of_quantity  NUMERIC,
  unit_value       NUMERIC,
  total_cost       NUMERIC,
  upload_batch_id  UUID REFERENCES upload_batches(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_number, item_name, issue_date)
);

CREATE INDEX IF NOT EXISTS idx_quality_issues_region ON quality_issues(region_id);
CREATE INDEX IF NOT EXISTS idx_quality_issues_date   ON quality_issues(issue_date);

INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('quality_issues', 'super_admin',    2),
  ('quality_issues', 'it_admin',       2),
  ('quality_issues', 'top_management', 1),
  ('quality_issues', 'sales_manager',  2),
  ('quality_issues', 'supervisor',     0),
  ('quality_issues', 'region_manager', 1),
  ('quality_issues', 'sales_rep',      0),
  ('quality_issues', 'fridge_admin',   0),
  ('quality_issues', 'accounts',       0),
  ('quality_issues', 'viewer',         0)
ON CONFLICT DO NOTHING;
