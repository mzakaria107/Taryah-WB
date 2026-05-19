require('dotenv').config();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const pool = require('./pool');

// route_prefix = first 2 digits of Route Code in the Excel
// 11→الرياض, 12→جدة, 13→مكة, 14→المدينة, 15→الدمام, 16→الخبر, 17→تبوك
const REGIONS = [
  { name_ar: 'الرياض',   name_en: 'Riyadh',  route_prefix: 11 },
  { name_ar: 'جدة',      name_en: 'Jeddah',  route_prefix: 12 },
  { name_ar: 'مكة',      name_en: 'Makkah',  route_prefix: 13 },
  { name_ar: 'المدينة',  name_en: 'Madinah', route_prefix: 14 },
  { name_ar: 'الدمام',   name_en: 'Dammam',  route_prefix: 15 },
  { name_ar: 'الخبر',    name_en: 'Khobar',  route_prefix: 16 },
  { name_ar: 'تبوك',     name_en: 'Tabuk',   route_prefix: 17 },
  { name_ar: 'أبها',     name_en: 'Abha',    route_prefix: null },
];

const USERS = [
  {
    name: 'مدير النظام',
    email: 'admin@company.com',
    password: 'Admin@123',
    role: 'super_admin',
    region_id: null,
  },
  {
    name: 'مدير تقنية المعلومات',
    email: 'itadmin@company.com',
    password: 'Admin@123',
    role: 'it_admin',
    region_id: null,
  },
  {
    name: 'مدير منطقة الرياض',
    email: 'manager1@company.com',
    password: 'Admin@123',
    role: 'region_manager',
    region_id: 1, // Riyadh
  },
];

async function seed() {
  console.log('Starting seed...');

  // Regions (with route_prefix for Excel Route Code mapping)
  for (const r of REGIONS) {
    await pool.query(
      `INSERT INTO regions (name_ar, name_en, route_prefix)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [r.name_ar, r.name_en, r.route_prefix]
    );
    // If region already exists (re-running seed), update the route_prefix
    await pool.query(
      `UPDATE regions SET route_prefix = $1 WHERE name_en = $2`,
      [r.route_prefix, r.name_en]
    );
  }
  console.log(`✓ ${REGIONS.length} regions seeded (with route prefixes)`);

  // Users
  for (const u of USERS) {
    const hash = await bcrypt.hash(u.password, 12);
    const id = uuidv4();
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role, region_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO NOTHING`,
      [id, u.name, u.email, hash, u.role, u.region_id]
    );
    console.log(`  ✓ ${u.role}: ${u.email}`);
  }
  console.log('✓ Users seeded');

  // Sample invoices for testing
  const { rows: regions } = await pool.query('SELECT id FROM regions ORDER BY id LIMIT 3');
  const statuses = ['paid', 'partial', 'unpaid'];
  const customerTypes = ['direct', 'route'];

  for (let i = 1; i <= 30; i++) {
    const original = parseFloat((Math.random() * 50000 + 5000).toFixed(2));
    const paid = parseFloat((original * (Math.random() * 0.9 + 0.1)).toFixed(2));
    const balance = parseFloat((original - paid).toFixed(2));
    const status = balance <= 0 ? 'paid' : paid < original ? 'partial' : 'unpaid';
    const rate = parseFloat(((paid / original) * 100).toFixed(2));
    const year = 2024 + Math.floor(Math.random() * 2);
    const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
    const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
    const region = regions[Math.floor(Math.random() * regions.length)];

    await pool.query(
      `INSERT INTO invoices
         (id, customer_id, customer_name, region_id, route_id, invoice_number,
          invoice_date, year, original_amount, paid_amount, balance, status,
          collection_rate, customer_type, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       ON CONFLICT (invoice_number) DO NOTHING`,
      [
        uuidv4(),
        `CUST-${String(i).padStart(4, '0')}`,
        `عميل تجريبي ${i}`,
        region?.id || 1,
        Math.floor(Math.random() * 10) + 1,
        `INV-${year}-${String(i).padStart(5, '0')}`,
        `${year}-${month}-${day}`,
        year,
        original,
        paid,
        balance,
        status,
        rate,
        customerTypes[Math.floor(Math.random() * customerTypes.length)],
      ]
    );
  }
  console.log('✓ 30 sample invoices seeded');

  console.log('\nSeed complete! Test credentials:');
  console.log('  super_admin:    admin@company.com    / Admin@123');
  console.log('  it_admin:       itadmin@company.com  / Admin@123');
  console.log('  region_manager: manager1@company.com / Admin@123');

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
