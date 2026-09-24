/**
 * carrefourDamage.js — /api/carrefour-damage/*
 *
 * Daily توالف (damage) entry for Carrefour branches, logged by a dedicated
 * "مروج" (carrefour_rep) account assigned to one or more branches, broken
 * down by item. Distinct from every other توالف figure in the app
 * (quality_issues, sales_activity.bad_return_qty) — those are uploaded from
 * NetSuite exports; this is hand-entered, hand-maintained (branches + item
 * catalog + branch↔rep assignment are all manual, no file feeds them).
 *
 * Two page keys gate this file:
 *  - 'carrefour_damage_entry'  — the promoter's daily entry form. Also used
 *    by admins for settings (branches/items/assignment) and on-behalf entry.
 *  - 'carrefour_damage_report' — the management roll-up.
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const pool    = require('../db/pool');
const { verifyToken, requireRoles, requirePagePermission } = require('../middleware/auth');

const router = express.Router();

const ADMIN_ROLES = ['super_admin', 'it_admin'];

/* ── Photo attachment storage ──────────────────────────────────
   Laid out on disk as <UPLOAD_DIR>/carrefour-photos/<report_type>/<branch_id>/<report_date>/
   — a numeric branch_id keeps the path filesystem-safe; the "album" grouping
   by branch NAME + date the report page shows is done from the DB columns,
   not from this folder layout. */
const PHOTOS_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads', 'carrefour-photos');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

function fixName(raw) {
  try { return Buffer.from(raw, 'latin1').toString('utf8'); } catch { return raw; }
}

const photoStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const { report_type, branch_id, report_date } = req.body;
    const dir = path.join(PHOTOS_DIR, String(report_type || 'unknown'), String(branch_id || 'unknown'), String(report_date || 'unknown'));
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

/* Resolves the branch ids a carrefour_rep is allowed to touch. Admins pass
   null, meaning "no restriction" (any branch, for on-behalf entry). */
async function allowedBranchIds(user) {
  if (ADMIN_ROLES.includes(user.role)) return null;
  const { rows } = await pool.query(
    'SELECT branch_id FROM carrefour_branch_reps WHERE user_id = $1', [user.id]
  );
  return rows.map(r => r.branch_id);
}

