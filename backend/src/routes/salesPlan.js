/* ═══════════════════════════════════════════════════════════════
   GET /api/sales-plan
   Actuals that feed the "خطة المبيعات" page: the last N complete
   months (default 9) of chilled-chicken sales per region, plus the
   debt / collection picture per region. The plan itself (60,000
   units/day split by region × weight, staffing) lives in the frontend
   (data/salesPlan.js) — this endpoint only returns facts.

   Conventions reused from the rest of the app:
   - sales_activity.branch_name = regions.name_ar (English identifier).
   - "direct" = central-warehouse pseudo-rep, excluded by default.
   - Active customer in a month = net qty > 0 that month.
   - Debt = plain SUM(balance), no status filter, minus 'direct'.
   - Unit weight comes from the item name ("1000gm", "450 g").
═══════════════════════════════════════════════════════════════ */
const express = require('express');
const pool = require('../db/pool');
const { verifyToken, requirePagePermission } = require('../middleware/auth');

const router = express.Router();

const DEFAULT_CATEGORIES = ['دجاج مبرد طرية'];
const ITEM_GRAMS_SQL = `NULLIF(substring(sa.item_name_en from '([0-9]+(?:\\.[0-9]+)?) *[gG]'),'')::numeric`;
const DIRECT_INV = `LOWER(TRIM(COALESCE(i.sales_rep_name, ''))) <> 'direct'`;

/* Working days — same calculator as regionPerformance.js / summary.js / performanceDashboard.js
   (skip Friday + named holidays) so the daily average here matches "متوسط الكميات اليومية" on
   the region-performance page. Keep HOLIDAYS in sync with those files. */
const HOLIDAYS = [
  { year: 2026, month: 5, days: [27, 28, 29] }, // عيد الأضحى 1447هـ
];
function workingDays(year, month) {
  const last = new Date(year, month, 0).getDate();
  let n = 0;
  for (let d = 1; d <= last; d++) {
    const holiday = HOLIDAYS.some(h => h.year === year && h.month === month && h.days.includes(d));
    if (new Date(year, month - 1, d).getDay() !== 5 && !holiday) n++;
  }
  return Math.max(n, 1);
}

function windowMonths(n) {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth() + 1;     // current (incomplete) month
  const out = [];
  for (let k = 0; k < n; k++) {
    m -= 1; if (m === 0) { m = 12; y -= 1; }
    out.unshift({ y, m });
  }
  return out;
}

