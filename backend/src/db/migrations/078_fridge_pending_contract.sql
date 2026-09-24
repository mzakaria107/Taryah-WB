-- Migration 078: "بانتظار توقيع العقد" flag
-- When a fridge is reassigned to a new customer without a new signed contract
-- being attached during the transfer, the fridge is flagged as awaiting the
-- contract. The flag clears automatically once a contract file is uploaded.
ALTER TABLE fridges ADD COLUMN IF NOT EXISTS pending_contract       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE fridges ADD COLUMN IF NOT EXISTS pending_contract_since TIMESTAMPTZ;

-- Records whether that particular transfer was the one left awaiting a contract
ALTER TABLE fridge_transfers ADD COLUMN IF NOT EXISTS pending_contract BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: the flag is rare, only the TRUE rows are ever queried
CREATE INDEX IF NOT EXISTS idx_fridges_pending_contract
  ON fridges(pending_contract) WHERE pending_contract;
