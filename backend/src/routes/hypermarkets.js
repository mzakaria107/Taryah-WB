/**
 * hypermarkets.js — GET /api/hypermarkets/*
 * Performance analytics for the "Hypermarkets" sales category.
 * Data source: sales_activity WHERE category_name ILIKE 'Hypermarkets'
 */

const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter, requireRoles } = require('../middleware/auth');

const router = express.Router();
const ADMIN  = ['super_admin', 'it_admin'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/* ── Constants ────────────────────────────────────────────── */
const CATEGORY_FILTER = `LOWER(TRIM(COALESCE(sa.category_name, ''))) = 'hypermarkets'`;
const CAT_PLAIN       = `LOWER(TRIM(COALESCE(category_name, ''))) = 'hypermarkets'`;

const MONTH_AR = {
  1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
  7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
};

/* Branch-expense entries are labeled with an English chain name (e.g.
   "Carrefour"), but sales_activity has no branch_name or customer_name
   field spelled that way — branch_name there is a geographic region, and
   Carrefour stores are recorded as Arabic customer_name values like
   "كارفور الرياض بارك". This maps an expense branch_name to the Arabic
   substring that identifies its customers in sales_activity, so revenue
   reconciliation can filter the right rows instead of matching nothing. */
const BRANCH_CUSTOMER_ALIAS = {
  Carrefour: 'كارفور',
};

/* ── Shared helpers ────────────────────────────────────────── */
// regionId may be a single id or an array of ids (a user can now be
// assigned more than one region) — returns the flattened list of
// name_ar/name_en branch labels for all of them, or null if none.
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

/* Region filter as a REPEATED `branch_name` query key, so the caller can
   keep several regions at once or drop one and keep the rest — mkBranch()
   below already emits `= ANY($n::text[])` for an array, so this only needs
   to normalize the incoming param shape (single value, repeated values, or
   absent = "جميع المناطق"). De-duplicated; empty → null exactly like the
   old single-value branch_name did, so an unfiltered request is unchanged. */
function branchScope(query) {
  let v = query.branch_name;
  if (v == null) return null;
  if (!Array.isArray(v)) v = [v];
  const out = [...new Set(v.map(x => String(x).trim()).filter(Boolean))];
  return out.length ? (out.length === 1 ? out[0] : out) : null;
}

function mkBranch(branch, p, alias) {
  if (!branch) return { sql: '', val: null, p };
  const col = alias ? `${alias}.branch_name` : 'branch_name';
  if (Array.isArray(branch)) {
    return { sql: ` AND ${col} = ANY($${p}::text[])`, val: branch, p: p + 1 };
  }
  return { sql: ` AND ${col} = $${p}`, val: branch, p: p + 1 };
}

/* ── Period (year/month vs. explicit date range) helper ──────
   `period` is either { years:[...], months:[...] } (the page's normal
   multi-select filter) or { range: [dateFrom, dateTo] } (the calendar
   from/to override). Both consume exactly the next 1–2 slots of `params`
   and return a boolean SQL fragment — mirrors the exact pattern proven
   in discountShops.js (itself cloned from this file) and salesReport.js's
   /branch-summary (make_date reconstruction from report_year/month_num/
   day, day is NOT NULL on every row). */
function periodFragment(params, alias, period) {
  const a = alias ? `${alias}.` : '';
  if (period.range) {
    params.push(period.range[0], period.range[1]);
    const p = params.length;
    return `make_date(${a}report_year::int, ${a}month_num::int, ${a}day::int) BETWEEN $${p - 1}::date AND $${p}::date`;
  }
  params.push(period.years, period.months);
  const p = params.length;
  return `${a}report_year = ANY($${p - 1}::int[]) AND ${a}month_num = ANY($${p}::int[])`;
}

/* Parses ?date_from=&date_to= into { range: [from,to] } or null. */
function parseDateRange(query) {
  const dateFrom = (query.date_from || '').trim();
  const dateTo   = (query.date_to   || '').trim();
  if (!dateFrom || !dateTo) return { useRange: false, dateFrom: null, dateTo: null };
  return { useRange: true, dateFrom, dateTo };
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
// Same working-days rule (skip Friday only) applied to an explicit calendar
// range instead of a whole month; capped at "today" if the range runs into
// the future, same as workingDays() capping an in-progress current month.
function workingDaysInRange(fromStr, toStr) {
  const from = new Date(`${fromStr}T00:00:00`);
  const to   = new Date(`${toStr}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cap = to > today ? today : to;
  let n = 0;
  for (let d = new Date(from); d <= cap; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 5 && !isHoliday(d.getFullYear(), d.getMonth() + 1, d.getDate())) n++;
  }
  return Math.max(n, 1);
}

/* ════════════════════════════════════════════════════════════
   GET /api/hypermarkets/summary
   Full performance summary for the selected month, or for an
   explicit ?date_from=&date_to= calendar range which overrides
   the year/month selection entirely (see periodFragment above).
════════════════════════════════════════════════════════════ */
router.get('/summary', verifyToken, applyRegionFilter, async (req, res) => {
  /* Accept either a single ?year= or a multi-select ?years=2024,2025,2026.
     When multiple years are selected, "cur" aggregates the given month
     summed across all of them; the prev-month comparison is disabled
     (there's no single unambiguous "previous period" for a year set) by
     passing an empty prev-years array — every prev query then naturally
     returns zero rows, and the existing null-guarded deviation math
     already renders "—" for those fields without any special-casing. */
  const yearsParam = (req.query.years || '').trim();
  const yearsArr = yearsParam
    ? [...new Set(yearsParam.split(',').map(s => parseInt(s.trim())).filter(Boolean))]
    : [parseInt(req.query.year) || new Date().getFullYear()];
  const isMultiYear = yearsArr.length > 1;
  const year  = yearsArr[0];

  /* Same multi-select treatment as years: accept ?months=6,7,8 or a single
     ?month=. With several months selected, "cur" sums all of them and the
     prev-period comparison is disabled the same way (empty prev array →
     every prev query naturally returns zero, deviations render "—"). */
  const monthsParam = (req.query.months || '').trim();
  const monthsArr = monthsParam
    ? [...new Set(monthsParam.split(',').map(s => parseInt(s.trim())).filter(Boolean))]
    : [parseInt(req.query.month) || (new Date().getMonth() + 1)];
  const isMultiMonth = monthsArr.length > 1;
  const month = monthsArr[0];
  const isMultiPeriod = isMultiYear || isMultiMonth;

  /* An explicit calendar range overrides year/month entirely and can span
     multiple months/years — same pattern as discountShops.js /summary. */
  const { useRange, dateFrom, dateTo } = parseDateRange(req.query);
  if (useRange && dateTo < dateFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });

  const rep = (req.query.salesrep_name || '').trim() || null;

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;
  const disablePrev   = isMultiPeriod || useRange;
  const prevYearsArr  = disablePrev ? [] : [prevYear];
  const prevMonthsArr = disablePrev ? [] : [prevMonth];

  const curPeriod  = useRange ? { range: [dateFrom, dateTo] } : { years: yearsArr, months: monthsArr };
  const prevPeriod = { years: prevYearsArr, months: prevMonthsArr };

  const wdCur  = useRange
    ? workingDaysInRange(dateFrom, dateTo)
    : yearsArr.reduce((s, y) => s + monthsArr.reduce((s2, m) => s2 + workingDays(y, m), 0), 0);
  const wdPrev = disablePrev ? 0 : workingDays(prevYear, prevMonth);

  try {
    let branch = branchScope(req.query);
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    /* ── Build base WHERE params for a period (current or prev) ── */
    function baseParams(period, extraRep) {
      const params = [];
      const periodSql = periodFragment(params, 'sa', period);
      const b = mkBranch(branch, params.length + 1, 'sa');
      if (b.val !== null) params.push(b.val);
      const r = extraRep || rep;
      if (r) params.push(r);
      const repSql = r ? ` AND sa.salesrep_name = $${params.length}` : '';
      return { params, periodSql, bSql: b.sql, repSql };
    }

    /* ── Helper: main aggregate for a period ────────────────
       active_customers = any invoice (no qty filter)
       inactive_customers = SUM(qty) <= 0                       */
    async function monthAgg(period) {
      const { params, periodSql, bSql, repSql } = baseParams(period);
      const r = await pool.query(`
        WITH cust AS (
          SELECT sa.customer_code, SUM(sa.qty) AS net_qty
          FROM sales_activity sa
          WHERE ${periodSql}
            AND ${CATEGORY_FILTER}${bSql}${repSql}
          GROUP BY sa.customer_code
        )
        SELECT
          COUNT(*)::int                                  AS active_customers,
          COUNT(CASE WHEN net_qty <= 0 THEN 1 END)::int  AS inactive_customers,
          (SELECT COALESCE(SUM(qty),0)::bigint
           FROM sales_activity sa
           WHERE ${periodSql}
             AND ${CATEGORY_FILTER}${bSql}${repSql})     AS total_qty,
          (SELECT COALESCE(SUM(bad_return_qty),0)::bigint
           FROM sales_activity sa
           WHERE ${periodSql}
             AND ${CATEGORY_FILTER}${bSql}${repSql})     AS total_returns
        FROM cust
      `, params);
      return r.rows[0] ?? { active_customers:0, inactive_customers:0, total_qty:0, total_returns:0 };
    }

    /* ── Helper: customer codes present in a period ─────────── */
    async function codesInMonth(period) {
      const { params, periodSql, bSql, repSql } = baseParams(period);
      const r = await pool.query(`
        SELECT DISTINCT customer_code
        FROM sales_activity sa
        WHERE ${periodSql}
          AND ${CATEGORY_FILTER}${bSql}${repSql}
      `, params);
      return new Set(r.rows.map(x => x.customer_code));
    }

    /* ── Helper: new customers this period (not seen before it) ──
       "Earlier" means an earlier (year, month) than the EARLIEST of the
       selected years/months, or (in range mode) any date before the
       range's start — computed as a tuple/date comparison so it works
       correctly regardless of how many years/months are selected. */
    async function newCustCount(period) {
      const { params, periodSql, bSql, repSql } = baseParams(period);
      let cutoffSql;
      if (period.range) {
        params.push(period.range[0]);
        cutoffSql = `make_date(report_year::int, month_num::int, day::int) < $${params.length}::date`;
      } else {
        const earliestYear  = period.years.length ? Math.min(...period.years) : 0;
        const earliestMonth = period.months.length ? Math.min(...period.months) : 0;
        cutoffSql = `(report_year < ${earliestYear} OR (report_year = ${earliestYear} AND month_num < ${earliestMonth}))`;
      }
      const r = await pool.query(`
        SELECT COUNT(DISTINCT customer_code)::int AS cnt
        FROM sales_activity sa
        WHERE ${periodSql}
          AND ${CATEGORY_FILTER}${bSql}${repSql}
          AND customer_code NOT IN (
            SELECT DISTINCT customer_code FROM sales_activity
            WHERE ${cutoffSql}
              AND ${CAT_PLAIN}
          )
      `, params);
      return Number(r.rows[0]?.cnt || 0);
    }

    /* ── Helper: monthly trend ──────────────────────────────
       Normal mode: every month of the selected year(s) (unfiltered by
       month, so the chart shows the whole year around the selection).
       Range mode: scoped to the explicit date range, still grouped by
       month_num — the same "sum across selected years by month_num"
       simplification the multi-year path already uses. */
    async function monthlyTrend() {
      const trendParams = [];
      let periodSql;
      if (useRange) {
        trendParams.push(dateFrom, dateTo);
        periodSql = `make_date(sa.report_year::int, sa.month_num::int, sa.day::int) BETWEEN $1::date AND $2::date`;
      } else {
        trendParams.push(yearsArr);
        periodSql = `sa.report_year = ANY($1::int[])`;
      }
      const b = mkBranch(branch, trendParams.length + 1, 'sa');
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
        WHERE ${periodSql}
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
    async function byRegion(period) {
      const { params, periodSql, bSql, repSql } = baseParams(period);
      const r = await pool.query(`
        SELECT
          COALESCE(TRIM(sa.branch_name), 'غير محدد') AS branch_name,
          COUNT(DISTINCT sa.customer_code)::int        AS active_customers,
          COALESCE(SUM(sa.qty),0)::bigint              AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS total_returns
        FROM sales_activity sa
        WHERE ${periodSql}
          AND ${CATEGORY_FILTER}${bSql}${repSql}
        GROUP BY COALESCE(TRIM(sa.branch_name), 'غير محدد')
        ORDER BY total_qty DESC
      `, params);
      return r.rows;
    }

    /* ── Helper: per-rep breakdown ─────────────────────────── */
    async function byRep(period) {
      const { params, periodSql, bSql, repSql } = baseParams(period);
      const r = await pool.query(`
        SELECT
          TRIM(sa.salesrep_name)                      AS salesrep_name,
          COALESCE(TRIM(sa.branch_name), 'غير محدد')  AS branch_name,
          COUNT(DISTINCT sa.customer_code)::int        AS active_customers,
          COALESCE(SUM(sa.qty),0)::bigint              AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS total_returns
        FROM sales_activity sa
        WHERE ${periodSql}
          AND ${CATEGORY_FILTER}${bSql}${repSql}
          AND sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) != ''
        GROUP BY TRIM(sa.salesrep_name), COALESCE(TRIM(sa.branch_name), 'غير محدد')
        ORDER BY total_qty DESC
      `, params);
      return r.rows;
    }

    /* ── Helper: per-item breakdown (top/bottom sellers) ───── */
    async function byItem(period) {
      const { params, periodSql, bSql, repSql } = baseParams(period);
      const r = await pool.query(`
        SELECT
          COALESCE(NULLIF(TRIM(sa.item_name_en), ''), 'غير محدد')     AS item_name,
          COALESCE(NULLIF(TRIM(sa.item_category_en), ''), 'غير محدد') AS item_category,
          COALESCE(SUM(sa.qty),0)::bigint              AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS total_returns,
          COUNT(DISTINCT sa.invoice_number)::int                                 AS invoice_count
        FROM sales_activity sa
        WHERE ${periodSql}
          AND ${CATEGORY_FILTER}${bSql}${repSql}
        GROUP BY
          COALESCE(NULLIF(TRIM(sa.item_name_en), ''), 'غير محدد'),
          COALESCE(NULLIF(TRIM(sa.item_category_en), ''), 'غير محدد')
        ORDER BY total_qty DESC
      `, params);
      return r.rows;
    }

    /* ── Helper: top customers ─────────────────────────────── */
    async function topCustomers(period) {
      const { params, periodSql, bSql, repSql } = baseParams(period);
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
        WHERE ${periodSql}
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
      itemCur, itemPrev,
    ] = await Promise.all([
      monthAgg(curPeriod),
      monthAgg(prevPeriod),
      codesInMonth(curPeriod),
      codesInMonth(prevPeriod),
      monthlyTrend(),
      byRegion(curPeriod),
      byRegion(prevPeriod),
      byRep(curPeriod),
      byRep(prevPeriod),
      topCustomers(curPeriod),
      newCustCount(curPeriod),
      byItem(curPeriod),
      byItem(prevPeriod),
    ]);

    const stoppedCount = [...codesPrev].filter(c => !codesCur.has(c)).length;

    /* ── Merge prev qty into region/rep/item rows ──────────── */
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
        category: 'Hypermarkets',
        use_date_range: useRange, date_from: dateFrom, date_to: dateTo,
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
    console.error('[Hypermarkets]', err);
    res.status(500).json({ error: 'خطأ في جلب بيانات Hypermarkets' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/hypermarkets/customer-matrix
   Whole-period monthly sales/returns/revenue matrix per customer
   (summed across every year present) — rows are the top N
   customers by period qty, columns are months 1-12. Each row
   also carries the customer's branch_name.
   Honors branch_name / salesrep_name filters.
════════════════════════════════════════════════════════════ */
router.get('/customer-matrix', verifyToken, applyRegionFilter, async (req, res) => {
  const rep   = (req.query.salesrep_name || '').trim() || null;
  const limit = Math.min(parseInt(req.query.limit) || 25, 50);
  const { useRange, dateFrom, dateTo } = parseDateRange(req.query);
  if (useRange && dateTo < dateFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });

  try {
    let branch = branchScope(req.query);
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    const params = [];
    let dateSql = '';
    if (useRange) {
      params.push(dateFrom, dateTo);
      dateSql = ` AND make_date(sa.report_year::int, sa.month_num::int, sa.day::int) BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
    }
    const b = mkBranch(branch, params.length + 1, 'sa');
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
      WHERE ${CATEGORY_FILTER}${dateSql}${b.sql}${repSql}
      GROUP BY sa.customer_code, sa.month_num
    `, params);

    /* ── Pivot rows → { customer_code → { name, branch, months[12], annual totals } } ── */
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
    console.error('[Hypermarkets] customer-matrix:', err);
    res.status(500).json({ error: 'خطأ في جلب مصفوفة العملاء' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/hypermarkets/item-overview
   Whole-period (every year present, no month/year filter) totals
   per item — powers the "كامل الفترة" best/worst sellers cards.
   Honors branch_name / salesrep_name filters.
════════════════════════════════════════════════════════════ */
router.get('/item-overview', verifyToken, applyRegionFilter, async (req, res) => {
  const rep = (req.query.salesrep_name || '').trim() || null;
  const { useRange, dateFrom, dateTo } = parseDateRange(req.query);
  if (useRange && dateTo < dateFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });

  try {
    let branch = branchScope(req.query);
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    const params = [];
    let dateSql = '';
    if (useRange) {
      params.push(dateFrom, dateTo);
      dateSql = ` AND make_date(sa.report_year::int, sa.month_num::int, sa.day::int) BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
    }
    const b = mkBranch(branch, params.length + 1, 'sa');
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
      WHERE ${CATEGORY_FILTER}${dateSql}${b.sql}${repSql}
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
    console.error('[Hypermarkets] item-overview:', err);
    res.status(500).json({ error: 'خطأ في جلب إجمالي الأصناف لكامل الفترة' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/hypermarkets/item-matrix
   Monthly sales/returns matrix per item for a given year — rows
   are the top N items (by annual qty), columns are months 1-12.
   Honors branch_name / salesrep_name filters.
════════════════════════════════════════════════════════════ */
router.get('/item-matrix', verifyToken, applyRegionFilter, async (req, res) => {
  const year  = parseInt(req.query.year) || new Date().getFullYear();
  const rep   = (req.query.salesrep_name || '').trim() || null;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const { useRange, dateFrom, dateTo } = parseDateRange(req.query);
  if (useRange && dateTo < dateFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });

  try {
    let branch = branchScope(req.query);
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    const params = [];
    let periodSql;
    if (useRange) {
      params.push(dateFrom, dateTo);
      periodSql = `make_date(sa.report_year::int, sa.month_num::int, sa.day::int) BETWEEN $1::date AND $2::date`;
    } else {
      params.push(year);
      periodSql = `sa.report_year=$1`;
    }
    const b = mkBranch(branch, params.length + 1, 'sa');
    if (b.val !== null) params.push(b.val);
    if (rep) params.push(rep);
    const repSql = rep ? ` AND sa.salesrep_name = $${params.length}` : '';

    /* One row per (item, month) — aggregated in JS into a matrix
       so the whole year comes back in a single query. */
    const r = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(sa.item_name_en), ''), 'غير محدد')     AS item_name,
        COALESCE(NULLIF(TRIM(sa.item_category_en), ''), 'غير محدد') AS item_category,
        sa.month_num::int                            AS month_num,
        COALESCE(SUM(sa.qty),0)::bigint               AS total_qty,
        COALESCE(SUM(sa.bad_return_qty),0)::bigint    AS total_returns
      FROM sales_activity sa
      WHERE ${periodSql}
        AND ${CATEGORY_FILTER}${b.sql}${repSql}
      GROUP BY
        COALESCE(NULLIF(TRIM(sa.item_name_en), ''), 'غير محدد'),
        COALESCE(NULLIF(TRIM(sa.item_category_en), ''), 'غير محدد'),
        sa.month_num
    `, params);

    /* ── Pivot rows → { item_name → { category, months[12], annual_qty, annual_returns } } ── */
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
    console.error('[Hypermarkets] item-matrix:', err);
    res.status(500).json({ error: 'خطأ في جلب مصفوفة الأصناف' });
  }
});

/* ════════════════════════════════════════════════════════════
   Branch monthly expenses (e.g. Carrefour fixed rebate / sell-out /
   creation-vendor & marketing support credit notes), deducted from
   that branch's net revenue everywhere it's shown.
════════════════════════════════════════════════════════════ */
const EXP_MONTH_MAP = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

// GET /api/hypermarkets/branch-expenses?branch_name=&year=
router.get('/branch-expenses', verifyToken, async (req, res) => {
  const branch = (req.query.branch_name || '').trim() || null;
  const year   = req.query.year ? parseInt(req.query.year) : null;
  try {
    const clauses = [];
    const params  = [];
    if (branch) { params.push(branch); clauses.push(`branch_name = $${params.length}`); }
    if (year)   { params.push(year);   clauses.push(`report_year = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT * FROM branch_monthly_expenses ${where} ORDER BY branch_name, report_year, month_num`,
      params
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[Hypermarkets] branch-expenses GET:', err);
    res.status(500).json({ error: 'خطأ في جلب مصروفات الفروع' });
  }
});

// POST /api/hypermarkets/branch-expenses/upload  (Excel/CSV)
// Expected columns: Month name (e.g. "Nov-25"), Fixed rebate, sell out,
// creation vendor & marketing support, Total credit note, notes.
// An optional "Branch" column may override the default (Carrefour).
router.post('/branch-expenses/upload', verifyToken, requireRoles(...ADMIN), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });
  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    // raw:false renders each cell using its display format — critical here
    // because Excel often stores a "Month name" column like "Nov-25" as a
    // date-typed cell, which would otherwise come back as a bare serial
    // number (e.g. 45962) instead of parseable text.
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
    if (!rows.length) return res.status(400).json({ error: 'الملف فارغ' });

    const sampleKeys = Object.keys(rows[0]);
    const findKey = (needle) => sampleKeys.find(k =>
      k.replace(/^﻿/, '').trim().toLowerCase().includes(needle)
    );
    const COL_MONTH    = findKey('month');
    const COL_REBATE   = findKey('fixed rebate');
    const COL_SELLOUT  = findKey('sell out');
    const COL_MARKETING = findKey('creation vendor');
    const COL_TOTAL    = findKey('total credit note');
    const COL_NOTES    = findKey('notes');
    const COL_BRANCH   = findKey('branch');

    const num = (v) => parseFloat(String(v || '0').replace(/,/g, '').trim()) || 0;

    const toSave = [];
    const errors = [];
    rows.forEach((row, i) => {
      const monthRaw = String(row[COL_MONTH] || '').trim();
      if (!monthRaw || monthRaw.toLowerCase() === 'total') return; // skip blank/total row

      const m = monthRaw.match(/^([A-Za-z]{3})[a-z]*[-\s](\d{2,4})$/);
      if (!m) { errors.push(`صف ${i + 2}: تعذّر فهم الشهر "${monthRaw}"`); return; }
      const monthNum = EXP_MONTH_MAP[m[1].toLowerCase()];
      if (!monthNum) { errors.push(`صف ${i + 2}: اسم شهر غير معروف "${m[1]}"`); return; }
      const yy = m[2].length === 2 ? 2000 + parseInt(m[2], 10) : parseInt(m[2], 10);

      toSave.push({
        branch_name:               (COL_BRANCH && String(row[COL_BRANCH] || '').trim()) || 'Carrefour',
        report_year:               yy,
        month_num:                 monthNum,
        fixed_rebate:              num(row[COL_REBATE]),
        sell_out:                  num(row[COL_SELLOUT]),
        creation_vendor_marketing: num(row[COL_MARKETING]),
        total_credit_note:         num(row[COL_TOTAL]),
        notes:                     String(row[COL_NOTES] || '').trim() || null,
      });
    });

    if (!toSave.length)
      return res.status(400).json({ error: 'لا توجد صفوف صالحة', errors });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of toSave) {
        await client.query(
          `INSERT INTO branch_monthly_expenses
             (branch_name, report_year, month_num, fixed_rebate, sell_out,
              creation_vendor_marketing, total_credit_note, notes, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (branch_name, report_year, month_num) DO UPDATE SET
             fixed_rebate              = EXCLUDED.fixed_rebate,
             sell_out                  = EXCLUDED.sell_out,
             creation_vendor_marketing = EXCLUDED.creation_vendor_marketing,
             total_credit_note         = EXCLUDED.total_credit_note,
             notes                     = EXCLUDED.notes,
             uploaded_by               = EXCLUDED.uploaded_by,
             uploaded_at               = NOW()`,
          [row.branch_name, row.report_year, row.month_num, row.fixed_rebate, row.sell_out,
           row.creation_vendor_marketing, row.total_credit_note, row.notes, req.user.id]
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true, saved: toSave.length, errors });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[Hypermarkets] branch-expenses upload:', err);
    res.status(500).json({ error: 'خطأ في رفع مصروفات الفروع' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/hypermarkets/overview
   Whole-period performance (no year/month filter): monthly trend
   across every year of data, best-performing branches, and total
   invoice count. Honors branch_name / salesrep_name filters.
════════════════════════════════════════════════════════════ */
router.get('/overview', verifyToken, applyRegionFilter, async (req, res) => {
  const rep = (req.query.salesrep_name || '').trim() || null;

  try {
    let branch = branchScope(req.query);
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    /* ── Build filter clause (no year/month) ────────────────── */
    function periodParams() {
      const params = [];
      const b = mkBranch(branch, 1, 'sa');
      if (b.val !== null) params.push(b.val);
      if (rep) params.push(rep);
      const repSql = rep ? ` AND sa.salesrep_name = $${params.length}` : '';
      return { params, bSql: b.sql, repSql };
    }

    /* ── Totals across the whole period ─────────────────────── */
    async function totals() {
      const { params, bSql, repSql } = periodParams();
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
        WHERE ${CATEGORY_FILTER}${bSql}${repSql}
      `, params);
      return r.rows[0] ?? {};
    }

    /* ── Monthly trend across every year present ────────────── */
    async function fullTrend() {
      const { params, bSql, repSql } = periodParams();
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
        WHERE ${CATEGORY_FILTER}${bSql}${repSql}
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

    /* ── Best branches ranking (whole period) ───────────────── */
    async function bestBranches() {
      const { params, bSql, repSql } = periodParams();
      const r = await pool.query(`
        SELECT
          COALESCE(TRIM(sa.branch_name), 'غير محدد') AS branch_name,
          COALESCE(SUM(sa.qty),0)::bigint              AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS total_returns,
          COUNT(DISTINCT sa.customer_code)::int         AS active_customers,
          COUNT(DISTINCT sa.invoice_number)::int                                 AS invoice_count
        FROM sales_activity sa
        WHERE ${CATEGORY_FILTER}${bSql}${repSql}
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

    /* ── Branch × month matrix (summed across every year present) ── */
    async function branchMonthMatrix() {
      const { params, bSql, repSql } = periodParams();
      const r = await pool.query(`
        SELECT
          COALESCE(TRIM(sa.branch_name), 'غير محدد') AS branch_name,
          sa.month_num::int                            AS month_num,
          COALESCE(SUM(sa.qty),0)::bigint               AS total_qty,
          COALESCE(SUM(sa.bad_return_qty),0)::bigint    AS total_returns,
          COALESCE(SUM(sa.net_revenue),0)::numeric      AS net_revenue
        FROM sales_activity sa
        WHERE ${CATEGORY_FILTER}${bSql}${repSql}
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

    /* ── Branch monthly expenses (e.g. Carrefour rebate credit notes) —
       deducted from net_revenue everywhere it's reported below. ── */
    async function branchExpenses() {
      const params = [];
      let where = '';
      if (branch) {
        const vals = Array.isArray(branch) ? branch : [branch];
        params.push(vals);
        where = `WHERE branch_name = ANY($1::text[])`;
      }
      const r = await pool.query(
        `SELECT branch_name, report_year, month_num,
                fixed_rebate, sell_out, creation_vendor_marketing, total_credit_note
         FROM branch_monthly_expenses ${where}`,
        params
      );
      return r.rows.map(row => ({
        branch_name:               row.branch_name,
        year:                      row.report_year,
        month_num:                 row.month_num,
        fixed_rebate:              Number(row.fixed_rebate),
        sell_out:                  Number(row.sell_out),
        creation_vendor_marketing: Number(row.creation_vendor_marketing),
        amount:                    Number(row.total_credit_note),
      }));
    }

    /* ── Revenue actually attributable to each expense branch (e.g. the
       real Carrefour-only revenue, matched by customer_name since it
       isn't a sales_activity branch_name), summed by calendar month
       across every year — powers the revenue-reconciliation rows under
       the expense matrix. ── */
    async function expenseBranchRevenue(branchNames) {
      const out = [];
      for (const bName of branchNames) {
        const alias = BRANCH_CUSTOMER_ALIAS[bName];
        const params = [alias ? `%${alias}%` : `%${bName}%`];
        const matchCol = alias ? 'sa.customer_name' : 'sa.branch_name';
        const r = await pool.query(
          `SELECT sa.month_num::int AS month_num, COALESCE(SUM(sa.net_revenue),0)::numeric AS gross_revenue
           FROM sales_activity sa
           WHERE ${CATEGORY_FILTER} AND ${matchCol} ILIKE $1
           GROUP BY sa.month_num`,
          params
        );
        r.rows.forEach(row => {
          out.push({ branch_name: bName, month_num: row.month_num, gross_revenue: Number(row.gross_revenue) });
        });
      }
      return out;
    }

    const [t, trend, branches, branchMonth, expenses] = await Promise.all([
      totals(), fullTrend(), bestBranches(), branchMonthMatrix(), branchExpenses(),
    ]);
    const expenseBranchNames = [...new Set(expenses.map(e => e.branch_name))];
    const branchRevenue = await expenseBranchRevenue(expenseBranchNames);

    /* ── Apply deductions ────────────────────────────────────── */
    const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0);
    // trend rows are keyed by (year, month); branchMonth rows are already
    // summed across every year for a given (branch, month) — so they need
    // a year-agnostic lookup.
    const expenseByYearMonth       = {};
    const expenseByBranchMonthAny  = {};
    expenses.forEach(e => {
      const ymKey = `${e.year}-${e.month_num}`;
      expenseByYearMonth[ymKey] = (expenseByYearMonth[ymKey] || 0) + e.amount;
      const bmKey = `${e.branch_name}-${e.month_num}`;
      expenseByBranchMonthAny[bmKey] = (expenseByBranchMonthAny[bmKey] || 0) + e.amount;
    });

    const trendWithDeduction = trend.map(t2 => ({
      ...t2,
      net_revenue: t2.net_revenue - (expenseByYearMonth[`${t2.year}-${t2.month_num}`] || 0),
    }));
    const branchMonthWithDeduction = branchMonth.map(c => ({
      ...c,
      gross_revenue: c.net_revenue, // raw SUM(sa.net_revenue), independent of any expense deduction
      net_revenue: c.net_revenue - (expenseByBranchMonthAny[`${c.branch_name}-${c.month_num}`] || 0),
    }));

    /* ── Expense (credit note) matrix — branch × month, summed across
       every year present, for the "توزيع الخصومات بالأشهر" matrix ── */
    const expenseMonthMap = {};
    expenses.forEach(e => {
      const key = `${e.branch_name}-${e.month_num}`;
      if (!expenseMonthMap[key]) {
        expenseMonthMap[key] = {
          branch_name: e.branch_name,
          month_num:   e.month_num,
          fixed_rebate: 0, sell_out: 0, creation_vendor_marketing: 0, total_credit_note: 0,
        };
      }
      const entry = expenseMonthMap[key];
      entry.fixed_rebate              += e.fixed_rebate;
      entry.sell_out                  += e.sell_out;
      entry.creation_vendor_marketing += e.creation_vendor_marketing;
      entry.total_credit_note         += e.amount;
    });
    const expenseMonthMatrix = Object.values(expenseMonthMap);

    res.json({
      period: {
        from_year: t.min_year || null,
        to_year:   t.max_year || null,
        months_count: trend.length,
      },
      totals: {
        total_qty:        Number(t.total_qty || 0),
        total_returns:    Number(t.total_returns || 0),
        gross_revenue:    Number(t.net_revenue || 0),
        total_credit_notes: expenseTotal,
        net_revenue:      Number(t.net_revenue || 0) - expenseTotal,
        returns_pct:      Number(t.total_qty) > 0
          ? +(Number(t.total_returns) / Number(t.total_qty) * 100).toFixed(1)
          : 0,
        active_customers: Number(t.active_customers || 0),
        invoice_count:    Number(t.invoice_count || 0),
      },
      trend: trendWithDeduction,
      branch_month_matrix: branchMonthWithDeduction,
      expense_month_matrix: expenseMonthMatrix,
      expense_branch_revenue: branchRevenue,
      by_branch: branches,
      best_branch: branches[0] || null,
    });
  } catch (err) {
    console.error('[Hypermarkets] overview:', err);
    res.status(500).json({ error: 'خطأ في جلب النظرة العامة' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/hypermarkets/filters
════════════════════════════════════════════════════════════ */
router.get('/filters', verifyToken, applyRegionFilter, async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const { useRange, dateFrom, dateTo } = parseDateRange(req.query);
  if (useRange && dateTo < dateFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });
  try {
    let branch = null;
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    const params = [];
    let periodSql;
    if (useRange) {
      params.push(dateFrom, dateTo);
      periodSql = `make_date(report_year::int, month_num::int, day::int) BETWEEN $1::date AND $2::date`;
    } else {
      params.push(year);
      periodSql = `report_year=$1`;
    }
    const b = mkBranch(branch, params.length + 1, null);
    if (b.val !== null) params.push(b.val);

    const { rows } = await pool.query(`
      SELECT DISTINCT
        COALESCE(TRIM(branch_name), '')   AS branch_name,
        COALESCE(TRIM(salesrep_name), '') AS salesrep_name
      FROM sales_activity
      WHERE ${periodSql}
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
