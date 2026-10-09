-- "أعمار المديونية حسب الفترة" — same data and audience as the aging page,
-- so every role starts with exactly the access it already has on `aging`.
INSERT INTO page_permissions (page_key, role, access_level)
SELECT 'aging_by_period', role, access_level
FROM page_permissions
WHERE page_key = 'aging'
ON CONFLICT (page_key, role) DO NOTHING;
