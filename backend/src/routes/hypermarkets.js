/**
 * hypermarkets.js — GET /api/hypermarkets/*
 * Performance analytics for the "Hypermarkets" sales category.
 * Data source: sales_activity WHERE category_name ILIKE 'Hypermarkets'
 */

const express = require('express');
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

const router = express.Router();

/* ── Constants ────────────────────────────────────────────── */
const CATEGORY_FILTER = `LOWER(TRIM(COALESCE(sa.category_name, ''))) = 'hypermarkets'`;
const CAT_PLAIN       = `LOWER(TRIM(COALESCE(category_name, ''))) = 'hypermarkets'`;

const MONTH_AR = {
  1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
  7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
};

/* ── Shared helpers ────────────────────────────────────────── */
async function resolveRegionBranch(regionId) {
  if (!regionId) return null;
  try {
    const res = await pool.query(
      'SELECT name_ar, name_en FROM regions WHERE id = $1', [regionId]
    );
    if (!res.rows.length) return null;
    const { name_ar, name_en } = res.rows[0];
    const names = [name_ar, name_en].filter(Boolean);
    return names.length ? names : null;
  } catch { return null; }
}

function mkBranch(branch, p, alias) {
  if (!branch) return { sql: '', val: null, p };
  const col = alias ? `${alias}.branch_name` : 'branch_name';
  if (Array.isArray(branch)) {
    return { sql: ` AND ${col} = ANY($${p}::text[])`, val: branch, p: p + 1 };
  }
  return { sql: ` AND ${col} = $${p}`, val: branch, p: p + 1 };
}

/* ── Working days ─────────────────────────────────────────── */
const HOLIDAYS = [
  { year: 2026, month: 5, days: [27, 28, 29] },
];
function isHoliday(y, m, d) {
  return HOLIDAYS.some(h => h.year === y && h.month === m && h.days.includes(d));
}
function workingDays(year, month) {
  const today   = new Date();
  const isCur   = today.getFullYear() === year && today.getMonth() + 1 === month;
  const lastDay = isCur ? today.getDate() : new Date(year, month, 0).getDate();
  let n = 0;
  for (let d = 1; d <= lastDay; d++) {
    if (new Date(year, month - 1, d).getDay() !== 5 && !isHoliday(year, month, d)) n++;
  }
  return Math.max(n, 1);
}

