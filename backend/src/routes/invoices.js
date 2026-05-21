const express = require('express');
const pool = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

const router = express.Router();

/* ── Shared param builder ────────────────────────
   Builds WHERE conditions + params array from query.
   Supports:
     years/year   – multi or single year
     months/month – multi or single month
     status       – 'due' → partial+unpaid, else exact
     customer_type – direct / route (NO 1406 exception — full clean filter)
     region_id    – overrides RBAC if super_admin passes it
     route_id     – exact route
     search       – ILIKE on customer_name / customer_name_en
     customer_id  – exact customer
   ─────────────────────────────────────────────── */
function buildConditions(q, req) {
  const {
    year, month, years, months,
    status, customer_type,
    region_id, route_id, search, customer_id,
    sales_rep_name,
  } = q;

  const conditions = [];
  const params     = [];
  let   p          = 1;

  // Region — RBAC first, then query param
  if (req.regionFilter) {
    conditions.push(`region_id = $${p++}`);
    params.push(req.regionFilter);
  } else if (region_id) {
    conditions.push(`region_id = $${p++}`);
    params.push(parseInt(region_id, 10));
  }

  // Multi-year
  if (years) {
    const arr = years.split(',').map(n => parseInt(n, 10)).filter(Boolean);
    if (arr.length === 1) { conditions.push(`year = $${p++}`); params.push(arr[0]); }
    else if (arr.length > 1) { conditions.push(`year = ANY($${p++}::int[])`); params.push(arr); }
  } else if (year) {
    conditions.push(`year = $${p++}`); params.push(parseInt(year, 10));
  }

  // Multi-month
  if (months) {
    const arr = months.split(',').map(n => parseInt(n, 10)).filter(Boolean);
    if (arr.length === 1) { conditions.push(`EXTRACT(MONTH FROM invoice_date) = $${p++}`); params.push(arr[0]); }
    else if (arr.length > 1) { conditions.push(`EXTRACT(MONTH FROM invoice_date) = ANY($${p++}::int[])`); params.push(arr); }
  } else if (month) {
    conditions.push(`EXTRACT(MONTH FROM invoice_date) = $${p++}`); params.push(parseInt(month, 10));
  }

  // Status — 'due' = partial + unpaid combined
  if (status === 'due') {
    conditions.push(`status IN ('partial', 'unpaid')`);
  } else if (status) {
    conditions.push(`status = $${p++}`); params.push(status);
  }

  // Direct sales — COMPLETE exclusion (no exceptions for any route)
  if (customer_type) {
    conditions.push(`customer_type = $${p++}`);
    params.push(customer_type);
  }

  // Route
  if (route_id) { conditions.push(`route_id = $${p++}`); params.push(parseInt(route_id, 10)); }

  // Sales rep
  if (sales_rep_name) { conditions.push(`sales_rep_name = $${p++}`); params.push(sales_rep_name); }

  // Customer
  if (customer_id) { conditions.push(`customer_id = $${p++}`); params.push(String(customer_id)); }

  // Search
  if (search) {
    conditions.push(`(customer_name ILIKE $${p} OR customer_name_en ILIKE $${p})`);
    params.push(`%${search}%`);
    p++;
  }

  return { conditions, params, p };
}

