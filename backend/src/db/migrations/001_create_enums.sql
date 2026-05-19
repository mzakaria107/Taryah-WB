-- Enums
CREATE TYPE user_role AS ENUM ('super_admin', 'region_manager', 'sales_rep', 'it_admin');
CREATE TYPE invoice_status AS ENUM ('paid', 'partial', 'unpaid');
CREATE TYPE upload_file_type AS ENUM ('customer_balance', 'route_master');
CREATE TYPE upload_status AS ENUM ('processing', 'success', 'failed');
