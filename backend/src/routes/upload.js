const express = require('express');
const xlsx = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const upload = require('../middleware/upload');
const { verifyToken, requireRoles } = require('../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function safeFloat(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

/** Convert Excel serial date → 'YYYY-MM-DD' string */
function serialToDate(serial) {
  if (!serial) return null;
  if (typeof serial === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(serial.trim())) return serial.trim();
  const num = parseFloat(serial);
  if (isNaN(num)) return null;
  try {
    const parsed = xlsx.SSF.parse_date_code(num);
    if (!parsed) return null;
    return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

/** Derive invoice status from balance vs original */
function deriveStatus(balance, original) {
  const bal = safeFloat(balance);
  const orig = safeFloat(original);
  if (bal <= 0) return 'paid';
  if (bal >= orig && orig > 0) return 'unpaid';
  return 'partial';
}

/**
 * Build route lookup maps:
 *   exactMap  : route_id (int)    → region_id  — from routes table (RouteMaster)
 *   prefixMap : route_prefix (2-digit) → region_id — from regions table (legacy fallback)
 */
async function buildRouteMaps() {
  const [exactRes, prefixRes] = await Promise.all([
    pool.query('SELECT route_id, region_id FROM routes WHERE region_id IS NOT NULL'),
    pool.query('SELECT id, route_prefix FROM regions WHERE route_prefix IS NOT NULL'),
  ]);
  const exactMap  = {};
  const prefixMap = {};
  exactRes.rows.forEach(r  => { exactMap[r.route_id]      = r.region_id; });
  prefixRes.rows.forEach(r => { prefixMap[r.route_prefix] = r.id; });
  return { exactMap, prefixMap };
}

// ─────────────────────────────────────────────
// Batch INSERT helper — fresh insert after table cleared
// No ON CONFLICT needed — table is truncated first.
// Inserts rows in chunks to avoid PG parameter limit (65535 max).
// ─────────────────────────────────────────────
const BATCH_SIZE   = 500;
const COLS_PER_ROW = 17; // includes customer_type

async function batchInsertInvoices(dbClient, invoiceRows) {
  let inserted = 0;
  for (let i = 0; i < invoiceRows.length; i += BATCH_SIZE) {
    const chunk        = invoiceRows.slice(i, i + BATCH_SIZE);
    const values       = [];
    const placeholders = chunk.map((row, idx) => {
      const base = idx * COLS_PER_ROW;
      values.push(
        row.id,
        row.customer_id,
        row.customer_name,
        row.customer_name_en,
        row.sales_rep_name,
        row.region_id,
        row.route_id,
        row.invoice_number,
        row.invoice_date,
        row.year,
        row.original_amount,
        row.paid_amount,
        row.balance,
        row.status,
        row.collection_rate,
        row.customer_type,   // 'direct' | 'route'
        row.upload_batch_id
      );
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13},$${base+14},$${base+15},$${base+16},$${base+17},NOW())`;
    });

    await dbClient.query(
      `INSERT INTO invoices
         (id, customer_id, customer_name, customer_name_en, sales_rep_name,
          region_id, route_id, invoice_number, invoice_date, year,
          original_amount, paid_amount, balance, status,
          collection_rate, customer_type, upload_batch_id, updated_at)
       VALUES ${placeholders.join(',')}`,
      values
    );
    inserted += chunk.length;
  }
  return inserted;
}

// ─────────────────────────────────────────────
// POST /api/upload/customer-balance
// Accepts customerBalanceDues.xlsx
// Exact column mapping confirmed from actual file:
//   Transaction Date  → invoice_date  (Excel serial)
//   Invoice Number    → invoice_number
//   Route Code        → route_id  (also derives region via prefix)
//   Customer Code     → customer_id
//   namelocal         → customer_name  (Arabic name)
//   Name English      → stored in customer_name if namelocal empty
//   Total Invoice Amount → original_amount
//   Amount Paid       → paid_amount
//   Balance           → balance
// ─────────────────────────────────────────────
router.post(
  '/customer-balance',
  verifyToken,
  requireRoles('super_admin', 'it_admin'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });

    const batchId = uuidv4();
    await pool.query(
      `INSERT INTO upload_batches (id, file_name, file_type, uploaded_by, status)
       VALUES ($1, $2, 'customer_balance', $3, 'processing')`,
      [batchId, req.file.originalname, req.user.id]
    );

    try {
      console.log(`[Upload] Reading file: ${req.file.originalname}`);
      const workbook = xlsx.readFile(req.file.path, {
        cellDates: false,
        dense: true,       // faster parsing
        sheetStubs: false,
      });

      const sheetName = workbook.SheetNames[0];
      const rawRows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {
        defval: '',
        raw: true,         // keep numbers as numbers
      });

      console.log(`[Upload] Parsed ${rawRows.length} rows`);

      if (rawRows.length === 0) {
        await pool.query(
          `UPDATE upload_batches SET status='failed', error_message=$1 WHERE id=$2`,
          ['الملف فارغ', batchId]
        );
        return res.status(400).json({ error: 'الملف فارغ' });
      }

      // Build route lookup maps (exact route_id first, then 2-digit prefix fallback)
      const { exactMap, prefixMap } = await buildRouteMaps();

      // Parse all rows into invoice objects
      const invoiceRows = [];
      const errors = [];

      for (let i = 0; i < rawRows.length; i++) {
        const row = rawRows[i];
        const rowNum = i + 2; // Excel row number (1-indexed header + 1)

        // ── Required field: Invoice Number ──────────────────────
        const invoiceNumber = String(row['Invoice Number'] || '').trim();
        if (!invoiceNumber) {
          errors.push({ row: rowNum, error: 'رقم الفاتورة مفقود' });
          continue;
        }

        // ── Customer ─────────────────────────────────────────────
        const customerId    = String(row['Customer Code']    || '').trim() || invoiceNumber;
        const nameAr        = String(row['namelocal']        || '').trim();
        const nameEn        = String(row['Name English']     || '').trim();
        const salesRepName  = String(row['First Name English'] || '').trim() || null;
        const customerName  = nameAr || nameEn || customerId;

        // Detect direct sales: rep name is literally "DIRECT" (case-insensitive)
        // Matches original dashboard logic: r.Rep.toLowerCase() === 'direct'
        const customerType  = (salesRepName || '').toLowerCase() === 'direct' ? 'direct' : 'route';

        // ── Route & Region ────────────────────────────────────────
        // Priority: exact route_id match (from RouteMaster) → 2-digit prefix fallback
        const routeCode   = parseInt(row['Route Code'], 10) || null;
        const routePrefix = routeCode ? parseInt(String(routeCode).substring(0, 2), 10) : null;
        const regionId    = routeCode
          ? (exactMap[routeCode] ?? prefixMap[routePrefix] ?? null)
          : null;

        // ── Amounts ───────────────────────────────────────────────
        const originalAmount = safeFloat(row['Total Invoice Amount']);
        const paidAmount     = safeFloat(row['Amount Paid']);
        const balance        = safeFloat(row['Balance']);
        const status         = deriveStatus(balance, originalAmount);
        const collectionRate = originalAmount > 0
          ? parseFloat(Math.min(100, (paidAmount / originalAmount) * 100).toFixed(2))
          : 0;

        // ── Date ─────────────────────────────────────────────────
        const invoiceDate = serialToDate(row['Transaction Date']);
        const year        = invoiceDate ? parseInt(invoiceDate.split('-')[0], 10) : null;

        invoiceRows.push({
          id:               uuidv4(),
          customer_id:      customerId,
          customer_name:    customerName,
          customer_name_en: nameEn || null,
          sales_rep_name:   salesRepName,
          region_id:        regionId,
          route_id:         routeCode,
          invoice_number:   invoiceNumber,
          invoice_date:     invoiceDate,
          year,
          original_amount:  originalAmount,
          paid_amount:      paidAmount,
          balance,
          status,
          collection_rate:  collectionRate,
          customer_type:    customerType,   // 'direct' | 'route'
          upload_batch_id:  batchId,
        });
      }

      console.log(`[Upload] ${invoiceRows.length} valid rows, ${errors.length} skipped`);

      // ── Save pre-upload snapshot for daily-change tracking ───────
      // Capture current balances BEFORE wiping, so aging page can show delta.
      // We upsert into yesterday's date so tomorrow's aging view shows the change.
      try {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const snapDate = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
        await pool.query(`
          INSERT INTO balance_snapshots (snapshot_date, customer_id, customer_name, total_balance, invoice_count)
          SELECT $1::date, customer_id, MAX(customer_name),
                 ROUND(SUM(balance)::numeric, 2), COUNT(*)::int
          FROM invoices
          WHERE status IN ('unpaid','partial') AND balance > 0
          GROUP BY customer_id
          ON CONFLICT (snapshot_date, customer_id) DO UPDATE
            SET total_balance = EXCLUDED.total_balance,
                invoice_count = EXCLUDED.invoice_count,
                customer_name = EXCLUDED.customer_name
        `, [snapDate]);
        console.log(`[Upload] Pre-upload balance snapshot saved for ${snapDate}`);
      } catch (snapErr) {
        // Non-fatal — don't block the upload if snapshot fails
        console.warn('[Upload] Balance snapshot save failed (non-fatal):', snapErr.message);
      }

      // ── Replace ALL data in a single transaction ──────────────
      // TRUNCATE … CASCADE removes notes (ON DELETE CASCADE) — fresh start
      const dbClient = await pool.connect();
      let processed  = 0;
      try {
        await dbClient.query('BEGIN');
        console.log('[Upload] Truncating invoices table (replacing all data)…');
        await dbClient.query('TRUNCATE TABLE invoices CASCADE');
        processed = await batchInsertInvoices(dbClient, invoiceRows);
        await dbClient.query('COMMIT');
        console.log(`[Upload] Inserted ${processed} fresh rows`);
      } catch (dbErr) {
        await dbClient.query('ROLLBACK');
        throw dbErr;
      } finally {
        dbClient.release();
      }

      await pool.query(
        `UPDATE upload_batches SET status='success', row_count=$1 WHERE id=$2`,
        [processed, batchId]
      );

      res.json({
        success: true,
        rowsProcessed: processed,
        rowsSkipped: errors.length,
        errors: errors.slice(0, 50), // cap errors in response
        batchId,
      });

    } catch (err) {
      console.error('[Upload] Error:', err.message);
      await pool.query(
        `UPDATE upload_batches SET status='failed', error_message=$1 WHERE id=$2`,
        [err.message.substring(0, 500), batchId]
      );
      res.status(500).json({ error: 'فشل في معالجة الملف: ' + err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload/route-master
// Reads RouteMaster.xlsx → upserts regions + routes → re-links invoices
//
// Flexible column detection — tries many naming conventions:
//   Route ID  : 'Route Code','Route ID','RouteCode','route_id','كود المسار','رقم المسار','الخط','كود الخط'
//   Region AR : 'Region','Region Name','اسم المنطقة','المنطقة','منطقة','Area','Territory'
//   Region EN : 'Region EN','Region English','Region Name EN','Area EN'
//   Route Name: 'Route Name','اسم المسار','اسم الخط','Route Description'
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/route-master',
  verifyToken,
  requireRoles('super_admin', 'it_admin'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });

    const batchId = uuidv4();
    await pool.query(
      `INSERT INTO upload_batches (id, file_name, file_type, uploaded_by, status)
       VALUES ($1, $2, 'route_master', $3, 'processing')`,
      [batchId, req.file.originalname, req.user.id]
    );

    try {
      console.log(`[RouteMaster] Reading: ${req.file.originalname}`);
      const workbook  = xlsx.readFile(req.file.path, { cellDates: false, raw: true });
      const sheetName = workbook.SheetNames[0];
      const rows      = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

      if (!rows.length) {
        await pool.query(`UPDATE upload_batches SET status='failed', error_message='الملف فارغ' WHERE id=$1`, [batchId]);
        return res.status(400).json({ error: 'الملف فارغ' });
      }

      // ── Detect column names ─────────────────────────────────────
      const cols = Object.keys(rows[0]);

      const pick = (...candidates) =>
        candidates.find(c => cols.some(k => k.trim().toLowerCase() === c.toLowerCase()));

      const colRouteId  = pick('Route Code','Route ID','RouteCode','route_id','كود المسار','رقم المسار','الخط','كود الخط','Route');
      const colRegionAr = pick('اسم المنطقة','المنطقة','منطقة','Region Name AR','Region AR','Region','Territory','Area');
      const colRegionEn = pick('Region EN','Region English','Region Name EN','Region Name','Area EN');
      const colRouteName= pick('Route Name','اسم المسار','اسم الخط','Route Description','Name');

      console.log(`[RouteMaster] Detected columns → routeId:${colRouteId}, regionAr:${colRegionAr}, regionEn:${colRegionEn}, routeName:${colRouteName}`);
      console.log(`[RouteMaster] Available columns: ${cols.join(', ')}`);

      if (!colRouteId) {
        return res.status(422).json({
          error: 'لم يتم العثور على عمود كود المسار (Route Code)',
          availableColumns: cols,
        });
      }
      if (!colRegionAr && !colRegionEn) {
        return res.status(422).json({
          error: 'لم يتم العثور على عمود اسم المنطقة',
          availableColumns: cols,
        });
      }

      // ── Parse rows ──────────────────────────────────────────────
      const routeMap = new Map(); // routeId → { regionNameAr, regionNameEn, routeName }
      let   skipped  = 0;

      for (const row of rows) {
        const routeId = parseInt(String(row[colRouteId] ?? '').trim(), 10);
        if (!routeId || isNaN(routeId)) { skipped++; continue; }

        const regionAr  = colRegionAr ? String(row[colRegionAr] ?? '').trim() : '';
        const regionEn  = colRegionEn ? String(row[colRegionEn] ?? '').trim() : '';
        const routeName = colRouteName ? String(row[colRouteName] ?? '').trim() : '';

        if (!regionAr && !regionEn) { skipped++; continue; }

        routeMap.set(routeId, { regionAr, regionEn, routeName });
      }

      console.log(`[RouteMaster] Parsed ${routeMap.size} valid routes, ${skipped} skipped`);

      if (!routeMap.size) {
        return res.status(422).json({ error: 'لا توجد بيانات صالحة في الملف', availableColumns: cols });
      }

      // ── Group by region name ────────────────────────────────────
      // Build regionName → { nameAr, nameEn, routeIds[] }
      const regionGroups = new Map();
      for (const [routeId, { regionAr, regionEn, routeName }] of routeMap) {
        const key = regionAr || regionEn;
        if (!regionGroups.has(key)) {
          regionGroups.set(key, { nameAr: regionAr, nameEn: regionEn, routeIds: [] });
        }
        regionGroups.get(key).routeIds.push({ routeId, routeName });
      }

      // ── DB transaction ──────────────────────────────────────────
      const dbClient = await pool.connect();
      let   regInserted = 0, regUpdated = 0, routesUpserted = 0, invUpdated = 0;

      try {
        await dbClient.query('BEGIN');

        // 1. Ensure routes table exists (idempotent)
        await dbClient.query(`
          CREATE TABLE IF NOT EXISTS routes (
            route_id   INTEGER PRIMARY KEY,
            region_id  INTEGER REFERENCES regions(id) ON DELETE SET NULL,
            route_name VARCHAR(200),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);

        // 2. Upsert regions
        const regionIdMap = new Map(); // key → region.id

        for (const [key, { nameAr, nameEn }] of regionGroups) {
          // Try to find existing region by Arabic name first, then English
          const existRes = await dbClient.query(
            `SELECT id FROM regions WHERE name_ar = $1 OR name_en = $2 LIMIT 1`,
            [nameAr || key, nameEn || key]
          );

          if (existRes.rows.length) {
            const id = existRes.rows[0].id;
            // Update names if we have better data
            if (nameAr || nameEn) {
              await dbClient.query(
                `UPDATE regions SET
                   name_ar = CASE WHEN $2 <> '' THEN $2 ELSE name_ar END,
                   name_en = CASE WHEN $3 <> '' THEN $3 ELSE name_en END
                 WHERE id = $1`,
                [id, nameAr, nameEn]
              );
              regUpdated++;
            }
            regionIdMap.set(key, id);
          } else {
            // Insert new region
            const ins = await dbClient.query(
              `INSERT INTO regions (name_ar, name_en)
               VALUES ($1, $2)
               ON CONFLICT DO NOTHING
               RETURNING id`,
              [nameAr || key, nameEn || nameAr || key]
            );
            if (ins.rows.length) {
              regionIdMap.set(key, ins.rows[0].id);
              regInserted++;
            }
          }
        }

        // 3. Upsert routes table only — route_id is the unique key, no prefix logic
        for (const [key, { routeIds }] of regionGroups) {
          const regionId = regionIdMap.get(key);
          if (!regionId) continue;

          for (const { routeId, routeName } of routeIds) {
            await dbClient.query(
              `INSERT INTO routes (route_id, region_id, route_name, updated_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (route_id) DO UPDATE
                 SET region_id  = EXCLUDED.region_id,
                     route_name = EXCLUDED.route_name,
                     updated_at = NOW()`,
              [routeId, regionId, routeName || null]
            );
            routesUpserted++;
          }
        }

        // 4. Re-link ALL invoices by joining routes table
        const updRes = await dbClient.query(
          `UPDATE invoices i
           SET region_id = rt.region_id
           FROM routes rt
           WHERE i.route_id = rt.route_id
             AND (i.region_id IS DISTINCT FROM rt.region_id)`
        );
        invUpdated = updRes.rowCount;

        await dbClient.query('COMMIT');
        console.log(`[RouteMaster] Done — regions: +${regInserted} updated:${regUpdated}, routes:${routesUpserted}, invoices re-linked:${invUpdated}`);

      } catch (dbErr) {
        await dbClient.query('ROLLBACK');
        throw dbErr;
      } finally {
        dbClient.release();
      }

      await pool.query(
        `UPDATE upload_batches SET status='success', row_count=$1 WHERE id=$2`,
        [routeMap.size, batchId]
      );

      res.json({
        success:        true,
        rowsProcessed:  routeMap.size,
        rowsSkipped:    skipped,
        regionsInserted:regInserted,
        regionsUpdated: regUpdated,
        routesUpserted,
        invoicesRelinked: invUpdated,
        detectedColumns: { route: colRouteId, regionAr: colRegionAr, regionEn: colRegionEn },
      });

    } catch (err) {
      console.error('[RouteMaster] Error:', err.message);
      await pool.query(
        `UPDATE upload_batches SET status='failed', error_message=$1 WHERE id=$2`,
        [err.message.substring(0, 500), batchId]
      );
      res.status(500).json({ error: 'فشل في معالجة الملف: ' + err.message });
    }
  }
);

// ─────────────────────────────────────────────
// GET /api/upload/batches[?file_type=xxx]
// ─────────────────────────────────────────────
router.get('/batches', verifyToken, requireRoles('super_admin', 'it_admin'), async (req, res) => {
  try {
    const { file_type } = req.query;
    const where  = file_type ? `WHERE ub.file_type = $1` : '';
    const params = file_type ? [file_type] : [];
    const { rows } = await pool.query(
      `SELECT ub.*, u.name AS uploader_name
       FROM upload_batches ub
       LEFT JOIN users u ON u.id = ub.uploaded_by
       ${where}
       ORDER BY ub.created_at DESC
       LIMIT 50`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('Batches error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
