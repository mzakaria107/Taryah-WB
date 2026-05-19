-- Migration 026: Add note_type column to notes table
-- The notes.js route inserts with a note_type column that didn't exist,
-- causing a PostgreSQL error on every invoice note upsert/insert.
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS note_type VARCHAR(20) NOT NULL DEFAULT 'invoice';

-- Also ensure the routes table exists so buildRouteMaps() in upload.js
-- doesn't throw on first startup before a RouteMaster file is uploaded.
CREATE TABLE IF NOT EXISTS routes (
  route_id   INTEGER PRIMARY KEY,
  region_id  INTEGER REFERENCES regions(id) ON DELETE SET NULL,
  route_name VARCHAR(200),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
