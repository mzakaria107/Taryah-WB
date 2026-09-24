-- Split the single qty_target into per item-category targets. Category
-- names match sales_activity.item_category_en values exactly:
--   دجاج مبرد طرية  (chilled)
--   مقطعات طرية     (cuts)
--   دجاج مجمد       (frozen)
-- qty_target is kept as the authoritative total, recomputed server-side
-- as the sum of the three on every save.
ALTER TABLE sales_rep_targets
  ADD COLUMN IF NOT EXISTS qty_target_chilled INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_target_cuts    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_target_frozen  INTEGER NOT NULL DEFAULT 0;
