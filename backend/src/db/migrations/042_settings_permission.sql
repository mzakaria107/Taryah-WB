-- Migration 042: add settings page (SMTP config) to page_permissions
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('settings', 'super_admin',    2),
  ('settings', 'it_admin',       2),
  ('settings', 'top_management', 0),
  ('settings', 'sales_manager',  0),
  ('settings', 'supervisor',     0),
  ('settings', 'region_manager', 0),
  ('settings', 'sales_rep',      0),
  ('settings', 'fridge_admin',   0),
  ('settings', 'viewer',         0)
ON CONFLICT DO NOTHING;
