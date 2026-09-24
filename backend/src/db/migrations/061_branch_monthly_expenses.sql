-- Monthly credit-note / rebate expenses per branch (e.g. Carrefour fixed
-- rebate, sell-out, creation vendor & marketing support), deducted from
-- that branch's net revenue in Hypermarkets reporting.
CREATE TABLE IF NOT EXISTS branch_monthly_expenses (
  id                        SERIAL PRIMARY KEY,
  branch_name               TEXT NOT NULL,
  report_year               INTEGER NOT NULL,
  month_num                 SMALLINT NOT NULL CHECK (month_num BETWEEN 1 AND 12),
  fixed_rebate              NUMERIC(14,2) NOT NULL DEFAULT 0,
  sell_out                  NUMERIC(14,2) NOT NULL DEFAULT 0,
  creation_vendor_marketing NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_credit_note         NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes                     TEXT,
  uploaded_by               UUID REFERENCES users(id),
  uploaded_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (branch_name, report_year, month_num)
);