/* ════════════════════════════════════════════════════════════
   Settings — branches (admin only)
════════════════════════════════════════════════════════════ */
router.get('/branches', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.branch_name, b.branch_code, b.is_active, b.created_at,
              COALESCE(
                (SELECT json_agg(json_build_object('user_id', u.id, 'name', u.name, 'email', u.email) ORDER BY u.name)
                 FROM carrefour_branch_reps cbr JOIN users u ON u.id = cbr.user_id
                 WHERE cbr.branch_id = b.id),
                '[]'
              ) AS reps
       FROM carrefour_branches b
       ORDER BY b.branch_name`
    );
    res.json(rows);
  } catch (err) {
    console.error('[CarrefourDamage] branches list:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/branches', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const branchName = String(req.body.branch_name || '').trim();
  const branchCode = String(req.body.branch_code || '').trim() || null;
  if (!branchName) return res.status(400).json({ error: 'اسم الفرع مطلوب' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO carrefour_branches (branch_name, branch_code, created_by)
       VALUES ($1, $2, $3) RETURNING *`,
      [branchName, branchCode, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'كود الفرع مستخدم بالفعل' });
    console.error('[CarrefourDamage] branch create:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.put('/branches/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const { branch_name, branch_code, is_active } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE carrefour_branches SET
         branch_name = COALESCE($1, branch_name),
         branch_code = COALESCE($2, branch_code),
         is_active   = COALESCE($3, is_active)
       WHERE id = $4 RETURNING *`,
      [branch_name?.trim() || null, branch_code?.trim() || null, is_active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'الفرع غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'كود الفرع مستخدم بالفعل' });
    console.error('[CarrefourDamage] branch update:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Every table that carries a branch_id and has NO ON DELETE CASCADE toward
// carrefour_branches — a branch referenced by any of these must be blocked
// from deletion (409, "deactivate instead"), never left to fail as a raw
// FK-violation 500 further down. carrefour_branch_reps is deliberately
// absent here: it DOES cascade (migration 088), so an assignment alone
// never blocks removing a branch.
const BRANCH_REFERENCING_TABLES = [
  'carrefour_damage_reports', 'carrefour_stock_reports', 'carrefour_order_reports',
  'carrefour_report_save_log', 'carrefour_report_photos',
];

router.delete('/branches/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    for (const table of BRANCH_REFERENCING_TABLES) {
      const used = await pool.query(`SELECT 1 FROM ${table} WHERE branch_id = $1 LIMIT 1`, [req.params.id]);
      if (used.rows.length) {
        return res.status(409).json({ error: 'لا يمكن حذف فرع له تقارير أو سجلات مسجلة — قم بإلغاء تفعيله بدلاً من ذلك' });
      }
    }
    const r = await pool.query('DELETE FROM carrefour_branches WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'الفرع غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[CarrefourDamage] branch delete:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Assign / unassign a promoter to a branch
router.post('/branches/:id/assign', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const userId = req.body.user_id;
  if (!userId) return res.status(400).json({ error: 'المستخدم مطلوب' });
  try {
    const u = await pool.query('SELECT id, role FROM users WHERE id = $1', [userId]);
    if (!u.rows.length) return res.status(404).json({ error: 'المستخدم غير موجود' });
    await pool.query(
      `INSERT INTO carrefour_branch_reps (branch_id, user_id) VALUES ($1, $2)
       ON CONFLICT (branch_id, user_id) DO NOTHING`,
      [req.params.id, userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[CarrefourDamage] assign:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.delete('/branches/:id/assign/:userId', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM carrefour_branch_reps WHERE branch_id = $1 AND user_id = $2',
      [req.params.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[CarrefourDamage] unassign:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Promoter accounts, for the assignment dropdown
router.get('/reps', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email FROM users WHERE role = 'carrefour_rep' AND is_active = TRUE ORDER BY name`
    );
    res.json(rows);
  } catch (err) {
    console.error('[CarrefourDamage] reps list:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════
   Settings — damage item catalog (admin only)
════════════════════════════════════════════════════════════ */
router.get('/items', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM carrefour_damage_items ORDER BY sort_order, item_name'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/items', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const itemName = String(req.body.item_name || '').trim();
  if (!itemName) return res.status(400).json({ error: 'اسم الصنف مطلوب' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO carrefour_damage_items (item_name) VALUES ($1) RETURNING *', [itemName]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'الصنف موجود بالفعل' });
    console.error('[CarrefourDamage] item create:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.put('/items/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const { item_name, is_active, sort_order } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE carrefour_damage_items SET
         item_name  = COALESCE($1, item_name),
         is_active  = COALESCE($2, is_active),
         sort_order = COALESCE($3, sort_order)
       WHERE id = $4 RETURNING *`,
      [item_name?.trim() || null, is_active, sort_order, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'الصنف غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'الصنف موجود بالفعل' });
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Same reasoning as BRANCH_REFERENCING_TABLES above, for the item catalog.
const ITEM_REFERENCING_TABLES = [
  'carrefour_damage_report_items', 'carrefour_stock_report_items', 'carrefour_order_report_items',
];

router.delete('/items/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    for (const table of ITEM_REFERENCING_TABLES) {
      const used = await pool.query(`SELECT 1 FROM ${table} WHERE item_id = $1 LIMIT 1`, [req.params.id]);
      if (used.rows.length) {
        return res.status(409).json({ error: 'لا يمكن حذف صنف مستخدم في تقارير مسجلة — قم بإلغاء تفعيله بدلاً من ذلك' });
      }
    }
    const r = await pool.query('DELETE FROM carrefour_damage_items WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'الصنف غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════
   Entry — the promoter's daily form
════════════════════════════════════════════════════════════ */

// Branches the current user may log against (own assignments, or every
// active branch for an admin doing on-behalf entry).
router.get('/my-branches', verifyToken, requirePagePermission('carrefour_damage_entry', 1), async (req, res) => {
  try {
    const ids = await allowedBranchIds(req.user);
    const { rows } = ids
      ? await pool.query(
          'SELECT id, branch_name, branch_code FROM carrefour_branches WHERE id = ANY($1::int[]) AND is_active = TRUE ORDER BY branch_name',
          [ids]
        )
      : await pool.query(
          'SELECT id, branch_name, branch_code FROM carrefour_branches WHERE is_active = TRUE ORDER BY branch_name'
        );
    res.json(rows);
  } catch (err) {
    console.error('[CarrefourDamage] my-branches:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* Both جرد التوالف (damage) and جرد أرصدة (stock-on-hand) are the same
   branch/day/item-lines shape, just against a different pair of tables —
   these factories build the GET/POST/report handlers once and mount them
   twice below, so the two tabs can never drift apart in behavior. */
function makeEntryGetHandler(reportsTable, itemsTable) {
  return async (req, res) => {
    const branchId = Number(req.query.branch_id);
    const date = String(req.query.date || '').trim();
    if (!branchId || !date) return res.status(400).json({ error: 'الفرع والتاريخ مطلوبان' });

    try {
      const ids = await allowedBranchIds(req.user);
      if (ids && !ids.includes(branchId)) {
        return res.status(403).json({ error: 'هذا الفرع غير مخصص لك' });
      }

      const items = await pool.query(
        'SELECT id, item_name FROM carrefour_damage_items WHERE is_active = TRUE ORDER BY sort_order, item_name'
      );
      const report = await pool.query(
        // report_date/expiry_date cast to text — the pg driver otherwise
        // parses DATE columns into a JS Date at LOCAL midnight, and
        // Date→JSON serializes that in UTC, silently shifting the day
        // whenever the server's local timezone isn't UTC (see CLAUDE.md).
        `SELECT id, branch_id, report_date::text AS report_date, submitted_by, submitted_by_name,
                notes, created_at, updated_at, report_no
         FROM ${reportsTable} WHERE branch_id = $1 AND report_date = $2`,
        [branchId, date]
      );
      let lines = [];
      if (report.rows.length) {
        const li = await pool.query(
          `SELECT item_id, item_name, quantity, expiry_date::text AS expiry_date, notes FROM ${itemsTable} WHERE report_id = $1`,
          [report.rows[0].id]
        );
        lines = li.rows;
      }

      res.json({ items: items.rows, report: report.rows[0] || null, lines });
    } catch (err) {
      console.error(`[CarrefourDamage] ${reportsTable} entry fetch:`, err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  };
}

/* reportType tags the append-only signature log (carrefour_report_save_log)
   so all three tabs' history can be told apart in one shared table. */
function makeEntrySaveHandler(reportsTable, itemsTable, reportType) {
  return async (req, res) => {
    const branchId = Number(req.body.branch_id);
    const date = String(req.body.report_date || '').trim();
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const notes = req.body.notes != null ? String(req.body.notes).trim() || null : null;

    if (!branchId || !date) return res.status(400).json({ error: 'الفرع والتاريخ مطلوبان' });

    try {
      const ids = await allowedBranchIds(req.user);
      if (ids && !ids.includes(branchId)) {
        return res.status(403).json({ error: 'هذا الفرع غير مخصص لك' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const upserted = await client.query(
          `INSERT INTO ${reportsTable} (branch_id, report_date, submitted_by, submitted_by_name, notes)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (branch_id, report_date) DO UPDATE SET
             submitted_by      = EXCLUDED.submitted_by,
             submitted_by_name = EXCLUDED.submitted_by_name,
             notes             = EXCLUDED.notes,
             updated_at        = NOW()
           RETURNING id`,
          [branchId, date, req.user.id, req.user.name || null, notes]
        );
        const reportId = upserted.rows[0].id;

        await client.query(`DELETE FROM ${itemsTable} WHERE report_id = $1`, [reportId]);

        let totalQty = 0;
        if (items.length) {
          const values = [];
          const placeholders = items.map((it, idx) => {
            const qty = Number(it.quantity) || 0;
            totalQty += qty;
            const base = idx * 6;
            values.push(
              reportId, it.item_id || null, String(it.item_name || '').trim(), qty,
              it.expiry_date || null, it.notes != null ? String(it.notes).trim() || null : null
            );
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
          }).join(', ');
          await client.query(
            `INSERT INTO ${itemsTable} (report_id, item_id, item_name, quantity, expiry_date, notes) VALUES ${placeholders}`,
            values
          );
        }

        // Signature log: append, never overwrite — this is the audit trail
        // proving who saved this branch/date and when, even across edits.
        await client.query(
          `INSERT INTO carrefour_report_save_log (report_type, branch_id, report_date, saved_by, saved_by_name, total_qty)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [reportType, branchId, date, req.user.id, req.user.name || null, totalQty]
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }

      res.json({ ok: true, branch_id: branchId, report_date: date });
    } catch (err) {
      console.error(`[CarrefourDamage] ${reportsTable} entry save:`, err);
      res.status(500).json({ error: 'خطأ في حفظ التقرير' });
    }
  };
}

router.get('/entry', verifyToken, requirePagePermission('carrefour_damage_entry', 1),
  makeEntryGetHandler('carrefour_damage_reports', 'carrefour_damage_report_items'));
router.post('/entry', verifyToken, requirePagePermission('carrefour_damage_entry', 2),
  makeEntrySaveHandler('carrefour_damage_reports', 'carrefour_damage_report_items', 'damage'));

router.get('/stock-entry', verifyToken, requirePagePermission('carrefour_damage_entry', 1),
  makeEntryGetHandler('carrefour_stock_reports', 'carrefour_stock_report_items'));
router.post('/stock-entry', verifyToken, requirePagePermission('carrefour_damage_entry', 2),
  makeEntrySaveHandler('carrefour_stock_reports', 'carrefour_stock_report_items', 'stock'));

router.get('/order-entry', verifyToken, requirePagePermission('carrefour_damage_entry', 1),
  makeEntryGetHandler('carrefour_order_reports', 'carrefour_order_report_items'));
router.post('/order-entry', verifyToken, requirePagePermission('carrefour_damage_entry', 2),
  makeEntrySaveHandler('carrefour_order_reports', 'carrefour_order_report_items', 'orders'));

// Signature log for one branch/date/tab — who saved it and when, every save
// kept (not just the latest). Same ownership scoping as /entry.
router.get('/save-log', verifyToken, requirePagePermission('carrefour_damage_entry', 1), async (req, res) => {
  const branchId = Number(req.query.branch_id);
  const date = String(req.query.date || '').trim();
  const reportType = String(req.query.report_type || '').trim();
  if (!branchId || !date || !['damage', 'stock', 'orders'].includes(reportType)) {
    return res.status(400).json({ error: 'الفرع والتاريخ ونوع التقرير مطلوبة' });
  }
  try {
    const ids = await allowedBranchIds(req.user);
    if (ids && !ids.includes(branchId)) {
      return res.status(403).json({ error: 'هذا الفرع غير مخصص لك' });
    }
    const { rows } = await pool.query(
      `SELECT saved_by_name, total_qty, saved_at FROM carrefour_report_save_log
       WHERE report_type = $1 AND branch_id = $2 AND report_date = $3
       ORDER BY saved_at DESC`,
      [reportType, branchId, date]
    );
    res.json(rows);
  } catch (err) {
    console.error('[CarrefourDamage] save-log:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════
   Photo attachments — attach before/after saving the entry (kept on
   report_type/branch/date directly, not on the report row's id), and the
   management "ألبوم الصور" browsing them by branch + date.
════════════════════════════════════════════════════════════ */
router.get('/photos', verifyToken, requirePagePermission('carrefour_damage_entry', 1), async (req, res) => {
  const branchId = Number(req.query.branch_id);
  const date = String(req.query.date || '').trim();
  const reportType = String(req.query.report_type || '').trim();
  if (!branchId || !date || !['damage', 'stock', 'orders'].includes(reportType)) {
    return res.status(400).json({ error: 'الفرع والتاريخ ونوع التقرير مطلوبة' });
  }
  try {
    const ids = await allowedBranchIds(req.user);
    if (ids && !ids.includes(branchId)) {
      return res.status(403).json({ error: 'هذا الفرع غير مخصص لك' });
    }
    const { rows } = await pool.query(
      `SELECT id, file_path, original_filename, uploaded_by_name, uploaded_at
       FROM carrefour_report_photos
       WHERE report_type = $1 AND branch_id = $2 AND report_date = $3
       ORDER BY uploaded_at DESC`,
      [reportType, branchId, date]
    );
    res.json(rows.map(r => ({ ...r, url: `/uploads/${r.file_path}` })));
  } catch (err) {
    console.error('[CarrefourDamage] photos list:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/photos', verifyToken, requirePagePermission('carrefour_damage_entry', 2),
  // multipart/form-data isn't parsed into req.body until multer runs, so
  // the branch-ownership check can only happen AFTER this — a forbidden
  // request's files land on disk first and are deleted below when rejected.
  (req, res, next) => photoUpload.array('files', 10)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'خطأ في رفع الصور' });
    next();
  }),
  async (req, res) => {
    const { report_type, branch_id, report_date } = req.body;
    const branchId = Number(branch_id);
    const reportType = String(report_type || '').trim();
    const date = String(report_date || '').trim();
    const cleanupFiles = () => (req.files || []).forEach(f => fs.unlink(f.path, () => {}));

    if (!branchId || !date || !['damage', 'stock', 'orders'].includes(reportType)) {
      cleanupFiles();
      return res.status(400).json({ error: 'الفرع والتاريخ ونوع التقرير مطلوبة' });
    }
    const ids = await allowedBranchIds(req.user);
    if (ids && !ids.includes(branchId)) {
      cleanupFiles();
      return res.status(403).json({ error: 'هذا الفرع غير مخصص لك' });
    }
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'لم يتم اختيار أي صور' });
    }

    try {
      const inserted = [];
      for (const f of req.files) {
        const relPath = path.relative(path.resolve(process.env.UPLOAD_DIR || './uploads'), f.path).split(path.sep).join('/');
        const { rows } = await pool.query(
          `INSERT INTO carrefour_report_photos
             (report_type, branch_id, report_date, file_path, original_filename, uploaded_by, uploaded_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, file_path, original_filename, uploaded_by_name, uploaded_at`,
          [reportType, branchId, date, relPath, fixName(f.originalname), req.user.id, req.user.name || null]
        );
        inserted.push({ ...rows[0], url: `/uploads/${rows[0].file_path}` });
      }
      res.status(201).json(inserted);
    } catch (err) {
      console.error('[CarrefourDamage] photos upload:', err);
      res.status(500).json({ error: 'خطأ في حفظ الصور' });
    }
  }
);

router.delete('/photos/:id', verifyToken, requirePagePermission('carrefour_damage_entry', 2), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM carrefour_report_photos WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'الصورة غير موجودة' });
    const photo = rows[0];

    const ids = await allowedBranchIds(req.user);
    if (ids && !ids.includes(photo.branch_id)) {
      return res.status(403).json({ error: 'هذا الفرع غير مخصص لك' });
    }

    await pool.query('DELETE FROM carrefour_report_photos WHERE id = $1', [req.params.id]);
    const fullPath = path.join(path.resolve(process.env.UPLOAD_DIR || './uploads'), photo.file_path);
    fs.unlink(fullPath, () => {}); // best-effort — a missing file must not block the DB delete
    res.json({ ok: true });
  } catch (err) {
    console.error('[CarrefourDamage] photo delete:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Album — management browsing of photos across branches/dates, grouped
// client-side by branch + date (same convention as the report rows).
router.get('/album', verifyToken, requirePagePermission('carrefour_damage_report', 1), async (req, res) => {
  const { report_type, date_from, date_to, branch_id } = req.query;
  const reportType = String(report_type || '').trim();
  if (!['damage', 'stock', 'orders'].includes(reportType)) {
    return res.status(400).json({ error: 'نوع التقرير مطلوب' });
  }
  const dateFrom = date_from || '1900-01-01';
  const dateTo   = date_to   || '2999-12-31';
  const cond = ['p.report_type = $1', 'p.report_date BETWEEN $2 AND $3'];
  const params = [reportType, dateFrom, dateTo];
  if (branch_id) { params.push(Number(branch_id)); cond.push(`p.branch_id = $${params.length}`); }

  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.branch_id, b.branch_name, p.report_date::text AS report_date, p.file_path, p.original_filename,
              p.uploaded_by_name, p.uploaded_at
       FROM carrefour_report_photos p
       JOIN carrefour_branches b ON b.id = p.branch_id
       WHERE ${cond.join(' AND ')}
       ORDER BY p.report_date DESC, b.branch_name`,
      params
    );
    res.json(rows.map(r => ({ ...r, url: `/uploads/${r.file_path}` })));
  } catch (err) {
    console.error('[CarrefourDamage] album:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════
   Report — filter option lists (lightweight, non-admin-gated —
   report viewers need these for the filter bar without the full
   admin branch/item CRUD payload)
════════════════════════════════════════════════════════════ */
router.get('/filters', verifyToken, requirePagePermission('carrefour_damage_report', 1), async (req, res) => {
  try {
    const branches = await pool.query(
      'SELECT id, branch_name FROM carrefour_branches WHERE is_active = TRUE ORDER BY branch_name'
    );
    const items = await pool.query(
      'SELECT id, item_name FROM carrefour_damage_items WHERE is_active = TRUE ORDER BY sort_order, item_name'
    );
    res.json({ branches: branches.rows, items: items.rows });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ════════════════════════════════════════════════════════════
   Report — management roll-up (same factory-per-table approach as
   the entry handlers above, so جرد التوالف and جرد أرصدة share one
   implementation).
════════════════════════════════════════════════════════════ */
function makeReportHandler(reportsTable, itemsTable) {
  return async (req, res) => {
    const { date_from, date_to, branch_id, item_id } = req.query;
    const dateFrom = date_from || '1900-01-01';
    const dateTo   = date_to   || '2999-12-31';

    const cond = ['r.report_date BETWEEN $1 AND $2'];
    const params = [dateFrom, dateTo];
    if (branch_id) { params.push(Number(branch_id)); cond.push(`r.branch_id = $${params.length}`); }
    if (item_id)   { params.push(Number(item_id));   cond.push(`ri.item_id = $${params.length}`); }
    const where = cond.join(' AND ');

    try {
      const rows = await pool.query(
        `SELECT r.id AS report_id, r.report_no, r.report_date::text AS report_date, r.branch_id, b.branch_name,
                r.submitted_by_name, r.notes AS report_notes,
                ri.item_id, ri.item_name, ri.quantity, ri.expiry_date::text AS expiry_date, ri.notes
         FROM ${reportsTable} r
         JOIN carrefour_branches b ON b.id = r.branch_id
         LEFT JOIN ${itemsTable} ri ON ri.report_id = r.id
         WHERE ${where}
         ORDER BY r.report_date DESC, b.branch_name`,
        params
      );

      const totalsQ = await pool.query(
        `SELECT COUNT(DISTINCT r.id)::int AS total_reports,
                COUNT(DISTINCT r.branch_id)::int AS branches_reported,
                COALESCE(SUM(ri.quantity), 0) AS total_qty
         FROM ${reportsTable} r
         LEFT JOIN ${itemsTable} ri ON ri.report_id = r.id
         WHERE ${where}`,
        params
      );

      const branchesTotalQ = await pool.query(
        'SELECT COUNT(*)::int AS n FROM carrefour_branches WHERE is_active = TRUE'
      );

      // Active branches WITH an assigned rep that have not logged for the
      // most recent date in range (a simple, actionable compliance signal).
      const latestDateQ = await pool.query(
        `SELECT MAX(report_date)::text AS d FROM ${reportsTable} WHERE report_date BETWEEN $1 AND $2`,
        [dateFrom, dateTo]
      );
      const latestDate = latestDateQ.rows[0].d;
      let missingToday = [];
      if (latestDate) {
        const missing = await pool.query(
          `SELECT DISTINCT b.id, b.branch_name
           FROM carrefour_branches b
           JOIN carrefour_branch_reps cbr ON cbr.branch_id = b.id
           WHERE b.is_active = TRUE
             AND NOT EXISTS (
               SELECT 1 FROM ${reportsTable} r
               WHERE r.branch_id = b.id AND r.report_date = $1
             )
           ORDER BY b.branch_name`,
          [latestDate]
        );
        missingToday = missing.rows;
      }

      res.json({
        rows: rows.rows,
        totals: {
          ...totalsQ.rows[0],
          branches_total: branchesTotalQ.rows[0].n,
        },
        latest_date: latestDate,
        missing_latest_date: missingToday,
      });
    } catch (err) {
      console.error(`[CarrefourDamage] ${reportsTable} report:`, err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  };
}

router.get('/report', verifyToken, requirePagePermission('carrefour_damage_report', 1),
  makeReportHandler('carrefour_damage_reports', 'carrefour_damage_report_items'));
router.get('/stock-report', verifyToken, requirePagePermission('carrefour_damage_report', 1),
  makeReportHandler('carrefour_stock_reports', 'carrefour_stock_report_items'));

router.get('/order-report', verifyToken, requirePagePermission('carrefour_damage_report', 1),
  makeReportHandler('carrefour_order_reports', 'carrefour_order_report_items'));

/* ════════════════════════════════════════════════════════════
   "الأسعار Survey" — a matrix of poultry items × competitor brands a
   promoter fills in while walking the shelf at a branch, comparing our
   own price ("طريه") against the market. See 117_carrefour_price_survey.sql
   for the schema/reasoning. Same page-permission gate as the other three
   entry tabs (carrefour_damage_entry) and the same branch-ownership
   scoping (allowedBranchIds) — a promoter only ever surveys their own
   assigned branch(es); an admin can survey on behalf of any branch.

   Unlike those three tabs, each CELL saves immediately on entry (see
   POST /price-survey/cell) rather than one batch "حفظ" — a promoter fills
   cells in one at a time while walking the aisle, not all at once.
════════════════════════════════════════════════════════════ */

// Initials shown directly in a filled cell ("اختصار اسم المستخدم") —
// first letter of up to the first 2 words of the display name, uppercased.
// Computed once at save time and frozen on the row, so it never changes
// retroactively if the user's display name is edited later.
function initialsFrom(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '؟';
  return words.slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// Admin-only, full list (active + inactive) — used by the settings panel's
// catalog-management tables, same shape/access as /branches and /items
// above. The promoter's own matrix view never calls these directly: it
// gets its (active-only) brands/items inline from GET /price-survey/entry.
router.get('/price-survey/brands', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM carrefour_price_brands ORDER BY sort_order, name'
    );
    res.json(rows);
  } catch (err) {
    console.error('[CarrefourDamage] price-survey brands:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.get('/price-survey/items', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM carrefour_price_survey_items ORDER BY sort_order, item_name'
    );
    res.json(rows);
  } catch (err) {
    console.error('[CarrefourDamage] price-survey items:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Admin-only catalog management — same shape as /items above, kept as
// separate endpoints since brands and survey-items are two distinct
// catalogs (a brand is a column, an item is a row).
router.post('/price-survey/brands', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'اسم البراند مطلوب' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO carrefour_price_brands (name, is_own_brand, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [name, !!req.body.is_own_brand, Number(req.body.sort_order) || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'البراند موجود بالفعل' });
    console.error('[CarrefourDamage] price-survey brand create:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.put('/price-survey/brands/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const { name, is_own_brand, is_active, sort_order } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE carrefour_price_brands SET
         name         = COALESCE($1, name),
         is_own_brand = COALESCE($2, is_own_brand),
         is_active    = COALESCE($3, is_active),
         sort_order   = COALESCE($4, sort_order)
       WHERE id = $5 RETURNING *`,
      [name?.trim() || null, is_own_brand, is_active, sort_order, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'البراند غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'البراند موجود بالفعل' });
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.delete('/price-survey/brands/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const used = await pool.query('SELECT 1 FROM carrefour_price_survey_entries WHERE brand_id = $1 LIMIT 1', [req.params.id]);
    if (used.rows.length) {
      return res.status(409).json({ error: 'لا يمكن حذف براند مستخدم في أسعار مسجلة — قم بإلغاء تفعيله بدلاً من ذلك' });
    }
    const r = await pool.query('DELETE FROM carrefour_price_brands WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'البراند غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.post('/price-survey/items', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const itemName = String(req.body.item_name || '').trim();
  if (!itemName) return res.status(400).json({ error: 'اسم الصنف مطلوب' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO carrefour_price_survey_items (item_name, category, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [itemName, req.body.category?.trim() || null, Number(req.body.sort_order) || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'الصنف موجود بالفعل' });
    console.error('[CarrefourDamage] price-survey item create:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.put('/price-survey/items/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const { item_name, category, is_active, sort_order } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE carrefour_price_survey_items SET
         item_name  = COALESCE($1, item_name),
         category   = COALESCE($2, category),
         is_active  = COALESCE($3, is_active),
         sort_order = COALESCE($4, sort_order)
       WHERE id = $5 RETURNING *`,
      [item_name?.trim() || null, category, is_active, sort_order, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'الصنف غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'الصنف موجود بالفعل' });
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.delete('/price-survey/items/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const used = await pool.query('SELECT 1 FROM carrefour_price_survey_entries WHERE item_id = $1 LIMIT 1', [req.params.id]);
    if (used.rows.length) {
      return res.status(409).json({ error: 'لا يمكن حذف صنف مستخدم في أسعار مسجلة — قم بإلغاء تفعيله بدلاً من ذلك' });
    }
    const r = await pool.query('DELETE FROM carrefour_price_survey_items WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'الصنف غير موجود' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Full matrix for one branch/date — items, brands, and every entered cell.
router.get('/price-survey/entry', verifyToken, requirePagePermission('carrefour_damage_entry', 1), async (req, res) => {
  const branchId = Number(req.query.branch_id);
  const date = String(req.query.date || '').trim();
  if (!branchId || !date) return res.status(400).json({ error: 'الفرع والتاريخ مطلوبان' });
  try {
    const ids = await allowedBranchIds(req.user);
    if (ids && !ids.includes(branchId)) {
      return res.status(403).json({ error: 'هذا الفرع غير مخصص لك' });
    }
    const [items, brands, entries] = await Promise.all([
      pool.query('SELECT id, item_name, category, sort_order FROM carrefour_price_survey_items WHERE is_active = TRUE ORDER BY sort_order, item_name'),
      pool.query('SELECT id, name, is_own_brand, sort_order FROM carrefour_price_brands WHERE is_active = TRUE ORDER BY sort_order, name'),
      pool.query(
        `SELECT item_id, brand_id, price, entered_by_name, entered_by_initials, updated_at
         FROM carrefour_price_survey_entries WHERE branch_id = $1 AND report_date = $2`,
        [branchId, date]
      ),
    ]);
    res.json({ items: items.rows, brands: brands.rows, entries: entries.rows });
  } catch (err) {
    console.error('[CarrefourDamage] price-survey entry fetch:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// One cell, saved immediately — "يتم تسجيل الادخال وحفظه مباشرة" per the
// request, unlike the other three tabs' single batch save. Upserts on the
// (branch_id, report_date, item_id, brand_id) unique key.
router.post('/price-survey/cell', verifyToken, requirePagePermission('carrefour_damage_entry', 2), async (req, res) => {
  const branchId = Number(req.body.branch_id);
  const date = String(req.body.report_date || '').trim();
  const itemId = Number(req.body.item_id);
  const brandId = Number(req.body.brand_id);
  const price = req.body.price === '' || req.body.price == null ? null : Number(req.body.price);
  if (!branchId || !date || !itemId || !brandId) {
    return res.status(400).json({ error: 'الفرع والتاريخ والصنف والبراند مطلوبة' });
  }
  if (price != null && (!Number.isFinite(price) || price < 0)) {
    return res.status(400).json({ error: 'السعر غير صالح' });
  }
  try {
    const ids = await allowedBranchIds(req.user);
    if (ids && !ids.includes(branchId)) {
      return res.status(403).json({ error: 'هذا الفرع غير مخصص لك' });
    }

    // An empty price clears the cell (a promoter correcting a mistaken
    // entry) rather than storing a 0 that would then win every "lowest
    // price" comparison.
    if (price == null) {
      await pool.query(
        'DELETE FROM carrefour_price_survey_entries WHERE branch_id=$1 AND report_date=$2 AND item_id=$3 AND brand_id=$4',
        [branchId, date, itemId, brandId]
      );
      return res.json({ ok: true, cleared: true });
    }

    const initials = initialsFrom(req.user.name);
    const { rows } = await pool.query(
      `INSERT INTO carrefour_price_survey_entries
         (branch_id, report_date, item_id, brand_id, price, entered_by, entered_by_name, entered_by_initials)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (branch_id, report_date, item_id, brand_id) DO UPDATE SET
         price = EXCLUDED.price, entered_by = EXCLUDED.entered_by,
         entered_by_name = EXCLUDED.entered_by_name, entered_by_initials = EXCLUDED.entered_by_initials,
         updated_at = NOW()
       RETURNING item_id, brand_id, price, entered_by_name, entered_by_initials, updated_at`,
      [branchId, date, itemId, brandId, price, req.user.id, req.user.name || null, initials]
    );
    res.json({ ok: true, entry: rows[0] });
  } catch (err) {
    console.error('[CarrefourDamage] price-survey cell save:', err);
    res.status(500).json({ error: 'خطأ في حفظ السعر' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/carrefour-damage/price-survey/report
   Unified cross-branch view of the price survey — one combined matrix
   instead of having to open each branch's entry separately. For every
   (item, brand) cell, takes each branch's MOST RECENT entry within the
   requested date range (a branch may have surveyed the same item/brand on
   several days — only the latest matters for "what's the price NOW"), then
   groups those per-branch values together:
     - all branches agree (or only one branch reported it) → a single
       settled value, `conflict: false`.
     - branches reported DIFFERENT prices → `conflict: true`, with every
       distinct value AND which branch(es) said it, so the discrepancy is
       shown rather than silently picking one — per the request
       ("في حالة كتابة قيمتين مختلفتين يتم توضيح ذلك").
   Same permission tier as the other report handlers (carrefour_damage_report).
════════════════════════════════════════════════════════════ */
router.get('/price-survey/report', verifyToken, requirePagePermission('carrefour_damage_report', 1), async (req, res) => {
  const dateFrom = String(req.query.date_from || '').trim();
  const dateTo = String(req.query.date_to || '').trim();
  const branchId = req.query.branch_id ? Number(req.query.branch_id) : null;
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'نطاق التاريخ مطلوب' });

  try {
    const params = [dateFrom, dateTo];
    let branchSql = '';
    if (branchId) { params.push(branchId); branchSql = ` AND branch_id = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT e.item_id, e.brand_id, e.branch_id, b.branch_name, e.price, e.report_date::text AS report_date
       FROM (
         SELECT DISTINCT ON (item_id, brand_id, branch_id) item_id, brand_id, branch_id, price, report_date
         FROM carrefour_price_survey_entries
         WHERE report_date BETWEEN $1 AND $2 ${branchSql}
         ORDER BY item_id, brand_id, branch_id, report_date DESC
       ) e
       JOIN carrefour_branches b ON b.id = e.branch_id
       ORDER BY e.item_id, e.brand_id, b.branch_name`,
      params
    );

    const [items, brands] = await Promise.all([
      pool.query('SELECT id, item_name, category, sort_order FROM carrefour_price_survey_items WHERE is_active = TRUE ORDER BY sort_order, item_name'),
      pool.query('SELECT id, name, is_own_brand, sort_order FROM carrefour_price_brands WHERE is_active = TRUE ORDER BY sort_order, name'),
    ]);

    res.json({ items: items.rows, brands: brands.rows, entries: rows });
  } catch (err) {
    console.error('[CarrefourDamage] price-survey report:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
