-- Track which region a fridge was withdrawn to when pulled for repair
-- (the fridge stays assigned to a warehouse/region while under maintenance,
-- separate from the customer it was removed from).
ALTER TABLE fridge_transfers ADD COLUMN IF NOT EXISTS from_region_id INTEGER REFERENCES regions(id);
ALTER TABLE fridge_transfers ADD COLUMN IF NOT EXISTS to_region_id   INTEGER REFERENCES regions(id);
