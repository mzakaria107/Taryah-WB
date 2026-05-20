ALTER TABLE profitability_snapshots
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'netsuite';
