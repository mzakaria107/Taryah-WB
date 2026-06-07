-- Add aging page permissions for all roles
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('aging', 'super_admin',    2),
  ('aging', 'it_admin',       2),
  ('aging', 'top_management', 2),
  ('aging', 'sales_manager',  2),
  ('aging', 'supervisor',     1),
  ('aging', 'region_manager', 1),
  ('aging', 'sales_rep',      0),
  ('aging', 'fridge_admin',   0),
  ('aging', 'accounts',       2),
  ('aging', 'viewer',         1)
ON CONFLICT DO NOTHING;
