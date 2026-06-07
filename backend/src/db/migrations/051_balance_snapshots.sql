-- Daily balance snapshots for debt-change tracking
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id            SERIAL PRIMARY KEY,
  snapshot_date DATE          NOT NULL,
  customer_id   VARCHAR(100)  NOT NULL,
  customer_name VARCHAR(300),
  total_balance NUMERIC(15,2) DEFAULT 0,
  invoice_count INTEGER       DEFAULT 0,
  created_at    TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(snapshot_date, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_bsnap_date        ON balance_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_bsnap_customer_id ON balance_snapshots(customer_id);
