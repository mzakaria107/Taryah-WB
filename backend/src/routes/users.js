const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const { verifyToken, requireRoles } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/users  (super_admin only) ───────────────
router.get('/', verifyToken, requireRoles('super_admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.region_id,
              u.is_active, u.created_at,
              r.name_ar AS region_name_ar
       FROM users u
       LEFT JOIN regions r ON r.id = u.region_id
       ORDER BY u.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Users list error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /api/users/regions  (any authenticated) ──────
router.get('/regions', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name_ar, name_en FROM regions ORDER BY name_ar');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── PUT /api/users/:id  (super_admin only) ───────────
router.put('/:id', verifyToken, requireRoles('super_admin'), async (req, res) => {
  const { name, email, role, region_id, password } = req.body;
  const updates = [];
  const params  = [];
  let p = 1;

  const allowed = ['super_admin','region_manager','sales_rep','it_admin','viewer'];

  if (name !== undefined)      { updates.push(`name = $${p++}`);      params.push(name); }
  if (email !== undefined)     { updates.push(`email = $${p++}`);     params.push(email); }
  if (role !== undefined) {
    if (!allowed.includes(role)) return res.status(400).json({ error: 'الدور غير صالح' });
    updates.push(`role = $${p++}`);
    params.push(role);
  }
  if (region_id !== undefined) {
    updates.push(`region_id = $${p++}`);
    params.push(region_id || null);
  }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    const hash = await bcrypt.hash(password, 12);
    updates.push(`password_hash = $${p++}`);
    params.push(hash);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'لا توجد حقول للتحديث' });

  params.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')}
       WHERE id = $${p}
       RETURNING id, name, email, role, region_id, is_active, created_at`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    console.error('User update error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── PATCH /api/users/:id/toggle-active  (super_admin) ─
router.patch('/:id/toggle-active', verifyToken, requireRoles('super_admin'), async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'لا يمكنك تعطيل حسابك الخاص' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE users SET is_active = NOT is_active
       WHERE id = $1
       RETURNING id, name, is_active`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Toggle active error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── DELETE /api/users/:id  (super_admin only) ────────
router.delete('/:id', verifyToken, requireRoles('super_admin'), async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'لا يمكنك حذف حسابك الخاص' });
  }
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('User delete error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
