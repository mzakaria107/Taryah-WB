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
 *   page / limit     – pagination (default 500)
 */

const express = require('express');
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter, requirePagePermission } = require('../middleware/auth');
const { suiteQL } = require('../utils/netsuite');

const router = express.Router();

// A region-restricted user (req.regionFilter is a non-empty array) may still
// narrow down to ONE of their own assigned regions via ?region_id= — honour
// it only if it's actually one of theirs, else fall back to their full set.
function resolveRegionIdsParam(req, region_id) {
  const requested = region_id ? parseInt(region_id, 10) : null;
  if (req.regionFilter && req.regionFilter.length) {
    return (requested && req.regionFilter.includes(requested)) ? [requested] : req.regionFilter;
  }
  return requested ? [requested] : null;
}

/* ── Allowed sort columns ────────────────────────────────────── */
const SORT_COLS = {
  total_balance:   'total_balance',
  b_1_15:          'b_1_15',
  b_16_30:         'b_16_30',
  b_31_60:         'b_31_60',
  b_61_90:         'b_61_90',
  b_91_120:        'b_91_120',
  b_120_plus:      'b_120_plus',
  customer_name:   'customer_name',
  daily_change:    'daily_change',
  collection_rate: 'collection_rate',
  avg_age_days:    'avg_age_days',
};

