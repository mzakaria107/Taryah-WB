-- Region Performance & Planning page permissions — management-level page
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('region_performance', 'super_admin',    2),
  ('region_performance', 'it_admin',       2),
  ('region_performance', 'top_management', 1),
  ('region_performance', 'sales_manager',  2),
  ('region_performance', 'supervisor',     0),
  ('region_performance', 'region_manager', 1),
  ('region_performance', 'sales_rep',      0),
  ('region_performance', 'fridge_admin',   0),
  ('region_performance', 'accounts',       0),
  ('region_performance', 'viewer',         0)
ON CONFLICT DO NOTHING;
