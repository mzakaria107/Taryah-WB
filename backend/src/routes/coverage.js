const express = require('express');
const pool    = require('../db/pool');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

/* ─────────────────────────────────────────────────────────────
   GET /api/coverage/filters?year=2026
   Returns unique branches and reps for selection dropdowns
───────────────────────────────────────────────────────────── */
router.get('/filters', verifyToken, async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT
        COALESCE(TRIM(branch_name), '') AS branch_name,
        COALESCE(TRIM(salesrep_name), '') AS salesrep_name
      FROM sales_activity
      WHERE report_year = $1
        AND salesrep_name IS NOT NULL AND TRIM(salesrep_name) != ''
      ORDER BY branch_name, salesrep_name
    `, [year]);

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
router.get('/profile', verifyToken, async (req, res) => {
  const repName = (req.query.rep || '').trim();
  const year    = parseInt(req.query.year)  || new Date().getFullYear();
  const month   = parseInt(req.query.month) || (new Date().getMonth() + 1);

  if (!repName) return res.status(400).json({ error: 'اسم المندوب مطلوب' });

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;

  try {
    /* 1 ── Global + branch rankings for the current month ─── */
    const rankRes = await pool.query(`
      WITH rep_monthly AS (
        SELECT
          TRIM(salesrep_name)                       AS salesrep_name,
          MAX(TRIM(COALESCE(branch_name,'')))        AS branch_name,
          SUM(qty)                                   AS total_qty,
          COUNT(*)                                   AS invoice_count,
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
    const prevRes = await pool.query(`
      SELECT
        customer_code,
        MAX(TRIM(customer_name))  AS customer_name,
        COUNT(*)                  AS invoice_count,
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
        COUNT(*)                  AS invoice_count,
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
        COUNT(*)   AS day_orders
      FROM sales_activity
      WHERE report_year = $1 AND month_num = $2 AND TRIM(salesrep_name) = $3
        AND day IS NOT NULL
      GROUP BY customer_code, day
      ORDER BY customer_code, day
    `, [year, month, repName]);

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
        },
      },
      period: { month, year, prev_month: prevMonth, prev_year: prevYear },
      prev_customers: prevRes.rows.map(r => ({
        customer_code:  r.customer_code,
        customer_name:  r.customer_name,
        invoice_count:  Number(r.invoice_count),
        total_qty:      Number(r.total_qty),
      })),
      curr_customers: currRes.rows.map(r => ({
        customer_code:  r.customer_code,
        customer_name:  r.customer_name,
        invoice_count:  Number(r.invoice_count),
        total_qty:      Number(r.total_qty),
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
router.get('/ranking', verifyToken, async (req, res) => {
  const year   = parseInt(req.query.year)  || new Date().getFullYear();
  const month  = parseInt(req.query.month) || (new Date().getMonth() + 1);
  const branch = (req.query.branch || '').trim();

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;

  try {
    const params = [year, month, prevYear, prevMonth];
    const branchCond = branch ? `AND TRIM(branch_name) = $5` : '';
    if (branch) params.push(branch);

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
      overall AS (
        SELECT rep,
          COUNT(DISTINCT customer_code) AS vis_custs,
          COUNT(*)                      AS total_vis
        FROM day_vis GROUP BY rep
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
        COALESCE(qa.total_qty, 0)                                    AS total_qty
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

module.exports = router;
