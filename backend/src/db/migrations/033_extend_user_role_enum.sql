-- Add missing roles to the user_role enum (PG16 supports this in transactions)
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'viewer';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'supervisor';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'fridge_admin';
