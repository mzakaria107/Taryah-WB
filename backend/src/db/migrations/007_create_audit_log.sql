CREATE TABLE IF NOT EXISTS audit_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID,
  action     VARCHAR(100) NOT NULL,
  entity     VARCHAR(100) NOT NULL,
  entity_id  UUID,
  old_value  JSONB,
  new_value  JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user      ON audit_log(user_id);
CREATE INDEX idx_audit_log_entity    ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_log_created   ON audit_log(created_at DESC);
