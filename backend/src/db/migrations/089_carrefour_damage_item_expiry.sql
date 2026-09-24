-- Per-line expiry date + notes on the Carrefour damage entry — the promoter
-- needs to record the batch's expiry date and any note (e.g. reason,
-- condition) against each item, not just one note for the whole day.
ALTER TABLE carrefour_damage_report_items
  ADD COLUMN IF NOT EXISTS expiry_date DATE,
  ADD COLUMN IF NOT EXISTS notes       TEXT;
