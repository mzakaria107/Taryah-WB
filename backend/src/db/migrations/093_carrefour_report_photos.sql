-- Photo attachments for the Carrefour entry — a promoter can attach photos
-- for a branch/date/tab BEFORE (or after) saving the quantities, since these
-- are keyed on (report_type, branch_id, report_date) directly rather than on
-- the report row's id. Powers both the entry page's attach/preview panel and
-- the report page's "ألبوم الصور" grouped by branch + save date.
CREATE TABLE IF NOT EXISTS carrefour_report_photos (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type        VARCHAR(20) NOT NULL CHECK (report_type IN ('damage', 'stock', 'orders')),
  branch_id          INTEGER NOT NULL REFERENCES carrefour_branches(id),
  report_date        DATE    NOT NULL,
  file_path          VARCHAR(500) NOT NULL, -- relative path under UPLOAD_DIR
  original_filename  VARCHAR(255),
  uploaded_by        UUID REFERENCES users(id),
  uploaded_by_name   VARCHAR(200),
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cf_photos_lookup ON carrefour_report_photos(report_type, branch_id, report_date);
CREATE INDEX IF NOT EXISTS idx_cf_photos_date    ON carrefour_report_photos(report_date);
