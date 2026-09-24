-- Discount Shops page permissions — admin only for now
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('discount_shops', 'super_admin',    2),
  ('discount_shops', 'it_admin',       2),
  ('discount_shops', 'top_management', 0),
  ('discount_shops', 'sales_manager',  0),
  ('discount_shops', 'supervisor',     0),
  ('discount_shops', 'region_manager', 0),
  ('discount_shops', 'sales_rep',      0),
  ('discount_shops', 'fridge_admin',   0),
  ('discount_shops', 'accounts',       0),
  ('discount_shops', 'viewer',         0)
ON CONFLICT DO NOTHING;
