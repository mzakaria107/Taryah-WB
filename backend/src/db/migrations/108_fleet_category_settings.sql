-- Turns the two hardcoded category lists in fleet.js (vehicle categories
-- CATEGORIES/CATEGORY_LABELS_AR, and expense categories EXPENSE_CATEGORIES)
-- into admin-editable lookup tables, same "settings screen adds/edits rows"
-- pattern already used for fleet_maintenance_types. Seeded with the exact
-- same keys/labels the hardcoded lists used, so no existing fleet_vehicles.
-- category or fleet_expenses.category value needs touching.
--
-- The two columns had a hard CHECK (category IN (...)) restricting them to
-- the fixed list — that has to go for a newly-added category to actually be
-- storable, replaced by a real FOREIGN KEY to the lookup table's `key`
-- (which IS the primary key, not a separate surrogate id, since `key` is
-- exactly the string already stored in every existing row). A category is
-- only ever deactivated (is_active = FALSE), never deleted, so there is no
-- ON DELETE case to handle — matches fleet_maintenance_types' own
-- soft-delete convention.

CREATE TABLE IF NOT EXISTS fleet_vehicle_categories (
  key         VARCHAR(20)  PRIMARY KEY,
  name_ar     VARCHAR(100) NOT NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO fleet_vehicle_categories (key, name_ar, sort_order) VALUES
  ('ton_3',     'سيارة 3 طن',            1),
  ('ton_5',     'سيارة 5 طن',            2),
  ('ton_10',    'سيارة 10 طن',           3),
  ('trailer',   'تريلا',                 4),
  ('hino',      'هينو',                  5),
  ('staff_car', 'سيارة موظفين صغيرة',    6)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE fleet_vehicles DROP CONSTRAINT IF EXISTS fleet_vehicles_category_check;
ALTER TABLE fleet_vehicles
  ADD CONSTRAINT fleet_vehicles_category_fkey
  FOREIGN KEY (category) REFERENCES fleet_vehicle_categories(key) ON UPDATE CASCADE;

-- fleet_maintenance_types.category ("التصنيف المستهدف" — which vehicle
-- category a maintenance type applies to, NULL = every category) never had
-- a CHECK constraint, only the app-level CATEGORIES.includes() check —
-- giving it a real FK closes that gap now that categories are DB rows.
-- Safe: every existing row has category = NULL (verified on production).
ALTER TABLE fleet_maintenance_types
  ADD CONSTRAINT fleet_maintenance_types_category_fkey
  FOREIGN KEY (category) REFERENCES fleet_vehicle_categories(key) ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS fleet_expense_categories (
  key         VARCHAR(30)  PRIMARY KEY,
  name_ar     VARCHAR(100) NOT NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO fleet_expense_categories (key, name_ar, sort_order) VALUES
  ('fuel',      'وقود',    1),
  ('repair',    'إصلاح',   2),
  ('tires',     'إطارات',  3),
  ('insurance', 'تأمين',   4),
  ('license',   'رخصة',    5),
  ('other',     'أخرى',    6)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE fleet_expenses DROP CONSTRAINT IF EXISTS fleet_expenses_category_check;
ALTER TABLE fleet_expenses
  ADD CONSTRAINT fleet_expenses_category_fkey
  FOREIGN KEY (category) REFERENCES fleet_expense_categories(key) ON UPDATE CASCADE;
