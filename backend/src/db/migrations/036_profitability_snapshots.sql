CREATE TABLE IF NOT EXISTS profitability_snapshots (
  id              SERIAL PRIMARY KEY,
  snapshot_date   DATE        NOT NULL,
  total_revenue   NUMERIC(16,2),
  total_cost      NUMERIC(16,2),
  gross_profit    NUMERIC(16,2),
  gross_profit_pct NUMERIC(8,4),
  qty             INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(snapshot_date)
);
