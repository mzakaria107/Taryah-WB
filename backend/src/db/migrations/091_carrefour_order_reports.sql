-- Third tab on the same entry/report pages: جرد الطلبيات المستلمة
-- (received-orders count) — same branch/day/item-lines shape as the
-- damage (مرتجعات) and stock-on-hand tabs, against its own pair of tables.
-- Same item catalog (carrefour_damage_items), same page keys/permissions —
-- another tab, not a new page.
CREATE TABLE IF NOT EXISTS carrefour_order_reports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          INTEGER NOT NULL REFERENCES carrefour_branches(id),
  report_date        DATE    NOT NULL,
  submitted_by       UUID REFERENCES users(id),
  submitted_by_name  VARCHAR(200),
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (branch_id, report_date)
);

CREATE TABLE IF NOT EXISTS carrefour_order_report_items (
  id          SERIAL PRIMARY KEY,
  report_id   UUID NOT NULL REFERENCES carrefour_order_reports(id) ON DELETE CASCADE,
  item_id     INTEGER REFERENCES carrefour_damage_items(id),
  item_name   VARCHAR(300) NOT NULL,
  quantity    NUMERIC(14,2) NOT NULL DEFAULT 0,
  expiry_date DATE,
  notes       TEXT,
  UNIQUE (report_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_cfo_reports_branch      ON carrefour_order_reports(branch_id);
CREATE INDEX IF NOT EXISTS idx_cfo_reports_date        ON carrefour_order_reports(report_date);
CREATE INDEX IF NOT EXISTS idx_cfo_report_items_report ON carrefour_order_report_items(report_id);
CREATE INDEX IF NOT EXISTS idx_cfo_report_items_item   ON carrefour_order_report_items(item_id);
