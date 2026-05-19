/**
 * routes/fridges.js
 * Refrigerator (asset) tracking
 *
 * GET  /api/fridges                        — list (filters: status, region_id, search)
 * GET  /api/fridges/stats                  — counts by status + region
 * GET  /api/fridges/customer-lookup        — ?code=XX → fetch customer info from invoices
 * POST /api/fridges/import                 — bulk Excel import
 * POST /api/fridges                        — create
 * GET  /api/fridges/:id                    — detail + transfer history
 * PUT  /api/fridges/:id                    — update
 * DELETE /api/fridges/:id                  — delete
 * POST /api/fridges/:id/transfer           — repair | reassign
 */

const express = require('express');
const multer  = require('multer');
const xlsx    = require('xlsx');
const router  = express.Router();
const pool    = require('../db/pool');
const { verifyToken, requireRoles } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/* ── Roles allowed to write/modify fridges ─────────────────── */
const FRIDGE_EDITORS = ['super_admin', 'it_admin'];
const canEdit = requireRoles(...FRIDGE_EDITORS);

router.use(verifyToken);

/* ── Status labels ─────────────────────────────────────────── */
const STATUS_AR = {
  active:                'فعالة',
  inactive:              'غير فعالة',
  out_of_service:        'خارج الخدمة',
  damaged:               'تالفة',
  warehouse_maintenance: 'بالمستودع للصيانة',
  warehouse_new:         'بالمستودع جديدة',
  warehouse_used:        'بالمستودع مستعملة',
};

