/* ════════════════════════════════════════════════════════════
   Fleet management (`/api/fleet`) — vehicle master, weekly odometer
   readings, per-vehicle maintenance schedule/history, and expenses.
   See 104_fleet_management.sql for the schema and the reasoning behind
   each table. Access is gated by the existing page_permissions system
   under pageKey 'fleet_management' — no new user_role, since product
   decision was ONE central fleet coordinator maintains everything
   rather than per-rep self-service.
════════════════════════════════════════════════════════════ */
const express = require('express');
const crypto  = require('crypto');
const multer  = require('multer');
const XLSX    = require('xlsx');
const pool    = require('../db/pool');
const { verifyToken, requirePagePermission, requireRoles } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Deleting a vehicle is irreversible (cascades its odometer/maintenance/
// expense history) — restricted to admins specifically, tighter than the
// page's normal edit level (2), which fleet_supervisor also holds and
// uses daily for adding/editing vehicles and logging odometer/maintenance/
// expenses. Same ADMIN_ROLES convention as settings.js/carrefourDamage.js.
const ADMIN_ROLES = ['super_admin', 'it_admin'];

const ASSIGNMENT_TYPES = ['rep', 'region_transport', 'farm_slaughterhouse', 'unassigned'];

// Keeps sales_reps.vehicle_number — the plate-number field Rep Management's
// own form edits, and that Quality Returns/reports read as "this rep's
// vehicle" (see qualityReturns.js) — in sync whenever a vehicle's rep-link
// changes here in Fleet. Fleet is the actively-maintained source now
// (categories, odometer, maintenance all live here), but Rep Management
// predates it and was never told about changes made on this side, so the
// two screens could silently disagree about which plate a rep drives.
// Called inside the SAME transaction as the vehicles write so the two
// tables can never end up committed out of sync with each other.
async function syncRepVehicleNumber(client, { oldRepId, oldPlate, newRepId, newPlate }) {
  if (oldRepId && oldRepId !== newRepId) {
    // This vehicle no longer belongs to that rep — clear their
    // vehicle_number, but only if it still holds exactly what THIS vehicle
    // last set it to (never clobber a value Rep Management set on its own
    // in the meantime for an unrelated reason).
    await client.query(
      `UPDATE sales_reps SET vehicle_number = NULL WHERE id = $1 AND vehicle_number = $2`,
      [oldRepId, oldPlate]
    );
  }
  if (newRepId) {
    await client.query(`UPDATE sales_reps SET vehicle_number = $1 WHERE id = $2`, [newPlate, newRepId]);
  }
}

/* Vehicle categories (تصنيفات السيارات) and expense line items (بنود
   المصروفات) used to be hardcoded arrays here. They are now admin-editable
   rows in fleet_vehicle_categories/fleet_expense_categories (108_fleet_
   category_settings.sql) — settings screens on the frontend add/edit them,
   same "add types from a settings tab" pattern as fleet_maintenance_types.
   `key` is what's actually stored in fleet_vehicles.category /
   fleet_expenses.category (a real FK now, not just an app-level .includes()
   check), so validity is enforced by the DB — invalid keys are caught as a
   23503 foreign-key violation in each route's catch block below, not with
   a separate .includes() lookup. */
async function loadVehicleCategories() {
  const r = await pool.query(
    'SELECT key, name_ar, is_active, sort_order FROM fleet_vehicle_categories ORDER BY sort_order, name_ar'
  );
  return r.rows;
}
async function loadCategoryLabels() {
  const labels = {};
  (await loadVehicleCategories()).forEach(c => { labels[c.key] = c.name_ar; });
  return labels;
}
async function loadExpenseCategories() {
  const r = await pool.query(
    'SELECT key, name_ar, is_active, sort_order FROM fleet_expense_categories ORDER BY sort_order, name_ar'
  );
  return r.rows;
}
async function loadExpenseCategoryLabels() {
  const labels = {};
  (await loadExpenseCategories()).forEach(c => { labels[c.key] = c.name_ar; });
  return labels;
}

/* Spare parts catalog (قطع غيار) — 109_fleet_spare_parts.sql, stock-tracked
   by 110/111_fleet_*.sql. Unlike the two catalogs above (a handful of
   rows, plain <select>), this one seeds ~250 rows, so it's addressed by a
   real integer id (not a slug key) and always needs client-side search to
   be usable — see FleetManagementPage.jsx's spare-parts pickers. Both a
   maintenance log row AND an expense row reference parts the SAME way now
   — a `parts_used` jsonb array of {part_id, qty} — but only the
   maintenance flow's parts always deduct stock; an expense row's parts
   each carry their OWN {unit_cost, deduct_stock} on top, since the admin
   chooses per-part whether it came from tracked inventory (cost pulled
   automatically, stock deducted) or was bought ad hoc for this expense
   (cost typed by hand, stock untouched) — see `validExpensePartsUsed`. */
async function loadSpareParts() {
  const r = await pool.query(`
    SELECT p.id, p.name_ar, p.is_active, p.sort_order, p.qty_on_hand,
           (SELECT s.unit_cost FROM fleet_part_supplies s
             WHERE s.part_id = p.id ORDER BY s.supply_date DESC, s.id DESC LIMIT 1) AS last_unit_cost
    FROM fleet_spare_parts p ORDER BY p.sort_order, p.name_ar
  `);
  return r.rows;
}
/* Sanitizes the client's [{part_id, qty}] payload (maintenance flow):
   drops non-existent part ids and non-positive quantities, collapses a
   part listed twice into one row (summed), never trusts it as-is.
   Insufficient qty_on_hand is NOT rejected here — see the migration's note
   on why stock can legitimately go negative; the caller surfaces that as a
   warning instead. */
async function validPartsUsed(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const byId = new Map();
  for (const row of list) {
    const partId = Number(row?.part_id);
    const qty = Number(row?.qty);
    if (!Number.isInteger(partId) || partId <= 0) continue;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    byId.set(partId, (byId.get(partId) || 0) + qty);
  }
  if (!byId.size) return [];
  const r = await pool.query('SELECT id FROM fleet_spare_parts WHERE id = ANY($1::int[])', [[...byId.keys()]]);
  const known = new Set(r.rows.map(row => row.id));
  return [...byId.entries()].filter(([id]) => known.has(id)).map(([part_id, qty]) => ({ part_id, qty }));
}
function resolvePartsUsed(partsUsed, allParts) {
  if (!Array.isArray(partsUsed) || !partsUsed.length) return [];
  const byId = new Map(allParts.map(p => [p.id, p.name_ar]));
  return partsUsed
    .map(row => ({ ...row, name_ar: byId.get(row.part_id) || null }))
    .filter(p => p.name_ar);
}
/* Sanitizes the client's [{part_id, qty, unit_cost, deduct_stock}] payload
   (expense flow). A row with deduct_stock=true NEVER trusts the client's
   unit_cost — it's overwritten here with that part's CURRENT last supply
   price, both so a stale price shown in an already-open form can't be
   submitted, and so the cost genuinely reflects what inventory says this
   part cost. A row with deduct_stock=false keeps the client's own
   hand-typed unit_cost (clamped to >= 0) — nothing to look up, it was
   bought outside inventory tracking for this one expense. */
async function validExpensePartsUsed(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const byId = new Map();
  for (const row of list) {
    const partId = Number(row?.part_id);
    const qty = Number(row?.qty);
    if (!Number.isInteger(partId) || partId <= 0) continue;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const deductStock = Boolean(row?.deduct_stock);
    const unitCost = Number(row?.unit_cost);
    byId.set(partId, {
      qty: (byId.get(partId)?.qty || 0) + qty,
      deduct_stock: deductStock,
      unit_cost: Number.isFinite(unitCost) && unitCost >= 0 ? unitCost : 0,
    });
  }
  if (!byId.size) return [];
  const parts = await pool.query(
    `SELECT p.id,
            (SELECT s.unit_cost FROM fleet_part_supplies s
              WHERE s.part_id = p.id ORDER BY s.supply_date DESC, s.id DESC LIMIT 1) AS last_unit_cost
     FROM fleet_spare_parts p WHERE p.id = ANY($1::int[])`,
    [[...byId.keys()]]
  );
  const lastCostById = new Map(parts.rows.map(r => [r.id, r.last_unit_cost != null ? Number(r.last_unit_cost) : 0]));
  return [...byId.entries()]
    .filter(([id]) => lastCostById.has(id))
    .map(([part_id, row]) => ({
      part_id, qty: row.qty, deduct_stock: row.deduct_stock,
      unit_cost: row.deduct_stock ? lastCostById.get(part_id) : row.unit_cost,
    }));
}

/* ── Report filter helpers (تقارير الأسطول) ──────────────────────
   `region_id`/`category` query params may repeat (Express folds repeats
   into an array; a single one stays a string) — same multi-select
   convention as /region-performance/period-compare's `branch` param.
   `buildScopeSql` appends the SQL fragment AND its bind values onto an
   existing params array (so callers control whether the scope filter is
   $1/$2 or comes after date bounds already in that array), always against
   the EFFECTIVE region (COALESCE(sr.region_id, v.region_id)) — a rep-linked
   vehicle's region always follows the rep's current one, same rule as
   every other fleet query in this file. Requires the query to alias the
   vehicle row `v` and LEFT JOIN sales_reps AS `sr`. */
function parseMulti(v) {
  if (v == null) return null;
  const arr = (Array.isArray(v) ? v : [v]).map(x => String(x).trim()).filter(Boolean);
  return arr.length ? arr : null;
}
function buildScopeSql(paramsArr, regionIds, categories) {
  let sql = '';
  if (regionIds && regionIds.length) {
    paramsArr.push(regionIds);
    sql += ` AND COALESCE(sr.region_id, v.region_id) = ANY($${paramsArr.length}::int[])`;
  }
  if (categories && categories.length) {
    paramsArr.push(categories);
    sql += ` AND v.category = ANY($${paramsArr.length}::varchar[])`;
  }
  return sql;
}

/* ════════════════════════════════════════════════════════════
   GET /api/fleet/vehicles
   List, with the odometer-staleness and maintenance-alert counts a
   fleet dashboard needs — computed per row via correlated subqueries
   rather than N+1 queries.
════════════════════════════════════════════════════════════ */
router.get('/vehicles', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  const { category, assignment_type, status, search, region_id } = req.query;
  const where = [];
  const params = [];
  if (category) { params.push(category); where.push(`v.category = $${params.length}`); }
  if (assignment_type) { params.push(assignment_type); where.push(`v.assignment_type = $${params.length}`); }
  if (status) { params.push(status); where.push(`v.status = $${params.length}`); }
  if (search) { params.push(`%${search}%`); where.push(`(v.plate_number ILIKE $${params.length} OR v.assignment_label ILIKE $${params.length} OR sr.name_ar ILIKE $${params.length})`); }
  // Filters on the EFFECTIVE region (rep's current region when rep-linked,
  // else the vehicle's own region_id) — see the SELECT below for why.
  if (region_id) { params.push(region_id); where.push(`COALESCE(sr.region_id, v.region_id) = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const r = await pool.query(
      `SELECT v.id, v.plate_number, v.category, v.assignment_type, v.assignment_label,
              v.assigned_rep_id, sr.name_ar AS assigned_rep_name, v.driver_name,
              v.make, v.model, v.model_year, v.status, v.notes,
              v.current_odometer_km, v.odometer_updated_at::text,
              (CURRENT_DATE - v.odometer_updated_at) AS days_since_odometer_update,
              -- Effective region: a rep-linked vehicle always follows that
              -- rep's CURRENT region (never a stale copy) — only vehicles
              -- with no rep use their own stored region_id.
              COALESCE(sr.region_id, v.region_id) AS region_id,
              COALESCE(rep_reg.name_ar, v_reg.name_ar) AS region_name,
              (SELECT COUNT(*)::int FROM fleet_maintenance_schedule ms
                 WHERE ms.vehicle_id = v.id
                   AND (v.current_odometer_km - ms.last_service_km) >= ms.interval_km
              ) AS overdue_maintenance_count
       FROM fleet_vehicles v
       LEFT JOIN sales_reps sr      ON sr.id = v.assigned_rep_id
       LEFT JOIN regions    rep_reg ON rep_reg.id = sr.region_id
       LEFT JOIN regions    v_reg   ON v_reg.id = v.region_id
       ${whereSql}
       ORDER BY v.plate_number`,
      params
    );
    res.json({ vehicles: r.rows, category_labels: await loadCategoryLabels() });
  } catch (err) {
    console.error('[Fleet] vehicles list:', err);
    res.status(500).json({ error: 'خطأ في جلب قائمة السيارات' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/fleet/regions — full, unrestricted region list for the
   region_id select on non-rep vehicles. Deliberately NOT reusing
   GET /api/users/regions: that endpoint runs applyRegionFilter, which
   would scope fleet_supervisor (not in the "all regions" role list) down
   to zero regions, since it has no region assignment of its own — this
   page always needs to see every region regardless of who's viewing it.
════════════════════════════════════════════════════════════ */
router.get('/regions', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name_ar FROM regions ORDER BY name_ar');
    res.json({ regions: r.rows });
  } catch (err) {
    console.error('[Fleet] regions list:', err);
    res.status(500).json({ error: 'خطأ في جلب قائمة المناطق' });
  }
});

/* ════════════════════════════════════════════════════════════
   POST /api/fleet/vehicles
   Adds a new vehicle to the fleet (transport/farm truck or a rep car
   not already seeded from sales_reps.vehicle_number) and seeds its
   maintenance schedule from every active maintenance type at that
   type's default interval — same "new row gets every active type"
   convention the seed migration used.
════════════════════════════════════════════════════════════ */
router.post('/vehicles', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const {
    plate_number, category, assignment_type, assigned_rep_id, assignment_label, driver_name,
    region_id, make, model, model_year, current_odometer_km,
  } = req.body || {};
  if (!plate_number || !String(plate_number).trim()) {
    return res.status(400).json({ error: 'رقم اللوحة مطلوب' });
  }
  if (assignment_type && !ASSIGNMENT_TYPES.includes(assignment_type)) {
    return res.status(400).json({ error: 'نوع تخصيص غير صالح' });
  }
  const finalAssignmentType = assignment_type || 'unassigned';
  // assigned_rep_id and driver_name are mutually exclusive — "who's
  // responsible for this vehicle" is either a registered rep (a real FK,
  // picked from the reps list) or a free-text driver name for
  // transport/farm trucks, never both.
  const isRepAssignment = finalAssignmentType === 'rep';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vr = await client.query(
      `INSERT INTO fleet_vehicles
         (plate_number, category, assignment_type, assigned_rep_id, assignment_label, driver_name,
          region_id, make, model, model_year, current_odometer_km, odometer_updated_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, CASE WHEN $11::numeric IS NOT NULL THEN CURRENT_DATE ELSE NULL END, $12)
       RETURNING id`,
      [
        String(plate_number).trim(), category || null, finalAssignmentType,
        isRepAssignment ? (assigned_rep_id || null) : null,
        assignment_label || null,
        isRepAssignment ? null : (driver_name || null),
        // region_id is only meaningful for non-rep vehicles — a rep-linked
        // vehicle's region always follows the rep's own (see the SELECTs),
        // so storing one here for a rep vehicle would just be dead data
        // that could misleadingly diverge from the rep's real region.
        isRepAssignment ? null : (region_id || null),
        make || null, model || null,
        model_year || null, current_odometer_km != null ? Number(current_odometer_km) : 0,
        req.user.id,
      ]
    );
    const vehicleId = vr.rows[0].id;

    // Baseline the new schedule at the vehicle's OWN starting odometer, not
    // 0 — a vehicle added with e.g. 50,000 km already on the clock must not
    // read as instantly overdue for every maintenance type the moment it's
    // created. "Last serviced" is genuinely unknown at creation, so only
    // last_service_km is seeded (last_service_date stays NULL); the first
    // real POST /maintenance for that type rolls both forward properly.
    await client.query(
      `INSERT INTO fleet_maintenance_schedule (vehicle_id, maintenance_type_id, interval_km, last_service_km)
       SELECT $1, t.id, t.default_interval_km, COALESCE($2::numeric, 0)
       FROM fleet_maintenance_types t WHERE t.is_active = TRUE`,
      [vehicleId, current_odometer_km != null ? Number(current_odometer_km) : 0]
    );

    if (isRepAssignment && assigned_rep_id) {
      await syncRepVehicleNumber(client, {
        oldRepId: null, oldPlate: null,
        newRepId: assigned_rep_id, newPlate: String(plate_number).trim(),
      });
    }

    await client.query('COMMIT');
    res.json({ ok: true, id: vehicleId });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'رقم اللوحة مسجّل بالفعل' });
    if (err.code === '23503' && err.constraint === 'fleet_vehicles_category_fkey') {
      return res.status(400).json({ error: 'تصنيف سيارة غير صالح' });
    }
    console.error('[Fleet] vehicle create:', err);
    res.status(500).json({ error: 'خطأ في إضافة السيارة' });
  } finally {
    client.release();
  }
});

/* ════════════════════════════════════════════════════════════
   PUT /api/fleet/vehicles/:id — edit vehicle master fields.

   Partial-update by design: only columns actually present as keys in
   req.body are touched. This matters a lot here because the vehicles
   LIST page fires small single-field PUTs (e.g. just { category } from
   the inline classification dropdown) — a naive "always set every
   column, defaulting to null when absent" UPDATE would silently wipe
   assigned_rep_id/driver_name/make/model on every such partial edit.
   That was a real bug: the rep link kept getting erased every time an
   admin classified a vehicle's category from the list. Never regress
   this — always check `'field' in req.body`, never `req.body.field`.
════════════════════════════════════════════════════════════ */
router.put('/vehicles/:id', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const body = req.body || {};
  if (body.assignment_type && !ASSIGNMENT_TYPES.includes(body.assignment_type)) return res.status(400).json({ error: 'نوع تخصيص غير صالح' });

  const sets = [];
  const values = [];
  const col = (name, value) => { values.push(value); sets.push(`${name} = $${values.length}`); };

  if ('plate_number' in body) col('plate_number', String(body.plate_number || '').trim() || null);
  if ('category' in body) col('category', body.category || null);
  if ('make' in body) col('make', body.make || null);
  if ('model' in body) col('model', body.model || null);
  // `body.model_year` arrives as '' (not null/undefined) when the edit
  // form's year field is empty — `!= null` doesn't catch that, and
  // Number('') is 0, not a meaningful "no year". Use a falsy check
  // instead, matching how POST /vehicles already handles this field.
  if ('model_year' in body) col('model_year', body.model_year ? Number(body.model_year) : null);
  if ('status' in body) col('status', body.status);
  if ('notes' in body) col('notes', body.notes || null);

  // assignment_type, assigned_rep_id, assignment_label and driver_name are
  // handled together: changing WHO the vehicle is assigned to is one
  // logical edit, so it only touches assigned_rep_id/driver_name when the
  // caller actually intends to change the assignment (assignment_type
  // present in the body) — editing, say, just `notes` must never clear them.
  if ('assignment_type' in body) {
    const isRepAssignment = body.assignment_type === 'rep';
    col('assignment_type', body.assignment_type);
    col('assigned_rep_id', isRepAssignment ? (body.assigned_rep_id || null) : null);
    col('driver_name', isRepAssignment ? null : (body.driver_name || null));
    // Same reasoning as POST: a rep-linked vehicle's region always follows
    // the rep, so region_id is only ever stored for non-rep vehicles —
    // switching a vehicle TO a rep clears out any manually-set region_id
    // it may have had before, since it's now dead/misleading data.
    col('region_id', isRepAssignment ? null : (body.region_id || null));
    if ('assignment_label' in body) col('assignment_label', body.assignment_label || null);
  } else {
    if ('assigned_rep_id' in body) col('assigned_rep_id', body.assigned_rep_id || null);
    if ('driver_name' in body) col('driver_name', body.driver_name || null);
    if ('assignment_label' in body) col('assignment_label', body.assignment_label || null);
    if ('region_id' in body) col('region_id', body.region_id || null);
  }

  if (!sets.length) return res.status(400).json({ error: 'لا توجد بيانات للتحديث' });
  values.push(req.params.id);

  // Transactional (was a plain pool.query before) so the fleet_vehicles
  // write and the sales_reps.vehicle_number sync below can never commit out
  // of step with each other — see syncRepVehicleNumber's own comment.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query(
      `SELECT plate_number, assigned_rep_id FROM fleet_vehicles WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!before.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'السيارة غير موجودة' }); }
    const oldPlate = before.rows[0].plate_number;
    const oldRepId = before.rows[0].assigned_rep_id;

    const r = await client.query(
      `UPDATE fleet_vehicles SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING plate_number, assigned_rep_id`,
      values
    );
    const newPlate = r.rows[0].plate_number;
    const newRepId = r.rows[0].assigned_rep_id;

    await syncRepVehicleNumber(client, { oldRepId, oldPlate, newRepId, newPlate });

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'رقم اللوحة مسجّل بالفعل' });
    if (err.code === '23503' && err.constraint === 'fleet_vehicles_category_fkey') {
      return res.status(400).json({ error: 'تصنيف سيارة غير صالح' });
    }
    console.error('[Fleet] vehicle update:', err);
    res.status(500).json({ error: 'خطأ في تعديل السيارة' });
  } finally {
    client.release();
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/fleet/reps — lightweight active-reps list for the "اختر من
   القائمة المسجلة للمناديب" dropdown when assigning a vehicle to a rep.
════════════════════════════════════════════════════════════ */
router.get('/reps', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name_ar FROM sales_reps WHERE is_active = TRUE ORDER BY name_ar`
    );
    res.json({ reps: r.rows });
  } catch (err) {
    console.error('[Fleet] reps list:', err);
    res.status(500).json({ error: 'خطأ في جلب قائمة المناديب' });
  }
});

/* ════════════════════════════════════════════════════════════
   DELETE /api/fleet/vehicles/:id — admin-only (see ADMIN_ROLES note above)
════════════════════════════════════════════════════════════ */
router.delete('/vehicles/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'DELETE FROM fleet_vehicles WHERE id = $1 RETURNING plate_number, assigned_rep_id',
      [req.params.id]
    );
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'السيارة غير موجودة' }); }
    // A deleted rep-linked vehicle no longer exists to point Rep Management
    // at — clear that rep's vehicle_number so it doesn't keep showing a
    // plate that's now gone from Fleet (same guard as syncRepVehicleNumber:
    // only clears if it still matches, never clobbers an unrelated value).
    if (r.rows[0].assigned_rep_id) {
      await syncRepVehicleNumber(client, {
        oldRepId: r.rows[0].assigned_rep_id, oldPlate: r.rows[0].plate_number,
        newRepId: null, newPlate: null,
      });
    }
    await client.query('COMMIT');
    res.json({ ok: true, removed: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Fleet] vehicle delete:', err);
    res.status(500).json({ error: 'خطأ في حذف السيارة' });
  } finally {
    client.release();
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/fleet/vehicles/:id — full profile: vehicle + maintenance
   schedule (with computed due/overdue status) + recent odometer
   history + recent maintenance log + recent expenses + expense totals.
════════════════════════════════════════════════════════════ */
router.get('/vehicles/:id', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  const { id } = req.params;
  try {
    const vr = await pool.query(
      `SELECT v.*, v.odometer_updated_at::text AS odometer_updated_at, sr.name_ar AS assigned_rep_name,
              COALESCE(sr.region_id, v.region_id) AS effective_region_id,
              COALESCE(rep_reg.name_ar, v_reg.name_ar) AS effective_region_name
       FROM fleet_vehicles v
       LEFT JOIN sales_reps sr      ON sr.id = v.assigned_rep_id
       LEFT JOIN regions    rep_reg ON rep_reg.id = sr.region_id
       LEFT JOIN regions    v_reg   ON v_reg.id = v.region_id
       WHERE v.id = $1`,
      [id]
    );
    if (!vr.rows.length) return res.status(404).json({ error: 'السيارة غير موجودة' });
    const vehicle = vr.rows[0];

    const scheduleR = await pool.query(
      `SELECT ms.id, ms.maintenance_type_id, t.name AS type_name, ms.interval_km,
              ms.last_service_km, ms.last_service_date::text,
              (v.current_odometer_km - ms.last_service_km) AS km_since_service,
              (ms.interval_km - (v.current_odometer_km - ms.last_service_km)) AS km_remaining
       FROM fleet_maintenance_schedule ms
       JOIN fleet_maintenance_types t ON t.id = ms.maintenance_type_id
       JOIN fleet_vehicles v ON v.id = ms.vehicle_id
       WHERE ms.vehicle_id = $1
       ORDER BY t.sort_order, t.name`,
      [id]
    );

    const odometerR = await pool.query(
      `SELECT id, reading_km, reading_date::text, recorded_by_name, created_at
       FROM fleet_odometer_readings WHERE vehicle_id = $1 ORDER BY reading_date DESC, id DESC LIMIT 30`,
      [id]
    );

    const maintLogR = await pool.query(
      `SELECT ml.id, ml.maintenance_type_id, t.name AS type_name, ml.service_date::text,
              ml.odometer_km, ml.cost, ml.vendor, ml.notes, ml.parts_used, ml.created_by_name
       FROM fleet_maintenance_log ml JOIN fleet_maintenance_types t ON t.id = ml.maintenance_type_id
       WHERE ml.vehicle_id = $1 ORDER BY ml.service_date DESC, ml.id DESC LIMIT 30`,
      [id]
    );

    const expensesR = await pool.query(
      `SELECT id, expense_date::text, category, amount, notes, parts_used, created_by_name
       FROM fleet_expenses WHERE vehicle_id = $1 ORDER BY expense_date DESC, id DESC LIMIT 50`,
      [id]
    );
    const expenseTotalsR = await pool.query(
      `SELECT category, SUM(amount)::numeric AS total FROM fleet_expenses WHERE vehicle_id = $1 GROUP BY category`,
      [id]
    );

    // parts_used → display names, resolved here (not per-row joins) so the
    // frontend never has to cross-reference a ~250-row catalog itself.
    const allParts = await loadSpareParts();
    const maintenanceLog = maintLogR.rows.map(r => ({ ...r, parts_used: resolvePartsUsed(r.parts_used, allParts) }));
    const expenses = expensesR.rows.map(r => ({ ...r, parts_used: resolvePartsUsed(r.parts_used, allParts) }));

    res.json({
      vehicle,
      category_labels: await loadCategoryLabels(),
      schedule: scheduleR.rows,
      odometer_history: odometerR.rows,
      maintenance_log: maintenanceLog,
      expenses,
      expense_totals: expenseTotalsR.rows,
    });
  } catch (err) {
    console.error('[Fleet] vehicle profile:', err);
    res.status(500).json({ error: 'خطأ في جلب بيانات السيارة' });
  }
});

/* ════════════════════════════════════════════════════════════
   POST /api/fleet/vehicles/:id/odometer
   Records a new reading and rolls fleet_vehicles.current_odometer_km/
   odometer_updated_at forward — but only if the new reading is not
   older than what's already on file, so a backdated correction entry
   can never regress the "current" figure the maintenance-due math and
   dashboard rely on.
════════════════════════════════════════════════════════════ */
router.post('/vehicles/:id/odometer', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const { reading_km, reading_date } = req.body || {};
  if (reading_km == null || isNaN(Number(reading_km))) {
    return res.status(400).json({ error: 'قراءة العداد مطلوبة' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO fleet_odometer_readings (vehicle_id, reading_km, reading_date, recorded_by, recorded_by_name)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5)`,
      [req.params.id, Number(reading_km), reading_date || null, req.user.id, req.user.name || null]
    );
    await client.query(
      `UPDATE fleet_vehicles
       SET current_odometer_km = $1, odometer_updated_at = COALESCE($2, CURRENT_DATE)
       WHERE id = $3 AND (odometer_updated_at IS NULL OR COALESCE($2, CURRENT_DATE) >= odometer_updated_at)`,
      [Number(reading_km), reading_date || null, req.params.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Fleet] odometer add:', err);
    res.status(500).json({ error: 'خطأ في تسجيل قراءة العداد' });
  } finally {
    client.release();
  }
});

