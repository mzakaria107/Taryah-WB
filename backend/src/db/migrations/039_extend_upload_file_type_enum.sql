-- Extend upload_file_type enum to include payments and sales_activity
ALTER TYPE upload_file_type ADD VALUE IF NOT EXISTS 'payments';
ALTER TYPE upload_file_type ADD VALUE IF NOT EXISTS 'sales_activity';
