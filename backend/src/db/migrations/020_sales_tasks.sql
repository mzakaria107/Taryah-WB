-- Migration 020: Sales Team Tasks Management
-- Tables: sales_supervisors, sales_tasks, sales_task_files, sales_task_notes

-- ── Sales Supervisors ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_supervisors (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(200) NOT NULL,
  region_id   INTEGER      REFERENCES regions(id) ON DELETE SET NULL,
  email       VARCHAR(200),
  phone       VARCHAR(50),
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by  UUID         REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_supervisors_region ON sales_supervisors(region_id);

-- ── Sales Tasks ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_tasks (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  title                VARCHAR(500) NOT NULL,
  description          TEXT,
  region_id            INTEGER      REFERENCES regions(id) ON DELETE SET NULL,
  supervisor_id        UUID         REFERENCES sales_supervisors(id) ON DELETE SET NULL,
  assigned_by          UUID         REFERENCES users(id) ON DELETE SET NULL,
  assigner_name        VARCHAR(200),
  assigner_email       VARCHAR(200),
  assignee_email       VARCHAR(200),
  cc_emails            TEXT,        -- comma-separated list
  due_date             DATE,
  priority             VARCHAR(20)  NOT NULL DEFAULT 'medium', -- low | medium | high | urgent
  status               VARCHAR(30)  NOT NULL DEFAULT 'pending',
  -- pending → acknowledged → in_progress → completed | cancelled
  acknowledged_at      TIMESTAMPTZ,
  acknowledgement_note TEXT,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  completion_note      TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_region     ON sales_tasks(region_id);
CREATE INDEX IF NOT EXISTS idx_tasks_supervisor ON sales_tasks(supervisor_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON sales_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date   ON sales_tasks(due_date);

-- ── Task File Attachments ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_task_files (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          UUID         NOT NULL REFERENCES sales_tasks(id) ON DELETE CASCADE,
  original_name    VARCHAR(300) NOT NULL,
  stored_name      VARCHAR(300) NOT NULL,
  file_size        INTEGER,
  mime_type        VARCHAR(100),
  upload_stage     VARCHAR(20)  NOT NULL DEFAULT 'assignment', -- assignment | completion | note
  uploaded_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  uploaded_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by_name VARCHAR(200)
);

CREATE INDEX IF NOT EXISTS idx_task_files_task ON sales_task_files(task_id);

-- ── Task Notes ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_task_notes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID        NOT NULL REFERENCES sales_tasks(id) ON DELETE CASCADE,
  note_text     TEXT        NOT NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  added_by_name VARCHAR(200)
);

CREATE INDEX IF NOT EXISTS idx_task_notes_task ON sales_task_notes(task_id);
