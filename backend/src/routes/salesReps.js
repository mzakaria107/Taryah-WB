const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const XLSX     = require('xlsx');
const pool     = require('../db/pool');
const { verifyToken, requireRoles } = require('../middleware/auth');

const ADMIN = ['super_admin', 'it_admin'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/* ── Helper ──────────────────────────────────────────────────── */
const ROLE_LABELS = {
  supervisor:      'مشرف',
  region_manager:  'مدير منطقة',
  sector_manager:  'مدير قطاع',
  sales_manager:   'مدير المبيعات',
};

/* ════════════════════════════════════════════════════════════════
   MANAGERS
════════════════════════════════════════════════════════════════ */

// GET /api/sales-reps/managers
router.get('/managers', verifyToken, async (req, res) => {
  try {
    const { role } = req.query;
    let sql = `
      SELECT m.*, r.name_ar AS region_name
      FROM rep_managers m
      LEFT JOIN regions r ON r.id = m.region_id
    `;
    const params = [];
    if (role) { sql += ` WHERE m.role = $1`; params.push(role); }
    sql += ` ORDER BY m.role, m.name_ar`;
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET managers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sales-reps/managers
router.post('/managers', verifyToken, requireRoles(...ADMIN), async (req, res) => {
  const { name_ar, name_en, role, region_id } = req.body;
  if (!name_ar || !role) return res.status(400).json({ error: 'الاسم والدور مطلوبان' });
  if (!ROLE_LABELS[role]) return res.status(400).json({ error: 'دور غير صالح' });
  try {
    const r = await pool.query(
      `INSERT INTO rep_managers (name_ar, name_en, role, region_id)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name_ar, name_en || null, role, region_id || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sales-reps/managers/:id
router.put('/managers/:id', verifyToken, requireRoles(...ADMIN), async (req, res) => {
  const { name_ar, name_en, role, region_id, is_active } = req.body;
  try {
    const r = await pool.query(
      `UPDATE rep_managers SET name_ar=$1, name_en=$2, role=$3, region_id=$4, is_active=$5
       WHERE id=$6 RETURNING *`,
      [name_ar, name_en || null, role, region_id || null, is_active ?? true, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'غير موجود' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sales-reps/managers/:id
router.delete('/managers/:id', verifyToken, requireRoles(...ADMIN), async (req, res) => {
  try {
    await pool.query(`DELETE FROM rep_managers WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   REPS
════════════════════════════════════════════════════════════════ */

// GET /api/sales-reps
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        sr.*,
        reg.name_ar AS region_name,
        sup.name_ar  AS supervisor_name,
        rm.name_ar   AS region_manager_name,
        sm.name_ar   AS sector_manager_name,
        smgr.name_ar AS sales_manager_name,
        sug.route_id AS suggested_route_id
      FROM sales_reps sr
      LEFT JOIN regions      reg  ON reg.id  = sr.region_id
      LEFT JOIN rep_managers sup  ON sup.id  = sr.supervisor_id
      LEFT JOIN rep_managers rm   ON rm.id   = sr.region_manager_id
      LEFT JOIN rep_managers sm   ON sm.id   = sr.sector_manager_id
      LEFT JOIN rep_managers smgr ON smgr.id = sr.sales_manager_id
      LEFT JOIN LATERAL (
        SELECT i.route_id, COUNT(*) AS cnt
        FROM invoices i
        WHERE i.sales_rep_name = sr.netsuite_name AND i.route_id IS NOT NULL
        GROUP BY i.route_id
        ORDER BY cnt DESC
        LIMIT 1
      ) sug ON sr.netsuite_name IS NOT NULL
      ORDER BY reg.name_ar, sr.name_ar
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sales-reps/routes — distinct route numbers seen on invoices,
// same convention as invoices.js /meta, for the rep-edit "خط السير" select.
router.get('/routes', verifyToken, async (req, res) => {
  try {
    // routes table (RouteMaster upload) UNION invoice-derived ids — a
    // freshly uploaded route (e.g. a new region's) must be assignable to
    // a rep BEFORE its first invoice exists; invoices alone hid those.
    const r = await pool.query(
      `SELECT route_id FROM routes WHERE route_id IS NOT NULL
       UNION
       SELECT DISTINCT route_id FROM invoices WHERE route_id IS NOT NULL
       ORDER BY route_id`
    );
    res.json(r.rows.map(x => x.route_id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sales-reps/auto-link-routes — bulk-fill route_id for every rep
// from their most common invoices.route_id (matched via netsuite_name).
// By default only fills reps with route_id IS NULL; pass { force: true }
// to overwrite existing manual assignments too.
router.post('/auto-link-routes', verifyToken, requireRoles(...ADMIN), async (req, res) => {
  const force = req.body?.force === true;
  try {
    const r = await pool.query(`
      WITH counts AS (
        SELECT sales_rep_name, route_id, COUNT(*) AS cnt
        FROM invoices
        WHERE route_id IS NOT NULL AND sales_rep_name IS NOT NULL
        GROUP BY sales_rep_name, route_id
      ),
      best AS (
        SELECT DISTINCT ON (sales_rep_name) sales_rep_name, route_id
        FROM counts
        ORDER BY sales_rep_name, cnt DESC
      )
      UPDATE sales_reps sr
      SET route_id = best.route_id
      FROM best
      WHERE sr.netsuite_name = best.sales_rep_name
        AND (${force ? 'TRUE' : 'sr.route_id IS NULL'})
      RETURNING sr.id, sr.name_ar, sr.route_id
    `);
    res.json({ linked: r.rows.length, reps: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sales-reps
router.post('/', verifyToken, requireRoles(...ADMIN), async (req, res) => {
  const { name_ar, name_en, netsuite_name, region_id, route_id, vehicle_number,
          supervisor_id, region_manager_id, sector_manager_id, sales_manager_id } = req.body;
  if (!name_ar) return res.status(400).json({ error: 'اسم المندوب مطلوب' });
  try {
    const r = await pool.query(
      `INSERT INTO sales_reps
         (name_ar, name_en, netsuite_name, region_id, route_id, vehicle_number,
          supervisor_id, region_manager_id, sector_manager_id, sales_manager_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name_ar, name_en||null, netsuite_name||null, region_id||null, route_id||null, vehicle_number?.trim() || null,
       supervisor_id||null, region_manager_id||null, sector_manager_id||null, sales_manager_id||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   TARGETS  (must be before /:id to avoid route conflict)
════════════════════════════════════════════════════════════════ */

// GET /api/sales-reps/targets?year=&month=
router.get('/targets', verifyToken, async (req, res) => {
  const { year, month } = req.query;
  try {
    let sql = `
      SELECT t.*, sr.name_ar AS rep_name, sr.netsuite_name,
             reg.name_ar AS region_name
      FROM sales_rep_targets t
      JOIN sales_reps sr ON sr.id = t.rep_id
      LEFT JOIN regions reg ON reg.id = sr.region_id
    `;
    const params = [];
    const conds  = [];
    if (year)  { conds.push(`t.year  = $${params.length+1}`); params.push(Number(year)); }
    if (month) { conds.push(`t.month = $${params.length+1}`); params.push(Number(month)); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY reg.name_ar, sr.name_ar';
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sales-reps/targets/suggested?year=&month=
// "هدف استرشادي" — a suggested per-category qty target for each rep,
// based on their CURRENT route's historical average (not the rep's own
// history), so a rep newly assigned to a route gets a sensible starting
// point based on what that route has actually sold. Averaged over the 4
// months preceding the given period; months where the route had zero
// activity across every category (inactive) are excluded from the
// average — a category-specific zero in an otherwise-active month still
// counts as a real 0 for that category's average.
const ITEM_CATEGORIES_SUGGESTED = ['دجاج مبرد طرية', 'مقطعات طرية', 'دجاج مجمد'];
const SUGGESTED_FIELD_BY_CATEGORY = {
  'دجاج مبرد طرية': 'qty_target_chilled_suggested',
  'مقطعات طرية':    'qty_target_cuts_suggested',
  'دجاج مجمد':      'qty_target_frozen_suggested',
};
router.get('/targets/suggested', verifyToken, async (req, res) => {
  const year  = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'سنة/شهر غير صحيح' });
  }
  try {
    const repsRes = await pool.query(
      `SELECT id, route_id FROM sales_reps WHERE is_active AND route_id IS NOT NULL`
    );
    const routeIds = [...new Set(repsRes.rows.map(r => r.route_id))];
    if (!routeIds.length) return res.json({});

    // Last 4 (year, month) pairs preceding the target period.
    const months = [];
    let y = year, m = month;
    for (let i = 0; i < 4; i++) {
      m -= 1;
      if (m < 1) { m = 12; y -= 1; }
      months.push({ y, m });
    }

    const monthCond = months.map((_, i) => `(sa.report_year=$${i*2+2} AND sa.month_num=$${i*2+3})`).join(' OR ');
    const monthParams = months.flatMap(({ y, m }) => [y, m]);
    const { rows } = await pool.query(
      `SELECT i.route_id, sa.report_year AS yr, sa.month_num AS mo,
              COALESCE(NULLIF(TRIM(sa.item_category_en), ''), 'أخرى') AS category,
              SUM(CASE WHEN sa.qty > 0 THEN sa.qty ELSE 0 END) AS qty
       FROM sales_activity sa
       JOIN invoices i ON i.invoice_number = sa.invoice_number
       WHERE i.route_id = ANY($1::int[])
         AND (${monthCond})
       GROUP BY i.route_id, sa.report_year, sa.month_num, category`,
      [routeIds, ...monthParams]
    );

    // routeMonthCat[route][ "yr-mo" ][category] = qty ; routeMonthTotal[route][ "yr-mo" ] = sum
    const routeMonthCat   = {};
    const routeMonthTotal = {};
    rows.forEach(r => {
      const key = `${r.yr}-${r.mo}`;
      const qty = parseInt(r.qty || 0);
      if (!routeMonthCat[r.route_id]) routeMonthCat[r.route_id] = {};
      if (!routeMonthCat[r.route_id][key]) routeMonthCat[r.route_id][key] = {};
      routeMonthCat[r.route_id][key][r.category] = qty;
      routeMonthTotal[r.route_id] = routeMonthTotal[r.route_id] || {};
      routeMonthTotal[r.route_id][key] = (routeMonthTotal[r.route_id][key] || 0) + qty;
    });

    const monthKeys = months.map(({ y, m }) => `${y}-${m}`);
    const suggestedByRoute = {};
    routeIds.forEach(routeId => {
      const totalsByMonth = routeMonthTotal[routeId] || {};
      const activeMonths = monthKeys.filter(k => (totalsByMonth[k] || 0) > 0);
      const catByMonth = routeMonthCat[routeId] || {};
      const out = { active_months_count: activeMonths.length };
      ITEM_CATEGORIES_SUGGESTED.forEach(cat => {
        const field = SUGGESTED_FIELD_BY_CATEGORY[cat];
        if (!activeMonths.length) { out[field] = null; return; }
        const sum = activeMonths.reduce((s, k) => s + ((catByMonth[k] || {})[cat] || 0), 0);
        out[field] = Math.round(sum / activeMonths.length);
      });
      suggestedByRoute[routeId] = out;
    });

    const result = {};
    repsRes.rows.forEach(rep => {
      if (suggestedByRoute[rep.route_id]) result[rep.id] = suggestedByRoute[rep.route_id];
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sales-reps/targets  (upsert one or many)
router.put('/targets', verifyToken, requireRoles(...ADMIN), async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [req.body];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const { rep_id, year, month, customer_target, collection_target_pct, credit_limit } = row;
      const qtyChilled = Number(row.qty_target_chilled || 0);
      const qtyCuts     = Number(row.qty_target_cuts    || 0);
      const qtyFrozen   = Number(row.qty_target_frozen  || 0);
      const qtyTotal    = qtyChilled + qtyCuts + qtyFrozen;
      if (!rep_id || !year || !month) continue;
      const pct = Math.min(100, Math.max(0, Number(collection_target_pct || 0)));
      await client.query(
        `INSERT INTO sales_rep_targets
           (rep_id, year, month, qty_target, qty_target_chilled, qty_target_cuts, qty_target_frozen,
            customer_target, collection_target_pct, credit_limit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (rep_id, year, month) DO UPDATE SET
           qty_target            = EXCLUDED.qty_target,
           qty_target_chilled    = EXCLUDED.qty_target_chilled,
           qty_target_cuts       = EXCLUDED.qty_target_cuts,
           qty_target_frozen     = EXCLUDED.qty_target_frozen,
           customer_target       = EXCLUDED.customer_target,
           collection_target_pct = EXCLUDED.collection_target_pct,
           credit_limit          = EXCLUDED.credit_limit`,
        [rep_id, year, month, qtyTotal, qtyChilled, qtyCuts, qtyFrozen, customer_target||0, pct, credit_limit||0]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, saved: rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/sales-reps/targets/upload  (Excel bulk import)
router.post('/targets/upload', verifyToken, requireRoles(...ADMIN), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });
  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const repRes   = await pool.query(`SELECT id, name_ar, netsuite_name FROM sales_reps WHERE is_active`);
    const repByName = {};
    repRes.rows.forEach(r => {
      if (r.name_ar)       repByName[r.name_ar.trim()]       = r.id;
      if (r.netsuite_name) repByName[r.netsuite_name.trim()] = r.id;
    });

    const toSave = [];
    const errors = [];
    rows.forEach((row, i) => {
      const repName = String(row['اسم المندوب'] || row['rep_name'] || '').trim();
      const repId   = repByName[repName];
      if (!repId) { errors.push(`صف ${i+2}: مندوب غير موجود "${repName}"`); return; }
      const year  = Number(row['السنة']  || row['year']  || 0);
      const month = Number(row['الشهر']  || row['month'] || 0);
      if (!year || !month || month < 1 || month > 12) {
        errors.push(`صف ${i+2}: سنة/شهر غير صحيح`);
        return;
      }
      const rawPct = Number(row['هدف التحصيل (%)'] || row['هدف التحصيل'] || row['collection_target_pct'] || 0);
      const qtyChilled = Number(row['هدف الكمية - دجاج مبرد طرية'] || row['qty_target_chilled'] || 0);
      const qtyCuts     = Number(row['هدف الكمية - مقطعات طرية']    || row['qty_target_cuts']    || 0);
      const qtyFrozen   = Number(row['هدف الكمية - دجاج مجمد']      || row['qty_target_frozen']  || 0);
      toSave.push({
        rep_id:                repId,
        year,
        month,
        qty_target_chilled:    qtyChilled,
        qty_target_cuts:       qtyCuts,
        qty_target_frozen:     qtyFrozen,
        qty_target:            qtyChilled + qtyCuts + qtyFrozen,
        customer_target:       Number(row['هدف العملاء']    || row['customer_target']      || 0),
        collection_target_pct: Math.min(100, Math.max(0, rawPct)),
        credit_limit:          Number(row['الحد الائتماني'] || row['credit_limit']         || 0),
      });
    });

    const pgClient = await pool.connect();
    try {
      await pgClient.query('BEGIN');
      for (const row of toSave) {
        await pgClient.query(
          `INSERT INTO sales_rep_targets
             (rep_id, year, month, qty_target, qty_target_chilled, qty_target_cuts, qty_target_frozen,
              customer_target, collection_target_pct, credit_limit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (rep_id, year, month) DO UPDATE SET
             qty_target=$4, qty_target_chilled=$5, qty_target_cuts=$6, qty_target_frozen=$7,
             customer_target=$8, collection_target_pct=$9, credit_limit=$10`,
          [row.rep_id, row.year, row.month, row.qty_target, row.qty_target_chilled, row.qty_target_cuts,
           row.qty_target_frozen, row.customer_target, row.collection_target_pct, row.credit_limit]
        );
      }
      await pgClient.query('COMMIT');
      res.json({ ok: true, saved: toSave.length, errors });
    } catch (err) {
      await pgClient.query('ROLLBACK');
      throw err;
    } finally {
      pgClient.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── NetSuite names (autocomplete) ──────────────────────────── */
router.get('/netsuite-names', verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT salesrep_name AS name
       FROM sales_activity
       WHERE salesrep_name IS NOT NULL AND salesrep_name <> ''
       ORDER BY salesrep_name`
    );
    res.json(r.rows.map(x => x.name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Unmatched rep names (data-quality check) ────────────────
   salesrep_names appearing in sales_activity for the given month
   that have NO matching netsuite_name in sales_reps. These reps'
   customers/qty are missing from the performance dashboard.     */
router.get('/unmatched-names', verifyToken, async (req, res) => {
  const now   = new Date();
  const year  = Number(req.query.year  || now.getFullYear());
  const month = Number(req.query.month || (now.getMonth() + 1));
  try {
    const r = await pool.query(
      `SELECT
         TRIM(sa.salesrep_name)                    AS salesrep_name,
         COUNT(DISTINCT sa.customer_code)::int     AS customers,
         COALESCE(SUM(sa.qty), 0)::bigint          AS total_qty
       FROM sales_activity sa
       WHERE sa.report_year = $1 AND sa.month_num = $2
         AND sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) <> ''
         AND LOWER(TRIM(sa.salesrep_name)) <> 'direct'
         AND NOT EXISTS (
           SELECT 1 FROM sales_reps sr
           WHERE sr.is_active
             AND TRIM(sr.netsuite_name) = TRIM(sa.salesrep_name)
         )
       GROUP BY TRIM(sa.salesrep_name)
       ORDER BY total_qty DESC`,
      [year, month]
    );
    res.json({ year, month, unmatched: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sales-reps/:id  (must stay AFTER all specific routes)
router.put('/:id', verifyToken, requireRoles(...ADMIN), async (req, res) => {
  const { name_ar, name_en, netsuite_name, region_id, route_id, vehicle_number,
          supervisor_id, region_manager_id, sector_manager_id, sales_manager_id, is_active } = req.body;
  try {
    const r = await pool.query(
      `UPDATE sales_reps SET
         name_ar=$1, name_en=$2, netsuite_name=$3, region_id=$4, route_id=$5, vehicle_number=$6,
         supervisor_id=$7, region_manager_id=$8, sector_manager_id=$9, sales_manager_id=$10, is_active=$11
       WHERE id=$12 RETURNING *`,
      [name_ar, name_en||null, netsuite_name||null, region_id||null, route_id||null, vehicle_number?.trim() || null,
       supervisor_id||null, region_manager_id||null, sector_manager_id||null, sales_manager_id||null,
       is_active ?? true, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'غير موجود' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sales-reps/:id
router.delete('/:id', verifyToken, requireRoles(...ADMIN), async (req, res) => {
  try {
    await pool.query(`DELETE FROM sales_reps WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
