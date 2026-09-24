const express = require('express');
const fs = require('fs');
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
 * Re-link every fridge to the sales rep + route of the customer's most
 * recent invoice (by invoice_date). Runs after every customer_balance
 * upload so fridge assignments stay in sync with whoever last sold to
 * that customer, without needing a manual admin action.
 */
async function syncFridgeAssignmentsFromInvoices() {
  const { rowCount } = await pool.query(`
    WITH latest_inv AS (
      SELECT DISTINCT ON (i.customer_id)
        i.customer_id, i.sales_rep_name, i.route_id
      FROM invoices i
      WHERE i.customer_id IS NOT NULL
      ORDER BY i.customer_id, i.invoice_date DESC, i.updated_at DESC
    )
    UPDATE fridges f
    SET salesrep_name = li.sales_rep_name,
        route_code    = li.route_id,
        updated_at    = NOW()
    FROM latest_inv li
    WHERE li.customer_id = f.customer_code
      AND (f.salesrep_name IS DISTINCT FROM li.sales_rep_name
           OR f.route_code IS DISTINCT FROM li.route_id)
  `);
  console.log(`[Upload] Synced ${rowCount} fridge(s) to latest invoice rep/route`);
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
          WHERE (status IN ('unpaid','partial') OR balance < 0)
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

      try {
        await syncFridgeAssignmentsFromInvoices();
      } catch (syncErr) {
        // Non-fatal — the invoice upload itself already succeeded.
        console.warn('[Upload] Fridge rep/route sync failed (non-fatal):', syncErr.message);
      }

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
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload/customer-list
// Reads the "Customer List - CM" export → upserts the `customers` master.
//
// The export is a periodic FULL list, so the load is an upsert keyed on the
// customer code — never a truncate-and-replace. A customer missing from a
// later export is left untouched rather than deleted: a partial or filtered
// download would otherwise wipe half the master, and this file is the only
// place supervisor / category / creation-source data exists at all.
//
// Column names are matched flexibly (the same approach as route-master) and
// whatever was matched is echoed back in the response, so a renamed column
// shows up as a reported mismatch instead of silently importing nulls.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/customer-list',
  verifyToken,
  requireRoles('super_admin', 'it_admin'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });

    const batchId = uuidv4();
    await pool.query(
      `INSERT INTO upload_batches (id, file_name, file_type, uploaded_by, status)
       VALUES ($1, $2, 'customer_list', $3, 'processing')`,
      [batchId, req.file.originalname, req.user.id]
    );

    const fail = async (status, body) => {
      await pool.query(
        `UPDATE upload_batches SET status='failed', error_message=$2 WHERE id=$1`,
        [batchId, String(body.error).slice(0, 500)]
      );
      return res.status(status).json(body);
    };

    try {
      const workbook = xlsx.readFile(req.file.path, { cellDates: true, raw: false });
      const sheet    = workbook.Sheets[workbook.SheetNames[0]];
      const rows     = xlsx.utils.sheet_to_json(sheet, { defval: '' });
      if (!rows.length) return fail(400, { error: 'الملف فارغ' });

      const cols = Object.keys(rows[0]);
      const norm = s => String(s).trim().toLowerCase().replace(/[\s_]+/g, ' ');
      /* The header row of this export arrives truncated in places
         ("Customer Co…", "Supervisor Co…", "Route Cod…"), so matching is done in
         tiers: exact first, then a shared-prefix match that tolerates ONE lost
         final character. Among prefix candidates the LONGEST column name wins —
         otherwise "Customer Category Name" would bind to the "Customer Category"
         code column, which sits earlier in the file, and the category code would
         be imported as the category name. */
      const sharedLen = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
      const pick = (...cands) => {
        for (const c of cands) {
          const hit = cols.find(k => norm(k) === norm(c));
          if (hit) return hit;
        }
        for (const c of cands) {
          const nc = norm(c);
          let best = null, bestLen = -1;
          for (const k of cols) {
            const nk = norm(k);
            const sh = sharedLen(nk, nc);
            const short = Math.min(nk.length, nc.length);
            if (short < 4) continue;
            const ok = sh === short || (short >= 6 && sh >= short - 1);
            if (ok && nk.length > bestLen) { best = k; bestLen = nk.length; }
          }
          if (best) return best;
        }
        return null;
      };

      const map = {
        customer_code:   pick('Customer Code', 'Customer Co', 'customer_code', 'كود العميل', 'رقم العميل'),
        /* 'Customer Name English' listed explicitly (not left to the prefix-
           match fallback) — the simpler "names-only" update file uses that
           exact header instead of the full CM export's plain 'Customer
           Name', and relying on prefix-matching alone to land on the right
           column over 'Customer Name Arabic' would be a coincidence of the
           two words' lengths, not a real guarantee. */
        customer_name:   pick('Customer Name', 'Customer Name English', 'Customer Name Eng', 'اسم العميل'),
        /* Listed with its own candidates so it can never be confused with the
           English column: 'Customer Name Arabic' also PREFIX-matches
           'Customer Name', so exact matching must resolve both first. */
        customer_name_ar: pick('Customer Name Arabic', 'Customer Name Ar', 'Customer Name AR',
                               'Customer Name Arab', 'اسم العميل بالعربي', 'الاسم العربي'),
        branch_code:     pick('Branch Code', 'Branch Cod', 'كود الفرع'),
        branch_name_en:  pick('Branch Name Eng', 'Branch Name English', 'Branch Name', 'اسم الفرع'),
        route_code:      pick('Route Code', 'Route Cod', 'كود الخط', 'رقم الخط'),
        route_name_en:   pick('Route Name English', 'Route Name Eng', 'Route Name', 'اسم الخط'),
        salesman_code:   pick('Salesman Code', 'Salesman Co', 'كود المندوب'),
        salesman_name:   pick('Salesman Name', 'اسم المندوب'),
        category_code:   pick('Customer Category', 'فئة العميل'),
        category_name:   pick('Customer Category Name', 'Customer Category Na', 'اسم فئة العميل'),
        supervisor_code: pick('Supervisor Code', 'Supervisor Co', 'كود المشرف'),
        supervisor_name: pick('Supervisor Name', 'اسم المشرف'),
        created_on:      pick('Datetime Created', 'Date Created', 'Created Date', 'تاريخ الإنشاء'),
        from_hht:        pick('Is Created From HHT', 'Is Created From H', 'Created From HHT'),
      };

      /* Two fields resolving to the SAME column means one of them is importing
         the wrong value. Reported rather than guessed at. */
      const byCol = {};
      Object.entries(map).forEach(([f, c]) => { if (c) (byCol[c] = byCol[c] || []).push(f); });
      const duplicateBindings = Object.entries(byCol).filter(([, fs]) => fs.length > 1)
        .map(([c, fs]) => ({ column: c, fields: fs }));

      /* The code and the name are the only columns the master cannot be built
         without — everything else is enrichment and may legitimately be blank. */
      if (!map.customer_code) {
        return fail(422, { error: 'لم يتم العثور على عمود كود العميل (Customer Code)', availableColumns: cols, matched: map });
      }
      if (!map.customer_name) {
        return fail(422, { error: 'لم يتم العثور على عمود اسم العميل (Customer Name)', availableColumns: cols, matched: map });
      }

      /* Branch name → region_id. regions.name_ar stores the ENGLISH branch
         identifier on this database (see the region-name gotcha), so both
         columns are tried. */
      const regRes = await pool.query('SELECT id, name_ar, name_en FROM regions');
      const regionByName = new Map();
      regRes.rows.forEach(r => {
        [r.name_ar, r.name_en].filter(Boolean)
          .forEach(n => regionByName.set(String(n).trim().toLowerCase(), r.id));
      });

      const S = (row, key, max) => {
        if (!map[key]) return null;
        const v = String(row[map[key]] ?? '').trim();
        if (!v) return null;
        return max ? v.slice(0, max) : v;
      };
      const truthy = v => {
        if (v == null) return null;
        const s = String(v).trim().toLowerCase();
        if (!s) return null;
        if (['yes', 'true', '1', 'y', 'نعم'].includes(s)) return true;
        if (['no', 'false', '0', 'n', 'لا'].includes(s)) return false;
        return null;
      };

      const parsed = new Map();   // last row wins for a repeated code
      let skipped = 0, unmatchedRegions = new Set();

      for (const row of rows) {
        const code = S(row, 'customer_code', 100);
        if (!code) { skipped++; continue; }

        const branchName = S(row, 'branch_name_en', 200);
        const regionId = branchName ? (regionByName.get(branchName.toLowerCase()) ?? null) : null;
        if (branchName && regionId == null) unmatchedRegions.add(branchName);

        const routeRaw = S(row, 'route_code');
        const routeNum = routeRaw ? parseInt(String(routeRaw).replace(/[^\d-]/g, ''), 10) : NaN;

        let createdOn = null;
        if (map.created_on) {
          const raw = row[map.created_on];
          const d = raw instanceof Date ? raw : (raw ? new Date(String(raw)) : null);
          if (d && !isNaN(d.getTime())) createdOn = d.toISOString();
        }

        parsed.set(code, [
          code,
          S(row, 'customer_name', 300),
          S(row, 'customer_name_ar', 300),
          S(row, 'branch_code', 50),
          branchName,
          regionId,
          Number.isFinite(routeNum) ? routeNum : null,
          S(row, 'route_name_en', 200),
          S(row, 'salesman_code', 50),
          S(row, 'salesman_name', 200),
          S(row, 'category_code', 50),
          S(row, 'category_name', 200),
          S(row, 'supervisor_code', 50),
          S(row, 'supervisor_name', 200),
          createdOn,
          truthy(map.from_hht ? row[map.from_hht] : null),
        ]);
      }

      if (!parsed.size) {
        return fail(422, { error: 'لا توجد صفوف صالحة في الملف', availableColumns: cols, matched: map });
      }

      const before = await pool.query('SELECT COUNT(*)::int AS n FROM customers');

      const client = await pool.connect();
      let inserted = 0, updated = 0;
      try {
        await client.query('BEGIN');
        for (const vals of parsed.values()) {
          const { rows: r } = await client.query(
            `INSERT INTO customers
               (customer_code, customer_name, customer_name_ar, branch_code, branch_name_en, region_id,
                route_code, route_name_en, salesman_code, salesman_name,
                category_code, category_name, supervisor_code, supervisor_name,
                created_on_source, created_from_hht, updated_by, upload_batch_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             ON CONFLICT (customer_code) DO UPDATE SET
               customer_name     = COALESCE(EXCLUDED.customer_name, customers.customer_name),
               customer_name_ar  = COALESCE(EXCLUDED.customer_name_ar, customers.customer_name_ar),
               branch_code       = COALESCE(EXCLUDED.branch_code, customers.branch_code),
               branch_name_en    = COALESCE(EXCLUDED.branch_name_en, customers.branch_name_en),
               region_id         = COALESCE(EXCLUDED.region_id, customers.region_id),
               route_code        = COALESCE(EXCLUDED.route_code, customers.route_code),
               route_name_en     = COALESCE(EXCLUDED.route_name_en, customers.route_name_en),
               salesman_code     = COALESCE(EXCLUDED.salesman_code, customers.salesman_code),
               salesman_name     = COALESCE(EXCLUDED.salesman_name, customers.salesman_name),
               category_code     = COALESCE(EXCLUDED.category_code, customers.category_code),
               category_name     = COALESCE(EXCLUDED.category_name, customers.category_name),
               supervisor_code   = COALESCE(EXCLUDED.supervisor_code, customers.supervisor_code),
               supervisor_name   = COALESCE(EXCLUDED.supervisor_name, customers.supervisor_name),
               created_on_source = COALESCE(EXCLUDED.created_on_source, customers.created_on_source),
               created_from_hht  = COALESCE(EXCLUDED.created_from_hht, customers.created_from_hht),
               updated_at        = NOW(),
               updated_by        = EXCLUDED.updated_by,
               upload_batch_id   = EXCLUDED.upload_batch_id
             RETURNING (xmax = 0) AS was_insert`,
            [...vals, req.user.id, batchId]
          );
          if (r[0].was_insert) inserted++; else updated++;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      /* upload_batches carries a single `row_count` — there are no
         total/success/error columns on this table (the other handlers use
         row_count too). */
      await pool.query(
        `UPDATE upload_batches SET status='success', row_count=$2 WHERE id=$1`,
        [batchId, parsed.size]
      );

      const withAr = [...parsed.values()].filter(v => v[2]).length;

      res.json({
        message: 'تم تحديث بيانات العملاء',
        with_arabic_name: withAr,
        file_rows: rows.length,
        customers_in_file: parsed.size,
        inserted, updated, skipped,
        total_customers: before.rows[0].n + inserted,
        /* Reported, not hidden: a branch name with no matching region leaves
           region_id null, and the operator needs to know which ones. */
        unmatched_branches: [...unmatchedRegions],
        matched_columns: map,
        duplicate_bindings: duplicateBindings,
        available_columns: cols,
      });
    } catch (err) {
      console.error('[CustomerList] upload failed:', err);
      await pool.query(
        `UPDATE upload_batches SET status='failed', error_message=$2 WHERE id=$1`,
        [batchId, String(err.message).slice(0, 500)]
      );
      res.status(500).json({ error: 'فشل تحديث بيانات العملاء: ' + err.message });
    } finally {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/upload/data-integrity
// Does every file actually link up? All four sources key on the customer code:
//   customers (Customer List - CM)  ← the master, carries route + salesman
//   invoices  (customerBalanceDues) ← debt
//   payments  (Route Invoice Collection Payment) ← collection
//   sales_activity (تقرير العملاء المتعاملة) ← quantities
// This reports, per region, where a link is MISSING — the case that made
// Jeddah's debt invisible on the dashboard: 74 customers in the master, live
// payments and sales, and zero rows in the balance file.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/data-integrity', verifyToken, async (req, res) => {
  try {
    const [byRegion, orphans, routesRes, freshRes, repRes] = await Promise.all([
      /* Set-based, NOT correlated EXISTS per customer: the first version ran an
         EXISTS against sales_activity (457K rows) once per customer and hung
         the request. Three DISTINCT scans hash-joined instead. */
      pool.query(`
        WITH inv AS (SELECT DISTINCT customer_id  AS code FROM invoices),
             pay AS (SELECT DISTINCT customer_code AS code FROM payments),
             sal AS (SELECT DISTINCT customer_code AS code FROM sales_activity),
             debt AS (SELECT region_id, ROUND(SUM(balance)::numeric,2) AS debt
                        FROM invoices GROUP BY region_id)
        SELECT r.id AS region_id, r.name_ar AS region,
               COUNT(c.customer_code)::int                                  AS customers,
               COUNT(*) FILTER (WHERE inv.code IS NOT NULL)::int            AS with_invoices,
               COUNT(*) FILTER (WHERE pay.code IS NOT NULL)::int            AS with_payments,
               COUNT(*) FILTER (WHERE sal.code IS NOT NULL)::int            AS with_sales,
               COUNT(*) FILTER (WHERE c.route_code IS NULL
                                  AND c.customer_code IS NOT NULL)::int     AS no_route,
               COUNT(*) FILTER (WHERE c.salesman_name IS NULL
                                  AND c.customer_code IS NOT NULL)::int     AS no_salesman,
               COALESCE(MAX(debt.debt), 0)                                  AS debt
        FROM regions r
        LEFT JOIN customers c ON c.region_id = r.id
        LEFT JOIN inv  ON inv.code = c.customer_code
        LEFT JOIN pay  ON pay.code = c.customer_code
        LEFT JOIN sal  ON sal.code = c.customer_code
        LEFT JOIN debt ON debt.region_id = r.id
        GROUP BY r.id, r.name_ar
        ORDER BY customers DESC`),
      /* codes present in a transactional file but absent from the master —
         these can never be enriched with a route or a salesman */
      pool.query(`
        SELECT 'payments' AS source, p.customer_code, MAX(p.customer_name) AS customer_name
          FROM payments p LEFT JOIN customers c ON c.customer_code = p.customer_code
         WHERE c.customer_code IS NULL GROUP BY 1,2
        UNION ALL
        SELECT 'sales_activity', s.customer_code, MAX(s.customer_name)
          FROM sales_activity s LEFT JOIN customers c ON c.customer_code = s.customer_code
         WHERE c.customer_code IS NULL GROUP BY 1,2
        UNION ALL
        SELECT 'invoices', i.customer_id, MAX(i.customer_name)
          FROM invoices i LEFT JOIN customers c ON c.customer_code = i.customer_id
         WHERE c.customer_code IS NULL GROUP BY 1,2
        ORDER BY 1,2`),
      pool.query(`
        SELECT COUNT(DISTINCT c.route_code)::int AS master_routes,
               COUNT(DISTINCT c.route_code) FILTER (WHERE rt.route_id IS NULL)::int AS missing_from_routes
          FROM customers c LEFT JOIN routes rt ON rt.route_id = c.route_code
         WHERE c.route_code IS NOT NULL`),
      pool.query(`
        SELECT 'customers' AS source, MAX(updated_at) AS newest FROM customers
        UNION ALL SELECT 'invoices',       MAX(updated_at)  FROM invoices
        UNION ALL SELECT 'payments',       MAX(uploaded_at) FROM payments
        UNION ALL SELECT 'sales_activity', MAX(uploaded_at) FROM sales_activity`),
      /* The master's salesman vs the reps the sales file actually reports.
         Compared as two SETS. The first version used NOT EXISTS with TRIM() on
         both sides, which defeats idx_sa_rep and scanned all 457K sales rows
         once per customer — it ran for over three minutes and hung the whole
         endpoint. */
      pool.query(`
        WITH reps AS (
          SELECT DISTINCT TRIM(salesrep_name) AS name FROM sales_activity
           WHERE salesrep_name IS NOT NULL AND TRIM(salesrep_name) <> ''),
        ms AS (
          SELECT DISTINCT TRIM(salesman_name) AS name FROM customers
           WHERE salesman_name IS NOT NULL AND TRIM(salesman_name) <> '')
        SELECT (SELECT COUNT(*)::int FROM ms) AS master_salesmen,
               (SELECT COUNT(*)::int FROM ms LEFT JOIN reps ON reps.name = ms.name
                 WHERE reps.name IS NULL) AS not_seen_in_sales`),
    ]);

    const regions = byRegion.rows.map(r => ({
      ...r,
      /* The signal that matters: the region has customers on the books but the
         debt file knows none of them, so its debt reads zero everywhere. */
      missing_from_debt_file: r.customers > 0 && r.with_invoices === 0,
    }));

    const orphanBySource = {};
    orphans.rows.forEach(o => {
      (orphanBySource[o.source] = orphanBySource[o.source] || []).push(
        { customer_code: o.customer_code, customer_name: o.customer_name });
    });

    res.json({
      regions,
      alerts: regions.filter(r => r.missing_from_debt_file).map(r => ({
        region: r.region,
        message: `${r.customers} عميل بالسجل و${r.with_sales} لديهم مبيعات، ولا يوجد أي صف لهم في ملف الأرصدة — لن تظهر مديونية ${r.region}`,
      })),
      orphans: Object.entries(orphanBySource).map(([source, rows]) => ({
        source, count: rows.length, sample: rows.slice(0, 20),
      })),
      routes: routesRes.rows[0],
      salesmen: repRes.rows[0],
      freshness: freshRes.rows,
    });
  } catch (e) {
    console.error('[Upload] data-integrity:', e);
    res.status(500).json({ error: e.message });
  }
});

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