// ─────────────────────────────────────────────────
// GET /api/invoices/meta — distinct filter values from actual data
// Returns regions, sales reps, and routes actually present in invoices
// ─────────────────────────────────────────────────
router.get('/meta', verifyToken, applyRegionFilter, async (req, res) => {
  const { customer_type, region_id } = req.query;

  const conditions = [];
  const params     = [];
  let   p          = 1;

  // RBAC region takes priority; super_admin can pass region_id from the query
  if (req.regionFilter) {
    conditions.push(`i.region_id = $${p++}`);
    params.push(req.regionFilter);
  } else if (region_id) {
    conditions.push(`i.region_id = $${p++}`);
    params.push(parseInt(region_id, 10));
  }
  if (customer_type) {
    conditions.push(`i.customer_type = $${p++}`);
    params.push(customer_type);
  }

  // Build per-query WHERE clauses that always include the extra IS NOT NULL guards
  const regionWhere = conditions.length
    ? 'WHERE ' + conditions.join(' AND ')
    : '';
  const repWhere = conditions.length
    ? `WHERE ${conditions.join(' AND ')} AND i.sales_rep_name IS NOT NULL AND i.sales_rep_name <> ''`
    : `WHERE i.sales_rep_name IS NOT NULL AND i.sales_rep_name <> ''`;
  const routeWhere = conditions.length
    ? `WHERE ${conditions.join(' AND ')} AND i.route_id IS NOT NULL`
    : `WHERE i.route_id IS NOT NULL`;

  try {
    const [regRes, repRes, routeRes] = await Promise.all([
      // Distinct regions that actually have invoices
      pool.query(
        `SELECT DISTINCT r.id, r.name_ar, r.name_en
         FROM invoices i
         JOIN regions r ON r.id = i.region_id
         ${regionWhere}
         ORDER BY r.name_ar`,
        params
      ),
      // Distinct sales reps (non-null, non-empty)
      pool.query(
        `SELECT DISTINCT i.sales_rep_name
         FROM invoices i
         ${repWhere}
         ORDER BY i.sales_rep_name`,
        params
      ),
      // Distinct routes (sorted numerically)
      pool.query(
        `SELECT DISTINCT i.route_id
         FROM invoices i
         ${routeWhere}
         ORDER BY i.route_id`,
        params
      ),
    ]);

    res.json({
      regions: regRes.rows,
      reps:    repRes.rows.map(r => r.sales_rep_name),
      routes:  routeRes.rows.map(r => r.route_id),
    });
  } catch (err) {
    console.error('Meta error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────
// GET /api/invoices
// ─────────────────────────────────────────────────
router.get('/', verifyToken, applyRegionFilter, async (req, res) => {
  const {
    page = 1, limit = 500,
    sort_by = 'invoice_date', sort_dir = 'DESC',
  } = req.query;

  // buildConditions uses table aliases so prefix them here
  const raw = buildConditions(req.query, req);
  const conditions = raw.conditions.map(c => c.replace(/\b(region_id|year|invoice_date|status|customer_type|route_id|customer_id|customer_name|customer_name_en)\b/g, 'i.$1'));
  const { params } = raw;
  let   { p }      = raw;

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const allowedSort = ['invoice_date', 'customer_name', 'original_amount', 'balance',
                       'collection_rate', 'status', 'year', 'route_id', 'customer_id'];
  const safeSort = allowedSort.includes(sort_by) ? sort_by : 'invoice_date';
  const safeDir  = sort_dir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const offset   = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM invoices i ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const { rows } = await pool.query(
      `SELECT i.*,
              r.name_ar AS region_name_ar,
              r.name_en AS region_name_en,
              n.note_text
       FROM invoices i
       LEFT JOIN regions r ON r.id = i.region_id
       LEFT JOIN notes   n ON n.invoice_id = i.id
       ${where}
       ORDER BY i.${safeSort} ${safeDir}
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, parseInt(limit, 10), offset]
    );

    res.json({ data: rows, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
  } catch (err) {
    console.error('Invoices fetch error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────
// GET /api/invoices/monthly-summary
// Monthly balance + unpaid count for a given year,
// plus per-region breakdown of unpaid invoices.
// Query params: year (default = current year), region_id, customer_type
// ─────────────────────────────────────────────────
router.get('/monthly-summary', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const year = req.query.year
      ? parseInt(req.query.year, 10)
      : new Date().getFullYear();

    const conditions = [`EXTRACT(YEAR FROM i.invoice_date) = $1`];
    const params     = [year];
    let   p          = 2;

    const effectiveRegion = req.regionFilter
      || (req.query.region_id ? parseInt(req.query.region_id, 10) : null);
    if (effectiveRegion) { conditions.push(`i.region_id = $${p++}`); params.push(effectiveRegion); }
    if (req.query.customer_type) { conditions.push(`i.customer_type = $${p++}`); params.push(req.query.customer_type); }

    const where = 'WHERE ' + conditions.join(' AND ');

    // ── Monthly totals ────────────────────────────────────────
    const monthRes = await pool.query(
      `SELECT
         EXTRACT(MONTH FROM i.invoice_date)::int                                        AS month,
         ROUND(SUM(i.balance)::numeric, 2)                                              AS total_balance,
         COUNT(*) FILTER (WHERE i.status IN ('unpaid','partial') AND i.balance > 0)::int AS unpaid_count,
         COUNT(*)::int                                                                   AS invoice_count
       FROM invoices i
       ${where}
       GROUP BY month
       ORDER BY month`,
      params
    );

    // Fill all 12 months (zeros for months without data)
    const monthMap = {};
    monthRes.rows.forEach(r => { monthMap[r.month] = r; });
    const months = Array.from({ length: 12 }, (_, i) => ({
      month:         i + 1,
      total_balance: parseFloat(monthMap[i + 1]?.total_balance || 0),
      unpaid_count:  parseInt(monthMap[i + 1]?.unpaid_count   || 0),
      invoice_count: parseInt(monthMap[i + 1]?.invoice_count  || 0),
    }));

    // ── Region breakdown ──────────────────────────────────────
    const regionRes = await pool.query(
      `SELECT
         COALESCE(r.name_ar, 'غير محدد')                                                AS region_name,
         COUNT(*) FILTER (WHERE i.status IN ('unpaid','partial') AND i.balance > 0)::int AS unpaid_count,
         ROUND(SUM(i.balance)::numeric, 2)                                              AS total_balance,
         COUNT(*)::int                                                                   AS invoice_count
       FROM invoices i
       LEFT JOIN regions r ON r.id = i.region_id
       ${where}
       GROUP BY r.name_ar
       ORDER BY unpaid_count DESC, total_balance DESC`,
      params
    );

    const totalUnpaid  = regionRes.rows.reduce((s, r) => s + r.unpaid_count,  0);
    const totalBalance = regionRes.rows.reduce((s, r) => s + parseFloat(r.total_balance), 0);

    const regions = regionRes.rows.map(r => ({
      region_name:   r.region_name,
      unpaid_count:  r.unpaid_count,
      total_balance: parseFloat(r.total_balance),
      pct_count:     totalUnpaid  > 0 ? parseFloat((r.unpaid_count          / totalUnpaid  * 100).toFixed(1)) : 0,
      pct_balance:   totalBalance > 0 ? parseFloat((parseFloat(r.total_balance) / totalBalance * 100).toFixed(1)) : 0,
    }));

    res.json({
      year,
      months,
      regions,
      total_balance:      parseFloat(totalBalance.toFixed(2)),
      total_unpaid_count: totalUnpaid,
    });
  } catch (err) {
    console.error('Monthly summary error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────
// GET /api/invoices/status-by-region
// Returns unpaid + partial counts broken down by region
// ─────────────────────────────────────────────────
router.get('/status-by-region', verifyToken, applyRegionFilter, async (req, res) => {
  const { conditions, params } = buildConditions(req.query, req);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    // Query grouped by region AND year so we can show per-year rows in the cards
    const { rows } = await pool.query(
      `SELECT
         r.name_ar                                          AS region_name,
         EXTRACT(YEAR FROM i.invoice_date)::int             AS invoice_year,
         COUNT(*) FILTER (WHERE i.status = 'unpaid')        AS unpaid_count,
         COUNT(*) FILTER (WHERE i.status = 'partial')       AS partial_count
       FROM invoices i
       LEFT JOIN regions r ON r.id = i.region_id
       ${where}
       GROUP BY r.name_ar, invoice_year
       ORDER BY r.name_ar, invoice_year`,
      params
    );

    // Aggregate per-region with year breakdown
    const regionMap = new Map();
    rows.forEach(r => {
      const name    = r.region_name || 'غير محدد';
      const year    = Number(r.invoice_year);
      const unpaid  = Number(r.unpaid_count);
      const partial = Number(r.partial_count);
      if (!regionMap.has(name)) {
        regionMap.set(name, { name, unpaid: 0, partial: 0, yearMap: new Map() });
      }
      const reg = regionMap.get(name);
      reg.unpaid  += unpaid;
      reg.partial += partial;
      reg.yearMap.set(year, { year, unpaid, partial });
    });

    const unpaidTotal  = [...regionMap.values()].reduce((s, r) => s + r.unpaid,  0);
    const partialTotal = [...regionMap.values()].reduce((s, r) => s + r.partial, 0);

    // Build final regions array (sorted by total desc)
    const regions = [...regionMap.values()]
      .map(r => ({
        name:    r.name,
        unpaid:  r.unpaid,
        partial: r.partial,
        total:   r.unpaid + r.partial,
        years:   [...r.yearMap.values()].sort((a, b) => a.year - b.year),
      }))
      .sort((a, b) => b.total - a.total);

    // Keep legacy shape for CombinedStatusKPICard (uses .regions[].count)
    const unpaidRegions  = regions
      .filter(r => r.unpaid  > 0)
      .map(r => ({
        name:  r.name,
        count: r.unpaid,
        pct:   unpaidTotal  > 0 ? Math.round(r.unpaid  / unpaidTotal  * 1000) / 10 : 0,
        years: r.years.map(y => ({ year: y.year, count: y.unpaid })),
      }));

    const partialRegions = regions
      .filter(r => r.partial > 0)
      .map(r => ({
        name:  r.name,
        count: r.partial,
        pct:   partialTotal > 0 ? Math.round(r.partial / partialTotal * 1000) / 10 : 0,
        years: r.years.map(y => ({ year: y.year, count: y.partial })),
      }));

    res.json({
      unpaid:  { total: unpaidTotal,  regions: unpaidRegions  },
      partial: { total: partialTotal, regions: partialRegions },
      regions,   // full region objects with both unpaid+partial per year
    });
  } catch (err) {
    console.error('Status by region error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// GET /api/invoices/kpi
// ─────────────────────────────────────────────────
router.get('/kpi', verifyToken, applyRegionFilter, async (req, res) => {
  const { conditions, params } = buildConditions(req.query, req);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)                                         AS invoice_count,
         COUNT(DISTINCT customer_id)                      AS customer_count,
         COALESCE(SUM(original_amount), 0)                AS total_amount,
         COALESCE(SUM(paid_amount),     0)                AS total_paid,
         COALESCE(SUM(balance),         0)                AS total_balance,
         CASE WHEN SUM(original_amount) > 0
              THEN ROUND(SUM(paid_amount) / SUM(original_amount) * 100, 2)
              ELSE 0 END                                  AS collection_rate,
         COUNT(*) FILTER (WHERE status = 'paid')          AS paid_count,
         COUNT(*) FILTER (WHERE status = 'partial')       AS partial_count,
         COUNT(*) FILTER (WHERE status = 'unpaid')        AS unpaid_count
       FROM invoices ${where}`,
      params
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('KPI error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────
// GET /api/invoices/years — year strip data
// Accepts customer_type + region_id to reflect direct-sales toggle
// ─────────────────────────────────────────────────
router.get('/years', verifyToken, applyRegionFilter, async (req, res) => {
  const { customer_type, region_id } = req.query;

  const conditions = [];
  const params     = [];
  let   p          = 1;

  if (req.regionFilter) {
    conditions.push(`region_id = $${p++}`);
    params.push(req.regionFilter);
  } else if (region_id) {
    conditions.push(`region_id = $${p++}`);
    params.push(parseInt(region_id, 10));
  }

  if (customer_type) {
    conditions.push(`customer_type = $${p++}`);
    params.push(customer_type);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const { rows } = await pool.query(
      `SELECT
         year,
         COUNT(*)                           AS invoice_count,
         COALESCE(SUM(original_amount), 0) AS total_amount,
         COALESCE(SUM(paid_amount),     0) AS total_paid,
         COALESCE(SUM(balance),         0) AS total_balance,
         CASE WHEN SUM(original_amount) > 0
              THEN ROUND(SUM(paid_amount) / SUM(original_amount) * 100, 2)
              ELSE 0 END                   AS collection_rate
       FROM invoices ${where}
       GROUP BY year
       ORDER BY year DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('Years error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────
// GET /api/invoices/customers — paged list of unique customers + aggregate stats
// Supports all filters: years, months, status, region, rep, route, search, customer_type
// ─────────────────────────────────────────────────
router.get('/customers', verifyToken, applyRegionFilter, async (req, res) => {
  const { page = 1, limit = 200, sort_by = 'total_balance', sort_dir = 'DESC' } = req.query;

  const { conditions, params } = buildConditions(req.query, req);
  let p = params.length + 1;

  const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  // Safe sort column whitelist — all aggregate columns
  const ALLOWED_SORT = {
    customer_name:   'MAX(customer_name)',
    customer_id:     'customer_id',
    route_id:        'MAX(route_id)',
    sales_rep_name:  'MAX(sales_rep_name)',
    invoice_count:   'COUNT(*)',
    total_amount:    'COALESCE(SUM(original_amount),0)',
    total_paid:      'COALESCE(SUM(paid_amount),0)',
    total_balance:   'COALESCE(SUM(balance),0)',
    collection_rate: 'CASE WHEN SUM(original_amount)>0 THEN ROUND(SUM(paid_amount)/SUM(original_amount)*100,2) ELSE 0 END',
    unpaid_count:    'COUNT(*) FILTER (WHERE status=\'unpaid\')',
    partial_count:   'COUNT(*) FILTER (WHERE status=\'partial\')',
    paid_count:      'COUNT(*) FILTER (WHERE status=\'paid\')',
  };
  const sortExpr = ALLOWED_SORT[sort_by] ?? ALLOWED_SORT.total_balance;
  const safeDir  = sort_dir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  try {
    const countRes = await pool.query(
      `SELECT COUNT(DISTINCT customer_id) FROM invoices ${where}`, params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const { rows } = await pool.query(
      `SELECT
         customer_id,
         MAX(customer_name)                           AS customer_name,
         MAX(customer_name_en)                        AS customer_name_en,
         MAX(sales_rep_name)                          AS sales_rep_name,
         MAX(route_id)                                AS route_id,
         MAX(region_id)                               AS region_id,
         MAX(customer_type)                           AS customer_type,
         COUNT(*)                                     AS invoice_count,
         COALESCE(SUM(original_amount), 0)            AS total_amount,
         COALESCE(SUM(paid_amount),     0)            AS total_paid,
         COALESCE(SUM(balance),         0)            AS total_balance,
         CASE WHEN SUM(original_amount) > 0
              THEN ROUND(SUM(paid_amount)/SUM(original_amount)*100,2)
              ELSE 0 END                              AS collection_rate,
         COUNT(*) FILTER (WHERE status='paid')        AS paid_count,
         COUNT(*) FILTER (WHERE status='partial')     AS partial_count,
         COUNT(*) FILTER (WHERE status='unpaid')      AS unpaid_count
       FROM invoices ${where}
       GROUP BY customer_id
       ORDER BY ${sortExpr} ${safeDir} NULLS LAST
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, parseInt(limit, 10), offset]
    );

    // Attach region names
    const regionIds = [...new Set(rows.map(r => r.region_id).filter(Boolean))];
    let regionMap = {};
    if (regionIds.length) {
      const rRes = await pool.query(
        `SELECT id, name_ar FROM regions WHERE id = ANY($1::int[])`, [regionIds]
      );
      rRes.rows.forEach(r => { regionMap[r.id] = r.name_ar; });
    }

    // Attach current customer note from protected table (safe from file upload truncation)
    const customerIds = rows.map(r => r.customer_id).filter(Boolean);
    let noteMap  = {};
    let reconMap = {};
    if (customerIds.length) {
      const [noteRes, reconRes] = await Promise.all([
        pool.query(
          `SELECT customer_id, note_text FROM customer_notes
           WHERE customer_id = ANY($1::text[])`,
          [customerIds]
        ),
        pool.query(
          `SELECT customer_id, COUNT(*) AS cnt FROM customer_reconciliations
           WHERE customer_id = ANY($1::text[])
           GROUP BY customer_id`,
          [customerIds]
        ),
      ]);
      noteRes.rows.forEach(r  => { noteMap[r.customer_id]  = r.note_text; });
      reconRes.rows.forEach(r => { reconMap[r.customer_id] = parseInt(r.cnt, 10); });
    }

    const data = rows.map(r => ({
      ...r,
      region_name_ar:       regionMap[r.region_id]  || null,
      customer_note:        noteMap[r.customer_id]   || '',
      reconciliation_count: reconMap[r.customer_id]  || 0,
    }));

    res.json({ data, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
  } catch (err) {
    console.error('Customers list error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────
// GET /api/invoices/customer/:customerId
// Full customer detail: info + summary + invoices
// Accepts same filters as main list (years, months, status, customer_type)
// ─────────────────────────────────────────────────
router.get('/customer/:customerId', verifyToken, applyRegionFilter, async (req, res) => {
  const { customerId } = req.params;

  // Build conditions — inject customer_id
  const merged = { ...req.query, customer_id: customerId };
  const { conditions, params } = buildConditions(merged, req);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    // Summary stats
    const sumRes = await pool.query(
      `SELECT
         customer_id,
         MAX(customer_name)                           AS customer_name,
         MAX(customer_name_en)                        AS customer_name_en,
         MAX(sales_rep_name)                          AS sales_rep_name,
         MAX(route_id)                                AS route_id,
         COUNT(*)                                     AS invoice_count,
         COALESCE(SUM(original_amount), 0)            AS total_amount,
         COALESCE(SUM(paid_amount),     0)            AS total_paid,
         COALESCE(SUM(balance),         0)            AS total_balance,
         CASE WHEN SUM(original_amount) > 0
              THEN ROUND(SUM(paid_amount)/SUM(original_amount)*100, 2)
              ELSE 0 END                              AS collection_rate,
         COUNT(*) FILTER (WHERE status = 'paid')      AS paid_count,
         COUNT(*) FILTER (WHERE status = 'partial')   AS partial_count,
         COUNT(*) FILTER (WHERE status = 'unpaid')    AS unpaid_count,
         MAX(region_id)                               AS region_id
       FROM invoices
       ${where}
       GROUP BY customer_id`,
      params
    );

    if (sumRes.rows.length === 0) {
      return res.status(404).json({ error: 'العميل غير موجود أو لا توجد فواتير مطابقة' });
    }

    const summary = sumRes.rows[0];

    // Region name + reconciliation count (parallel)
    const [rRes, reconRes] = await Promise.all([
      summary.region_id
        ? pool.query('SELECT name_ar FROM regions WHERE id = $1', [summary.region_id])
        : Promise.resolve({ rows: [] }),
      pool.query(
        'SELECT COUNT(*) AS cnt FROM customer_reconciliations WHERE customer_id = $1',
        [customerId]
      ),
    ]);
    const region_name_ar       = rRes.rows[0]?.name_ar ?? null;
    const reconciliation_count = parseInt(reconRes.rows[0]?.cnt || 0, 10);

    // All invoices for this customer (with filters, no pagination limit)
    // Use i. prefix for customer_id to avoid ambiguity with notes.customer_id
    const joinedWhere = where.replace(/\bcustomer_id\b/g, 'i.customer_id');
    const { rows: invoices } = await pool.query(
      `SELECT i.*, r.name_ar AS region_name_ar, n.note_text
       FROM invoices i
       LEFT JOIN regions r ON r.id = i.region_id
       LEFT JOIN (SELECT invoice_id, note_text FROM notes) n
         ON n.invoice_id = i.id
       ${joinedWhere}
       ORDER BY i.invoice_date DESC`,
      params
    );

    res.json({
      customer: {
        customer_id:          summary.customer_id,
        customer_name:        summary.customer_name,
        customer_name_en:     summary.customer_name_en,
        sales_rep_name:       summary.sales_rep_name,
        route_id:             summary.route_id,
        region_id:            summary.region_id,
        region_name_ar,
        reconciliation_count,
      },
      summary: {
        invoice_count:   Number(summary.invoice_count),
        total_amount:    Number(summary.total_amount),
        total_paid:      Number(summary.total_paid),
        total_balance:   Number(summary.total_balance),
        collection_rate: Number(summary.collection_rate),
        paid_count:      Number(summary.paid_count),
        partial_count:   Number(summary.partial_count),
        unpaid_count:    Number(summary.unpaid_count),
      },
      invoices,
    });
  } catch (err) {
    console.error('Customer detail error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────
// GET /api/invoices/balance-by-region
// Total balance per region, broken down by year.
// Respects all active filters (years, months, status, customer_type, region).
// ─────────────────────────────────────────────────
router.get('/balance-by-region', verifyToken, applyRegionFilter, async (req, res) => {
  const { conditions, params } = buildConditions(req.query, req);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(r.name_ar, 'غير محدد')       AS region_name,
         i.year,
         COALESCE(SUM(i.balance),          0)   AS total_balance,
         COALESCE(SUM(i.original_amount),  0)   AS total_amount,
         COALESCE(SUM(i.paid_amount),      0)   AS total_paid,
         COUNT(*)                               AS invoice_count
       FROM invoices i
       LEFT JOIN regions r ON r.id = i.region_id
       ${where}
       GROUP BY r.name_ar, i.year
       ORDER BY r.name_ar, i.year DESC`,
      params
    );

    /* Reshape: [ { region_name, total_balance, total_amount, years: [...] } ] */
    const regionMap = {};
    for (const row of rows) {
      const rn = row.region_name;
      if (!regionMap[rn]) {
        regionMap[rn] = {
          region_name:   rn,
          years:         [],
          total_balance: 0,
          total_amount:  0,
          total_paid:    0,
        };
      }
      regionMap[rn].years.push({
        year:    Number(row.year),
        balance: Number(row.total_balance),
        amount:  Number(row.total_amount),
        paid:    Number(row.total_paid),
        count:   Number(row.invoice_count),
      });
      regionMap[rn].total_balance += Number(row.total_balance);
      regionMap[rn].total_amount  += Number(row.total_amount);
      regionMap[rn].total_paid    += Number(row.total_paid);
    }

    /* Sort by descending total balance */
    const result = Object.values(regionMap).sort((a, b) => b.total_balance - a.total_balance);
    res.json(result);
  } catch (err) {
    console.error('Balance by region error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────
// GET /api/invoices/region-month-matrix
// Heat-map matrix: regions × months — ALL statuses
// Balance = remaining (paid rows contribute 0), counts include paid for full picture
// ─────────────────────────────────────────────────
router.get('/region-month-matrix', verifyToken, applyRegionFilter, async (req, res) => {
  const { conditions, params } = buildConditions(req.query, req);

  // Strip any status filter so ALL statuses are included
  const baseConditions = conditions.filter(c => !c.includes('status'));
  const where = baseConditions.length ? 'WHERE ' + baseConditions.join(' AND ') : '';

  try {
    const { rows } = await pool.query(
      `SELECT
         i.region_id,
         r.name_ar                                    AS region_name,
         EXTRACT(MONTH FROM i.invoice_date)::int      AS month,
         COUNT(*)                                     AS invoice_count,
         COUNT(*) FILTER (WHERE i.status='unpaid')    AS unpaid_count,
         COUNT(*) FILTER (WHERE i.status='partial')   AS partial_count,
         COUNT(*) FILTER (WHERE i.status='paid')      AS paid_count,
         COALESCE(SUM(i.balance),         0)          AS total_balance,
         COALESCE(SUM(i.original_amount), 0)          AS total_amount,
         COALESCE(SUM(i.paid_amount),     0)          AS total_paid
       FROM invoices i
       LEFT JOIN regions r ON r.id = i.region_id
       ${where}
       GROUP BY i.region_id, r.name_ar, month
       ORDER BY r.name_ar, month`,
      params
    );

    // Aggregate into per-region Map with per-month buckets
    const regionMap = new Map();
    const monthSet  = new Set();

    rows.forEach(r => {
      const name    = r.region_name || 'غير محدد';
      const month   = Number(r.month);
      const count   = Number(r.invoice_count);
      const unpaid  = Number(r.unpaid_count);
      const partial = Number(r.partial_count);
      const paid    = Number(r.paid_count);
      const balance = Number(r.total_balance);
      const amount  = Number(r.total_amount);
      const paidAmt = Number(r.total_paid);

      monthSet.add(month);

      if (!regionMap.has(r.region_id)) {
        regionMap.set(r.region_id, {
          id: r.region_id, name,
          months: {},
          total: { count: 0, unpaid: 0, partial: 0, paid: 0, balance: 0, amount: 0, paidAmt: 0 },
        });
      }
      const reg = regionMap.get(r.region_id);
      reg.months[month] = { count, unpaid, partial, paid, balance, amount, paidAmt };
      reg.total.count   += count;
      reg.total.unpaid  += unpaid;
      reg.total.partial += partial;
      reg.total.paid    += paid;
      reg.total.balance += balance;
      reg.total.amount  += amount;
      reg.total.paidAmt += paidAmt;
    });

    const months  = [...monthSet].sort((a, b) => a - b);
    const regions = [...regionMap.values()].sort((a, b) => b.total.balance - a.total.balance);

    // Column totals
    const colTotals = {};
    months.forEach(m => {
      colTotals[m] = regions.reduce((s, r) => {
        const c = r.months[m] || { count: 0, unpaid: 0, partial: 0, paid: 0, balance: 0, amount: 0, paidAmt: 0 };
        return {
          count:   s.count   + c.count,
          unpaid:  s.unpaid  + c.unpaid,
          partial: s.partial + c.partial,
          paid:    s.paid    + c.paid,
          balance: s.balance + c.balance,
          amount:  s.amount  + c.amount,
          paidAmt: s.paidAmt + c.paidAmt,
        };
      }, { count: 0, unpaid: 0, partial: 0, paid: 0, balance: 0, amount: 0, paidAmt: 0 });
    });

    res.json({ months, regions, colTotals });
  } catch (err) {
    console.error('Region month matrix error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────
// GET /api/invoices/region-month-customers
// Customer breakdown for a single matrix cell
// ─────────────────────────────────────────────────
router.get('/region-month-customers', verifyToken, applyRegionFilter, async (req, res) => {
  const { region_id, month, year, customer_type } = req.query;

  if (!region_id || !month || !year) {
    return res.status(400).json({ error: 'region_id و month و year مطلوبة' });
  }

  const conditions = [
    `status IN ('unpaid', 'partial')`,
    `region_id = $1`,
    `EXTRACT(MONTH FROM invoice_date) = $2`,
    `EXTRACT(YEAR  FROM invoice_date) = $3`,
  ];
  const params = [parseInt(region_id, 10), parseInt(month, 10), parseInt(year, 10)];
  let p = 4;

  if (customer_type === 'route') {
    conditions.push(`customer_type = $${p++}`);
    params.push('route');
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  try {
    const { rows } = await pool.query(
      `SELECT
         customer_id,
         MAX(customer_name)                             AS customer_name,
         MAX(customer_name_en)                          AS customer_name_en,
         MAX(route_id)                                  AS route_id,
         MAX(sales_rep_name)                            AS sales_rep_name,
         COUNT(*)                                       AS invoice_count,
         COUNT(*) FILTER (WHERE status='unpaid')        AS unpaid_count,
         COUNT(*) FILTER (WHERE status='partial')       AS partial_count,
         COALESCE(SUM(balance),         0)              AS total_balance,
         COALESCE(SUM(original_amount), 0)              AS total_amount,
         COALESCE(SUM(paid_amount),     0)              AS total_paid
       FROM invoices
       ${where}
       GROUP BY customer_id
       ORDER BY total_balance DESC`,
      params
    );

    res.json({
      customers:     rows,
      customerCount: rows.length,
      invoiceCount:  rows.reduce((s, r) => s + Number(r.invoice_count),  0),
      totalBalance:  rows.reduce((s, r) => s + Number(r.total_balance),  0),
      unpaidCount:   rows.reduce((s, r) => s + Number(r.unpaid_count),   0),
      partialCount:  rows.reduce((s, r) => s + Number(r.partial_count),  0),
    });
  } catch (err) {
    console.error('Region month customers error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────
// GET /api/invoices/:id  — single invoice
// ─────────────────────────────────────────────────
router.get('/:id', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, r.name_ar AS region_name_ar, r.name_en AS region_name_en, n.note_text
       FROM invoices i
       LEFT JOIN regions r ON r.id = i.region_id
       LEFT JOIN notes   n ON n.invoice_id = i.id
       WHERE i.id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'الفاتورة غير موجودة' });

    const invoice = rows[0];
    if (req.regionFilter && invoice.region_id !== req.regionFilter) {
      return res.status(403).json({ error: 'غير مصرح' });
    }

    res.json(invoice);
  } catch (err) {
    console.error('Invoice get error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
