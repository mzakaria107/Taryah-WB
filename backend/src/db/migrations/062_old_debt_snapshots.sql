-- Freezes "دين الفواتير" for the old-debt collection tracker: the first
-- time a given customer is queried within a specific [period_from,
-- period_to] invoice-date window, their balance at that moment is locked
-- in here. Later calls reuse the frozen value instead of recomputing it
-- from invoices.balance (which changes as new payments come in), so the
-- admin can compare it against the live current balance to see how much
-- has actually been collected since the period was first opened.
CREATE TABLE IF NOT EXISTS old_debt_snapshots (
  id               SERIAL PRIMARY KEY,
  customer_id      VARCHAR(100) NOT NULL,
  period_from      DATE NOT NULL,
  period_to        DATE NOT NULL,
  snapshot_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  invoice_count    INTEGER NOT NULL DEFAULT 0,
  unpaid_count     INTEGER NOT NULL DEFAULT 0,
  taken_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, period_from, period_to)
);