/* ════════════════════════════════════════════════════════════
   POST /api/fleet/vehicles/:id/maintenance
   Logs a completed service AND rolls the schedule's last_service_km/
   date forward for that maintenance type — the two writes happen in one
   transaction so the "due" calculation can never read a stale schedule
   row after a service was just logged.
════════════════════════════════════════════════════════════ */
router.post('/vehicles/:id/maintenance', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const { maintenance_type_id, service_date, odometer_km, cost, vendor, notes, parts_used } = req.body || {};
  if (!maintenance_type_id) return res.status(400).json({ error: 'نوع الصيانة مطلوب' });
  if (odometer_km == null || isNaN(Number(odometer_km))) return res.status(400).json({ error: 'قراءة العداد وقت الصيانة مطلوبة' });

  // Optional — a maintenance job doesn't have to name specific parts, but
  // any {part_id, qty} it DOES send has to reference a real part (silently
  // dropped otherwise, never trusted as-is). Consuming a part here DEDUCTS
  // from fleet_spare_parts.qty_on_hand in the same transaction as the log
  // insert, linked to this vehicle via the log row's own vehicle_id.
  const cleanPartsUsed = await validPartsUsed(parts_used);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO fleet_maintenance_log
         (vehicle_id, maintenance_type_id, service_date, odometer_km, cost, vendor, notes, parts_used, created_by, created_by_name)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7, $8, $9, $10)`,
      [
        req.params.id, maintenance_type_id, service_date || null, Number(odometer_km),
        Number(cost) || 0, vendor || null, notes || null, JSON.stringify(cleanPartsUsed), req.user.id, req.user.name || null,
      ]
    );
    await client.query(
      `UPDATE fleet_maintenance_schedule
       SET last_service_km = $1, last_service_date = COALESCE($2, CURRENT_DATE)
       WHERE vehicle_id = $3 AND maintenance_type_id = $4`,
      [Number(odometer_km), service_date || null, req.params.id, maintenance_type_id]
    );

    // Deduct stock — never blocks the write on insufficient balance (see
    // the migration's note); insufficient rows are just collected to warn
    // the caller with, after the fact.
    const lowStockWarnings = [];
    for (const { part_id, qty } of cleanPartsUsed) {
      const upd = await client.query(
        `UPDATE fleet_spare_parts SET qty_on_hand = qty_on_hand - $1 WHERE id = $2 RETURNING name_ar, qty_on_hand`,
        [qty, part_id]
      );
      if (upd.rows.length && Number(upd.rows[0].qty_on_hand) < 0) {
        lowStockWarnings.push(`الرصيد المتبقي لقطعة "${upd.rows[0].name_ar}" أصبح سالباً (${upd.rows[0].qty_on_hand})`);
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, warnings: lowStockWarnings });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Fleet] maintenance log:', err);
    res.status(500).json({ error: 'خطأ في تسجيل الصيانة' });
  } finally {
    client.release();
  }
});

/* ════════════════════════════════════════════════════════════
   PUT/DELETE /api/fleet/maintenance-log/:id — correct or remove one
   already-logged maintenance row. ADMIN-ONLY (unlike expense edit/delete,
   which sits at the page's normal edit level): a maintenance row is what
   the due/overdue schedule is computed from, so silently rewriting one
   changes real alerts for the vehicle — requested specifically for admins.

   Two side effects must be kept honest, both inside one transaction with
   the row locked (`FOR UPDATE`, so two concurrent edits can't double-apply):
   1. Stock — reverse the OLD parts_used (+qty) before applying the NEW
      (−qty) on edit, or before dropping the row on delete, same rule as
      expense edit/delete.
   2. The schedule — POST /maintenance rolls fleet_maintenance_schedule's
      last_service_km/date forward to whatever was logged last, so
      removing/changing a row means that (vehicle, type) pair's schedule
      must be RECOMPUTED from the log that remains (latest by service_date,
      then id) rather than left pointing at a service that no longer
      exists. If no log remains for that type, it falls back to the
      vehicle's current odometer as the baseline (date left NULL) — the
      same "current reading is the starting point" rule migration 113
      applied fleet-wide, rather than reverting to 0 (which would
      re-create the false "everything overdue" alerts that migration
      fixed). An edit that changes the maintenance TYPE recomputes both the
      old and new type's schedules.
════════════════════════════════════════════════════════════ */
async function recomputeMaintenanceSchedule(client, vehicleId, typeId) {
  const latest = await client.query(
    `SELECT odometer_km, service_date FROM fleet_maintenance_log
     WHERE vehicle_id = $1 AND maintenance_type_id = $2
     ORDER BY service_date DESC, id DESC LIMIT 1`,
    [vehicleId, typeId]
  );
  if (latest.rows.length) {
    await client.query(
      `UPDATE fleet_maintenance_schedule SET last_service_km = $1, last_service_date = $2
       WHERE vehicle_id = $3 AND maintenance_type_id = $4`,
      [latest.rows[0].odometer_km, latest.rows[0].service_date, vehicleId, typeId]
    );
  } else {
    await client.query(
      `UPDATE fleet_maintenance_schedule ms
       SET last_service_km = v.current_odometer_km, last_service_date = NULL
       FROM fleet_vehicles v
       WHERE v.id = $1 AND ms.vehicle_id = v.id AND ms.maintenance_type_id = $2`,
      [vehicleId, typeId]
    );
  }
}

router.put('/maintenance-log/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const { maintenance_type_id, service_date, odometer_km, cost, vendor, notes, parts_used } = req.body || {};
  if (!maintenance_type_id) return res.status(400).json({ error: 'نوع الصيانة مطلوب' });
  if (odometer_km == null || odometer_km === '' || isNaN(Number(odometer_km))) return res.status(400).json({ error: 'قراءة العداد وقت الصيانة مطلوبة' });

  const cleanPartsUsed = await validPartsUsed(parts_used);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, vehicle_id, maintenance_type_id, parts_used FROM fleet_maintenance_log WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!existing.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'سجل الصيانة غير موجود' }); }
    const old = existing.rows[0];

    for (const { part_id, qty } of old.parts_used || []) {
      await client.query('UPDATE fleet_spare_parts SET qty_on_hand = qty_on_hand + $1 WHERE id = $2', [qty, part_id]);
    }
    const lowStockWarnings = [];
    for (const { part_id, qty } of cleanPartsUsed) {
      const upd = await client.query(
        `UPDATE fleet_spare_parts SET qty_on_hand = qty_on_hand - $1 WHERE id = $2 RETURNING name_ar, qty_on_hand`,
        [qty, part_id]
      );
      if (upd.rows.length && Number(upd.rows[0].qty_on_hand) < 0) {
        lowStockWarnings.push(`الرصيد المتبقي لقطعة "${upd.rows[0].name_ar}" أصبح سالباً (${upd.rows[0].qty_on_hand})`);
      }
    }

    await client.query(
      `UPDATE fleet_maintenance_log
       SET maintenance_type_id = $1, service_date = COALESCE($2, service_date), odometer_km = $3,
           cost = $4, vendor = $5, notes = $6, parts_used = $7
       WHERE id = $8`,
      [maintenance_type_id, service_date || null, Number(odometer_km), Number(cost) || 0,
       vendor || null, notes || null, JSON.stringify(cleanPartsUsed), req.params.id]
    );

    await recomputeMaintenanceSchedule(client, old.vehicle_id, old.maintenance_type_id);
    if (Number(maintenance_type_id) !== Number(old.maintenance_type_id)) {
      await recomputeMaintenanceSchedule(client, old.vehicle_id, Number(maintenance_type_id));
    }

    await client.query('COMMIT');
    console.log(`[Fleet] maintenance log ${req.params.id} edited by ${req.user.name || req.user.id}`);
    res.json({ ok: true, warnings: lowStockWarnings });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') return res.status(400).json({ error: 'نوع الصيانة غير صالح' });
    console.error('[Fleet] maintenance log update:', err);
    res.status(500).json({ error: 'خطأ في تعديل سجل الصيانة' });
  } finally {
    client.release();
  }
});

router.delete('/maintenance-log/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'SELECT id, vehicle_id, maintenance_type_id, parts_used FROM fleet_maintenance_log WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'سجل الصيانة غير موجود' }); }
    const row = r.rows[0];

    for (const { part_id, qty } of row.parts_used || []) {
      await client.query('UPDATE fleet_spare_parts SET qty_on_hand = qty_on_hand + $1 WHERE id = $2', [qty, part_id]);
    }
    await client.query('DELETE FROM fleet_maintenance_log WHERE id = $1', [req.params.id]);
    await recomputeMaintenanceSchedule(client, row.vehicle_id, row.maintenance_type_id);

    await client.query('COMMIT');
    console.log(`[Fleet] maintenance log ${req.params.id} deleted by ${req.user.name || req.user.id}`);
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Fleet] maintenance log delete:', err);
    res.status(500).json({ error: 'خطأ في حذف سجل الصيانة' });
  } finally {
    client.release();
  }
});

/* ════════════════════════════════════════════════════════════
   POST /api/fleet/vehicles/:id/expenses
════════════════════════════════════════════════════════════ */
router.post('/vehicles/:id/expenses', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const { expense_date, category, amount, notes, parts_used } = req.body || {};
  if (!category) return res.status(400).json({ error: 'تصنيف المصروف مطلوب' });
  if (amount == null || isNaN(Number(amount))) return res.status(400).json({ error: 'قيمة المصروف مطلوبة' });

  // Optional — an expense doesn't have to name specific parts. A part
  // marked deduct_stock=true here deducts from fleet_spare_parts.qty_on_hand
  // in the same transaction as the expense insert (its unit_cost is looked
  // up server-side, never trusted from the client — see
  // validExpensePartsUsed); one NOT marked is a plain hand-entered line
  // with no stock effect.
  const cleanPartsUsed = await validExpensePartsUsed(parts_used);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO fleet_expenses (vehicle_id, expense_date, category, amount, notes, parts_used, created_by, created_by_name)
       VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5, $6, $7, $8)`,
      [req.params.id, expense_date || null, category, Number(amount), notes || null, JSON.stringify(cleanPartsUsed), req.user.id, req.user.name || null]
    );

    const lowStockWarnings = [];
    for (const { part_id, qty, deduct_stock } of cleanPartsUsed) {
      if (!deduct_stock) continue;
      const upd = await client.query(
        `UPDATE fleet_spare_parts SET qty_on_hand = qty_on_hand - $1 WHERE id = $2 RETURNING name_ar, qty_on_hand`,
        [qty, part_id]
      );
      if (upd.rows.length && Number(upd.rows[0].qty_on_hand) < 0) {
        lowStockWarnings.push(`الرصيد المتبقي لقطعة "${upd.rows[0].name_ar}" أصبح سالباً (${upd.rows[0].qty_on_hand})`);
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, warnings: lowStockWarnings });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503' && err.constraint === 'fleet_expenses_category_fkey') {
      return res.status(400).json({ error: 'تصنيف المصروف غير صالح' });
    }
    console.error('[Fleet] expense add:', err);
    res.status(500).json({ error: 'خطأ في تسجيل المصروف' });
  } finally {
    client.release();
  }
});

