-- Migration 028: Stock management tables
-- NetSuite stock snapshots + area distribution history

-- ── Distribution areas (locations) ────────────────────────────
CREATE TABLE IF NOT EXISTS stock_areas (
  id         SERIAL PRIMARY KEY,
  area_code  VARCHAR(50)  UNIQUE NOT NULL,
  area_name  VARCHAR(200) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_active  BOOLEAN DEFAULT true
);

-- Pre-seed the 9 areas from the distribution sheet
INSERT INTO stock_areas (area_code, area_name, sort_order) VALUES
  ('hael',             'Hael',               1),
  ('arar_sakaka',      'Arar - Sakaka',       2),
  ('el_madina',        'El Madina',           3),
  ('qassem',           'Qassem',              4),
  ('riyadh',           'Riyadh',              5),
  ('shaqraa',          'Shaqraa',             6),
  ('al_dawadmy',       'Al Dawadmy',          7),
  ('carrefour_riyadh', 'Carrefour - Riyadh',  8),
  ('atayeb_alulya',    'Atayeb Alulya',       9)
ON CONFLICT (area_code) DO NOTHING;

-- ── Stock snapshots (each NetSuite sync = one snapshot) ────────
CREATE TABLE IF NOT EXISTS stock_snapshots (
  id            SERIAL PRIMARY KEY,
  snapshot_date DATE         NOT NULL DEFAULT CURRENT_DATE,
  synced_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  synced_by     INTEGER,     -- user id (no FK to avoid migration-order issues)
  source        VARCHAR(20)  NOT NULL DEFAULT 'netsuite',  -- 'netsuite' | 'manual'
  notes         TEXT,
  item_count    INTEGER      DEFAULT 0,
  status        VARCHAR(20)  DEFAULT 'success'
);

-- Snapshot line-items (one row per item per snapshot)
CREATE TABLE IF NOT EXISTS stock_snapshot_items (
  id            SERIAL PRIMARY KEY,
  snapshot_id   INTEGER NOT NULL REFERENCES stock_snapshots(id) ON DELETE CASCADE,
  item_name     VARCHAR(300),
  category      VARCHAR(200),
  netsuite_id   VARCHAR(100),
  item_code     VARCHAR(100),
  qty_on_hand   NUMERIC(14,2) DEFAULT 0,
  qty_available NUMERIC(14,2) DEFAULT 0,
  qty_on_order  NUMERIC(14,2) DEFAULT 0
);

-- ── Distribution uploads (each Excel upload = one distribution) ─
CREATE TABLE IF NOT EXISTS stock_distributions (
  id                SERIAL PRIMARY KEY,
  distribution_date DATE        NOT NULL DEFAULT CURRENT_DATE,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by       INTEGER,   -- user id (no FK to avoid migration-order issues)
  notes             TEXT,
  item_count        INTEGER DEFAULT 0
);

-- Distribution items (one row per item × area per upload)
CREATE TABLE IF NOT EXISTS stock_distribution_items (
  id              SERIAL PRIMARY KEY,
  distribution_id INTEGER NOT NULL REFERENCES stock_distributions(id) ON DELETE CASCADE,
  item_name       VARCHAR(300),
  category        VARCHAR(200),
  area_id         INTEGER REFERENCES stock_areas(id),
  area_name       VARCHAR(200),
  quantity        NUMERIC(14,2) DEFAULT 0
);

-- ── Indexes ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_stock_snap_items_snap   ON stock_snapshot_items(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_stock_snap_items_name   ON stock_snapshot_items(item_name);
CREATE INDEX IF NOT EXISTS idx_stock_dist_items_dist   ON stock_distribution_items(distribution_id);
CREATE INDEX IF NOT EXISTS idx_stock_dist_items_name   ON stock_distribution_items(item_name);
CREATE INDEX IF NOT EXISTS idx_stock_snapshots_date    ON stock_snapshots(snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_stock_distributions_date ON stock_distributions(distribution_date DESC);
