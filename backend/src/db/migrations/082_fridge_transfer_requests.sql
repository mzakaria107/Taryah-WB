-- Migration 082: fridge transfer REQUESTS (طلب نقل ثلاجة) with approval.
--
-- A supervisor or region manager raises a request; the fridge does NOT move
-- until a fridge admin (or system admin) approves it. The existing
-- fridge_transfers table stays the record of transfers that ACTUALLY happened —
-- a request is a separate thing and must never be mistaken for one.
--
-- Both sides' route + salesman are SNAPSHOT at request time rather than looked
-- up when printing: the printed request has to stay a faithful record of what
-- was approved even after the customer master is re-uploaded and a route or a
-- rep changes hands.
DO $$ BEGIN
  CREATE TYPE fridge_request_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fridge_transfer_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fridge_id           UUID NOT NULL REFERENCES fridges(id) ON DELETE CASCADE,
  asset_number        VARCHAR(100),           -- snapshot: survives a fridge rename

  from_customer_code  VARCHAR(100),
  from_customer_name  VARCHAR(300),
  from_route_code     INTEGER,
  from_route_name     VARCHAR(200),
  from_salesman_name  VARCHAR(200),
  from_region_id      INTEGER REFERENCES regions(id) ON DELETE SET NULL,

  to_customer_code    VARCHAR(100) NOT NULL,
  to_customer_name    VARCHAR(300),
  to_route_code       INTEGER,
  to_route_name       VARCHAR(200),
  to_salesman_name    VARCHAR(200),
  to_region_id        INTEGER REFERENCES regions(id) ON DELETE SET NULL,

  reason              TEXT,
  status              fridge_request_status NOT NULL DEFAULT 'pending',

  requested_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name   VARCHAR(200),
  requested_by_role   VARCHAR(50),
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  decided_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name     VARCHAR(200),
  decided_at          TIMESTAMPTZ,
  decision_note       TEXT,

  -- set only once the transfer is actually carried out, on approval
  transfer_id         UUID REFERENCES fridge_transfers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ftr_status ON fridge_transfer_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_ftr_fridge ON fridge_transfer_requests(fridge_id);

-- Only ONE request may be open per fridge at a time; two pending requests for
-- the same asset would let it be "approved" twice into different customers.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ftr_one_pending_per_fridge
  ON fridge_transfer_requests(fridge_id) WHERE status = 'pending';

-- Let a notification point at the request it is about (same shape as the
-- existing target_request_id column used by the targets approval flow).
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS fridge_request_id UUID
  REFERENCES fridge_transfer_requests(id) ON DELETE CASCADE;
