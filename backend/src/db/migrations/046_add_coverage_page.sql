-- Add coverage page permissions for all roles
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('coverage', 'super_admin',    2),
  ('coverage', 'it_admin',       2),
  ('coverage', 'top_management', 1),
  ('coverage', 'sales_manager',  2),
  ('coverage', 'supervisor',     2),
  ('coverage', 'region_manager', 2),
  ('coverage', 'sales_rep',      1),
  ('coverage', 'fridge_admin',   0),
  ('coverage', 'accounts',       0),
  ('coverage', 'viewer',         0)
ON CONFLICT DO NOTHING;
