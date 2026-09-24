-- New Jeddah region — appears automatically in every region filter that
-- reads from the regions table. name_ar intentionally stores the English
-- identifier, matching how every other region row is stored (see the
-- "Region name storage gotcha" in CLAUDE.md).
INSERT INTO regions (name_ar, name_en)
SELECT 'Jeddah', 'Jeddah'
WHERE NOT EXISTS (SELECT 1 FROM regions WHERE name_en = 'Jeddah' OR name_ar = 'Jeddah');
