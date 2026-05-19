CREATE TABLE IF NOT EXISTS upload_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name     VARCHAR(255) NOT NULL,
  file_type     upload_file_type NOT NULL,
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  row_count     INTEGER DEFAULT 0,
  status        upload_status NOT NULL DEFAULT 'processing',
  error_message TEXT,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_upload_batches_uploaded_by ON upload_batches(uploaded_by);
CREATE INDEX idx_upload_batches_created_at  ON upload_batches(created_at DESC);
