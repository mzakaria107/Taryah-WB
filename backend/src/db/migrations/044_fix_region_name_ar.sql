-- Fix name_ar in regions table to use proper Arabic names
-- matching the exact location names returned by NetSuite WebQuery.
-- Previously name_ar was incorrectly stored with English transliterations.

UPDATE regions SET name_ar = CASE
  WHEN LOWER(TRIM(name_en)) IN ('shaqraa', 'shaqra', 'al shaqraa')              THEN 'شقرا'
  WHEN LOWER(TRIM(name_en)) IN ('riyadh', 'al riyadh', 'al-riyadh')             THEN 'الرياض'
  WHEN LOWER(TRIM(name_en)) IN ('hael', 'hail', 'ha''il', 'hayl')               THEN 'حائل'
  WHEN LOWER(TRIM(name_en)) IN ('qassem', 'qasim', 'al qassem', 'al-qassim',
                                 'al qasim', 'al-qasim')                         THEN 'القصيم'
  WHEN LOWER(TRIM(name_en)) IN ('al dawadmy', 'dawadmy', 'al dawadmi',
                                 'al-dawadmi', 'dawadmi')                         THEN 'الدوادمي'
  WHEN LOWER(TRIM(name_en)) IN ('arar', 'arar - sakaka', 'arar-sakaka',
                                 'arar sakaka', 'arrar')                          THEN 'عرعر'
  WHEN LOWER(TRIM(name_en)) IN ('sakaka')                                         THEN 'سكاكا'
  WHEN LOWER(TRIM(name_en)) IN ('el madina', 'al madina', 'al-madina',
                                 'medina', 'madinah', 'al madinah',
                                 'al-madinah', 'madinah al munawarah')            THEN 'المدينة المنورة'
  WHEN LOWER(TRIM(name_en)) IN ('dammam', 'al dammam', 'al-dammam',
                                 'eastern province', 'eastern region')            THEN 'الدمام'
  WHEN LOWER(TRIM(name_en)) IN ('carrefour - riyadh', 'carrefour riyadh',
                                 'carrefour')                                     THEN 'كارفور الرياض'
  WHEN LOWER(TRIM(name_en)) IN ('atayeb alulya', 'atayeb', 'tayeb',
                                 'taybah alulya')                                 THEN 'طيبة العليا'
  ELSE name_ar
END
WHERE name_ar ~* '^[A-Za-z]'   -- only rows where name_ar starts with English letters
   OR name_ar = name_en;       -- or name_ar is a copy of name_en
