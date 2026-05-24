-- Migration 043: add sales_report page to page_permissions
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('sales_report', 'super_admin',    2),
  ('sales_report', 'it_admin',       2),
  ('sales_report', 'top_management', 2),
  ('sales_report', 'sales_manager',  2),
  ('sales_report', 'supervisor',     1),
  ('sales_report', 'region_manager', 1),
  ('sales_report', 'sales_rep',      0),
  ('sales_report', 'fridge_admin',   0),
  ('sales_report', 'viewer',         0)
ON CONFLICT DO NOTHING;
