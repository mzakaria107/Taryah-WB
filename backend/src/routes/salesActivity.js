const express  = require('express');
const xlsx     = require('xlsx');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const pool     = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

const router = express.Router();

// ── Multer for CSV (accept csv + xlsx) ─────────────────────
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const csvStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ts  = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `${ts}-sa-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  },
});

const csvUpload = multer({
  storage: csvStorage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.csv', '.xlsx', '.xls'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('يُسمح فقط بملفات CSV أو Excel'));
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// ── Constants ───────────────────────────────────────────────
const MONTH_MAP = {
  January:1, February:2, March:3, April:4,
  May:5, June:6, July:7, August:8,
  September:9, October:10, November:11, December:12,
};

// Case-insensitive lookup helper
function lookupMonth(name) {
  if (!name) return undefined;
  const trimmed = name.trim();
  // Exact match first
  if (MONTH_MAP[trimmed] !== undefined) return MONTH_MAP[trimmed];
  // Case-insensitive fallback
  const lower = trimmed.toLowerCase();
  for (const [key, val] of Object.entries(MONTH_MAP)) {
    if (key.toLowerCase() === lower) return val;
  }
  return undefined;
}

const BATCH_SIZE = 500;

/* Resolve a region_id to its branch_name (name_ar) for sales_activity filtering */
async function resolveRegionBranch(regionId) {
  if (!regionId) return null;
  try {
    const res = await pool.query('SELECT name_ar FROM regions WHERE id = $1', [regionId]);
    return res.rows[0]?.name_ar || null;
  } catch { return null; }
}

// ── Robust CSV parser (handles quoted fields with commas) ───
function parseCSV(text) {
  // Strip UTF-8 BOM
  text = text.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);

  function splitLine(line) {
    const result = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        // Handle escaped double-quotes ""
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; continue; }
        inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    result.push(cur.trim());
    return result;
  }

  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length < 2) return [];

  const headers = splitLine(nonEmpty[0]).map(h => h.replace(/^﻿/, '').trim());
  const rows = [];
  for (let i = 1; i < nonEmpty.length; i++) {
    const vals = splitLine(nonEmpty[i]);
    // Skip completely empty lines
    if (vals.every(v => !v)) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] !== undefined ? vals[idx] : ''; });
    rows.push(obj);
  }
  return rows;
}

// ── Helper: parse CSV/XLSX file into row objects ────────────
function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') {
    // Use robust custom CSV parser instead of xlsx (which misaligns columns for Arabic names with commas)
    // Try UTF-8 first; if it contains replacement chars, fall back to latin1 (Windows-1256 safe passthrough)
    let buf  = fs.readFileSync(filePath);
    let text = buf.toString('utf-8');

    // Detect Windows-1256 / Latin-1 encoding: if there are many replacement chars (U+FFFD) use latin1
    const replacements = (text.match(/�/g) || []).length;
    if (replacements > 5) {
      console.log('[SalesActivity] Encoding fallback: latin1 (possible Windows-1256)');
      text = buf.toString('latin1');
    }

    return parseCSV(text);
  }
  // For real Excel files, xlsx is fine
  const wb   = xlsx.readFile(filePath, { type: 'file' });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: '', raw: false });
  return rows;
}

// ── POST /upload ─────────────────────────────────────────────
router.post('/upload', verifyToken, applyRegionFilter, csvUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });

  const batchId = uuidv4();
  await pool.query(
    `INSERT INTO upload_batches (id, file_name, file_type, uploaded_by, status)
     VALUES ($1, $2, 'sales_activity', $3, 'processing')`,
    [batchId, req.file.originalname, req.user.id]
  );

  try {
    console.log(`[SalesActivity] Reading: ${req.file.originalname}`);
    const rawRows = parseFile(req.file.path);
    console.log(`[SalesActivity] Parsed ${rawRows.length} rows`);

    if (!rawRows.length) {
      await pool.query(`UPDATE upload_batches SET status='failed', error_message='الملف فارغ' WHERE id=$1`, [batchId]);
      return res.status(400).json({ error: 'الملف فارغ أو لا يحتوي على بيانات' });
    }

    // Detect columns (handle BOM in first key)
    const sampleKeys = Object.keys(rawRows[0]);
    console.log('[SalesActivity] Detected columns:', sampleKeys);
    const findKey = (name) => sampleKeys.find(k => k.replace(/^﻿/, '').trim() === name) || name;

    const COL_CUST_NAME   = findKey('Customer Name Arabic');
    const COL_CUST_CODE   = findKey('Customer Code');
    const COL_BRANCH      = findKey('Branch Name English');
    const COL_REP         = findKey('First Name Salesrep English');
    const COL_INVOICE     = findKey('Invoice Number');
    const COL_MONTH       = findKey('Month');
    const COL_QTY         = findKey('Total Net qty with FOC');
    const COL_CATEGORY    = findKey('Category Name English');
    // Day: prefer explicit 'Day' column, fallback to extracting from 'Transaction Date'
    const COL_DAY         = sampleKeys.includes('Day') ? 'Day' : null;
    const COL_DATE        = sampleKeys.find(k => k.replace(/^﻿/, '').trim() === 'Transaction Date') || null;
    console.log('[SalesActivity] Column mapping:', { COL_CUST_NAME, COL_CUST_CODE, COL_BRANCH, COL_REP, COL_INVOICE, COL_MONTH, COL_QTY, COL_CATEGORY, COL_DAY, COL_DATE });
    if (rawRows.length > 0) {
      const sample = rawRows[0];
      console.log('[SalesActivity] First row sample:', {
        name:    sample[COL_CUST_NAME],
        code:    sample[COL_CUST_CODE],
        invoice: sample[COL_INVOICE],
        month:   sample[COL_MONTH],
        qty:     sample[COL_QTY],
      });
    }

    // Build valid rows
    const validRows = [];
    const errors    = [];

    for (let i = 0; i < rawRows.length; i++) {
      const r       = rawRows[i];
      const rowNum  = i + 2;

      const invoiceNum = String(r[COL_INVOICE] || '').trim();
      if (!invoiceNum) continue; // skip silently per spec

      const monthName = String(r[COL_MONTH] || '').trim();
      const monthNum  = lookupMonth(monthName);
      if (!monthNum) {
        errors.push({ row: rowNum, error: `اسم الشهر غير معروف: "${monthName}"` });
        continue;
      }

      const custName  = String(r[COL_CUST_NAME] || '').trim();
      const custCode  = String(r[COL_CUST_CODE]  || '').trim();
      if (!custCode) {
        errors.push({ row: rowNum, error: 'كود العميل مفقود' });
        continue;
      }

      const qtyRaw = String(r[COL_QTY] || '0').replace(/,/g, '').trim();
      const qty    = parseInt(qtyRaw, 10) || 0;

      let day = null;
      if (COL_DAY && r[COL_DAY]) {
        day = parseInt(String(r[COL_DAY]).trim(), 10) || null;
      } else if (COL_DATE && r[COL_DATE]) {
        // Extract day from "2026-05-03 00:00:00" or "2026-05-03"
        const m = String(r[COL_DATE]).trim().match(/^\d{4}-\d{2}-(\d{2})/);
        if (m) day = parseInt(m[1], 10) || null;
      }

      validRows.push({
        customer_name:  custName  || custCode,
        customer_code:  custCode,
        branch_name:    String(r[COL_BRANCH]   || '').trim() || null,
        salesrep_name:  String(r[COL_REP]      || '').trim() || null,
        category_name:  String(r[COL_CATEGORY] || '').trim() || null,
        invoice_number: invoiceNum,
        month_name:     monthName,
        month_num:      monthNum,
        report_year:    2026,
        qty,
        day,
      });
    }

    console.log(`[SalesActivity] ${rawRows.length} raw → ${validRows.length} valid, ${errors.length} errors`);

    if (!validRows.length)
      return res.status(400).json({ error: 'لا توجد صفوف صالحة بعد التحقق', errors: errors.slice(0, 50) });

    // ── Determine which months & year are in the uploaded file ──
    // Only those months will be replaced; all other months stay untouched.
    const uploadYear   = validRows[0].report_year;
    const uploadMonths = [...new Set(validRows.map(r => r.month_num))];
    console.log(`[SalesActivity] Will replace month(s) ${uploadMonths.join(',')} of ${uploadYear} only`);

    // Batch replace (DELETE month(s) then INSERT fresh)
    const dbClient = await pool.connect();
    let inserted = 0, deleted = 0;

    try {
      await dbClient.query('BEGIN');

      // Delete ONLY the months present in the uploaded file for this year
      const delRes = await dbClient.query(
        `DELETE FROM sales_activity
         WHERE report_year = $1
           AND month_num   = ANY($2::smallint[])`,
        [uploadYear, uploadMonths]
      );
      deleted = delRes.rowCount;
      console.log(`[SalesActivity] Deleted ${deleted} old rows for month(s) ${uploadMonths.join(',')}`);

      // Insert all new rows in batches
      for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
        const chunk = validRows.slice(i, i + BATCH_SIZE);
        const COLS  = 11;   // +1 for day
        const vals  = [];
        const ph    = chunk.map((row, idx) => {
          const b = idx * COLS;
          vals.push(
            row.customer_name, row.customer_code, row.branch_name,
            row.salesrep_name, row.category_name, row.invoice_number,
            row.month_name, row.month_num, row.report_year, row.qty,
            row.day ?? null,
          );
          return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`;
        });

        const result = await dbClient.query(
          `INSERT INTO sales_activity
             (customer_name, customer_code, branch_name, salesrep_name,
              category_name, invoice_number, month_name, month_num, report_year, qty, day)
           VALUES ${ph.join(',')}
           ON CONFLICT (invoice_number, report_year) DO UPDATE SET
             qty           = EXCLUDED.qty,
             day           = EXCLUDED.day,
             category_name = EXCLUDED.category_name,
             uploaded_at   = NOW(),
             uploaded_by   = $${chunk.length * COLS + 1}
           RETURNING id`,
          [...vals, req.user.id]
        );
        inserted += result.rowCount;
      }

      await dbClient.query('COMMIT');
    } catch (dbErr) {
      await dbClient.query('ROLLBACK');
      throw dbErr;
    } finally {
      dbClient.release();
    }

    // Clean up temp file
    try { fs.unlinkSync(req.file.path); } catch (_) {}

    console.log(`[SalesActivity] inserted=${inserted}, deleted=${deleted}, months=${uploadMonths.join(',')}`);
    await pool.query(
      `UPDATE upload_batches SET status='success', row_count=$1 WHERE id=$2`,
      [inserted, batchId]
    );
    res.json({
      success: true,
      inserted,
      deleted,
      months:  uploadMonths,
      year:    uploadYear,
      total:   validRows.length,
      errors:  errors.slice(0, 50),
    });

  } catch (err) {
    console.error('[SalesActivity] Upload error:', err.message);
    await pool.query(
      `UPDATE upload_batches SET status='failed', error_message=$1 WHERE id=$2`,
      [err.message.substring(0, 500), batchId]
    );
    res.status(500).json({ error: 'فشل في معالجة الملف: ' + err.message });
  }
});

