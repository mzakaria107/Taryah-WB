-- Category Performance page permissions — admin only for now
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('category_performance', 'super_admin',    2),
  ('category_performance', 'it_admin',       2),
  ('category_performance', 'top_management', 0),
  ('category_performance', 'sales_manager',  0),
  ('category_performance', 'supervisor',     0),
  ('category_performance', 'region_manager', 0),
  ('category_performance', 'sales_rep',      0),
  ('category_performance', 'fridge_admin',   0),
  ('category_performance', 'accounts',       0),
  ('category_performance', 'viewer',         0)
ON CONFLICT DO NOTHING;
