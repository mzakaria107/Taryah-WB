-- Save log for the "طباعة عقد عميل" contract-print feature
-- (DiscountShopsPage.jsx → "contract" tab). Every time a user actually
-- SAVES a contract (as opposed to just previewing it), one row is
-- appended here — never updated in place — so printing the same
-- customer's contract twice (e.g. a renewal) keeps both as separate,
-- individually-numbered records instead of one row being overwritten.
-- This mirrors the append-only carrefour_report_save_log design, but
-- doesn't need a *separate* "reports" header table the way Carrefour/
-- Quality Returns do: there's no daily entry grid here, so one save
-- IS one contract — the log row and the "report" are the same thing.
--
-- Numbers/tiers are stored as a frozen snapshot (JSONB) of exactly what
-- was on the printed sheet at save time, rather than re-derived later
-- from incentive-baseline + the live growth%/tier settings — those
-- settings are editable and shared with the "سيناريو حافز % من المبيعات"
-- tab, so a contract saved today must still show its own numbers even if
-- an admin changes the growth% next month.
CREATE TABLE IF NOT EXISTS discount_shop_contracts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_no         SERIAL UNIQUE,
  customer_code       VARCHAR(50)  NOT NULL,
  customer_name       VARCHAR(300) NOT NULL,
  avg_monthly_qty     NUMERIC(14,2) NOT NULL DEFAULT 0,
  growth_pct          NUMERIC(6,2)  NOT NULL DEFAULT 0,
  target_qty          NUMERIC(14,2) NOT NULL DEFAULT 0,
  tiers               JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{label, from, to, rate}]
  created_by          UUID REFERENCES users(id),
  created_by_name     VARCHAR(200), -- denormalized so a later-deleted account doesn't erase authorship
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ds_contracts_customer ON discount_shop_contracts(customer_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ds_contracts_created   ON discount_shop_contracts(created_at DESC);
