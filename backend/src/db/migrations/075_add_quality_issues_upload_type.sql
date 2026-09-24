-- upload_batches.file_type is an enum — quality_issues uploads need their own value.
-- ALTER TYPE ... ADD VALUE cannot run inside the same transaction as other
-- statements that use it, so this migration only does the enum add.
ALTER TYPE upload_file_type ADD VALUE IF NOT EXISTS 'quality_issues';
