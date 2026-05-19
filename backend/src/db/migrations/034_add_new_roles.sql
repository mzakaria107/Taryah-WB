-- Add sales_manager and top_management to the user_role enum
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'sales_manager';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'top_management';

-- Default page permissions for both new roles (all regions scope)
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('dashboard',       'sales_manager',  2),
  ('invoices',        'sales_manager',  2),
  ('reports',         'sales_manager',  2),
  ('customer_detail', 'sales_manager',  2),
  ('sales_activity',  'sales_manager',  2),
  ('sales_tasks',     'sales_manager',  2),
  ('fridges',         'sales_manager',  0),
  ('stock',           'sales_manager',  0),
  ('current_stock',   'sales_manager',  0),
  ('upload',          'sales_manager',  0),
  ('users',           'sales_manager',  0),
  ('permissions',     'sales_manager',  0),

  ('dashboard',       'top_management', 1),
  ('invoices',        'top_management', 1),
  ('reports',         'top_management', 1),
  ('customer_detail', 'top_management', 1),
  ('sales_activity',  'top_management', 1),
  ('sales_tasks',     'top_management', 1),
  ('fridges',         'top_management', 1),
  ('stock',           'top_management', 0),
  ('current_stock',   'top_management', 0),
  ('upload',          'top_management', 0),
  ('users',           'top_management', 0),
  ('permissions',     'top_management', 0)
ON CONFLICT DO NOTHING;
