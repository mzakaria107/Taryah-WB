-- The صفحة الربحية page, its route, and its NetSuite cron job have been
-- removed from the app. profitability_snapshots itself is left intact as
-- historical data — only the page_permissions rows for it are stale now.
DELETE FROM page_permissions WHERE page_key = 'profitability';
