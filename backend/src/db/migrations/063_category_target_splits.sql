-- Lets an admin split each rep's overall qty_target into percentages per
-- customer category (sales_activity.category_name — e.g. Hypermarkets,
-- Restaurant, Groceries) so the performance dashboard can show, per rep,
-- how much of the target each category is expected to carry and how
-- much of that slice has actually been achieved.
CREATE TABLE IF NOT EXISTS category_target_splits (
  category_name TEXT PRIMARY KEY,
  pct           NUMERIC(5,2) NOT NULL DEFAULT 0,
  updated_by    UUID REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