/* ════════════════════════════════════════════════════════════
   PUT/DELETE /api/fleet/expenses/:id — edit/delete an already-saved
   expense row. Open to any user holding the page's normal edit level
   (same as creating one) — NOT admin-only, unlike vehicle delete/stock
   reset, since correcting a typo'd amount or category is routine fleet
   coordination, not a destructive/irreversible action in the same sense.

   Both routes must UNDO whatever stock effect the row's OLD parts_used
   had before applying the new one (edit) or before dropping the row
   entirely (delete) — otherwise a stock-deducting part edited away, or a
   deleted expense that had deducted stock, would leave qty_on_hand
   permanently short by however much that row took. `FOR UPDATE` locks the
   row for the duration of the transaction so a concurrent edit/delete on
   the same expense can't interleave and double-reverse or double-apply
   its stock effect.
════════════════════════════════════════════════════════════ */
router.put('/expenses/:id', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const { expense_date, category, amount, notes, parts_used } = req.body || {};
  if (!category) return res.status(400).json({ error: 'تصنيف المصروف مطلوب' });
  if (amount == null || isNaN(Number(amount))) return res.status(400).json({ error: 'قيمة المصروف مطلوبة' });

  const cleanPartsUsed = await validExpensePartsUsed(parts_used);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id, parts_used FROM fleet_expenses WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!existing.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'المصروف غير موجود' }); }

    // Reverse the OLD row's stock effect first…
    for (const { part_id, qty, deduct_stock } of existing.rows[0].parts_used || []) {
      if (!deduct_stock) continue;
      await client.query('UPDATE fleet_spare_parts SET qty_on_hand = qty_on_hand + $1 WHERE id = $2', [qty, part_id]);
    }
    // …then apply the NEW one. Two separate loops (not a diff) — simpler
    // and correct even when a part was removed, added, or had its qty
    // changed, at the cost of a redundant -N/+N pair on a part left
    // untouched between edits; negligible next to the correctness win.
    const lowStockWarnings = [];
    for (const { part_id, qty, deduct_stock } of cleanPartsUsed) {
      if (!deduct_stock) continue;
      const upd = await client.query(
        `UPDATE fleet_spare_parts SET qty_on_hand = qty_on_hand - $1 WHERE id = $2 RETURNING name_ar, qty_on_hand`,
        [qty, part_id]
      );
      if (upd.rows.length && Number(upd.rows[0].qty_on_hand) < 0) {
        lowStockWarnings.push(`الرصيد المتبقي لقطعة "${upd.rows[0].name_ar}" أصبح سالباً (${upd.rows[0].qty_on_hand})`);
      }
    }

    await client.query(
      `UPDATE fleet_expenses
       SET expense_date = COALESCE($1, expense_date), category = $2, amount = $3, notes = $4, parts_used = $5
       WHERE id = $6`,
      [expense_date || null, category, Number(amount), notes || null, JSON.stringify(cleanPartsUsed), req.params.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, warnings: lowStockWarnings });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503' && err.constraint === 'fleet_expenses_category_fkey') {
      return res.status(400).json({ error: 'تصنيف المصروف غير صالح' });
    }
    console.error('[Fleet] expense update:', err);
    res.status(500).json({ error: 'خطأ في تعديل المصروف' });
  } finally {
    client.release();
  }
});

