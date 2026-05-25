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

module.exports = router;
