/**
 * summary.js — GET /api/summary
 * Comprehensive general-summary endpoint.
 *
 * Query params:
 *   year, month       – default: current month
 *   branch_name       – English branch name (optional)
 *   salesrep_name     – filter to single rep (optional)
 *   region_id         – filter invoices by region (optional)
 */

const express = require('express');
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

const router = express.Router();

/* ── Shared helpers (same pattern as salesActivity.js) ──────── */
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

/**
 * Returns { sql, val } for a branch_name WHERE clause.
 * p = the next $N placeholder index.
 */
function mkBranch(branch, p, tableAlias) {
  if (!branch) return { sql: '', val: null, p };
  const col = tableAlias ? `${tableAlias}.branch_name` : 'branch_name';
  if (Array.isArray(branch)) {
    return { sql: ` AND ${col} = ANY($${p}::text[])`, val: branch, p: p + 1 };
  }
  return { sql: ` AND ${col} = $${p}`, val: branch, p: p + 1 };
}

/* ── Working-days calculator (skip Friday + named holidays) ──── */
const HOLIDAYS = [
  { year: 2026, month: 5, days: [27, 28, 29] }, // عيد الأضحى 1447هـ
];
function isHoliday(y, m, d) {
  return HOLIDAYS.some(h => h.year === y && h.month === m && h.days.includes(d));
}
function workingDays(year, month) {
  const today     = new Date();
  const isCur     = today.getFullYear() === year && today.getMonth() + 1 === month;
  const lastDay   = isCur ? today.getDate() : new Date(year, month, 0).getDate();
  let n = 0;
  for (let d = 1; d <= lastDay; d++) {
    if (new Date(year, month - 1, d).getDay() !== 5 && !isHoliday(year, month, d)) n++;
  }
  return Math.max(n, 1);
}

