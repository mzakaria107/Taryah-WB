-- Register "حساب العمولات" as a manageable page in the permissions system,
-- so who can view the commissions tab is configurable from صفحة الصلاحيات
-- instead of the previous hardcoded super_admin/it_admin-only check.
-- Defaults preserve current behavior: only super_admin/it_admin can see it
-- until an admin explicitly grants access to other roles.
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('commissions', 'super_admin',    2),
  ('commissions', 'it_admin',       2),
  ('commissions', 'top_management', 0),
  ('commissions', 'sales_manager',  0),
  ('commissions', 'supervisor',     0),
  ('commissions', 'region_manager', 0),
  ('commissions', 'sales_rep',      0),
  ('commissions', 'fridge_admin',   0),
  ('commissions', 'accounts',       0),
  ('commissions', 'viewer',         0)
ON CONFLICT DO NOTHING;
