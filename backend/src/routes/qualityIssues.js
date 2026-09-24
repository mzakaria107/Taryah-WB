/**
 * qualityIssues.js — /api/quality-issues/*
 *
 * Tracks the NetSuite "Quality Issues Quantity and Cost" report: priced
 * quality-adjustment line items (qty + cost) per region/item, uploaded
 * periodically as an Excel export. Distinct from sales_activity.bad_return_qty
 * (route-level returns) — this is warehouse/QC-level damage with a cost figure.
 *
 * Upload is additive/idempotent (UPSERT on document_number+item+date), not a
 * TRUNCATE-replace, because each periodic export re-covers overlapping date
 * ranges and the user re-uploads the same recurring report going forward.
 */

const express = require('express');
const xlsx    = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const pool    = require('../db/pool');
const upload  = require('../middleware/upload');
const { verifyToken, applyRegionFilter, requirePagePermission } = require('../middleware/auth');

const router = express.Router();

const MONTH_AR = {
  1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
  7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
};

/* Same Arabic region names used across the dashboard (regions.name_ar/name_en
   actually store the English identifier — see currentStock.js). Sorted
   longest-first so "المدينة المنورة" is tried before any shorter prefix,
   and matched with startsWith() because the report's "Location: Name" cell
   appends a free-text warehouse suffix inconsistently
   (e.g. "شقرا منتج تام - ميرنا" vs "الرياض - منتج تام ميرنا"). */
const REGION_KEY_BY_AR_NAME = {
  'الرياض':          'Riyadh',
  'القصيم':          'Al-Qassem',
  'شقرا':            'Shaqraa',
  'الدوادمي':        'Al Duwadmi',
  'حائل':            'Hael',
  'عرعر':            'Arar',
  'المدينة المنورة': 'Madinah',
  'حفر الباطن':      'Hafir El Batin',
  'الدمام':          'Dammam',
  'جدة':             'Jeddah',
};
const AR_NAMES_BY_LENGTH = Object.keys(REGION_KEY_BY_AR_NAME).sort((a, b) => b.length - a.length);

function matchRegionArName(locationRaw) {
  const s = String(locationRaw || '').trim();
  return AR_NAMES_BY_LENGTH.find(name => s.startsWith(name)) || null;
}

let _regionIdCache = null;
async function regionIdByKey() {
  if (_regionIdCache) return _regionIdCache;
  const r = await pool.query('SELECT id, name_ar FROM regions');
  _regionIdCache = {};
  r.rows.forEach(row => { _regionIdCache[row.name_ar] = row.id; });
  setTimeout(() => { _regionIdCache = null; }, 10 * 60 * 1000).unref?.();
  return _regionIdCache;
}

/** "18/3/2026" (D/M/YYYY, as exported by NetSuite) → 'YYYY-MM-DD' */
function parseExportDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function safeNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/* ── Region filter helper (region_manager scoping) ──────────── */
function applyScope(req, conditions, params) {
  if (req.regionFilter?.length) {
    params.push(req.regionFilter);
    conditions.push(`qi.region_id = ANY($${params.length}::int[])`);
  }
}