router.get('/', verifyToken, requirePagePermission('sales_plan', 1), async (req, res) => {
  try {
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 9, 1), 24);
    const win = windowMonths(months);
    const first = win[0], last = win[win.length - 1];
    const dateFrom = `${first.y}-${String(first.m).padStart(2, '0')}-01`;
    const lastDay = new Date(last.y, last.m, 0).getDate();
    const dateTo = `${last.y}-${String(last.m).padStart(2, '0')}-${lastDay}`;
    const calendarDays = Math.round((new Date(dateTo) - new Date(dateFrom)) / 86400000) + 1;

    let categories = req.query.categories;
    if (typeof categories === 'string') categories = categories.split(',');
    categories = (categories || DEFAULT_CATEGORIES).map(s => String(s).trim().toLowerCase()).filter(Boolean);
    // Region-performance counts direct (central-warehouse) sales in its quantities, so the plan
    // includes them too by default to keep the two daily averages identical.
    const excludeDirect = req.query.exclude_direct === '1';

    // sales_activity window predicate: (year*100 + month) between first and last
    const ymFrom = first.y * 100 + first.m, ymTo = last.y * 100 + last.m;
    const saBase = `(sa.report_year * 100 + sa.month_num) BETWEEN $1 AND $2
      ${excludeDirect ? `AND LOWER(TRIM(COALESCE(sa.salesrep_name, ''))) <> 'direct'` : ''}`;
    const saCat = `LOWER(TRIM(COALESCE(sa.item_category_en, ''))) = ANY($3::text[])`;
    const saParams = [ymFrom, ymTo, categories];

    const q = (sql, params) => pool.query(sql, params).then(r => r.rows);

    const [
      regions, byBranch, activeByMonth, sellingDays, repsByMonth, byWeight, filletRows,
      allCats, salesValue, payments, debt, overdue, dormant, top10, repsOverdue, carrefour, badDebt, byMonth,
    ] = await Promise.all([
      // fleet_only (migration 112) may be missing if startup migrations stalled — fall back.
      q(`SELECT id, name_ar FROM regions WHERE COALESCE(fleet_only, false) = false ORDER BY id`)
        .catch(() => q(`SELECT id, name_ar FROM regions ORDER BY id`)),

      // Chilled qty / revenue per branch
      q(`SELECT COALESCE(NULLIF(TRIM(sa.branch_name), ''), 'غير محدد') AS branch,
                COALESCE(SUM(sa.qty), 0)::bigint AS qty,
                COALESCE(SUM(sa.net_revenue), 0)::numeric AS revenue
         FROM sales_activity sa WHERE ${saBase} AND ${saCat}
         GROUP BY 1`, saParams),

      // Active customers (net qty > 0) per branch per month
      q(`SELECT branch, ym, COUNT(*)::int AS active FROM (
           SELECT COALESCE(NULLIF(TRIM(sa.branch_name), ''), 'غير محدد') AS branch,
                  sa.report_year * 100 + sa.month_num AS ym, sa.customer_code, SUM(sa.qty) AS q
           FROM sales_activity sa WHERE ${saBase} AND ${saCat}
           GROUP BY 1, 2, 3
         ) c WHERE q > 0 GROUP BY 1, 2`, saParams),

      // Selling days: company-wide distinct dates with chilled sales, and per branch
      q(`SELECT COALESCE(NULLIF(TRIM(sa.branch_name), ''), 'غير محدد') AS branch,
                COUNT(DISTINCT (sa.report_year, sa.month_num, sa.day))::int AS days
         FROM sales_activity sa WHERE ${saBase} AND ${saCat} AND sa.day IS NOT NULL AND sa.qty > 0
         GROUP BY ROLLUP (1)`, saParams),

      // Field reps actually selling chilled, per branch per month
      q(`SELECT COALESCE(NULLIF(TRIM(sa.branch_name), ''), 'غير محدد') AS branch,
                sa.report_year * 100 + sa.month_num AS ym,
                COUNT(DISTINCT TRIM(sa.salesrep_name))::int AS reps
         FROM sales_activity sa
         WHERE ${saBase} AND ${saCat} AND sa.qty > 0
           AND sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) <> ''
           AND LOWER(TRIM(sa.salesrep_name)) <> 'direct'
         GROUP BY 1, 2`, saParams),

      // Weight-class mix per branch (chilled categories)
      q(`SELECT COALESCE(NULLIF(TRIM(sa.branch_name), ''), 'غير محدد') AS branch,
                ROUND(${ITEM_GRAMS_SQL})::int AS grams,
                COALESCE(SUM(sa.qty), 0)::bigint AS qty,
                COALESCE(SUM(sa.net_revenue), 0)::numeric AS revenue
         FROM sales_activity sa WHERE ${saBase} AND ${saCat}
         GROUP BY 1, 2`, saParams),

      // Fillet (any category) per branch — the plan has a "فيليه 450ج" line
      q(`SELECT COALESCE(NULLIF(TRIM(sa.branch_name), ''), 'غير محدد') AS branch,
                COALESCE(SUM(sa.qty), 0)::bigint AS qty,
                COALESCE(SUM(sa.net_revenue), 0)::numeric AS revenue
         FROM sales_activity sa
         WHERE ${saBase} AND (sa.item_name_en ILIKE '%fillet%' OR sa.item_name_en ILIKE '%فيلي%')
         GROUP BY 1`, [ymFrom, ymTo]),

      // Category list for the picker
      q(`SELECT TRIM(sa.item_category_en) AS name, COALESCE(SUM(sa.qty), 0)::bigint AS qty
         FROM sales_activity sa
         WHERE (sa.report_year * 100 + sa.month_num) BETWEEN $1 AND $2 AND TRIM(COALESCE(sa.item_category_en, '')) <> ''
         GROUP BY 1 ORDER BY 2 DESC`, [ymFrom, ymTo]),

      // Invoiced value in the window per region (all products — debt is on all products)
      q(`SELECT i.region_id, COALESCE(SUM(i.original_amount), 0)::numeric AS invoiced
         FROM invoices i
         WHERE i.invoice_date BETWEEN $1 AND $2 AND ${DIRECT_INV}
         GROUP BY 1`, [dateFrom, dateTo]),

      // Collected in the window per region (payment → customer's region via invoices)
      q(`WITH cust_region AS (
           SELECT customer_id, MAX(region_id) AS region_id FROM invoices WHERE ${DIRECT_INV.replace(/i\./g, '')}
           GROUP BY customer_id
         )
         SELECT cr.region_id, COALESCE(SUM(p.total_paid), 0)::numeric AS collected
         FROM payments p JOIN cust_region cr ON cr.customer_id = p.customer_code
         WHERE p.tran_date BETWEEN $1 AND $2
         GROUP BY 1`, [dateFrom, dateTo]),

      // Current debt per region + customers carrying debt
      q(`SELECT i.region_id,
                COALESCE(SUM(i.balance), 0)::numeric AS debt,
                COUNT(DISTINCT i.customer_id) FILTER (WHERE i.balance > 0)::int AS debtors
         FROM invoices i WHERE ${DIRECT_INV}
         GROUP BY 1`),

      // Overdue buckets per region (by invoice age)
      q(`SELECT i.region_id,
                COALESCE(SUM(i.balance) FILTER (WHERE CURRENT_DATE - i.invoice_date > 60), 0)::numeric  AS over60,
                COALESCE(SUM(i.balance) FILTER (WHERE CURRENT_DATE - i.invoice_date > 90), 0)::numeric  AS over90,
                COALESCE(SUM(i.balance) FILTER (WHERE CURRENT_DATE - i.invoice_date > 180), 0)::numeric AS over180,
                COALESCE(SUM(i.balance) FILTER (WHERE CURRENT_DATE - i.invoice_date > 365), 0)::numeric AS over365
         FROM invoices i WHERE ${DIRECT_INV} AND i.balance > 0
         GROUP BY 1`),

      // Dormant debtors: owe money but bought nothing in the last 60 days
      q(`SELECT region_id, COUNT(*)::int AS customers, COALESCE(SUM(debt), 0)::numeric AS debt FROM (
           SELECT i.customer_id, MAX(i.region_id) AS region_id, SUM(i.balance) AS debt, MAX(i.invoice_date) AS last_inv
           FROM invoices i WHERE ${DIRECT_INV}
           GROUP BY i.customer_id
         ) c WHERE debt > 0 AND last_inv < CURRENT_DATE - 60
         GROUP BY 1`),

      // Top 10 debtors
      q(`SELECT i.customer_id, MAX(i.customer_name) AS customer_name, MAX(r.name_ar) AS region,
                SUM(i.balance)::numeric AS debt,
                MAX(CURRENT_DATE - i.invoice_date) FILTER (WHERE i.balance > 0)::int AS oldest_days,
                MAX(i.invoice_date)::text AS last_invoice
         FROM invoices i LEFT JOIN regions r ON r.id = i.region_id
         WHERE ${DIRECT_INV}
         GROUP BY i.customer_id HAVING SUM(i.balance) > 0
         ORDER BY debt DESC LIMIT 10`),

      // Reps with the most debt older than 90 days
      q(`SELECT TRIM(i.sales_rep_name) AS rep, MAX(r.name_ar) AS region,
                SUM(i.balance)::numeric AS debt,
                COALESCE(SUM(i.balance) FILTER (WHERE CURRENT_DATE - i.invoice_date > 90), 0)::numeric AS over90
         FROM invoices i LEFT JOIN regions r ON r.id = i.region_id
         WHERE ${DIRECT_INV} AND COALESCE(TRIM(i.sales_rep_name), '') <> ''
         GROUP BY 1 HAVING SUM(i.balance) > 0
         ORDER BY over90 DESC LIMIT 10`),

      // Carrefour share of debt
      q(`SELECT COALESCE(SUM(i.balance), 0)::numeric AS debt
         FROM invoices i
         WHERE ${DIRECT_INV} AND (i.customer_name ILIKE '%كارفور%' OR i.customer_name_en ILIKE '%carrefour%')`),

      // Flagged bad debt (table may not exist yet)
      pool.query(`SELECT COALESCE(SUM(i.balance), 0)::numeric AS debt, COUNT(DISTINCT b.customer_id)::int AS customers
                  FROM bad_debt_customers b JOIN invoices i ON i.customer_id = b.customer_id
                  WHERE ${DIRECT_INV}`).then(r => r.rows).catch(() => [{ debt: 0, customers: 0 }]),

      // Chilled qty per month (company) — lets the page show any sub-window's daily average
      q(`SELECT sa.report_year * 100 + sa.month_num AS ym, COALESCE(SUM(sa.qty), 0)::bigint AS qty
         FROM sales_activity sa WHERE ${saBase} AND ${saCat}
         GROUP BY 1`, saParams),
    ]);

    const n = v => Number(v || 0);
    const regionById = new Map(regions.map(r => [r.id, r.name_ar]));
    const byRegionId = (rows, field) => {
      const m = new Map();
      for (const r of rows) {
        const name = regionById.get(r.region_id) || 'غير محدد';
        m.set(name, (m.get(name) || 0) + n(r[field]));
      }
      return m;
    };

    const companyDays = n(sellingDays.find(r => r.branch === null)?.days);
    const monthlyQty = new Map(byMonth.map(r => [Number(r.ym), n(r.qty)]));
    const branchDays = new Map(sellingDays.filter(r => r.branch !== null).map(r => [r.branch, n(r.days)]));

    const avgPerMonth = (rows, field) => {
      const sums = new Map();
      for (const r of rows) sums.set(r.branch, (sums.get(r.branch) || 0) + n(r[field]));
      return new Map([...sums].map(([b, s]) => [b, s / win.length]));
    };
    const activeAvg = avgPerMonth(activeByMonth, 'active');
    const repsAvg = avgPerMonth(repsByMonth, 'reps');

    const weights = new Map();       // branch -> { grams: {qty, revenue} }
    for (const r of byWeight) {
      if (!weights.has(r.branch)) weights.set(r.branch, {});
      const g = r.grams == null ? 'other' : String(r.grams);
      const w = weights.get(r.branch);
      w[g] = { qty: n(w[g]?.qty) + n(r.qty), revenue: n(w[g]?.revenue) + n(r.revenue) };
    }
    const fillet = new Map(filletRows.map(r => [r.branch, { qty: n(r.qty), revenue: n(r.revenue) }]));

    const invoiced = byRegionId(salesValue, 'invoiced');
    const collected = byRegionId(payments, 'collected');
    const debtM = byRegionId(debt, 'debt');
    const debtorsM = byRegionId(debt, 'debtors');
    const over = ['over60', 'over90', 'over180', 'over365'].reduce((o, k) => ({ ...o, [k]: byRegionId(overdue, k) }), {});
    const dormantCust = byRegionId(dormant, 'customers');
    const dormantDebt = byRegionId(dormant, 'debt');

    /* ── Ramp baseline + expansion pool ─────────────────────────────
       "Recent" = the last 3 months of the window (today's run-rate); "prior" = the months before.
       Per customer: lost (bought before, nothing net in the recent months), declining (recent
       daily < 70% of prior daily), new (first appears in the recent months). */
    const recent = win.slice(-Math.min(3, win.length));
    const prior = win.slice(0, win.length - recent.length);
    const recentFrom = recent[0].y * 100 + recent[0].m;
    const recentDays = recent.reduce((s, m) => s + workingDays(m.y, m.m), 0);
    const priorDays = prior.reduce((s, m) => s + workingDays(m.y, m.m), 0);
    const [branchMonthly, custRows] = await Promise.all([
      q(`SELECT COALESCE(NULLIF(TRIM(sa.branch_name), ''), 'غير محدد') AS branch,
                sa.report_year * 100 + sa.month_num AS ym, COALESCE(SUM(sa.qty), 0)::bigint AS qty
         FROM sales_activity sa WHERE ${saBase} AND ${saCat}
         GROUP BY 1, 2`, saParams),
      q(`SELECT sa.customer_code,
                MAX(sa.customer_name) AS customer_name,
                MAX(COALESCE(NULLIF(TRIM(sa.branch_name), ''), 'غير محدد')) AS branch,
                MAX(TRIM(sa.salesrep_name)) AS rep,
                COALESCE(SUM(sa.qty) FILTER (WHERE sa.report_year * 100 + sa.month_num >= $4), 0)::bigint AS recent,
                COALESCE(SUM(sa.qty) FILTER (WHERE sa.report_year * 100 + sa.month_num <  $4), 0)::bigint AS prior,
                MAX(sa.report_year * 100 + sa.month_num) FILTER (WHERE sa.qty > 0) AS last_ym
         FROM sales_activity sa WHERE ${saBase} AND ${saCat}
         GROUP BY sa.customer_code`, [...saParams, recentFrom]),
    ]);
    const recentQty = new Map(), recentActive = new Map(), recentReps = new Map();
    for (const r of branchMonthly) if (Number(r.ym) >= recentFrom) recentQty.set(r.branch, (recentQty.get(r.branch) || 0) + n(r.qty));
    for (const r of activeByMonth) if (Number(r.ym) >= recentFrom) recentActive.set(r.branch, (recentActive.get(r.branch) || 0) + n(r.active) / recent.length);
    for (const r of repsByMonth) if (Number(r.ym) >= recentFrom) recentReps.set(r.branch, (recentReps.get(r.branch) || 0) + n(r.reps) / recent.length);

    const pool_ = new Map();   // branch -> expansion-pool aggregates
    const lost = [], declining = [];
    const agg = b => { if (!pool_.has(b)) pool_.set(b, { lost: 0, lost_daily: 0, declining: 0, declining_loss: 0, new_customers: 0, new_daily: 0 }); return pool_.get(b); };
    for (const c of custRows) {
      const rq = n(c.recent), pq = n(c.prior);
      const rd = recentDays ? rq / recentDays : 0, pd = priorDays ? pq / priorDays : 0;
      const a = agg(c.branch);
      const row = { customer_code: c.customer_code, customer_name: c.customer_name, region: c.branch, rep: c.rep,
                    prior_daily: pd, recent_daily: rd, last_ym: c.last_ym };
      if (pq > 0 && rq <= 0) { a.lost += 1; a.lost_daily += pd; lost.push(row); }
      else if (pq > 0 && rq > 0 && rd < pd * 0.7) { a.declining += 1; a.declining_loss += pd - rd; declining.push({ ...row, loss: pd - rd }); }
      else if (pq <= 0 && rq > 0 && priorDays) { a.new_customers += 1; a.new_daily += rd; }
    }
    lost.sort((x, y) => y.prior_daily - x.prior_daily);
    declining.sort((x, y) => y.loss - x.loss);

    // The next 3 months (current month first) for the ramp.
    const today = new Date();
    const rampMonths = [0, 1, 2].map(k => {
      const d = new Date(today.getFullYear(), today.getMonth() + k, 1);
      return { y: d.getFullYear(), m: d.getMonth() + 1, working_days: workingDays(d.getFullYear(), d.getMonth() + 1) };
    });

    const branches = new Set([
      ...regions.map(r => r.name_ar), ...byBranch.map(r => r.branch), ...debtM.keys(),
    ]);
    const salesByBranch = new Map(byBranch.map(r => [r.branch, r]));

    const rows = [...branches].map(b => ({
      region: b,
      qty: n(salesByBranch.get(b)?.qty),
      revenue: n(salesByBranch.get(b)?.revenue),
      selling_days: branchDays.get(b) || 0,
      avg_active_customers: activeAvg.get(b) || 0,
      avg_active_reps: repsAvg.get(b) || 0,
      weights: weights.get(b) || {},
      fillet: fillet.get(b) || { qty: 0, revenue: 0 },
      invoiced: invoiced.get(b) || 0,
      collected: collected.get(b) || 0,
      debt: debtM.get(b) || 0,
      debtors: debtorsM.get(b) || 0,
      over60: over.over60.get(b) || 0,
      over90: over.over90.get(b) || 0,
      over180: over.over180.get(b) || 0,
      over365: over.over365.get(b) || 0,
      dormant_customers: dormantCust.get(b) || 0,
      dormant_debt: dormantDebt.get(b) || 0,
      recent_qty: recentQty.get(b) || 0,
      recent_active_customers: recentActive.get(b) || 0,
      recent_active_reps: recentReps.get(b) || 0,
      pool: pool_.get(b) || { lost: 0, lost_daily: 0, declining: 0, declining_loss: 0, new_customers: 0, new_daily: 0 },
    })).filter(r => r.qty || r.debt || r.invoiced || r.collected);

    res.json({
      window: {
        months: win.map(m => ({ ...m, working_days: workingDays(m.y, m.m), qty: n(monthlyQty.get(m.y * 100 + m.m)) })),
        date_from: dateFrom, date_to: dateTo, calendar_days: calendarDays, selling_days: companyDays,
        working_days: win.reduce((s, m) => s + workingDays(m.y, m.m), 0),
      },
      categories, exclude_direct: excludeDirect,
      category_options: allCats.map(c => ({ name: c.name, qty: n(c.qty) })),
      regions: rows,
      recent: { months: recent, working_days: recentDays, prior_working_days: priorDays },
      ramp_months: rampMonths,
      lost_customers: lost.slice(0, 20),
      declining_customers: declining.slice(0, 20),
      top_debtors: top10.map(r => ({ ...r, debt: n(r.debt) })),
      reps_overdue: repsOverdue.map(r => ({ ...r, debt: n(r.debt), over90: n(r.over90) })),
      carrefour_debt: n(carrefour[0]?.debt),
      bad_debt: { debt: n(badDebt[0]?.debt), customers: n(badDebt[0]?.customers) },
    });
  } catch (err) {
    console.error('[SalesPlan]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
