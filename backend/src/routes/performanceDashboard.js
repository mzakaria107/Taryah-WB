const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter, requireRoles } = require('../middleware/auth');
const { DAMAGE_TARGET_PCT, computeCommissionPct, computeCategoryPenalty, debtExcessInfo } = require('../utils/commission');
const { getRepBalances } = require('../utils/debtSnapshot');

const ADMIN = ['super_admin', 'it_admin'];
const FRIDGE_DAILY_TARGET = 40; // units/day per active fridge (same as FridgesPage)

/* ── Working-days calculator (skip Friday + named holidays) — same
   convention as summary.js/hypermarkets.js: full month if the period
   is in the past, MTD (up to today) if it's the current month. ── */
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

const MONTH_NAMES_AR = {
  1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
  7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
};

/* ═══════════════════════════════════════════════════════════════
   Category target split — admin-configurable percentages that
   divide each rep's overall qty_target across customer categories
   (sales_activity.category_name). Not required to sum to 100; the
   frontend flags it if they don't so the admin notices.

   Three levels, resolved as rep > region > global (most specific
   wins) when the main dashboard computes each rep's category targets:
     - global: category_target_splits            (category_name PK)
     - region: region_category_target_splits      (region_id, category_name)
     - rep:    rep_category_target_splits         (rep_id, category_name)
═══════════════════════════════════════════════════════════════ */
const SCOPE_TABLE = {
  global: { table: 'category_target_splits',        idCol: null },
  region: { table: 'region_category_target_splits',  idCol: 'region_id' },
  rep:    { table: 'rep_category_target_splits',      idCol: 'rep_id' },
};