// ─────────────────────────────────────────────────────────────
// POST /api/quality-issues/upload
// Accepts "QualityIssuesQuantityandCost(...).xls" (NetSuite SpreadsheetML
// export). Header row is preceded by report-title rows, so the header is
// located dynamically rather than assumed at row 0.
// ─────────────────────────────────────────────────────────────
router.post(
  '/upload',
  verifyToken,
  requirePagePermission('quality_issues', 2),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });

    const batchId = uuidv4();
    try {
      await pool.query(
        `INSERT INTO upload_batches (id, file_name, file_type, uploaded_by, status)
         VALUES ($1, $2, 'quality_issues', $3, 'processing')`,
        [batchId, req.file.originalname, req.user.id]
      );

      const workbook  = xlsx.readFile(req.file.path, { cellDates: false });
      const sheetName = workbook.SheetNames[0];
      const sheet     = workbook.Sheets[sheetName];

      // Locate the header row by finding the cell that reads "Location: Name"
      // — the report ships with 6 title/blank rows above it.
      const grid = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const headerRowIdx = grid.findIndex(row => row.includes('Location: Name'));
      if (headerRowIdx === -1) {
        throw new Error('تعذر التعرف على تنسيق الملف — لم يتم العثور على عمود "Location: Name"');
      }

      const rawRows = xlsx.utils.sheet_to_json(sheet, { range: headerRowIdx, defval: '' });
      const regionIds = await regionIdByKey();

      const parsedRows = [];
      const errors = [];

      for (let i = 0; i < rawRows.length; i++) {
        const row = rawRows[i];
        const location = String(row['Location: Name'] || '').trim();
        if (!location || location === 'Total') continue; // trailing totals row

        const documentNumber = String(row['Document Number'] || '').trim();
        const itemName        = String(row['Item'] || '').trim();
        const issueDate        = parseExportDate(row['Date']);
        if (!documentNumber || !itemName || !issueDate) {
          errors.push({ row: headerRowIdx + i + 2, error: 'بيانات ناقصة (رقم المستند / الصنف / التاريخ)' });
          continue;
        }

        const regionArName = matchRegionArName(location);
        const regionKey     = regionArName ? REGION_KEY_BY_AR_NAME[regionArName] : null;
        const regionId       = regionKey ? (regionIds[regionKey] ?? null) : null;

        parsedRows.push({
          id: uuidv4(),
          region_id: regionId,
          region_name_ar: regionArName || location,
          location_raw: location,
          item_type: String(row['Item Type'] || '').trim() || null,
          item_name: itemName,
          issue_date: issueDate,
          document_number: documentNumber,
          memo: String(row['Memo'] || '').trim() || null,
          quantity: safeNum(row['Quantity']),
          pct_of_quantity: safeNum(row['% of Quantity']),
          unit_value: safeNum(row['Unit Value']),
          total_cost: safeNum(row['Total Cost']),
          upload_batch_id: batchId,
        });
      }

      if (!parsedRows.length) {
        await pool.query(
          `UPDATE upload_batches SET status='failed', error_message=$1 WHERE id=$2`,
          ['لا توجد صفوف صالحة في الملف', batchId]
        );
        return res.status(400).json({ error: 'لا توجد صفوف صالحة في الملف' });
      }

      let upserted = 0;
      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');
        for (const r of parsedRows) {
          await dbClient.query(
            `INSERT INTO quality_issues
               (id, region_id, region_name_ar, location_raw, item_type, item_name,
                issue_date, document_number, memo, quantity, pct_of_quantity,
                unit_value, total_cost, upload_batch_id, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
             ON CONFLICT (document_number, item_name, issue_date) DO UPDATE SET
               region_id = EXCLUDED.region_id,
               region_name_ar = EXCLUDED.region_name_ar,
               location_raw = EXCLUDED.location_raw,
               item_type = EXCLUDED.item_type,
               memo = EXCLUDED.memo,
               quantity = EXCLUDED.quantity,
               pct_of_quantity = EXCLUDED.pct_of_quantity,
               unit_value = EXCLUDED.unit_value,
               total_cost = EXCLUDED.total_cost,
               upload_batch_id = EXCLUDED.upload_batch_id,
               updated_at = NOW()`,
            [r.id, r.region_id, r.region_name_ar, r.location_raw, r.item_type, r.item_name,
             r.issue_date, r.document_number, r.memo, r.quantity, r.pct_of_quantity,
             r.unit_value, r.total_cost, r.upload_batch_id]
          );
          upserted++;
        }
        await dbClient.query('COMMIT');
      } catch (dbErr) {
        await dbClient.query('ROLLBACK');
        throw dbErr;
      } finally {
        dbClient.release();
      }

      await pool.query(
        `UPDATE upload_batches SET status='success', row_count=$1 WHERE id=$2`,
        [upserted, batchId]
      );

      res.json({
        success: true,
        rowsProcessed: upserted,
        rowsSkipped: errors.length,
        errors: errors.slice(0, 50),
        batchId,
      });
    } catch (err) {
      console.error('[QualityIssues] Upload error:', err.message);
      await pool.query(
        `UPDATE upload_batches SET status='failed', error_message=$1 WHERE id=$2`,
        [err.message.substring(0, 500), batchId]
      );
      res.status(500).json({ error: 'فشل في معالجة الملف: ' + err.message });
    }
  }
);

