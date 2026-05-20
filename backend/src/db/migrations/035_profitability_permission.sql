-- Migration 035: add profitability page to page_permissions
INSERT INTO page_permissions (page_key, role, access_level) VALUES
  ('profitability', 'super_admin',    2),
  ('profitability', 'it_admin',       2),
  ('profitability', 'top_management', 1),
  ('profitability', 'sales_manager',  2),
  ('profitability', 'supervisor',     0),
  ('profitability', 'region_manager', 0),
  ('profitability', 'sales_rep',      0),
  ('profitability', 'fridge_admin',   0),
  ('profitability', 'viewer',         0)
ON CONFLICT DO NOTHING;
