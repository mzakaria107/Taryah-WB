-- Target-approval workflow: admin/sales_manager sends a region's monthly
-- targets for review; every active user in that region gets notified and
-- can approve. Multiple approvers per region/period are recorded.
CREATE TABLE IF NOT EXISTS target_approval_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year         SMALLINT NOT NULL,
  month        SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  region_id    INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  sent_by      UUID REFERENCES users(id),
  sent_by_name VARCHAR(200),
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (year, month, region_id)
);

CREATE TABLE IF NOT EXISTS target_approvals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       UUID NOT NULL REFERENCES target_approval_requests(id) ON DELETE CASCADE,
  approved_by      UUID REFERENCES users(id),
  approved_by_name VARCHAR(200),
  approved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, approved_by)
);

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS target_request_id UUID REFERENCES target_approval_requests(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notif_target_request ON notifications(target_request_id);
CREATE INDEX IF NOT EXISTS idx_target_approvals_request ON target_approvals(request_id);
