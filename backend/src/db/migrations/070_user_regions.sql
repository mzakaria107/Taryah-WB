-- Many-to-many user↔region assignment. A user can now be granted access to
-- more than one region (e.g. a supervisor covering two regions). The legacy
-- users.region_id column is kept in sync as the "primary" (first) region for
-- any code path not yet updated to read the multi-region set.
CREATE TABLE IF NOT EXISTS user_regions (
  user_id   UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  region_id INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, region_id)
);

CREATE INDEX IF NOT EXISTS idx_user_regions_user   ON user_regions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_regions_region ON user_regions(region_id);

INSERT INTO user_regions (user_id, region_id)
SELECT id, region_id FROM users WHERE region_id IS NOT NULL
ON CONFLICT DO NOTHING;
