-- Migration 022: Refrigerator (Asset) Tracking
-- Tables: fridges, fridge_transfers

DO $$ BEGIN
  CREATE TYPE fridge_status AS ENUM (
    'active', 'inactive', 'out_of_service', 'damaged',
    'warehouse_maintenance', 'warehouse_new', 'warehouse_used'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fridge_transfer_type AS ENUM ('repair', 'reassign');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Main fridges table
CREATE TABLE IF NOT EXISTS fridges (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_number    VARCHAR(100) NOT NULL UNIQUE,       -- رقم الثلاجة / رقم الأصل
  customer_code   VARCHAR(100),                        -- رقم العميل (nullable when in warehouse)
  customer_name   VARCHAR(300),
  region_id       INTEGER      REFERENCES regions(id) ON DELETE SET NULL,
  route_code      INTEGER,
  salesrep_name   VARCHAR(200),
  contract_number VARCHAR(100),                        -- رقم العقد
  contract_date   DATE,                               -- تاريخ إبرام العقد
  status          fridge_status NOT NULL DEFAULT 'active',
  notes           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
  updated_by      UUID         REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fridges_customer ON fridges(customer_code);
CREATE INDEX IF NOT EXISTS idx_fridges_status   ON fridges(status);
CREATE INDEX IF NOT EXISTS idx_fridges_region   ON fridges(region_id);
CREATE INDEX IF NOT EXISTS idx_fridges_asset    ON fridges(asset_number);

-- Transfer/movement history
CREATE TABLE IF NOT EXISTS fridge_transfers (
  id                 UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  fridge_id          UUID                 NOT NULL REFERENCES fridges(id) ON DELETE CASCADE,
  transfer_type      fridge_transfer_type NOT NULL,
  from_customer_code VARCHAR(100),
  from_customer_name VARCHAR(300),
  to_customer_code   VARCHAR(100),
  to_customer_name   VARCHAR(300),
  notes              TEXT,
  transferred_at     TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
  created_by         UUID                 REFERENCES users(id) ON DELETE SET NULL,
  created_by_name    VARCHAR(200)
);

CREATE INDEX IF NOT EXISTS idx_fridge_transfers_fridge ON fridge_transfers(fridge_id);
