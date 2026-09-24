-- Lets each rep be linked to a route (خط السير). There is no dedicated
-- routes table in this system — route numbers live as a plain integer on
-- invoices.route_id — so this just stores that same number against the rep.
ALTER TABLE sales_reps ADD COLUMN IF NOT EXISTS route_id INTEGER;
