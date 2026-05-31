-- Add summary page permissions for all roles
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('summary', 'super_admin',    2),
  ('summary', 'it_admin',       2),
  ('summary', 'top_management', 2),
  ('summary', 'sales_manager',  2),
  ('summary', 'supervisor',     1),
  ('summary', 'region_manager', 1),
  ('summary', 'sales_rep',      0),
  ('summary', 'fridge_admin',   0),
  ('summary', 'accounts',       1),
  ('summary', 'viewer',         1)
ON CONFLICT DO NOTHING;
