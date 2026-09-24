/**
 * categoryPerformance.js — GET /api/category-performance/*
 * Generalized version of hypermarkets.js — same analytics, but for ANY
 * customer category (سلسلة, مطاعم, بقالة, ...) selected via ?category=,
 * instead of being hardcoded to "Hypermarkets". Also adds customer
 * name/code search + a per-customer annual performance panel that is
 * NOT scoped to a single category (a customer can buy across categories).
 * Data source: sales_activity.category_name
 */

const express = require('express');
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

const router = express.Router();

const MONTH_AR = {
  1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
  7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
};

/* ── Shared helpers (same pattern as hypermarkets.js) ────────── */
async function resolveRegionBranch(regionId) {
  if (!regionId || (Array.isArray(regionId) && !regionId.length)) return null;
  const ids = Array.isArray(regionId) ? regionId : [regionId];
  try {
    const res = await pool.query(
      'SELECT name_ar, name_en FROM regions WHERE id = ANY($1::int[])', [ids]
    );
    if (!res.rows.length) return null;
    const names = res.rows.flatMap(r => [r.name_ar, r.name_en]).filter(Boolean);
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

// Empty/missing category ("الكل") must NOT bind an unused placeholder —
// Postgres errors ("bind message supplies N parameters, but prepared
// statement requires M") if a param is pushed but never referenced in
// the query text, so the placeholder is only allocated when category is set.
function mkCategory(category, p, alias) {
  if (!category) return { sql: 'TRUE', val: null, p };
  const col = alias ? `${alias}.category_name` : 'category_name';
  return { sql: `LOWER(TRIM(${col})) = LOWER($${p})`, val: category, p: p + 1 };
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

// Reads ?category= — empty/missing means "all categories" (no filter),
// selectable in the UI as "الكل".
function requireCategory(req, res, next) {
  req.category = (req.query.category || '').trim();
  next();
}

/* ════════════════════════════════════════════════════════════
   GET /api/category-performance/categories
   Distinct customer-category list (region-agnostic).
════════════════════════════════════════════════════════════ */
router.get('/categories', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT TRIM(category_name) AS val
      FROM sales_activity
      WHERE category_name IS NOT NULL AND TRIM(category_name) != ''
      ORDER BY val
    `);
    res.json({ categories: rows.map(r => r.val) });
  } catch (err) {
    console.error('[CategoryPerformance] categories:', err);
    res.status(500).json({ error: 'خطأ في جلب فئات العملاء' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/category-performance/summary
   Full performance summary for the selected month + category
════════════════════════════════════════════════════════════ */
router.get('/summary', verifyToken, applyRegionFilter, requireCategory, async (req, res) => {
  const category = req.category;

  const yearsParam = (req.query.years || '').trim();
  const yearsArr = yearsParam
    ? [...new Set(yearsParam.split(',').map(s => parseInt(s.trim())).filter(Boolean))]
    : [parseInt(req.query.year) || new Date().getFullYear()];
  const isMultiYear = yearsArr.length > 1;
  const year  = yearsArr[0];

  const monthsParam = (req.query.months || '').trim();
  const monthsArr = monthsParam
    ? [...new Set(monthsParam.split(',').map(s => parseInt(s.trim())).filter(Boolean))]
    : [parseInt(req.query.month) || (new Date().getMonth() + 1)];
  const isMultiMonth = monthsArr.length > 1;
  const month = monthsArr[0];
  const isMultiPeriod = isMultiYear || isMultiMonth;

  const rep = (req.query.salesrep_name || '').trim() || null;

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;
  const prevYearsArr  = isMultiPeriod ? [] : [prevYear];
  const prevMonthsArr = isMultiPeriod ? [] : [prevMonth];

  const wdCur  = yearsArr.reduce((s, y) => s + monthsArr.reduce((s2, m) => s2 + workingDays(y, m), 0), 0);
  const wdPrev = isMultiPeriod ? 0 : workingDays(prevYear, prevMonth);

  try {
    let branch = req.query.branch_name || null;
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    /* ── Build base WHERE params — $1=year[], $2=month[], then category/branch/rep as present ── */
    function baseParams(y, m, extraRep) {
      const params = [y, m];
      let p = 3;
      const cat = mkCategory(category, p, 'sa');
      if (cat.val !== null) { params.push(cat.val); p = cat.p; }
      const catSql = cat.sql;
      const catSqlPlain = category ? `LOWER(TRIM(category_name)) = LOWER($${p - 1})` : 'TRUE';
      const b = mkBranch(branch, p, 'sa');
      if (b.val !== null) params.push(b.val);
      const r = extraRep || rep;
      if (r) params.push(r);
      const repSql = r ? ` AND sa.salesrep_name = $${params.length}` : '';
      return { params, bSql: b.sql, repSql, catSql, catSqlPlain };
    }

    async function monthAgg(y, m) {
      const { params, bSql, repSql, catSql } = baseParams(y, m);
      const r = await pool.query(`
        WITH cust AS (
          SELECT sa.customer_code, SUM(sa.qty) AS net_qty
          FROM sales_activity sa
          WHERE sa.report_year = ANY($1::int[]) AND sa.month_num = ANY($2::int[])
            AND ${catSql}${bSql}${repSql}
          GROUP BY sa.customer_code
        )
        SELECT
          COUNT(*)::int                                  AS active_customers,
          COUNT(CASE WHEN net_qty <= 0 THEN 1 END)::int  AS inactive_customers,
          (SELECT COALESCE(SUM(qty),0)::bigint
           FROM sales_activity sa
           WHERE sa.report_year = ANY($1::int[]) AND sa.month_num = ANY($2::int[])
             AND ${catSql}${bSql}${repSql})     AS total_qty,
          (SELECT COALESCE(SUM(bad_return_qty),0)::bigint
           FROM sales_activity sa
           WHERE sa.report_year = ANY($1::int[]) AND sa.month_num = ANY($2::int[])
             AND ${catSql}${bSql}${repSql})     AS total_returns
        FROM cust
      `, params);
      return r.rows[0] ?? { active_customers:0, inactive_customers:0, total_qty:0, total_returns:0 };
    }

    async function codesInMonth(y, m) {
      const { params, bSql, repSql, catSql } = baseParams(y, m);
      const r = await pool.query(`
        SELECT DISTINCT customer_code
        FROM sales_activity sa
        WHERE sa.report_year = ANY($1::int[]) AND sa.month_num = ANY($2::int[])
          AND ${catSql}${bSql}${repSql}
      `, params);
      return new Set(r.rows.map(x => x.customer_code));
    }

    async function newCustCount(y, m) {
      const { params, bSql, repSql, catSql, catSqlPlain } = baseParams(y, m);
      const earliestYear  = y.length ? Math.min(...y) : 0;
      const earliestMonth = m.length ? Math.min(...m) : 0;
      const r = await pool.query(`
        SELECT COUNT(DISTINCT customer_code)::int AS cnt
        FROM sales_activity sa
        WHERE sa.report_year = ANY($1::int[]) AND sa.month_num = ANY($2::int[])
          AND ${catSql}${bSql}${repSql}
          AND customer_code NOT IN (
            SELECT DISTINCT customer_code FROM sales_activity
            WHERE (report_year < ${earliestYear} OR (report_year = ${earliestYear} AND month_num < ${earliestMonth}))
              AND ${catSqlPlain}
          )
      `, params);
      return Number(r.rows[0]?.cnt || 0);
    }

    async function monthlyTrend() {
      const trendParams = [yearsArr];
      let tp = 2;
      const tCat = mkCategory(category, tp, 'sa');
      if (tCat.val !== null) { trendParams.push(tCat.val); tp = tCat.p; }
      const catSql = tCat.sql;
      const b = mkBranch(branch, tp, 'sa');
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
        WHERE sa.report_year = ANY($1::int[])
          AND ${catSql}${b.sql}${rSql}
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

    async function byRegion(y, m) {
      const { params, bSql, repSql, catSql } = baseParams(y, m);
      const r = await pool.query(`
        SELECT
          COALESCE(TRIM(sa.branch_name), 'غير محدد') AS branch_name,
          COUNT(DISTINCT sa.customer_code)::int        AS active_customers,
          COALESCE(SUM(sa.qty),0)::bigint              AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS total_returns
        FROM sales_activity sa
        WHERE sa.report_year = ANY($1::int[]) AND sa.month_num = ANY($2::int[])
          AND ${catSql}${bSql}${repSql}
        GROUP BY COALESCE(TRIM(sa.branch_name), 'غير محدد')
        ORDER BY total_qty DESC
      `, params);
      return r.rows;
    }

    async function byRep(y, m) {
      const { params, bSql, repSql, catSql } = baseParams(y, m);
      const r = await pool.query(`
        SELECT
          TRIM(sa.salesrep_name)                      AS salesrep_name,
          COALESCE(TRIM(sa.branch_name), 'غير محدد')  AS branch_name,
          COUNT(DISTINCT sa.customer_code)::int        AS active_customers,
          COALESCE(SUM(sa.qty),0)::bigint              AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS total_returns
        FROM sales_activity sa
        WHERE sa.report_year = ANY($1::int[]) AND sa.month_num = ANY($2::int[])
          AND ${catSql}${bSql}${repSql}
          AND sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) != ''
        GROUP BY TRIM(sa.salesrep_name), COALESCE(TRIM(sa.branch_name), 'غير محدد')
        ORDER BY total_qty DESC
      `, params);
      return r.rows;
    }

    async function byItem(y, m) {
      const { params, bSql, repSql, catSql } = baseParams(y, m);
      const r = await pool.query(`
        SELECT
          COALESCE(NULLIF(TRIM(sa.item_name_en), ''), 'غير محدد')     AS item_name,
          COALESCE(NULLIF(TRIM(sa.item_category_en), ''), 'غير محدد') AS item_category,
          COALESCE(SUM(sa.qty),0)::bigint              AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS total_returns,
          COUNT(DISTINCT sa.invoice_number)::int                                 AS invoice_count
        FROM sales_activity sa
        WHERE sa.report_year = ANY($1::int[]) AND sa.month_num = ANY($2::int[])
          AND ${catSql}${bSql}${repSql}
        GROUP BY
          COALESCE(NULLIF(TRIM(sa.item_name_en), ''), 'غير محدد'),
          COALESCE(NULLIF(TRIM(sa.item_category_en), ''), 'غير محدد')
        ORDER BY total_qty DESC
      `, params);
      return r.rows;
    }

    async function topCustomers(y, m) {
      const { params, bSql, repSql, catSql } = baseParams(y, m);
      const r = await pool.query(`
        SELECT
          sa.customer_code,
          MAX(sa.customer_name)                       AS customer_name,
          MAX(TRIM(sa.branch_name))                   AS branch_name,
          MAX(TRIM(sa.salesrep_name))                 AS salesrep_name,
          COALESCE(SUM(sa.qty),0)::int                AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::int     AS total_returns,
          COUNT(DISTINCT sa.invoice_number)::int                               AS invoice_count
        FROM sales_activity sa
        WHERE sa.report_year = ANY($1::int[]) AND sa.month_num = ANY($2::int[])
          AND ${catSql}${bSql}${repSql}
        GROUP BY sa.customer_code
        ORDER BY total_qty DESC
      `, params);
      return r.rows;
    }

    const [
      aCur, aPrev,
      codesCur, codesPrev,
      trend,
      regCur, regPrev,
      repCur, repPrev,
      customers,
      newCount,
      itemCur, itemPrev,
    ] = await Promise.all([
      monthAgg(yearsArr, monthsArr),
      monthAgg(prevYearsArr, prevMonthsArr),
      codesInMonth(yearsArr, monthsArr),
      codesInMonth(prevYearsArr, prevMonthsArr),
      monthlyTrend(),
      byRegion(yearsArr, monthsArr),
      byRegion(prevYearsArr, prevMonthsArr),
      byRep(yearsArr, monthsArr),
      byRep(prevYearsArr, prevMonthsArr),
      topCustomers(yearsArr, monthsArr),
      newCustCount(yearsArr, monthsArr),
      byItem(yearsArr, monthsArr),
      byItem(prevYearsArr, prevMonthsArr),
    ]);

    const stoppedCount = [...codesPrev].filter(c => !codesCur.has(c)).length;

    const prevRegMap  = Object.fromEntries(regPrev.map(r => [r.branch_name, Number(r.total_qty)]));
    const prevRepMap  = Object.fromEntries(repPrev.map(r => [r.salesrep_name, Number(r.total_qty)]));
    const prevItemMap = Object.fromEntries(itemPrev.map(r => [r.item_name, Number(r.total_qty)]));

    const tQtyCur  = Number(aCur.total_qty);
    const tQtyPrev = Number(aPrev.total_qty);
    const tRetCur  = Number(aCur.total_returns);
    const tRetPrev = Number(aPrev.total_returns);

    res.json({
      meta: {
        year, years: yearsArr, is_multi_year: isMultiYear,
        month, months: monthsArr, is_multi_month: isMultiMonth,
        prev_year: prevYear, prev_month: prevMonth,
        working_days_cur: wdCur, working_days_prev: wdPrev,
        category,
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

      by_item: itemCur.map(it => ({
        item_name:     it.item_name,
        item_category: it.item_category,
        total_qty:     Number(it.total_qty),
        prev_qty:      prevItemMap[it.item_name] || 0,
        total_returns: Number(it.total_returns),
        invoice_count: Number(it.invoice_count),
        returns_pct:   Number(it.total_qty) > 0
          ? +(Number(it.total_returns) / Number(it.total_qty) * 100).toFixed(1)
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
    console.error('[CategoryPerformance] summary:', err);
    res.status(500).json({ error: 'خطأ في جلب بيانات أداء الفئة' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/category-performance/customer-matrix
════════════════════════════════════════════════════════════ */
router.get('/customer-matrix', verifyToken, applyRegionFilter, requireCategory, async (req, res) => {
  const category = req.category;
  const rep   = (req.query.salesrep_name || '').trim() || null;
  const limit = Math.min(parseInt(req.query.limit) || 25, 50);

  try {
    let branch = req.query.branch_name || null;
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    const params = [];
    let p = 1;
    const cat = mkCategory(category, p, 'sa');
    if (cat.val !== null) { params.push(cat.val); p = cat.p; }
    const catSql = cat.sql;
    const b = mkBranch(branch, p, 'sa');
    if (b.val !== null) params.push(b.val);
    if (rep) params.push(rep);
    const repSql = rep ? ` AND sa.salesrep_name = $${params.length}` : '';

    const r = await pool.query(`
      SELECT
        sa.customer_code                              AS customer_code,
        MAX(sa.customer_name)                         AS customer_name,
        MAX(TRIM(sa.branch_name))                     AS branch_name,
        sa.month_num::int                              AS month_num,
        COALESCE(SUM(sa.qty),0)::bigint                AS total_qty,
        COALESCE(SUM(sa.bad_return_qty),0)::bigint     AS total_returns,
        COALESCE(SUM(sa.net_revenue),0)::numeric       AS net_revenue
      FROM sales_activity sa
      WHERE ${catSql}${b.sql}${repSql}
      GROUP BY sa.customer_code, sa.month_num
    `, params);

    const byCust = {};
    for (const row of r.rows) {
      const key = row.customer_code;
      if (!byCust[key]) {
        byCust[key] = {
          customer_code:  row.customer_code,
          customer_name:  row.customer_name,
          branch_name:    row.branch_name || 'غير محدد',
          annual_qty:     0,
          annual_returns: 0,
          annual_revenue: 0,
          months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, qty: 0, returns: 0, revenue: 0 })),
        };
      }
      const entry = byCust[key];
      const qty = Number(row.total_qty);
      const ret = Number(row.total_returns);
      const rev = Number(row.net_revenue);
      entry.months[row.month_num - 1].qty     = qty;
      entry.months[row.month_num - 1].returns = ret;
      entry.months[row.month_num - 1].revenue = rev;
      entry.annual_qty     += qty;
      entry.annual_returns += ret;
      entry.annual_revenue += rev;
    }

    const items = Object.values(byCust)
      .sort((a, b2) => b2.annual_qty - a.annual_qty)
      .slice(0, limit);

    const maxQty = items.reduce((m, it) => Math.max(m, ...it.months.map(mo => mo.qty)), 1);

    res.json({ month_names: MONTH_AR, max_qty: maxQty, items });
  } catch (err) {
    console.error('[CategoryPerformance] customer-matrix:', err);
    res.status(500).json({ error: 'خطأ في جلب مصفوفة العملاء' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/category-performance/item-overview
════════════════════════════════════════════════════════════ */
router.get('/item-overview', verifyToken, applyRegionFilter, requireCategory, async (req, res) => {
  const category = req.category;
  const rep = (req.query.salesrep_name || '').trim() || null;

  try {
    let branch = req.query.branch_name || null;
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    const params = [];
    let p = 1;
    const cat = mkCategory(category, p, 'sa');
    if (cat.val !== null) { params.push(cat.val); p = cat.p; }
    const catSql = cat.sql;
    const b = mkBranch(branch, p, 'sa');
    if (b.val !== null) params.push(b.val);
    if (rep) params.push(rep);
    const repSql = rep ? ` AND sa.salesrep_name = $${params.length}` : '';

    const r = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(sa.item_name_en), ''), 'غير محدد')     AS item_name,
        COALESCE(NULLIF(TRIM(sa.item_category_en), ''), 'غير محدد') AS item_category,
        COALESCE(SUM(sa.qty),0)::bigint              AS total_qty,
        COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS total_returns,
        COUNT(DISTINCT sa.invoice_number)::int                                 AS invoice_count
      FROM sales_activity sa
      WHERE ${catSql}${b.sql}${repSql}
      GROUP BY
        COALESCE(NULLIF(TRIM(sa.item_name_en), ''), 'غير محدد'),
        COALESCE(NULLIF(TRIM(sa.item_category_en), ''), 'غير محدد')
      ORDER BY total_qty DESC
    `, params);

    const items = r.rows.map(row => ({
      item_name:     row.item_name,
      item_category: row.item_category,
      total_qty:     Number(row.total_qty),
      total_returns: Number(row.total_returns),
      invoice_count: Number(row.invoice_count),
      returns_pct:   Number(row.total_qty) > 0
        ? +(Number(row.total_returns) / Number(row.total_qty) * 100).toFixed(1)
        : 0,
    }));

    res.json({ items });
  } catch (err) {
    console.error('[CategoryPerformance] item-overview:', err);
    res.status(500).json({ error: 'خطأ في جلب إجمالي الأصناف لكامل الفترة' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/category-performance/item-matrix
════════════════════════════════════════════════════════════ */
router.get('/item-matrix', verifyToken, applyRegionFilter, requireCategory, async (req, res) => {
  const category = req.category;
  const year  = parseInt(req.query.year) || new Date().getFullYear();
  const rep   = (req.query.salesrep_name || '').trim() || null;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  try {
    let branch = req.query.branch_name || null;
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    const params = [year];
    let p = 2;
    const cat = mkCategory(category, p, 'sa');
    if (cat.val !== null) { params.push(cat.val); p = cat.p; }
    const catSql = cat.sql;
    const b = mkBranch(branch, p, 'sa');
    if (b.val !== null) params.push(b.val);
    if (rep) params.push(rep);
    const repSql = rep ? ` AND sa.salesrep_name = $${params.length}` : '';

    const r = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(sa.item_name_en), ''), 'غير محدد')     AS item_name,
        COALESCE(NULLIF(TRIM(sa.item_category_en), ''), 'غير محدد') AS item_category,
        sa.month_num::int                            AS month_num,
        COALESCE(SUM(sa.qty),0)::bigint               AS total_qty,
        COALESCE(SUM(sa.bad_return_qty),0)::bigint    AS total_returns
      FROM sales_activity sa
      WHERE sa.report_year=$1
        AND ${catSql}${b.sql}${repSql}
      GROUP BY
        COALESCE(NULLIF(TRIM(sa.item_name_en), ''), 'غير محدد'),
        COALESCE(NULLIF(TRIM(sa.item_category_en), ''), 'غير محدد'),
        sa.month_num
    `, params);

    const byItem = {};
    for (const row of r.rows) {
      const key = row.item_name;
      if (!byItem[key]) {
        byItem[key] = {
          item_name:      row.item_name,
          item_category:  row.item_category,
          annual_qty:     0,
          annual_returns: 0,
          months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, qty: 0, returns: 0 })),
        };
      }
      const entry = byItem[key];
      const qty = Number(row.total_qty);
      const ret = Number(row.total_returns);
      entry.months[row.month_num - 1].qty     = qty;
      entry.months[row.month_num - 1].returns = ret;
      entry.annual_qty     += qty;
      entry.annual_returns += ret;
    }

    const items = Object.values(byItem)
      .sort((a, b2) => b2.annual_qty - a.annual_qty)
      .slice(0, limit);

    const maxQty = items.reduce((m, it) => Math.max(m, ...it.months.map(mo => mo.qty)), 1);

    res.json({
      year,
      month_names: MONTH_AR,
      max_qty: maxQty,
      items,
    });
  } catch (err) {
    console.error('[CategoryPerformance] item-matrix:', err);
    res.status(500).json({ error: 'خطأ في جلب مصفوفة الأصناف' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/category-performance/overview
   Whole-period performance (no year/month filter) for the category.
════════════════════════════════════════════════════════════ */
router.get('/overview', verifyToken, applyRegionFilter, requireCategory, async (req, res) => {
  const category = req.category;
  const rep = (req.query.salesrep_name || '').trim() || null;

  try {
    let branch = req.query.branch_name || null;
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    function periodParams() {
      const params = [];
      let p = 1;
      const cat = mkCategory(category, p, 'sa');
      if (cat.val !== null) { params.push(cat.val); p = cat.p; }
      const catSql = cat.sql;
      const b = mkBranch(branch, p, 'sa');
      if (b.val !== null) params.push(b.val);
      if (rep) params.push(rep);
      const repSql = rep ? ` AND sa.salesrep_name = $${params.length}` : '';
      return { params, bSql: b.sql, repSql, catSql };
    }

    async function totals() {
      const { params, bSql, repSql, catSql } = periodParams();
      const r = await pool.query(`
        SELECT
          COALESCE(SUM(sa.qty),0)::bigint             AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint  AS total_returns,
          COALESCE(SUM(sa.net_revenue),0)::numeric     AS net_revenue,
          COUNT(DISTINCT sa.customer_code)::int        AS active_customers,
          COUNT(DISTINCT sa.invoice_number)::int                                AS invoice_count,
          MIN(sa.report_year)::int                     AS min_year,
          MAX(sa.report_year)::int                     AS max_year
        FROM sales_activity sa
        WHERE ${catSql}${bSql}${repSql}
      `, params);
      return r.rows[0] ?? {};
    }

    async function fullTrend() {
      const { params, bSql, repSql, catSql } = periodParams();
      const r = await pool.query(`
        SELECT
          sa.report_year::int                          AS year,
          sa.month_num::int                             AS month_num,
          COALESCE(SUM(sa.qty),0)::bigint               AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint    AS total_returns,
          COALESCE(SUM(sa.net_revenue),0)::numeric      AS net_revenue,
          COUNT(DISTINCT sa.customer_code)::int          AS active_customers,
          COUNT(DISTINCT sa.invoice_number)::int                                  AS invoice_count
        FROM sales_activity sa
        WHERE ${catSql}${bSql}${repSql}
        GROUP BY sa.report_year, sa.month_num
        ORDER BY sa.report_year, sa.month_num
      `, params);
      return r.rows.map(row => ({
        year:             row.year,
        month_num:        row.month_num,
        month_name:       MONTH_AR[row.month_num] || '',
        label:            `${MONTH_AR[row.month_num] || ''} ${row.year}`,
        total_qty:        Number(row.total_qty),
        total_returns:    Number(row.total_returns),
        net_revenue:      Number(row.net_revenue),
        active_customers: Number(row.active_customers),
        invoice_count:    Number(row.invoice_count),
        returns_pct:      Number(row.total_qty) > 0
          ? +(Number(row.total_returns) / Number(row.total_qty) * 100).toFixed(1)
          : 0,
      }));
    }

    async function bestBranches() {
      const { params, bSql, repSql, catSql } = periodParams();
      const r = await pool.query(`
        SELECT
          COALESCE(TRIM(sa.branch_name), 'غير محدد') AS branch_name,
          COALESCE(SUM(sa.qty),0)::bigint              AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS total_returns,
          COUNT(DISTINCT sa.customer_code)::int         AS active_customers,
          COUNT(DISTINCT sa.invoice_number)::int                                 AS invoice_count
        FROM sales_activity sa
        WHERE ${catSql}${bSql}${repSql}
        GROUP BY COALESCE(TRIM(sa.branch_name), 'غير محدد')
        ORDER BY total_qty DESC
      `, params);
      return r.rows.map(row => ({
        branch_name:      row.branch_name,
        total_qty:        Number(row.total_qty),
        total_returns:    Number(row.total_returns),
        active_customers: Number(row.active_customers),
        invoice_count:    Number(row.invoice_count),
        returns_pct:      Number(row.total_qty) > 0
          ? +(Number(row.total_returns) / Number(row.total_qty) * 100).toFixed(1)
          : 0,
      }));
    }

    async function branchMonthMatrix() {
      const { params, bSql, repSql, catSql } = periodParams();
      const r = await pool.query(`
        SELECT
          COALESCE(TRIM(sa.branch_name), 'غير محدد') AS branch_name,
          sa.month_num::int                            AS month_num,
          COALESCE(SUM(sa.qty),0)::bigint               AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint    AS total_returns,
          COALESCE(SUM(sa.net_revenue),0)::numeric      AS net_revenue
        FROM sales_activity sa
        WHERE ${catSql}${bSql}${repSql}
        GROUP BY COALESCE(TRIM(sa.branch_name), 'غير محدد'), sa.month_num
      `, params);
      return r.rows.map(row => ({
        branch_name:   row.branch_name,
        month_num:     row.month_num,
        total_qty:     Number(row.total_qty),
        total_returns: Number(row.total_returns),
        net_revenue:   Number(row.net_revenue),
      }));
    }

    const [t, trend, branches, branchMonth] = await Promise.all([
      totals(), fullTrend(), bestBranches(), branchMonthMatrix(),
    ]);

    res.json({
      period: {
        from_year: t.min_year || null,
        to_year:   t.max_year || null,
        months_count: trend.length,
      },
      totals: {
        total_qty:        Number(t.total_qty || 0),
        total_returns:    Number(t.total_returns || 0),
        net_revenue:      Number(t.net_revenue || 0),
        returns_pct:      Number(t.total_qty) > 0
          ? +(Number(t.total_returns) / Number(t.total_qty) * 100).toFixed(1)
          : 0,
        active_customers: Number(t.active_customers || 0),
        invoice_count:    Number(t.invoice_count || 0),
      },
      trend,
      branch_month_matrix: branchMonth,
      by_branch: branches,
      best_branch: branches[0] || null,
    });
  } catch (err) {
    console.error('[CategoryPerformance] overview:', err);
    res.status(500).json({ error: 'خطأ في جلب النظرة العامة' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/category-performance/filters
════════════════════════════════════════════════════════════ */
router.get('/filters', verifyToken, applyRegionFilter, requireCategory, async (req, res) => {
  const category = req.category;
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    let branch = null;
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);
    const params = [year];
    let p = 2;
    const cat = mkCategory(category, p, null);
    if (cat.val !== null) { params.push(cat.val); p = cat.p; }
    const catSql = cat.sql;
    const b = mkBranch(branch, p, null);
    if (b.val !== null) params.push(b.val);

    const { rows } = await pool.query(`
      SELECT DISTINCT
        COALESCE(TRIM(branch_name), '')   AS branch_name,
        COALESCE(TRIM(salesrep_name), '') AS salesrep_name
      FROM sales_activity
      WHERE report_year=$1
        AND ${catSql}
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
    console.error('[CategoryPerformance] filters:', err);
    res.status(500).json({ error: 'خطأ في جلب قوائم الفلترة' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/category-performance/customer-search?q=
   Search by customer name or code, across ALL categories.
════════════════════════════════════════════════════════════ */
router.get('/customer-search', verifyToken, applyRegionFilter, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });

  try {
    let branch = null;
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    const params = [`%${q}%`];
    const b = mkBranch(branch, 2, null);
    if (b.val !== null) params.push(b.val);

    const { rows } = await pool.query(`
      SELECT customer_code, MAX(customer_name) AS customer_name, MAX(TRIM(branch_name)) AS branch_name
      FROM sales_activity
      WHERE (customer_code ILIKE $1 OR customer_name ILIKE $1) ${b.sql}
      GROUP BY customer_code
      ORDER BY MAX(customer_name)
      LIMIT 20
    `, params);

    res.json({ results: rows });
  } catch (err) {
    console.error('[CategoryPerformance] customer-search:', err);
    res.status(500).json({ error: 'خطأ في البحث عن العميل' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/category-performance/customer/:code
   Full annual performance panel for one customer — across ALL
   categories (not scoped to the page's selected category filter),
   for a given year (default current year).
════════════════════════════════════════════════════════════ */
router.get('/customer/:code', verifyToken, applyRegionFilter, async (req, res) => {
  const code = req.params.code;
  const year = parseInt(req.query.year) || new Date().getFullYear();

  try {
    let branch = null;
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);
    const bParams = [];
    const b = mkBranch(branch, 1, null);
    if (b.val !== null) bParams.push(b.val);

    const infoRes = await pool.query(`
      SELECT customer_code, MAX(customer_name) AS customer_name,
             MAX(TRIM(branch_name)) AS branch_name, MAX(TRIM(salesrep_name)) AS salesrep_name
      FROM sales_activity
      WHERE customer_code = $1 ${b.sql}
      GROUP BY customer_code
    `, [code, ...bParams]);

    if (!infoRes.rowCount) return res.status(404).json({ error: 'لم يتم العثور على العميل' });

    const [monthlyRes, categoryRes, yearsRes] = await Promise.all([
      pool.query(`
        SELECT month_num::int AS month_num,
               COALESCE(SUM(qty),0)::bigint AS total_qty,
               COALESCE(SUM(bad_return_qty),0)::bigint AS total_returns,
               COALESCE(SUM(net_revenue),0)::numeric AS net_revenue
        FROM sales_activity
        WHERE customer_code = $1 AND report_year = $2 ${b.sql}
        GROUP BY month_num
        ORDER BY month_num
      `, [code, year, ...bParams]),
      pool.query(`
        SELECT COALESCE(NULLIF(TRIM(category_name), ''), 'غير محدد') AS category_name,
               COALESCE(SUM(qty),0)::bigint AS total_qty,
               COALESCE(SUM(bad_return_qty),0)::bigint AS total_returns
        FROM sales_activity
        WHERE customer_code = $1 AND report_year = $2 ${b.sql}
        GROUP BY COALESCE(NULLIF(TRIM(category_name), ''), 'غير محدد')
        ORDER BY total_qty DESC
      `, [code, year, ...bParams]),
      pool.query(`
        SELECT DISTINCT report_year::int AS y FROM sales_activity WHERE customer_code = $1 ${b.sql} ORDER BY y DESC
      `, [code, ...bParams]),
    ]);

    const monthMap = Object.fromEntries(monthlyRes.rows.map(r => [Number(r.month_num), r]));
    const months = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const row = monthMap[m];
      return {
        month_num: m,
        month_name: MONTH_AR[m],
        total_qty: row ? Number(row.total_qty) : 0,
        total_returns: row ? Number(row.total_returns) : 0,
        net_revenue: row ? Number(row.net_revenue) : 0,
      };
    });

    const totalQty     = months.reduce((s, m) => s + m.total_qty, 0);
    const totalReturns = months.reduce((s, m) => s + m.total_returns, 0);
    const totalRevenue = months.reduce((s, m) => s + m.net_revenue, 0);

    res.json({
      customer: infoRes.rows[0],
      year,
      available_years: yearsRes.rows.map(r => r.y),
      months,
      by_category: categoryRes.rows.map(r => ({
        category_name: r.category_name,
        total_qty: Number(r.total_qty),
        total_returns: Number(r.total_returns),
      })),
      totals: {
        total_qty: totalQty,
        total_returns: totalReturns,
        net_revenue: totalRevenue,
        returns_pct: totalQty > 0 ? +(totalReturns / totalQty * 100).toFixed(1) : 0,
      },
    });
  } catch (err) {
    console.error('[CategoryPerformance] customer detail:', err);
    res.status(500).json({ error: 'خطأ في جلب أداء العميل' });
  }
});

module.exports = router;