/* ─────────────────────────────────────────────────────────────
   GET /api/summary
───────────────────────────────────────────────────────────── */
router.get('/', verifyToken, applyRegionFilter, async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
  const rep   = (req.query.salesrep_name || '').trim() || null;

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;

  const wdCur  = workingDays(year, month);
  const wdPrev = workingDays(prevYear, prevMonth);

  try {
    /* Resolve branch from RBAC (region_manager) or explicit param */
    let branch = req.query.branch_name || null;
    if (req.regionFilter) branch = await resolveRegionBranch(req.regionFilter);

    /* Region ID for invoices/payments */
    let regionId = null;
    if (req.regionFilter)         regionId = req.regionFilter;
    else if (req.query.region_id) regionId = parseInt(req.query.region_id, 10);

    /* ── Helper: run a sales_activity aggregate ─────────────
       Definitions aligned with SalesActivityPage /kpi endpoint:
       - active_customers   = COUNT(DISTINCT customer_code) — any invoice this month
       - inactive_customers = customers whose net SUM(qty) <= 0 this month (غير متعاملة)
       - total_qty / total_returns = plain sums                               */
    async function salesAgg(y, m) {
      const params = [y, m];
      const b   = mkBranch(branch, 3, 'sa');   // for CTE (alias sa)
      const b2  = mkBranch(branch, 3, 'sa2');  // for subqueries (alias sa2) — same $N
      if (b.val !== null) params.push(b.val);
      const repIdx = params.length + 1;
      if (rep) params.push(rep);
      const repSql  = rep ? ` AND sa.salesrep_name  = $${repIdx}` : '';
      const repSql2 = rep ? ` AND sa2.salesrep_name = $${repIdx}` : '';

      const r = await pool.query(`
        WITH cust AS (
          SELECT
            sa.customer_code,
            SUM(sa.qty) AS net_qty
          FROM sales_activity sa
          WHERE sa.report_year=$1 AND sa.month_num=$2
            ${b.sql}${repSql}
          GROUP BY sa.customer_code
        )
        SELECT
          COUNT(*)::int                                        AS active_customers,
          COUNT(CASE WHEN net_qty <= 0 THEN 1 END)::int       AS inactive_customers,
          (SELECT COALESCE(SUM(sa2.qty),0)::bigint
           FROM sales_activity sa2
           WHERE sa2.report_year=$1 AND sa2.month_num=$2
             ${b2.sql}${repSql2})                             AS total_qty,
          (SELECT COALESCE(SUM(sa2.bad_return_qty),0)::bigint
           FROM sales_activity sa2
           WHERE sa2.report_year=$1 AND sa2.month_num=$2
             ${b2.sql}${repSql2})                             AS total_returns
        FROM cust
      `, params);
      return r.rows[0] ?? { active_customers:0, inactive_customers:0, total_qty:0, total_returns:0 };
    }

    /* ── Helper: distinct customer codes present in a month ──
       No qty filter — matches SalesActivityPage definition:
       any invoice appearance = active / stopped / new        */
    async function activeCodes(y, m) {
      const params = [y, m];
      const b = mkBranch(branch, 3, null);
      if (b.val !== null) params.push(b.val);
      if (rep) params.push(rep);
      const repSql = rep ? ` AND salesrep_name = $${params.length}` : '';

      const r = await pool.query(`
        SELECT DISTINCT customer_code
        FROM sales_activity
        WHERE report_year=$1 AND month_num=$2
          ${b.sql}${repSql}
      `, params);
      return new Set(r.rows.map(x => x.customer_code));
    }

    /* ── Helper: new customers count ─────────────────────────
       In current month but NOT in any earlier month this year.
       Mirrors SalesActivityPage /kpi newCurrentMonth logic.   */
    async function newCustomersCount(y, m) {
      const params = [y, m];
      const b = mkBranch(branch, 3, null);
      if (b.val !== null) params.push(b.val);
      if (rep) params.push(rep);
      const repSql = rep ? ` AND salesrep_name = $${params.length}` : '';

      const r = await pool.query(`
        SELECT COUNT(DISTINCT customer_code)::int AS cnt
        FROM sales_activity
        WHERE report_year=$1 AND month_num=$2
          ${b.sql}${repSql}
          AND customer_code NOT IN (
            SELECT DISTINCT customer_code
            FROM sales_activity
            WHERE report_year=$1 AND month_num < $2
          )
      `, params);
      return Number(r.rows[0]?.cnt || 0);
    }

    /* ── Helper: per-branch breakdown ──────────────────────── */
    async function regionBreakdown(y, m) {
      const params = [y, m];
      const b = mkBranch(branch, 3, 'sa');
      if (b.val !== null) params.push(b.val);
      if (rep) params.push(rep);
      const repSql = rep ? ` AND sa.salesrep_name = $${params.length}` : '';

      const r = await pool.query(`
        SELECT
          COALESCE(TRIM(sa.branch_name), 'غير محدد') AS branch_name,
          COUNT(DISTINCT sa.customer_code)::int       AS active_customers,
          COALESCE(SUM(sa.qty), 0)::bigint            AS total_qty,
          COALESCE(SUM(sa.bad_return_qty), 0)::bigint AS total_returns
        FROM sales_activity sa
        WHERE sa.report_year=$1 AND sa.month_num=$2
          ${b.sql}${repSql}
        GROUP BY COALESCE(TRIM(sa.branch_name), 'غير محدد')
        ORDER BY total_qty DESC
      `, params);
      return r.rows;
    }

    /* ── Helper: per-rep breakdown ─────────────────────────── */
    async function repBreakdown(y, m) {
      const params = [y, m];
      const b = mkBranch(branch, 3, 'sa');
      if (b.val !== null) params.push(b.val);
      if (rep) params.push(rep);
      const repSql = rep ? ` AND sa.salesrep_name = $${params.length}` : '';

      const r = await pool.query(`
        SELECT
          TRIM(sa.salesrep_name)                      AS salesrep_name,
          COALESCE(TRIM(sa.branch_name), 'غير محدد')  AS branch_name,
          COUNT(DISTINCT sa.customer_code)::int        AS active_customers,
          COALESCE(SUM(sa.qty), 0)::bigint             AS total_qty,
          COALESCE(SUM(sa.bad_return_qty), 0)::bigint  AS total_returns
        FROM sales_activity sa
        WHERE sa.report_year=$1 AND sa.month_num=$2
          AND sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) != ''
          ${b.sql}${repSql}
        GROUP BY TRIM(sa.salesrep_name), COALESCE(TRIM(sa.branch_name), 'غير محدد')
        ORDER BY total_qty DESC
      `, params);
      return r.rows;
    }

    /* ── Helper: collections total (region/rep-aware) ─────── */
    async function collectionsTotal(y, m) {
      const params = [y, m];

      /* No filter → simple aggregation (fast path) */
      if (!regionId && !branch && !rep) {
        const r = await pool.query(`
          SELECT
            COALESCE(SUM(total_paid), 0)::numeric AS total_paid,
            COUNT(*)::int                         AS tx_count
          FROM payments
          WHERE EXTRACT(YEAR  FROM tran_date) = $1
            AND EXTRACT(MONTH FROM tran_date) = $2
        `, params);
        return r.rows[0];
      }

      /* Build customer_code sub-query from invoices
         Using IN (subquery) avoids duplicate rows that JOIN on invoice_number
         would cause, and works even when payment.invoice_number is NULL.     */
      const subClauses = [];
      let   subJoin    = '';

      if (regionId) {
        params.push(regionId);
        subClauses.push(`i.region_id = $${params.length}`);
      } else if (branch) {
        subJoin = `JOIN regions r ON r.id = i.region_id`;
        if (Array.isArray(branch)) {
          params.push(branch);
          subClauses.push(
            `(r.name_en = ANY($${params.length}::text[]) OR r.name_ar = ANY($${params.length}::text[]))`
          );
        } else {
          params.push(branch);
          subClauses.push(
            `(r.name_en = $${params.length} OR r.name_ar = $${params.length})`
          );
        }
      }

      if (rep) {
        params.push(rep);
        subClauses.push(`i.sales_rep_name = $${params.length}`);
      }

      const subWhere = subClauses.length ? `WHERE ${subClauses.join(' AND ')}` : '';

      const r = await pool.query(`
        SELECT
          COALESCE(SUM(p.total_paid), 0)::numeric AS total_paid,
          COUNT(*)::int                           AS tx_count
        FROM payments p
        WHERE EXTRACT(YEAR  FROM p.tran_date) = $1
          AND EXTRACT(MONTH FROM p.tran_date) = $2
          AND p.customer_code IN (
            SELECT DISTINCT i.customer_id
            FROM   invoices i
            ${subJoin}
            ${subWhere}
          )
      `, params);
      return r.rows[0];
    }

    /* ── Helper: debt from invoices ────────────────────────── */
    async function debtData() {
      const clauses = [];
      const params  = [];
      let p = 1;

      if (regionId) {
        clauses.push(`i.region_id = $${p++}`);
        params.push(regionId);
      } else if (branch) {
        /* Filter by branch name via regions sub-query — works for both
           string ('Madinah') and array (['Madinah','المدينة']) values. */
        if (Array.isArray(branch)) {
          clauses.push(
            `i.region_id IN (SELECT id FROM regions WHERE name_en = ANY($${p}::text[]) OR name_ar = ANY($${p}::text[]))`
          );
        } else {
          clauses.push(
            `i.region_id IN (SELECT id FROM regions WHERE name_en = $${p} OR name_ar = $${p})`
          );
        }
        params.push(branch);
        p++;
      }

      if (rep) { clauses.push(`i.sales_rep_name=$${p++}`); params.push(rep); }

      // Always exclude "direct" sales rep — they are not real reps and
      // their balance must not inflate any region's (e.g. Shaqra) total.
      const directExclude = `LOWER(TRIM(COALESCE(i.sales_rep_name, ''))) != 'direct'`;
      const where = clauses.length
        ? 'WHERE ' + clauses.join(' AND ') + ` AND ${directExclude}`
        : `WHERE ${directExclude}`;

      const [byReg, byRep, tot] = await Promise.all([
        pool.query(`
          SELECT
            i.region_id,
            COALESCE(r.name_ar, r.name_en, 'غير محدد') AS region_name,
            COALESCE(SUM(i.balance), 0)::numeric        AS total_balance,
            COALESCE(SUM(i.original_amount), 0)::numeric AS total_invoiced,
            COALESCE(SUM(i.paid_amount), 0)::numeric     AS total_paid_inv
          FROM invoices i
          LEFT JOIN regions r ON r.id=i.region_id
          ${where}
          GROUP BY i.region_id, COALESCE(r.name_ar, r.name_en, 'غير محدد')
          ORDER BY total_balance DESC
        `, params),

        pool.query(`
          SELECT
            COALESCE(TRIM(i.sales_rep_name), 'غير محدد') AS salesrep_name,
            COALESCE(SUM(i.balance), 0)::numeric          AS total_balance,
            COALESCE(SUM(i.original_amount), 0)::numeric  AS total_invoiced
          FROM invoices i
          ${where}
          GROUP BY COALESCE(TRIM(i.sales_rep_name), 'غير محدد')
          ORDER BY total_balance DESC
          LIMIT 60
        `, params),

        pool.query(`
          SELECT COALESCE(SUM(i.balance), 0)::numeric AS grand
          FROM invoices i ${where}
        `, params),
      ]);

      const grand = Number(tot.rows[0]?.grand || 0);
      return { grand, byReg: byReg.rows, byRep: byRep.rows };
    }

    /* ── Run all in parallel ───────────────────────────────── */
    const [
      sCur, sPrev,
      codesCur, codesPrev,
      regCur, regPrev,
      repCur, repPrev,
      colCur, colPrev,
      debt,
      newCustCount,
    ] = await Promise.all([
      salesAgg(year, month),
      salesAgg(prevYear, prevMonth),
      activeCodes(year, month),
      activeCodes(prevYear, prevMonth),
      regionBreakdown(year, month),
      regionBreakdown(prevYear, prevMonth),
      repBreakdown(year, month),
      repBreakdown(prevYear, prevMonth),
      collectionsTotal(year, month),
      collectionsTotal(prevYear, prevMonth),
      debtData(),
      newCustomersCount(year, month),
    ]);

    /* ── Stopped customers: appeared last month, gone this month
       Mirrors SalesActivityPage: no qty filter on either side   */
    const stoppedCount = [...codesPrev].filter(c => !codesCur.has(c)).length;

    /* ── Merge prev_qty into region rows ───────────────────── */
    const prevRegMap = Object.fromEntries(regPrev.map(r => [r.branch_name, Number(r.total_qty)]));
    const regions = regCur.map(r => ({
      branch_name:      r.branch_name,
      total_qty:        Number(r.total_qty),
      total_returns:    Number(r.total_returns),
      active_customers: Number(r.active_customers),
      prev_qty:         prevRegMap[r.branch_name] || 0,
    }));

    /* ── Merge prev_qty into rep rows ──────────────────────── */
    const prevRepMap = Object.fromEntries(repPrev.map(r => [r.salesrep_name, Number(r.total_qty)]));
    const reps = repCur.map(r => ({
      salesrep_name:    r.salesrep_name,
      branch_name:      r.branch_name,
      total_qty:        Number(r.total_qty),
      total_returns:    Number(r.total_returns),
      active_customers: Number(r.active_customers),
      prev_qty:         prevRepMap[r.salesrep_name] || 0,
    }));

    /* ── Totals ────────────────────────────────────────────── */
    const tQtyCur  = Number(sCur.total_qty);
    const tQtyPrev = Number(sPrev.total_qty);
    const tRetCur  = Number(sCur.total_returns);
    const tRetPrev = Number(sPrev.total_returns);
    const tColCur  = Number(colCur.total_paid);
    const tColPrev = Number(colPrev.total_paid);

    res.json({
      meta: { year, month, prev_year: prevYear, prev_month: prevMonth, working_days_cur: wdCur, working_days_prev: wdPrev },

      sales: {
        cur: {
          total_qty:          tQtyCur,
          total_returns:      tRetCur,
          returns_pct:        tQtyCur > 0 ? +(tRetCur / tQtyCur * 100).toFixed(1) : 0,
          active_customers:   Number(sCur.active_customers),
          inactive_customers: Number(sCur.inactive_customers),
          daily_avg:          +(tQtyCur / wdCur).toFixed(1),
        },
        prev: {
          total_qty:        tQtyPrev,
          total_returns:    tRetPrev,
          returns_pct:      tQtyPrev > 0 ? +(tRetPrev / tQtyPrev * 100).toFixed(1) : 0,
          active_customers: Number(sPrev.active_customers),
          daily_avg:        +(tQtyPrev / wdPrev).toFixed(1),
        },
        deviation_pct: tQtyPrev > 0 ? +((tQtyCur - tQtyPrev) / tQtyPrev * 100).toFixed(1) : null,
      },

      stopped_customers: stoppedCount,
      new_customers: newCustCount,

      collections: {
        total_paid:      tColCur,
        daily_avg:       +(tColCur / wdCur).toFixed(2),
        tx_count:        Number(colCur.tx_count),
        prev_total_paid: tColPrev,
        deviation_pct:   tColPrev > 0 ? +((tColCur - tColPrev) / tColPrev * 100).toFixed(1) : null,
      },

      regions,
      reps,

      debt: {
        grand_balance: debt.grand,
        by_region: debt.byReg.map(r => ({
          region_id:      r.region_id,
          region_name:    r.region_name,
          total_balance:  Number(r.total_balance),
          total_invoiced: Number(r.total_invoiced),
          pct_of_total:   debt.grand > 0 ? +(Number(r.total_balance) / debt.grand * 100).toFixed(1) : 0,
        })),
        by_rep: debt.byRep.map(r => ({
          salesrep_name:  r.salesrep_name,
          total_balance:  Number(r.total_balance),
          total_invoiced: Number(r.total_invoiced),
          pct_of_total:   debt.grand > 0 ? +(Number(r.total_balance) / debt.grand * 100).toFixed(1) : 0,
        })),
      },
    });

  } catch (err) {
    console.error('[Summary]', err);
    res.status(500).json({ error: 'خطأ في جلب بيانات الملخص' });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/summary/filters  — dropdown data
───────────────────────────────────────────────────────────── */
router.get('/filters', verifyToken, applyRegionFilter, async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    let branch = null;
    if (req.regionFilter) branch = await resolveRegionBranch(req.regionFilter);

    const params = [year];
    const b = mkBranch(branch, 2, null);
    if (b.val !== null) params.push(b.val);

    const [saRes, regRes] = await Promise.all([
      pool.query(`
        SELECT DISTINCT
          COALESCE(TRIM(branch_name), '')   AS branch_name,
          COALESCE(TRIM(salesrep_name), '') AS salesrep_name
        FROM sales_activity
        WHERE report_year=$1
          AND salesrep_name IS NOT NULL AND TRIM(salesrep_name)!=''
          ${b.sql}
        ORDER BY branch_name, salesrep_name
      `, params),
      pool.query('SELECT id, COALESCE(name_ar, name_en) AS name FROM regions ORDER BY name'),
    ]);

    const branches = [...new Set(saRes.rows.map(r => r.branch_name).filter(Boolean))].sort();
    const reps     = saRes.rows.filter(r => r.salesrep_name).map(r => ({
      name: r.salesrep_name,
      branch: r.branch_name || '',
    }));

    res.json({ branches, reps, regions: regRes.rows });
  } catch (err) {
    console.error('[Summary] filters:', err);
    res.status(500).json({ error: 'خطأ في جلب قوائم الفلترة' });
  }
});

module.exports = router;