router.delete('/expenses/:id', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT id, parts_used FROM fleet_expenses WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'المصروف غير موجود' }); }

    for (const { part_id, qty, deduct_stock } of r.rows[0].parts_used || []) {
      if (!deduct_stock) continue;
      await client.query('UPDATE fleet_spare_parts SET qty_on_hand = qty_on_hand + $1 WHERE id = $2', [qty, part_id]);
    }
    await client.query('DELETE FROM fleet_expenses WHERE id = $1', [req.params.id]);

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Fleet] expense delete:', err);
    res.status(500).json({ error: 'خطأ في حذف المصروف' });
  } finally {
    client.release();
  }
});

/* ════════════════════════════════════════════════════════════
   Maintenance type catalog — admin settings (interval defaults per
   category, add/deactivate types). New vehicles seed from whatever is
   is_active = TRUE at creation time; adding a type here does NOT
   retroactively add a schedule row to already-existing vehicles (kept
   simple — the fleet admin can add it per-vehicle from the profile if
   needed later; a bulk-backfill endpoint can be added if this turns out
   to be a common need).
════════════════════════════════════════════════════════════ */
router.get('/maintenance-types', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM fleet_maintenance_types ORDER BY sort_order, name');
    res.json({ types: r.rows });
  } catch (err) {
    console.error('[Fleet] maintenance types list:', err);
    res.status(500).json({ error: 'خطأ في جلب أنواع الصيانة' });
  }
});

