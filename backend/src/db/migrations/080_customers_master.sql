-- Migration 080: customer master table, fed by the "Customer List - CM" export.
--
-- Until now there was NO customer master anywhere in the schema: customer
-- attributes existed only as denormalized copies on transactional rows
-- (invoices.customer_name / sales_activity.category_name), so a customer with
-- no invoice this period was invisible, and the supervisor / creation-source
-- fields had nowhere to live at all.
--
-- Keyed on the customer code and upserted, because the CM export is a periodic
-- full-list download: re-uploading it must refresh the master, not duplicate it.
CREATE TABLE IF NOT EXISTS customers (
  customer_code     VARCHAR(100) PRIMARY KEY,
  customer_name     VARCHAR(300),
  branch_code       VARCHAR(50),
  branch_name_en    VARCHAR(200),
  region_id         INTEGER REFERENCES regions(id) ON DELETE SET NULL,
  route_code        INTEGER,
  route_name_en     VARCHAR(200),
  salesman_code     VARCHAR(50),
  salesman_name     VARCHAR(200),
  category_code     VARCHAR(50),
  category_name     VARCHAR(200),
  supervisor_code   VARCHAR(50),
  supervisor_name   VARCHAR(200),
  created_on_source TIMESTAMPTZ,          -- "Datetime Created" from the source system
  created_from_hht  BOOLEAN,              -- "Is Created From HHT"
  first_loaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  upload_batch_id   UUID
);

CREATE INDEX IF NOT EXISTS idx_customers_region     ON customers(region_id);
CREATE INDEX IF NOT EXISTS idx_customers_route      ON customers(route_code);
CREATE INDEX IF NOT EXISTS idx_customers_salesman   ON customers(salesman_name);
CREATE INDEX IF NOT EXISTS idx_customers_supervisor ON customers(supervisor_name);
CREATE INDEX IF NOT EXISTS idx_customers_category   ON customers(category_name);

-- upload_batches.file_type is an enum; this upload needs its own value.
ALTER TYPE upload_file_type ADD VALUE IF NOT EXISTS 'customer_list';
