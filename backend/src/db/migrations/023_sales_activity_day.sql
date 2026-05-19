-- Migration 023: Add day column to sales_activity for daily tracking
ALTER TABLE sales_activity
  ADD COLUMN IF NOT EXISTS day SMALLINT CHECK (day BETWEEN 1 AND 31);

CREATE INDEX IF NOT EXISTS idx_sa_day ON sales_activity(day);
