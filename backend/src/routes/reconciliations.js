const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const pool    = require('../db/pool');
const { verifyToken, requireRoles } = require('../middleware/auth');

const router = express.Router();

// ── Storage: uploads/reconciliations/<customerId>/<uuid>_<filename> ──
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads', 'reconciliations');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = path.join(UPLOAD_DIR, String(req.params.customerId || 'unknown'));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._؀-ۿ\s-]/g, '_');
    cb(null, `${uuidv4()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/reconciliations/upload/:customerId
// Upload a reconciliation file for a customer
// ─────────────────────────────────────────────────────────────────────
router.post(
  '/upload/:customerId',
  verifyToken,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });

    const { customerId } = req.params;
    const { notes = '' } = req.body;

    // Verify customer exists
    const check = await pool.query(
      `SELECT customer_id FROM invoices WHERE customer_id = $1 LIMIT 1`,
      [customerId]
    );
    if (!check.rows.length) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'العميل غير موجود' });
    }

    const { rows } = await pool.query(
      `INSERT INTO customer_reconciliations
         (customer_id, file_name, file_path, file_size, mime_type, uploaded_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        customerId,
        req.file.originalname,
        req.file.path,
        req.file.size,
        req.file.mimetype,
        req.user.id,
        notes || null,
      ]
    );

    const row = rows[0];
    res.json({
      ok: true,
      id:          row.id,
      file_name:   row.file_name,
      file_size:   row.file_size,
      uploaded_at: row.uploaded_at,
    });
  }
);

// ─────────────────────────────────────────────────────────────────────
// GET /api/reconciliations/:customerId
// List reconciliation files for a customer
// ─────────────────────────────────────────────────────────────────────
router.get('/:customerId', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cr.id, cr.file_name, cr.file_size, cr.mime_type,
              cr.uploaded_at, cr.notes,
              u.name AS uploader_name
       FROM customer_reconciliations cr
       LEFT JOIN users u ON u.id = cr.uploaded_by
       WHERE cr.customer_id = $1
       ORDER BY cr.uploaded_at DESC`,
      [req.params.customerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[Reconciliations] List error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/reconciliations/download/:id
// Download a reconciliation file
// ─────────────────────────────────────────────────────────────────────
router.get('/download/:id', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM customer_reconciliations WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'الملف غير موجود' });

    const rec = rows[0];
    if (!fs.existsSync(rec.file_path)) {
      return res.status(404).json({ error: 'الملف غير موجود على الخادم' });
    }

    res.download(rec.file_path, rec.file_name);
  } catch (err) {
    console.error('[Reconciliations] Download error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/reconciliations/:id
// Delete a reconciliation file (super_admin / it_admin only)
// ─────────────────────────────────────────────────────────────────────
router.delete(
  '/:id',
  verifyToken,
  requireRoles('super_admin', 'it_admin'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `DELETE FROM customer_reconciliations WHERE id = $1 RETURNING *`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'السجل غير موجود' });

      // Remove physical file
      const rec = rows[0];
      try { if (fs.existsSync(rec.file_path)) fs.unlinkSync(rec.file_path); } catch (_) {}

      res.json({ ok: true });
    } catch (err) {
      console.error('[Reconciliations] Delete error:', err);
      res.status(500).json({ error: 'خطأ في الخادم' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────
// GET /api/reconciliations/has/:customerId
// Quick check — does customer have any reconciliation file?
// Used by customer list to show badge
// ─────────────────────────────────────────────────────────────────────
router.get('/has/:customerId', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM customer_reconciliations WHERE customer_id = $1`,
      [req.params.customerId]
    );
    res.json({ has: parseInt(rows[0].cnt, 10) > 0, count: parseInt(rows[0].cnt, 10) });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
