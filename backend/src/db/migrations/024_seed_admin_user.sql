-- Seed default super_admin user
-- pgcrypto gen_salt('bf',12) produces a bcrypt hash compatible with node bcrypt
-- Default password: Admin@123  — change after first login
INSERT INTO users (name, email, password_hash, role)
SELECT
  'مدير النظام',
  'admin@taryah.com',
  crypt('Admin@123', gen_salt('bf', 12)),
  'super_admin'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'admin@taryah.com');
