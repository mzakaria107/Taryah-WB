-- Add collections_performance page permissions for all roles
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('collections_performance', 'super_admin',    2),
  ('collections_performance', 'it_admin',       2),
  ('collections_performance', 'top_management', 2),
  ('collections_performance', 'sales_manager',  2),
  ('collections_performance', 'supervisor',     1),
  ('collections_performance', 'region_manager', 1),
  ('collections_performance', 'sales_rep',      0),
  ('collections_performance', 'fridge_admin',   0),
  ('collections_performance', 'accounts',       2),
  ('collections_performance', 'viewer',         1)
ON CONFLICT DO NOTHING;
