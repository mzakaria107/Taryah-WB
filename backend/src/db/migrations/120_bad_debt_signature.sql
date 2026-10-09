-- Signature for the bad-debt flag: name captured at flag time + an audit log of every
-- mark/unmark. Also created lazily by ensureBadDebtTable() in routes/aging.js.
ALTER TABLE bad_debt_customers ADD COLUMN IF NOT EXISTS marked_by_name VARCHAR(200);
CREATE TABLE IF NOT EXISTS bad_debt_log (
  id          SERIAL PRIMARY KEY,
  customer_id VARCHAR(100) NOT NULL,
  action      VARCHAR(10)  NOT NULL,   -- 'mark' | 'unmark'
  user_id     UUID,
  user_name   VARCHAR(200),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
