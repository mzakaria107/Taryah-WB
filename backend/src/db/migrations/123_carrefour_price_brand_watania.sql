-- «الوطنية» competitor brand for the Carrefour price survey (entry matrix + cross-branch report).
-- Placed right after «انتاج» and before our own brand «طريه», which stays the last column.
UPDATE carrefour_price_brands SET sort_order = sort_order + 1
 WHERE is_own_brand = TRUE
   AND NOT EXISTS (SELECT 1 FROM carrefour_price_brands WHERE name = 'الوطنية');
INSERT INTO carrefour_price_brands (name, is_own_brand, sort_order)
SELECT 'الوطنية', FALSE,
       COALESCE((SELECT sort_order FROM carrefour_price_brands WHERE name = 'انتاج'), 8) + 1
ON CONFLICT (name) DO NOTHING;
