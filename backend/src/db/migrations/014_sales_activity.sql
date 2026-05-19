CREATE TABLE IF NOT EXISTS sales_activity (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name  VARCHAR(300) NOT NULL,
  customer_code  VARCHAR(50)  NOT NULL,
  branch_name    VARCHAR(100),
  salesrep_name  VARCHAR(200),
  invoice_number VARCHAR(100) NOT NULL,
  month_name     VARCHAR(20)  NOT NULL,
  month_num      SMALLINT     NOT NULL,
  report_year    SMALLINT     NOT NULL DEFAULT 2026,
  qty            INTEGER      NOT NULL DEFAULT 0,
  uploaded_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  uploaded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT uq_sa_invoice UNIQUE (invoice_number, report_year)
);
CREATE INDEX IF NOT EXISTS idx_sa_customer ON sales_activity(customer_code);
CREATE INDEX IF NOT EXISTS idx_sa_branch   ON sales_activity(branch_name);
CREATE INDEX IF NOT EXISTS idx_sa_month    ON sales_activity(month_num, report_year);
CREATE INDEX IF NOT EXISTS idx_sa_rep      ON sales_activity(salesrep_name);

CREATE TABLE IF NOT EXISTS sales_activity_notes (
  customer_code VARCHAR(50) PRIMARY KEY,
  note_text     TEXT        NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
