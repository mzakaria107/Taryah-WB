-- Lets a contract's monthly target/tiers be expressed either in quantity
-- ("حبة", the original paper template's unit) or in sales value ("ر.س") —
-- requested so a customer's contract can be pegged to whichever basis the
-- deal was actually negotiated on. Renamed the two numeric columns to
-- generic names since they now hold either unit depending on `basis`
-- (feature shipped minutes earlier with zero real rows yet, only the
-- already-cleaned-up test probe, so a rename carries no data-loss risk).
ALTER TABLE discount_shop_contracts RENAME COLUMN avg_monthly_qty TO avg_monthly_value;
ALTER TABLE discount_shop_contracts RENAME COLUMN target_qty      TO target_value;

ALTER TABLE discount_shop_contracts
  ADD COLUMN IF NOT EXISTS basis VARCHAR(10) NOT NULL DEFAULT 'qty' CHECK (basis IN ('qty', 'revenue'));
