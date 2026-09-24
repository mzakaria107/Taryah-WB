-- Admin-mandated item categories — forced active for EVERY user, on top of
-- (not instead of) each user's own optional extras in
-- quality_returns_user_category_prefs. A row existing here means that
-- category is mandatory; there is deliberately no is_active column — a row
-- present = mandatory, absent = not mandatory (simpler than a boolean flag
-- that could sit at FALSE and be forgotten).
--
-- This changes the *default* for non-mandatory categories from "on unless
-- hidden" to "off unless a user opts in" — see fetchCategoryStates() in
-- qualityReturns.js: a category with no mandatory row and no user pref row
-- now defaults to inactive, whereas before this migration every category
-- defaulted to active for a fresh user.
CREATE TABLE IF NOT EXISTS quality_returns_mandatory_categories (
  item_category  VARCHAR(300) PRIMARY KEY,
  set_by         UUID REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