/* ═══════════════════════════════════════════════════════════════
   GET /api/aging
═══════════════════════════════════════════════════════════════ */
router.get('/', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const {
      region_id, route_id, search, customer_type, sales_rep_name, exclude_carrefour,
      sort_by  = 'total_balance',
      sort_dir = 'DESC',
      page  = 1,
      limit = 500,
    } = req.query;

    /* ── Build WHERE conditions ───────────────────────────────── */
    const conditions = [`(i.status IN ('unpaid','partial') OR i.balance < 0)`];
    const params     = [];
    let   p          = 1;

    const effectiveRegionIds = resolveRegionIdsParam(req, region_id);
    if (effectiveRegionIds) {
      conditions.push(`i.region_id = ANY($${p++}::int[])`);
      params.push(effectiveRegionIds);
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
    if (sales_rep_name) {
      conditions.push(`i.sales_rep_name = $${p++}`);
      params.push(sales_rep_name);
    }
    /* Carrefour is a single hypermarket group whose 13 branches carry ~560K of
       open balance on long agreed terms — big enough to dominate the ageing
       buckets and hide how the rest of the book behaves. Matching BOTH name
       columns: they agree on every current row (434 either way), and relying
       on one alone would break the day a record fills in only the other. */
    if (exclude_carrefour === '1' || exclude_carrefour === 'true') {
      conditions.push(`(COALESCE(i.customer_name,'') NOT ILIKE '%كارفور%'
                    AND COALESCE(i.customer_name_en,'') NOT ILIKE '%carrefour%')`);
    }

    const where    = conditions.join(' AND ');
    const safeSort = SORT_COLS[sort_by] ?? 'total_balance';
    const safeDir  = sort_dir?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const pageNum  = Math.max(parseInt(page)  || 1, 1);
    const limNum   = Math.min(parseInt(limit) || 500, 2000);
    const offsetNum = (pageNum - 1) * limNum;

    /* ── Lazy daily snapshot ─────────────────────────────────── */
    // Save today's balances once per day (first API call triggers it)
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    const { rows: snapCheck } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM balance_snapshots WHERE snapshot_date = $1`, [todayStr]
    );
    if ((snapCheck[0].n) === 0) {
      await pool.query(`
        INSERT INTO balance_snapshots (snapshot_date, customer_id, customer_name, total_balance, invoice_count)
        SELECT
          $1::date,
          customer_id,
          MAX(customer_name),
          ROUND(SUM(balance)::numeric, 2),
          COUNT(*)::int
        FROM invoices
        WHERE (status IN ('unpaid','partial') OR balance < 0)
        GROUP BY customer_id
        ON CONFLICT (snapshot_date, customer_id) DO UPDATE
          SET total_balance = EXCLUDED.total_balance,
              invoice_count = EXCLUDED.invoice_count,
              customer_name = EXCLUDED.customer_name
      `, [todayStr]);
    }

    /* ── Previous snapshot date (subquery — avoids extra param) ─ */
    // Used inline in the main query via:
    //   bs.snapshot_date = (SELECT MAX(snapshot_date) FROM balance_snapshots WHERE snapshot_date < CURRENT_DATE)

    /* ── Main aging query ────────────────────────────────────── */
    // p now equals params.length + 1
    // lim → $p, offset → $p+1
    params.push(limNum, offsetNum);

    const { rows } = await pool.query(`
      SELECT
        i.customer_id,
        MAX(i.customer_name)      AS customer_name,
        MAX(i.customer_name_en)   AS customer_name_en,
        MAX(i.region_id)          AS region_id,
        MAX(i.route_id)           AS route_id,
        -- Aging buckets (NULL invoice_date falls through to b_120_plus)
        ROUND(SUM(CASE
          WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 1  AND 15
          THEN i.balance ELSE 0 END)::numeric, 2) AS b_1_15,
        ROUND(SUM(CASE
          WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 16 AND 30
          THEN i.balance ELSE 0 END)::numeric, 2) AS b_16_30,
        ROUND(SUM(CASE
          WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 31 AND 60
          THEN i.balance ELSE 0 END)::numeric, 2) AS b_31_60,
        ROUND(SUM(CASE
          WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 61 AND 90
          THEN i.balance ELSE 0 END)::numeric, 2) AS b_61_90,
        ROUND(SUM(CASE
          WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 91 AND 120
          THEN i.balance ELSE 0 END)::numeric, 2) AS b_91_120,
        ROUND(SUM(CASE
          WHEN i.invoice_date IS NULL OR (CURRENT_DATE - i.invoice_date) > 120
          THEN i.balance ELSE 0 END)::numeric, 2) AS b_120_plus,
        -- Totals
        ROUND(SUM(i.balance)::numeric, 2)         AS total_balance,
        ROUND(SUM(i.original_amount)::numeric, 2)  AS total_amount,
        ROUND(SUM(i.paid_amount)::numeric, 2)       AS total_paid,
        COUNT(*)::int                               AS invoice_count,
        ROUND((SUM(i.paid_amount) / NULLIF(SUM(i.original_amount),0) * 100)::numeric, 1) AS collection_rate,
        -- Age of the oldest outstanding invoice (days)
        MAX(
          CASE WHEN i.invoice_date IS NOT NULL
          THEN (CURRENT_DATE - i.invoice_date)
          ELSE 121 END
        )::int AS avg_age_days,
        -- Daily change vs most recent previous snapshot
        COALESCE(bs.total_balance, SUM(i.balance)) AS prev_balance,
        ROUND((SUM(i.balance) - COALESCE(bs.total_balance, SUM(i.balance)))::numeric, 2) AS daily_change
      FROM invoices i
      LEFT JOIN balance_snapshots bs
        ON  bs.customer_id    = i.customer_id
        AND bs.snapshot_date  = (
          SELECT MAX(snapshot_date) FROM balance_snapshots WHERE snapshot_date < CURRENT_DATE
        )
      WHERE ${where}
      GROUP BY i.customer_id, bs.total_balance
      HAVING SUM(i.balance) > 0
      ORDER BY ${safeSort} ${safeDir}
      LIMIT $${p} OFFSET $${p + 1}
    `, params);

    /* ── Count ───────────────────────────────────────────────── */
    // Use params minus lim/offset (last 2 elements)
    const filterParams = params.slice(0, -2);
    const { rows: countRows } = await pool.query(`
      SELECT COUNT(DISTINCT i.customer_id)::int AS total
      FROM invoices i
      WHERE ${where}
    `, filterParams);

    /* ── Bucket totals (KPI cards) ───────────────────────────── */
    const { rows: totals } = await pool.query(`
      SELECT
        ROUND(SUM(CASE WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 1  AND 15  THEN i.balance ELSE 0 END)::numeric,2) AS b_1_15,
        ROUND(SUM(CASE WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 16 AND 30  THEN i.balance ELSE 0 END)::numeric,2) AS b_16_30,
        ROUND(SUM(CASE WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 31 AND 60  THEN i.balance ELSE 0 END)::numeric,2) AS b_31_60,
        ROUND(SUM(CASE WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 61 AND 90  THEN i.balance ELSE 0 END)::numeric,2) AS b_61_90,
        ROUND(SUM(CASE WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 91 AND 120 THEN i.balance ELSE 0 END)::numeric,2) AS b_91_120,
        ROUND(SUM(CASE WHEN i.invoice_date IS NULL OR (CURRENT_DATE - i.invoice_date) > 120                   THEN i.balance ELSE 0 END)::numeric,2) AS b_120_plus,
        ROUND(SUM(i.balance)::numeric, 2)         AS total_balance,
        COUNT(DISTINCT i.customer_id)::int         AS customer_count,
        COUNT(*)::int                              AS invoice_count
      FROM invoices i
      WHERE ${where}
    `, filterParams);

    /* ── Region breakdown ────────────────────────────────────── */
    const { rows: byRegion } = await pool.query(`
      SELECT
        i.region_id,
        r.name_ar AS region_name,
        ROUND(SUM(CASE WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 1  AND 15  THEN i.balance ELSE 0 END)::numeric,2) AS b_1_15,
        ROUND(SUM(CASE WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 16 AND 30  THEN i.balance ELSE 0 END)::numeric,2) AS b_16_30,
        ROUND(SUM(CASE WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 31 AND 60  THEN i.balance ELSE 0 END)::numeric,2) AS b_31_60,
        ROUND(SUM(CASE WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 61 AND 90  THEN i.balance ELSE 0 END)::numeric,2) AS b_61_90,
        ROUND(SUM(CASE WHEN i.invoice_date IS NOT NULL AND (CURRENT_DATE - i.invoice_date) BETWEEN 91 AND 120 THEN i.balance ELSE 0 END)::numeric,2) AS b_91_120,
        ROUND(SUM(CASE WHEN i.invoice_date IS NULL OR (CURRENT_DATE - i.invoice_date) > 120                   THEN i.balance ELSE 0 END)::numeric,2) AS b_120_plus,
        ROUND(SUM(i.balance)::numeric, 2)         AS total_balance,
        COUNT(DISTINCT i.customer_id)::int         AS customer_count
      FROM invoices i
      LEFT JOIN regions r ON r.id = i.region_id
      WHERE ${where}
      GROUP BY i.region_id, r.name_ar
      ORDER BY total_balance DESC
    `, filterParams);

    /* ── Previous snapshot date (for display) ────────────────── */
    const { rows: prevSnap } = await pool.query(
      `SELECT MAX(snapshot_date)::text AS prev_date FROM balance_snapshots WHERE snapshot_date < $1`,
      [todayStr]
    );

    res.json({
      customers:     rows,
      total:         countRows[0]?.total || 0,
      kpis:          totals[0] || {},
      by_region:     byRegion,
      snapshot_date: todayStr,
      prev_date:     prevSnap[0]?.prev_date || null,
    });
  } catch (err) {
    console.error('[Aging]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/aging/collections
   Old-debt collection tracker: invoices dated within [date_from,
   date_to] define the "old debt" set. "دين الفواتير" is a FROZEN
   SNAPSHOT of each customer's balance for that set, taken the first
   time this exact period is queried for them (stored in
   old_debt_snapshots) — later calls reuse the stored value instead of
   recomputing it, so it stays fixed even as invoices.balance changes.
   "الرصيد الحالي" always reflects the live balance, so the gap between
   the two columns is exactly what's been collected since the period
   was first opened. Also returned: a flat list of payments received
   per customer per day — scoped to the CURRENT CALENDAR MONTH ONLY
   (1st of this month through today), independent of date_from/date_to.
   Payments only soft-link to a customer (via customer_code), not to a
   specific invoice, so daily collection is tracked at the customer
   level rather than per-invoice.
═══════════════════════════════════════════════════════════════ */
router.get('/collections', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const { date_from, date_to, region_id, sales_rep_name, exclude_carrefour } = req.query;
    if (!date_from || !date_to) {
      return res.status(400).json({ error: 'date_from و date_to مطلوبان' });
    }

    const conditions = [`i.invoice_date BETWEEN $1 AND $2`];
    const params = [date_from, date_to];
    let p = 3;

    const effectiveRegionIds = resolveRegionIdsParam(req, region_id);
    if (effectiveRegionIds) {
      conditions.push(`i.region_id = ANY($${p++}::int[])`);
      params.push(effectiveRegionIds);
    }
    if (sales_rep_name) {
      conditions.push(`i.sales_rep_name = $${p++}`);
      params.push(sales_rep_name);
    }
    /* Carrefour is a single hypermarket group whose 13 branches carry ~560K of
       open balance on long agreed terms — big enough to dominate the ageing
       buckets and hide how the rest of the book behaves. Matching BOTH name
       columns: they agree on every current row (434 either way), and relying
       on one alone would break the day a record fills in only the other. */
    if (exclude_carrefour === '1' || exclude_carrefour === 'true') {
      conditions.push(`(COALESCE(i.customer_name,'') NOT ILIKE '%كارفور%'
                    AND COALESCE(i.customer_name_en,'') NOT ILIKE '%carrefour%')`);
    }

    const where = conditions.join(' AND ');

    /* Rep attribution — split by ACTUAL invoice rep, not one name picked
       for the whole customer. 1,062 of ~2,600 customers here (40%) have
       invoices tied to more than one distinct sales_rep_name historically
       (route reassignment, a substitute covering a day, inconsistent
       recording) — collapsing that to a single MAX()-picked name pinned
       the customer's ENTIRE balance on whoever happened to sort last, which
       both misattributed debt and hid that it was ever shared. Grouping by
       (customer_id, sales_rep_name) instead gives each rep their own row —
       the parent "دين الفواتير" total below is simply these summed back up,
       so it can never disagree with its own breakdown. */
    const { rows: repRows } = await pool.query(`
      SELECT
        i.customer_id,
        i.sales_rep_name,
        MAX(i.customer_name)    AS customer_name,
        MAX(i.region_id)        AS region_id,
        MAX(r.name_ar)          AS region_name,
        COUNT(*)::int                              AS invoice_count,
        COUNT(*) FILTER (WHERE i.balance > 0)::int AS unpaid_count,
        ROUND(SUM(i.balance)::numeric, 2)          AS current_balance
      FROM invoices i
      LEFT JOIN regions r ON r.id = i.region_id
      WHERE ${where}
      GROUP BY i.customer_id, i.sales_rep_name
      HAVING SUM(i.original_amount) > 0
    `, params);

    if (!repRows.length) {
      return res.json({ customers: [], payments: [], date_from, date_to });
    }

    // Freeze each (customer, rep) combo the first time this period is seen
    // for it — same idempotent ON CONFLICT DO NOTHING as before, now keyed
    // one level finer so a rep's own frozen share never gets overwritten
    // by a later, changed balance either.
    await pool.query(`
      INSERT INTO old_debt_snapshots
        (customer_id, sales_rep_name, period_from, period_to, snapshot_balance, invoice_count, unpaid_count)
      SELECT t.customer_id, t.sales_rep_name, $2::date, $3::date, t.balance, t.invoice_count, t.unpaid_count
      FROM UNNEST($1::text[], $4::text[], $5::numeric[], $6::int[], $7::int[])
        AS t(customer_id, sales_rep_name, balance, invoice_count, unpaid_count)
      ON CONFLICT (customer_id, sales_rep_name, period_from, period_to) DO NOTHING
    `, [
      repRows.map(c => c.customer_id),
      date_from,
      date_to,
      repRows.map(c => c.sales_rep_name),
      repRows.map(c => c.current_balance),
      repRows.map(c => c.invoice_count),
      repRows.map(c => c.unpaid_count),
    ]);

    const { rows: snaps } = await pool.query(`
      SELECT customer_id, sales_rep_name, snapshot_balance, invoice_count, unpaid_count, taken_at
      FROM old_debt_snapshots
      WHERE customer_id = ANY($1::text[]) AND period_from = $2 AND period_to = $3
        AND sales_rep_name != ''
    `, [repRows.map(c => c.customer_id), date_from, date_to]);
    const snapMap = {};
    snaps.forEach(s => { snapMap[`${s.customer_id}|${s.sales_rep_name}`] = s; });

    const repRowsResolved = repRows.map(c => {
      const snap = snapMap[`${c.customer_id}|${c.sales_rep_name}`];
      return {
        ...c,
        total_debt:        snap ? Number(snap.snapshot_balance) : Number(c.current_balance),
        invoice_count:     snap ? snap.invoice_count : c.invoice_count,
        unpaid_count:      snap ? snap.unpaid_count  : c.unpaid_count,
        snapshot_taken_at: snap ? snap.taken_at : null,
      };
    });

    // Roll the per-rep rows back up into one row per customer — the totals
    // are a plain sum of the breakdown, so "دين الفواتير" at the top and
    // the sum of the expanded rep rows are always the same number. The
    // headline "sales_rep_name" shown collapsed is whichever rep holds the
    // largest share of the FROZEN debt, purely for the one-line view; the
    // full split travels in rep_breakdown for the UI to expand.
    const byCustomer = new Map();
    repRowsResolved.forEach(r => {
      if (!byCustomer.has(r.customer_id)) {
        byCustomer.set(r.customer_id, {
          customer_id: r.customer_id, customer_name: r.customer_name,
          region_id: r.region_id, region_name: r.region_name,
          current_balance: 0, total_debt: 0, invoice_count: 0, unpaid_count: 0,
          snapshot_taken_at: r.snapshot_taken_at, rep_breakdown: [],
        });
      }
      const g = byCustomer.get(r.customer_id);
      g.current_balance += Number(r.current_balance);
      g.total_debt      += Number(r.total_debt);
      g.invoice_count   += r.invoice_count;
      g.unpaid_count    += r.unpaid_count;
      if (r.snapshot_taken_at && (!g.snapshot_taken_at || r.snapshot_taken_at < g.snapshot_taken_at)) {
        g.snapshot_taken_at = r.snapshot_taken_at; // earliest freeze across the group
      }
      g.rep_breakdown.push({
        sales_rep_name: r.sales_rep_name,
        current_balance: Number(r.current_balance),
        total_debt: Number(r.total_debt),
        invoice_count: r.invoice_count,
        unpaid_count: r.unpaid_count,
      });
    });

    const customers = [...byCustomer.values()].map(g => {
      g.rep_breakdown.sort((a, b) => b.total_debt - a.total_debt);
      return {
        ...g,
        current_balance: +g.current_balance.toFixed(2),
        total_debt: +g.total_debt.toFixed(2),
        historical_rep_count: g.rep_breakdown.length,
        sales_rep_name: g.rep_breakdown[0]?.sales_rep_name || null,
      };
    }).sort((a, b) => b.current_balance - a.current_balance);

    const customerIds = customers.map(c => c.customer_id);
    let payments = [];
    if (customerIds.length) {
      // Only pass the one parameter this query actually references —
      // Postgres requires every bound $n to appear in the query text to
      // infer its type, so reusing the larger `params` array (which also
      // carries unused region/rep/date_to values) throws "could not
      // determine data type of parameter $2".
      const { rows } = await pool.query(`
        SELECT
          pay.customer_code                       AS customer_id,
          pay.tran_date::text                      AS pay_date,
          ROUND(SUM(pay.total_paid)::numeric, 2)   AS amount
        FROM payments pay
        WHERE pay.customer_code = ANY($1::text[])
          AND pay.tran_date >= date_trunc('month', CURRENT_DATE)::date
          AND pay.tran_date <= CURRENT_DATE
        GROUP BY pay.customer_code, pay.tran_date
        HAVING SUM(pay.total_paid) <> 0
        ORDER BY pay.tran_date ASC
      `, [customerIds]);
      payments = rows;
    }

    res.json({ customers, payments, date_from, date_to });
  } catch (err) {
    console.error('[Aging/collections]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   POST /api/aging/collections/reset-snapshot
   Re-opens the "دين الفواتير (لقطة ثابتة)" baseline for one [date_from,
   date_to] period: deletes its rows from old_debt_snapshots so the next
   GET /collections call re-freezes every customer at TODAY's live
   invoices.balance instead of whatever value was locked in the first
   time this period was ever viewed.

   Scoped to the period only, not to region/sales_rep — those two only
   filter which customers are DISPLAYED, but the snapshot itself is keyed
   on (customer_id, period_from, period_to) with no region/rep dimension.
   Resetting just the on-screen subset would leave the period's snapshot
   half-fresh, half-stale; every customer in the period is reset together
   so "متى أُخذت اللقطة" stays one answer, not one per region. ═══════════════════════════════════════════════════════════════ */
router.post('/collections/reset-snapshot', verifyToken, requirePagePermission('aging', 2), async (req, res) => {
  try {
    const { date_from, date_to } = req.body || {};
    if (!date_from || !date_to) {
      return res.status(400).json({ error: 'date_from و date_to مطلوبان' });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM old_debt_snapshots WHERE period_from = $1 AND period_to = $2`,
      [date_from, date_to]
    );
    res.json({ success: true, deleted: rowCount, date_from, date_to });
  } catch (err) {
    console.error('[Aging/reset-snapshot]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/aging/collections/payments/:customerId?date=YYYY-MM-DD
   Payment-document detail behind one daily cell of the collection
   tracker: every payment row for that customer on that day, with the
   invoice_number it was recorded against (when present — the Excel
   source sometimes leaves it blank) and the cash/cheque/bank/POS
   split. Date omitted → all payments for the current month.
═══════════════════════════════════════════════════════════════ */
router.get('/collections/payments/:customerId', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { date } = req.query;

    if (req.regionFilter && req.regionFilter.length) {
      const own = await pool.query(
        `SELECT 1 FROM invoices WHERE customer_id = $1 AND region_id = ANY($2::int[]) LIMIT 1`,
        [customerId, req.regionFilter]
      );
      if (!own.rowCount) return res.status(403).json({ error: 'غير مصرح' });
    }

    const params = [customerId];
    let dateCond = `AND p.tran_date >= date_trunc('month', CURRENT_DATE)::date AND p.tran_date <= CURRENT_DATE`;
    if (date) {
      params.push(date);
      dateCond = `AND p.tran_date = $2`;
    }

    // Reference resolution, in order of trust:
    //   1. invoices table (live dues file)         → real invoice, full data
    //   2. sales_activity (sales transaction log)  → real invoice that was
    //      settled and dropped out of the dues file → "فاتورة مغلقة",
    //      date/amount reconstructed best-effort from the sales lines
    //   3. neither → not a sales invoice at all (e.g. NetSuite settlement
    //      or advance-payment document) → "مرجع غير مطابق لفاتورة"
    const { rows } = await pool.query(`
      SELECT
        p.document_number,
        p.invoice_number,
        p.tran_date::text AS tran_date,
        p.cash, p.cheque, p.bank_tran, p.pos,
        p.total_paid,
        i.invoice_date::text  AS invoice_date,
        i.original_amount     AS invoice_amount,
        i.balance             AS invoice_balance,
        i.status              AS invoice_status,
        (i.invoice_number IS NULL AND sa.sa_date IS NOT NULL) AS closed_invoice,
        sa.sa_date::text      AS closed_invoice_date,
        sa.sa_amount          AS closed_invoice_amount
      FROM payments p
      LEFT JOIN invoices i ON i.invoice_number = TRIM(p.invoice_number)
      LEFT JOIN LATERAL (
        SELECT
          MIN(make_date(s.report_year, s.month_num,
                        LEAST(GREATEST(COALESCE(s.day, 1), 1), 28))) AS sa_date,
          NULLIF(SUM(s.net_revenue), 0) AS sa_amount
        FROM sales_activity s
        WHERE i.invoice_number IS NULL
          AND s.invoice_number = TRIM(p.invoice_number)
      ) sa ON TRUE
      WHERE p.customer_code = $1
        ${dateCond}
        AND p.total_paid <> 0
      ORDER BY p.tran_date ASC, p.document_number ASC
    `, params);

    // ── Resolve the TRUE invoice applications from NetSuite ──
    // The Excel's "Invoice Number" column is unreliable (often carries a
    // Mirna settlement-document reference, e.g. the 11076xxxxx series,
    // that matches no invoice). NetSuite stores each Mirna document
    // number in the transaction's externalid, and its payment-
    // application links record exactly which invoice(s) each payment
    // settled and for how much. Best-effort: if NetSuite is not
    // configured or unreachable, payments are returned without
    // applications and the frontend falls back to the Excel reference.
    try {
      const docNumbers = rows.map(r => String(r.document_number).trim()).filter(Boolean);
      if (docNumbers.length) {
        const cfgRes = await pool.query("SELECT value FROM app_settings WHERE key = 'netsuite_config'");
        const cfg = cfgRes.rows[0]?.value;
        if (cfg && cfg.account_id && cfg.consumer_key) {
          const nsConfig = {
            accountId: cfg.account_id, consumerKey: cfg.consumer_key,
            consumerSecret: cfg.consumer_secret, tokenKey: cfg.token_key, tokenSecret: cfg.token_secret,
          };
          const inList = docNumbers.map(d => `'${d.replace(/'/g, "''")}'`).join(',');
          const ns = await suiteQL(nsConfig, `
            SELECT pay.externalid AS pay_ext, inv.externalid AS inv_ext,
                   inv.trandate AS inv_date, inv.foreigntotal AS inv_total,
                   ptll.foreignamount AS applied_amount
            FROM PreviousTransactionLineLink ptll
            JOIN transaction inv ON inv.id = ptll.previousdoc
            JOIN transaction pay ON pay.id = ptll.nextdoc
            WHERE pay.externalid IN (${inList}) AND inv.type = 'CustInvc'
          `);
          const appsByDoc = {};
          const invNumbers = new Set();
          (ns.items || []).forEach(a => {
            const key = String(a.pay_ext).trim();
            if (!appsByDoc[key]) appsByDoc[key] = [];
            appsByDoc[key].push({
              invoice_number: a.inv_ext,
              invoice_date:   a.inv_date,
              invoice_total:  Math.abs(Number(a.inv_total) || 0),
              applied_amount: Math.abs(Number(a.applied_amount) || 0),
            });
            if (a.inv_ext) invNumbers.add(String(a.inv_ext).trim());
          });

          // Attach the local (dashboard) current balance for each applied invoice
          if (invNumbers.size) {
            const { rows: localInv } = await pool.query(
              `SELECT invoice_number, balance FROM invoices WHERE invoice_number = ANY($1::text[])`,
              [[...invNumbers]]
            );
            const balByInv = {};
            localInv.forEach(li => { balByInv[li.invoice_number] = Number(li.balance); });
            Object.values(appsByDoc).forEach(apps => apps.forEach(a => {
              a.invoice_balance = balByInv[String(a.invoice_number).trim()] ?? null;
            }));
          }

          rows.forEach(r => {
            r.applications = appsByDoc[String(r.document_number).trim()] || null;
          });
        }
      }
    } catch (nsErr) {
      console.error('[Aging/collections/payments] NetSuite lookup failed (non-fatal):', nsErr.message);
    }

    res.json({ payments: rows });
  } catch (err) {
    console.error('[Aging/collections/payments]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/aging/invoices/:customerId
   Invoice-level breakdown for one customer
═══════════════════════════════════════════════════════════════ */
router.get('/invoices/:customerId', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const { customerId } = req.params;

    if (req.regionFilter && req.regionFilter.length) {
      const own = await pool.query(
        `SELECT 1 FROM invoices WHERE customer_id = $1 AND region_id = ANY($2::int[]) LIMIT 1`,
        [customerId, req.regionFilter]
      );
      if (!own.rowCount) return res.status(403).json({ error: 'غير مصرح' });
    }

    const { rows } = await pool.query(`
      SELECT
        invoice_number,
        invoice_date::text AS invoice_date,
        original_amount,
        paid_amount,
        balance,
        status,
        COALESCE((CURRENT_DATE - invoice_date)::int, 0)                          AS age_days,
        ROUND((paid_amount / NULLIF(original_amount,0) * 100)::numeric, 1)        AS paid_pct,
        ROUND((balance     / NULLIF(original_amount,0) * 100)::numeric, 1)        AS remaining_pct
      FROM invoices
      WHERE customer_id = $1
        AND status IN ('unpaid','partial')
        AND balance > 0
      ORDER BY invoice_date ASC NULLS LAST
    `, [customerId]);
    res.json({ invoices: rows });
  } catch (err) {
    console.error('[Aging/invoices]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