router.get('/category-splits', verifyToken, async (req, res) => {
  try {
    const scope = ['global', 'region', 'rep'].includes(req.query.scope) ? req.query.scope : 'global';
    const cfg = SCOPE_TABLE[scope];
    const scopeId = req.query.scope_id ? parseInt(req.query.scope_id, 10) : null;
    if (cfg.idCol && !scopeId) {
      return res.status(400).json({ error: 'scope_id مطلوب لهذا النطاق' });
    }

    const splitsQuery = cfg.idCol
      ? pool.query(`SELECT category_name, pct FROM ${cfg.table} WHERE ${cfg.idCol} = $1 ORDER BY category_name`, [scopeId])
      : pool.query(`SELECT category_name, pct FROM ${cfg.table} ORDER BY category_name`);

    const [splitsRes, catsRes] = await Promise.all([
      splitsQuery,
      pool.query(`
        SELECT DISTINCT NULLIF(TRIM(category_name), '') AS category_name
        FROM sales_activity
        WHERE category_name IS NOT NULL AND TRIM(category_name) <> ''
        ORDER BY 1
      `),
    ]);
    res.json({
      scope,
      splits: splitsRes.rows,
      categories: catsRes.rows.map(r => r.category_name).filter(Boolean),
    });
  } catch (err) {
    console.error('[PerformanceDashboard/category-splits]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/category-splits', verifyToken, requireRoles(...ADMIN), async (req, res) => {
  try {
    const { splits, scope, scope_id } = req.body; // splits: [{ category_name, pct }]
    if (!Array.isArray(splits)) return res.status(400).json({ error: 'splits يجب أن تكون مصفوفة' });
    const cfg = SCOPE_TABLE[scope];
    if (!cfg) return res.status(400).json({ error: 'scope غير صالح' });
    const scopeId = scope_id ? parseInt(scope_id, 10) : null;
    if (cfg.idCol && !scopeId) return res.status(400).json({ error: 'scope_id مطلوب لهذا النطاق' });

    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      for (const s of splits) {
        const name = String(s.category_name || '').trim();
        const pct  = Number(s.pct) || 0;
        if (!name) continue;
        if (cfg.idCol) {
          await dbClient.query(`
            INSERT INTO ${cfg.table} (${cfg.idCol}, category_name, pct, updated_by, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (${cfg.idCol}, category_name) DO UPDATE
              SET pct = EXCLUDED.pct, updated_by = EXCLUDED.updated_by, updated_at = NOW()
          `, [scopeId, name, pct, req.user.id]);
        } else {
          await dbClient.query(`
            INSERT INTO ${cfg.table} (category_name, pct, updated_by, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (category_name) DO UPDATE
              SET pct = EXCLUDED.pct, updated_by = EXCLUDED.updated_by, updated_at = NOW()
          `, [name, pct, req.user.id]);
        }
      }
      await dbClient.query('COMMIT');
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[PerformanceDashboard/category-splits PUT]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* Clear a rep- or region-level override for one category so it falls
   back to the next level up (region → global). Global itself can't be
   "cleared" — set its pct to 0 instead. */
router.delete('/category-splits', verifyToken, requireRoles(...ADMIN), async (req, res) => {
  try {
    const { scope, scope_id, category_name } = req.query;
    const cfg = SCOPE_TABLE[scope];
    if (!cfg || !cfg.idCol) return res.status(400).json({ error: 'scope غير صالح' });
    const scopeId = parseInt(scope_id, 10);
    if (!scopeId || !category_name) return res.status(400).json({ error: 'scope_id و category_name مطلوبان' });
    await pool.query(`DELETE FROM ${cfg.table} WHERE ${cfg.idCol} = $1 AND category_name = $2`, [scopeId, category_name]);
    res.json({ success: true });
  } catch (err) {
    console.error('[PerformanceDashboard/category-splits DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/performance-dashboard
   Query params: year, month, region_id
   Returns performance per rep aggregated from:
   - sales_activity (qty, customers)
   - invoices (outstanding balance)
   - payments (collection)
   - sales_rep_targets (targets)
   - sales_reps (hierarchy)
──────────────────────────────────────────────────────────────── */
router.get('/', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const now   = new Date();
    const year  = Number(req.query.year  || now.getFullYear());
    const month = Number(req.query.month || (now.getMonth() + 1));
    const requestedRegionId = req.query.region_id ? Number(req.query.region_id) : null;
    // Region-restricted users (req.regionFilter is an array) can only ever
    // see their own assigned region(s) — a requested region_id outside that
    // set is ignored in favour of the full allowed set, never honoured as-is.
    let regionIds = null;
    if (req.regionFilter && req.regionFilter.length) {
      regionIds = (requestedRegionId && req.regionFilter.includes(requestedRegionId))
        ? [requestedRegionId]
        : req.regionFilter;
    } else if (requestedRegionId) {
      regionIds = [requestedRegionId];
    }
    const regionId = regionIds && regionIds.length === 1 ? regionIds[0] : null;
    const repId    = req.query.rep_id ? Number(req.query.rep_id) : null;

    // Prev month
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;

    /* ── 1. All reps with hierarchy ─────────────────────────── */
    let repSql = `
      SELECT sr.id, sr.name_ar, sr.netsuite_name,
             sr.region_id, sr.route_id,
             reg.name_ar  AS region_name,
             sup.name_ar  AS supervisor_name,
             rm.name_ar   AS region_manager_name,
             sm.name_ar   AS sector_manager_name,
             smgr.name_ar AS sales_manager_name
      FROM sales_reps sr
      LEFT JOIN regions      reg  ON reg.id  = sr.region_id
      LEFT JOIN rep_managers sup  ON sup.id  = sr.supervisor_id
      LEFT JOIN rep_managers rm   ON rm.id   = sr.region_manager_id
      LEFT JOIN rep_managers sm   ON sm.id   = sr.sector_manager_id
      LEFT JOIN rep_managers smgr ON smgr.id = sr.sales_manager_id
      WHERE sr.is_active
    `;
    const repParams = [];
    if (regionIds) { repParams.push(regionIds); repSql += ` AND sr.region_id = ANY($${repParams.length}::int[])`; }
    if (repId)      { repParams.push(repId);    repSql += ` AND sr.id = $${repParams.length}`; }
    repSql += ` ORDER BY reg.name_ar, sr.name_ar`;
    const repsRes = await pool.query(repSql, repParams);
    const reps    = repsRes.rows;

    if (!reps.length) {
      return res.json({ year, month, monthName: MONTH_NAMES_AR[month], regions: [], kpi: {} });
    }

    const nsNames = reps.map(r => r.netsuite_name).filter(Boolean);
    const repIds  = reps.map(r => r.id);

    /* ── 2. Current month sales_activity per rep ─────────────── */
    const saRes = await pool.query(
      `SELECT
         salesrep_name,
         SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END)        AS qty_positive,
         SUM(qty)                                           AS qty_net,
         SUM(COALESCE(bad_return_qty, 0))                   AS damage_qty,
         COUNT(DISTINCT CASE WHEN qty > 0 THEN customer_code END) AS active_customers
       FROM sales_activity
       WHERE report_year = $1 AND month_num = $2
         AND salesrep_name = ANY($3::text[])
       GROUP BY salesrep_name`,
      [year, month, nsNames]
    );
    const saByName = {};
    saRes.rows.forEach(r => { saByName[r.salesrep_name] = r; });

    /* ── 2b. Current month qty per rep × customer category ────
       Uses SUM(qty) — NET, including negative/return rows — same basis as
       rep.qty_mtd, so the category breakdown always sums to the same total
       the raw achievement % is computed from. Using gross-positive qty
       here (as this used to) let the category-penalty deduction (below)
       come out larger than the total shortfall whenever a rep had any
       returns, occasionally pushing the "penalized" achievement % ABOVE
       the raw one — see the same fix already applied to the item-category
       breakdown a few lines down. */
    const saCatRes = await pool.query(
      `SELECT
         salesrep_name,
         COALESCE(NULLIF(TRIM(category_name), ''), 'غير محدد') AS category_name,
         SUM(qty) AS qty_net
       FROM sales_activity
       WHERE report_year = $1 AND month_num = $2
         AND salesrep_name = ANY($3::text[])
       GROUP BY salesrep_name, COALESCE(NULLIF(TRIM(category_name), ''), 'غير محدد')`,
      [year, month, nsNames]
    );
    const catQtyByRep = {}; // { repName: { category: qty } }
    saCatRes.rows.forEach(r => {
      if (!catQtyByRep[r.salesrep_name]) catQtyByRep[r.salesrep_name] = {};
      catQtyByRep[r.salesrep_name][r.category_name] = parseInt(r.qty_net || 0);
    });

    /* ── 2c0. Current month qty per rep × item category (product type) ──
       Powers the small colored breakdown shown under the "الكمية" cell
       — دجاج مبرد طرية / مقطعات طرية / دجاج مجمد, matching item_category_en
       exactly as it exists in sales_activity, everything else bucketed
       into "أخرى". Distinct from category_name (customer category) used
       by the split system above.
       Uses SUM(qty) — NET, including negative/return rows — same basis
       as rep.qty_mtd (also SUM(qty)/qty_net) below, so the category parts
       always sum to the displayed total. Using gross-positive qty here
       (as qty_positive elsewhere does) previously made the breakdown sum
       to MORE than the net total whenever a rep had any returns. */
    const saItemCatRes = await pool.query(
      `SELECT
         salesrep_name,
         COALESCE(NULLIF(TRIM(item_category_en), ''), 'أخرى') AS item_category,
         SUM(qty) AS qty_net
       FROM sales_activity
       WHERE report_year = $1 AND month_num = $2
         AND salesrep_name = ANY($3::text[])
       GROUP BY salesrep_name, COALESCE(NULLIF(TRIM(item_category_en), ''), 'أخرى')`,
      [year, month, nsNames]
    );
    const itemCatQtyByRep = {}; // { repName: { itemCategory: qty } }
    saItemCatRes.rows.forEach(r => {
      if (!itemCatQtyByRep[r.salesrep_name]) itemCatQtyByRep[r.salesrep_name] = {};
      itemCatQtyByRep[r.salesrep_name][r.item_category] = parseInt(r.qty_net || 0);
    });
    const KNOWN_ITEM_CATEGORIES = ['دجاج مبرد طرية', 'مقطعات طرية', 'دجاج مجمد'];
    const ITEM_CAT_TARGET_FIELD = {
      'دجاج مبرد طرية': 'qty_target_chilled',
      'مقطعات طرية':    'qty_target_cuts',
      'دجاج مجمد':      'qty_target_frozen',
    };
    // Merges actual qty (from sales_activity, grouped above) with each
    // category's own target (entered directly per rep in Rep Management,
    // not derived from a % split) — so qty/target/achievement can all be
    // shown per item category, not just per rep overall. "أخرى" has no
    // target field, so its achievement is always null.
    function buildItemQtyBreakdown(itemQtys, targetRow) {
      const known = KNOWN_ITEM_CATEGORIES.map(cat => {
        const qty    = itemQtys[cat] || 0;
        const target = targetRow ? Number(targetRow[ITEM_CAT_TARGET_FIELD[cat]] || 0) : 0;
        return {
          category: cat,
          qty,
          target,
          achievement: target > 0 ? +((qty / target) * 100).toFixed(1) : null,
        };
      });
      const otherQty = Object.entries(itemQtys)
        .filter(([cat]) => !KNOWN_ITEM_CATEGORIES.includes(cat))
        .reduce((s, [, q]) => s + q, 0);
      const all = [...known, { category: 'أخرى', qty: otherQty, target: 0, achievement: null }];
      // qty is net (can be negative if returns exceeded sales that month
      // in a category) — filter on !== 0, not > 0, so a negative-net
      // category isn't silently dropped, which would otherwise make the
      // visible parts sum to less than the displayed total.
      return all.filter(c => c.qty !== 0 || c.target > 0).sort((a, b) => b.qty - a.qty);
    }

    /* ── 2c. Target split percentages per category (admin-configured) ──
       Resolved per rep as rep-level override > region-level override >
       global default, so different regions/reps can carry a different
       category mix (e.g. a Riyadh rep mostly Hypermarkets, a Hail rep
       mostly Restaurants). */
    const [catSplitGlobalRes, catSplitRegionRes, catSplitRepRes] = await Promise.all([
      pool.query(`SELECT category_name, pct FROM category_target_splits`),
      pool.query(`SELECT region_id, category_name, pct FROM region_category_target_splits`),
      pool.query(`SELECT rep_id, category_name, pct FROM rep_category_target_splits WHERE rep_id = ANY($1::int[])`, [repIds]),
    ]);
    const catSplitGlobal = {};
    catSplitGlobalRes.rows.forEach(r => { catSplitGlobal[r.category_name] = parseFloat(r.pct || 0); });
    const catSplitByRegion = {}; // { region_id: { category: pct } }
    catSplitRegionRes.rows.forEach(r => {
      if (!catSplitByRegion[r.region_id]) catSplitByRegion[r.region_id] = {};
      catSplitByRegion[r.region_id][r.category_name] = parseFloat(r.pct || 0);
    });
    const catSplitByRep = {}; // { rep_id: { category: pct } }
    catSplitRepRes.rows.forEach(r => {
      if (!catSplitByRep[r.rep_id]) catSplitByRep[r.rep_id] = {};
      catSplitByRep[r.rep_id][r.category_name] = parseFloat(r.pct || 0);
    });
    // Master category list — the UNION of every category name that has a
    // configured split anywhere (global/region/rep) plus every category
    // any rep actually sold in this month. Used so a rep's target gets
    // allocated across ALL configured categories even for the ones they
    // didn't sell any qty in this period — otherwise a rep who only sold
    // Poultry Shops this month would silently drop their Hypermarkets/
    // Restaurant/etc. share of target entirely, understating those
    // categories' aggregated % everywhere below their configured weight.
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

    /* ── 3. Prev month sales_activity per rep ───────────────── */
    const saPrevRes = await pool.query(
      `SELECT
         salesrep_name,
         SUM(qty)                                                   AS qty_net,
         COUNT(DISTINCT CASE WHEN qty > 0 THEN customer_code END)  AS active_customers
       FROM sales_activity
       WHERE report_year = $1 AND month_num = $2
         AND salesrep_name = ANY($3::text[])
       GROUP BY salesrep_name`,
      [prevYear, prevMonth, nsNames]
    );
    const saPrevByName = {};
    saPrevRes.rows.forEach(r => { saPrevByName[r.salesrep_name] = r; });

    /* ── 3b. New customers this month (first-time buyers ever) ── */
    let newCustByName = {};
    if (nsNames.length) {
      const newCustRes = await pool.query(
        `WITH cur AS (
           SELECT salesrep_name, customer_code
           FROM sales_activity
           WHERE report_year=$1 AND month_num=$2 AND qty > 0
             AND salesrep_name = ANY($3::text[])
         ),
         prev_custs AS (
           SELECT DISTINCT customer_code FROM sales_activity
           WHERE qty > 0
             AND (report_year < $1 OR (report_year = $1 AND month_num < $2))
         )
         SELECT cur.salesrep_name,
                COUNT(DISTINCT cur.customer_code) AS new_customers
         FROM cur
         WHERE cur.customer_code NOT IN (SELECT customer_code FROM prev_custs)
         GROUP BY cur.salesrep_name`,
        [year, month, nsNames]
      );
      newCustRes.rows.forEach(r => {
        newCustByName[r.salesrep_name] = parseInt(r.new_customers || 0);
      });
    }

    /* ── 4. Targets per rep for this month ──────────────────── */
    const targetsRes = await pool.query(
      `SELECT rep_id, qty_target, qty_target_chilled, qty_target_cuts, qty_target_frozen,
              customer_target, collection_target_pct, credit_limit
       FROM sales_rep_targets
       WHERE rep_id = ANY($1::int[]) AND year=$2 AND month=$3`,
      [repIds, year, month]
    );
    const targetById = {};
    targetsRes.rows.forEach(r => { targetById[r.rep_id] = r; });

    /* ── 5. Outstanding balance per rep — frozen once the month is
       closed, see utils/debtSnapshot.js ── */
    const balanceData = await getRepBalances(reps, year, month);

    /* ── 6. Payments (collection) per rep via customer_code ─── */
    // Get customers served by each rep this month
    const custRepRes = await pool.query(
      `SELECT DISTINCT salesrep_name, customer_code
       FROM sales_activity
       WHERE report_year=$1 AND month_num=$2
         AND salesrep_name = ANY($3::text[])
         AND qty > 0`,
      [year, month, nsNames]
    );
    // Build: repName → Set of customer_codes
    const custsByRep = {};
    custRepRes.rows.forEach(r => {
      if (!custsByRep[r.salesrep_name]) custsByRep[r.salesrep_name] = new Set();
      custsByRep[r.salesrep_name].add(r.customer_code);
    });

    /* ── 6b. Fridge coverage per rep ──────────────────────────
       Part 1 (تغطية): active fridges whose customer actually bought
       this month (custsByRep, built above) ÷ total active fridges on
       that rep's route.
       Part 2 (هدف): actual qty sold to fridge-owning customers this
       month ÷ (active_fridge_count × 40 units/day × working days),
       same formula documented for FridgesPage (40/day, ~1040/month).

       Matched primarily via route number (fridges.route_code =
       sales_reps.route_id) — the more reliable link now that reps can
       be assigned a route in Rep Management — falling back to the old
       salesrep_name match for any rep who hasn't been linked to a
       route yet. */
    const repRouteIds = [...new Set(reps.map(r => r.route_id).filter(v => v !== null && v !== undefined))];
    const fridgeRes = await pool.query(
      `SELECT route_code, salesrep_name, customer_code, status
       FROM fridges
       WHERE status = 'active'
         AND (route_code = ANY($1::int[]) OR salesrep_name = ANY($2::text[]))`,
      [repRouteIds, nsNames]
    );
    const fridgesByRoute = {}; // { route_code: [customer_code, ...] }
    const fridgesByRep   = {}; // { repName: [customer_code, ...] } — fallback
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
      const fridgeQtyRes = await pool.query(
        `SELECT salesrep_name, SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END) AS fridge_qty
         FROM sales_activity
         WHERE report_year = $1 AND month_num = $2
           AND salesrep_name = ANY($3::text[])
           AND customer_code = ANY($4::text[])
         GROUP BY salesrep_name`,
        [year, month, nsNames, allFridgeCustCodes]
      );
      fridgeQtyRes.rows.forEach(r => { fridgeQtyByRep[r.salesrep_name] = parseInt(r.fridge_qty || 0); });
    }
    const wdCur = workingDays(year, month);

    // Sum payments per customer in the month
    const allCustCodes = [...new Set(custRepRes.rows.map(r => r.customer_code))];
    let paymentsByCustomer = {};
    if (allCustCodes.length) {
      const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
      const endDate   = new Date(year, month, 0).toISOString().slice(0,10); // last day
      const payRes = await pool.query(
        `SELECT customer_code, COALESCE(SUM(total_paid),0) AS collected
         FROM payments
         WHERE customer_code = ANY($1::text[])
           AND tran_date >= $2 AND tran_date <= $3
         GROUP BY customer_code`,
        [allCustCodes, startDate, endDate]
      );
      payRes.rows.forEach(r => { paymentsByCustomer[r.customer_code] = parseFloat(r.collected); });
    }

    /* ── 3c. Global distinct customer count — same method as summary report ──
       When a region/rep filter is active, scope to that filter's reps (nsNames)
       so the KPI total matches the filtered table below. With no filter, use
       the unscoped count so it matches the region-comparison report exactly. */
    const isFiltered = !!(regionIds || repId);
    const [globalCustRes, globalNewRes] = await Promise.all([
      isFiltered
        ? pool.query(
            `SELECT COUNT(DISTINCT customer_code)::int AS total_customers
             FROM sales_activity
             WHERE report_year=$1 AND month_num=$2 AND salesrep_name = ANY($3::text[])`,
            [year, month, nsNames]
          )
        : pool.query(
            `SELECT COUNT(DISTINCT customer_code)::int AS total_customers
             FROM sales_activity WHERE report_year=$1 AND month_num=$2`,
            [year, month]
          ),
      isFiltered
        ? pool.query(
            `SELECT COUNT(DISTINCT customer_code)::int AS new_customers
             FROM sales_activity
             WHERE report_year=$1 AND month_num=$2 AND salesrep_name = ANY($3::text[])
               AND customer_code NOT IN (
                 SELECT DISTINCT customer_code FROM sales_activity
                 WHERE report_year=$1 AND month_num < $2
               )`,
            [year, month, nsNames]
          )
        : pool.query(
            `SELECT COUNT(DISTINCT customer_code)::int AS new_customers
             FROM sales_activity
             WHERE report_year=$1 AND month_num=$2
               AND customer_code NOT IN (
                 SELECT DISTINCT customer_code FROM sales_activity
                 WHERE report_year=$1 AND month_num < $2
               )`,
            [year, month]
          ),
    ]);
    const globalDistinctCustomers    = parseInt(globalCustRes.rows[0]?.total_customers || 0);
    const globalDistinctNewCustomers = parseInt(globalNewRes.rows[0]?.new_customers || 0);

    /* ── 6c. Commission weights — "الأداء المرجح" now shows the same
       weighted commission % used on the "حساب العمولات" tab, so both
       stay consistent (see backend/src/utils/commission.js). ── */
    const commissionWeightsRes = await pool.query(`SELECT item_key, weight_pct FROM commission_weights`);
    const commissionWeights = {};
    commissionWeightsRes.rows.forEach(r => { commissionWeights[r.item_key] = parseFloat(r.weight_pct || 0); });

    /* ── 7. Build rep rows + region aggregation ─────────────── */
    const regionMap = {};

    reps.forEach(rep => {
      const nsName  = rep.netsuite_name || '';
      const sa      = saByName[nsName]      || {};
      const saPrev  = saPrevByName[nsName]  || {};
      const target  = targetById[rep.id]    || {};
      const balance = balanceData[nsName]   || 0;

      const qtyMtd      = parseInt(sa.qty_net || 0);
      const qtyPositive = parseInt(sa.qty_positive || 0);
      const qtyPrev     = parseInt(saPrev.qty_net || 0);
      const qtyTarget   = parseInt(target.qty_target || 0);
      const damageQty   = parseInt(sa.damage_qty || 0);
      // التوالف target: at most 0.5% of gross qty sold this month.
      const damagePct      = qtyPositive > 0 ? (damageQty / qtyPositive * 100) : null;
      const damageExceeded = damagePct !== null && damagePct > DAMAGE_TARGET_PCT;
      const custMtd     = parseInt(sa.active_customers || 0);
      const custPrev    = parseInt(saPrev.active_customers || 0);
      const custTarget  = parseInt(target.customer_target || 0);
      const newCustMtd  = newCustByName[nsName] || 0;
      const creditLimit     = parseFloat(target.credit_limit || 0);
      const collTargetPct   = parseFloat(target.collection_target_pct || 0);
      // Collection target = percentage of outstanding balance (what should be collected this month)
      const collTarget      = collTargetPct > 0 ? (collTargetPct / 100) * balance : 0;

      // Collection = sum of payments for this rep's customers
      const custCodes = custsByRep[nsName] || new Set();
      let collected = 0;
      custCodes.forEach(c => { collected += paymentsByCustomer[c] || 0; });

      // Fridge coverage: Part 1 (coverage %) = active fridges whose
      // customer bought this month ÷ total active fridges on the route.
      // Part 2 (target %) = actual qty sold to fridge customers ÷
      // (fridge count × 40/day × working days).
      // Prefer route-based match (rep.route_id → fridges.route_code);
      // fall back to name match only if the rep has no route assigned
      // or no fridges were found on that route.
      const routeMatch = (rep.route_id !== null && rep.route_id !== undefined)
        ? fridgesByRoute[rep.route_id]
        : null;
      const repFridgeCustCodes = routeMatch || fridgesByRep[nsName] || [];
      const totalFridges    = repFridgeCustCodes.length;
      const coveredFridges  = repFridgeCustCodes.filter(c => c && custCodes.has(c)).length;
      const fridgeCoveragePct = totalFridges > 0 ? (coveredFridges / totalFridges * 100) : null;
      const fridgeQty        = fridgeQtyByRep[nsName] || 0;
      const fridgeTarget     = totalFridges > 0 ? totalFridges * FRIDGE_DAILY_TARGET * wdCur : 0;
      const fridgeTargetAch  = fridgeTarget > 0 ? (fridgeQty / fridgeTarget * 100) : null;

      const qtyGrowth   = qtyPrev > 0 ? ((qtyMtd - qtyPrev) / qtyPrev * 100) : null;
      const qtyAch      = qtyTarget > 0 ? (qtyMtd / qtyTarget * 100) : null;
      const custAch     = custTarget > 0 ? (custMtd / custTarget * 100) : null;
      const collAch     = collTarget > 0 ? (collected / collTarget * 100) : null;
      const debtPct     = creditLimit > 0 ? (balance / creditLimit * 100) : null;
      // Max allowed debt = 110% of credit limit (10% overage is acceptable)
      const maxAllowedDebt = creditLimit * 1.10;
      const debtExceeded   = creditLimit > 0 && balance > maxAllowedDebt;
      // 100% if within limit; linearly drops to 0% at 2× credit_limit
      const limitAch    = creditLimit > 0
        ? (balance <= maxAllowedDebt
            ? 100
            : Math.max(0, (2 * creditLimit - balance) / (2 * creditLimit - maxAllowedDebt) * 100))
        : null;
      // Category breakdown: each category's slice of qty_target (via the
      // admin-configured split %) vs. what was actually sold in that
      // category this month. Iterates the FULL category list (not just
      // categories this rep happened to sell in) so their target is
      // allocated across every configured category, not silently
      // dropped for the ones with zero qty this period — otherwise the
      // aggregate % at region/company level comes out systematically
      // lower than the configured weights (see commit history).
      const catQtys = catQtyByRep[nsName] || {};
      const categoryBreakdown = allCategories.map(cat => {
        const catQty    = catQtys[cat] || 0;
        const pct       = resolveCatPct(rep.id, rep.region_id, cat);
        const catTarget = qtyTarget > 0 ? (pct / 100) * qtyTarget : 0;
        const catAch    = catTarget > 0 ? (catQty / catTarget * 100) : null;
        return {
          category:    cat,
          qty:         catQty,
          target_pct:  pct,
          target:      +catTarget.toFixed(1),
          achievement: catAch !== null ? +catAch.toFixed(1) : null,
        };
      }).filter(c => c.qty !== 0 || c.target > 0) // net qty can be negative — see item-category comment above
        .sort((a, b) => b.qty - a.qty);

      // Category penalty: a surplus in one customer category can't offset
      // a shortfall in another — each category's contribution toward the
      // overall qty achievement is capped at its own target. The rep's
      // real qty_achievement (and everything derived from it, incl. the
      // الأداء المرجح commission formula) uses this penalized % instead of
      // the raw qty_mtd/qty_target ratio whenever a category split is
      // actually configured.
      const catPenalty  = computeCategoryPenalty(categoryBreakdown, qtyTarget);
      const qtyAchFinal = catPenalty ? catPenalty.penalized_pct : qtyAch;
      const qtyPenaltyPct = catPenalty ? +(qtyAch - catPenalty.penalized_pct).toFixed(1) : 0;

      // الأداء المرجح = weighted commission % across all 5 items (same
      // formula/weights as the حساب العمولات tab — see utils/commission.js)
      const weightedAch = computeCommissionPct(
        { qtyAch: qtyAchFinal, custAch, debtPct, damagePct, fridgeCoveragePct, fridgeTargetAch },
        commissionWeights
      ).total_pct;

      const itemQtyBreakdown = buildItemQtyBreakdown(itemCatQtyByRep[nsName] || {}, target);

      const repRow = {
        rep_id:           rep.id,
        rep_name:         rep.name_ar,
        netsuite_name:    nsName,
        supervisor:       rep.supervisor_name,
        region_manager:   rep.region_manager_name,
        sector_manager:   rep.sector_manager_name,
        sales_manager:    rep.sales_manager_name,
        qty_mtd:          qtyMtd,
        qty_positive:     qtyPositive,
        qty_prev:         qtyPrev,
        qty_target:       qtyTarget,
        qty_growth:       qtyGrowth !== null ? +qtyGrowth.toFixed(1) : null,
        qty_achievement:      qtyAchFinal !== null ? +qtyAchFinal.toFixed(1) : null,
        qty_achievement_raw:  qtyAch      !== null ? +qtyAch.toFixed(1)      : null,
        qty_penalty_pct:      qtyPenaltyPct,
        qty_penalty_reasons:  catPenalty ? catPenalty.shortfalls : [],
        damage_qty:       damageQty,
        damage_pct:       damagePct !== null ? +damagePct.toFixed(2) : null,
        damage_exceeded:  damageExceeded,
        fridges_total:      totalFridges,
        fridges_covered:    coveredFridges,
        fridge_coverage_pct: fridgeCoveragePct !== null ? +fridgeCoveragePct.toFixed(1) : null,
        fridge_qty:         fridgeQty,
        fridge_target:      +fridgeTarget.toFixed(1),
        fridge_target_achievement: fridgeTargetAch !== null ? +fridgeTargetAch.toFixed(1) : null,
        customers_mtd:     custMtd,
        new_customers_mtd: newCustMtd,
        customers_prev:    custPrev,
        customer_target:   custTarget,
        customer_gap:     custTarget > 0 ? custTarget - custMtd : null,
        customer_achievement: custAch !== null ? +custAch.toFixed(1) : null,
        credit_limit:     creditLimit,
        max_allowed_debt: creditLimit > 0 ? +maxAllowedDebt.toFixed(2) : null,
        outstanding_balance: balance,
        credit_gap:       creditLimit > 0 ? creditLimit - balance : null,
        debt_pct:         debtPct !== null ? +debtPct.toFixed(1) : null,
        debt_exceeded:    debtExceeded,
        debt_excess_pct:  debtExcessInfo(debtPct)?.excess_pct ?? null,
        limit_achievement: limitAch !== null ? +limitAch.toFixed(1) : null,
        collection_target_pct: collTargetPct,
        collection_target: +collTarget.toFixed(2),
        collected:        +collected.toFixed(2),
        coll_achievement:  collAch !== null ? +collAch.toFixed(1) : null,
        weighted_achievement: weightedAch !== null ? +weightedAch.toFixed(1) : null,
        category_breakdown: categoryBreakdown,
        item_qty_breakdown: itemQtyBreakdown,
      };

      const regionName = rep.region_name || 'غير محدد';
      if (!regionMap[regionName]) {
        regionMap[regionName] = {
          region_name:    regionName,
          region_id:      rep.region_id,
          reps:           [],
        };
      }
      regionMap[regionName].reps.push(repRow);
    });

    // Aggregate region totals
    const regions = Object.values(regionMap).map(region => {
      const r = region.reps;
      const totalQty      = r.reduce((s,x) => s + x.qty_mtd,   0);
      const totalQtyPositive = r.reduce((s,x) => s + x.qty_positive, 0);
      const totalQtyPrev  = r.reduce((s,x) => s + x.qty_prev,  0);
      const totalQtyTgt   = r.reduce((s,x) => s + x.qty_target, 0);
      const totalDamage   = r.reduce((s,x) => s + x.damage_qty, 0);
      const totalCust     = r.reduce((s,x) => s + x.customers_mtd, 0);
      const totalNewCust  = r.reduce((s,x) => s + (x.new_customers_mtd || 0), 0);
      const totalCustPrev = r.reduce((s,x) => s + x.customers_prev, 0);
      const totalCustTgt  = r.reduce((s,x) => s + x.customer_target, 0);
      const totalBalance  = r.reduce((s,x) => s + x.outstanding_balance, 0);
      const totalLimit    = r.reduce((s,x) => s + x.credit_limit, 0);
      const totalCollected = r.reduce((s,x) => s + x.collected, 0);
      const totalCollTgt  = r.reduce((s,x) => s + x.collection_target, 0);
      const qtyGrowth  = totalQtyPrev > 0 ? ((totalQty - totalQtyPrev) / totalQtyPrev * 100) : null;
      const qtyAch     = totalQtyTgt  > 0 ? (totalQty / totalQtyTgt  * 100) : null;
      const custAch    = totalCustTgt > 0 ? (totalCust / totalCustTgt * 100) : null;
      const debtPct    = totalLimit > 0   ? (totalBalance / totalLimit * 100) : null;
      const totalMaxAllowed = totalLimit * 1.10;
      const limitAch   = totalLimit > 0
        ? (totalBalance <= totalMaxAllowed
            ? 100
            : Math.max(0, (2 * totalLimit - totalBalance) / (2 * totalLimit - totalMaxAllowed) * 100))
        : null;
      const collAch    = totalCollTgt > 0 ? (totalCollected / totalCollTgt * 100) : null;
      const repsExceeded = r.filter(x => x.debt_exceeded).length;
      const damagePct  = totalQtyPositive > 0 ? (totalDamage / totalQtyPositive * 100) : null;
      const damageExceeded = damagePct !== null && damagePct > DAMAGE_TARGET_PCT;
      const repsDamageExceeded = r.filter(x => x.damage_exceeded).length;

      const totalFridges       = r.reduce((s,x) => s + x.fridges_total,   0);
      const totalFridgesCovered = r.reduce((s,x) => s + x.fridges_covered, 0);
      const totalFridgeQty     = r.reduce((s,x) => s + x.fridge_qty,      0);
      const totalFridgeTarget  = r.reduce((s,x) => s + x.fridge_target,   0);
      const fridgeCoveragePct = totalFridges > 0 ? (totalFridgesCovered / totalFridges * 100) : null;
      const fridgeTargetAch   = totalFridgeTarget > 0 ? (totalFridgeQty / totalFridgeTarget * 100) : null;

      // Region-level category breakdown = sum of each rep's per-category
      // qty/target across the region. target_pct is DERIVED from the
      // summed target ÷ the region's total qty_target — not copied from
      // whichever rep's row happened to be seen first — so the displayed
      // % always matches the displayed target amount even when reps have
      // different per-rep/region category-split overrides (a straight
      // copy would show one rep's % next to the whole region's sum,
      // which don't correspond to each other).
      const catAgg = {};
      r.forEach(rep => {
        (rep.category_breakdown || []).forEach(c => {
          if (!catAgg[c.category]) catAgg[c.category] = { category: c.category, qty: 0, target: 0 };
          catAgg[c.category].qty    += c.qty;
          catAgg[c.category].target += c.target;
        });
      });
      const categoryBreakdown = Object.values(catAgg).map(c => ({
        ...c,
        target: +c.target.toFixed(1),
        target_pct: totalQtyTgt > 0 ? +((c.target / totalQtyTgt) * 100).toFixed(1) : 0,
        achievement: c.target > 0 ? +((c.qty / c.target) * 100).toFixed(1) : null,
      })).sort((a, b) => b.qty - a.qty);

      // Same category-penalty rule as rep rows, applied to the region's
      // aggregated category breakdown.
      const catPenalty  = computeCategoryPenalty(categoryBreakdown, totalQtyTgt);
      const qtyAchFinal = catPenalty ? catPenalty.penalized_pct : qtyAch;
      const qtyPenaltyPct = catPenalty ? +(qtyAch - catPenalty.penalized_pct).toFixed(1) : 0;

      // الأداء المرجح = same weighted commission formula as rep rows.
      const weightedAch = computeCommissionPct(
        { qtyAch: qtyAchFinal, custAch, debtPct, damagePct, fridgeCoveragePct, fridgeTargetAch },
        commissionWeights
      ).total_pct;

      // Region-level item-category qty breakdown — same fixed 3-category
      // + "أخرى" bucketing as the rep rows, summed across the region's reps.
      const itemCatAgg = {};
      r.forEach(rep => {
        (rep.item_qty_breakdown || []).forEach(c => {
          if (!itemCatAgg[c.category]) itemCatAgg[c.category] = { category: c.category, qty: 0, target: 0 };
          itemCatAgg[c.category].qty    += c.qty;
          itemCatAgg[c.category].target += c.target || 0;
        });
      });
      const itemQtyBreakdown = Object.values(itemCatAgg)
        .map(c => ({ ...c, achievement: c.target > 0 ? +((c.qty / c.target) * 100).toFixed(1) : null }))
        .filter(c => c.qty !== 0 || c.target > 0) // net qty can be negative — see rep-level comment
        .sort((a, b) => b.qty - a.qty);

      return {
        ...region,
        qty_mtd:              totalQty,
        qty_positive:         totalQtyPositive,
        qty_prev:             totalQtyPrev,
        qty_target:           totalQtyTgt,
        damage_qty:           totalDamage,
        damage_pct:           damagePct !== null ? +damagePct.toFixed(2) : null,
        damage_exceeded:      damageExceeded,
        reps_damage_exceeded: repsDamageExceeded,
        fridges_total:        totalFridges,
        fridges_covered:      totalFridgesCovered,
        fridge_coverage_pct:  fridgeCoveragePct !== null ? +fridgeCoveragePct.toFixed(1) : null,
        fridge_qty:           totalFridgeQty,
        fridge_target:        +totalFridgeTarget.toFixed(1),
        fridge_target_achievement: fridgeTargetAch !== null ? +fridgeTargetAch.toFixed(1) : null,
        qty_growth:           qtyGrowth  !== null ? +qtyGrowth.toFixed(1)  : null,
        qty_achievement:      qtyAchFinal !== null ? +qtyAchFinal.toFixed(1) : null,
        qty_achievement_raw:  qtyAch      !== null ? +qtyAch.toFixed(1)      : null,
        qty_penalty_pct:      qtyPenaltyPct,
        qty_penalty_reasons:  catPenalty ? catPenalty.shortfalls : [],
        customers_mtd:        totalCust,
        new_customers_mtd:    totalNewCust,
        customers_prev:       totalCustPrev,
        customer_target:      totalCustTgt,
        customer_gap:         totalCustTgt > 0 ? totalCustTgt - totalCust : null,
        customer_achievement: custAch    !== null ? +custAch.toFixed(1)    : null,
        credit_limit:         totalLimit,
        max_allowed_debt:     totalLimit > 0 ? +totalMaxAllowed.toFixed(2) : null,
        outstanding_balance:  +totalBalance.toFixed(2),
        credit_gap:           totalLimit > 0 ? totalLimit - totalBalance : null,
        debt_pct:             debtPct    !== null ? +debtPct.toFixed(1)    : null,
        debt_exceeded:        totalLimit > 0 && totalBalance > totalMaxAllowed,
        debt_excess_pct:      debtExcessInfo(debtPct)?.excess_pct ?? null,
        reps_exceeded_limit:  repsExceeded,
        limit_achievement:    limitAch   !== null ? +limitAch.toFixed(1)   : null,
        collection_target:    totalCollTgt,
        collected:            +totalCollected.toFixed(2),
        coll_achievement:     collAch    !== null ? +collAch.toFixed(1)    : null,
        weighted_achievement: weightedAch !== null ? +weightedAch.toFixed(1) : null,
        reps_count:           r.length,
        category_breakdown:   categoryBreakdown,
        item_qty_breakdown:   itemQtyBreakdown,
      };
    }).sort((a,b) => (b.qty_mtd || 0) - (a.qty_mtd || 0));

    /* ── 8. Overall KPIs ─────────────────────────────────────── */
    const kpi = {
      total_qty_mtd:        regions.reduce((s,r) => s + r.qty_mtd,  0),
      total_qty_positive:   regions.reduce((s,r) => s + r.qty_positive, 0),
      total_qty_prev:       regions.reduce((s,r) => s + r.qty_prev, 0),
      total_qty_target:     regions.reduce((s,r) => s + r.qty_target, 0),
      total_damage_qty:     regions.reduce((s,r) => s + r.damage_qty, 0),
      total_customers:      globalDistinctCustomers,
      total_new_customers:  globalDistinctNewCustomers,
      total_customers_prev: regions.reduce((s,r) => s + r.customers_prev, 0),
      total_customer_target: regions.reduce((s,r) => s + r.customer_target, 0),
      total_balance:        +regions.reduce((s,r) => s + r.outstanding_balance, 0).toFixed(2),
      total_credit_limit:   regions.reduce((s,r) => s + r.credit_limit, 0),
      total_collected:      +regions.reduce((s,r) => s + r.collected, 0).toFixed(2),
      total_collection_target: regions.reduce((s,r) => s + r.collection_target, 0),
      regions_count:        regions.length,
      reps_count:           reps.length,
    };
    // Company-wide item-category qty breakdown = sum of every region's
    // breakdown, same fixed 3-category + "أخرى" bucketing as rep/region rows.
    const kpiItemCatAgg = {};
    regions.forEach(region => {
      (region.item_qty_breakdown || []).forEach(c => {
        if (!kpiItemCatAgg[c.category]) kpiItemCatAgg[c.category] = { category: c.category, qty: 0, target: 0 };
        kpiItemCatAgg[c.category].qty    += c.qty;
        kpiItemCatAgg[c.category].target += c.target || 0;
      });
    });
    kpi.item_qty_breakdown = Object.values(kpiItemCatAgg)
      .map(c => ({ ...c, achievement: c.target > 0 ? +((c.qty / c.target) * 100).toFixed(1) : null }))
      .filter(c => c.qty !== 0 || c.target > 0) // net qty can be negative — see rep-level comment
      .sort((a, b) => b.qty - a.qty);

    const totalTgt = kpi.total_qty_target;
    kpi.overall_qty_achievement = totalTgt > 0 ? +((kpi.total_qty_mtd / totalTgt) * 100).toFixed(1) : null;
    const totalCollTgt = kpi.total_collection_target;
    kpi.overall_coll_achievement = totalCollTgt > 0 ? +((kpi.total_collected / totalCollTgt) * 100).toFixed(1) : null;
    kpi.qty_growth = kpi.total_qty_prev > 0
      ? +((kpi.total_qty_mtd - kpi.total_qty_prev) / kpi.total_qty_prev * 100).toFixed(1)
      : null;
    kpi.reps_exceeded_limit = regions.reduce((s, r) => s + (r.reps_exceeded_limit || 0), 0);
    kpi.overall_debt_pct = kpi.total_credit_limit > 0
      ? +((kpi.total_balance / kpi.total_credit_limit) * 100).toFixed(1)
      : null;
    kpi.debt_excess_pct = debtExcessInfo(kpi.overall_debt_pct)?.excess_pct ?? null;
    kpi.overall_damage_pct = kpi.total_qty_positive > 0
      ? +((kpi.total_damage_qty / kpi.total_qty_positive) * 100).toFixed(2)
      : null;
    kpi.damage_target_pct = DAMAGE_TARGET_PCT;
    kpi.reps_damage_exceeded = regions.reduce((s, r) => s + (r.reps_damage_exceeded || 0), 0);

    kpi.total_fridges       = regions.reduce((s, r) => s + (r.fridges_total || 0), 0);
    kpi.total_fridges_covered = regions.reduce((s, r) => s + (r.fridges_covered || 0), 0);
    kpi.overall_fridge_coverage_pct = kpi.total_fridges > 0
      ? +((kpi.total_fridges_covered / kpi.total_fridges) * 100).toFixed(1)
      : null;
    kpi.total_fridge_qty    = regions.reduce((s, r) => s + (r.fridge_qty || 0), 0);
    kpi.total_fridge_target = +regions.reduce((s, r) => s + (r.fridge_target || 0), 0).toFixed(1);
    kpi.overall_fridge_target_achievement = kpi.total_fridge_target > 0
      ? +((kpi.total_fridge_qty / kpi.total_fridge_target) * 100).toFixed(1)
      : null;
    kpi.overall_customer_achievement = kpi.total_customer_target > 0
      ? +((kpi.total_customers / kpi.total_customer_target) * 100).toFixed(1)
      : null;

    // Company-wide category breakdown = sum across all regions.
    // target_pct derived the same way as the region-level fix above.
    const kpiCatAgg = {};
    regions.forEach(region => {
      (region.category_breakdown || []).forEach(c => {
        if (!kpiCatAgg[c.category]) kpiCatAgg[c.category] = { category: c.category, qty: 0, target: 0 };
        kpiCatAgg[c.category].qty    += c.qty;
        kpiCatAgg[c.category].target += c.target;
      });
    });
    const categoryBreakdown = Object.values(kpiCatAgg).map(c => ({
      ...c,
      target: +c.target.toFixed(1),
      target_pct: kpi.total_qty_target > 0 ? +((c.target / kpi.total_qty_target) * 100).toFixed(1) : 0,
      achievement: c.target > 0 ? +((c.qty / c.target) * 100).toFixed(1) : null,
    })).sort((a, b) => b.qty - a.qty);

    // Same category-penalty rule as rep/region rows, applied company-wide.
    const kpiCatPenalty = computeCategoryPenalty(categoryBreakdown, kpi.total_qty_target);
    kpi.overall_qty_achievement_raw = kpi.overall_qty_achievement;
    kpi.overall_qty_achievement = kpiCatPenalty ? kpiCatPenalty.penalized_pct : kpi.overall_qty_achievement;
    kpi.qty_penalty_pct = kpiCatPenalty
      ? +((kpi.overall_qty_achievement_raw ?? 0) - kpiCatPenalty.penalized_pct).toFixed(1)
      : 0;
    kpi.qty_penalty_reasons = kpiCatPenalty ? kpiCatPenalty.shortfalls : [];

    kpi.weighted_achievement = computeCommissionPct({
      qtyAch:  kpi.overall_qty_achievement,
      custAch: kpi.overall_customer_achievement,
      debtPct: kpi.overall_debt_pct,
      damagePct: kpi.overall_damage_pct,
      fridgeCoveragePct: kpi.overall_fridge_coverage_pct,
      fridgeTargetAch:   kpi.overall_fridge_target_achievement,
    }, commissionWeights).total_pct;

    res.json({
      year,
      month,
      monthName: MONTH_NAMES_AR[month],
      kpi,
      regions,
      category_breakdown: categoryBreakdown,
    });
  } catch (err) {
    console.error('Performance dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
