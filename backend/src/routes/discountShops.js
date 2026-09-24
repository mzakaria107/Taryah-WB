/**
 * discountShops.js — GET /api/discount-shops/*
 * Performance analytics for the "Discount Shops" customer set — an
 * EXPLICIT, DB-backed list of customer_codes (NOT sales_activity's
 * category_name field: most of these customers actually carry
 * category_name = 'Poultry Shops' / 'Groceries' / 'Restaurant' rather
 * than 'Discount Shops', so filtering on category_name would silently
 * miss most of the intended set).
 * Data source: sales_activity WHERE customer_code IN (SELECT customer_code
 * FROM discount_shop_customers) — the list itself lives in the
 * `discount_shop_customers` table (migration 087, seeded with the original
 * hardcoded 40-customer segment) and can be refreshed from the page via
 * POST /customer-list/upload (admin-only, full TRUNCATE + INSERT replace).
 */

const express = require('express');
const xlsx    = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const pool    = require('../db/pool');
const upload  = require('../middleware/upload');
const { verifyToken, applyRegionFilter, requireRoles } = require('../middleware/auth');

const router = express.Router();

/* ── Constants ────────────────────────────────────────────── */
// The customer_code segment now lives in the discount_shop_customers table
// (see migration 087) instead of a hardcoded JS array, so it can be
// refreshed periodically via POST /customer-list/upload without a code
// deploy. These two fragments are still built once as plain SQL strings —
// every call site below just interpolates them as a boolean condition,
// unchanged from the old hardcoded-array version.
const CATEGORY_FILTER = `sa.customer_code IN (SELECT customer_code FROM discount_shop_customers)`;
const CAT_PLAIN       = `customer_code IN (SELECT customer_code FROM discount_shop_customers)`;