router.post('/maintenance-types', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const { name, category, default_interval_km, sort_order } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم نوع الصيانة مطلوب' });
  if (default_interval_km == null || isNaN(Number(default_interval_km))) return res.status(400).json({ error: 'الفترة الافتراضية (كم) مطلوبة' });
  try {
    const r = await pool.query(
      `INSERT INTO fleet_maintenance_types (name, category, default_interval_km, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [String(name).trim(), category || null, Number(default_interval_km), Number(sort_order) || 0]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23503' && err.constraint === 'fleet_maintenance_types_category_fkey') {
      return res.status(400).json({ error: 'تصنيف سيارة غير صالح' });
    }
    console.error('[Fleet] maintenance type create:', err);
    res.status(500).json({ error: 'خطأ في إضافة نوع الصيانة' });
  }
});

/* Partial-update: only columns actually present in the body are touched.
   The settings-tab table fires small single-field PUTs (just
   { default_interval_km } on blur, or just { is_active } on the checkbox) —
   the previous COALESCE($n, ...) form still unconditionally overwrote
   `category` with `category || null` on EVERY such edit, which would have
   silently wiped a type's target category the same way the vehicles PUT
   bug once wiped assigned_rep_id (see that endpoint's own comment above).
   It never surfaced because every category was NULL in practice — fixed
   here now that admin-set target categories are an actual code path. */
router.put('/maintenance-types/:id', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const body = req.body || {};
  const sets = [];
  const values = [];
  const col = (name, value) => { values.push(value); sets.push(`${name} = $${values.length}`); };

  if ('name' in body) col('name', String(body.name || '').trim() || null);
  if ('category' in body) col('category', body.category || null);
  if ('default_interval_km' in body) col('default_interval_km', body.default_interval_km != null ? Number(body.default_interval_km) : null);
  if ('is_active' in body) col('is_active', body.is_active != null ? Boolean(body.is_active) : null);
  if ('sort_order' in body) col('sort_order', body.sort_order != null ? Number(body.sort_order) : null);

  if (!sets.length) return res.status(400).json({ error: 'لا توجد بيانات للتحديث' });
  values.push(req.params.id);

  try {
    const r = await pool.query(
      `UPDATE fleet_maintenance_types SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING id`,
      values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'نوع الصيانة غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503' && err.constraint === 'fleet_maintenance_types_category_fkey') {
      return res.status(400).json({ error: 'تصنيف سيارة غير صالح' });
    }
    console.error('[Fleet] maintenance type update:', err);
    res.status(500).json({ error: 'خطأ في تعديل نوع الصيانة' });
  }
});

/* ════════════════════════════════════════════════════════════
   Vehicle category catalog (تصنيفات السيارات) — admin settings, same
   add/deactivate-only pattern as the maintenance-type catalog above (never
   physically deleted, only is_active = FALSE, so a category already used
   on existing vehicles never dangles). `key` is generated server-side
   (a short random slug) rather than typed by the admin — it's the machine
   value actually stored on fleet_vehicles.category, and asking an
   Arabic-speaking admin to also invent an ASCII key is unnecessary friction
   when the Arabic name is the only thing anyone needs to type or read.
════════════════════════════════════════════════════════════ */
router.get('/vehicle-categories', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  try {
    res.json({ categories: await loadVehicleCategories() });
  } catch (err) {
    console.error('[Fleet] vehicle categories list:', err);
    res.status(500).json({ error: 'خطأ في جلب تصنيفات السيارات' });
  }
});

router.post('/vehicle-categories', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const { name_ar, sort_order } = req.body || {};
  if (!name_ar || !String(name_ar).trim()) return res.status(400).json({ error: 'اسم التصنيف مطلوب' });
  const key = `cat_${crypto.randomBytes(4).toString('hex')}`;
  try {
    await pool.query(
      `INSERT INTO fleet_vehicle_categories (key, name_ar, sort_order) VALUES ($1, $2, $3)`,
      [key, String(name_ar).trim(), Number(sort_order) || 0]
    );
    res.json({ ok: true, key });
  } catch (err) {
    console.error('[Fleet] vehicle category create:', err);
    res.status(500).json({ error: 'خطأ في إضافة التصنيف' });
  }
});

router.put('/vehicle-categories/:key', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const { name_ar, is_active, sort_order } = req.body || {};
  try {
    const r = await pool.query(
      `UPDATE fleet_vehicle_categories
       SET name_ar = COALESCE($1, name_ar),
           is_active = COALESCE($2, is_active),
           sort_order = COALESCE($3, sort_order)
       WHERE key = $4 RETURNING key`,
      [name_ar || null, is_active != null ? Boolean(is_active) : null,
       sort_order != null ? Number(sort_order) : null, req.params.key]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'التصنيف غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Fleet] vehicle category update:', err);
    res.status(500).json({ error: 'خطأ في تعديل التصنيف' });
  }
});

// حذف تصنيف بالكامل — يختلف عن "إلغاء التفعيل" (is_active=false) اللي
// يُبقي التصنيف موجوداً ويُخفيه فقط من قوائم الاختيار عند إضافة جديد.
// الحذف الفعلي مرفوض من قاعدة البيانات (23503 — FK) لو أي سيارة أو نوع
// صيانة لا يزال مربوطاً به (fleet_vehicles.category /
// fleet_maintenance_types.category)، فيُعاد للمستخدم برسالة واضحة تقترح
// إلغاء التفعيل بدلاً من ذلك — بدل رسالة خطأ عامة غير مفهومة.
router.delete('/vehicle-categories/:key', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM fleet_vehicle_categories WHERE key = $1 RETURNING key', [req.params.key]);
    if (!r.rows.length) return res.status(404).json({ error: 'التصنيف غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'هذا التصنيف مستخدم في سيارة واحدة أو أكثر (أو نوع صيانة) — لا يمكن حذفه. يمكنك إلغاء تفعيله بدلاً من ذلك.' });
    }
    console.error('[Fleet] vehicle category delete:', err);
    res.status(500).json({ error: 'خطأ في حذف التصنيف' });
  }
});

/* ════════════════════════════════════════════════════════════
   Expense line-item catalog (بنود المصروفات) — identical shape/pattern to
   the vehicle-category catalog just above.
════════════════════════════════════════════════════════════ */
router.get('/expense-categories', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  try {
    res.json({ categories: await loadExpenseCategories() });
  } catch (err) {
    console.error('[Fleet] expense categories list:', err);
    res.status(500).json({ error: 'خطأ في جلب بنود المصروفات' });
  }
});

router.post('/expense-categories', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const { name_ar, sort_order } = req.body || {};
  if (!name_ar || !String(name_ar).trim()) return res.status(400).json({ error: 'اسم البند مطلوب' });
  const key = `exp_${crypto.randomBytes(4).toString('hex')}`;
  try {
    await pool.query(
      `INSERT INTO fleet_expense_categories (key, name_ar, sort_order) VALUES ($1, $2, $3)`,
      [key, String(name_ar).trim(), Number(sort_order) || 0]
    );
    res.json({ ok: true, key });
  } catch (err) {
    console.error('[Fleet] expense category create:', err);
    res.status(500).json({ error: 'خطأ في إضافة بند المصروف' });
  }
});

router.put('/expense-categories/:key', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const { name_ar, is_active, sort_order } = req.body || {};
  try {
    const r = await pool.query(
      `UPDATE fleet_expense_categories
       SET name_ar = COALESCE($1, name_ar),
           is_active = COALESCE($2, is_active),
           sort_order = COALESCE($3, sort_order)
       WHERE key = $4 RETURNING key`,
      [name_ar || null, is_active != null ? Boolean(is_active) : null,
       sort_order != null ? Number(sort_order) : null, req.params.key]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'البند غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Fleet] expense category update:', err);
    res.status(500).json({ error: 'خطأ في تعديل بند المصروف' });
  }
});

// حذف بند بالكامل — نفس منطق حذف تصنيفات السيارات أعلاه: مرفوض من قاعدة
// البيانات (23503) لو أي مصروف مسجَّل لا يزال يستخدم هذا البند
// (fleet_expenses.category)، فيُعاد للمستخدم برسالة واضحة تقترح إلغاء
// التفعيل بدلاً من الحذف.
router.delete('/expense-categories/:key', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM fleet_expense_categories WHERE key = $1 RETURNING key', [req.params.key]);
    if (!r.rows.length) return res.status(404).json({ error: 'البند غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'هذا البند مستخدم في مصروف واحد أو أكثر — لا يمكن حذفه. يمكنك إلغاء تفعيله بدلاً من ذلك.' });
    }
    console.error('[Fleet] expense category delete:', err);
    res.status(500).json({ error: 'خطأ في حذف بند المصروف' });
  }
});

/* ════════════════════════════════════════════════════════════
   Spare parts catalog (قطع غيار) — same add/edit-in-settings shape as the
   two catalogs above, addressed by integer id (not a slug key) since it's
   large enough (~250 rows) that the frontend always searches it rather
   than rendering a plain <select>.
════════════════════════════════════════════════════════════ */
router.get('/spare-parts', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  try {
    res.json({ parts: await loadSpareParts() });
  } catch (err) {
    console.error('[Fleet] spare parts list:', err);
    res.status(500).json({ error: 'خطأ في جلب قائمة قطع الغيار' });
  }
});

router.post('/spare-parts', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const { name_ar, sort_order } = req.body || {};
  if (!name_ar || !String(name_ar).trim()) return res.status(400).json({ error: 'اسم القطعة مطلوب' });
  try {
    const r = await pool.query(
      `INSERT INTO fleet_spare_parts (name_ar, sort_order) VALUES ($1, $2) RETURNING id`,
      [String(name_ar).trim(), Number(sort_order) || 0]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'قطعة الغيار مسجّلة بالفعل' });
    console.error('[Fleet] spare part create:', err);
    res.status(500).json({ error: 'خطأ في إضافة قطعة الغيار' });
  }
});

router.put('/spare-parts/:id', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const { name_ar, is_active, sort_order } = req.body || {};
  try {
    const r = await pool.query(
      `UPDATE fleet_spare_parts
       SET name_ar = COALESCE($1, name_ar),
           is_active = COALESCE($2, is_active),
           sort_order = COALESCE($3, sort_order)
       WHERE id = $4 RETURNING id`,
      [name_ar || null, is_active != null ? Boolean(is_active) : null,
       sort_order != null ? Number(sort_order) : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'القطعة غير موجودة' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'قطعة الغيار مسجّلة بالفعل' });
    console.error('[Fleet] spare part update:', err);
    res.status(500).json({ error: 'خطأ في تعديل قطعة الغيار' });
  }
});

/* ════════════════════════════════════════════════════════════
   أمر توريد أرصدة مخزون (stock receiving order) — records a supply-in
   transaction for one part and rolls its qty_on_hand forward, in one
   transaction. This is the ONLY way stock increases; consumption during a
   logged maintenance service (POST /vehicles/:id/maintenance) is the only
   way it decreases.
════════════════════════════════════════════════════════════ */
router.post('/spare-parts/:id/supply', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const { quantity, unit_cost, supply_date, notes } = req.body || {};
  if (quantity == null || isNaN(Number(quantity)) || Number(quantity) <= 0) {
    return res.status(400).json({ error: 'الكمية الموردة مطلوبة ويجب أن تكون أكبر من صفر' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO fleet_part_supplies (part_id, supply_date, quantity, unit_cost, notes, created_by, created_by_name)
       VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5, $6, $7) RETURNING id`,
      [req.params.id, supply_date || null, Number(quantity), Number(unit_cost) || 0, notes || null, req.user.id, req.user.name || null]
    );
    const upd = await client.query(
      `UPDATE fleet_spare_parts SET qty_on_hand = qty_on_hand + $1 WHERE id = $2 RETURNING id, qty_on_hand`,
      [Number(quantity), req.params.id]
    );
    if (!upd.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'القطعة غير موجودة' }); }
    await client.query('COMMIT');
    res.json({ ok: true, supply_id: ins.rows[0].id, qty_on_hand: upd.rows[0].qty_on_hand });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Fleet] part supply add:', err);
    res.status(500).json({ error: 'خطأ في تسجيل أمر التوريد' });
  } finally {
    client.release();
  }
});

router.get('/spare-parts/:id/supplies', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, supply_date::text, quantity, unit_cost, total_cost, notes, created_by_name
       FROM fleet_part_supplies WHERE part_id = $1 ORDER BY supply_date DESC, id DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ supplies: r.rows });
  } catch (err) {
    console.error('[Fleet] part supplies list:', err);
    res.status(500).json({ error: 'خطأ في جلب سجل التوريد' });
  }
});

