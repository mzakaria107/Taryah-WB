-- Second daily entry type on the same page: جرد أرصدة (stock-on-hand count),
-- alongside the existing جرد توالف (damage). Same branches, same item
-- catalog (carrefour_damage_items — one product list serves both counts),
-- same promoter/admin actors and the same two page keys
-- (carrefour_damage_entry / carrefour_damage_report) — this is a second TAB
-- on the existing pages, not a new page, so no new page_permissions rows.
CREATE TABLE IF NOT EXISTS carrefour_stock_reports (
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

CREATE TABLE IF NOT EXISTS carrefour_stock_report_items (
  id          SERIAL PRIMARY KEY,
  report_id   UUID NOT NULL REFERENCES carrefour_stock_reports(id) ON DELETE CASCADE,
  item_id     INTEGER REFERENCES carrefour_damage_items(id),
  item_name   VARCHAR(300) NOT NULL, -- snapshot, same reasoning as carrefour_damage_report_items
  quantity    NUMERIC(14,2) NOT NULL DEFAULT 0,
  expiry_date DATE,
  notes       TEXT,
  UNIQUE (report_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_cfs_reports_branch      ON carrefour_stock_reports(branch_id);
CREATE INDEX IF NOT EXISTS idx_cfs_reports_date        ON carrefour_stock_reports(report_date);
CREATE INDEX IF NOT EXISTS idx_cfs_report_items_report ON carrefour_stock_report_items(report_id);
CREATE INDEX IF NOT EXISTS idx_cfs_report_items_item   ON carrefour_stock_report_items(item_id);
