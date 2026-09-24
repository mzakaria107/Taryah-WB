-- Lets category target-split percentages be overridden per region and
-- per rep, not just globally. Resolution order when computing a rep's
-- category targets: rep-level override > region-level override >
-- global default (category_target_splits, from migration 063).
CREATE TABLE IF NOT EXISTS region_category_target_splits (
  region_id     INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  category_name TEXT NOT NULL,
  pct           NUMERIC(5,2) NOT NULL DEFAULT 0,
  updated_by    UUID REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (region_id, category_name)
);

CREATE TABLE IF NOT EXISTS rep_category_target_splits (
  rep_id        INTEGER NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  category_name TEXT NOT NULL,
  pct           NUMERIC(5,2) NOT NULL DEFAULT 0,
  updated_by    UUID REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (rep_id, category_name)
);
