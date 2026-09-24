-- Splits the frozen "دين الفواتير" old-debt snapshot from per-customer to
-- per-(customer, rep): 40% of customers here have invoices tied to more
-- than one salesman historically, and freezing/showing one combined total
-- under a single name hid that the debt is actually shared. Existing rows
-- get sales_rep_name = '' (a sentinel, not NULL — Postgres unique
-- constraints treat NULLs as always-distinct, which would defeat
-- ON CONFLICT DO NOTHING for them) and are simply superseded the next time
-- their period is viewed, since the app never reads rep='' rows going
-- forward — no data is destroyed, old totals just stop being reused.
ALTER TABLE old_debt_snapshots
  ADD COLUMN IF NOT EXISTS sales_rep_name VARCHAR(255) NOT NULL DEFAULT '';

ALTER TABLE old_debt_snapshots
  DROP CONSTRAINT IF EXISTS old_debt_snapshots_customer_id_period_from_period_to_key;

ALTER TABLE old_debt_snapshots
  ADD CONSTRAINT old_debt_snapshots_customer_rep_period_key
  UNIQUE (customer_id, sales_rep_name, period_from, period_to);
