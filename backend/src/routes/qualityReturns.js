/**
 * qualityReturns.js — /api/quality-returns/*
 *
 * Daily مرتجعات عيوب الجودة (quality-defect returns) entry, by item × route,
 * for a whole region at once, logged by a dedicated "مراقب مرتجعات جودة"
 * (quality_returns_monitor) account assigned to one or more regions.
 *
 * Distinct from every other توالف/quality figure in the app:
 *  - quality_issues.js — a NetSuite-uploaded warehouse/QC report, region-only,
 *    no route/rep dimension, no manual entry.
 *  - carrefour_damage_*.js — a different business (Carrefour branches, not
 *    regions/routes), separate tables/roles entirely.
 * This one is hand-entered against real routes/reps (sales_reps, routes) —
 * no separate "branch" concept is invented here, unlike Carrefour.
 *
 * The item list is NOT a manually-maintained catalog — it's pulled live from
 * sales_activity.item_name_en (small enough, ~65 distinct items, to render
 * as full grid rows).
 *
 * Two page keys gate this file:
 *  - 'quality_returns_entry'  — the monitor's daily grid. Also used by
 *    admins for settings (region↔monitor assignment) and on-behalf entry.
 *  - 'quality_returns_report' — the management search/report.
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const pool    = require('../db/pool');
const { verifyToken, requireRoles, requirePagePermission } = require('../middleware/auth');

/* ── Photo attachment storage — same convention as carrefourDamage.js:
   <UPLOAD_DIR>/quality-returns-photos/<region_id>/<report_date>/ ── */
const PHOTOS_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads', 'quality-returns-photos');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

function fixName(raw) {
  try { return Buffer.from(raw, 'latin1').toString('utf8'); } catch { return raw; }
}

const photoStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const { region_id, report_date } = req.body;
    const dir = path.join(PHOTOS_DIR, String(region_id || 'unknown'), String(report_date || 'unknown'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ts   = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const name = fixName(file.originalname);
    const safe = name.replace(/[^a-zA-Z0-9.؀-ۿ_-]/g, '_');
    cb(null, `${ts}-${safe}`);
  },
});
const photoFileFilter = (_req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
  const ext = path.extname(file.originalname).toLowerCase();
  cb(allowed.includes(ext) ? null : new Error('يُسمح فقط بملفات الصور (jpg, png, webp, heic)'), allowed.includes(ext));
};
const photoUpload = multer({
  storage: photoStorage,
  fileFilter: photoFileFilter,
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
});

const router = express.Router();

const ADMIN_ROLES = ['super_admin', 'it_admin'];

/* Resolves the region ids a quality_returns_monitor is allowed to touch.
   Admins pass null, meaning "no restriction" (any region, on-behalf entry). */
async function allowedRegionIds(user) {
  if (ADMIN_ROLES.includes(user.role)) return null;
  const { rows } = await pool.query(
    'SELECT region_id FROM quality_returns_region_monitors WHERE user_id = $1', [user.id]
  );
  return rows.map(r => r.region_id);
}