/* ── Customer lookup from invoices ─────────────────────────── */
router.get('/customer-lookup', async (req, res) => {
  const { code } = req.query;
  if (!code?.trim()) return res.json({ found: false });

  try {
    // Try invoices first (most complete)
    const invRes = await pool.query(
      `SELECT DISTINCT
         i.customer_id    AS customer_code,
         i.customer_name,
         i.route_id       AS route_code,
         i.region_id,
         r.name_ar        AS region_name,
         sa.salesrep_name
       FROM invoices i
       LEFT JOIN regions r  ON r.id = i.region_id
       LEFT JOIN LATERAL (
         SELECT salesrep_name FROM sales_activity
         WHERE customer_code = i.customer_id
         ORDER BY report_year DESC, month_num DESC LIMIT 1
       ) sa ON true
       WHERE i.customer_id = $1
       LIMIT 1`,
      [code.trim()]
    );

    if (invRes.rowCount) {
      const row = invRes.rows[0];
      return res.json({
        found:          true,
        customer_code:  row.customer_code,
        customer_name:  row.customer_name,
        region_id:      row.region_id,
        region_name:    row.region_name,
        route_code:     row.route_code,
        salesrep_name:  row.salesrep_name,
      });
    }

    // Fallback: sales_activity
    const saRes = await pool.query(
      `SELECT DISTINCT
         sa.customer_code,
         sa.customer_name,
         sa.salesrep_name,
         sa.branch_name,
         r.id AS region_id, r.name_ar AS region_name
       FROM sales_activity sa
       LEFT JOIN regions r ON r.name_ar = sa.branch_name OR r.name_en = sa.branch_name
       WHERE sa.customer_code = $1
       ORDER BY sa.customer_code LIMIT 1`,
      [code.trim()]
    );

    if (saRes.rowCount) {
      const row = saRes.rows[0];
      return res.json({
        found:         true,
        customer_code: row.customer_code,
        customer_name: row.customer_name,
        region_id:     row.region_id,
        region_name:   row.region_name,
        route_code:    null,
        salesrep_name: row.salesrep_name,
      });
    }

    res.json({ found: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Stats ─────────────────────────────────────────────────── */
router.get('/stats', async (req, res) => {
  try {
    const [statusRes, regionRes, multiRes, regionStatusRes] = await Promise.all([
      pool.query(
        `SELECT status, COUNT(*) AS cnt FROM fridges GROUP BY status ORDER BY cnt DESC`
      ),
      pool.query(
        `SELECT r.name_ar AS region, COUNT(*) AS cnt
         FROM fridges f
         LEFT JOIN regions r ON r.id = f.region_id
         GROUP BY r.name_ar ORDER BY cnt DESC`
      ),
      pool.query(
        `SELECT customer_code, customer_name, COUNT(*) AS fridge_count
         FROM fridges WHERE customer_code IS NOT NULL
         GROUP BY customer_code, customer_name
         HAVING COUNT(*) > 1
         ORDER BY fridge_count DESC`
      ),
      /* Per-region × per-status breakdown */
      pool.query(
        `SELECT
           COALESCE(r.name_ar, 'غير محدد') AS region_name,
           r.id                             AS region_id,
           f.status,
           COUNT(*)::int                   AS cnt
         FROM fridges f
         LEFT JOIN regions r ON r.id = f.region_id
         GROUP BY r.id, r.name_ar, f.status
         ORDER BY r.name_ar NULLS LAST, f.status`
      ),
    ]);

    /* Group region-status rows into a map: region_name → { status: cnt } */
    const regionMap = {};
    for (const row of regionStatusRes.rows) {
      const key = row.region_name;
      if (!regionMap[key]) {
        regionMap[key] = { region_name: key, region_id: row.region_id, by_status: {} };
      }
      regionMap[key].by_status[row.status] = row.cnt;
    }
    const by_region_status = Object.values(regionMap)
      .map(r => ({
        ...r,
        total:       Object.values(r.by_status).reduce((s, v) => s + v, 0),
      }))
      .sort((a, b) => b.total - a.total);

    res.json({
      by_status:              statusRes.rows,
      by_region:              regionRes.rows,
      by_region_status,
      multi_fridge_customers: multiRes.rows,
      total: statusRes.rows.reduce((s, r) => s + parseInt(r.cnt), 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Bulk Excel Import ─────────────────────────────────────── */
router.post('/import', canEdit, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم إرفاق ملف' });

  // ── Parse Excel ──────────────────────────────────────────────
  let rows;
  try {
    const wb   = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'تعذّر قراءة الملف — تأكد من أنه Excel صالح' });
  }

  if (!rows.length) return res.status(400).json({ error: 'الملف فارغ أو لا يحتوي على بيانات' });

  // ── Column name normalizer ────────────────────────────────────
  const ALIASES = {
    asset_number:    ['رقم الثلاجة','رقم الأصل','رقم الاصل','asset_number','Asset Number','AssetNumber','رقم ثلاجة'],
    customer_code:   ['رقم العميل','كود العميل','customer_code','Customer Code','CustomerCode','رقم_العميل'],
    customer_name:   ['اسم العميل','customer_name','Customer Name','CustomerName'],
    region_name:     ['المنطقة','اسم المنطقة','region','region_name','Branch','branch_name'],
    route_code:      ['رقم الخط','الخط','route_code','Route','RouteCode','route'],
    salesrep_name:   ['اسم المندوب','المندوب','salesrep_name','Salesrep','Sales Rep','مندوب المبيعات'],
    contract_number: ['رقم العقد','contract_number','Contract Number','ContractNumber'],
    contract_date:   ['تاريخ العقد','contract_date','Contract Date','ContractDate'],
    status:          ['الحالة','status','Status'],
    notes:           ['ملاحظات','notes','Notes','ملاحظة'],
  };

  // Build a map: header_in_file → canonical_field
  const headers = Object.keys(rows[0]);
  const colMap  = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      const found = headers.find(h => h.trim() === alias || h.trim().toLowerCase() === alias.toLowerCase());
      if (found) { colMap[found] = field; break; }
    }
  }

  // ── Valid status values ───────────────────────────────────────
  const VALID_STATUSES = new Set([
    'active','inactive','out_of_service','damaged',
    'warehouse_maintenance','warehouse_new','warehouse_used',
  ]);
  const STATUS_AR_TO_EN = {
    'فعالة': 'active',
    'غير فعالة': 'inactive',
    'خارج الخدمة': 'out_of_service',
    'تالفة': 'damaged',
    'بالمستودع للصيانة': 'warehouse_maintenance',
    'بالمستودع جديدة': 'warehouse_new',
    'بالمستودع مستعملة': 'warehouse_used',
  };

  // ── Customer info cache (avoid repeated DB lookups) ───────────
  const customerCache = {};
  async function lookupCustomer(code) {
    if (!code) return null;
    if (customerCache[code] !== undefined) return customerCache[code];
    try {
      const invRes = await pool.query(
        `SELECT DISTINCT
           i.customer_id AS customer_code,
           i.customer_name,
           i.route_id    AS route_code,
           i.region_id,
           r.name_ar     AS region_name,
           sa.salesrep_name
         FROM invoices i
         LEFT JOIN regions r ON r.id = i.region_id
         LEFT JOIN LATERAL (
           SELECT salesrep_name FROM sales_activity
           WHERE customer_code = i.customer_id
           ORDER BY report_year DESC, month_num DESC LIMIT 1
         ) sa ON true
         WHERE i.customer_id = $1
         LIMIT 1`,
        [code]
      );
      if (invRes.rowCount) { customerCache[code] = invRes.rows[0]; return invRes.rows[0]; }
      const saRes = await pool.query(
        `SELECT DISTINCT sa.customer_code, sa.customer_name, sa.salesrep_name,
           r.id AS region_id, r.name_ar AS region_name
         FROM sales_activity sa
         LEFT JOIN regions r ON r.name_ar = sa.branch_name OR r.name_en = sa.branch_name
         WHERE sa.customer_code = $1
         ORDER BY sa.customer_code LIMIT 1`,
        [code]
      );
      customerCache[code] = saRes.rowCount ? saRes.rows[0] : null;
    } catch { customerCache[code] = null; }
    return customerCache[code];
  }

  // ── Region name → id cache ────────────────────────────────────
  let regionMap = {};
  try {
    const rRes = await pool.query(`SELECT id, name_ar, name_en FROM regions`);
    rRes.rows.forEach(r => {
      if (r.name_ar) regionMap[r.name_ar.trim()] = r.id;
      if (r.name_en) regionMap[r.name_en.trim()] = r.id;
    });
  } catch (_) {}

  // ── Process rows ──────────────────────────────────────────────
  const inserted = [];
  const skipped  = [];
  const errors   = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const rowNum = i + 2; // +2 because Excel row 1 = header, data starts row 2

    // Map to canonical fields
    const mapped = {};
    for (const [rawCol, val] of Object.entries(raw)) {
      const field = colMap[rawCol];
      if (field) mapped[field] = val != null ? String(val).trim() : '';
    }

    // Asset number is required
    const assetNum = mapped.asset_number?.trim();
    if (!assetNum) {
      errors.push({ row: rowNum, error: 'رقم الثلاجة مفقود', data: mapped });
      continue;
    }

    // Resolve customer info
    const custCode = mapped.customer_code?.trim() || null;
    let custName   = mapped.customer_name?.trim() || null;
    let regionId   = null;
    let routeCode  = mapped.route_code ? parseInt(mapped.route_code) || null : null;
    let salesrep   = mapped.salesrep_name?.trim() || null;

    // Try to resolve region from name column
    if (mapped.region_name) {
      regionId = regionMap[mapped.region_name.trim()] || null;
    }

    // Auto-fill from customer lookup if customer_code is given
    if (custCode) {
      const info = await lookupCustomer(custCode);
      if (info) {
        if (!custName)  custName  = info.customer_name  || null;
        if (!regionId)  regionId  = info.region_id      || null;
        if (!routeCode) routeCode = info.route_code     ? parseInt(info.route_code) : null;
        if (!salesrep)  salesrep  = info.salesrep_name  || null;
      }
    }

    // Resolve status
    let status = 'active';
    if (mapped.status) {
      const s = mapped.status.trim();
      if (VALID_STATUSES.has(s))              status = s;
      else if (STATUS_AR_TO_EN[s])            status = STATUS_AR_TO_EN[s];
    }

    // Contract date — xlsx may return a Date object or string
    let contractDate = null;
    if (mapped.contract_date) {
      const rawDate = mapped.contract_date;
      if (rawDate instanceof Date)            contractDate = rawDate.toISOString().split('T')[0];
      else if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) contractDate = rawDate.slice(0, 10);
      else if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(rawDate)) {
        const [d, m, y] = rawDate.split('/');
        contractDate = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      } else if (/^\d{1,2}-\d{1,2}-\d{4}/.test(rawDate)) {
        const [d, m, y] = rawDate.split('-');
        contractDate = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      }
    }

    // Insert with conflict skip
    try {
      const result = await pool.query(
        `INSERT INTO fridges
           (asset_number, customer_code, customer_name, region_id, route_code,
            salesrep_name, contract_number, contract_date, status, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         ON CONFLICT (asset_number) DO NOTHING
         RETURNING id`,
        [
          assetNum,
          custCode,
          custName,
          regionId,
          routeCode,
          salesrep,
          mapped.contract_number?.trim() || null,
          contractDate,
          status,
          mapped.notes?.trim() || null,
          req.user.id,
        ]
      );

      if (result.rowCount > 0) {
        inserted.push(assetNum);
      } else {
        skipped.push({ asset_number: assetNum, reason: 'رقم الثلاجة موجود بالفعل' });
      }
    } catch (e) {
      errors.push({ row: rowNum, error: e.message, data: { asset_number: assetNum } });
    }
  }

  res.json({
    total:    rows.length,
    inserted: inserted.length,
    skipped:  skipped.length,
    errors:   errors.length,
    inserted_list: inserted,
    skipped_list:  skipped,
    error_list:    errors,
  });
});

/* ── List ──────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  const { status, region_id, search, customer_code } = req.query;

  const conds = [];
  const vals  = [];
  let p = 1;

  if (status) {
    conds.push(`f.status = $${p++}`);
    vals.push(status);
  }
  if (region_id) {
    conds.push(`f.region_id = $${p++}`);
    vals.push(Number(region_id));
  }
  if (customer_code) {
    conds.push(`f.customer_code = $${p++}`);
    vals.push(customer_code);
  }
  if (search) {
    conds.push(`(
      f.asset_number   ILIKE $${p}   OR
      f.customer_code  ILIKE $${p}   OR
      f.customer_name  ILIKE $${p}   OR
      f.contract_number ILIKE $${p}
    )`);
    vals.push(`%${search}%`);
    p++;
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT
         f.*,
         r.name_ar AS region_name,
         (SELECT COUNT(*) FROM fridges f2
          WHERE f2.customer_code = f.customer_code AND f.customer_code IS NOT NULL
         )::int AS customer_fridge_count
       FROM fridges f
       LEFT JOIN regions r ON r.id = f.region_id
       ${where}
       ORDER BY f.updated_at DESC
       LIMIT 500`,
      vals
    );
    res.json({ fridges: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Create ────────────────────────────────────────────────── */
router.post('/', canEdit, async (req, res) => {
  const {
    asset_number, customer_code, customer_name,
    region_id, route_code, salesrep_name,
    contract_number, contract_date, status, notes,
  } = req.body;

  if (!asset_number?.trim()) return res.status(400).json({ error: 'رقم الثلاجة مطلوب' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO fridges
         (asset_number, customer_code, customer_name, region_id, route_code,
          salesrep_name, contract_number, contract_date, status, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       RETURNING *`,
      [
        asset_number.trim(),
        customer_code?.trim() || null,
        customer_name?.trim() || null,
        region_id ? Number(region_id) : null,
        route_code ? Number(route_code) : null,
        salesrep_name?.trim() || null,
        contract_number?.trim() || null,
        contract_date || null,
        status || 'active',
        notes?.trim() || null,
        req.user.id,
      ]
    );
    res.status(201).json({ fridge: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'رقم الثلاجة موجود بالفعل' });
    res.status(500).json({ error: e.message });
  }
});

/* ── Sales Report ──────────────────────────────────────────── */
/*
 * GET /api/fridges/sales-report
 *
 * Data source: sales_activity (all uploaded customers — active + inactive)
 * LEFT JOIN fridges  → fridge_count (0 if no fridge for that customer)
 * LEFT JOIN regions  → region_name  (matched via sa.branch_name)
 *
 * Query params:
 *   year       — filter by report_year  (optional)
 *   month      — filter by month_num    (optional)
 *   day        — filter by day          (optional)
 *   region_id  — filter by region       (optional, matched via branch_name)
 *   trading    — 'active' | 'inactive'  (optional, based on total qty)
 *   search     — text search            (optional)
 */
router.get('/sales-report', async (req, res) => {
  const { year, month, day, region_id, trading, search } = req.query;

  /*
   * Strategy:
   *   Base table = fridges  (all fridge-customers always appear)
   *
   *   Quantities JOIN  — period filters (year+month) go here.
   *     Requires BOTH year AND month to avoid cross-month totals.
   *     If no month selected → JOIN condition is FALSE → qty = 0.
   *
   *   Last-activity subquery — independent of period filter,
   *     always shows customer's most recent sale ever.
   *
   *   WHERE — fridge-level filters only (region, search).
   */

  let p = 1;
  const allVals = [];

  /*
   * Fix: pre-aggregate sales_activity PER CUSTOMER before joining fridges.
   * Without this, a customer with N fridges gets N×SUM instead of 1×SUM
   * because the JOIN creates a Cartesian product (N fridge rows × M invoice rows).
   *
   * Quantities subquery uses invoice_date from the invoices table as the
   * authoritative date source (as requested), while still using sales_activity
   * for the qty values.
   */

  /* ── Period filter params for the qty subquery ── */
  let saSubquery;
  if (year && month) {
    // Use invoices.invoice_date as the authoritative date
    saSubquery = `
      SELECT
        sa.customer_code,
        SUM(sa.qty)::int                        AS total_qty,
        COUNT(DISTINCT sa.invoice_number)::int  AS invoice_count
      FROM sales_activity sa
      JOIN invoices i ON i.invoice_number = sa.invoice_number
      WHERE EXTRACT(YEAR  FROM i.invoice_date)::int = $${p++}
        AND EXTRACT(MONTH FROM i.invoice_date)::int = $${p++}
        ${day ? `AND EXTRACT(DAY FROM i.invoice_date)::int = $${p++}` : ''}
      GROUP BY sa.customer_code
    `;
    allVals.push(Number(year), Number(month));
    if (day) allVals.push(Number(day));
  } else {
    /* No month specified → no qty aggregation to avoid cross-month totals */
    saSubquery = `
      SELECT NULL::varchar AS customer_code,
             0::int        AS total_qty,
             0::int        AS invoice_count
      WHERE FALSE
    `;
  }

  /* ── WHERE: fridge-level filters ── */
  const whereParts = ['f.customer_code IS NOT NULL'];
  if (region_id) {
    whereParts.push(`f.region_id = $${p++}`);
    allVals.push(Number(region_id));
  }
  if (search?.trim()) {
    whereParts.push(`(
      f.customer_code ILIKE $${p} OR
      f.customer_name ILIKE $${p} OR
      f.salesrep_name ILIKE $${p}
    )`);
    allVals.push(`%${search.trim()}%`);
    p++;
  }

  /* ── HAVING: trading filter ── */
  let havingClause = '';
  if (trading === 'active')   havingClause = 'HAVING COALESCE(MAX(sa.total_qty), 0) > 0';
  if (trading === 'inactive') havingClause = 'HAVING COALESCE(MAX(sa.total_qty), 0) <= 0';

  try {
    const { rows } = await pool.query(
      `SELECT
         f.customer_code,
         MAX(f.customer_name)                               AS customer_name,
         MAX(r.name_ar)                                     AS region_name,
         MAX(f.salesrep_name)                               AS salesrep_name,
         COUNT(DISTINCT f.id)::int                                          AS fridge_count,
         COUNT(DISTINCT CASE WHEN f.status = 'active' THEN f.id END)::int  AS active_fridge_count,
         STRING_AGG(DISTINCT f.asset_number, ', '
                    ORDER BY f.asset_number)                               AS asset_numbers,
         -- Quantities from pre-aggregated subquery (one row per customer → no multiplication)
         COALESCE(MAX(sa.total_qty),   0)::int              AS total_qty,
         COALESCE(MAX(sa.invoice_count), 0)::int            AS invoice_count,
         -- Last activity: always from full history (independent of period filter)
         MAX(hist.last_ym)                                  AS last_active_ym,
         MAX(hist.last_month_name)                          AS last_month_name,
         MAX(hist.last_year)::int                           AS last_year,
         MAX(hist.last_day)::int                            AS last_day
       FROM fridges f
       LEFT JOIN (${saSubquery}) sa ON sa.customer_code = f.customer_code
       LEFT JOIN regions r           ON r.id = f.region_id
       LEFT JOIN (
         SELECT DISTINCT ON (sa2.customer_code)
           sa2.customer_code,
           sa2.report_year * 100 + sa2.month_num  AS last_ym,
           sa2.month_name                         AS last_month_name,
           sa2.report_year                        AS last_year,
           sa2.day                                AS last_day
         FROM sales_activity sa2
         JOIN invoices i2 ON i2.invoice_number = sa2.invoice_number
         WHERE sa2.qty > 0
         ORDER BY sa2.customer_code,
                  i2.invoice_date DESC NULLS LAST
       ) hist ON hist.customer_code = f.customer_code
       WHERE ${whereParts.join(' AND ')}
       GROUP BY f.customer_code
       ${havingClause}
       ORDER BY total_qty DESC, f.customer_code`,
      allVals
    );

    /* ── Summary totals ── */
    const totalQty      = rows.reduce((s, r) => s + r.total_qty, 0);
    const activeCount   = rows.filter(r => r.total_qty > 0).length;
    const inactiveCount = rows.filter(r => r.total_qty <= 0).length;

    /* ── Filter dropdown data ── */
    const yearsRes = await pool.query(
      `SELECT DISTINCT report_year FROM sales_activity ORDER BY report_year DESC`
    );

    let monthsRes = { rows: [] };
    if (year) {
      monthsRes = await pool.query(
        `SELECT DISTINCT month_num, month_name
         FROM sales_activity
         WHERE report_year = $1
         ORDER BY month_num`,
        [Number(year)]
      );
    }

    let daysRes = { rows: [] };
    if (year && month) {
      daysRes = await pool.query(
        `SELECT DISTINCT day
         FROM sales_activity
         WHERE report_year = $1 AND month_num = $2
           AND day IS NOT NULL
         ORDER BY day`,
        [Number(year), Number(month)]
      );
    }

    res.json({
      rows,
      summary: {
        total_customers:    rows.length,
        active_customers:   activeCount,
        inactive_customers: inactiveCount,
        total_qty:          totalQty,
      },
      years:  yearsRes.rows.map(r => r.report_year),
      months: monthsRes.rows,
      days:   daysRes.rows.map(r => r.day),
    });
  } catch (e) {
    console.error('[sales-report]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── Detail ────────────────────────────────────────────────── */
router.get('/:id', async (req, res) => {
  try {
    const [fridgeRes, histRes] = await Promise.all([
      pool.query(
        `SELECT f.*, r.name_ar AS region_name
         FROM fridges f
         LEFT JOIN regions r ON r.id = f.region_id
         WHERE f.id = $1`,
        [req.params.id]
      ),
      pool.query(
        `SELECT * FROM fridge_transfers WHERE fridge_id = $1 ORDER BY transferred_at DESC`,
        [req.params.id]
      ),
    ]);
    if (!fridgeRes.rowCount) return res.status(404).json({ error: 'الثلاجة غير موجودة' });
    res.json({ fridge: fridgeRes.rows[0], history: histRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Update ────────────────────────────────────────────────── */
router.put('/:id', canEdit, async (req, res) => {
  const {
    asset_number, customer_code, customer_name,
    region_id, route_code, salesrep_name,
    contract_number, contract_date, status, notes,
  } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE fridges SET
         asset_number    = COALESCE($1, asset_number),
         customer_code   = $2,
         customer_name   = $3,
         region_id       = $4,
         route_code      = $5,
         salesrep_name   = $6,
         contract_number = $7,
         contract_date   = $8,
         status          = COALESCE($9, status),
         notes           = $10,
         updated_by      = $11,
         updated_at      = NOW()
       WHERE id = $12
       RETURNING *`,
      [
        asset_number?.trim() || null,
        customer_code?.trim() || null,
        customer_name?.trim() || null,
        region_id ? Number(region_id) : null,
        route_code ? Number(route_code) : null,
        salesrep_name?.trim() || null,
        contract_number?.trim() || null,
        contract_date || null,
        status || null,
        notes?.trim() || null,
        req.user.id,
        req.params.id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'الثلاجة غير موجودة' });
    res.json({ fridge: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'رقم الثلاجة موجود بالفعل' });
    res.status(500).json({ error: e.message });
  }
});

/* ── Delete ────────────────────────────────────────────────── */
router.delete('/:id', canEdit, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM fridges WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'الثلاجة غير موجودة' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Transfer (repair | reassign) ──────────────────────────── */
router.post('/:id/transfer', canEdit, async (req, res) => {
  const { transfer_type, to_customer_code, to_customer_name, notes } = req.body;
  if (!['repair', 'reassign'].includes(transfer_type)) {
    return res.status(400).json({ error: 'نوع النقل غير صحيح' });
  }
  if (transfer_type === 'reassign' && !to_customer_code?.trim()) {
    return res.status(400).json({ error: 'رقم العميل الجديد مطلوب للنقل' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Current fridge state
    const cur = await client.query(
      `SELECT customer_code, customer_name FROM fridges WHERE id = $1`,
      [req.params.id]
    );
    if (!cur.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'الثلاجة غير موجودة' }); }
    const { customer_code: fromCode, customer_name: fromName } = cur.rows[0];

    // Determine new state
    let newStatus     = transfer_type === 'repair' ? 'warehouse_maintenance' : 'active';
    let newCustCode   = transfer_type === 'reassign' ? to_customer_code.trim() : null;
    let newCustName   = transfer_type === 'reassign' ? (to_customer_name?.trim() || null) : null;

    // Record transfer history
    await client.query(
      `INSERT INTO fridge_transfers
         (fridge_id, transfer_type, from_customer_code, from_customer_name,
          to_customer_code, to_customer_name, notes, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        req.params.id, transfer_type, fromCode, fromName,
        newCustCode, newCustName,
        notes?.trim() || null, req.user.id, req.user.name || req.user.email,
      ]
    );

    // Update fridge
    const { rows } = await client.query(
      `UPDATE fridges SET
         status        = $1,
         customer_code = $2,
         customer_name = $3,
         updated_by    = $4,
         updated_at    = NOW()
       WHERE id = $5
       RETURNING *`,
      [newStatus, newCustCode, newCustName, req.user.id, req.params.id]
    );

    await client.query('COMMIT');
    res.json({ fridge: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
