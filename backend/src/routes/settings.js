const express = require('express');
const pool    = require('../db/pool');
const { verifyToken } = require('../middleware/auth');
const { invalidateSmtpCache, testConnection } = require('../utils/mailer');

const router = express.Router();

const ADMIN_ROLES = ['super_admin', 'it_admin'];

/* ── GET /api/settings  — all settings, any auth user ── */
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

/* ── GET /api/settings/:key  — single key ── */
router.get('/:key', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT value, updated_at FROM app_settings WHERE key = $1',
      [req.params.key]
    );
    res.json(rows.length
      ? { value: rows[0].value, updatedAt: rows[0].updated_at }
      : { value: null }
    );
  } catch (err) {
    console.error('Settings GET/:key error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── PUT /api/settings/:key  — super_admin / it_admin ── */
router.put('/:key', verifyToken, async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: 'التخصيص متاح للمدير والمشرفين فقط' });
  }
  const { key } = req.params;
  /* Accept either { value: X } body (preferred) or the body itself as value */
  const value = req.body?.value !== undefined ? req.body.value : req.body;
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
    /* Invalidate SMTP cache whenever the smtp key is updated */
    if (key === 'smtp') invalidateSmtpCache();
    res.json({ ok: true });
  } catch (err) {
    console.error('Settings PUT error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ── POST /api/settings/smtp/test  — test SMTP connection ── */
router.post('/smtp/test', verifyToken, async (req, res) => {
  if (!ADMIN_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: 'غير مصرح' });
  }
  try {
    await testConnection(req.body);   // body = { host, port, secure, user, pass }
    res.json({ ok: true, message: 'الاتصال ناجح ✓' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