// Combined supply feed across EVERY part — powers "أرصدة قطع الغيار"'s own
// "آخر عمليات التوريد" audit trail, so reviewing the whole store doesn't
// mean opening each part's own history one at a time.
router.get('/part-supplies', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.id, s.part_id, p.name_ar AS part_name, s.supply_date::text,
             s.quantity, s.unit_cost, s.total_cost, s.notes, s.created_by_name
      FROM fleet_part_supplies s
      JOIN fleet_spare_parts p ON p.id = s.part_id
      ORDER BY s.supply_date DESC, s.id DESC
      LIMIT 100
    `);
    res.json({ supplies: r.rows });
  } catch (err) {
    console.error('[Fleet] part supplies (combined) list:', err);
    res.status(500).json({ error: 'خطأ في جلب سجل التوريد' });
  }
});

// حذف سجل توريد بالكامل — e.g. a mistaken/test entry (wrong quantity or
// price typed in) that should never have existed, as opposed to تصفير
// (below), which is a blunt "zero the balance" correction that leaves the
// supply history intact. Deleting a supply row MUST reverse its
// contribution to qty_on_hand (subtract the quantity it once added) or the
// cached balance would permanently over-count — same "undo the row's stock
// effect before removing it" rule as expense delete. Open to the page's
// normal edit level, not admin-only: this corrects a specific mistaken
// entry (like editing/deleting an expense), it doesn't wipe a whole
// balance blind to what's really on the shelf the way تصفير does.
// `FOR UPDATE` locks the row for the transaction so a concurrent
// delete/edit on the same supply row can't double-reverse it.
router.delete('/part-supplies/:id', verifyToken, requirePagePermission('fleet_management', 2), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'SELECT part_id, quantity FROM fleet_part_supplies WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'سجل التوريد غير موجود' }); }
    const upd = await client.query(
      'UPDATE fleet_spare_parts SET qty_on_hand = qty_on_hand - $1 WHERE id = $2 RETURNING qty_on_hand',
      [r.rows[0].quantity, r.rows[0].part_id]
    );
    await client.query('DELETE FROM fleet_part_supplies WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, qty_on_hand: upd.rows[0]?.qty_on_hand ?? null });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Fleet] part supply delete:', err);
    res.status(500).json({ error: 'خطأ في حذف سجل التوريد' });
  } finally {
    client.release();
  }
});

// تصفير الرصيد (admin-only) — a manual correction, not a supply/consumption
// event, so it's kept OUT of fleet_part_supplies (that ledger's quantity is
// CHECK > 0, i.e. receiving-only by design) and doesn't touch it at all;
// it purely zeroes the cached qty_on_hand. Admin-only (same ADMIN_ROLES
// gate as vehicle delete) because it silently discards whatever the true
// physical count should have been reconciled to — same "irreversible,
// so tighter than the page's normal edit level" reasoning as that route.
router.post('/spare-parts/:id/reset-stock', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE fleet_spare_parts SET qty_on_hand = 0 WHERE id = $1 RETURNING id, name_ar, qty_on_hand`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'القطعة غير موجودة' });
    console.log(`[Fleet] stock reset: part #${r.rows[0].id} "${r.rows[0].name_ar}" zeroed by ${req.user.name || req.user.id}`);
    res.json({ ok: true, qty_on_hand: r.rows[0].qty_on_hand });
  } catch (err) {
    console.error('[Fleet] part stock reset:', err);
    res.status(500).json({ error: 'خطأ في تصفير الرصيد' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/fleet/dashboard
   KPI/alert summary for the overview tab: fleet counts by
   category/status, vehicles overdue on their weekly odometer update,
   the maintenance-alert list (soonest-due first), and this month's
   expense totals by category.
════════════════════════════════════════════════════════════ */
router.get('/dashboard', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  try {
    const totalsR = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'active')::int AS active,
             COUNT(*) FILTER (WHERE status = 'in_maintenance')::int AS in_maintenance,
             COUNT(*) FILTER (WHERE category IS NULL)::int AS unclassified
      FROM fleet_vehicles
    `);
    const byCategoryR = await pool.query(`
      SELECT COALESCE(category, 'unclassified') AS category, COUNT(*)::int AS n
      FROM fleet_vehicles GROUP BY category
    `);
    // Odometer not updated in the last 7 days (or never) — the weekly
    // update reminder this whole feature was built around.
    const staleOdometerR = await pool.query(`
      SELECT v.id, v.plate_number, v.category, sr.name_ar AS assigned_rep_name, v.assignment_label,
             v.odometer_updated_at::text, (CURRENT_DATE - v.odometer_updated_at) AS days_since_update
      FROM fleet_vehicles v LEFT JOIN sales_reps sr ON sr.id = v.assigned_rep_id
      WHERE v.status <> 'sold'
        AND (v.odometer_updated_at IS NULL OR v.odometer_updated_at <= CURRENT_DATE - INTERVAL '7 days')
      ORDER BY v.odometer_updated_at NULLS FIRST
    `);
    // Maintenance alerts: due (>=90% of interval consumed) or overdue.
    const maintAlertsR = await pool.query(`
      SELECT v.id AS vehicle_id, v.plate_number, v.category, sr.name_ar AS assigned_rep_name,
             t.name AS type_name, ms.interval_km, ms.last_service_km,
             (v.current_odometer_km - ms.last_service_km) AS km_since_service,
             (v.current_odometer_km - ms.last_service_km) - ms.interval_km AS km_overdue_by,
             CASE WHEN (v.current_odometer_km - ms.last_service_km) >= ms.interval_km THEN 'overdue'
                  ELSE 'due_soon' END AS alert_level
      FROM fleet_maintenance_schedule ms
      JOIN fleet_vehicles v ON v.id = ms.vehicle_id
      JOIN fleet_maintenance_types t ON t.id = ms.maintenance_type_id
      LEFT JOIN sales_reps sr ON sr.id = v.assigned_rep_id
      WHERE v.status <> 'sold'
        AND (v.current_odometer_km - ms.last_service_km) >= ms.interval_km * 0.9
      ORDER BY ((v.current_odometer_km - ms.last_service_km) - ms.interval_km) DESC
    `);
    const monthExpensesR = await pool.query(`
      SELECT category, SUM(amount)::numeric AS total
      FROM fleet_expenses
      WHERE date_trunc('month', expense_date) = date_trunc('month', CURRENT_DATE)
      GROUP BY category
    `);

    res.json({
      totals: totalsR.rows[0],
      by_category: byCategoryR.rows,
      category_labels: await loadCategoryLabels(),
      stale_odometer: staleOdometerR.rows,
      maintenance_alerts: maintAlertsR.rows,
      month_expenses: monthExpensesR.rows,
    });
  } catch (err) {
    console.error('[Fleet] dashboard:', err);
    res.status(500).json({ error: 'خطأ في جلب مؤشرات الأسطول' });
  }
});

/* ════════════════════════════════════════════════════════════
   Fleet REPORTS (تقارير الأسطول) — a dedicated tab, filterable by an
   arbitrary date range plus region(s) and vehicle category(ies), unlike
   the overview/vehicles tabs which show current state only. Three
   endpoints, one per report the user asked for, sharing the same filter
   parsing/scope-SQL helpers above:
     • /reports/summary     — مؤشرات الأداء (KPIs) for the filtered scope
     • /reports/maintenance — جدول الصيانات المنفذة (date-ranged, from the
       log) والقادمة (current due/overdue state — inherently odometer-
       based, not date-ranged, same as the dashboard's own alert list)
     • /reports/expenses    — سجل المصروفات + تجميعات حسب البند/السيارة/الشهر
════════════════════════════════════════════════════════════ */

/* GET /api/fleet/reports/summary?date_from=...&date_to=...&region_id=1&region_id=2&category=ton_5 */
router.get('/reports/summary', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  const dateFrom = String(req.query.date_from || '').trim();
  const dateTo   = String(req.query.date_to   || '').trim();
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'الفترة (من - إلى) مطلوبة' });
  if (dateTo < dateFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });

  const regionIds  = parseMulti(req.query.region_id)?.map(Number).filter(n => !isNaN(n)) || null;
  const categories = parseMulti(req.query.category) || null;

  try {
    const vParams = [];
    const vScope = buildScopeSql(vParams, regionIds, categories);
    const vehicleCountQ = pool.query(
      `SELECT COUNT(*)::int AS n FROM fleet_vehicles v LEFT JOIN sales_reps sr ON sr.id = v.assigned_rep_id
       WHERE v.status <> 'sold'${vScope}`,
      vParams
    );

    const maintParams = [dateFrom, dateTo];
    const maintScope = buildScopeSql(maintParams, regionIds, categories);
    const maintQ = pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(ml.cost),0)::numeric AS total_cost
       FROM fleet_maintenance_log ml
       JOIN fleet_vehicles v ON v.id = ml.vehicle_id
       LEFT JOIN sales_reps sr ON sr.id = v.assigned_rep_id
       WHERE ml.service_date BETWEEN $1::date AND $2::date${maintScope}`,
      maintParams
    );

    const expParams = [dateFrom, dateTo];
    const expScope = buildScopeSql(expParams, regionIds, categories);
    const expQ = pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(fe.amount),0)::numeric AS total_amount
       FROM fleet_expenses fe
       JOIN fleet_vehicles v ON v.id = fe.vehicle_id
       LEFT JOIN sales_reps sr ON sr.id = v.assigned_rep_id
       WHERE fe.expense_date BETWEEN $1::date AND $2::date${expScope}`,
      expParams
    );

    // Total km driven in the period: MAX-MIN odometer reading per vehicle
    // among vehicles with 2+ readings IN the window — a vehicle updated
    // only once in the period contributes no computable delta, so it's
    // excluded rather than counted as 0 (which would understate, not
    // just omit). This is a real-reading-based figure, never inferred
    // from current_odometer_km, so it can't include distance driven
    // outside the selected period.
    const kmParams = [dateFrom, dateTo];
    const kmScope = buildScopeSql(kmParams, regionIds, categories);
    const kmQ = pool.query(
      `WITH km AS (
         SELECT o.vehicle_id, MAX(o.reading_km) - MIN(o.reading_km) AS driven
         FROM fleet_odometer_readings o
         JOIN fleet_vehicles v ON v.id = o.vehicle_id
         LEFT JOIN sales_reps sr ON sr.id = v.assigned_rep_id
         WHERE o.reading_date BETWEEN $1::date AND $2::date${kmScope}
         GROUP BY o.vehicle_id HAVING COUNT(*) > 1
       )
       SELECT COALESCE(SUM(driven),0)::numeric AS total_km FROM km WHERE driven > 0`,
      kmParams
    );

    const alertParams = [];
    const alertScope = buildScopeSql(alertParams, regionIds, categories);
    const alertQ = pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE (v.current_odometer_km - ms.last_service_km) >= ms.interval_km)::int AS overdue,
         COUNT(*) FILTER (WHERE (v.current_odometer_km - ms.last_service_km) >= ms.interval_km * 0.9
                            AND (v.current_odometer_km - ms.last_service_km) < ms.interval_km)::int AS due_soon
       FROM fleet_maintenance_schedule ms
       JOIN fleet_vehicles v ON v.id = ms.vehicle_id
       LEFT JOIN sales_reps sr ON sr.id = v.assigned_rep_id
       WHERE v.status <> 'sold'${alertScope}`,
      alertParams
    );

    const [vehicleCountR, maintR, expR, kmR, alertR] = await Promise.all([vehicleCountQ, maintQ, expQ, kmQ, alertQ]);

    const vehicleCount     = vehicleCountR.rows[0].n;
    const maintenanceCost  = Number(maintR.rows[0].total_cost);
    const maintenanceCount = maintR.rows[0].n;
    const expenseTotal     = Number(expR.rows[0].total_amount);
    const expenseCount     = expR.rows[0].n;
    const totalCost        = maintenanceCost + expenseTotal;
    const totalKm          = Number(kmR.rows[0].total_km);

    res.json({
      period: { from: dateFrom, to: dateTo },
      vehicle_count: vehicleCount,
      maintenance_cost: maintenanceCost,
      maintenance_count: maintenanceCount,
      expense_total: expenseTotal,
      expense_count: expenseCount,
      total_cost: totalCost,
      total_km: totalKm,
      cost_per_km: totalKm > 0 ? +(totalCost / totalKm).toFixed(2) : null,
      avg_cost_per_vehicle: vehicleCount > 0 ? +(totalCost / vehicleCount).toFixed(2) : null,
      overdue_count: alertR.rows[0].overdue,
      due_soon_count: alertR.rows[0].due_soon,
    });
  } catch (err) {
    console.error('[Fleet] reports/summary:', err);
    res.status(500).json({ error: 'خطأ في جلب مؤشرات التقرير' });
  }
});

/* GET /api/fleet/reports/maintenance?date_from=...&date_to=...&region_id=..&category=.. */
router.get('/reports/maintenance', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  const dateFrom = String(req.query.date_from || '').trim();
  const dateTo   = String(req.query.date_to   || '').trim();
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'الفترة (من - إلى) مطلوبة' });
  if (dateTo < dateFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });

  const regionIds  = parseMulti(req.query.region_id)?.map(Number).filter(n => !isNaN(n)) || null;
  const categories = parseMulti(req.query.category) || null;

  try {
    const doneParams = [dateFrom, dateTo];
    const doneScope = buildScopeSql(doneParams, regionIds, categories);
    const doneQ = pool.query(
      `SELECT ml.id, ml.service_date::text, v.id AS vehicle_id, v.plate_number, v.category,
              COALESCE(sr.region_id, v.region_id) AS region_id,
              COALESCE(rep_reg.name_ar, v_reg.name_ar) AS region_name,
              t.name AS type_name, ml.odometer_km, ml.cost, ml.vendor, ml.notes, ml.created_by_name
       FROM fleet_maintenance_log ml
       JOIN fleet_vehicles v ON v.id = ml.vehicle_id
       JOIN fleet_maintenance_types t ON t.id = ml.maintenance_type_id
       LEFT JOIN sales_reps sr      ON sr.id = v.assigned_rep_id
       LEFT JOIN regions    rep_reg ON rep_reg.id = sr.region_id
       LEFT JOIN regions    v_reg   ON v_reg.id = v.region_id
       WHERE ml.service_date BETWEEN $1::date AND $2::date${doneScope}
       ORDER BY ml.service_date DESC, ml.id DESC`,
      doneParams
    );

    // "القادمة" is inherently odometer-based (due = km consumed since last
    // service ≥ interval), not date-based — there is no service calendar in
    // this system to project a due DATE from, only a due ODOMETER reading.
    // Reuses the exact due/overdue rule the overview dashboard already
    // shows, just with the region/category scope applied.
    const dueParams = [];
    const dueScope = buildScopeSql(dueParams, regionIds, categories);
    const dueQ = pool.query(
      `SELECT v.id AS vehicle_id, v.plate_number, v.category,
              COALESCE(sr.region_id, v.region_id) AS region_id,
              COALESCE(rep_reg.name_ar, v_reg.name_ar) AS region_name,
              t.name AS type_name, ms.interval_km, ms.last_service_km, ms.last_service_date::text,
              v.current_odometer_km,
              (v.current_odometer_km - ms.last_service_km) AS km_since_service,
              (v.current_odometer_km - ms.last_service_km) - ms.interval_km AS km_overdue_by,
              CASE WHEN (v.current_odometer_km - ms.last_service_km) >= ms.interval_km THEN 'overdue'
                   ELSE 'due_soon' END AS alert_level
       FROM fleet_maintenance_schedule ms
       JOIN fleet_vehicles v ON v.id = ms.vehicle_id
       JOIN fleet_maintenance_types t ON t.id = ms.maintenance_type_id
       LEFT JOIN sales_reps sr      ON sr.id = v.assigned_rep_id
       LEFT JOIN regions    rep_reg ON rep_reg.id = sr.region_id
       LEFT JOIN regions    v_reg   ON v_reg.id = v.region_id
       WHERE v.status <> 'sold'
         AND (v.current_odometer_km - ms.last_service_km) >= ms.interval_km * 0.9
         ${dueScope}
       ORDER BY ((v.current_odometer_km - ms.last_service_km) - ms.interval_km) DESC`,
      dueParams
    );

    const [doneR, dueR] = await Promise.all([doneQ, dueQ]);

    res.json({
      period: { from: dateFrom, to: dateTo },
      category_labels: await loadCategoryLabels(),
      done: doneR.rows,
      upcoming: dueR.rows,
    });
  } catch (err) {
    console.error('[Fleet] reports/maintenance:', err);
    res.status(500).json({ error: 'خطأ في تقرير الصيانة' });
  }
});

