-- Restores the صفحة الربحية page_permissions rows deleted by migration 083.
-- The page itself, its route, and its NetSuite cron job have been re-added
-- to the app (profitability_snapshots was left intact the whole time).
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('profitability', 'super_admin',    2),
  ('profitability', 'it_admin',       2),
  ('profitability', 'top_management', 1),
  ('profitability', 'sales_manager',  2),
  ('profitability', 'supervisor',     0),
  ('profitability', 'region_manager', 0),
  ('profitability', 'sales_rep',      0),
  ('profitability', 'fridge_admin',   0),
  ('profitability', 'accounts',       0),
  ('profitability', 'viewer',         0)
ON CONFLICT (page_key, role) DO UPDATE SET access_level = EXCLUDED.access_level;