/* ── NetSuite live web query — "Quality Issues Quantity and Cost" ──
   Same report as the manual .xls upload above, fetched live instead. Its
   HTML export carries a DIFFERENT shape than the upload file:
     - date is "YYYY-MM-DD HH:MM:SS", not the upload's "D/M/YYYY"
     - numeric cells are unevaluated spreadsheet formulas, e.g. "=-2" or
       "=2.12066666666666666666666666666666666667E00" — strip the leading
       "=" and parseFloat (E-notation parses fine as-is)
     - no "% of Quantity" or "Total Cost" column; Total Cost is derived as
       quantity × unit_value here (both already carry the report's sign,
       so this lands on the same negative-means-loss convention the
       upload's own Total Cost column used — every aggregate query already
       wraps this field in ABS(), so the sign only has to be consistent,
       not positive)
     - a stray leading report-grouping row with an empty Document Number,
       skipped by the same "row has no document number" guard as the
       upload parser uses for its trailing Total row. */
const QI_WEBQUERY_URL =
  'https://9275514.app.netsuite.com/app/reporting/webquery.nl' +
  '?compid=9275514&entity=64075&email=nationalsales@taryahpoultry.com.sa' +
  '&role=1225&cr=545&hash=AAEJ7tMQwIAURmVBk5jqhDaE0LFU33vT_p8bCK-Bpy9dg5TX2FY';

function qiParseHTMLTable(html) {
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const clean = s =>
    s.replace(/<[^>]+>/g, '')
     .replace(/&nbsp;/g, ' ')
     .replace(/&amp;/g, '&')
     .replace(/&lt;/g, '<')
     .replace(/&gt;/g, '>')
     .replace(/&#\d+;/g, '')
     .trim();

  const extractCells = trHtml => {
    const cells = [];
    const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let m;
    while ((m = re.exec(trHtml)) !== null) cells.push(clean(m[1]));
    return cells;
  };

  const allTrs = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) allTrs.push(m[1]);
  if (!allTrs.length) return { headers: [], rows: [] };

  const headers = extractCells(allTrs[0]);
  const rows = [];
  for (let i = 1; i < allTrs.length; i++) {
    const cells = extractCells(allTrs[i]);
    if (!cells.length || cells.every(c => c === '')) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = cells[idx] ?? ''; });
    rows.push(row);
  }
  return { headers, rows };
}

