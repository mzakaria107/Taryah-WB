-- Add page_permissions rows for rep_management and performance_dashboard
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('rep_management', 'super_admin',    2),
  ('rep_management', 'it_admin',       2),
  ('rep_management', 'top_management', 0),
  ('rep_management', 'sales_manager',  1),
  ('rep_management', 'supervisor',     0),
  ('rep_management', 'region_manager', 0),
  ('rep_management', 'sales_rep',      0),
  ('rep_management', 'fridge_admin',   0),
  ('rep_management', 'accounts',       0),
  ('rep_management', 'viewer',         0),

  ('performance_dashboard', 'super_admin',    2),
  ('performance_dashboard', 'it_admin',       2),
  ('performance_dashboard', 'top_management', 2),
  ('performance_dashboard', 'sales_manager',  2),
  ('performance_dashboard', 'supervisor',     1),
  ('performance_dashboard', 'region_manager', 1),
  ('performance_dashboard', 'sales_rep',      0),
  ('performance_dashboard', 'fridge_admin',   0),
  ('performance_dashboard', 'accounts',       0),
  ('performance_dashboard', 'viewer',         0)
ON CONFLICT (page_key, role) DO NOTHING;
