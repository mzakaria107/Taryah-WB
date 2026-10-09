-- "خطة المبيعات" page: management only by default.
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('sales_plan', 'super_admin', 2), ('sales_plan', 'it_admin', 2),
  ('sales_plan', 'top_management', 2), ('sales_plan', 'sales_manager', 2),
  ('sales_plan', 'supervisor', 0), ('sales_plan', 'region_manager', 0),
  ('sales_plan', 'sales_rep', 0), ('sales_plan', 'fridge_admin', 0),
  ('sales_plan', 'accounts', 1), ('sales_plan', 'viewer', 0)
ON CONFLICT (page_key, role) DO NOTHING;
