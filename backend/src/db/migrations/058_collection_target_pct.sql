-- Migration 058: Convert collection_target from fixed SAR value to percentage of monthly sales
ALTER TABLE sales_rep_targets
  RENAME COLUMN collection_target TO collection_target_pct;

-- Reset any values that can't be valid percentages (were previously fixed amounts)
UPDATE sales_rep_targets SET collection_target_pct = 0 WHERE collection_target_pct > 100;