/** "2026-01-25 00:00:00" → 'YYYY-MM-DD' */
function parseWebqueryDate(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** "=-2" / "=2.12E00" / "" → number|null — strips the leading "=" a raw
    spreadsheet-formula export cell carries. */
function safeFormulaNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/^=/, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────
// POST /api/quality-issues/sync-netsuite — fetch + UPSERT live, same
// dedup key (document_number, item_name, issue_date) as the file upload,
// so a NetSuite sync and a manual upload of the same report never
// duplicate rows.
// ─────────────────────────────────────────────────────────────
router.post(
  '/sync-netsuite',
  verifyToken,
  requirePagePermission('quality_issues', 2),
  async (req, res) => {
    const batchId = uuidv4();
    try {
      await pool.query(
        `INSERT INTO upload_batches (id, file_name, file_type, uploaded_by, status)
         VALUES ($1, 'NetSuite Sync', 'quality_issues', $2, 'processing')`,
        [batchId, req.user.id]
      );

      const netRes = await fetch(QI_WEBQUERY_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'text/html,text/csv,*/*',
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!netRes.ok) throw new Error(`NetSuite HTTP ${netRes.status}`);
      const html = await netRes.text();

      const { rows: rawRows } = qiParseHTMLTable(html);
      const regionIds = await regionIdByKey();

      const parsedRows = [];
      const errors = [];

      for (let i = 0; i < rawRows.length; i++) {
        const row = rawRows[i];
        const location = String(row['Location: Name'] || '').trim();
        const documentNumber = String(row['Document Number'] || '').trim();
        const itemName = String(row['Item'] || '').trim();
        const issueDate = parseWebqueryDate(row['Date']);
        if (!documentNumber || !itemName || !issueDate) {
          errors.push({ row: i + 2, error: 'بيانات ناقصة (رقم المستند / الصنف / التاريخ)' });
          continue;
        }

        const regionArName = matchRegionArName(location);
        const regionKey    = regionArName ? REGION_KEY_BY_AR_NAME[regionArName] : null;
        const regionId      = regionKey ? (regionIds[regionKey] ?? null) : null;

        const quantity  = safeFormulaNum(row['Quantity']);
        const unitValue = safeFormulaNum(row['Unit Value']);
        const totalCost = quantity != null && unitValue != null ? quantity * unitValue : null;

        parsedRows.push({
          id: uuidv4(),
          region_id: regionId,
          region_name_ar: regionArName || location,
          location_raw: location,
          item_type: String(row['Item Type'] || '').trim() || null,
          item_name: itemName,
          issue_date: issueDate,
          document_number: documentNumber,
          memo: String(row['Memo'] || '').trim() || null,
          quantity,
          pct_of_quantity: null,
          unit_value: unitValue,
          total_cost: totalCost,
          upload_batch_id: batchId,
        });
      }

      if (!parsedRows.length) {
        await pool.query(
          `UPDATE upload_batches SET status='failed', error_message=$1 WHERE id=$2`,
          ['لا توجد صفوف صالحة في استجابة NetSuite', batchId]
        );
        return res.status(502).json({ error: 'لا توجد صفوف صالحة في استجابة NetSuite' });
      }

      let upserted = 0;
      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');
        for (const r of parsedRows) {
          await dbClient.query(
            `INSERT INTO quality_issues
               (id, region_id, region_name_ar, location_raw, item_type, item_name,
                issue_date, document_number, memo, quantity, pct_of_quantity,
                unit_value, total_cost, upload_batch_id, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
             ON CONFLICT (document_number, item_name, issue_date) DO UPDATE SET
               region_id = EXCLUDED.region_id,
               region_name_ar = EXCLUDED.region_name_ar,
               location_raw = EXCLUDED.location_raw,
               item_type = EXCLUDED.item_type,
               memo = EXCLUDED.memo,
               quantity = EXCLUDED.quantity,
               pct_of_quantity = EXCLUDED.pct_of_quantity,
               unit_value = EXCLUDED.unit_value,
               total_cost = EXCLUDED.total_cost,
               upload_batch_id = EXCLUDED.upload_batch_id,
               updated_at = NOW()`,
            [r.id, r.region_id, r.region_name_ar, r.location_raw, r.item_type, r.item_name,
             r.issue_date, r.document_number, r.memo, r.quantity, r.pct_of_quantity,
             r.unit_value, r.total_cost, r.upload_batch_id]
          );
          upserted++;
        }
        await dbClient.query('COMMIT');
      } catch (dbErr) {
        await dbClient.query('ROLLBACK');
        throw dbErr;
      } finally {
        dbClient.release();
      }

      await pool.query(
        `UPDATE upload_batches SET status='success', row_count=$1 WHERE id=$2`,
        [upserted, batchId]
      );

      res.json({
        success: true,
        rowsProcessed: upserted,
        rowsSkipped: errors.length,
        errors: errors.slice(0, 50),
        batchId,
      });
    } catch (err) {
      console.error('[QualityIssues] NetSuite sync error:', err.message);
      await pool.query(
        `UPDATE upload_batches SET status='failed', error_message=$1 WHERE id=$2`,
        [err.message.substring(0, 500), batchId]
      );
      res.status(502).json({ error: 'فشل جلب البيانات من NetSuite: ' + err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// GET /api/quality-issues/filters — regions + item types + date bounds
// ─────────────────────────────────────────────────────────────
router.get('/filters', verifyToken, applyRegionFilter, requirePagePermission('quality_issues', 1), async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    applyScope(req, conditions, params);
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [regionsRes, itemTypesRes, boundsRes] = await Promise.all([
      pool.query(`
        SELECT DISTINCT r.id, r.name_ar
        FROM quality_issues qi
        JOIN regions r ON r.id = qi.region_id
        ${where}
        ORDER BY r.name_ar
      `, params),
      pool.query(`
        SELECT DISTINCT item_type FROM quality_issues qi
        ${where ? where + ' AND item_type IS NOT NULL' : 'WHERE item_type IS NOT NULL'}
        ORDER BY item_type
      `, params),
      pool.query(`SELECT MIN(issue_date) AS min_date, MAX(issue_date) AS max_date FROM quality_issues qi ${where}`, params),
    ]);

    res.json({
      regions: regionsRes.rows,
      item_types: itemTypesRes.rows.map(r => r.item_type),
      min_date: boundsRes.rows[0]?.min_date || null,
      max_date: boundsRes.rows[0]?.max_date || null,
    });
  } catch (err) {
    console.error('[QualityIssues] filters error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/quality-issues/summary?region_id=&item_type=&from=&to=
// Monthly trend per region + totals + by-item breakdown.
// ─────────────────────────────────────────────────────────────
router.get('/summary', verifyToken, applyRegionFilter, requirePagePermission('quality_issues', 1), async (req, res) => {
  try {
    const { region_id, item_type, from, to } = req.query;
    const conditions = [];
    const params = [];
    applyScope(req, conditions, params);

    if (region_id) { params.push(region_id); conditions.push(`qi.region_id = $${params.length}`); }
    if (item_type) { params.push(item_type); conditions.push(`qi.item_type = $${params.length}`); }
    if (from)      { params.push(from);      conditions.push(`qi.issue_date >= $${params.length}`); }
    if (to)        { params.push(to);        conditions.push(`qi.issue_date <= $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [monthlyRes, byRegionRes, byItemRes, totalsRes, itemMonthlyRes] = await Promise.all([
      // Monthly trend, split per region so the frontend can draw one line per region.
      pool.query(`
        SELECT
          EXTRACT(YEAR FROM qi.issue_date)::int  AS year,
          EXTRACT(MONTH FROM qi.issue_date)::int AS month,
          qi.region_id,
          COALESCE(r.name_ar, qi.region_name_ar) AS region_name,
          COUNT(*)::int                    AS issue_count,
          COALESCE(SUM(ABS(qi.quantity)),0)::numeric   AS quantity,
          COALESCE(SUM(ABS(qi.total_cost)),0)::numeric AS total_cost
        FROM quality_issues qi
        LEFT JOIN regions r ON r.id = qi.region_id
        ${where}
        GROUP BY 1,2,3,4
        ORDER BY 1,2
      `, params),
      pool.query(`
        SELECT qi.region_id, COALESCE(r.name_ar, qi.region_name_ar) AS region_name,
          COUNT(*)::int AS issue_count,
          COALESCE(SUM(ABS(qi.quantity)),0)::numeric   AS quantity,
          COALESCE(SUM(ABS(qi.total_cost)),0)::numeric AS total_cost
        FROM quality_issues qi
        LEFT JOIN regions r ON r.id = qi.region_id
        ${where}
        GROUP BY 1,2
        ORDER BY total_cost DESC
      `, params),
      pool.query(`
        SELECT qi.item_name,
          COUNT(*)::int AS issue_count,
          COALESCE(SUM(ABS(qi.quantity)),0)::numeric   AS quantity,
          COALESCE(SUM(ABS(qi.total_cost)),0)::numeric AS total_cost
        FROM quality_issues qi
        ${where}
        GROUP BY 1
        ORDER BY total_cost DESC
        LIMIT 20
      `, params),
      pool.query(`
        SELECT COUNT(*)::int AS issue_count,
          COALESCE(SUM(ABS(qi.quantity)),0)::numeric   AS quantity,
          COALESCE(SUM(ABS(qi.total_cost)),0)::numeric AS total_cost,
          COUNT(DISTINCT qi.region_id)::int AS region_count
        FROM quality_issues qi
        ${where}
      `, params),
      // Per region × item × month — powers the expandable per-item detail
      // rows under each region in the trend matrix.
      pool.query(`
        SELECT
          EXTRACT(YEAR FROM qi.issue_date)::int  AS year,
          EXTRACT(MONTH FROM qi.issue_date)::int AS month,
          qi.region_id,
          COALESCE(r.name_ar, qi.region_name_ar) AS region_name,
          qi.item_name,
          COALESCE(SUM(ABS(qi.quantity)),0)::numeric   AS quantity,
          COALESCE(SUM(ABS(qi.total_cost)),0)::numeric AS total_cost
        FROM quality_issues qi
        LEFT JOIN regions r ON r.id = qi.region_id
        ${where}
        GROUP BY 1,2,3,4,5
        ORDER BY 1,2
      `, params),
    ]);

    const monthly = monthlyRes.rows.map(r => ({
      ...r,
      month_name: `${MONTH_AR[r.month]} ${r.year}`,
    }));

    res.json({
      monthly,
      by_region: byRegionRes.rows,
      by_item: byItemRes.rows,
      item_monthly: itemMonthlyRes.rows,
      totals: totalsRes.rows[0],
    });
  } catch (err) {
    console.error('[QualityIssues] summary error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/quality-issues — filtered line-item list (paginated)
// ─────────────────────────────────────────────────────────────
router.get('/', verifyToken, applyRegionFilter, requirePagePermission('quality_issues', 1), async (req, res) => {
  try {
    const { region_id, item_type, from, to, page = 1, page_size = 50 } = req.query;
    const conditions = [];
    const params = [];
    applyScope(req, conditions, params);

    if (region_id) { params.push(region_id); conditions.push(`qi.region_id = $${params.length}`); }
    if (item_type) { params.push(item_type); conditions.push(`qi.item_type = $${params.length}`); }
    if (from)      { params.push(from);      conditions.push(`qi.issue_date >= $${params.length}`); }
    if (to)        { params.push(to);        conditions.push(`qi.issue_date <= $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit  = Math.min(500, parseInt(page_size, 10) || 50);
    const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limit;

    params.push(limit);
    params.push(offset);

    const [rowsRes, countRes] = await Promise.all([
      pool.query(`
        SELECT qi.*, r.name_ar AS region_name
        FROM quality_issues qi
        LEFT JOIN regions r ON r.id = qi.region_id
        ${where}
        ORDER BY qi.issue_date DESC, qi.document_number DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params),
      pool.query(`SELECT COUNT(*)::int AS total FROM quality_issues qi ${where}`, params.slice(0, params.length - 2)),
    ]);

    res.json({ rows: rowsRes.rows, total: countRes.rows[0]?.total || 0 });
  } catch (err) {
    console.error('[QualityIssues] list error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