/* GET /api/fleet/reports/expenses?date_from=...&date_to=...&region_id=..&category=.. */
router.get('/reports/expenses', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  const dateFrom = String(req.query.date_from || '').trim();
  const dateTo   = String(req.query.date_to   || '').trim();
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'الفترة (من - إلى) مطلوبة' });
  if (dateTo < dateFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });

  const regionIds  = parseMulti(req.query.region_id)?.map(Number).filter(n => !isNaN(n)) || null;
  const categories = parseMulti(req.query.category) || null;

  try {
    const rowsParams = [dateFrom, dateTo];
    const rowsScope = buildScopeSql(rowsParams, regionIds, categories);
    const rowsQ = pool.query(
      `SELECT fe.id, fe.expense_date::text, v.id AS vehicle_id, v.plate_number, v.category,
              COALESCE(sr.region_id, v.region_id) AS region_id,
              COALESCE(rep_reg.name_ar, v_reg.name_ar) AS region_name,
              fe.category AS expense_category, fe.amount, fe.notes, fe.created_by_name
       FROM fleet_expenses fe
       JOIN fleet_vehicles v ON v.id = fe.vehicle_id
       LEFT JOIN sales_reps sr      ON sr.id = v.assigned_rep_id
       LEFT JOIN regions    rep_reg ON rep_reg.id = sr.region_id
       LEFT JOIN regions    v_reg   ON v_reg.id = v.region_id
       WHERE fe.expense_date BETWEEN $1::date AND $2::date${rowsScope}
       ORDER BY fe.expense_date DESC, fe.id DESC`,
      rowsParams
    );

    const byCatParams = [dateFrom, dateTo];
    const byCatScope = buildScopeSql(byCatParams, regionIds, categories);
    const byCatQ = pool.query(
      `SELECT fe.category, COUNT(*)::int AS n, SUM(fe.amount)::numeric AS total
       FROM fleet_expenses fe
       JOIN fleet_vehicles v ON v.id = fe.vehicle_id
       LEFT JOIN sales_reps sr ON sr.id = v.assigned_rep_id
       WHERE fe.expense_date BETWEEN $1::date AND $2::date${byCatScope}
       GROUP BY fe.category ORDER BY total DESC`,
      byCatParams
    );

    const byVehicleParams = [dateFrom, dateTo];
    const byVehicleScope = buildScopeSql(byVehicleParams, regionIds, categories);
    const byVehicleQ = pool.query(
      `SELECT v.id AS vehicle_id, v.plate_number, v.category, SUM(fe.amount)::numeric AS total, COUNT(*)::int AS n
       FROM fleet_expenses fe
       JOIN fleet_vehicles v ON v.id = fe.vehicle_id
       LEFT JOIN sales_reps sr ON sr.id = v.assigned_rep_id
       WHERE fe.expense_date BETWEEN $1::date AND $2::date${byVehicleScope}
       GROUP BY v.id, v.plate_number, v.category
       ORDER BY total DESC LIMIT 20`,
      byVehicleParams
    );

    const byMonthParams = [dateFrom, dateTo];
    const byMonthScope = buildScopeSql(byMonthParams, regionIds, categories);
    const byMonthQ = pool.query(
      `SELECT to_char(date_trunc('month', fe.expense_date), 'YYYY-MM') AS month, SUM(fe.amount)::numeric AS total
       FROM fleet_expenses fe
       JOIN fleet_vehicles v ON v.id = fe.vehicle_id
       LEFT JOIN sales_reps sr ON sr.id = v.assigned_rep_id
       WHERE fe.expense_date BETWEEN $1::date AND $2::date${byMonthScope}
       GROUP BY 1 ORDER BY 1`,
      byMonthParams
    );

    const [rowsR, byCatR, byVehicleR, byMonthR] = await Promise.all([rowsQ, byCatQ, byVehicleQ, byMonthQ]);

    res.json({
      period: { from: dateFrom, to: dateTo },
      category_labels: await loadCategoryLabels(),
      expense_category_labels: await loadExpenseCategoryLabels(),
      rows: rowsR.rows,
      by_category: byCatR.rows,
      by_vehicle: byVehicleR.rows,
      by_month: byMonthR.rows,
    });
  } catch (err) {
    console.error('[Fleet] reports/expenses:', err);
    res.status(500).json({ error: 'خطأ في تقرير المصروفات' });
  }
});

/* ════════════════════════════════════════════════════════════
   POST /api/fleet/import — bulk Excel import for vehicles + odometer
   readings, one file, two sheets ("السيارات" / "قراءات العداد"). The
   frontend's "تنزيل نموذج" button exports the SAME two sheets pre-filled
   with the current data (see FleetReportsTab's sibling in
   FleetManagementPage.jsx) — the admin edits/adds rows in Excel and
   re-uploads the whole thing here, which is why every vehicle column is
   fully overwritten from the sheet rather than partial-updated like
   PUT /vehicles/:id: a spreadsheet row has no way to represent "this
   field wasn't touched" the way a JSON body's absent key can, and the
   sheet was pre-filled with the CURRENT value anyway, so an untouched
   cell IS "no change" by construction. `status` is the one exception
   (COALESCE to the existing value) because it's NOT NULL with a fixed
   CHECK list — an unrecognized/blank cell there must not accidentally
   reset a vehicle's status.

   Vehicles are matched to existing rows by (normalized) plate_number — a
   match UPDATEs, no match INSERTs (and seeds its maintenance schedule,
   same as POST /vehicles). Odometer rows are matched to a vehicle the
   same way (including one just created by an earlier row in the SAME
   file) and follow the exact same "never regress current_odometer_km on
   a backdated entry" rule as POST /vehicles/:id/odometer. Everything
   commits in one transaction — a mid-file error rolls back the whole
   import rather than leaving it half-applied.
════════════════════════════════════════════════════════════ */
const normalizePlate = s => String(s || '').trim().replace(/\s+/g, ' ');
function parseExcelDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  const d = new Date(String(v).trim());
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
const cell = (row, ...keys) => {
  for (const k of keys) { if (row[k] !== undefined && row[k] !== '') return row[k]; }
  return '';
};
/* Excel re-saves a downloaded template's header row with EXTRA WHITESPACE
   around a header cell surprisingly easily (observed live: a user widened
   the "العداد الحالي (كم)" column and re-saved, and the column name came
   back as " العداد الحالي (كم) " — leading+trailing space) even though the
   original export has none. `cell()` above does exact key lookup, so an
   unnoticed whitespace change like that makes every row silently read as
   blank for that column — no error, just nothing updates, which is exactly
   how this bug first surfaced. Normalizing every parsed row's keys (trim +
   collapse internal whitespace) right after `sheet_to_json` makes the
   lookup tolerant of that without weakening the "must exactly match one of
   these header names" contract in any way a real header wouldn't already
   satisfy. */
const normalizeRowKeys = (row) => {
  const out = {};
  for (const k of Object.keys(row)) out[String(k).trim().replace(/\s+/g, ' ')] = row[k];
  return out;
};

router.get('/import/template-data', verifyToken, requirePagePermission('fleet_management', 1), async (req, res) => {
  // Everything the frontend needs to build the two-sheet template client-side
  // with Arabic labels (not raw keys) pre-filled, matching what /import parses back.
  try {
    const vehiclesR = await pool.query(
      `SELECT v.plate_number, v.category, v.assignment_type, sr.name_ar AS assigned_rep_name,
              v.assignment_label, v.driver_name,
              COALESCE(rep_reg.name_ar, v_reg.name_ar) AS region_name,
              v.make, v.model, v.model_year, v.status, v.current_odometer_km, v.notes
       FROM fleet_vehicles v
       LEFT JOIN sales_reps sr      ON sr.id = v.assigned_rep_id
       LEFT JOIN regions    rep_reg ON rep_reg.id = sr.region_id
       LEFT JOIN regions    v_reg   ON v_reg.id = v.region_id
       ORDER BY v.plate_number`
    );
    res.json({
      vehicles: vehiclesR.rows,
      category_labels: await loadCategoryLabels(),
    });
  } catch (err) {
    console.error('[Fleet] import template-data:', err);
    res.status(500).json({ error: 'خطأ في تجهيز نموذج الاستيراد' });
  }
});

