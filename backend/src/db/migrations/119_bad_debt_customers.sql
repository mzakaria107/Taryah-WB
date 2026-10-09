-- Customers whose debt has been flagged as uncollectable ("مديونية معدومة").
-- Presence of a row = flagged; un-flagging deletes the row. Toggled from the
-- debt-by-period page (needs full access on aging_by_period).
CREATE TABLE IF NOT EXISTS bad_debt_customers (
  customer_id VARCHAR(100) PRIMARY KEY,
  marked_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  marked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
