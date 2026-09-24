/**
 * routes/commissions.js — أداء المناديب → تبويب "حساب العمولات" (admin only)
 *
 * GET  /api/commissions/weights          — current item weights
 * PUT  /api/commissions/weights          — update weights (admin)
 * GET  /api/commissions/limits           — every rep/manager's registered commission ceiling
 * PUT  /api/commissions/limits           — bulk upsert ceilings (admin)
 * GET  /api/commissions/report           — full computed commission report for a month
 *
 * Whole router is admin-only — this tab isn't meant for other roles.
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { verifyToken, requirePagePermission } = require('../middleware/auth');
const {
  DAMAGE_TARGET_PCT, ITEM_KEYS, ITEM_LABELS_AR, computeCommissionPct, computeCategoryPenalty, debtExcessInfo,
} = require('../utils/commission');
const { getRepBalances } = require('../utils/debtSnapshot');

const FRIDGE_DAILY_TARGET = 40;

// View endpoints require level ≥1 on the "commissions" page permission,
// write endpoints require level ≥2 — matches the frontend's own
// canViewCommissions / canEditCommissions gating in PerformanceDashboardPage.
router.use(verifyToken);
const canView = requirePagePermission('commissions', 1);
const canEdit = requirePagePermission('commissions', 2);

/* ── Working-days calculator — copy of performanceDashboard.js's, kept
   in sync there (see that file's comment for the full rationale). ── */
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

const MANAGER_ROLE_FIELD = {
  supervisor:      'supervisor_id',
  region_manager:  'region_manager_id',
  sector_manager:  'sector_manager_id',
  sales_manager:   'sales_manager_id',
};

