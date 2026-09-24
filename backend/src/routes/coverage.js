const express = require('express');
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

const router = express.Router();

// regionId may be a single id or an array of ids (a user can now be
// assigned more than one region) — returns the flattened list of
// name_ar/name_en branch labels for all of them, or null if none.
// sales_activity.branch_name stores English region names (e.g. "Riyadh").
async function resolveRegionBranch(regionId) {
  if (!regionId || (Array.isArray(regionId) && !regionId.length)) return null;
  const ids = Array.isArray(regionId) ? regionId : [regionId];
  try {
    const res = await pool.query('SELECT name_ar, name_en FROM regions WHERE id = ANY($1::int[])', [ids]);
    if (!res.rows.length) return null;
    const names = res.rows.flatMap(r => [r.name_ar, r.name_en]).filter(Boolean);
    return names.length ? names : null;
  } catch { return null; }
}

/* ── Official working-days calculator (skip Friday + named holidays) —
   same convention as performanceDashboard.js/summary.js/hypermarkets.js:
   full month if the period is in the past, MTD (up to today) if current. ── */
const HOLIDAYS = [
  { year: 2026, month: 5, days: [27, 28, 29] }, // عيد الأضحى 1447هـ
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

/* ─────────────────────────────────────────────────────────────
   GET /api/coverage/filters?year=2026
   Returns unique branches and reps for selection dropdowns
───────────────────────────────────────────────────────────── */
router.get('/filters', verifyToken, applyRegionFilter, async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    const allowedBranches = (req.regionFilter && req.regionFilter.length)
      ? await resolveRegionBranch(req.regionFilter)
      : null;

    const branchCond = allowedBranches ? `AND TRIM(branch_name) = ANY($2::text[])` : '';
    const params = allowedBranches ? [year, allowedBranches] : [year];

    const { rows } = await pool.query(`
      SELECT DISTINCT
        COALESCE(TRIM(branch_name), '') AS branch_name,
        COALESCE(TRIM(salesrep_name), '') AS salesrep_name
      FROM sales_activity
      WHERE report_year = $1
        AND salesrep_name IS NOT NULL AND TRIM(salesrep_name) != ''
        ${branchCond}
      ORDER BY branch_name, salesrep_name
    `, params);

    const branches = [...new Set(rows.map(r => r.branch_name).filter(Boolean))].sort();
    const reps = rows
      .filter(r => r.salesrep_name)
      .map(r => ({ name: r.salesrep_name, branch: r.branch_name || '' }));

    res.json({ branches, reps });
  } catch (err) {
    console.error('[Coverage] filters error:', err);
    res.status(500).json({ error: 'خطأ في جلب قوائم الفلترة' });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/coverage/profile?rep=...&year=2026&month=5
   Full rep profile: KPIs, rankings, prev month customers,
   current month daily breakdown
───────────────────────────────────────────────────────────── */
router.get('/profile', verifyToken, applyRegionFilter, async (req, res) => {
  const repName = (req.query.rep || '').trim();
  const year    = parseInt(req.query.year)  || new Date().getFullYear();
  const month   = parseInt(req.query.month) || (new Date().getMonth() + 1);

  if (!repName) return res.status(400).json({ error: 'اسم المندوب مطلوب' });

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;

  try {
    if (req.regionFilter && req.regionFilter.length) {
      const allowedBranches = await resolveRegionBranch(req.regionFilter);
      if (allowedBranches) {
        const ownRep = await pool.query(
          `SELECT 1 FROM sales_activity
           WHERE TRIM(salesrep_name) = $1 AND TRIM(branch_name) = ANY($2::text[]) LIMIT 1`,
          [repName, allowedBranches]
        );
        if (!ownRep.rowCount) return res.status(403).json({ error: 'غير مصرح بعرض بيانات هذا المندوب' });
      }
    }

    /* 1 ── Global + branch rankings for the current month ─── */
    const rankRes = await pool.query(`
      WITH rep_monthly AS (
        SELECT
          TRIM(salesrep_name)                       AS salesrep_name,
          MAX(TRIM(COALESCE(branch_name,'')))        AS branch_name,
          SUM(qty)                                   AS total_qty,
          COUNT(DISTINCT invoice_number)                                   AS invoice_count,
          COUNT(DISTINCT customer_code)              AS customer_count
        FROM sales_activity
        WHERE report_year = $1 AND month_num = $2
          AND salesrep_name IS NOT NULL AND TRIM(salesrep_name) != ''
        GROUP BY TRIM(salesrep_name)
      ),
      global_ranked AS (
        SELECT *,
          RANK() OVER (ORDER BY total_qty DESC)  AS global_rank,
          COUNT(*) OVER ()                        AS total_reps_global
        FROM rep_monthly
      ),
      branch_ranked AS (
        SELECT salesrep_name,
          RANK() OVER (PARTITION BY branch_name ORDER BY total_qty DESC) AS branch_rank,
          COUNT(*) OVER (PARTITION BY branch_name)                        AS total_reps_branch
        FROM rep_monthly
      )
      SELECT g.*, b.branch_rank, b.total_reps_branch
      FROM   global_ranked g
      LEFT JOIN branch_ranked b ON g.salesrep_name = b.salesrep_name
      WHERE  g.salesrep_name = $3
    `, [year, month, repName]);

    /* 2 ── Previous-month customers ─────────────────────── */
    // invoice_count must be COUNT(DISTINCT invoice_number), not COUNT(*) —
    // sales_activity has one row per (invoice_number, item_category_en,
    // item_name_en), so a single invoice with several line items was
    // otherwise counted as several "orders". Restricted to qty > 0 rows
    // (the same "genuine sale line" convention used everywhere else in
    // this codebase, e.g. active_customers) since sales_activity has no
    // transaction-type column to distinguish sales from returns/credit
    // memos — a pure-return line (net qty ≤ 0) isn't a sales order.
    const prevRes = await pool.query(`
      SELECT
        customer_code,
        MAX(TRIM(customer_name))  AS customer_name,
        COUNT(DISTINCT CASE WHEN qty > 0 THEN invoice_number END) AS invoice_count,
        SUM(qty)                  AS total_qty
      FROM sales_activity
      WHERE report_year = $1 AND month_num = $2 AND TRIM(salesrep_name) = $3
      GROUP BY customer_code
      ORDER BY total_qty DESC
    `, [prevYear, prevMonth, repName]);

    /* 3 ── Current-month customers (aggregated) ─────────── */
    const currRes = await pool.query(`
      SELECT
        customer_code,
        MAX(TRIM(customer_name))  AS customer_name,
        COUNT(DISTINCT CASE WHEN qty > 0 THEN invoice_number END) AS invoice_count,
        SUM(qty)                  AS total_qty
      FROM sales_activity
      WHERE report_year = $1 AND month_num = $2 AND TRIM(salesrep_name) = $3
      GROUP BY customer_code
      ORDER BY total_qty DESC
    `, [year, month, repName]);

    /* 4 ── Current-month daily data (requires day column) ── */
    const daysRes = await pool.query(`
      SELECT
        customer_code,
        day,
        SUM(qty)   AS day_qty,
        COUNT(DISTINCT invoice_number)   AS day_orders
      FROM sales_activity
      WHERE report_year = $1 AND month_num = $2 AND TRIM(salesrep_name) = $3
        AND day IS NOT NULL
      GROUP BY customer_code, day
      ORDER BY customer_code, day
    `, [year, month, repName]);

    /* 5 ── Current-month qty by item category (product type) ──
       Powers "متوسط الكميات اليومية" broken down by category — same
       fixed دجاج مبرد طرية / مقطعات طرية / دجاج مجمد + "أخرى" bucketing
       used on the performance dashboard. Uses SUM(qty) — NET, including
       returns — same basis as total_qty above (also SUM(qty)) so the
       category parts always sum to the displayed total; gross-positive
       qty here previously summed to MORE than the net total whenever the
       rep had any returns this month. */
    const itemCatRes = await pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(item_category_en), ''), 'أخرى') AS category,
        SUM(qty) AS qty
      FROM sales_activity
      WHERE report_year = $1 AND month_num = $2 AND TRIM(salesrep_name) = $3
      GROUP BY category
    `, [year, month, repName]);
    const ITEM_CATEGORIES = ['دجاج مبرد طرية', 'مقطعات طرية', 'دجاج مجمد'];
    const itemCatQty = {};
    itemCatRes.rows.forEach(row => { itemCatQty[row.category] = parseInt(row.qty || 0); });
    const itemQtyBreakdown = [
      ...ITEM_CATEGORIES.map(cat => ({ category: cat, qty: itemCatQty[cat] || 0 })),
      { category: 'أخرى', qty: Object.entries(itemCatQty).filter(([c]) => !ITEM_CATEGORIES.includes(c)).reduce((s,[,q]) => s+q, 0) },
    ].filter(c => c.qty !== 0).sort((a, b) => b.qty - a.qty);

    // Qty average-per-day basis = distinct days this month the rep had any
    // sales activity at all (not calendar working days) — a rep who only
    // worked half the elapsed month shouldn't have their daily qty average
    // diluted by days they simply didn't work.
    const activeDaysCount = new Set(daysRes.rows.map(row => row.day)).size;
    const totalVisits = daysRes.rows.length; // one row per (customer, day) already deduplicated
    // Visits average is instead measured against OFFICIAL working days
    // elapsed this month (calendar days minus Friday/holidays, MTD if the
    // current month) — a fixed, predictable denominator for route-coverage
    // planning, unlike the qty average above.
    const officialWorkDays = workingDays(year, month);

    // Total visits split per week (day 1-7 → week 1, 8-14 → week 2, ...),
    // same bucketing convention used by /ranking's week_num CASE.
    const weekOfDay = d => (d <= 7 ? 1 : d <= 14 ? 2 : d <= 21 ? 3 : d <= 28 ? 4 : 5);
    const weeklyVisits = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    daysRes.rows.forEach(row => { weeklyVisits[weekOfDay(Number(row.day))]++; });
    const weeklyVisitsList = [1, 2, 3, 4, 5].map(w => ({ week: w, visits: weeklyVisits[w] }));

    /* 6 ── Fridge count per customer (active fridges only, same
       convention as fridges.js/performanceDashboard.js) — covers every
       customer appearing in either month so "لديه ثلاجة" stays accurate
       even for a customer only seen in the previous month's list. */
    const allCustCodes = [...new Set([
      ...prevRes.rows.map(r => r.customer_code),
      ...currRes.rows.map(r => r.customer_code),
    ])];
    let fridgeCountByCustomer = {};
    if (allCustCodes.length) {
      const fridgeCountRes = await pool.query(
        `SELECT customer_code, COUNT(*) AS fridge_count
         FROM fridges
         WHERE status = 'active' AND customer_code = ANY($1::text[])
         GROUP BY customer_code`,
        [allCustCodes]
      );
      fridgeCountRes.rows.forEach(row => {
        fridgeCountByCustomer[row.customer_code] = parseInt(row.fridge_count || 0);
      });
    }

    const r = rankRes.rows[0] || {};

    res.json({
      rep: {
        name:   repName,
        branch: r.branch_name || '',
        kpi: {
          total_qty:         Number(r.total_qty)         || 0,
          invoice_count:     Number(r.invoice_count)     || 0,
          customer_count:    Number(r.customer_count)    || 0,
          global_rank:       r.global_rank       ? Number(r.global_rank)       : null,
          total_reps_global: r.total_reps_global ? Number(r.total_reps_global) : 0,
          branch_rank:       r.branch_rank       ? Number(r.branch_rank)       : null,
          total_reps_branch: r.total_reps_branch ? Number(r.total_reps_branch) : 0,
          active_days_count: activeDaysCount,
          official_work_days: officialWorkDays,
          avg_daily_qty:     activeDaysCount > 0 ? +(Number(r.total_qty || 0) / activeDaysCount).toFixed(1) : 0,
          avg_daily_visits:  officialWorkDays > 0 ? +(totalVisits / officialWorkDays).toFixed(1) : 0,
          total_visits:      totalVisits,
          weekly_visits:     weeklyVisitsList,
          item_qty_breakdown: itemQtyBreakdown.map(c => ({
            ...c,
            avg_daily_qty: activeDaysCount > 0 ? +(c.qty / activeDaysCount).toFixed(1) : 0,
          })),
        },
      },
      period: { month, year, prev_month: prevMonth, prev_year: prevYear },
      prev_customers: prevRes.rows.map(r => ({
        customer_code:  r.customer_code,
        customer_name:  r.customer_name,
        invoice_count:  Number(r.invoice_count),
        total_qty:      Number(r.total_qty),
        fridge_count:   fridgeCountByCustomer[r.customer_code] || 0,
      })),
      curr_customers: currRes.rows.map(r => ({
        customer_code:  r.customer_code,
        customer_name:  r.customer_name,
        invoice_count:  Number(r.invoice_count),
        total_qty:      Number(r.total_qty),
        fridge_count:   fridgeCountByCustomer[r.customer_code] || 0,
      })),
      day_data: daysRes.rows.map(r => ({
        customer_code: r.customer_code,
        day:           Number(r.day),
        qty:           Number(r.day_qty),
        orders:        Number(r.day_orders),
      })),
      has_day_data: daysRes.rows.length > 0,
    });
  } catch (err) {
    console.error('[Coverage] profile error:', err);
    res.status(500).json({ error: 'خطأ في جلب بيانات المندوب' });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/coverage/ranking?month=&year=&branch=
   All reps ranked by overall coverage % with per-week breakdown
───────────────────────────────────────────────────────────── */
router.get('/ranking', verifyToken, applyRegionFilter, async (req, res) => {
  const year   = parseInt(req.query.year)  || new Date().getFullYear();
  const month  = parseInt(req.query.month) || (new Date().getMonth() + 1);
  const branch = (req.query.branch || '').trim();

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;

  try {
    const allowedBranches = (req.regionFilter && req.regionFilter.length)
      ? await resolveRegionBranch(req.regionFilter)
      : null;

    const params = [year, month, prevYear, prevMonth];
    let branchCond = '';
    if (allowedBranches) {
      // Region-restricted: honour an explicit branch pick only if it's
      // actually one of the caller's own branches, else scope to all of them.
      const branchVal = (branch && allowedBranches.includes(branch)) ? [branch] : allowedBranches;
      params.push(branchVal);
      branchCond = `AND TRIM(branch_name) = ANY($5::text[])`;
    } else if (branch) {
      branchCond = `AND TRIM(branch_name) = $5`;
      params.push(branch);
    }

    const { rows } = await pool.query(`
      WITH
      curr AS (
        SELECT DISTINCT
          TRIM(salesrep_name)              AS rep,
          TRIM(COALESCE(branch_name,''))   AS branch,
          customer_code
        FROM sales_activity
        WHERE report_year = $1 AND month_num = $2
          AND salesrep_name IS NOT NULL AND TRIM(salesrep_name) != ''
          ${branchCond}
      ),
      prev AS (
        SELECT DISTINCT
          TRIM(salesrep_name) AS rep,
          customer_code
        FROM sales_activity
        WHERE report_year = $3 AND month_num = $4
          AND salesrep_name IS NOT NULL AND TRIM(salesrep_name) != ''
          ${branchCond}
      ),
      all_custs AS (
        SELECT rep, customer_code FROM curr
        UNION
        SELECT rep, customer_code FROM prev
      ),
      rep_totals AS (
        SELECT rep, COUNT(DISTINCT customer_code) AS total_custs
        FROM all_custs GROUP BY rep
      ),
      day_vis AS (
        SELECT
          TRIM(salesrep_name) AS rep,
          customer_code,
          day,
          CASE
            WHEN day BETWEEN 1  AND 7  THEN 1
            WHEN day BETWEEN 8  AND 14 THEN 2
            WHEN day BETWEEN 15 AND 21 THEN 3
            WHEN day BETWEEN 22 AND 28 THEN 4
            ELSE 5
          END AS week_num
        FROM sales_activity
        WHERE report_year = $1 AND month_num = $2
          AND day IS NOT NULL
          AND salesrep_name IS NOT NULL AND TRIM(salesrep_name) != ''
          ${branchCond}
      ),
      -- per-rep per-week per-customer distinct visit days
      cust_week_days AS (
        SELECT rep, week_num, customer_code,
          COUNT(DISTINCT day) AS day_cnt
        FROM day_vis
        GROUP BY rep, week_num, customer_code
      ),
      weekly AS (
        SELECT rep, week_num,
          COUNT(DISTINCT customer_code)                                  AS vis_custs,
          SUM(day_cnt)                                                   AS total_vis,
          COUNT(DISTINCT CASE WHEN day_cnt >= 2 THEN customer_code END)  AS eff_custs
        FROM cust_week_days
        GROUP BY rep, week_num
      ),
      -- Overall visits must use the same deduplicated-by-day count as the
      -- weekly totals (SUM(day_cnt)), not COUNT(*) over raw sales_activity
      -- rows — a customer with multiple invoice lines on the same day was
      -- otherwise counted as multiple visits, inflating "زيارة/يوم".
      overall AS (
        SELECT rep,
          COUNT(DISTINCT customer_code) AS vis_custs,
          SUM(day_cnt)                  AS total_vis
        FROM cust_week_days GROUP BY rep
      ),
      -- Current month net quantities per rep
      qty_agg AS (
        SELECT TRIM(salesrep_name) AS rep, SUM(qty) AS total_qty
        FROM sales_activity
        WHERE report_year = $1 AND month_num = $2
          AND salesrep_name IS NOT NULL AND TRIM(salesrep_name) != ''
          ${branchCond}
        GROUP BY TRIM(salesrep_name)
      )
      SELECT
        c.rep                                                        AS rep_name,
        MAX(c.branch)                                                AS branch_name,
        COUNT(DISTINCT c.customer_code)                              AS curr_custs,
        COALESCE(rt.total_custs, COUNT(DISTINCT c.customer_code))    AS total_custs,
        COALESCE(MAX(CASE WHEN w.week_num=1 THEN w.vis_custs  END),0) AS w1_vis,
        COALESCE(MAX(CASE WHEN w.week_num=1 THEN w.total_vis  END),0) AS w1_tot,
        COALESCE(MAX(CASE WHEN w.week_num=1 THEN w.eff_custs  END),0) AS w1_eff,
        COALESCE(MAX(CASE WHEN w.week_num=2 THEN w.vis_custs  END),0) AS w2_vis,
        COALESCE(MAX(CASE WHEN w.week_num=2 THEN w.total_vis  END),0) AS w2_tot,
        COALESCE(MAX(CASE WHEN w.week_num=2 THEN w.eff_custs  END),0) AS w2_eff,
        COALESCE(MAX(CASE WHEN w.week_num=3 THEN w.vis_custs  END),0) AS w3_vis,
        COALESCE(MAX(CASE WHEN w.week_num=3 THEN w.total_vis  END),0) AS w3_tot,
        COALESCE(MAX(CASE WHEN w.week_num=3 THEN w.eff_custs  END),0) AS w3_eff,
        COALESCE(MAX(CASE WHEN w.week_num=4 THEN w.vis_custs  END),0) AS w4_vis,
        COALESCE(MAX(CASE WHEN w.week_num=4 THEN w.total_vis  END),0) AS w4_tot,
        COALESCE(MAX(CASE WHEN w.week_num=4 THEN w.eff_custs  END),0) AS w4_eff,
        COALESCE(MAX(CASE WHEN w.week_num=5 THEN w.vis_custs  END),0) AS w5_vis,
        COALESCE(MAX(CASE WHEN w.week_num=5 THEN w.total_vis  END),0) AS w5_tot,
        COALESCE(MAX(CASE WHEN w.week_num=5 THEN w.eff_custs  END),0) AS w5_eff,
        COALESCE(o.vis_custs, 0)                                     AS ov_vis,
        COALESCE(o.total_vis, 0)                                     AS ov_tot,
        COALESCE(MAX(qa.total_qty), 0)                               AS total_qty
      FROM curr c
      LEFT JOIN rep_totals rt ON rt.rep = c.rep
      LEFT JOIN weekly      w  ON w.rep  = c.rep
      LEFT JOIN overall     o  ON o.rep  = c.rep
      LEFT JOIN qty_agg     qa ON qa.rep = c.rep
      GROUP BY c.rep, rt.total_custs, o.vis_custs, o.total_vis
      ORDER BY
        COALESCE(o.vis_custs,0)::float
          / NULLIF(COALESCE(rt.total_custs, COUNT(DISTINCT c.customer_code)), 0) DESC NULLS LAST,
        COALESCE(o.total_vis,0) DESC
    `, params);

    const reps = rows.map((r, i) => {
      const tot = parseInt(r.total_custs) || 1;
      const pct = n => tot > 0 ? Math.round(parseInt(n || 0) / tot * 100) : 0;
      return {
        rank:            i + 1,
        rep_name:        r.rep_name,
        branch_name:     r.branch_name,
        total_customers: parseInt(r.total_custs),
        curr_customers:  parseInt(r.curr_custs),
        weeks: [
          { visited: parseInt(r.w1_vis), visits: parseInt(r.w1_tot), pct: pct(r.w1_vis), efficient: parseInt(r.w1_eff), effPct: pct(r.w1_eff) },
          { visited: parseInt(r.w2_vis), visits: parseInt(r.w2_tot), pct: pct(r.w2_vis), efficient: parseInt(r.w2_eff), effPct: pct(r.w2_eff) },
          { visited: parseInt(r.w3_vis), visits: parseInt(r.w3_tot), pct: pct(r.w3_vis), efficient: parseInt(r.w3_eff), effPct: pct(r.w3_eff) },
          { visited: parseInt(r.w4_vis), visits: parseInt(r.w4_tot), pct: pct(r.w4_vis), efficient: parseInt(r.w4_eff), effPct: pct(r.w4_eff) },
          { visited: parseInt(r.w5_vis), visits: parseInt(r.w5_tot), pct: pct(r.w5_vis), efficient: parseInt(r.w5_eff), effPct: pct(r.w5_eff) },
        ],
        total_qty: parseInt(r.total_qty) || 0,
        overall: (() => {
          const weekEffs = [
            { eff: parseInt(r.w1_eff), tot: parseInt(r.w1_tot) },
            { eff: parseInt(r.w2_eff), tot: parseInt(r.w2_tot) },
            { eff: parseInt(r.w3_eff), tot: parseInt(r.w3_tot) },
            { eff: parseInt(r.w4_eff), tot: parseInt(r.w4_tot) },
            { eff: parseInt(r.w5_eff), tot: parseInt(r.w5_tot) },
          ];
          const activeWeeks = weekEffs.filter(w => w.tot > 0);
          const avgEffPct = activeWeeks.length > 0
            ? Math.round(activeWeeks.reduce((s, w) => s + pct(w.eff), 0) / activeWeeks.length)
            : 0;
          return {
            visited: parseInt(r.ov_vis),
            visits:  parseInt(r.ov_tot),
            pct:     pct(r.ov_vis),
            effPct:  avgEffPct,
          };
        })(),
        has_day_data: parseInt(r.ov_tot) > 0,
      };
    });

    res.json({
      reps,
      period: { month, year, prev_month: prevMonth, prev_year: prevYear },
    });
  } catch (err) {
    console.error('[Coverage] ranking error:', err);
    res.status(500).json({ error: 'خطأ في جلب بيانات الترتيب' });
  }
});

/* ── GET /coverage/visits-range ──────────────────────────────────
   Daily-visits KPI for the "متابعة الزيارات اليومية" tab over an
   ARBITRARY date range (date_from/date_to), unlike /ranking which is
   locked to a single calendar month because its weekly buckets are built
   from day-of-month numbers (1–31) that reset every month and can't span
   a month boundary.

   A "visit" is still customer_code × distinct day, matching /ranking's
   definition (day_cnt) — but the denominator here is the rep's own count
   of distinct dates with at least one visit IN THE RANGE, not an inferred
   "active work days" from whole-week granularity. That is a strictly more
   accurate answer once real dates are available, and it is what the ASP
   VISIT_TARGET_SCORE=13 methodology (region-performance scorecard) already
   compares against. ── */
router.get('/visits-range', verifyToken, applyRegionFilter, async (req, res) => {
  const dateFrom = (req.query.date_from || '').trim();
  const dateTo   = (req.query.date_to   || '').trim();
  /* Multiple regions may be picked together (checkbox multi-select on the
     "متابعة الزيارات اليومية" tab) — express expands repeated ?branch=..
     query params into an array, a single one stays a string, and none at
     all means "كل المناطق" (unchanged default). An explicit empty selection
     ("لا شيء") is handled entirely on the client (it never calls this
     endpoint), so branch here is either absent or a non-empty list/string. */
  let branch = req.query.branch || null;
  if (branch && !Array.isArray(branch)) branch = [branch];
  branch = branch ? branch.map(b => String(b).trim()).filter(Boolean) : null;
  if (branch && !branch.length) branch = null;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'من وإلى تاريخ مطلوبان' });
  }
  if (dateTo < dateFrom) {
    return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });
  }

  try {
    const allowedBranches = (req.regionFilter && req.regionFilter.length)
      ? await resolveRegionBranch(req.regionFilter)
      : null;

    const params = [dateFrom, dateTo];
    let branchCond = '';
    if (allowedBranches) {
      const requested = branch ? branch.filter(b => allowedBranches.includes(b)) : [];
      const branchVal = requested.length ? requested : allowedBranches;
      params.push(branchVal);
      branchCond = `AND TRIM(branch_name) = ANY($3::text[])`;
    } else if (branch) {
      branchCond = `AND TRIM(branch_name) = ANY($3::text[])`;
      params.push(branch);
    }

    const { rows } = await pool.query(`
      WITH day_vis AS (
        SELECT
          TRIM(salesrep_name)                                     AS rep,
          TRIM(COALESCE(branch_name,''))                          AS branch,
          customer_code,
          make_date(report_year::int, month_num::int, day::int)   AS visit_date
        FROM sales_activity
        WHERE day IS NOT NULL
          AND salesrep_name IS NOT NULL AND TRIM(salesrep_name) != ''
          ${branchCond}
      ),
      in_range AS (
        SELECT * FROM day_vis
        WHERE visit_date BETWEEN $1::date AND $2::date
      )
      SELECT
        rep                                        AS rep_name,
        MAX(branch)                                AS branch_name,
        COUNT(DISTINCT customer_code || '|' || visit_date)::int AS total_visits,
        COUNT(DISTINCT visit_date)::int             AS active_days
      FROM in_range
      GROUP BY rep
      ORDER BY (COUNT(DISTINCT customer_code || '|' || visit_date)::numeric
                / NULLIF(COUNT(DISTINCT visit_date), 0)) ASC NULLS LAST
    `, params);

    const reps = rows.map(r => {
      const activeDays  = parseInt(r.active_days) || 0;
      const totalVisits = parseInt(r.total_visits) || 0;
      return {
        rep_name:     r.rep_name,
        branch_name:  r.branch_name,
        total_visits: totalVisits,
        active_days:  activeDays,
        avg_visits:   activeDays > 0 ? +(totalVisits / activeDays).toFixed(2) : null,
      };
    });

    res.json({ reps, period: { date_from: dateFrom, date_to: dateTo } });
  } catch (err) {
    console.error('[Coverage] visits-range error:', err);
    res.status(500).json({ error: 'خطأ في جلب بيانات الزيارات' });
  }
});

module.exports = router;
