-- Signature/audit log: every time an entry (any of the three tabs) is
-- saved, append a row recording who saved it and when. Distinct from
-- carrefour_*_reports.submitted_by/updated_at, which only ever holds the
-- LATEST save (an upsert overwrites it) — this table is append-only, so a
-- report edited three times in a day keeps all three signatures instead of
-- losing the earlier ones. Shared across all three tabs via report_type,
-- same "one implementation, N tables" reasoning as the entry/report
-- factories in carrefourDamage.js.
CREATE TABLE IF NOT EXISTS carrefour_report_save_log (
  id             BIGSERIAL PRIMARY KEY,
  report_type    VARCHAR(20) NOT NULL CHECK (report_type IN ('damage', 'stock', 'orders')),
  branch_id      INTEGER NOT NULL REFERENCES carrefour_branches(id),
  report_date    DATE    NOT NULL,
  saved_by       UUID REFERENCES users(id),
  saved_by_name  VARCHAR(200),
  total_qty      NUMERIC(14,2) NOT NULL DEFAULT 0,
  saved_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cf_save_log_lookup
  ON carrefour_report_save_log(report_type, branch_id, report_date, saved_at DESC);
