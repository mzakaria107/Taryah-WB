/**
 * aging.js — GET /api/aging
 *
 * Debt Aging Matrix:
 *   Returns per-customer outstanding balances bucketed by invoice age,
 *   plus daily-change vs yesterday's snapshot (lazy-saved on first call each day).
 *
 * Query params:
 *   region_id        – filter by region (RBAC-enforced for region_manager)
 *   route_id         – filter by route
 *   search           – ILIKE on customer_name
 *   customer_type    – 'route' | 'direct'
 *   sort_by          – column to sort (default: total_balance)
 *   sort_dir         – ASC | DESC (default: DESC)
 *   page / limit     – pagination (default 200)
 */

const express = require('express');
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

const router = express.Router();

/* ── Allowed sort columns ────────────────────────────────────── */
const SORT_COLS = {
  total_balance: 'total_balance',
  b_1_15:        'b_1_15',
  b_16_30:       'b_16_30',
  b_31_60:       'b_31_60',
  b_61_90:       'b_61_90',
  b_91_120:      'b_91_120',
  b_120_plus:    'b_120_plus',
  customer_name: 'customer_name',
  daily_change:  'daily_change',
  collection_rate: 'collection_rate',
};

/* ═══════════════════════════════════════════════════════════════
   GET /api/aging
═══════════════════════════════════════════════════════════════ */
router.get('/', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const {
      region_id, route_id, search, customer_type,
      sort_by = 'total_balance', sort_dir = 'DESC',
      page = 1, limit = 500,
    } = req.query;

    const conditions = [`i.status IN ('unpaid','partial')`, `i.balance > 0`];
    const params     = [];
    let   p          = 1;

    // RBAC region first
    if (req.regionFilter) {
      conditions.push(`i.region_id = $${p++}`);
      params.push(req.regionFilter);
    } else if (region_id) {
      conditions.push(`i.region_id = $${p++}`);
      params.push(parseInt(region_id, 10));
    }
    if (route_id) {
      conditions.push(`i.route_id = $${p++}`);
      params.push(parseInt(route_id, 10));
    }
    if (customer_type) {
      conditions.push(`i.customer_type = $${p++}`);
      params.push(customer_type);
    }
    if (search) {
      conditions.push(`(i.customer_name ILIKE $${p} OR i.customer_name_en ILIKE $${p})`);
      params.push(`%${search}%`);
      p++;
    }

    const where  = conditions.join(' AND ');
    const safeSort = SORT_COLS[sort_by] ?? 'total_balance';
    const safeDir  = sort_dir?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const offset   = (Math.max(parseInt(page) || 1, 1) - 1) * Math.min(parseInt(limit) || 500, 1000);
    const lim      = Math.min(parseInt(limit) || 500, 1000);

    /* ── Lazy daily snapshot ─────────────────────────────────── */
    // Save today's balances if not yet done today (once per day)
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    const { rows: snapCheck } = await pool.query(
      `SELECT COUNT(*) AS n FROM balance_snapshots WHERE snapshot_date = $1`, [todayStr]
    );
    if (parseInt(snapCheck[0].n) === 0) {
      // Insert today's snapshot for ALL customers with outstanding balance
      await pool.query(`
        INSERT INTO balance_snapshots (snapshot_date, customer_id, customer_name, total_balance, invoice_count)
        SELECT
          $1::date,
          customer_id,
          MAX(customer_name),
          ROUND(SUM(balance)::numeric, 2),
          COUNT(*)::int
        FROM invoices
        WHERE status IN ('unpaid','partial') AND balance > 0
        GROUP BY customer_id
        ON CONFLICT (snapshot_date, customer_id) DO NOTHING
      `, [todayStr]);
    }

    /* ── Yesterday's snapshot date (most recent available) ──── */
    const { rows: prevSnap } = await pool.query(`
      SELECT MAX(snapshot_date)::text AS prev_date
      FROM balance_snapshots
      WHERE snapshot_date < $1
    `, [todayStr]);
    const prevDate = prevSnap[0]?.prev_date || null;

    /* ── Main aging query ────────────────────────────────────── */
    const { rows, rowCount } = await pool.query(`
      SELECT
        i.customer_id,
        MAX(i.customer_name)      AS customer_name,
        MAX(i.customer_name_en)   AS customer_name_en,
        MAX(i.region_id)          AS region_id,
        MAX(i.route_id)           AS route_id,
        -- Aging buckets
        ROUND(SUM(CASE WHEN (CURRENT_DATE - i.invoice_date) BETWEEN 1  AND 15  THEN i.balance ELSE 0 END)::numeric, 2) AS b_1_15,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - i.invoice_date) BETWEEN 16 AND 30  THEN i.balance ELSE 0 END)::numeric, 2) AS b_16_30,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - i.invoice_date) BETWEEN 31 AND 60  THEN i.balance ELSE 0 END)::numeric, 2) AS b_31_60,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - i.invoice_date) BETWEEN 61 AND 90  THEN i.balance ELSE 0 END)::numeric, 2) AS b_61_90,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - i.invoice_date) BETWEEN 91 AND 120 THEN i.balance ELSE 0 END)::numeric, 2) AS b_91_120,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - i.invoice_date) > 120             THEN i.balance ELSE 0 END)::numeric, 2) AS b_120_plus,
        -- Totals
        ROUND(SUM(i.balance)::numeric, 2)        AS total_balance,
        ROUND(SUM(i.original_amount)::numeric, 2) AS total_amount,
        ROUND(SUM(i.paid_amount)::numeric, 2)     AS total_paid,
        COUNT(*)::int                             AS invoice_count,
        ROUND((SUM(i.paid_amount) / NULLIF(SUM(i.original_amount),0) * 100)::numeric, 1) AS collection_rate,
        -- Daily change vs prev snapshot
        COALESCE(bs.total_balance, SUM(i.balance))           AS prev_balance,
        ROUND((SUM(i.balance) - COALESCE(bs.total_balance, SUM(i.balance)))::numeric, 2) AS daily_change
      FROM invoices i
      LEFT JOIN balance_snapshots bs
        ON bs.customer_id   = i.customer_id
        AND bs.snapshot_date = $1
      WHERE ${where}
      GROUP BY i.customer_id, bs.total_balance
      HAVING SUM(i.balance) > 0
      ORDER BY ${safeSort} ${safeDir}
      LIMIT $${p} OFFSET $${p + 1}
    `, [...params, prevDate, lim, offset]);

    /* ── Count query ─────────────────────────────────────────── */
    const { rows: countRows } = await pool.query(`
      SELECT COUNT(DISTINCT i.customer_id)::int AS total
      FROM invoices i
      WHERE ${where}
    `, params);

    /* ── Bucket totals (for KPI cards) ──────────────────────── */
    const { rows: totals } = await pool.query(`
      SELECT
        ROUND(SUM(CASE WHEN (CURRENT_DATE - invoice_date) BETWEEN 1  AND 15  THEN balance ELSE 0 END)::numeric,2) AS b_1_15,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - invoice_date) BETWEEN 16 AND 30  THEN balance ELSE 0 END)::numeric,2) AS b_16_30,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - invoice_date) BETWEEN 31 AND 60  THEN balance ELSE 0 END)::numeric,2) AS b_31_60,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - invoice_date) BETWEEN 61 AND 90  THEN balance ELSE 0 END)::numeric,2) AS b_61_90,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - invoice_date) BETWEEN 91 AND 120 THEN balance ELSE 0 END)::numeric,2) AS b_91_120,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - invoice_date) > 120              THEN balance ELSE 0 END)::numeric,2) AS b_120_plus,
        ROUND(SUM(balance)::numeric, 2)       AS total_balance,
        COUNT(DISTINCT customer_id)::int       AS customer_count,
        COUNT(*)::int                          AS invoice_count
      FROM invoices i
      WHERE ${where}
    `, params);

    /* ── Region breakdown ────────────────────────────────────── */
    const { rows: byRegion } = await pool.query(`
      SELECT
        i.region_id,
        r.name_ar   AS region_name,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - i.invoice_date) BETWEEN 1  AND 15  THEN i.balance ELSE 0 END)::numeric,2) AS b_1_15,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - i.invoice_date) BETWEEN 16 AND 30  THEN i.balance ELSE 0 END)::numeric,2) AS b_16_30,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - i.invoice_date) BETWEEN 31 AND 60  THEN i.balance ELSE 0 END)::numeric,2) AS b_31_60,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - i.invoice_date) BETWEEN 61 AND 90  THEN i.balance ELSE 0 END)::numeric,2) AS b_61_90,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - i.invoice_date) BETWEEN 91 AND 120 THEN i.balance ELSE 0 END)::numeric,2) AS b_91_120,
        ROUND(SUM(CASE WHEN (CURRENT_DATE - i.invoice_date) > 120              THEN i.balance ELSE 0 END)::numeric,2) AS b_120_plus,
        ROUND(SUM(i.balance)::numeric, 2)         AS total_balance,
        COUNT(DISTINCT i.customer_id)::int         AS customer_count
      FROM invoices i
      LEFT JOIN regions r ON r.id = i.region_id
      WHERE ${where}
      GROUP BY i.region_id, r.name_ar
      ORDER BY total_balance DESC
    `, params);

    res.json({
      customers:     rows,
      total:         countRows[0]?.total || 0,
      kpis:          totals[0] || {},
      by_region:     byRegion,
      snapshot_date: todayStr,
      prev_date:     prevDate,
    });
  } catch (err) {
    console.error('[Aging]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/aging/invoices/:customerId
   Invoice-level breakdown for one customer (aging drill-down)
═══════════════════════════════════════════════════════════════ */
router.get('/invoices/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { rows } = await pool.query(`
      SELECT
        invoice_number,
        invoice_date::text AS invoice_date,
        original_amount,
        paid_amount,
        balance,
        status,
        (CURRENT_DATE - invoice_date)::int                           AS age_days,
        ROUND((paid_amount / NULLIF(original_amount,0) * 100)::numeric,1) AS paid_pct,
        ROUND((balance     / NULLIF(original_amount,0) * 100)::numeric,1) AS remaining_pct
      FROM invoices
      WHERE customer_id = $1
        AND status IN ('unpaid','partial')
        AND balance > 0
      ORDER BY invoice_date ASC
    `, [customerId]);
    res.json({ invoices: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