// ── Filter helper: builds WHERE clause starting at the given $N ─
function filterClause(branch, rep, startAt) {
  const conds = [];
  const vals  = [];
  let p = startAt;
  if (branch) { conds.push(`branch_name = $${p++}`);   vals.push(branch); }
  if (rep)    { conds.push(`salesrep_name = $${p++}`); vals.push(rep);    }
  return { sql: conds.length ? ' AND ' + conds.join(' AND ') : '', vals };
}

// ── GET /kpi ─────────────────────────────────────────────────
router.get('/kpi', verifyToken, applyRegionFilter, async (req, res) => {
  const year   = parseInt(req.query.year || '2026', 10);
  let   branch = (req.query.branch || '').trim() || null;
  const rep    = (req.query.rep    || '').trim() || null;
  if (req.regionFilter) branch = await resolveRegionBranch(req.regionFilter);

  try {
    // Max month & prev month (no filter needed here)
    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(month_num),0) AS max_month FROM sales_activity WHERE report_year=$1`,
      [year]
    );
    const maxMonth  = parseInt(maxRes.rows[0].max_month, 10);
    const prevMonth = maxMonth > 1 ? maxMonth - 1 : null;

    // Each query gets its own filter clause with correct parameter positions
    // Queries with only $1=year: filter starts at $2
    const f1 = filterClause(branch, rep, 2);
    // Queries with $1=year, $2=month: filter starts at $3
    const f2 = filterClause(branch, rep, 3);
    // Queries with $1=year, $2=prevMonth, $3=maxMonth: filter starts at $4
    const f3 = filterClause(branch, rep, 4);

    const [totalInvRes, totalCustRes, byMonthRes, activeRes, stoppedRes, newRes] = await Promise.all([
      // Total invoices
      pool.query(
        `SELECT COUNT(*) AS cnt FROM sales_activity WHERE report_year=$1${f1.sql}`,
        [year, ...f1.vals]
      ),
      // Total distinct customers
      pool.query(
        `SELECT COUNT(DISTINCT customer_code) AS cnt FROM sales_activity WHERE report_year=$1${f1.sql}`,
        [year, ...f1.vals]
      ),
      // Invoices by month
      pool.query(
        `SELECT month_num, COUNT(*) AS cnt
         FROM sales_activity WHERE report_year=$1${f1.sql}
         GROUP BY month_num ORDER BY month_num`,
        [year, ...f1.vals]
      ),
      // Active in current month ($1=year, $2=maxMonth, filter from $3)
      maxMonth
        ? pool.query(
            `SELECT COUNT(DISTINCT customer_code) AS cnt
             FROM sales_activity WHERE report_year=$1 AND month_num=$2${f2.sql}`,
            [year, maxMonth, ...f2.vals]
          )
        : Promise.resolve({ rows: [{ cnt: 0 }] }),
      // Stopped: in prevMonth but NOT in maxMonth ($1=year, $2=prevMonth, $3=maxMonth, filter from $4)
      prevMonth
        ? pool.query(
            `SELECT COUNT(DISTINCT customer_code) AS cnt
             FROM sales_activity
             WHERE report_year=$1 AND month_num=$2${f3.sql}
               AND customer_code NOT IN (
                 SELECT DISTINCT customer_code FROM sales_activity
                 WHERE report_year=$1 AND month_num=$3
               )`,
            [year, prevMonth, maxMonth, ...f3.vals]
          )
        : Promise.resolve({ rows: [{ cnt: 0 }] }),
      // New in maxMonth: not in any previous month ($1=year, $2=maxMonth, filter from $3)
      maxMonth
        ? pool.query(
            `SELECT COUNT(DISTINCT customer_code) AS cnt
             FROM sales_activity
             WHERE report_year=$1 AND month_num=$2${f2.sql}
               AND customer_code NOT IN (
                 SELECT DISTINCT customer_code FROM sales_activity
                 WHERE report_year=$1 AND month_num < $2
               )`,
            [year, maxMonth, ...f2.vals]
          )
        : Promise.resolve({ rows: [{ cnt: 0 }] }),
    ]);

    const invoicesByMonth = {};
    for (const r of byMonthRes.rows) invoicesByMonth[parseInt(r.month_num)] = parseInt(r.cnt);

    res.json({
      maxMonth,
      prevMonth,
      totalInvoices:       parseInt(totalInvRes.rows[0].cnt),
      totalCustomers:      parseInt(totalCustRes.rows[0].cnt),
      activeCurrentMonth:  parseInt(activeRes.rows[0].cnt),
      stoppedCurrentMonth: parseInt(stoppedRes.rows[0].cnt),
      newCurrentMonth:     parseInt(newRes.rows[0].cnt),
      invoicesByMonth,
    });
  } catch (err) {
    console.error('[SalesActivity] kpi error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /region-stats ─────────────────────────────────────────
router.get('/region-stats', verifyToken, applyRegionFilter, async (req, res) => {
  const year   = parseInt(req.query.year || '2026', 10);
  let   branch = (req.query.branch || '').trim() || null;
  const rep    = (req.query.rep    || '').trim() || null;
  if (req.regionFilter) branch = await resolveRegionBranch(req.regionFilter);

  try {
    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(month_num),0) AS max_month FROM sales_activity WHERE report_year=$1`,
      [year]
    );
    const maxMonth  = parseInt(maxRes.rows[0].max_month, 10);
    const prevMonth = maxMonth > 1 ? maxMonth - 1 : null;

    if (!maxMonth) return res.json({ maxMonth: 0, prevMonth: null, regions: [] });

    // Each query: $1=year, $2=month → filter starts at $3
    const f2 = filterClause(branch, rep, 3);
    // Stopped query: $1=year, $2=prevMonth, $3=maxMonth → filter starts at $4
    const f3 = filterClause(branch, rep, 4);

    const f2prev = filterClause(branch, rep, 3);

    // Run all region queries in parallel
    const [newByRegion, currentTotalByRegion, stoppedByRegionRes, prevTotalByRegionRes] = await Promise.all([
      // New customers per region: split into truly_new vs returning via invoices table
      // A customer is "returning" if they appear in invoices from a previous year
      pool.query(
        `WITH new_custs AS (
           SELECT DISTINCT
             sa.customer_code,
             COALESCE(sa.branch_name,'غير محدد') AS region
           FROM sales_activity sa
           WHERE sa.report_year = $1 AND sa.month_num = $2${f2.sql}
             AND sa.customer_code NOT IN (
               SELECT DISTINCT customer_code FROM sales_activity
               WHERE report_year = $1 AND month_num < $2
             )
         )
         SELECT
           nc.region,
           COUNT(nc.customer_code)                                          AS cnt,
           COUNT(CASE WHEN prev.customer_id IS NOT NULL THEN 1 END)        AS returning_cnt,
           COUNT(CASE WHEN prev.customer_id IS NULL     THEN 1 END)        AS truly_new_cnt
         FROM new_custs nc
         LEFT JOIN LATERAL (
           SELECT customer_id FROM invoices
           WHERE customer_id = nc.customer_code AND year < $1
           LIMIT 1
         ) prev ON true
         GROUP BY nc.region
         ORDER BY cnt DESC`,
        [year, maxMonth, ...f2.vals]
      ),
      // Total distinct customers per region in current month
      pool.query(
        `SELECT COALESCE(branch_name,'غير محدد') AS region, COUNT(DISTINCT customer_code) AS cnt
         FROM sales_activity
         WHERE report_year=$1 AND month_num=$2${f2.sql}
         GROUP BY branch_name`,
        [year, maxMonth, ...f2.vals]
      ),
      // Stopped: in prevMonth but NOT in maxMonth
      prevMonth ? pool.query(
        `SELECT COALESCE(branch_name,'غير محدد') AS region, COUNT(DISTINCT customer_code) AS cnt
         FROM sales_activity
         WHERE report_year=$1 AND month_num=$2${f3.sql}
           AND customer_code NOT IN (
             SELECT DISTINCT customer_code FROM sales_activity
             WHERE report_year=$1 AND month_num=$3
           )
         GROUP BY branch_name ORDER BY cnt DESC`,
        [year, prevMonth, maxMonth, ...f3.vals]
      ) : Promise.resolve({ rows: [] }),
      // Total distinct customers per region in prev month
      prevMonth ? pool.query(
        `SELECT COALESCE(branch_name,'غير محدد') AS region, COUNT(DISTINCT customer_code) AS cnt
         FROM sales_activity
         WHERE report_year=$1 AND month_num=$2${f2prev.sql}
         GROUP BY branch_name`,
        [year, prevMonth, ...f2prev.vals]
      ) : Promise.resolve({ rows: [] }),
    ]);

    // Build region map
    const regMap = {};
    const ensure = r => {
      if (!regMap[r]) regMap[r] = {
        region: r, newCount: 0, trulyNewCount: 0, returningCount: 0,
        stoppedCount: 0, prevCount: 0, currentCount: 0,
      };
    };
    for (const r of newByRegion.rows) {
      ensure(r.region);
      regMap[r.region].newCount       = parseInt(r.cnt,           10);
      regMap[r.region].returningCount = parseInt(r.returning_cnt, 10);
      regMap[r.region].trulyNewCount  = parseInt(r.truly_new_cnt, 10);
    }
    for (const r of currentTotalByRegion.rows)  { ensure(r.region); regMap[r.region].currentCount  = parseInt(r.cnt); }
    for (const r of stoppedByRegionRes.rows)    { ensure(r.region); regMap[r.region].stoppedCount  = parseInt(r.cnt); }
    for (const r of prevTotalByRegionRes.rows)  { ensure(r.region); regMap[r.region].prevCount     = parseInt(r.cnt); }

    res.json({
      maxMonth,
      prevMonth,
      regions: Object.values(regMap).sort((a, b) => b.currentCount - a.currentCount),
    });
  } catch (err) {
    console.error('[SalesActivity] region-stats error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /stopped-customers ───────────────────────────────────
// Customers active in prevMonth but NOT in current (max) month
router.get('/stopped-customers', verifyToken, applyRegionFilter, async (req, res) => {
  const year   = parseInt(req.query.year || '2026', 10);
  let   branch = (req.query.branch || '').trim() || null;
  const rep    = (req.query.rep    || '').trim() || null;
  if (req.regionFilter) branch = await resolveRegionBranch(req.regionFilter);

  try {
    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(month_num),0) AS max_month FROM sales_activity WHERE report_year=$1`,
      [year]
    );
    const currentMonth = parseInt(maxRes.rows[0].max_month, 10);
    const prevMonth    = currentMonth > 1 ? currentMonth - 1 : null;

    if (!currentMonth || !prevMonth)
      return res.json({ currentMonth, prevMonth: null, customers: [] });

    // $1=year, $2=prevMonth, $3=currentMonth → filter from $4
    const f = filterClause(branch, rep, 4);

    const result = await pool.query(
      `SELECT
         sa.customer_code,
         MAX(sa.customer_name)  AS customer_name,
         MAX(sa.branch_name)    AS branch_name,
         MAX(sa.salesrep_name)  AS salesrep_name,
         COUNT(*)               AS invoice_count,
         SUM(sa.qty)            AS total_qty
       FROM sales_activity sa
       WHERE sa.report_year = $1
         AND sa.month_num   = $2${f.sql}
         AND sa.customer_code NOT IN (
           SELECT DISTINCT customer_code
           FROM   sales_activity
           WHERE  report_year = $1
             AND  month_num   = $3
         )
       GROUP BY sa.customer_code
       ORDER BY invoice_count DESC`,
      [year, prevMonth, currentMonth, ...f.vals]
    );

    res.json({
      currentMonth,
      prevMonth,
      customers: result.rows.map(r => ({
        customer_code:  r.customer_code,
        customer_name:  r.customer_name,
        branch_name:    r.branch_name,
        salesrep_name:  r.salesrep_name,
        invoice_count:  parseInt(r.invoice_count, 10),
        total_qty:      parseInt(r.total_qty, 10) || 0,
      })),
    });
  } catch (err) {
    console.error('[SalesActivity] stopped-customers error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /report ──────────────────────────────────────────────
router.get('/report', verifyToken, applyRegionFilter, async (req, res) => {
  const year   = parseInt(req.query.year || '2026', 10);
  let   branch = (req.query.branch || '').trim() || null;
  const rep    = (req.query.rep    || '').trim() || null;
  if (req.regionFilter) branch = await resolveRegionBranch(req.regionFilter);

  try {
    // Build WHERE conditions
    const conditions = ['sa.report_year = $1'];
    const params     = [year];
    let   p          = 2;

    if (branch) { conditions.push(`sa.branch_name = $${p++}`); params.push(branch); }
    if (rep)    { conditions.push(`sa.salesrep_name = $${p++}`); params.push(rep); }

    const where = conditions.join(' AND ');

    // Get max month (current month in the data)
    const maxMonthRes = await pool.query(
      `SELECT COALESCE(MAX(month_num), 0) AS max_month FROM sales_activity WHERE report_year = $1`,
      [year]
    );
    const maxMonth = parseInt(maxMonthRes.rows[0].max_month, 10);

    // Get all distinct months present in the data for this year
    const monthsRes = await pool.query(
      `SELECT DISTINCT month_num FROM sales_activity WHERE report_year = $1 ORDER BY month_num`,
      [year]
    );
    const months = monthsRes.rows.map(r => parseInt(r.month_num, 10));

    // Aggregate: customer × month → sum qty, count invoices
    const dataRes = await pool.query(
      `SELECT
         sa.customer_code,
         MAX(sa.customer_name)   AS customer_name,
         MAX(sa.branch_name)     AS branch_name,
         MAX(sa.salesrep_name)   AS salesrep_name,
         MAX(sa.category_name)   AS category_name,
         sa.month_num,
         SUM(sa.qty)             AS total_qty,
         COUNT(*)                AS invoice_count
       FROM sales_activity sa
       WHERE ${where}
       GROUP BY sa.customer_code, sa.month_num`,
      params
    );

    // Notes
    const notesRes = await pool.query(
      `SELECT customer_code, note_text FROM sales_activity_notes`
    );
    const notesMap = {};
    for (const n of notesRes.rows) notesMap[n.customer_code] = n.note_text;

    // Build customer map
    const custMap = new Map();

    for (const row of dataRes.rows) {
      const code = row.customer_code;
      if (!custMap.has(code)) {
        custMap.set(code, {
          customer_code: code,
          customer_name: row.customer_name,
          branch_name:   row.branch_name,
          salesrep_name: row.salesrep_name,
          category_name: row.category_name,
          months:        {},
          total:         0,
        });
      }
      const c = custMap.get(code);
      const mn = parseInt(row.month_num, 10);
      c.months[mn] = parseInt(row.invoice_count, 10);
      c.total     += parseInt(row.invoice_count, 10);
    }

    // Add note & active_current flag
    const customers = Array.from(custMap.values()).map(c => ({
      ...c,
      active_current: Boolean(maxMonth && c.months[maxMonth] > 0),
      note:           notesMap[c.customer_code] || '',
    }));

    // Sort: inactive first (desc total), then active (desc total)
    customers.sort((a, b) => {
      if (a.active_current !== b.active_current) {
        return a.active_current ? 1 : -1; // inactive first
      }
      return b.total - a.total;
    });

    res.json({ months, customers, maxMonth });

  } catch (err) {
    console.error('[SalesActivity] report error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /new-customers ───────────────────────────────────────
router.get('/new-customers', verifyToken, applyRegionFilter, async (req, res) => {
  const year   = parseInt(req.query.year || '2026', 10);
  let   branch = (req.query.branch || '').trim() || null;
  const rep    = (req.query.rep    || '').trim() || null;
  if (req.regionFilter) branch = await resolveRegionBranch(req.regionFilter);

  try {
    // Max month
    const maxMonthRes = await pool.query(
      `SELECT COALESCE(MAX(month_num), 0) AS max_month FROM sales_activity WHERE report_year = $1`,
      [year]
    );
    const currentMonth = parseInt(maxMonthRes.rows[0].max_month, 10);
    if (!currentMonth) return res.json({ currentMonth: 0, customers: [] });

    // Build filter clause
    const filterConds = [];
    const filterParams = [year, currentMonth];
    let p = 3;

    if (branch) { filterConds.push(`sa.branch_name = $${p++}`); filterParams.push(branch); }
    if (rep)    { filterConds.push(`sa.salesrep_name = $${p++}`); filterParams.push(rep); }

    const extraWhere = filterConds.length ? ' AND ' + filterConds.join(' AND ') : '';

    // Customers active in current month but NOT in any previous month
    const result = await pool.query(
      `SELECT
         sa.customer_code,
         MAX(sa.customer_name)  AS customer_name,
         MAX(sa.branch_name)    AS branch_name,
         MAX(sa.salesrep_name)  AS salesrep_name,
         COUNT(*)               AS invoice_count,
         SUM(sa.qty)            AS total_qty
       FROM sales_activity sa
       WHERE sa.report_year = $1
         AND sa.month_num = $2
         ${extraWhere}
         AND sa.customer_code NOT IN (
           SELECT DISTINCT customer_code
           FROM sales_activity
           WHERE report_year = $1
             AND month_num < $2
         )
       GROUP BY sa.customer_code
       ORDER BY invoice_count DESC`,
      filterParams
    );

    // Find which of these "new" customers have invoices in PREVIOUS years
    // Uses the invoices table (CustomerBalanceDues) — the authoritative source of invoice history
    const newCodes = result.rows.map(r => r.customer_code);
    let returningSet = new Set();
    if (newCodes.length > 0) {
      const retRes = await pool.query(
        `SELECT DISTINCT customer_id
         FROM invoices
         WHERE customer_id = ANY($1) AND year < $2`,
        [newCodes, year]
      );
      returningSet = new Set(retRes.rows.map(r => r.customer_id));
    }

    res.json({
      currentMonth,
      customers: result.rows.map(r => ({
        customer_code:  r.customer_code,
        customer_name:  r.customer_name,
        branch_name:    r.branch_name,
        salesrep_name:  r.salesrep_name,
        invoice_count:  parseInt(r.invoice_count, 10),
        total_qty:      parseInt(r.total_qty, 10) || 0,
        is_returning:   returningSet.has(r.customer_code),
      })),
    });

  } catch (err) {
    console.error('[SalesActivity] new-customers error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /meta ────────────────────────────────────────────────
router.get('/meta', verifyToken, applyRegionFilter, async (req, res) => {
  const year   = parseInt(req.query.year || '2026', 10);
  let   branch = (req.query.branch || '').trim() || null;
  if (req.regionFilter) branch = await resolveRegionBranch(req.regionFilter);

  try {
    // Reps are filtered by branch when a branch is selected
    const repQuery = branch
      ? pool.query(
          `SELECT DISTINCT salesrep_name FROM sales_activity
           WHERE report_year = $1 AND branch_name = $2 AND salesrep_name IS NOT NULL
           ORDER BY salesrep_name`,
          [year, branch]
        )
      : pool.query(
          `SELECT DISTINCT salesrep_name FROM sales_activity
           WHERE report_year = $1 AND salesrep_name IS NOT NULL
           ORDER BY salesrep_name`,
          [year]
        );

    const branchQuery = req.regionFilter
      ? pool.query(
          `SELECT DISTINCT branch_name FROM sales_activity
           WHERE report_year = $1 AND branch_name = $2 AND branch_name IS NOT NULL
           ORDER BY branch_name`,
          [year, branch]
        )
      : pool.query(
          `SELECT DISTINCT branch_name FROM sales_activity
           WHERE report_year = $1 AND branch_name IS NOT NULL
           ORDER BY branch_name`,
          [year]
        );

    const [branchRes, repRes, yearsRes] = await Promise.all([
      branchQuery,
      repQuery,
      pool.query(
        `SELECT DISTINCT report_year FROM sales_activity ORDER BY report_year DESC`
      ),
    ]);

    res.json({
      branches: branchRes.rows.map(r => r.branch_name),
      reps:     repRes.rows.map(r => r.salesrep_name),
      years:    yearsRes.rows.map(r => parseInt(r.report_year, 10)),
    });
  } catch (err) {
    console.error('[SalesActivity] meta error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /category-stats ──────────────────────────────────────
// Returns customer-count per category for current month AND previous month
router.get('/category-stats', verifyToken, applyRegionFilter, async (req, res) => {
  const year   = parseInt(req.query.year || '2026', 10);
  let   branch = (req.query.branch || '').trim() || null;
  const rep    = (req.query.rep    || '').trim() || null;
  if (req.regionFilter) branch = await resolveRegionBranch(req.regionFilter);

  try {
    // Resolve max and prev months
    const maxRes = await pool.query(
      `SELECT COALESCE(MAX(month_num), 0) AS max_month FROM sales_activity WHERE report_year = $1`,
      [year]
    );
    const maxMonth  = parseInt(maxRes.rows[0].max_month, 10);
    const prevMonth = maxMonth > 1 ? maxMonth - 1 : null;

    // filter clause starts at $3 (after $1=year, $2=month)
    const { sql: filterSql, vals: filterVals } = filterClause(branch, rep, 3);

    function buildCats(rows) {
      const total = rows.reduce((s, r) => s + parseInt(r.customer_count, 10), 0);
      const categories = rows.map(r => ({
        category: r.category,
        count:    parseInt(r.customer_count, 10),
        pct:      total > 0 ? Math.round((parseInt(r.customer_count, 10) / total) * 1000) / 10 : 0,
      }));
      return { categories, total };
    }

    const catQuery = `
      SELECT
        COALESCE(NULLIF(TRIM(category_name), ''), 'غير محدد') AS category,
        COUNT(DISTINCT customer_code) AS customer_count
      FROM sales_activity
      WHERE report_year = $1 AND month_num = $2${filterSql}
      GROUP BY COALESCE(NULLIF(TRIM(category_name), ''), 'غير محدد')
      ORDER BY customer_count DESC`;

    const [curRes, prevRes] = await Promise.all([
      maxMonth
        ? pool.query(catQuery, [year, maxMonth,  ...filterVals])
        : Promise.resolve({ rows: [] }),
      prevMonth
        ? pool.query(catQuery, [year, prevMonth, ...filterVals])
        : Promise.resolve({ rows: [] }),
    ]);

    res.json({
      current: { month: maxMonth,  ...buildCats(curRes.rows)  },
      prev:    { month: prevMonth, ...buildCats(prevRes.rows) },
    });
  } catch (err) {
    console.error('[SalesActivity] category-stats error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── PUT /note ────────────────────────────────────────────────
router.put('/note', verifyToken, async (req, res) => {
  const { customer_code, note_text } = req.body;
  if (!customer_code) return res.status(400).json({ error: 'customer_code مطلوب' });

  const text = (note_text || '').trim();

  try {
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');

      // Upsert current note
      await dbClient.query(
        `INSERT INTO sales_activity_notes (customer_code, note_text, updated_at, updated_by)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (customer_code) DO UPDATE SET
           note_text  = EXCLUDED.note_text,
           updated_at = NOW(),
           updated_by = EXCLUDED.updated_by`,
        [customer_code, text, req.user.id]
      );

      // Always append to history (immutable record — never deleted)
      const userRes = await dbClient.query(
        `SELECT name FROM users WHERE id = $1`, [req.user.id]
      );
      const username = userRes.rows[0]?.name || 'مجهول';

      await dbClient.query(
        `INSERT INTO sales_activity_notes_history
           (customer_code, note_text, saved_at, saved_by, saved_by_name)
         VALUES ($1, $2, NOW(), $3, $4)`,
        [customer_code, text, req.user.id, username]
      );

      await dbClient.query('COMMIT');
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[SalesActivity] note error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /note-history/:customerCode ──────────────────────────
router.get('/note-history/:customerCode', verifyToken, async (req, res) => {
  const { customerCode } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, note_text, saved_at, saved_by_name
       FROM sales_activity_notes_history
       WHERE customer_code = $1
       ORDER BY saved_at DESC
       LIMIT 50`,
      [customerCode]
    );
    res.json({ history: result.rows });
  } catch (err) {
    console.error('[SalesActivity] note-history error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /export ──────────────────────────────────────────────
router.get('/export', verifyToken, applyRegionFilter, async (req, res) => {
  const year   = parseInt(req.query.year || '2026', 10);
  let   branch = (req.query.branch || '').trim() || null;
  const rep    = (req.query.rep    || '').trim() || null;
  if (req.regionFilter) branch = await resolveRegionBranch(req.regionFilter);
  // tab: 'report' (default) | 'new' | 'stopped'
  const tab    = (req.query.tab || 'report').trim();

  const MONTH_AR = {
    1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
    7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
  };

  try {
    /* ── Get max month (shared by all tabs) ── */
    const maxMonthRes = await pool.query(
      `SELECT COALESCE(MAX(month_num), 0) AS max_month FROM sales_activity WHERE report_year = $1`,
      [year]
    );
    const maxMonth  = parseInt(maxMonthRes.rows[0].max_month, 10);
    const prevMonth = maxMonth > 1 ? maxMonth - 1 : null;

    let sheetRows = [];
    let sheetName = 'تقرير العملاء';
    let filename  = `sales_report_${year}.xlsx`;

    /* ════════════════════════════════════════════
       TAB: العملاء الجدد
       ════════════════════════════════════════════ */
    if (tab === 'new') {
      sheetName = 'العملاء الجدد';
      filename  = `new_customers_month${maxMonth}_${year}.xlsx`;

      if (!maxMonth) {
        sheetRows = [['لا توجد بيانات']];
      } else {
        const filterConds  = [];
        const filterParams = [year, maxMonth];
        let p = 3;
        if (branch) { filterConds.push(`sa.branch_name = $${p++}`);    filterParams.push(branch); }
        if (rep)    { filterConds.push(`sa.salesrep_name = $${p++}`);  filterParams.push(rep); }
        const extraWhere = filterConds.length ? ' AND ' + filterConds.join(' AND ') : '';

        const result = await pool.query(
          `SELECT
             sa.customer_code,
             MAX(sa.customer_name)  AS customer_name,
             MAX(sa.branch_name)    AS branch_name,
             MAX(sa.salesrep_name)  AS salesrep_name,
             MAX(sa.category_name)  AS category_name,
             COUNT(*)               AS invoice_count
           FROM sales_activity sa
           WHERE sa.report_year = $1 AND sa.month_num = $2${extraWhere}
             AND sa.customer_code NOT IN (
               SELECT DISTINCT customer_code FROM sales_activity
               WHERE report_year = $1 AND month_num < $2
             )
           GROUP BY sa.customer_code
           ORDER BY invoice_count DESC`,
          filterParams
        );

        // Check which are returning from previous years via invoices table (CustomerBalanceDues)
        const expCodes = result.rows.map(r => r.customer_code);
        let expReturning = new Set();
        if (expCodes.length > 0) {
          const retRes = await pool.query(
            `SELECT DISTINCT customer_id
             FROM invoices
             WHERE customer_id = ANY($1) AND year < $2`,
            [expCodes, year]
          );
          expReturning = new Set(retRes.rows.map(r => r.customer_id));
        }

        sheetRows = [
          ['#', 'اسم العميل', 'كود العميل', 'المنطقة', 'المندوب', 'التصنيف',
           `فواتير ${MONTH_AR[maxMonth]}`, 'الحالة'],
          ...result.rows.map((r, i) => [
            i + 1,
            r.customer_name,
            r.customer_code,
            r.branch_name   || '',
            r.salesrep_name || '',
            r.category_name || '',
            parseInt(r.invoice_count, 10),
            expReturning.has(r.customer_code) ? 'عميل عائد من عام سابق' : 'جديد',
          ]),
        ];
      }

    /* ════════════════════════════════════════════
       TAB: المتوقفون
       ════════════════════════════════════════════ */
    } else if (tab === 'stopped') {
      sheetName = 'المتوقفون';
      filename  = `stopped_customers_month${maxMonth}_${year}.xlsx`;

      if (!maxMonth || !prevMonth) {
        sheetRows = [['لا توجد بيانات — يلزم وجود شهرين على الأقل']];
      } else {
        const f = filterClause(branch, rep, 4);
        const result = await pool.query(
          `SELECT
             sa.customer_code,
             MAX(sa.customer_name)  AS customer_name,
             MAX(sa.branch_name)    AS branch_name,
             MAX(sa.salesrep_name)  AS salesrep_name,
             MAX(sa.category_name)  AS category_name,
             COUNT(*)               AS invoice_count
           FROM sales_activity sa
           WHERE sa.report_year = $1 AND sa.month_num = $2${f.sql}
             AND sa.customer_code NOT IN (
               SELECT DISTINCT customer_code FROM sales_activity
               WHERE report_year = $1 AND month_num = $3
             )
           GROUP BY sa.customer_code
           ORDER BY invoice_count DESC`,
          [year, prevMonth, maxMonth, ...f.vals]
        );

        sheetRows = [
          ['#', 'اسم العميل', 'كود العميل', 'المنطقة', 'المندوب', 'التصنيف',
           `فواتير ${MONTH_AR[prevMonth]}`, 'الحالة'],
          ...result.rows.map((r, i) => [
            i + 1,
            r.customer_name,
            r.customer_code,
            r.branch_name   || '',
            r.salesrep_name || '',
            r.category_name || '',
            parseInt(r.invoice_count, 10),
            '⛔ متوقف',
          ]),
        ];
      }

    /* ════════════════════════════════════════════
       TAB: التقرير الشهري (default)
       ════════════════════════════════════════════ */
    } else {
      filename = `sales_report_${year}.xlsx`;

      const conditions = ['sa.report_year = $1'];
      const params     = [year];
      let   p          = 2;
      if (branch) { conditions.push(`sa.branch_name = $${p++}`);   params.push(branch); }
      if (rep)    { conditions.push(`sa.salesrep_name = $${p++}`); params.push(rep); }
      const where = conditions.join(' AND ');

      const monthsRes = await pool.query(
        `SELECT DISTINCT month_num FROM sales_activity WHERE report_year = $1 ORDER BY month_num`,
        [year]
      );
      const months = monthsRes.rows.map(r => parseInt(r.month_num, 10));

      const dataRes = await pool.query(
        `SELECT
           sa.customer_code,
           MAX(sa.customer_name)   AS customer_name,
           MAX(sa.branch_name)     AS branch_name,
           MAX(sa.salesrep_name)   AS salesrep_name,
           MAX(sa.category_name)   AS category_name,
           sa.month_num,
           COUNT(*)                AS invoice_count
         FROM sales_activity sa
         WHERE ${where}
         GROUP BY sa.customer_code, sa.month_num`,
        params
      );

      const notesRes = await pool.query(`SELECT customer_code, note_text FROM sales_activity_notes`);
      const notesMap = {};
      for (const n of notesRes.rows) notesMap[n.customer_code] = n.note_text;

      const custMap = new Map();
      for (const row of dataRes.rows) {
        const code = row.customer_code;
        if (!custMap.has(code)) {
          custMap.set(code, {
            customer_code: code, customer_name: row.customer_name,
            branch_name: row.branch_name, salesrep_name: row.salesrep_name,
            category_name: row.category_name, months: {}, total: 0,
          });
        }
        const c = custMap.get(code);
        const mn = parseInt(row.month_num, 10);
        c.months[mn] = parseInt(row.invoice_count, 10);
        c.total += parseInt(row.invoice_count, 10);
      }

      const customers = Array.from(custMap.values()).map(c => ({
        ...c,
        active_current: Boolean(maxMonth && c.months[maxMonth] > 0),
        note: notesMap[c.customer_code] || '',
      }));
      customers.sort((a, b) => {
        if (a.active_current !== b.active_current) return a.active_current ? 1 : -1;
        return b.total - a.total;
      });

      sheetRows = [
        ['#', 'اسم العميل', 'كود العميل', 'المنطقة', 'المندوب', 'التصنيف',
         ...months.map(m => MONTH_AR[m] || m), 'الإجمالي', 'الحالة', 'ملاحظات'],
        ...customers.map((c, i) => [
          i + 1, c.customer_name, c.customer_code,
          c.branch_name || '', c.salesrep_name || '', c.category_name || '',
          ...months.map(m => c.months[m] || 0),
          c.total,
          c.active_current ? 'نشط' : 'غير نشط',
          c.note,
        ]),
      ];
    }

    /* ── Write workbook ── */
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet(sheetRows);
    xlsx.utils.book_append_sheet(wb, ws, sheetName);

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);

  } catch (err) {
    console.error('[SalesActivity] export error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
