/**
 * collections.js — GET /api/collections/performance
 *
 * Returns daily payment totals broken down by region, plus KPI summary.
 *
 * Query params:
 *   year, month          – default: current month (used when no date_from/date_to)
 *   date_from, date_to   – explicit date range override (YYYY-MM-DD)
 *   region_id            – filter to a single region (optional)
 */

const express = require('express');
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

const router = express.Router();

/* ── Date helpers ───────────────────────────────────────────── */
function padMonth(m) { return String(m).padStart(2, '0'); }

function monthRange(year, month) {
  const from = `${year}-${padMonth(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${padMonth(month)}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

/* ─────────────────────────────────────────────────────────────
   GET /api/collections/performance
───────────────────────────────────────────────────────────── */
router.get('/performance', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const year     = parseInt(req.query.year)  || new Date().getFullYear();
    const month    = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const regionId = req.query.region_id ? parseInt(req.query.region_id) : null;

    let dateFrom = (req.query.date_from || '').trim() || null;
    let dateTo   = (req.query.date_to   || '').trim() || null;

    // Fall back to full month when no explicit range
    if (!dateFrom || !dateTo) {
      const r = monthRange(year, month);
      dateFrom = r.from;
      dateTo   = r.to;
    }

    /* ── Region lookup ───────────────────────────────────────── */
    const regionsRes = await pool.query(
      'SELECT id, name_ar FROM regions ORDER BY id'
    );
    const allRegions = regionsRes.rows;

    /* ── Main query: daily totals per region ─────────────────── */
    // Region-payment link: customer_code → invoices.customer_id → invoices.region_id
    // We use a DISTINCT subquery on invoices to avoid fan-out
    const vals = [dateFrom, dateTo];
    let regionClause = '';
    if (regionId) {
      vals.push(regionId);
      regionClause = `AND r.id = $${vals.length}`;
    }

    const dailySQL = `
      SELECT
        p.tran_date::text                        AS tran_date,
        r.id                                     AS region_id,
        r.name_ar                                AS region_name,
        ROUND(SUM(p.total_paid)::numeric, 2)     AS total_paid,
        ROUND(SUM(p.cash)::numeric, 2)           AS cash,
        ROUND(SUM(p.cheque)::numeric, 2)         AS cheque,
        ROUND(SUM(p.bank_tran)::numeric, 2)      AS bank_tran,
        ROUND(SUM(p.pos)::numeric, 2)            AS pos,
        COUNT(*)::int                            AS tx_count,
        COUNT(DISTINCT p.customer_code)::int     AS customer_count
      FROM payments p
      JOIN (
        SELECT DISTINCT customer_id, region_id
        FROM invoices
        WHERE region_id IS NOT NULL
      ) inv ON inv.customer_id = p.customer_code
      JOIN regions r ON r.id = inv.region_id
      WHERE p.tran_date BETWEEN $1 AND $2
        ${regionClause}
      GROUP BY p.tran_date, r.id, r.name_ar
      ORDER BY p.tran_date, r.id
    `;

    /* ── KPI totals ──────────────────────────────────────────── */
    const kpiSQL = `
      SELECT
        ROUND(SUM(p.total_paid)::numeric, 2)     AS total_paid,
        ROUND(SUM(p.cash)::numeric, 2)           AS cash,
        ROUND(SUM(p.cheque)::numeric, 2)         AS cheque,
        ROUND(SUM(p.bank_tran)::numeric, 2)      AS bank_tran,
        ROUND(SUM(p.pos)::numeric, 2)            AS pos,
        COUNT(*)::int                            AS tx_count,
        COUNT(DISTINCT p.customer_code)::int     AS customer_count,
        COUNT(DISTINCT p.tran_date)::int         AS active_days
      FROM payments p
      JOIN (
        SELECT DISTINCT customer_id, region_id
        FROM invoices
        WHERE region_id IS NOT NULL
      ) inv ON inv.customer_id = p.customer_code
      JOIN regions r ON r.id = inv.region_id
      WHERE p.tran_date BETWEEN $1 AND $2
        ${regionClause}
    `;

    /* ── Region totals (for the summary row / comparison) ─────── */
    const regionTotalsSQL = `
      SELECT
        r.id                                     AS region_id,
        r.name_ar                                AS region_name,
        ROUND(SUM(p.total_paid)::numeric, 2)     AS total_paid,
        ROUND(SUM(p.cash)::numeric, 2)           AS cash,
        ROUND(SUM(p.cheque)::numeric, 2)         AS cheque,
        ROUND(SUM(p.bank_tran)::numeric, 2)      AS bank_tran,
        ROUND(SUM(p.pos)::numeric, 2)            AS pos,
        COUNT(*)::int                            AS tx_count,
        COUNT(DISTINCT p.customer_code)::int     AS customer_count
      FROM payments p
      JOIN (
        SELECT DISTINCT customer_id, region_id
        FROM invoices
        WHERE region_id IS NOT NULL
      ) inv ON inv.customer_id = p.customer_code
      JOIN regions r ON r.id = inv.region_id
      WHERE p.tran_date BETWEEN $1 AND $2
        ${regionClause}
      GROUP BY r.id, r.name_ar
      ORDER BY SUM(p.total_paid) DESC
    `;

    const [dailyRes, kpiRes, regionTotalsRes] = await Promise.all([
      pool.query(dailySQL, vals),
      pool.query(kpiSQL,   vals),
      pool.query(regionTotalsSQL, vals),
    ]);

    res.json({
      date_from:     dateFrom,
      date_to:       dateTo,
      year,
      month,
      kpis:          kpiRes.rows[0] || {},
      daily:         dailyRes.rows,
      region_totals: regionTotalsRes.rows,
      regions:       allRegions,
    });
  } catch (err) {
    console.error('collections/performance error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