const MONTH_AR = {
  1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
  7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
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
   and return a boolean SQL fragment — mirrors the exact pattern already
   proven in salesReport.js's /branch-summary (make_date reconstruction
   from report_year/month_num/day, day is NOT NULL on every row). */
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
   GET /api/discount-shops/summary
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
     multiple months/years — same pattern as salesReport.js /branch-summary. */
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
        category: 'Discount Shops',
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
    console.error('[DiscountShops]', err);
    res.status(500).json({ error: 'خطأ في جلب بيانات محلات التخفيضات' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/discount-shops/customer-matrix
   Whole-period monthly sales/returns/revenue matrix per customer
   (summed across every year present, or narrowed to an explicit
   ?date_from=&date_to= range) — rows are the top N customers by
   period qty, columns are months 1-12. Each row also carries the
   customer's branch_name. Honors branch_name / salesrep_name filters.
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
    console.error('[DiscountShops] customer-matrix:', err);
    res.status(500).json({ error: 'خطأ في جلب مصفوفة العملاء' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/discount-shops/item-overview
   Whole-period totals per item (or narrowed to an explicit
   ?date_from=&date_to= range) — powers the "كامل الفترة" best/worst
   sellers cards. Honors branch_name / salesrep_name filters.
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
    console.error('[DiscountShops] item-overview:', err);
    res.status(500).json({ error: 'خطأ في جلب إجمالي الأصناف لكامل الفترة' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/discount-shops/item-matrix
   Monthly sales/returns matrix per item for a given year, or for
   an explicit ?date_from=&date_to= range (which overrides ?year=)
   — rows are the top N items (by qty), columns are months 1-12.
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
    console.error('[DiscountShops] item-matrix:', err);
    res.status(500).json({ error: 'خطأ في جلب مصفوفة الأصناف' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/discount-shops/overview
   Trend/branches/matrix performance: monthly trend, best-performing
   branches, and branch×month matrix. Honors branch_name /
   salesrep_name filters, plus the SAME optional period filter every
   other tab on this page uses — ?years=/?months= (CSV or repeated,
   same convention as /summary), or ?date_from=&date_to= which
   overrides years/months entirely and can span multiple months/years
   (same make_date() pattern as /summary and /chilled-chicken-baseline).
   Omitting all three means "no filter, whole period" — unchanged
   from this route's original behavior, and still what a direct API
   call with no params gets; the page always sends its live filter
   state, so in practice this tab now tracks whatever period is
   selected elsewhere on the page instead of always showing every
   year of history.
   NOTE: unlike hypermarkets.js this has no branch-expenses
   deduction — branch_monthly_expenses (fixed rebate / sell-out /
   vendor marketing / credit notes) is a Hypermarkets-only trade-
   terms concept with no category dimension, so net_revenue here
   is simply the raw SUM(sa.net_revenue).
════════════════════════════════════════════════════════════ */
router.get('/overview', verifyToken, applyRegionFilter, async (req, res) => {
  const rep = (req.query.salesrep_name || '').trim() || null;

  const { useRange, dateFrom, dateTo } = parseDateRange(req.query);
  if (useRange && dateTo < dateFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });

  const yearsParam = (req.query.years || '').trim();
  const yearsArr = yearsParam
    ? [...new Set(yearsParam.split(',').map(s => parseInt(s.trim())).filter(Boolean))]
    : null;
  const monthsParam = (req.query.months || '').trim();
  const monthsArr = monthsParam
    ? [...new Set(monthsParam.split(',').map(s => parseInt(s.trim())).filter(Boolean))]
    : null;
  const hasPeriodFilter = useRange || (yearsArr && yearsArr.length) || (monthsArr && monthsArr.length);

  try {
    let branch = branchScope(req.query);
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    /* ── Build filter clause, optionally narrowed to a period ── */
    function periodParams() {
      const params = [];
      let periodSql = '';
      if (useRange) {
        params.push(dateFrom, dateTo);
        periodSql = ` AND make_date(sa.report_year::int, sa.month_num::int, sa.day::int) BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
      } else {
        if (yearsArr && yearsArr.length)  { params.push(yearsArr);  periodSql += ` AND sa.report_year = ANY($${params.length}::int[])`; }
        if (monthsArr && monthsArr.length) { params.push(monthsArr); periodSql += ` AND sa.month_num = ANY($${params.length}::int[])`; }
      }
      const b = mkBranch(branch, params.length + 1, 'sa');
      if (b.val !== null) params.push(b.val);
      if (rep) params.push(rep);
      const repSql = rep ? ` AND sa.salesrep_name = $${params.length}` : '';
      return { params, bSql: `${periodSql}${b.sql}`, repSql };
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

    /* ── Company-wide totals for the SAME period/branch/rep scope, but
       WITHOUT the discount-shop customer restriction — the denominator
       for "what share of total sales is this segment" on the KPI cards.
       Reuses periodParams() so the two totals are guaranteed to compare
       the exact same period/branch/rep slice, just with vs. without the
       CATEGORY_FILTER. ── */
    async function companyTotals() {
      const { params, bSql, repSql } = periodParams();
      const r = await pool.query(`
        SELECT
          COALESCE(SUM(sa.qty),0)::bigint          AS total_qty,
          COALESCE(SUM(sa.net_revenue),0)::numeric  AS net_revenue
        FROM sales_activity sa
        WHERE TRUE${bSql}${repSql}
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

    const [t, company, trend, branches, branchMonth] = await Promise.all([
      totals(), companyTotals(), fullTrend(), bestBranches(), branchMonthMatrix(),
    ]);
    const companyQty = Number(company.total_qty || 0);
    const companyRevenue = Number(company.net_revenue || 0);

    // No branch_monthly_expenses deduction here (see file header note) —
    // gross_revenue and net_revenue are identical for Discount Shops.
    const branchMonthWithGross = branchMonth.map(c => ({
      ...c,
      gross_revenue: c.net_revenue,
    }));

    res.json({
      period: {
        from_year: t.min_year || null,
        to_year:   t.max_year || null,
        months_count: trend.length,
        filter_applied: hasPeriodFilter,
        date_range_applied: useRange
          ? `date_from=${dateFrom}; date_to=${dateTo}`
          : (hasPeriodFilter
            ? `years=${yearsArr && yearsArr.length ? yearsArr.join(',') : 'الكل'}; months=${monthsArr && monthsArr.length ? monthsArr.join(',') : 'الكل'}`
            : 'كامل الفترة المتاحة (لا يوجد فلتر تاريخ)'),
      },
      totals: {
        total_qty:        Number(t.total_qty || 0),
        total_returns:    Number(t.total_returns || 0),
        gross_revenue:    Number(t.net_revenue || 0),
        total_credit_notes: 0,
        net_revenue:      Number(t.net_revenue || 0),
        returns_pct:      Number(t.total_qty) > 0
          ? +(Number(t.total_returns) / Number(t.total_qty) * 100).toFixed(1)
          : 0,
        active_customers: Number(t.active_customers || 0),
        invoice_count:    Number(t.invoice_count || 0),
        // Share of TOTAL company sales (same period/branch/rep scope, but
        // across every customer — not just the discount-shop segment) —
        // "الحصة من إجمالي المبيعات". Null (not 0) when the company total
        // itself is zero, so an empty period reads as "no data" rather
        // than a real 0% share.
        company_total_qty:     companyQty,
        company_total_revenue: companyRevenue,
        qty_share_pct:     companyQty > 0     ? +(Number(t.total_qty || 0)      / companyQty     * 100).toFixed(2) : null,
        revenue_share_pct: companyRevenue > 0 ? +(Number(t.net_revenue || 0)    / companyRevenue * 100).toFixed(2) : null,
      },
      trend,
      branch_month_matrix: branchMonthWithGross,
      by_branch: branches,
      best_branch: branches[0] || null,
    });
  } catch (err) {
    console.error('[DiscountShops] overview:', err);
    res.status(500).json({ error: 'خطأ في جلب النظرة العامة' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/discount-shops/chilled-chicken-baseline
   Per-item and per-customer historical baseline for the "دجاج
   مبرد" (chilled chicken) category, scoped to the discount-shop
   customer codes. Powers the client-side 10+1 free-goods promo
   scenario tool. Optional ?years=/?months= (repeated or CSV,
   same convention as /summary), or an explicit ?date_from=&date_to=
   range which overrides years/months entirely (same pattern as
   /summary). When neither is given the baseline is ALL available
   history for these customers/category (reported in
   meta.date_range_applied).
════════════════════════════════════════════════════════════ */
const CHILLED_CHICKEN_CATEGORIES = [
  'دجاج مبرد طرية',
  'دجاج مبرد متبل',
  'دجاج مبرد  قريد بي-سجى', // NOTE: double space before "قريد" — verified against production, keep exact
];
router.get('/chilled-chicken-baseline', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    let branch = branchScope(req.query);
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    const { useRange, dateFrom, dateTo } = parseDateRange(req.query);
    if (useRange && dateTo < dateFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });

    // Same years/months multi-select convention as /summary — CSV or
    // repeated query key, defaulting to "no filter" (all history) here
    // rather than the current-month default /summary uses, since this
    // is a baseline/average tool, not a single-period snapshot.
    const yearsParam = (req.query.years || '').trim();
    const yearsArr = yearsParam
      ? [...new Set(yearsParam.split(',').map(s => parseInt(s.trim())).filter(Boolean))]
      : null;
    const monthsParam = (req.query.months || '').trim();
    const monthsArr = monthsParam
      ? [...new Set(monthsParam.split(',').map(s => parseInt(s.trim())).filter(Boolean))]
      : null;

    const params = [];
    let periodSql = '';
    if (useRange) {
      params.push(dateFrom, dateTo);
      periodSql += ` AND make_date(sa.report_year::int, sa.month_num::int, sa.day::int) BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
    } else {
      if (yearsArr && yearsArr.length) { params.push(yearsArr); periodSql += ` AND sa.report_year = ANY($${params.length}::int[])`; }
      if (monthsArr && monthsArr.length) { params.push(monthsArr); periodSql += ` AND sa.month_num = ANY($${params.length}::int[])`; }
    }

    const b = mkBranch(branch, params.length + 1, 'sa');
    if (b.val !== null) params.push(b.val);

    const catParams = params.length + 1;
    params.push(CHILLED_CHICKEN_CATEGORIES);
    const catSql = ` AND sa.item_category_en = ANY($${catParams}::text[])`;

    // Optional item include-filter (?items=CSV of item_name_en) — lets the
    // scenario tool include/exclude specific SKUs from the 10+1 calc itself
    // (not just the display), by narrowing the exact same rows that feed
    // both the per-customer baseline and the per-item breakdown. Absent or
    // empty means "no filter, all items in the category" — byte-identical
    // to the SQL before this filter existed.
    const itemsParam = (req.query.items || '').trim();
    const itemsArr = itemsParam
      ? [...new Set(itemsParam.split(',').map(s => s.trim()).filter(Boolean))]
      : null;
    let itemsSql = '';
    if (itemsArr && itemsArr.length) {
      params.push(itemsArr);
      itemsSql = ` AND TRIM(COALESCE(sa.item_name_en,'')) = ANY($${params.length}::text[])`;
    }

    const whereSql = `${CATEGORY_FILTER}${catSql}${itemsSql}${periodSql}${b.sql}`;

    const [itemsRes, custRes, overallRes] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(NULLIF(TRIM(sa.item_name_en), ''), 'غير محدد') AS item_name_en,
          COALESCE(SUM(sa.qty),0)::bigint             AS total_qty,
          COALESCE(SUM(sa.net_revenue),0)::numeric     AS total_revenue,
          COUNT(DISTINCT sa.customer_code)::int         AS n_customers
        FROM sales_activity sa
        WHERE ${whereSql}
        GROUP BY COALESCE(NULLIF(TRIM(sa.item_name_en), ''), 'غير محدد')
        ORDER BY total_qty DESC
      `, params),

      pool.query(`
        WITH cust_months AS (
          SELECT
            sa.customer_code,
            MAX(sa.customer_name)                         AS customer_name,
            sa.report_year, sa.month_num,
            SUM(sa.qty)                                    AS month_qty
          FROM sales_activity sa
          WHERE ${whereSql}
          GROUP BY sa.customer_code, sa.report_year, sa.month_num
        )
        SELECT
          customer_code,
          MAX(customer_name)                               AS customer_name,
          COUNT(*) FILTER (WHERE month_qty > 0)::int         AS active_months,
          COALESCE(SUM(month_qty),0)::bigint                 AS total_qty
        FROM cust_months
        GROUP BY customer_code
        ORDER BY total_qty DESC
      `, params),

      pool.query(`
        SELECT
          COALESCE(SUM(sa.qty),0)::bigint             AS total_qty,
          COALESCE(SUM(sa.net_revenue),0)::numeric     AS total_revenue,
          COUNT(DISTINCT sa.customer_code)::int         AS active_customers
        FROM sales_activity sa
        WHERE ${whereSql}
      `, params),
    ]);

    const items = itemsRes.rows.map(r => {
      const qty = Number(r.total_qty);
      const rev = Number(r.total_revenue);
      return {
        item_name_en: r.item_name_en,
        total_qty: qty,
        total_revenue: rev,
        asp: qty > 0 ? +(rev / qty).toFixed(4) : 0,
        n_customers: Number(r.n_customers),
      };
    });

    // total_revenue per customer isn't needed by the spec's response shape
    // beyond total_qty/avg_monthly_qty, but is included for completeness /
    // future use — computed here from a second, cheaper aggregate pass so
    // the CTE above (grouped by month, needed for active_months) doesn't
    // also need to carry revenue.
    const custRevRes = await pool.query(`
      SELECT sa.customer_code, COALESCE(SUM(sa.net_revenue),0)::numeric AS total_revenue
      FROM sales_activity sa
      WHERE ${whereSql}
      GROUP BY sa.customer_code
    `, params);
    const custRevMap = Object.fromEntries(custRevRes.rows.map(r => [r.customer_code, Number(r.total_revenue)]));

    const customers = custRes.rows.map(r => {
      const qty = Number(r.total_qty);
      const activeMonths = Number(r.active_months);
      return {
        customer_code: r.customer_code,
        customer_name: r.customer_name,
        active_months: activeMonths,
        total_qty: qty,
        total_revenue: custRevMap[r.customer_code] || 0,
        avg_monthly_qty: activeMonths > 0 ? +(qty / activeMonths).toFixed(4) : 0,
      };
    });

    const ov = overallRes.rows[0] || {};
    const overallQty = Number(ov.total_qty || 0);
    const overallRev = Number(ov.total_revenue || 0);

    res.json({
      items,
      customers,
      overall: {
        total_qty: overallQty,
        total_revenue: overallRev,
        asp: overallQty > 0 ? +(overallRev / overallQty).toFixed(4) : 0,
        active_customers: Number(ov.active_customers || 0),
      },
      meta: {
        date_range_applied: useRange
          ? `date_from=${dateFrom}; date_to=${dateTo}`
          : ((yearsArr && yearsArr.length) || (monthsArr && monthsArr.length)
            ? `years=${yearsArr && yearsArr.length ? yearsArr.join(',') : 'الكل'}; months=${monthsArr && monthsArr.length ? monthsArr.join(',') : 'الكل'}`
            : 'كامل الفترة المتاحة (لا يوجد فلتر تاريخ)'),
        categories: CHILLED_CHICKEN_CATEGORIES,
        items_filter_applied: itemsArr && itemsArr.length ? itemsArr : null,
      },
    });
  } catch (err) {
    console.error('[DiscountShops] chilled-chicken-baseline:', err);
    res.status(500).json({ error: 'خطأ في جلب بيانات دجاج مبرد الأساسية' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/discount-shops/incentive-baseline
   Per-customer historical baseline across the WHOLE discount-shop
   segment (every category, not just chilled chicken) — powers the
   "سيناريو حافز % من المبيعات" tool: a sales-value target each
   customer must reach to qualify for a tiered cash incentive.
   Same shape and period-filter convention as chilled-chicken-baseline
   (?years=/?months= CSV, or ?date_from=&date_to= overriding both;
   omitted = all available history), just without the item_category_en
   restriction. No item-level breakdown here — the incentive is priced
   on total sales VALUE per customer, not per SKU.
════════════════════════════════════════════════════════════ */
router.get('/incentive-baseline', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    let branch = branchScope(req.query);
    if (req.regionFilter && req.regionFilter.length) branch = await resolveRegionBranch(req.regionFilter);

    const { useRange, dateFrom, dateTo } = parseDateRange(req.query);
    if (useRange && dateTo < dateFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });

    const yearsParam = (req.query.years || '').trim();
    const yearsArr = yearsParam
      ? [...new Set(yearsParam.split(',').map(s => parseInt(s.trim())).filter(Boolean))]
      : null;
    const monthsParam = (req.query.months || '').trim();
    const monthsArr = monthsParam
      ? [...new Set(monthsParam.split(',').map(s => parseInt(s.trim())).filter(Boolean))]
      : null;

    const params = [];
    let periodSql = '';
    if (useRange) {
      params.push(dateFrom, dateTo);
      periodSql += ` AND make_date(sa.report_year::int, sa.month_num::int, sa.day::int) BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
    } else {
      if (yearsArr && yearsArr.length) { params.push(yearsArr); periodSql += ` AND sa.report_year = ANY($${params.length}::int[])`; }
      if (monthsArr && monthsArr.length) { params.push(monthsArr); periodSql += ` AND sa.month_num = ANY($${params.length}::int[])`; }
    }

    const b = mkBranch(branch, params.length + 1, 'sa');
    if (b.val !== null) params.push(b.val);

    const whereSql = `${CATEGORY_FILTER}${periodSql}${b.sql}`;

    const [custRes, overallRes, monthlyRes] = await Promise.all([
      pool.query(`
        WITH cust_months AS (
          SELECT
            sa.customer_code,
            MAX(sa.customer_name)                          AS customer_name,
            sa.report_year, sa.month_num,
            SUM(sa.qty)                                     AS month_qty,
            SUM(sa.net_revenue)                              AS month_revenue
          FROM sales_activity sa
          WHERE ${whereSql}
          GROUP BY sa.customer_code, sa.report_year, sa.month_num
        )
        SELECT
          cm.customer_code,
          -- customer_name here is meant to be the ENGLISH name (the contract
          -- print labels it "اسم العميل (إنجليزي)"). sales_activity.customer_name
          -- was wrongly assumed to always be English — live-verified it's
          -- actually Arabic for 2667 of 2668 distinct customer codes
          -- (a NetSuite export quirk, not a bug in this query). The customers
          -- MASTER's own customer_name (now correctly English after the real
          -- "Customer List - CM" upload) is preferred; sales_activity's raw
          -- value is only a last-resort fallback for a customer_code that
          -- somehow isn't in the master at all.
          COALESCE(MAX(c.customer_name), MAX(cm.customer_name)) AS customer_name,
          -- Arabic name for the contract print, resolved from the customers
          -- master (customer_name_ar, 081_customers_name_ar.sql) — left NULL
          -- (never fabricated from sales_activity) when the master doesn't
          -- have one for this code.
          MAX(c.customer_name_ar)                          AS customer_name_ar,
          -- Region for the contract's "المنطقة" column, resolved the same
          -- way as everywhere else in the app (customers.region_id → regions.name_ar).
          MAX(r.name_ar)                                   AS region_name,
          COUNT(*) FILTER (WHERE cm.month_qty > 0)::int      AS active_months,
          COALESCE(SUM(cm.month_qty),0)::bigint              AS total_qty,
          COALESCE(SUM(cm.month_revenue),0)::numeric         AS total_revenue
        FROM cust_months cm
        LEFT JOIN customers c ON c.customer_code = cm.customer_code
        LEFT JOIN regions   r ON r.id = c.region_id
        GROUP BY cm.customer_code
        ORDER BY total_revenue DESC
      `, params),

      pool.query(`
        SELECT
          COALESCE(SUM(sa.qty),0)::bigint             AS total_qty,
          COALESCE(SUM(sa.net_revenue),0)::numeric     AS total_revenue,
          COUNT(DISTINCT sa.customer_code)::int         AS active_customers
        FROM sales_activity sa
        WHERE ${whereSql}
      `, params),

      // Per-customer, per-month breakdown (صافي مبيعات شهر بشهر) — same
      // customer scope/filters as custRes above (identical whereSql), just
      // not collapsed down to one row per customer. Powers the "التفصيل
      // الشهري" tab so its per-customer totals always foot exactly to the
      // same total_qty/total_revenue custRes already reports — one query
      // shape, no risk of the two tabs silently disagreeing.
      pool.query(`
        SELECT
          sa.customer_code,
          sa.report_year::int                         AS year,
          sa.month_num::int                            AS month,
          COALESCE(SUM(sa.qty),0)::bigint               AS qty,
          COALESCE(SUM(sa.net_revenue),0)::numeric      AS revenue
        FROM sales_activity sa
        WHERE ${whereSql}
        GROUP BY sa.customer_code, sa.report_year, sa.month_num
        ORDER BY sa.report_year, sa.month_num
      `, params),
    ]);

    /* customer_code → [{year, month, qty, revenue}, …], chronological */
    const monthsByCustomer = new Map();
    const monthKeySet = new Set(); // distinct (year, month) across ALL customers, for the tab's column headers
    monthlyRes.rows.forEach(r => {
      const key = `${r.year}-${r.month}`;
      monthKeySet.add(key);
      if (!monthsByCustomer.has(r.customer_code)) monthsByCustomer.set(r.customer_code, new Map());
      monthsByCustomer.get(r.customer_code).set(key, { qty: Number(r.qty), revenue: Number(r.revenue) });
    });
    const monthKeys = [...monthKeySet].sort((a, b) => {
      const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number);
      return ay - by || am - bm;
    });
    const months = monthKeys.map(k => {
      const [year, month] = k.split('-').map(Number);
      return { key: k, year, month };
    });

    const customers = custRes.rows.map(r => {
      const qty = Number(r.total_qty);
      const rev = Number(r.total_revenue);
      const activeMonths = Number(r.active_months);
      const custMonths = monthsByCustomer.get(r.customer_code);
      return {
        customer_code: r.customer_code,
        customer_name: r.customer_name,
        customer_name_ar: r.customer_name_ar || null,
        region_name: r.region_name || null,
        active_months: activeMonths,
        total_qty: qty,
        total_revenue: rev,
        avg_monthly_qty:     activeMonths > 0 ? +(qty / activeMonths).toFixed(4) : 0,
        avg_monthly_revenue: activeMonths > 0 ? +(rev / activeMonths).toFixed(4) : 0,
        // { "<year>-<month>": { qty, revenue } } — only the months this
        // customer actually had activity in; a month absent here means
        // zero sales, same "missing = 0, not —" convention monthKeys/months
        // below is built from (a customer with zero months anywhere in the
        // filtered period simply has no key at all).
        by_month: custMonths ? Object.fromEntries(custMonths) : {},
      };
    });

    const ov = overallRes.rows[0] || {};
    const overallQty = Number(ov.total_qty || 0);
    const overallRev = Number(ov.total_revenue || 0);

    res.json({
      customers,
      months,
      overall: {
        total_qty: overallQty,
        total_revenue: overallRev,
        active_customers: Number(ov.active_customers || 0),
      },
      meta: {
        date_range_applied: useRange
          ? `date_from=${dateFrom}; date_to=${dateTo}`
          : ((yearsArr && yearsArr.length) || (monthsArr && monthsArr.length)
            ? `years=${yearsArr && yearsArr.length ? yearsArr.join(',') : 'الكل'}; months=${monthsArr && monthsArr.length ? monthsArr.join(',') : 'الكل'}`
            : 'كامل الفترة المتاحة (لا يوجد فلتر تاريخ)'),
      },
    });
  } catch (err) {
    console.error('[DiscountShops] incentive-baseline:', err);
    res.status(500).json({ error: 'خطأ في جلب بيانات الأساس لسيناريو الحافز' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/discount-shops/filters
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
    console.error('[DiscountShops] filters:', err);
    res.status(500).json({ error: 'خطأ في جلب قوائم الفلترة' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/discount-shops/customer-list
   Current discount-shop customer segment — powers the admin-only
   upload card on the page (current count + last-uploaded timestamp
   + the list itself).
════════════════════════════════════════════════════════════ */
router.get('/customer-list', verifyToken, async (req, res) => {
  try {
    // d.customer_name is Arabic-PREFERRED by design (see /customer-list/upload
    // and /customer-list/add-one below — "nameAr || nameEn") for this segment
    // panel's own single-name display, so it must NOT be assumed to be the
    // English name elsewhere. customer_name_en is the customers MASTER's own
    // (always-English) column, resolved separately and unambiguously for
    // anything that needs a real English/Arabic split (the contract print).
    const r = await pool.query(`
      SELECT d.customer_code, d.customer_name, c.customer_name AS customer_name_en,
             c.customer_name_ar, r.name_ar AS region_name, d.uploaded_at
      FROM discount_shop_customers d
      LEFT JOIN customers c ON c.customer_code = d.customer_code
      LEFT JOIN regions   r ON r.id = c.region_id
      ORDER BY d.customer_name NULLS LAST, d.customer_code
    `);
    const lastUploadedAt = r.rows.reduce((max, row) => {
      const t = row.uploaded_at ? new Date(row.uploaded_at).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    res.json({
      customers: r.rows,
      count: r.rows.length,
      last_uploaded_at: lastUploadedAt ? new Date(lastUploadedAt).toISOString() : null,
    });
  } catch (err) {
    console.error('[DiscountShops] customer-list:', err);
    res.status(500).json({ error: 'خطأ في جلب قائمة عملاء محلات التخفيضات' });
  }
});

/* ════════════════════════════════════════════════════════════
   POST /api/discount-shops/customer-list/upload
   Refreshes the discount-shop customer segment from an uploaded
   Excel file (admin-only — same access matrix as the page itself,
   super_admin/it_admin). Expected columns: "Customer Code",
   "Customer Name", optional "Customer Name Local" (Arabic, preferred
   when present — matches the customers.customer_name_ar Arabic-
   preferred-fallback-to-English convention used elsewhere).

   Semantics: FULL TRUNCATE + INSERT REPLACE in one transaction — this
   list defines current segment membership, so a customer missing from
   a fresh upload should actually drop out (unlike the `customers`
   master's upsert-never-delete convention, which is right for that
   table but wrong here). On any parse/insert error the transaction is
   rolled back so the old list is never left partially destroyed.
════════════════════════════════════════════════════════════ */
router.post(
  '/customer-list/upload',
  verifyToken,
  requireRoles('super_admin', 'it_admin'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });

    try {
      const workbook  = xlsx.readFile(req.file.path, { cellDates: false });
      const sheetName = workbook.SheetNames[0];
      const sheet     = workbook.Sheets[sheetName];
      const rawRows   = xlsx.utils.sheet_to_json(sheet, { defval: '' });

      const seen = new Set();
      const newRows = [];
      const errors = [];
      for (let i = 0; i < rawRows.length; i++) {
        const row = rawRows[i];
        const code = String(row['Customer Code'] ?? '').trim();
        if (!code) continue; // skip blank/total rows
        const nameEn = String(row['Customer Name'] ?? '').trim();
        const nameArRaw = row['Customer Name Local'];
        const nameAr = nameArRaw != null ? String(nameArRaw).trim() : '';
        const name = nameAr || nameEn || null;
        if (!name) {
          errors.push({ row: i + 2, error: 'اسم العميل مفقود', customer_code: code });
        }
        if (seen.has(code)) continue; // duplicate code in the file — keep first occurrence
        seen.add(code);
        newRows.push({ customer_code: code, customer_name: name });
      }

      if (!newRows.length) {
        return res.status(400).json({ error: 'لا توجد صفوف صالحة في الملف (عمود Customer Code مطلوب)' });
      }

      const client = await pool.connect();
      let previousCount = 0;
      let oldCodes = new Set();
      try {
        await client.query('BEGIN');

        const oldRes = await client.query('SELECT customer_code FROM discount_shop_customers');
        oldCodes = new Set(oldRes.rows.map(r => r.customer_code));
        previousCount = oldCodes.size;

        await client.query('TRUNCATE discount_shop_customers');

        const values = [];
        const placeholders = newRows.map((row, idx) => {
          const base = idx * 4;
          values.push(row.customer_code, row.customer_name, req.user.id, new Date());
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
        }).join(', ');

        await client.query(
          `INSERT INTO discount_shop_customers (customer_code, customer_name, uploaded_by, uploaded_at)
           VALUES ${placeholders}`,
          values
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }

      const newCodes = new Set(newRows.map(r => r.customer_code));
      const added   = [...newCodes].filter(c => !oldCodes.has(c));
      const removed = [...oldCodes].filter(c => !newCodes.has(c));

      res.json({
        ok: true,
        previous_count: previousCount,
        new_count: newCodes.size,
        added,
        removed,
        row_errors: errors,
      });
    } catch (err) {
      console.error('[DiscountShops] customer-list/upload:', err);
      res.status(500).json({ error: 'خطأ في رفع قائمة العملاء: ' + (err.message || '') });
    }
  }
);

/* ════════════════════════════════════════════════════════════
   POST /api/discount-shops/customer-list/add-one
   Adds (or updates) a SINGLE customer to the segment by code —
   the lighter-weight alternative to a full list re-upload for the
   common case of just onboarding/removing one customer at a time.
   Same admin-only gate as the rest of this list's endpoints.

   The name is resolved automatically so the admin only has to type
   a code: tries the `customers` master first (Arabic-preferred, same
   convention as customers.customer_name_ar elsewhere), then falls
   back to the latest `sales_activity` row for that code. A code that
   matches neither is still added (typos happen on both sides — a
   code not yet in the master doesn't mean it's wrong), but the
   response carries a warning so the admin isn't left thinking a name
   was found when none was.
════════════════════════════════════════════════════════════ */
router.post(
  '/customer-list/add-one',
  verifyToken,
  requireRoles('super_admin', 'it_admin'),
  async (req, res) => {
    const code = String(req.body.customer_code || '').trim();
    if (!code) return res.status(400).json({ error: 'كود العميل مطلوب' });

    try {
      const existing = await pool.query(
        'SELECT customer_code FROM discount_shop_customers WHERE customer_code = $1', [code]
      );
      const alreadyInList = existing.rows.length > 0;

      let name = null;
      const master = await pool.query(
        `SELECT COALESCE(NULLIF(TRIM(customer_name_ar), ''), customer_name) AS name
         FROM customers WHERE customer_code = $1`, [code]
      );
      if (master.rows.length && master.rows[0].name) {
        name = master.rows[0].name;
      } else {
        const sa = await pool.query(
          `SELECT MAX(customer_name) AS name FROM sales_activity WHERE customer_code = $1`, [code]
        );
        if (sa.rows.length && sa.rows[0].name) name = sa.rows[0].name;
      }

      await pool.query(
        `INSERT INTO discount_shop_customers (customer_code, customer_name, uploaded_by, uploaded_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (customer_code) DO UPDATE SET
           customer_name = COALESCE(EXCLUDED.customer_name, discount_shop_customers.customer_name),
           uploaded_by   = EXCLUDED.uploaded_by,
           uploaded_at   = NOW()`,
        [code, name, req.user.id]
      );

      res.json({
        ok: true,
        customer_code: code,
        customer_name: name,
        was_already_in_list: alreadyInList,
        name_not_found: !name,
      });
    } catch (err) {
      console.error('[DiscountShops] customer-list/add-one:', err);
      res.status(500).json({ error: 'خطأ في إضافة العميل' });
    }
  }
);

/* ════════════════════════════════════════════════════════════
   DELETE /api/discount-shops/customer-list/:customer_code
   Removes a single customer from the segment — same admin-only gate.
════════════════════════════════════════════════════════════ */
router.delete(
  '/customer-list/:customer_code',
  verifyToken,
  requireRoles('super_admin', 'it_admin'),
  async (req, res) => {
    const code = String(req.params.customer_code || '').trim();
    if (!code) return res.status(400).json({ error: 'كود العميل مطلوب' });

    try {
      const r = await pool.query(
        'DELETE FROM discount_shop_customers WHERE customer_code = $1 RETURNING customer_code, customer_name',
        [code]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'العميل غير موجود في القائمة' });
      res.json({ ok: true, removed: r.rows[0] });
    } catch (err) {
      console.error('[DiscountShops] customer-list delete:', err);
      res.status(500).json({ error: 'خطأ في حذف العميل' });
    }
  }
);

/* ════════════════════════════════════════════════════════════
   POST /api/discount-shops/contracts
   Saves one printed customer contract as a permanent, numbered log
   row (append-only — see 101_discount_shop_contracts.sql for why this
   IS the log, not a header+log pair like Carrefour/Quality Returns).
   The frontend sends the exact snapshot it just rendered/printed
   (avg_monthly_value, growth_pct, target_value, tiers, basis) so the
   saved record always matches what the customer actually signed, even
   if the incentive-scenario growth%/tiers get edited afterwards.
   `basis` ('qty' | 'revenue') records which unit avg_monthly_value/
   target_value are expressed in — added so a contract can be pegged
   to sales value (ر.س) instead of quantity (حبة) when that's how the
   deal was actually negotiated; see 102_discount_shop_contracts_basis.sql.
════════════════════════════════════════════════════════════ */
router.post('/contracts', verifyToken, async (req, res) => {
  const { customer_code, customer_name, customer_name_ar, region_name, avg_monthly_value, growth_pct, target_value, tiers, basis } = req.body || {};
  if (!customer_code || !customer_name) {
    return res.status(400).json({ error: 'بيانات العميل مطلوبة' });
  }
  if (!Array.isArray(tiers) || !tiers.length) {
    return res.status(400).json({ error: 'شرائح العقد مطلوبة' });
  }
  const basisVal = basis === 'revenue' ? 'revenue' : 'qty';
  try {
    const r = await pool.query(
      `INSERT INTO discount_shop_contracts
         (customer_code, customer_name, customer_name_ar, region_name, avg_monthly_value, growth_pct, target_value, tiers, basis, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, contract_no, created_at`,
      [
        String(customer_code).trim(), String(customer_name).trim(),
        customer_name_ar ? String(customer_name_ar).trim() : null,
        region_name ? String(region_name).trim() : null,
        Number(avg_monthly_value) || 0, Number(growth_pct) || 0, Number(target_value) || 0,
        JSON.stringify(tiers), basisVal, req.user.id, req.user.name || null,
      ]
    );
    res.json({ ok: true, contract: r.rows[0] });
  } catch (err) {
    console.error('[DiscountShops] contracts save:', err);
    res.status(500).json({ error: 'خطأ في حفظ سجل العقد' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/discount-shops/contracts
   Save log — every contract ever saved, newest first. Optional
   ?customer_code= narrows to one customer's history (used by the
   "سجل العقود" list under the contract tab).
════════════════════════════════════════════════════════════ */
router.get('/contracts', verifyToken, async (req, res) => {
  const { customer_code } = req.query;
  try {
    const params = [];
    let where = '';
    if (customer_code) {
      params.push(String(customer_code).trim());
      where = 'WHERE customer_code = $1';
    }
    const r = await pool.query(
      `SELECT id, contract_no, customer_code, customer_name, customer_name_ar, region_name, avg_monthly_value, growth_pct,
              target_value, tiers, basis, created_by_name, created_at,
              updated_by_name, updated_at
       FROM discount_shop_contracts
       ${where}
       ORDER BY created_at DESC
       LIMIT 500`,
      params
    );

    /* "صافي مبيعات الشهر الحالي" + "مستحق حافز؟" — computed fresh on every
       list load against the CURRENT calendar month (not whichever date
       filters happen to be selected elsewhere on the page, and not the
       month the contract was originally signed in) — this is a live
       compliance check against an ongoing agreement, not a historical
       snapshot, so it deliberately does NOT freeze like the rest of this
       table's fields do. */
    const now = new Date();
    const curYear = now.getFullYear(), curMonth = now.getMonth() + 1;
    const codes = [...new Set(r.rows.map(c => c.customer_code))];
    const salesByCode = new Map();
    if (codes.length) {
      const saRes = await pool.query(
        `SELECT customer_code, COALESCE(SUM(qty),0)::numeric AS qty, COALESCE(SUM(net_revenue),0)::numeric AS revenue
         FROM sales_activity
         WHERE report_year = $1 AND month_num = $2 AND customer_code = ANY($3::text[])
         GROUP BY customer_code`,
        [curYear, curMonth, codes]
      );
      saRes.rows.forEach(row => salesByCode.set(row.customer_code, { qty: Number(row.qty), revenue: Number(row.revenue) }));
    }

    /* Highest tier whose `from` the achieved value has reached — same rule
       as rateForAchievement/calcIncentiveScenario on the frontend, just the
       backend's own copy since this needs to run per contract row here. */
    const achievedTier = (value, tiers) => {
      let best = null;
      for (const t of (tiers || [])) {
        const from = Number(t.from);
        if (Number.isFinite(from) && value >= from) {
          if (!best || from > Number(best.from)) best = t;
        }
      }
      return best;
    };

    const contracts = r.rows.map(c => {
      const sales = salesByCode.get(c.customer_code) || { qty: 0, revenue: 0 };
      const currentValue = c.basis === 'revenue' ? sales.revenue : sales.qty;
      const tier = achievedTier(currentValue, c.tiers);
      return {
        ...c,
        current_month_label: `${MONTH_AR[curMonth]} ${curYear}`,
        current_month_value: currentValue,
        qualifies: !!tier,
        achieved_tier: tier,
        bonus_amount: tier ? +(currentValue * (Number(tier.rate) / 100)).toFixed(2) : 0,
      };
    });

    res.json({ contracts });
  } catch (err) {
    console.error('[DiscountShops] contracts list:', err);
    res.status(500).json({ error: 'خطأ في جلب سجل العقود' });
  }
});

/* ════════════════════════════════════════════════════════════
   PUT /api/discount-shops/contracts/:id
   Corrects an already-saved contract's numbers in place — contract_no,
   created_at and created_by are never touched (the contract keeps its
   identity), only the editable fields change, and updated_by/updated_at
   record who last corrected it. See 103_discount_shop_contracts_edit.sql
   for why this table allows edits despite otherwise being an append-only
   save log.
════════════════════════════════════════════════════════════ */
router.put('/contracts/:id', verifyToken, async (req, res) => {
  const { avg_monthly_value, growth_pct, target_value, tiers, basis } = req.body || {};
  if (!Array.isArray(tiers) || !tiers.length) {
    return res.status(400).json({ error: 'شرائح العقد مطلوبة' });
  }
  const basisVal = basis === 'revenue' ? 'revenue' : 'qty';
  try {
    const r = await pool.query(
      `UPDATE discount_shop_contracts
       SET avg_monthly_value = $1, growth_pct = $2, target_value = $3, tiers = $4, basis = $5,
           updated_by = $6, updated_by_name = $7, updated_at = NOW()
       WHERE id = $8
       RETURNING id, contract_no, customer_code, customer_name, avg_monthly_value, growth_pct,
                 target_value, tiers, basis, created_by_name, created_at,
                 updated_by_name, updated_at`,
      [
        Number(avg_monthly_value) || 0, Number(growth_pct) || 0, Number(target_value) || 0,
        JSON.stringify(tiers), basisVal, req.user.id, req.user.name || null, req.params.id,
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'العقد غير موجود' });
    res.json({ ok: true, contract: r.rows[0] });
  } catch (err) {
    console.error('[DiscountShops] contracts update:', err);
    res.status(500).json({ error: 'خطأ في تعديل العقد' });
  }
});

/* ════════════════════════════════════════════════════════════
   DELETE /api/discount-shops/contracts/:id
   Removes one saved contract permanently — e.g. a duplicate save or a
   test/mistaken entry. Unlike an edit, there's no "corrected" trail left
   behind; the frontend gates this behind a confirm() dialog for the same
   reason customer-list delete does.
════════════════════════════════════════════════════════════ */
router.delete('/contracts/:id', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      'DELETE FROM discount_shop_contracts WHERE id = $1 RETURNING id, contract_no, customer_name',
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'العقد غير موجود' });
    res.json({ ok: true, removed: r.rows[0] });
  } catch (err) {
    console.error('[DiscountShops] contracts delete:', err);
    res.status(500).json({ error: 'خطأ في حذف العقد' });
  }
});

module.exports = router;
