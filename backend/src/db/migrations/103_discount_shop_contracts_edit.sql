-- Lets a saved contract be corrected after the fact (typo in a threshold,
-- wrong growth% locked in, etc.) without losing its identity: contract_no,
-- created_at and created_by are NEVER touched by an edit — only the
-- editable fields (avg_monthly_value/growth_pct/target_value/tiers/basis)
-- change, and updated_by/updated_at record who last corrected it and
-- when. This intentionally breaks the "pure append-only log" purity of
-- 101_discount_shop_contracts.sql in favor of the more common "an
-- invoice/contract can be amended but keeps its number" model — the
-- save-log guarantee that matters (every PRINTED contract has a
-- permanent unique number) still holds; only ITS CONTENTS can now be
-- corrected, same as fixing a typo on a signed paper doesn't invalidate
-- the contract number stamped on it.
ALTER TABLE discount_shop_contracts
  ADD COLUMN IF NOT EXISTS updated_by      UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_by_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ;
