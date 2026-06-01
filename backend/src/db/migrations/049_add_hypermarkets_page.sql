-- Hypermarkets page permissions — admin only for now
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('hypermarkets', 'super_admin',    2),
  ('hypermarkets', 'it_admin',       2),
  ('hypermarkets', 'top_management', 0),
  ('hypermarkets', 'sales_manager',  0),
  ('hypermarkets', 'supervisor',     0),
  ('hypermarkets', 'region_manager', 0),
  ('hypermarkets', 'sales_rep',      0),
  ('hypermarkets', 'fridge_admin',   0),
  ('hypermarkets', 'accounts',       0),
  ('hypermarkets', 'viewer',         0)
ON CONFLICT DO NOTHING;
