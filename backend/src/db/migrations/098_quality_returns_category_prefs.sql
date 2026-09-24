-- Per-USER item-category visibility for the entry grid (distinct from the
-- route toggle, which is a shared per-region admin setting) — different
-- monitors care about different category subsets, so this is a personal
-- preference, not a global one. Default (no row) = active, so a user who
-- never customizes still sees every category exactly as before.
CREATE TABLE IF NOT EXISTS quality_returns_user_category_prefs (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_category  VARCHAR(300) NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, item_category)
);