/* ════════════════════════════════════════════════════════════
   Settings — region ↔ monitor assignment (admin only)
════════════════════════════════════════════════════════════ */
router.get('/regions-admin', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT reg.id, reg.name_ar,
              COALESCE(
                (SELECT json_agg(json_build_object('user_id', u.id, 'name', u.name, 'email', u.email) ORDER BY u.name)
                 FROM quality_returns_region_monitors qrm JOIN users u ON u.id = qrm.user_id
                 WHERE qrm.region_id = reg.id),
                '[]'
              ) AS monitors
       FROM regions reg
       ORDER BY reg.name_ar`
    );
    res.json(rows);
  } catch (err) {
    console.error('[QualityReturns] regions-admin:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/regions/:id/assign', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const userId = req.body.user_id;
  if (!userId) return res.status(400).json({ error: 'المستخدم مطلوب' });
  try {
    const u = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!u.rows.length) return res.status(404).json({ error: 'المستخدم غير موجود' });
    await pool.query(
      `INSERT INTO quality_returns_region_monitors (region_id, user_id) VALUES ($1, $2)
       ON CONFLICT (region_id, user_id) DO NOTHING`,
      [req.params.id, userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[QualityReturns] assign:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.delete('/regions/:id/assign/:userId', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM quality_returns_region_monitors WHERE region_id = $1 AND user_id = $2',
      [req.params.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Monitor accounts, for the assignment dropdown
router.get('/monitors', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM users WHERE role = 'quality_returns_monitor' AND is_active = TRUE ORDER BY name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════
   Entry — regions/routes/items available to the current user
════════════════════════════════════════════════════════════ */

// Regions the current user may log against (own assignments, or every
// region for an admin doing on-behalf entry).
router.get('/my-regions', verifyToken, requirePagePermission('quality_returns_entry', 1), async (req, res) => {
  try {
    const ids = await allowedRegionIds(req.user);
    // fleet_only rows (fleet-vehicle warehouses) are never a real quality-returns region.
    const { rows } = ids
      ? await pool.query('SELECT id, name_ar FROM regions WHERE id = ANY($1::int[]) AND fleet_only = false ORDER BY name_ar', [ids])
      : await pool.query('SELECT id, name_ar FROM regions WHERE fleet_only = false ORDER BY name_ar');
    res.json(rows);
  } catch (err) {
    console.error('[QualityReturns] my-regions:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Every route in a region (active or not), each with its assigned rep(s) and
// its is_active flag — powers the admin's route on/off toggle panel on the
// entry page. Only ACTIVE routes are the ones the /entry grid renders as
// columns (the same filter is applied inline in GET /entry below).
router.get('/routes', verifyToken, requirePagePermission('quality_returns_entry', 1), async (req, res) => {
  const regionId = Number(req.query.region_id);
  if (!regionId) return res.status(400).json({ error: 'المنطقة مطلوبة' });
  try {
    const ids = await allowedRegionIds(req.user);
    if (ids && !ids.includes(regionId)) {
      return res.status(403).json({ error: 'هذه المنطقة غير مخصصة لك' });
    }
    const { rows } = await pool.query(
      `SELECT r.route_id, COALESCE(qrs.is_active, FALSE) AS is_active,
              COALESCE(
                (SELECT json_agg(json_build_object('name', sr.name_ar, 'vehicle_number', sr.vehicle_number))
                 FROM sales_reps sr WHERE sr.route_id = r.route_id AND sr.is_active = TRUE),
                '[]'
              ) AS reps
       FROM routes r
       LEFT JOIN quality_returns_route_settings qrs ON qrs.route_id = r.route_id
       WHERE r.region_id = $1
       ORDER BY r.route_id`,
      [regionId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[QualityReturns] routes:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Toggle one route on/off for the entry grid. Originally admin-only, but
// that meant the actual daily user (the region's assigned monitor — the
// one who actually suffers from a too-wide grid) had no way to control
// it themselves and had to ask an admin every time. Opened to anyone with
// edit access to quality_returns_entry (same level POST /entry requires),
// scoped to the monitor's own assigned region(s) — same allowedRegionIds
// check GET /routes already uses, so a monitor can't touch a route
// belonging to a region they're not assigned to.
router.put('/routes/:routeId/active', verifyToken, requirePagePermission('quality_returns_entry', 2), async (req, res) => {
  const isActive = !!req.body.is_active;
  try {
    const ids = await allowedRegionIds(req.user);
    if (ids) {
      const routeRegion = await pool.query('SELECT region_id FROM routes WHERE route_id = $1', [req.params.routeId]);
      if (!routeRegion.rows.length || !ids.includes(routeRegion.rows[0].region_id)) {
        return res.status(403).json({ error: 'هذا الخط غير مخصص لمنطقتك' });
      }
    }
    await pool.query(
      `INSERT INTO quality_returns_route_settings (route_id, is_active, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (route_id) DO UPDATE SET is_active = EXCLUDED.is_active, updated_at = NOW()`,
      [req.params.routeId, isActive]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[QualityReturns] route toggle:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* Item list — the SET of items is live from sales_activity (never a
   maintained catalog), but sales_activity has NO Arabic name or item code
   anywhere in the schema — quality_returns_item_info is a pure DISPLAY
   overlay keyed on the same item_name_en identity, optional per item, never
   the join key for anything (a blank row just falls back to the English
   name). item_category comes from the item's most recent sales_activity
   row (report_year/month_num DESC) in case it ever shifted category. */
async function fetchItemList() {
  const { rows } = await pool.query(`
    SELECT item_name_en, item_category_en AS item_category, item_name_ar, item_code
    FROM (
      SELECT DISTINCT ON (sa.item_name_en)
             sa.item_name_en, sa.item_category_en, ii.item_name_ar, ii.item_code
      FROM sales_activity sa
      LEFT JOIN quality_returns_item_info ii ON ii.item_name_en = sa.item_name_en
      WHERE sa.item_name_en IS NOT NULL AND TRIM(sa.item_name_en) <> ''
      ORDER BY sa.item_name_en, sa.report_year DESC, sa.month_num DESC
    ) x
    ORDER BY COALESCE(NULLIF(TRIM(item_category_en), ''), 'zzz'), COALESCE(item_name_ar, item_name_en)
  `);
  return rows;
}

router.get('/items', verifyToken, requirePagePermission('quality_returns_entry', 1), async (req, res) => {
  try {
    res.json(await fetchItemList());
  } catch (err) {
    console.error('[QualityReturns] items:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Settings — admin edits the Arabic name / code overlay for one item.
router.put('/item-info', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const itemNameEn = String(req.body.item_name_en || '').trim();
  if (!itemNameEn) return res.status(400).json({ error: 'الصنف مطلوب' });
  try {
    await pool.query(
      `INSERT INTO quality_returns_item_info (item_name_en, item_name_ar, item_code, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (item_name_en) DO UPDATE SET
         item_name_ar = EXCLUDED.item_name_ar,
         item_code    = EXCLUDED.item_code,
         updated_at   = NOW()`,
      [itemNameEn, req.body.item_name_ar?.trim() || null, req.body.item_code?.trim() || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[QualityReturns] item-info update:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

async function allCategories() {
  const items = await fetchItemList();
  return [...new Set(items.map(it => it.item_category || 'غير مصنف'))];
}

// Item-category visibility for the entry grid — two layers:
//  1. Admin-mandated categories (quality_returns_mandatory_categories) are
//     forced active for EVERY user and cannot be turned off by them.
//  2. Everything else is a per-user optional extra
//     (quality_returns_user_category_prefs) the user opts into themselves.
// A category that's neither mandatory nor opted into defaults to INACTIVE
// (the admin curates the baseline; users add what they personally need) —
// this is a deliberate change from the feature's first version, where an
// untouched category defaulted to active for everyone.
router.get('/category-prefs', verifyToken, requirePagePermission('quality_returns_entry', 1), async (req, res) => {
  try {
    const categories = await allCategories();
    const mandatoryQ = await pool.query('SELECT item_category FROM quality_returns_mandatory_categories');
    const mandatorySet = new Set(mandatoryQ.rows.map(r => r.item_category));
    const userQ = await pool.query(
      'SELECT item_category, is_active FROM quality_returns_user_category_prefs WHERE user_id = $1',
      [req.user.id]
    );
    const userMap = Object.fromEntries(userQ.rows.map(r => [r.item_category, r.is_active]));
    res.json(categories.map(cat => {
      const isMandatory = mandatorySet.has(cat);
      return {
        item_category: cat,
        is_mandatory: isMandatory,
        is_active: isMandatory ? true : !!userMap[cat],
      };
    }));
  } catch (err) {
    console.error('[QualityReturns] category-prefs:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.put('/category-prefs', verifyToken, requirePagePermission('quality_returns_entry', 1), async (req, res) => {
  const category = String(req.body.item_category || '').trim();
  if (!category) return res.status(400).json({ error: 'الفئة مطلوبة' });
  try {
    // Mandatory categories can't be turned off by a user — reject rather
    // than silently no-op, so the UI's disabled toggle is backed by a real
    // guarantee, not just client-side politeness.
    const mandatory = await pool.query(
      'SELECT 1 FROM quality_returns_mandatory_categories WHERE item_category = $1', [category]
    );
    if (mandatory.rows.length) {
      return res.status(409).json({ error: 'هذه الفئة إجبارية من الإدارة ولا يمكن إلغاء تفعيلها' });
    }
    await pool.query(
      `INSERT INTO quality_returns_user_category_prefs (user_id, item_category, is_active, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, item_category) DO UPDATE SET is_active = EXCLUDED.is_active, updated_at = NOW()`,
      [req.user.id, category, !!req.body.is_active]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[QualityReturns] category-prefs update:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Admin settings — which categories are mandatory for everyone.
router.get('/mandatory-categories', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const categories = await allCategories();
    const mandatoryQ = await pool.query('SELECT item_category FROM quality_returns_mandatory_categories');
    const mandatorySet = new Set(mandatoryQ.rows.map(r => r.item_category));
    res.json(categories.map(cat => ({ item_category: cat, is_mandatory: mandatorySet.has(cat) })));
  } catch (err) {
    console.error('[QualityReturns] mandatory-categories:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.put('/mandatory-categories', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const category = String(req.body.item_category || '').trim();
  if (!category) return res.status(400).json({ error: 'الفئة مطلوبة' });
  try {
    if (req.body.is_mandatory) {
      await pool.query(
        `INSERT INTO quality_returns_mandatory_categories (item_category, set_by, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (item_category) DO UPDATE SET set_by = EXCLUDED.set_by, updated_at = NOW()`,
        [category, req.user.id]
      );
    } else {
      await pool.query('DELETE FROM quality_returns_mandatory_categories WHERE item_category = $1', [category]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[QualityReturns] mandatory-categories update:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/entry', verifyToken, requirePagePermission('quality_returns_entry', 1), async (req, res) => {
  const regionId = Number(req.query.region_id);
  const date = String(req.query.date || '').trim();
  if (!regionId || !date) return res.status(400).json({ error: 'المنطقة والتاريخ مطلوبان' });

  try {
    const ids = await allowedRegionIds(req.user);
    if (ids && !ids.includes(regionId)) {
      return res.status(403).json({ error: 'هذه المنطقة غير مخصصة لك' });
    }

    // Only routes turned on via the admin toggle render as grid columns —
    // see PUT /routes/:routeId/active and the default "first 5" seed in
    // migration 097.
    const routes = await pool.query(
      `SELECT r.route_id,
              COALESCE(
                (SELECT json_agg(json_build_object('name', sr.name_ar, 'vehicle_number', sr.vehicle_number))
                 FROM sales_reps sr WHERE sr.route_id = r.route_id AND sr.is_active = TRUE),
                '[]'
              ) AS reps
       FROM routes r
       JOIN quality_returns_route_settings qrs ON qrs.route_id = r.route_id AND qrs.is_active = TRUE
       WHERE r.region_id = $1 ORDER BY r.route_id`,
      [regionId]
    );
    const items = await fetchItemList();
    const report = await pool.query(
      `SELECT id, region_id, report_date::text AS report_date, submitted_by, submitted_by_name,
              notes, report_no, created_at, updated_at
       FROM quality_returns_reports WHERE region_id = $1 AND report_date = $2`,
      [regionId, date]
    );
    let lines = [];
    if (report.rows.length) {
      const li = await pool.query(
        `SELECT route_id, item_name, quantity, expiry_date::text AS expiry_date, notes
         FROM quality_returns_report_lines WHERE report_id = $1`,
        [report.rows[0].id]
      );
      lines = li.rows;
    }

    res.json({
      routes: routes.rows,
      items,
      report: report.rows[0] || null,
      lines,
    });
  } catch (err) {
    console.error('[QualityReturns] entry fetch:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/entry', verifyToken, requirePagePermission('quality_returns_entry', 2), async (req, res) => {
  const regionId = Number(req.body.region_id);
  const date = String(req.body.report_date || '').trim();
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  const notes = req.body.notes != null ? String(req.body.notes).trim() || null : null;

  if (!regionId || !date) return res.status(400).json({ error: 'المنطقة والتاريخ مطلوبان' });

  try {
    const ids = await allowedRegionIds(req.user);
    if (ids && !ids.includes(regionId)) {
      return res.status(403).json({ error: 'هذه المنطقة غير مخصصة لك' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const upserted = await client.query(
        `INSERT INTO quality_returns_reports (region_id, report_date, submitted_by, submitted_by_name, notes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (region_id, report_date) DO UPDATE SET
           submitted_by      = EXCLUDED.submitted_by,
           submitted_by_name = EXCLUDED.submitted_by_name,
           notes             = EXCLUDED.notes,
           updated_at        = NOW()
         RETURNING id`,
        [regionId, date, req.user.id, req.user.name || null, notes]
      );
      const reportId = upserted.rows[0].id;

      await client.query('DELETE FROM quality_returns_report_lines WHERE report_id = $1', [reportId]);

      let totalQty = 0;
      if (lines.length) {
        const values = [];
        const placeholders = lines.map((ln, idx) => {
          const qty = Number(ln.quantity) || 0;
          totalQty += qty;
          const base = idx * 6;
          values.push(
            reportId, Number(ln.route_id), String(ln.item_name || '').trim(), qty,
            ln.expiry_date || null, ln.notes != null ? String(ln.notes).trim() || null : null
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        }).join(', ');
        await client.query(
          `INSERT INTO quality_returns_report_lines (report_id, route_id, item_name, quantity, expiry_date, notes) VALUES ${placeholders}`,
          values
        );
      }

      // Signature log: append, never overwrite — proves who saved this
      // region/date and when, even across repeated edits the same day.
      await client.query(
        `INSERT INTO quality_returns_save_log (region_id, report_date, saved_by, saved_by_name, total_qty)
         VALUES ($1, $2, $3, $4, $5)`,
        [regionId, date, req.user.id, req.user.name || null, totalQty]
      );

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ ok: true, region_id: regionId, report_date: date });
  } catch (err) {
    console.error('[QualityReturns] entry save:', err);
    res.status(500).json({ error: 'خطأ في حفظ التقرير' });
  }
});

// Signature log for one region/date — who saved it and when, every save
// kept (not just the latest). Same ownership scoping as /entry.
router.get('/save-log', verifyToken, requirePagePermission('quality_returns_entry', 1), async (req, res) => {
  const regionId = Number(req.query.region_id);
  const date = String(req.query.date || '').trim();
  if (!regionId || !date) return res.status(400).json({ error: 'المنطقة والتاريخ مطلوبان' });
  try {
    const ids = await allowedRegionIds(req.user);
    if (ids && !ids.includes(regionId)) {
      return res.status(403).json({ error: 'هذه المنطقة غير مخصصة لك' });
    }
    const { rows } = await pool.query(
      `SELECT saved_by_name, total_qty, saved_at FROM quality_returns_save_log
       WHERE region_id = $1 AND report_date = $2 ORDER BY saved_at DESC`,
      [regionId, date]
    );
    res.json(rows);
  } catch (err) {
    console.error('[QualityReturns] save-log:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════
   Photo attachments — attach before/after saving the entry (kept on
   region/date directly, not on the report row's id).
════════════════════════════════════════════════════════════ */
router.get('/photos', verifyToken, requirePagePermission('quality_returns_entry', 1), async (req, res) => {
  const regionId = Number(req.query.region_id);
  const date = String(req.query.date || '').trim();
  if (!regionId || !date) return res.status(400).json({ error: 'المنطقة والتاريخ مطلوبان' });
  try {
    const ids = await allowedRegionIds(req.user);
    if (ids && !ids.includes(regionId)) {
      return res.status(403).json({ error: 'هذه المنطقة غير مخصصة لك' });
    }
    const { rows } = await pool.query(
      `SELECT id, file_path, original_filename, uploaded_by_name, uploaded_at
       FROM quality_returns_report_photos
       WHERE region_id = $1 AND report_date = $2 ORDER BY uploaded_at DESC`,
      [regionId, date]
    );
    res.json(rows.map(r => ({ ...r, url: `/uploads/${r.file_path}` })));
  } catch (err) {
    console.error('[QualityReturns] photos list:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/photos', verifyToken, requirePagePermission('quality_returns_entry', 2),
  // multipart/form-data isn't parsed into req.body until multer runs, so
  // the region-ownership check can only happen AFTER this — a forbidden
  // request's files land on disk first and are deleted below when rejected.
  (req, res, next) => photoUpload.array('files', 10)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'خطأ في رفع الصور' });
    next();
  }),
  async (req, res) => {
    const { region_id, report_date } = req.body;
    const regionId = Number(region_id);
    const date = String(report_date || '').trim();
    const cleanupFiles = () => (req.files || []).forEach(f => fs.unlink(f.path, () => {}));

    if (!regionId || !date) {
      cleanupFiles();
      return res.status(400).json({ error: 'المنطقة والتاريخ مطلوبان' });
    }
    const ids = await allowedRegionIds(req.user);
    if (ids && !ids.includes(regionId)) {
      cleanupFiles();
      return res.status(403).json({ error: 'هذه المنطقة غير مخصصة لك' });
    }
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'لم يتم اختيار أي صور' });
    }

    try {
      const inserted = [];
      for (const f of req.files) {
        const relPath = path.relative(path.resolve(process.env.UPLOAD_DIR || './uploads'), f.path).split(path.sep).join('/');
        const { rows } = await pool.query(
          `INSERT INTO quality_returns_report_photos
             (region_id, report_date, file_path, original_filename, uploaded_by, uploaded_by_name)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, file_path, original_filename, uploaded_by_name, uploaded_at`,
          [regionId, date, relPath, fixName(f.originalname), req.user.id, req.user.name || null]
        );
        inserted.push({ ...rows[0], url: `/uploads/${rows[0].file_path}` });
      }
      res.status(201).json(inserted);
    } catch (err) {
      console.error('[QualityReturns] photos upload:', err);
      res.status(500).json({ error: 'خطأ في حفظ الصور' });
    }
  }
);

router.delete('/photos/:id', verifyToken, requirePagePermission('quality_returns_entry', 2), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM quality_returns_report_photos WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'الصورة غير موجودة' });
    const photo = rows[0];

    const ids = await allowedRegionIds(req.user);
    if (ids && !ids.includes(photo.region_id)) {
      return res.status(403).json({ error: 'هذه المنطقة غير مخصصة لك' });
    }

    await pool.query('DELETE FROM quality_returns_report_photos WHERE id = $1', [req.params.id]);
    const fullPath = path.join(path.resolve(process.env.UPLOAD_DIR || './uploads'), photo.file_path);
    fs.unlink(fullPath, () => {}); // best-effort — a missing file must not block the DB delete
    res.json({ ok: true });
  } catch (err) {
    console.error('[QualityReturns] photo delete:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Same photo list as /photos above, but gated by the REPORT permission
// (not the entry one) and with no region-ownership restriction — a report
// viewer sees every region's data already, so its attached photos too.
router.get('/report-photos', verifyToken, requirePagePermission('quality_returns_report', 1), async (req, res) => {
  const regionId = Number(req.query.region_id);
  const date = String(req.query.date || '').trim();
  if (!regionId || !date) return res.status(400).json({ error: 'المنطقة والتاريخ مطلوبان' });
  try {
    const { rows } = await pool.query(
      `SELECT id, file_path, original_filename, uploaded_by_name, uploaded_at
       FROM quality_returns_report_photos
       WHERE region_id = $1 AND report_date = $2 ORDER BY uploaded_at DESC`,
      [regionId, date]
    );
    res.json(rows.map(r => ({ ...r, url: `/uploads/${r.file_path}` })));
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════
   Report — filter option lists
════════════════════════════════════════════════════════════ */
router.get('/filters', verifyToken, requirePagePermission('quality_returns_report', 1), async (req, res) => {
  try {
    const regions = await pool.query('SELECT id, name_ar FROM regions WHERE fleet_only = false ORDER BY name_ar');
    const routes = await pool.query('SELECT route_id, region_id FROM routes ORDER BY route_id');
    const items = await fetchItemList();
    res.json({ regions: regions.rows, routes: routes.rows, items });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════
   Report — management search across all regions, with date range
════════════════════════════════════════════════════════════ */
router.get('/report', verifyToken, requirePagePermission('quality_returns_report', 1), async (req, res) => {
  const { date_from, date_to, region_id, route_id, item } = req.query;
  const dateFrom = date_from || '1900-01-01';
  const dateTo   = date_to   || '2999-12-31';

  const cond = ['r.report_date BETWEEN $1 AND $2'];
  const params = [dateFrom, dateTo];
  if (region_id) { params.push(Number(region_id)); cond.push(`r.region_id = $${params.length}`); }
  if (route_id)  { params.push(Number(route_id));  cond.push(`rl.route_id = $${params.length}`); }
  if (item)      { params.push(item);              cond.push(`rl.item_name = $${params.length}`); }
  const where = cond.join(' AND ');

  try {
    const rows = await pool.query(
      `SELECT r.id AS report_id, r.report_no, r.report_date::text AS report_date, r.region_id, reg.name_ar AS region_name,
              r.submitted_by_name, r.notes AS report_notes,
              rl.route_id, rl.item_name, ii.item_name_ar, ii.item_code, rl.quantity, rl.expiry_date::text AS expiry_date, rl.notes,
              (SELECT string_agg(DISTINCT sr.name_ar, '، ') FROM sales_reps sr
                 WHERE sr.route_id = rl.route_id AND sr.is_active = TRUE) AS rep_names,
              (SELECT string_agg(DISTINCT sr.vehicle_number, '، ') FROM sales_reps sr
                 WHERE sr.route_id = rl.route_id AND sr.is_active = TRUE AND sr.vehicle_number IS NOT NULL) AS vehicle_numbers
       FROM quality_returns_reports r
       JOIN regions reg ON reg.id = r.region_id
       LEFT JOIN quality_returns_report_lines rl ON rl.report_id = r.id
       LEFT JOIN quality_returns_item_info ii ON ii.item_name_en = rl.item_name
       WHERE ${where}
       ORDER BY r.report_date DESC, reg.name_ar, rl.route_id`,
      params
    );

    const totalsQ = await pool.query(
      `SELECT COUNT(DISTINCT r.id)::int AS total_reports,
              COUNT(DISTINCT r.region_id)::int AS regions_reported,
              COUNT(DISTINCT rl.route_id)::int AS routes_reported,
              COALESCE(SUM(rl.quantity), 0) AS total_qty
       FROM quality_returns_reports r
       LEFT JOIN quality_returns_report_lines rl ON rl.report_id = r.id
       WHERE ${where}`,
      params
    );

    // "Total" here means regions actually assigned a monitor (the ones this
    // program can realistically expect a report from), not every region
    // the company has — a region nobody covers would otherwise permanently
    // drag the compliance percentage down for no actionable reason.
    const regionsTotalQ = await pool.query(
      'SELECT COUNT(DISTINCT region_id)::int AS n FROM quality_returns_region_monitors'
    );
    const routesTotalQ = await pool.query(
      `SELECT COUNT(*)::int AS n FROM routes r
       WHERE EXISTS (SELECT 1 FROM quality_returns_region_monitors qrm WHERE qrm.region_id = r.region_id)`
    );

    const latestDateQ = await pool.query(
      `SELECT MAX(report_date)::text AS d FROM quality_returns_reports WHERE report_date BETWEEN $1 AND $2`,
      [dateFrom, dateTo]
    );
    const latestDate = latestDateQ.rows[0].d;
    let missingToday = [];
    if (latestDate) {
      const missing = await pool.query(
        `SELECT DISTINCT reg.id, reg.name_ar
         FROM regions reg
         JOIN quality_returns_region_monitors qrm ON qrm.region_id = reg.id
         WHERE NOT EXISTS (
           SELECT 1 FROM quality_returns_reports r
           WHERE r.region_id = reg.id AND r.report_date = $1
         )
         ORDER BY reg.name_ar`,
        [latestDate]
      );
      missingToday = missing.rows;
    }

    res.json({
      rows: rows.rows,
      totals: {
        ...totalsQ.rows[0],
        regions_total: regionsTotalQ.rows[0].n,
        routes_total: routesTotalQ.rows[0].n,
      },
      latest_date: latestDate,
      missing_latest_date: missingToday,
    });
  } catch (err) {
    console.error('[QualityReturns] report:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