router.post('/import', verifyToken, requirePagePermission('fleet_management', 2), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });

  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
  } catch (err) {
    return res.status(400).json({ error: 'تعذّر قراءة الملف — تأكد أنه ملف Excel صالح' });
  }

  const pgClient = await pool.connect();
  try {
    const [categories, regionsRes, repsRes, existingRes] = await Promise.all([
      loadVehicleCategories(),
      pool.query('SELECT id, name_ar FROM regions'),
      pool.query('SELECT id, name_ar FROM sales_reps WHERE is_active = TRUE'),
      pool.query('SELECT id, plate_number, current_odometer_km, assigned_rep_id FROM fleet_vehicles'),
    ]);
    const catByLabel = {};
    categories.forEach(c => { catByLabel[c.name_ar.trim()] = c.key; catByLabel[c.key] = c.key; });
    const regionByName = {};
    regionsRes.rows.forEach(r => { regionByName[r.name_ar.trim()] = r.id; });
    const repByName = {};
    repsRes.rows.forEach(r => { if (r.name_ar) repByName[r.name_ar.trim()] = r.id; });
    const ASSIGN_BY_LABEL = {
      'مندوب': 'rep', 'نقل بضاعة لمنطقة': 'region_transport',
      'نقل بضاعة لمزرعة/مسلخ': 'farm_slaughterhouse', 'غير مخصصة': 'unassigned',
      rep: 'rep', region_transport: 'region_transport',
      farm_slaughterhouse: 'farm_slaughterhouse', unassigned: 'unassigned',
    };
    const STATUS_BY_LABEL = {
      'نشطة': 'active', 'في الصيانة': 'in_maintenance', 'متوقفة': 'inactive', 'مُباعة': 'sold',
      active: 'active', in_maintenance: 'in_maintenance', inactive: 'inactive', sold: 'sold',
    };
    const vehicleByPlate = {};
    const vehicleCurrentKm = {}; // id → current_odometer_km, for the "العداد الحالي" cell diff-check below
    const vehicleOldRepId = {}; // id → assigned_rep_id BEFORE this import, for the rep-sync diff below
    existingRes.rows.forEach(v => {
      vehicleByPlate[normalizePlate(v.plate_number)] = v.id;
      vehicleCurrentKm[v.id] = Number(v.current_odometer_km || 0);
      vehicleOldRepId[v.id] = v.assigned_rep_id;
    });

    const vehSheetName = wb.SheetNames.find(n => /سيارات|vehicles/i.test(n)) || wb.SheetNames[0];
    const vehRows = vehSheetName
      ? XLSX.utils.sheet_to_json(wb.Sheets[vehSheetName], { defval: '' }).map(normalizeRowKeys)
      : [];

    // Odometer sheet is parsed UP FRONT (processed below, after the vehicle
    // loop) so a brand-new vehicle's INSERT can tell whether this same file
    // is ALSO about to log a real odometer reading for it. If so, the
    // vehicle row must NOT stamp odometer_updated_at = TODAY from its own
    // "العداد الحالي" cell — that would out-date the odometer sheet's real
    // (often past-dated) reading, and the odometer-regression guard on
    // fleet_odometer_readings' own UPDATE would then silently refuse to
    // roll current_odometer_km forward to the real reading. Leaving the new
    // row at the column default (0 / NULL updated_at) lets the odometer
    // sheet's own INSERT establish the baseline instead — its guard always
    // lets the FIRST reading through regardless of date.
    const odoSheetName = wb.SheetNames.find(n => /عداد|odometer/i.test(n));
    const odoRows = odoSheetName
      ? XLSX.utils.sheet_to_json(wb.Sheets[odoSheetName], { defval: '' }).map(normalizeRowKeys)
      : [];
    // Only a row that carries an ACTUAL reading counts as "the odometer
    // sheet claims this plate" — the exported template pre-fills a plate
    // cell for every vehicle on this sheet regardless of whether the admin
    // ever fills in a reading for it, so a blank km cell must NOT block the
    // vehicle-sheet's own "العداد الحالي" cell from being read (that was a
    // real bug: every vehicle in the odometer sheet, even fully blank rows,
    // was treated as "claimed", so NEITHER path ever updated the odometer).
    const odoPlateSet = new Set(
      odoRows
        .filter(r => {
          const km = cell(r, 'قراءة العداد (كم)', 'reading_km');
          return km !== '' && !isNaN(Number(km));
        })
        .map(r => normalizePlate(cell(r, 'رقم اللوحة', 'plate_number')))
        .filter(Boolean)
    );

    const vehErrors = [];
    let vehCreated = 0, vehUpdated = 0;
    // Shared with the "قراءات العداد" sheet loop further down — an existing
    // vehicle whose "العداد الحالي" cell was actually CHANGED (see the
    // UPDATE branch below) also logs a reading, so both paths feed the same
    // counters/arrays and the response's `odometer` totals cover either way
    // of updating a vehicle's odometer through this one file.
    const odoErrors = [];
    let odoCreated = 0;

    await pgClient.query('BEGIN');

    for (let i = 0; i < vehRows.length; i++) {
      const row = vehRows[i];
      const plate = String(cell(row, 'رقم اللوحة', 'plate_number')).trim();
      if (!plate) continue; // blank template row

      const catRaw = String(cell(row, 'التصنيف', 'category')).trim();
      const category = catRaw ? (catByLabel[catRaw] || null) : null;
      if (catRaw && !category) vehErrors.push(`سيارات صف ${i + 2}: تصنيف غير معروف "${catRaw}" — تُركت بدون تصنيف`);

      const assignRaw = String(cell(row, 'نوع التخصيص', 'assignment_type')).trim();
      const assignmentType = ASSIGN_BY_LABEL[assignRaw] || 'unassigned';
      if (assignRaw && !ASSIGN_BY_LABEL[assignRaw]) vehErrors.push(`سيارات صف ${i + 2}: نوع تخصيص غير معروف "${assignRaw}" — استُخدم "غير مخصصة"`);
      const isRep = assignmentType === 'rep';

      let assignedRepId = null;
      if (isRep) {
        const repName = String(cell(row, 'اسم المندوب', 'rep_name')).trim();
        assignedRepId = repByName[repName] || null;
        if (repName && !assignedRepId) vehErrors.push(`سيارات صف ${i + 2}: مندوب غير موجود "${repName}"`);
      }
      const driverName = !isRep ? (String(cell(row, 'اسم السائق', 'driver_name')).trim() || null) : null;
      const assignmentLabel = String(cell(row, 'وصف الجهة', 'assignment_label')).trim() || null;

      let regionId = null;
      if (!isRep) {
        const regionName = String(cell(row, 'المنطقة', 'region')).trim();
        regionId = regionByName[regionName] || null;
        if (regionName && !regionId) vehErrors.push(`سيارات صف ${i + 2}: منطقة غير معروفة "${regionName}"`);
      }

      const statusRaw = String(cell(row, 'الحالة', 'status')).trim();
      const status = STATUS_BY_LABEL[statusRaw] || null;
      if (statusRaw && !status) vehErrors.push(`سيارات صف ${i + 2}: حالة غير معروفة "${statusRaw}" — أُبقيت الحالة كما كانت`);

      const make  = String(cell(row, 'الشركة المصنّعة', 'الشركة المصنعة', 'make')).trim() || null;
      const model = String(cell(row, 'الموديل', 'model')).trim() || null;
      const modelYearRaw = cell(row, 'سنة الصنع', 'model_year');
      const modelYear = modelYearRaw !== '' ? Number(modelYearRaw) || null : null;
      const notes = String(cell(row, 'ملاحظات', 'notes')).trim() || null;
      const odometerRaw = cell(row, 'العداد الحالي (كم)', 'current_odometer_km');

      const plateKey = normalizePlate(plate);
      const existingId = vehicleByPlate[plateKey];

      if (existingId) {
        await pgClient.query(
          `UPDATE fleet_vehicles SET
             category = $1, assignment_type = $2, assigned_rep_id = $3, driver_name = $4,
             assignment_label = $5, region_id = $6, status = COALESCE($7, status),
             make = $8, model = $9, model_year = $10, notes = $11
           WHERE id = $12`,
          [category, assignmentType, isRep ? assignedRepId : null, driverName, assignmentLabel,
           isRep ? null : regionId, status, make, model, modelYear, notes, existingId]
        );
        vehUpdated++;

        // Same rep-vehicle_number sync as POST/PUT /vehicles — the plate
        // doesn't change in this branch (matched by plate), only who it's
        // assigned to can.
        await syncRepVehicleNumber(pgClient, {
          oldRepId: vehicleOldRepId[existingId], oldPlate: plate,
          newRepId: isRep ? assignedRepId : null, newPlate: plate,
        });

        // "العداد الحالي (كم)" on the vehicle sheet, for an EXISTING vehicle:
        // treated as a genuine new reading dated TODAY (the vehicle sheet has
        // no date column of its own — that's what "قراءات العداد" is for)
        // ONLY when the cell's value actually differs from what's on file.
        // Without the diff-check, simply re-uploading the template (every
        // row pre-filled with the CURRENT value, most of them untouched)
        // would log a redundant reading for every single vehicle on every
        // import. Skipped when this same file's odometer sheet ALSO carries
        // an explicit row for this plate — that row has a real date and
        // should be the one that decides, not an implicit "today" guess.
        if (!odoPlateSet.has(plateKey) && odometerRaw !== '' && !isNaN(Number(odometerRaw))) {
          const newKm = Number(odometerRaw);
          if (newKm !== vehicleCurrentKm[existingId]) {
            await pgClient.query(
              `INSERT INTO fleet_odometer_readings (vehicle_id, reading_km, reading_date, recorded_by, recorded_by_name)
               VALUES ($1, $2, CURRENT_DATE, $3, $4)`,
              [existingId, newKm, req.user.id, req.user.name || null]
            );
            await pgClient.query(
              `UPDATE fleet_vehicles
               SET current_odometer_km = $1, odometer_updated_at = CURRENT_DATE
               WHERE id = $2 AND (odometer_updated_at IS NULL OR CURRENT_DATE >= odometer_updated_at)`,
              [newKm, existingId]
            );
            odoCreated++;
          }
        }
      } else {
        // See the odoPlateSet comment above: a plate that ALSO has an
        // odometer-sheet row in this same file gets created at 0/NULL here
        // so that sheet's own (real-dated) reading establishes the baseline.
        const seedsFromOdoSheet = odoPlateSet.has(plateKey);
        const initialOdometer = seedsFromOdoSheet ? 0 : (odometerRaw !== '' ? Number(odometerRaw) || 0 : 0);
        const ir = await pgClient.query(
          `INSERT INTO fleet_vehicles
             (plate_number, category, assignment_type, assigned_rep_id, assignment_label, driver_name,
              region_id, make, model, model_year, status, current_odometer_km, odometer_updated_at, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11,'active'), $12::numeric,
                   CASE WHEN $12::numeric IS NOT NULL AND $12::numeric > 0 THEN CURRENT_DATE ELSE NULL END, $13, $14)
           RETURNING id`,
          [plate, category, assignmentType, isRep ? assignedRepId : null, assignmentLabel,
           isRep ? null : driverName, isRep ? null : regionId, make, model, modelYear, status,
           initialOdometer, notes, req.user.id]
        );
        // Same baseline rule as the single-vehicle POST /vehicles: seed the
        // schedule at the imported vehicle's OWN starting odometer, not 0 —
        // otherwise every bulk-imported vehicle with real km already on the
        // clock reads as instantly overdue for every maintenance type. Skip
        // the seedsFromOdoSheet case (initialOdometer forced to 0 above,
        // waiting on that sheet's own real reading) — 0 is correct there.
        await pgClient.query(
          `INSERT INTO fleet_maintenance_schedule (vehicle_id, maintenance_type_id, interval_km, last_service_km)
           SELECT $1, t.id, t.default_interval_km, $2::numeric FROM fleet_maintenance_types t WHERE t.is_active = TRUE`,
          [ir.rows[0].id, initialOdometer]
        );
        vehicleByPlate[plateKey] = ir.rows[0].id; // resolvable by an odometer-sheet row below, same file
        vehCreated++;

        if (isRep && assignedRepId) {
          await syncRepVehicleNumber(pgClient, { oldRepId: null, oldPlate: null, newRepId: assignedRepId, newPlate: plate });
        }
      }
    }

    /* ── قراءات العداد (odoSheetName/odoRows/odoErrors/odoCreated already declared above) ──
       The template pre-fills a plate cell on this sheet for EVERY vehicle,
       whether or not the admin ever fills in a reading for it — a blank
       km cell here is the normal "didn't touch this row" case, not a
       mistake, so it's skipped silently rather than reported as an error
       (a genuinely blank-but-otherwise-real row would just flood the
       result with 30+ scary-looking messages for something that isn't
       wrong). Only a row with an unresolvable PLATE is a real error. */
    for (let i = 0; i < odoRows.length; i++) {
      const row = odoRows[i];
      const plate = String(cell(row, 'رقم اللوحة', 'plate_number')).trim();
      if (!plate) continue;

      const kmRaw = cell(row, 'قراءة العداد (كم)', 'reading_km');
      if (kmRaw === '' || isNaN(Number(kmRaw))) continue; // untouched placeholder row — not an error

      const vehicleId = vehicleByPlate[normalizePlate(plate)];
      if (!vehicleId) { odoErrors.push(`قراءات العداد صف ${i + 2}: سيارة غير موجودة برقم لوحة "${plate}"`); continue; }

      const readingDate = parseExcelDate(cell(row, 'تاريخ القراءة', 'reading_date'));
      await pgClient.query(
        `INSERT INTO fleet_odometer_readings (vehicle_id, reading_km, reading_date, recorded_by, recorded_by_name)
         VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5)`,
        [vehicleId, Number(kmRaw), readingDate, req.user.id, req.user.name || null]
      );
      await pgClient.query(
        `UPDATE fleet_vehicles
         SET current_odometer_km = $1, odometer_updated_at = COALESCE($2, CURRENT_DATE)
         WHERE id = $3 AND (odometer_updated_at IS NULL OR COALESCE($2, CURRENT_DATE) >= odometer_updated_at)`,
        [Number(kmRaw), readingDate, vehicleId]
      );
      odoCreated++;
    }

    await pgClient.query('COMMIT');
    res.json({
      ok: true,
      vehicles: { created: vehCreated, updated: vehUpdated, errors: vehErrors },
      odometer: { created: odoCreated, errors: odoErrors },
    });
  } catch (err) {
    await pgClient.query('ROLLBACK');
    console.error('[Fleet] import:', err);
    res.status(500).json({ error: 'خطأ في استيراد الملف — لم يتم حفظ أي بيانات' });
  } finally {
    pgClient.release();
  }
});

module.exports = router;
