-- "الأسعار Survey" tab on the Carrefour promoter entry page: a matrix of
-- poultry items (rows) × competitor brands (columns) a promoter fills in
-- while walking the shelf at a branch, comparing our own price ("طريه")
-- against the market. Distinct from carrefour_damage_items/branches'
-- SKU-coded توالف catalog — this is a generic weight-class/cut catalog
-- shared across every brand's own product line, not our own SKUs.
--
-- Scoped by (branch_id, report_date) like the other three entry tabs
-- (توالف/أرصدة/طلبيات) so a survey has a real date and branch history, but
-- each CELL saves immediately on entry (see the /price-survey/cell route)
-- rather than one batch "حفظ" like those — a promoter fills cells in over
-- time while walking the aisle, not all at once.

CREATE TABLE IF NOT EXISTS carrefour_price_brands (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  -- Flags "طريه" (our own brand) — the column the "Average" of every OTHER
  -- brand is compared against, per the request. Only one row should ever
  -- have this true; enforced by convention/admin UI, not a DB constraint,
  -- since a future rebrand might need to move the flag to a new row first.
  is_own_brand BOOLEAN NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS carrefour_price_survey_items (
  id          SERIAL PRIMARY KEY,
  item_name   VARCHAR(200) NOT NULL UNIQUE,
  -- Section header the row falls under (الدجاج الكامل / المقطعات / …) —
  -- rendered as a full-width divider row in the matrix, matching the
  -- source spreadsheet's red category bars.
  category    VARCHAR(100),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- One row per (branch, date, item, brand) cell — a real UNIQUE constraint
-- so the cell-save route can upsert instead of needing a separate
-- check-then-insert (and so the matrix can never end up with two prices
-- for the same cell on the same day).
CREATE TABLE IF NOT EXISTS carrefour_price_survey_entries (
  id                  BIGSERIAL PRIMARY KEY,
  branch_id           INTEGER NOT NULL REFERENCES carrefour_branches(id) ON DELETE CASCADE,
  report_date         DATE NOT NULL,
  item_id             INTEGER NOT NULL REFERENCES carrefour_price_survey_items(id) ON DELETE CASCADE,
  brand_id            INTEGER NOT NULL REFERENCES carrefour_price_brands(id) ON DELETE CASCADE,
  price               NUMERIC(10,2) NOT NULL,
  -- "اختصار اسم المستخدم" shown directly in the cell — computed once at
  -- save time from the saver's real name (see initialsFrom in the route),
  -- not re-derived on every read, so it stays stable even if the user's
  -- display name changes later.
  entered_by          UUID REFERENCES users(id),
  entered_by_name     VARCHAR(200),
  entered_by_initials VARCHAR(10),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (branch_id, report_date, item_id, brand_id)
);
CREATE INDEX IF NOT EXISTS idx_cf_price_survey_lookup ON carrefour_price_survey_entries(branch_id, report_date);

-- Seed the 9 columns visible in the source spreadsheet — "طريه" flagged as
-- our own brand (see is_own_brand above).
INSERT INTO carrefour_price_brands (name, is_own_brand, sort_order) VALUES
  ('النخيل', FALSE, 1), ('الناصرية', FALSE, 2), ('رضوي', FALSE, 3), ('ساديا', FALSE, 4),
  ('المراعي', FALSE, 5), ('التنمية', FALSE, 6), ('الفروج الذهبي', FALSE, 7), ('انتاج', FALSE, 8),
  ('طريه', TRUE, 9)
ON CONFLICT (name) DO NOTHING;

-- Seed the rows visible in the source spreadsheet (it was cut off on
-- screen beyond "دجاج متنوع 900" — an admin can add any missing rows
-- afterward from the same items-management screen used for the other
-- Carrefour catalogs; this is a starting point, not assumed complete).
INSERT INTO carrefour_price_survey_items (item_name, category, sort_order) VALUES
  ('طرية 1200', 'الدجاج الكامل', 1),
  ('طرية 1100', 'الدجاج الكامل', 2),
  ('طرية 1000', 'الدجاج الكامل', 3),
  ('طرية 900', 'الدجاج الكامل', 4),
  ('طرية 800', 'الدجاج الكامل', 5),
  ('فيليه', 'المقطعات', 6),
  ('صدور بالعظم', 'المقطعات', 7),
  ('أفخاذ كاملة', 'المقطعات', 8),
  ('أجنحة', 'المقطعات', 9),
  ('أفخاذ علوية', 'المقطعات', 10),
  ('قوانص', 'الحويصلات', 11),
  ('كبدة', 'الحويصلات', 12),
  ('قلوب', 'الحويصلات', 13),
  ('دجاج متبل حار 600', 'المتبلات', 14),
  ('دجاج متبل مندي 600', 'المتبلات', 15),
  ('دجاج متنوع 900', 'المتبلات', 16)
ON CONFLICT (item_name) DO NOTHING;
