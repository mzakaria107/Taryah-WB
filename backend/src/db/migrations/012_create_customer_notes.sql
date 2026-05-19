-- ══════════════════════════════════════════════════════════════
--  012_create_customer_notes.sql
--
--  Two new tables that are COMPLETELY INDEPENDENT of invoices.
--  No foreign-key to invoices → safe from TRUNCATE invoices CASCADE.
--
--  customer_notes        — one current note per customer (upsert)
--  customer_note_history — immutable append-only audit log
-- ══════════════════════════════════════════════════════════════

-- ── Current note per customer ──────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_notes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id VARCHAR(50) NOT NULL UNIQUE,
  note_text   TEXT        NOT NULL DEFAULT '',
  user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_notes_cid ON customer_notes(customer_id);

-- ── Permanent audit trail — never deleted on file upload ───────
CREATE TABLE IF NOT EXISTS customer_note_history (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id VARCHAR(50) NOT NULL,
  note_text   TEXT        NOT NULL DEFAULT '',
  user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cnh_customer ON customer_note_history(customer_id);
CREATE INDEX IF NOT EXISTS idx_cnh_created  ON customer_note_history(created_at DESC);

-- ── Migrate existing customer notes from note_history (if any) ─
-- Takes the most-recent note per customer as the current value.
INSERT INTO customer_notes (id, customer_id, note_text, user_id, updated_at, created_at)
SELECT DISTINCT ON (customer_id)
  gen_random_uuid(),
  customer_id,
  note_text,
  user_id,
  created_at,
  created_at
FROM note_history
WHERE note_type = 'customer'
  AND customer_id IS NOT NULL
ORDER BY customer_id, created_at DESC
ON CONFLICT (customer_id) DO NOTHING;

-- Migrate full audit trail
INSERT INTO customer_note_history (id, customer_id, note_text, user_id, created_at)
SELECT id, customer_id, note_text, user_id, created_at
FROM note_history
WHERE note_type = 'customer'
  AND customer_id IS NOT NULL
ON CONFLICT DO NOTHING;