/* ════════════════════════════════════════════════════════════
   GET /api/hypermarkets/summary
   Full performance summary for the selected month
════════════════════════════════════════════════════════════ */
router.get('/summary', verifyToken, applyRegionFilter, async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
  const rep   = (req.query.salesrep_name || '').trim() || null;

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;

  const wdCur  = workingDays(year, month);
  const wdPrev = workingDays(prevYear, prevMonth);

  try {
    let branch = req.query.branch_name || null;
    if (req.regionFilter) branch = await resolveRegionBranch(req.regionFilter);

    /* ── Build base WHERE params for current and prev month ─ */
    function baseParams(y, m, extraRep) {
      const params = [y, m];
      const b = mkBranch(branch, 3, 'sa');
      if (b.val !== null) params.push(b.val);
      const r = extraRep || rep;
      if (r) params.push(r);
      const repSql = r ? ` AND sa.salesrep_name = $${params.length}` : '';
      return { params, bSql: b.sql, repSql };
    }

    /* ── Helper: main aggregate for a month ─────────────────
       active_customers = any invoice (no qty filter)
       inactive_customers = SUM(qty) <= 0                       */
    async function monthAgg(y, m) {
      const { params, bSql, repSql } = baseParams(y, m);
      const r = await pool.query(`
        WITH cust AS (
          SELECT sa.customer_code, SUM(sa.qty) AS net_qty
          FROM sales_activity sa
          WHERE sa.report_year=$1 AND sa.month_num=$2
            AND ${CATEGORY_FILTER}${bSql}${repSql}
          GROUP BY sa.customer_code
        )
        SELECT
          COUNT(*)::int                                  AS active_customers,
          COUNT(CASE WHEN net_qty <= 0 THEN 1 END)::int  AS inactive_customers,
          (SELECT COALESCE(SUM(qty),0)::bigint
           FROM sales_activity sa
           WHERE sa.report_year=$1 AND sa.month_num=$2
             AND ${CATEGORY_FILTER}${bSql}${repSql})     AS total_qty,
          (SELECT COALESCE(SUM(bad_return_qty),0)::bigint
           FROM sales_activity sa
           WHERE sa.report_year=$1 AND sa.month_num=$2
             AND ${CATEGORY_FILTER}${bSql}${repSql})     AS total_returns
        FROM cust
      `, params);
      return r.rows[0] ?? { active_customers:0, inactive_customers:0, total_qty:0, total_returns:0 };
    }

    /* ── Helper: customer codes present in a month ────────── */
    async function codesInMonth(y, m) {
      const { params, bSql, repSql } = baseParams(y, m);
      const r = await pool.query(`
        SELECT DISTINCT customer_code
        FROM sales_activity sa
        WHERE sa.report_year=$1 AND sa.month_num=$2
          AND ${CATEGORY_FILTER}${bSql}${repSql}
      `, params);
      return new Set(r.rows.map(x => x.customer_code));
    }

    /* ── Helper: new customers this month (not in earlier months) */
    async function newCustCount(y, m) {
      const { params, bSql, repSql } = baseParams(y, m);
      const r = await pool.query(`
        SELECT COUNT(DISTINCT customer_code)::int AS cnt
        FROM sales_activity sa
        WHERE sa.report_year=$1 AND sa.month_num=$2
          AND ${CATEGORY_FILTER}${bSql}${repSql}
          AND customer_code NOT IN (
            SELECT DISTINCT customer_code FROM sales_activity
            WHERE report_year=$1 AND month_num < $2
              AND ${CAT_PLAIN}
          )
      `, params);
      return Number(r.rows[0]?.cnt || 0);
    }

    /* ── Helper: monthly trend (all months in year) ────────── */
    async function monthlyTrend() {
      const { params, bSql, repSql } = baseParams(year, 1); // dummy month — we remove it below
      // Use year-only params
      const trendParams = [year];
      const b = mkBranch(branch, 2, 'sa');
      if (b.val !== null) trendParams.push(b.val);
      if (rep) trendParams.push(rep);
      const rSql = rep ? ` AND sa.salesrep_name = $${trendParams.length}` : '';

      const r = await pool.query(`
        SELECT
          sa.month_num,
          COALESCE(MAX(sa.month_name), '') AS month_name,
          COALESCE(SUM(sa.qty),0)::bigint             AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint  AS total_returns,
          COUNT(DISTINCT sa.customer_code)::int        AS active_customers
        FROM sales_activity sa
        WHERE sa.report_year=$1
          AND ${CATEGORY_FILTER}${b.sql}${rSql}
        GROUP BY sa.month_num
        ORDER BY sa.month_num
      `, trendParams);
      return r.rows.map(row => ({
        month_num:        Number(row.month_num),
        month_name:       MONTH_AR[Number(row.month_num)] || row.month_name,
        total_qty:        Number(row.total_qty),
        total_returns:    Number(row.total_returns),
        active_customers: Number(row.active_customers),
        returns_pct:      Number(row.total_qty) > 0
          ? +(Number(row.total_returns) / Number(row.total_qty) * 100).toFixed(1)
          : 0,
      }));
    }

    /* ── Helper: per-region breakdown ─────────────────────── */
    async function byRegion(y, m) {
      const { params, bSql, repSql } = baseParams(y, m);
      const r = await pool.query(`
        SELECT
          COALESCE(TRIM(sa.branch_name), 'غير محدد') AS branch_name,
          COUNT(DISTINCT sa.customer_code)::int        AS active_customers,
          COALESCE(SUM(sa.qty),0)::bigint              AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS total_returns
        FROM sales_activity sa
        WHERE sa.report_year=$1 AND sa.month_num=$2
          AND ${CATEGORY_FILTER}${bSql}${repSql}
        GROUP BY COALESCE(TRIM(sa.branch_name), 'غير محدد')
        ORDER BY total_qty DESC
      `, params);
      return r.rows;
    }

    /* ── Helper: per-rep breakdown ─────────────────────────── */
    async function byRep(y, m) {
      const { params, bSql, repSql } = baseParams(y, m);
      const r = await pool.query(`
        SELECT
          TRIM(sa.salesrep_name)                      AS salesrep_name,
          COALESCE(TRIM(sa.branch_name), 'غير محدد')  AS branch_name,
          COUNT(DISTINCT sa.customer_code)::int        AS active_customers,
          COALESCE(SUM(sa.qty),0)::bigint              AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS total_returns
        FROM sales_activity sa
        WHERE sa.report_year=$1 AND sa.month_num=$2
          AND ${CATEGORY_FILTER}${bSql}${repSql}
          AND sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) != ''
        GROUP BY TRIM(sa.salesrep_name), COALESCE(TRIM(sa.branch_name), 'غير محدد')
        ORDER BY total_qty DESC
      `, params);
      return r.rows;
    }

    /* ── Helper: top customers ─────────────────────────────── */
    async function topCustomers(y, m) {
      const { params, bSql, repSql } = baseParams(y, m);
      const r = await pool.query(`
        SELECT
          sa.customer_code,
          MAX(sa.customer_name)                       AS customer_name,
          MAX(TRIM(sa.branch_name))                   AS branch_name,
          MAX(TRIM(sa.salesrep_name))                 AS salesrep_name,
          COALESCE(SUM(sa.qty),0)::int                AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::int     AS total_returns,
          COUNT(*)::int                               AS invoice_count
        FROM sales_activity sa
        WHERE sa.report_year=$1 AND sa.month_num=$2
          AND ${CATEGORY_FILTER}${bSql}${repSql}
        GROUP BY sa.customer_code
        ORDER BY total_qty DESC
      `, params);
      return r.rows;
    }

    /* ── Run all queries in parallel ───────────────────────── */
    const [
      aCur, aPrev,
      codesCur, codesPrev,
      trend,
      regCur, regPrev,
      repCur, repPrev,
      customers,
      newCount,
    ] = await Promise.all([
      monthAgg(year, month),
      monthAgg(prevYear, prevMonth),
      codesInMonth(year, month),
      codesInMonth(prevYear, prevMonth),
      monthlyTrend(),
      byRegion(year, month),
      byRegion(prevYear, prevMonth),
      byRep(year, month),
      byRep(prevYear, prevMonth),
      topCustomers(year, month),
      newCustCount(year, month),
    ]);

    const stoppedCount = [...codesPrev].filter(c => !codesCur.has(c)).length;

    /* ── Merge prev qty into region/rep rows ───────────────── */
    const prevRegMap = Object.fromEntries(regPrev.map(r => [r.branch_name, Number(r.total_qty)]));
    const prevRepMap = Object.fromEntries(repPrev.map(r => [r.salesrep_name, Number(r.total_qty)]));

    const tQtyCur  = Number(aCur.total_qty);
    const tQtyPrev = Number(aPrev.total_qty);
    const tRetCur  = Number(aCur.total_returns);
    const tRetPrev = Number(aPrev.total_returns);

    res.json({
      meta: {
        year, month, prev_year: prevYear, prev_month: prevMonth,
        working_days_cur: wdCur, working_days_prev: wdPrev,
        category: 'Hypermarkets',
      },

      cur: {
        total_qty:          tQtyCur,
        total_returns:      tRetCur,
        returns_pct:        tQtyCur > 0 ? +(tRetCur / tQtyCur * 100).toFixed(1) : 0,
        active_customers:   Number(aCur.active_customers),
        inactive_customers: Number(aCur.inactive_customers),
        daily_avg:          +(tQtyCur / wdCur).toFixed(1),
        avg_per_customer:   aCur.active_customers > 0
          ? +(tQtyCur / Number(aCur.active_customers)).toFixed(1)
          : 0,
        new_customers:      newCount,
        stopped_customers:  stoppedCount,
      },

      prev: {
        total_qty:        tQtyPrev,
        total_returns:    tRetPrev,
        returns_pct:      tQtyPrev > 0 ? +(tRetPrev / tQtyPrev * 100).toFixed(1) : 0,
        active_customers: Number(aPrev.active_customers),
        daily_avg:        +(tQtyPrev / wdPrev).toFixed(1),
      },

      deviation: {
        qty_pct:      tQtyPrev > 0 ? +((tQtyCur - tQtyPrev) / tQtyPrev * 100).toFixed(1) : null,
        returns_delta: tQtyCur > 0 && tQtyPrev > 0
          ? +((tRetCur/tQtyCur - tRetPrev/tQtyPrev) * 100).toFixed(1)
          : null,
        customers_pct: Number(aPrev.active_customers) > 0
          ? +((Number(aCur.active_customers) - Number(aPrev.active_customers)) / Number(aPrev.active_customers) * 100).toFixed(1)
          : null,
        daily_avg_pct: aPrev.daily_avg > 0
          ? +((tQtyCur/wdCur - tQtyPrev/wdPrev) / (tQtyPrev/wdPrev) * 100).toFixed(1)
          : null,
      },

      trend,

      by_region: regCur.map(r => ({
        branch_name:      r.branch_name,
        total_qty:        Number(r.total_qty),
        total_returns:    Number(r.total_returns),
        active_customers: Number(r.active_customers),
        prev_qty:         prevRegMap[r.branch_name] || 0,
        returns_pct:      Number(r.total_qty) > 0
          ? +(Number(r.total_returns) / Number(r.total_qty) * 100).toFixed(1)
          : 0,
      })),

      by_rep: repCur.map(r => ({
        salesrep_name:    r.salesrep_name,
        branch_name:      r.branch_name,
        total_qty:        Number(r.total_qty),
        total_returns:    Number(r.total_returns),
        active_customers: Number(r.active_customers),
        prev_qty:         prevRepMap[r.salesrep_name] || 0,
        returns_pct:      Number(r.total_qty) > 0
          ? +(Number(r.total_returns) / Number(r.total_qty) * 100).toFixed(1)
          : 0,
      })),

      customers: customers.map(c => ({
        customer_code:   c.customer_code,
        customer_name:   c.customer_name,
        branch_name:     c.branch_name,
        salesrep_name:   c.salesrep_name,
        total_qty:       Number(c.total_qty),
        total_returns:   Number(c.total_returns),
        invoice_count:   Number(c.invoice_count),
        returns_pct:     Number(c.total_qty) > 0
          ? +(Number(c.total_returns) / Number(c.total_qty) * 100).toFixed(1)
          : 0,
      })),
    });

  } catch (err) {
    console.error('[Hypermarkets]', err);
    res.status(500).json({ error: 'خطأ في جلب بيانات Hypermarkets' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/hypermarkets/filters
════════════════════════════════════════════════════════════ */
router.get('/filters', verifyToken, applyRegionFilter, async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    let branch = null;
    if (req.regionFilter) branch = await resolveRegionBranch(req.regionFilter);
    const b = mkBranch(branch, 2, null);
    const params = [year];
    if (b.val !== null) params.push(b.val);

    const { rows } = await pool.query(`
      SELECT DISTINCT
        COALESCE(TRIM(branch_name), '')   AS branch_name,
        COALESCE(TRIM(salesrep_name), '') AS salesrep_name
      FROM sales_activity
      WHERE report_year=$1
        AND ${CAT_PLAIN}
        AND salesrep_name IS NOT NULL AND TRIM(salesrep_name) != ''
        ${b.sql}
      ORDER BY branch_name, salesrep_name
    `, params);

    const branches = [...new Set(rows.map(r => r.branch_name).filter(Boolean))].sort();
    const reps     = rows.filter(r => r.salesrep_name).map(r => ({
      name: r.salesrep_name,
      branch: r.branch_name || '',
    }));

    res.json({ branches, reps });
  } catch (err) {
    console.error('[Hypermarkets] filters:', err);
    res.status(500).json({ error: 'خطأ في جلب قوائم الفلترة' });
  }
});

module.exports = router;
