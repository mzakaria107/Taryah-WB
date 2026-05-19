-- Add last_seen_at for online-status tracking (updated on login + heartbeat)
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
