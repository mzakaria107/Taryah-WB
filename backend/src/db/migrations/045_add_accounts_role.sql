-- Add 'accounts' role to the user_role enum
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'accounts';

-- Default page permissions for accounts role
-- Access: dashboard, invoices, reports, customer_detail (read-only)
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('dashboard',       'accounts', 1),
  ('invoices',        'accounts', 1),
  ('reports',         'accounts', 1),
  ('customer_detail', 'accounts', 1),
  ('sales_activity',  'accounts', 0),
  ('sales_tasks',     'accounts', 0),
  ('fridges',         'accounts', 0),
  ('stock',           'accounts', 0),
  ('current_stock',   'accounts', 0),
  ('upload',          'accounts', 0),
  ('users',           'accounts', 0),
  ('permissions',     'accounts', 0),
  ('profitability',   'accounts', 0),
  ('settings',        'accounts', 0),
  ('sales_report',    'accounts', 0)
ON CONFLICT DO NOTHING;
