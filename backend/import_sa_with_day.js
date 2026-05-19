/**
 * import_sa_with_day.js
 * Import updated sales_activity CSV that includes a Day column.
 *
 * Strategy:
 *   - ON CONFLICT (invoice_number, report_year) DO UPDATE
 *     → updates day + qty for existing rows
 *     → inserts brand-new invoices if any
 *
 * Run inside backend Docker container:
 *   node /app/import_sa_with_day.js
 */

require('dotenv').config({ path: '/app/.env' });
const { Pool }  = require('pg');
const fs        = require('fs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* ── Month name → number ─────────────────────────────────── */
const MONTH_NUM = {
  January:1, February:2, March:3, April:4, May:5, June:6,
  July:7, August:8, September:9, October:10, November:11, December:12,
};

/* ── Parse CSV (no external lib) ────────────────────────── */
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    vals.push(cur.trim());
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
  });
}

async function main() {
  const filePath = '/tmp/sa_with_day.csv';
  console.log(`\n📂 Reading: ${filePath}`);
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseCSV(text).filter(r => r['Invoice Number']?.trim());

  console.log(`📊 Parsed rows: ${rows.length}`);

  /* ── Determine report_year from context (default 2026) ─ */
  // Month is "May", file is 2026 — use 2026 as default
  const REPORT_YEAR = 2026;

  /* ── Apply migration 023 first ───────────────────────── */
  console.log('\n⚙️  Applying migration 023 (day column)…');
  await pool.query(`
    ALTER TABLE sales_activity
      ADD COLUMN IF NOT EXISTS day SMALLINT CHECK (day BETWEEN 1 AND 31)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sa_day ON sales_activity(day)
  `);
  console.log('   ✓ Migration applied');

  /* ── Upsert rows ──────────────────────────────────────── */
  let updated = 0, inserted = 0, errors = 0;
  const errorList = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    const customerName  = (row['Customer Name Arabic'] || '').trim() || null;
    const customerCode  = (row['Customer Code']        || '').trim() || null;
    const categoryName  = (row['Category Name English']|| '').trim() || null;
    const branchName    = (row['Branch Name English']  || '').trim() || null;
    const salesrepName  = (row['First Name Salesrep English'] || '').trim() || null;
    const invoiceNumber = (row['Invoice Number']       || '').trim() || null;
    const dayRaw        = row['Day'];
    const monthName     = (row['Month']                || '').trim() || null;
    const qtyRaw        = row['Total Net qty with FOC'];

    if (!invoiceNumber || !customerCode) {
      errors++;
      errorList.push({ row: i + 2, error: 'بيانات ناقصة' });
      continue;
    }

    const day      = dayRaw  ? parseInt(dayRaw)  || null : null;
    const monthNum = monthName ? (MONTH_NUM[monthName] || null) : null;
    const qty      = qtyRaw  ? parseInt(qtyRaw)  || 0   : 0;

    try {
      const res = await pool.query(
        `INSERT INTO sales_activity
           (customer_name, customer_code, category_name, branch_name,
            salesrep_name, invoice_number, day, month_name, month_num,
            report_year, qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (invoice_number, report_year)
         DO UPDATE SET
           day           = EXCLUDED.day,
           qty           = EXCLUDED.qty,
           customer_name = EXCLUDED.customer_name,
           branch_name   = EXCLUDED.branch_name,
           salesrep_name = EXCLUDED.salesrep_name,
           category_name = EXCLUDED.category_name
         RETURNING (xmax = 0) AS is_insert`,
        [customerName, customerCode, categoryName, branchName,
         salesrepName, invoiceNumber, day, monthName, monthNum,
         REPORT_YEAR, qty]
      );

      if (res.rows[0]?.is_insert) inserted++;
      else                        updated++;
    } catch (e) {
      errors++;
      errorList.push({ row: i + 2, invoice: invoiceNumber, error: e.message });
    }

    if ((i + 1) % 100 === 0 || i === rows.length - 1) {
      process.stdout.write(
        `\r  معالجة ${i + 1}/${rows.length} … ✅ ${updated} محدّث | ➕ ${inserted} جديد | ❌ ${errors}`
      );
    }
  }

  console.log('\n\n══════════════════════════════════');
  console.log(`✅ محدَّث  : ${updated}`);
  console.log(`➕ جديد    : ${inserted}`);
  console.log(`❌ أخطاء  : ${errors}`);
  console.log('══════════════════════════════════');

  if (errorList.length) {
    console.log('\nتفاصيل الأخطاء:');
    errorList.slice(0, 10).forEach(e =>
      console.log(`  صف ${e.row}: ${e.error}${e.invoice ? ` [${e.invoice}]` : ''}`)
    );
  }

  /* ── Verify day column filled ── */
  const verify = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE day IS NOT NULL) AS with_day,
            COUNT(*) AS total
     FROM sales_activity
     WHERE report_year = ${REPORT_YEAR} AND month_num = ${MONTH_NUM[rows[0]?.Month] || 5}`
  );
  const v = verify.rows[0];
  console.log(`\n📋 التحقق — شهر مايو ${REPORT_YEAR}: ${v.with_day}/${v.total} صف لديها قيمة day`);

  await pool.end();
}

main().catch(err => { console.error('خطأ فادح:', err); process.exit(1); });
