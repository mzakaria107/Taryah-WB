-- «أداء عملاء الاسبيشيال» (/special-customers) — copy of the Discount Shops page for a second
-- customer segment. Admin-only like discount_shops. Its two tables (special_customers,
-- special_customer_contracts) are created lazily by routes/specialCustomers.js.
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('special_customers', 'super_admin',    2),
  ('special_customers', 'it_admin',       2),
  ('special_customers', 'top_management', 0),
  ('special_customers', 'sales_manager',  0),
  ('special_customers', 'supervisor',     0),
  ('special_customers', 'region_manager', 0),
  ('special_customers', 'sales_rep',      0),
  ('special_customers', 'fridge_admin',   0),
  ('special_customers', 'accounts',       0),
  ('special_customers', 'viewer',         0)
ON CONFLICT DO NOTHING;
