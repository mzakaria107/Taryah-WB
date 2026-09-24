-- sales_activity has NO Arabic item name and NO item code anywhere in the
-- schema (verified: item_name_en / item_category_en are the only item
-- columns that exist app-wide) — so displaying either requires an
-- admin-maintained translation/code overlay, not another live-pulled field.
-- This table is deliberately just a display overlay, keyed on the same
-- item_name_en identity already used everywhere (quality_returns_report_lines
-- .item_name, /items, /report) — it never becomes the join key for anything,
-- so a missing/blank row here just falls back to showing the English name.
CREATE TABLE IF NOT EXISTS quality_returns_item_info (
  item_name_en  VARCHAR(300) PRIMARY KEY,
  item_name_ar  VARCHAR(300),
  item_code     VARCHAR(50),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
