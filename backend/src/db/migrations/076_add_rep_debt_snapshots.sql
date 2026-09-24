-- Freezes each rep's outstanding balance for a CLOSED month the first time
-- it's read, so commissions/performance figures for a past month stay
-- stable instead of silently drifting as invoices/payments keep changing
-- after the month is over.
CREATE TABLE IF NOT EXISTS rep_debt_snapshots (
  rep_id               INTEGER NOT NULL REFERENCES sales_reps(id),
  year                 INTEGER NOT NULL,
  month                INTEGER NOT NULL,
  outstanding_balance  NUMERIC NOT NULL,
  snapshotted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (rep_id, year, month)
);
