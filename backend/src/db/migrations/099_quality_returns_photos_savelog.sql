-- Bringing quality-returns to parity with the Carrefour module: photo
-- attachments (before/after saving) and an append-only signature log
-- (every save kept, not just the latest — see carrefour_report_save_log
-- for the same reasoning). One region/day here plays the role
-- report_type+branch_id+report_date played for Carrefour.
CREATE TABLE IF NOT EXISTS quality_returns_report_photos (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id          INTEGER NOT NULL REFERENCES regions(id),
  report_date        DATE    NOT NULL,
  file_path          VARCHAR(500) NOT NULL,
  original_filename  VARCHAR(255),
  uploaded_by        UUID REFERENCES users(id),
  uploaded_by_name   VARCHAR(200),
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qr_photos_lookup ON quality_returns_report_photos(region_id, report_date);

CREATE TABLE IF NOT EXISTS quality_returns_save_log (
  id             BIGSERIAL PRIMARY KEY,
  region_id      INTEGER NOT NULL REFERENCES regions(id),
  report_date    DATE    NOT NULL,
  saved_by       UUID REFERENCES users(id),
  saved_by_name  VARCHAR(200),
  total_qty      NUMERIC(14,2) NOT NULL DEFAULT 0,
  saved_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qr_save_log_lookup ON quality_returns_save_log(region_id, report_date, saved_at DESC);