/* ═══════════════════════════════════════════════════════════════
   WEIGHTS
═══════════════════════════════════════════════════════════════ */
router.get('/weights', canView, async (req, res) => {
  try {
    const r = await pool.query(`SELECT item_key, weight_pct FROM commission_weights ORDER BY item_key`);
    const map = {};
    r.rows.forEach(row => { map[row.item_key] = parseFloat(row.weight_pct); });
    ITEM_KEYS.forEach(k => { if (!(k in map)) map[k] = 0; });
    res.json({ weights: map, labels: ITEM_LABELS_AR, damage_target_pct: DAMAGE_TARGET_PCT });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/weights', canEdit, async (req, res) => {
  const { weights } = req.body; // { qty, customers, debt, damage, fridges }
  if (!weights || typeof weights !== 'object') return res.status(400).json({ error: 'weights مطلوبة' });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const key of ITEM_KEYS) {
        const pct = Number(weights[key] || 0);
        await client.query(`
          INSERT INTO commission_weights (item_key, weight_pct, updated_by, updated_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (item_key) DO UPDATE SET weight_pct = EXCLUDED.weight_pct, updated_by = EXCLUDED.updated_by, updated_at = NOW()
        `, [key, pct, req.user.id]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   LIMITS (commission ceilings)
═══════════════════════════════════════════════════════════════ */
router.get('/limits', canView, async (req, res) => {
  try {
    const r = await pool.query(`SELECT person_type, person_id, commission_limit FROM commission_limits`);
    const map = {}; // { "rep-12": 5000, "manager-3": 8000 }
    r.rows.forEach(row => { map[`${row.person_type}-${row.person_id}`] = parseFloat(row.commission_limit); });
    res.json({ limits: map });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/limits', canEdit, async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [req.body]; // [{person_type, person_id, commission_limit}]
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        const { person_type, person_id, commission_limit } = row;
        if (!['rep', 'manager'].includes(person_type) || !person_id) continue;
        await client.query(`
          INSERT INTO commission_limits (person_type, person_id, commission_limit, updated_by, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (person_type, person_id) DO UPDATE
            SET commission_limit = EXCLUDED.commission_limit, updated_by = EXCLUDED.updated_by, updated_at = NOW()
        `, [person_type, Number(person_id), Number(commission_limit || 0), req.user.id]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    res.json({ success: true, saved: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   REPORT — full computed commission per rep + per manager (rollups)
═══════════════════════════════════════════════════════════════ */
router.get('/report', canView, async (req, res) => {
  try {
    const now   = new Date();
    const year  = Number(req.query.year  || now.getFullYear());
    const month = Number(req.query.month || (now.getMonth() + 1));

    /* ── Weights + limits ────────────────────────────────────── */
    const [weightsRes, limitsRes] = await Promise.all([
      pool.query(`SELECT item_key, weight_pct FROM commission_weights`),
      pool.query(`SELECT person_type, person_id, commission_limit FROM commission_limits`),
    ]);
    const weights = {};
    weightsRes.rows.forEach(r => { weights[r.item_key] = parseFloat(r.weight_pct || 0); });
    ITEM_KEYS.forEach(k => { if (!(k in weights)) weights[k] = 0; });
    const limitsMap = {};
    limitsRes.rows.forEach(r => { limitsMap[`${r.person_type}-${r.person_id}`] = parseFloat(r.commission_limit || 0); });

    /* ── Reps with hierarchy ─────────────────────────────────── */
    const repsRes = await pool.query(`
      SELECT sr.id, sr.name_ar, sr.netsuite_name, sr.region_id, sr.route_id,
             sr.supervisor_id, sr.region_manager_id, sr.sector_manager_id, sr.sales_manager_id,
             reg.name_ar AS region_name
      FROM sales_reps sr
      LEFT JOIN regions reg ON reg.id = sr.region_id
      WHERE sr.is_active
      ORDER BY reg.name_ar, sr.name_ar
    `);
    const reps = repsRes.rows;
    if (!reps.length) {
      return res.json({ year, month, weights, reps: [], managers: { supervisor: [], region_manager: [], sector_manager: [], sales_manager: [] } });
    }
    const nsNames = reps.map(r => r.netsuite_name).filter(Boolean);
    const repIds  = reps.map(r => r.id);

    /* ── Sales activity this month (qty, damage, customers) ──── */
    const saRes = await pool.query(`
      SELECT salesrep_name,
             SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END) AS qty_positive,
             SUM(qty) AS qty_net,
             SUM(COALESCE(bad_return_qty,0)) AS damage_qty,
             COUNT(DISTINCT CASE WHEN qty > 0 THEN customer_code END) AS active_customers
      FROM sales_activity
      WHERE report_year = $1 AND month_num = $2 AND salesrep_name = ANY($3::text[])
      GROUP BY salesrep_name
    `, [year, month, nsNames]);
    const saByName = {};
    saRes.rows.forEach(r => { saByName[r.salesrep_name] = r; });

    /* ── Targets ──────────────────────────────────────────────── */
    const targetsRes = await pool.query(`
      SELECT rep_id, qty_target, customer_target, credit_limit
      FROM sales_rep_targets WHERE rep_id = ANY($1::int[]) AND year=$2 AND month=$3
    `, [repIds, year, month]);
    const targetById = {};
    targetsRes.rows.forEach(r => { targetById[r.rep_id] = r; });

    /* ── Outstanding balance — frozen once the month is closed, see
       utils/debtSnapshot.js ── */
    const balanceByName = await getRepBalances(reps, year, month);

    /* ── Fridges (route-based, name fallback) — same convention as
       performanceDashboard.js ── */
    const custRepRes = await pool.query(`
      SELECT DISTINCT salesrep_name, customer_code FROM sales_activity
      WHERE report_year=$1 AND month_num=$2 AND salesrep_name = ANY($3::text[]) AND qty > 0
    `, [year, month, nsNames]);
    const custsByRep = {};
    custRepRes.rows.forEach(r => {
      if (!custsByRep[r.salesrep_name]) custsByRep[r.salesrep_name] = new Set();
      custsByRep[r.salesrep_name].add(r.customer_code);
    });

    const repRouteIds = [...new Set(reps.map(r => r.route_id).filter(v => v !== null && v !== undefined))];
    const fridgeRes = await pool.query(`
      SELECT route_code, salesrep_name, customer_code FROM fridges
      WHERE status = 'active' AND (route_code = ANY($1::int[]) OR salesrep_name = ANY($2::text[]))
    `, [repRouteIds, nsNames]);
    const fridgesByRoute = {};
    const fridgesByRep   = {};
    fridgeRes.rows.forEach(r => {
      if (r.route_code !== null && r.route_code !== undefined) {
        if (!fridgesByRoute[r.route_code]) fridgesByRoute[r.route_code] = [];
        fridgesByRoute[r.route_code].push(r.customer_code);
      }
      if (r.salesrep_name) {
        if (!fridgesByRep[r.salesrep_name]) fridgesByRep[r.salesrep_name] = [];
        fridgesByRep[r.salesrep_name].push(r.customer_code);
      }
    });
    const allFridgeCustCodes = [...new Set(fridgeRes.rows.map(r => r.customer_code).filter(Boolean))];
    let fridgeQtyByRep = {};
    if (allFridgeCustCodes.length) {
      const fridgeQtyRes = await pool.query(`
        SELECT salesrep_name, SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END) AS fridge_qty
        FROM sales_activity
        WHERE report_year=$1 AND month_num=$2 AND salesrep_name = ANY($3::text[]) AND customer_code = ANY($4::text[])
        GROUP BY salesrep_name
      `, [year, month, nsNames, allFridgeCustCodes]);
      fridgeQtyRes.rows.forEach(r => { fridgeQtyByRep[r.salesrep_name] = parseInt(r.fridge_qty || 0); });
    }
    const wdCur = workingDays(year, month);

    /* ── Customer-category qty + target-split % (same as
       performanceDashboard.js) — used to apply the category penalty rule
       below: a rep's overall qty achievement can't be inflated by
       overselling one customer category to mask underselling another. ── */
    // Uses SUM(qty) — NET, including negative/return rows — same basis as
    // qty_mtd below, so the category breakdown always sums to the same
    // total the raw achievement % is computed from. Gross-positive qty
    // here let the category-penalty deduction come out larger than the
    // total shortfall whenever a rep had any returns, occasionally
    // pushing the "penalized" achievement % ABOVE the raw one.
    const saCatRes = await pool.query(`
      SELECT salesrep_name,
             COALESCE(NULLIF(TRIM(category_name), ''), 'غير محدد') AS category_name,
             SUM(qty) AS qty_net
      FROM sales_activity
      WHERE report_year = $1 AND month_num = $2 AND salesrep_name = ANY($3::text[])
      GROUP BY salesrep_name, COALESCE(NULLIF(TRIM(category_name), ''), 'غير محدد')
    `, [year, month, nsNames]);
    const catQtyByRep = {};
    saCatRes.rows.forEach(r => {
      if (!catQtyByRep[r.salesrep_name]) catQtyByRep[r.salesrep_name] = {};
      catQtyByRep[r.salesrep_name][r.category_name] = parseInt(r.qty_net || 0);
    });
    const [catSplitGlobalRes, catSplitRegionRes, catSplitRepRes] = await Promise.all([
      pool.query(`SELECT category_name, pct FROM category_target_splits`),
      pool.query(`SELECT region_id, category_name, pct FROM region_category_target_splits`),
      pool.query(`SELECT rep_id, category_name, pct FROM rep_category_target_splits WHERE rep_id = ANY($1::int[])`, [repIds]),
    ]);
    const catSplitGlobal = {};
    catSplitGlobalRes.rows.forEach(r => { catSplitGlobal[r.category_name] = parseFloat(r.pct || 0); });
    const catSplitByRegion = {};
    catSplitRegionRes.rows.forEach(r => {
      if (!catSplitByRegion[r.region_id]) catSplitByRegion[r.region_id] = {};
      catSplitByRegion[r.region_id][r.category_name] = parseFloat(r.pct || 0);
    });
    const catSplitByRep = {};
    catSplitRepRes.rows.forEach(r => {
      if (!catSplitByRep[r.rep_id]) catSplitByRep[r.rep_id] = {};
      catSplitByRep[r.rep_id][r.category_name] = parseFloat(r.pct || 0);
    });
    const allCategoriesSet = new Set(Object.keys(catSplitGlobal));
    Object.values(catSplitByRegion).forEach(m => Object.keys(m).forEach(c => allCategoriesSet.add(c)));
    Object.values(catSplitByRep).forEach(m => Object.keys(m).forEach(c => allCategoriesSet.add(c)));
    Object.values(catQtyByRep).forEach(m => Object.keys(m).forEach(c => allCategoriesSet.add(c)));
    const allCategories = [...allCategoriesSet];
    function resolveCatPct(repId, regionId, cat) {
      const repMap = catSplitByRep[repId];
      if (repMap && Object.prototype.hasOwnProperty.call(repMap, cat)) return repMap[cat];
      const regionMap = catSplitByRegion[regionId];
      if (regionMap && Object.prototype.hasOwnProperty.call(regionMap, cat)) return regionMap[cat];
      return catSplitGlobal[cat] || 0;
    }
    function buildCategoryBreakdown(repId, regionId, nsName, qtyTarget) {
      const catQtys = catQtyByRep[nsName] || {};
      return allCategories.map(cat => {
        const catQty    = catQtys[cat] || 0;
        const pct       = resolveCatPct(repId, regionId, cat);
        const catTarget = qtyTarget > 0 ? (pct / 100) * qtyTarget : 0;
        return { category: cat, qty: catQty, target: +catTarget.toFixed(1) };
      }).filter(c => c.qty !== 0 || c.target > 0); // net qty can be negative
    }

    /* ── Build per-rep absolute metrics + commission ─────────── */
    function buildMetrics(abs) {
      const qtyAch  = abs.qty_target  > 0 ? (abs.qty_mtd   / abs.qty_target  * 100) : null;
      const custAch = abs.customer_target > 0 ? (abs.customers_mtd / abs.customer_target * 100) : null;
      const debtPct = abs.credit_limit > 0 ? (abs.balance / abs.credit_limit * 100) : null;
      const damagePct = abs.qty_positive > 0 ? (abs.damage_qty / abs.qty_positive * 100) : null;
      const fridgeCoveragePct = abs.fridges_total > 0 ? (abs.fridges_covered / abs.fridges_total * 100) : null;
      const fridgeTargetAch   = abs.fridge_target > 0 ? (abs.fridge_qty / abs.fridge_target * 100) : null;
      return { qtyAch, custAch, debtPct, damagePct, fridgeCoveragePct, fridgeTargetAch };
    }
    function round1(v) { return v === null || v === undefined ? null : +v.toFixed(1); }
    function avg(arr) {
      const vals = arr.filter(v => v !== null && v !== undefined);
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    }

    function commissionFromMetrics(personType, personId, m) {
      const { total_pct, breakdown } = computeCommissionPct(m, weights);
      const limit = limitsMap[`${personType}-${personId}`] || 0;
      const cappedPct = Math.min(total_pct, 110);
      const amount = limit > 0 ? +((cappedPct / 100) * limit).toFixed(2) : 0;
      return {
        metrics: {
          qty_achievement: round1(m.qtyAch), customer_achievement: round1(m.custAch),
          debt_pct: round1(m.debtPct), debt_excess_pct: debtExcessInfo(m.debtPct)?.excess_pct ?? null,
          damage_pct: m.damagePct !== null ? +m.damagePct.toFixed(2) : null,
          fridge_coverage_pct: round1(m.fridgeCoveragePct), fridge_target_achievement: round1(m.fridgeTargetAch),
        },
        breakdown,
        total_pct,
        capped_pct: +cappedPct.toFixed(1),
        commission_limit: limit,
        commission_amount: amount,
      };
    }

    const repAbsById = {};
    const repMetricsById = {};
    const repCategoryBreakdownById = {};
    const repRows = reps.map(rep => {
      const nsName = rep.netsuite_name || '';
      const sa = saByName[nsName] || {};
      const target = targetById[rep.id] || {};
      const balance = balanceByName[nsName] || 0;

      const qtyMtd      = parseInt(sa.qty_net || 0);
      const qtyPositive = parseInt(sa.qty_positive || 0);
      const damageQty   = parseInt(sa.damage_qty || 0);
      const custMtd     = parseInt(sa.active_customers || 0);
      const qtyTarget   = parseInt(target.qty_target || 0);
      const custTarget  = parseInt(target.customer_target || 0);
      const creditLimit = parseFloat(target.credit_limit || 0);

      const custCodes = custsByRep[nsName] || new Set();
      const routeMatch = (rep.route_id !== null && rep.route_id !== undefined) ? fridgesByRoute[rep.route_id] : null;
      const repFridgeCustCodes = routeMatch || fridgesByRep[nsName] || [];
      const fridgesTotal   = repFridgeCustCodes.length;
      const fridgesCovered = repFridgeCustCodes.filter(c => c && custCodes.has(c)).length;
      const fridgeQty       = fridgeQtyByRep[nsName] || 0;
      const fridgeTarget    = fridgesTotal > 0 ? fridgesTotal * FRIDGE_DAILY_TARGET * wdCur : 0;

      const abs = {
        qty_mtd: qtyMtd, qty_target: qtyTarget, qty_positive: qtyPositive, damage_qty: damageQty,
        customers_mtd: custMtd, customer_target: custTarget,
        credit_limit: creditLimit, balance,
        fridges_total: fridgesTotal, fridges_covered: fridgesCovered, fridge_qty: fridgeQty, fridge_target: fridgeTarget,
      };
      repAbsById[rep.id] = abs;
      const repMetrics = buildMetrics(abs);

      // Category penalty: a surplus in one customer category can't offset
      // a shortfall in another — same rule as the performance dashboard's
      // "الأداء المرجح" column, so commission and dashboard always agree.
      const categoryBreakdown = buildCategoryBreakdown(rep.id, rep.region_id, nsName, qtyTarget);
      repCategoryBreakdownById[rep.id] = categoryBreakdown;
      const catPenalty = computeCategoryPenalty(categoryBreakdown, qtyTarget);
      const qtyAchRaw = repMetrics.qtyAch;
      if (catPenalty) repMetrics.qtyAch = catPenalty.penalized_pct;
      repMetricsById[rep.id] = repMetrics;

      const commission = commissionFromMetrics('rep', rep.id, repMetrics);
      return {
        rep_id: rep.id, rep_name: rep.name_ar, region_name: rep.region_name,
        supervisor_id: rep.supervisor_id, region_manager_id: rep.region_manager_id,
        sector_manager_id: rep.sector_manager_id, sales_manager_id: rep.sales_manager_id,
        qty_achievement_raw: round1(qtyAchRaw),
        qty_penalty_pct: catPenalty ? round1(qtyAchRaw - catPenalty.penalized_pct) : 0,
        qty_penalty_reasons: catPenalty ? catPenalty.shortfalls : [],
        ...commission,
      };
    });

    /* ── Manager rollups ──────────────────────────────────────
       Sales/customer achievement: totals of the reps directly linked
       to this manager (sum achieved ÷ sum target), same as before.
       Debt: aggregate — sum of the linked reps' outstanding balance ÷
       sum of their credit limits. Averaging each rep's individual debt%
       (the previous approach) let a single outlier rep with a small
       credit limit but a large balance (e.g. 201% on their own) drag a
       whole team's average over the 110% cutoff and zero the entire
       debt item's weight, even though the team's total balance was
       comfortably under its total limit. Aggregating first avoids that.
       توالف / fridge coverage & target: still AVERAGE of the linked
       reps' own individual percentages — for a supervisor or a منطقة
       manager, averaged over just their linked reps; for a قطاع manager
       or a مبيعات manager (company-wide roles), averaged over ALL
       active reps regardless of that specific link. */
    const managersRes = await pool.query(`SELECT id, name_ar, role, is_active FROM rep_managers WHERE is_active ORDER BY role, name_ar`);
    const managers = { supervisor: [], region_manager: [], sector_manager: [], sales_manager: [] };
    managersRes.rows.forEach(mgr => {
      const field = MANAGER_ROLE_FIELD[mgr.role];
      if (!field) return;
      const linkedReps = reps.filter(r => r[field] === mgr.id);
      const avgSourceReps = (mgr.role === 'sector_manager' || mgr.role === 'sales_manager') ? reps : linkedReps;

      const qtyCustTotals = linkedReps.reduce((s, r) => {
        const a = repAbsById[r.id];
        s.qty_mtd += a.qty_mtd; s.qty_target += a.qty_target;
        s.customers_mtd += a.customers_mtd; s.customer_target += a.customer_target;
        return s;
      }, { qty_mtd: 0, qty_target: 0, customers_mtd: 0, customer_target: 0 });
      const qtyAchRaw = qtyCustTotals.qty_target > 0 ? (qtyCustTotals.qty_mtd / qtyCustTotals.qty_target * 100) : null;
      const custAch   = qtyCustTotals.customer_target > 0 ? (qtyCustTotals.customers_mtd / qtyCustTotals.customer_target * 100) : null;

      // Same category-penalty rule as reps, applied to the manager's
      // linked-reps' aggregated category breakdown.
      const mgrCatAgg = {};
      linkedReps.forEach(r => {
        (repCategoryBreakdownById[r.id] || []).forEach(c => {
          if (!mgrCatAgg[c.category]) mgrCatAgg[c.category] = { category: c.category, qty: 0, target: 0 };
          mgrCatAgg[c.category].qty    += c.qty;
          mgrCatAgg[c.category].target += c.target;
        });
      });
      const mgrCatPenalty = computeCategoryPenalty(Object.values(mgrCatAgg), qtyCustTotals.qty_target);
      const qtyAch = mgrCatPenalty ? mgrCatPenalty.penalized_pct : qtyAchRaw;

      const debtTotals = avgSourceReps.reduce((s, r) => {
        const a = repAbsById[r.id];
        s.balance      += a.balance;
        s.credit_limit += a.credit_limit;
        return s;
      }, { balance: 0, credit_limit: 0 });
      const debtPct = debtTotals.credit_limit > 0 ? (debtTotals.balance / debtTotals.credit_limit * 100) : null;

      const m = {
        qtyAch, custAch, debtPct,
        damagePct:          avg(avgSourceReps.map(r => repMetricsById[r.id].damagePct)),
        fridgeCoveragePct:  avg(avgSourceReps.map(r => repMetricsById[r.id].fridgeCoveragePct)),
        fridgeTargetAch:    avg(avgSourceReps.map(r => repMetricsById[r.id].fridgeTargetAch)),
      };

      const commission = commissionFromMetrics('manager', mgr.id, m);
      managers[mgr.role].push({
        manager_id: mgr.id, name: mgr.name_ar, role: mgr.role,
        reps_count: linkedReps.length,
        qty_achievement_raw: round1(qtyAchRaw),
        qty_penalty_pct: mgrCatPenalty ? round1(qtyAchRaw - mgrCatPenalty.penalized_pct) : 0,
        qty_penalty_reasons: mgrCatPenalty ? mgrCatPenalty.shortfalls : [],
        ...commission,
      });
    });

    res.json({ year, month, weights, damage_target_pct: DAMAGE_TARGET_PCT, reps: repRows, managers });
  } catch (err) {
    console.error('[Commissions/report]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
