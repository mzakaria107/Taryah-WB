const express = require('express');
const pool    = require('../db/pool');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

/* ── GET /api/settings  — any authenticated user ── */
router.get('/', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM app_settings');
    const out = {};
    rows.forEach(r => { out[r.key] = r.value; });
    res.json(out);
  } catch (err) {
    console.error('Settings GET error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── PUT /api/settings/:key  — super_admin only ── */
router.put('/:key', verifyToken, async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'التخصيص متاح للمدير العام فقط' });
  }
  const { key } = req.params;
  const value = req.body;
  try {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value      = $2::jsonb,
             updated_by = $3,
             updated_at = NOW()`,
      [key, JSON.stringify(value), req.user.email]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Settings PUT error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
