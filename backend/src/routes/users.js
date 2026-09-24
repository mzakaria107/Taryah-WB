const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const { verifyToken, requireRoles, applyRegionFilter } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/users  (super_admin only) ───────────────
router.get('/', verifyToken, requireRoles('super_admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.region_id,
              u.is_active, u.created_at, u.last_seen_at,
              r.name_ar AS region_name_ar,
              COALESCE(
                (SELECT json_agg(json_build_object('id', reg.id, 'name_ar', reg.name_ar) ORDER BY reg.name_ar)
                 FROM user_regions ur JOIN regions reg ON reg.id = ur.region_id
                 WHERE ur.user_id = u.id),
                '[]'
              ) AS regions
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

// ── GET /api/users/regions  (any authenticated — scoped to the
//    caller's own assigned regions unless they hold an all-region role) ──
router.get('/regions', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    // fleet_only rows (e.g. "مستودع شقراء") are a fleet-vehicle classification,
    // never a real sales/region assignment — excluded from this general picker.
    const { rows } = req.regionFilter && req.regionFilter.length
      ? await pool.query('SELECT id, name_ar, name_en FROM regions WHERE id = ANY($1::int[]) AND fleet_only = false ORDER BY name_ar', [req.regionFilter])
      : await pool.query('SELECT id, name_ar, name_en FROM regions WHERE fleet_only = false ORDER BY name_ar');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── PUT /api/users/:id  (super_admin only) ───────────
router.put('/:id', verifyToken, requireRoles('super_admin'), async (req, res) => {
  const { name, email, role, region_id, region_ids, password } = req.body;
  const updates = [];
  const params  = [];
  let p = 1;

  const allowed = ['super_admin','it_admin','sales_manager','top_management','supervisor','region_manager','sales_rep','fridge_admin','accounts','viewer','carrefour_rep','quality_returns_monitor','fleet_supervisor'];

  const settingRegions = region_ids !== undefined || region_id !== undefined;
  const ids = Array.isArray(region_ids)
    ? [...new Set(region_ids.map(Number))]
    : (region_id ? [Number(region_id)] : []);

  if (name !== undefined)      { updates.push(`name = $${p++}`);      params.push(name); }
  if (email !== undefined)     { updates.push(`email = $${p++}`);     params.push(email); }
  if (role !== undefined) {
    if (!allowed.includes(role)) return res.status(400).json({ error: 'الدور غير صالح' });
    updates.push(`role = $${p++}`);
    params.push(role);
  }
  if (settingRegions) {
    updates.push(`region_id = $${p++}`);
    params.push(ids[0] || null);
  }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    const hash = await bcrypt.hash(password, 12);
    updates.push(`password_hash = $${p++}`);
    params.push(hash);
  }

  if (updates.length === 0 && !settingRegions) {
    return res.status(400).json({ error: 'لا توجد حقول للتحديث' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let userRow;
    if (updates.length) {
      params.push(req.params.id);
      const { rows } = await client.query(
        `UPDATE users SET ${updates.join(', ')}
         WHERE id = $${p}
         RETURNING id, name, email, role, region_id, is_active, created_at`,
        params
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'المستخدم غير موجود' });
      }
      userRow = rows[0];
    } else {
      const { rows } = await client.query(
        `SELECT id, name, email, role, region_id, is_active, created_at FROM users WHERE id = $1`,
        [req.params.id]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'المستخدم غير موجود' });
      }
      userRow = rows[0];
    }

    if (settingRegions) {
      await client.query('DELETE FROM user_regions WHERE user_id = $1', [req.params.id]);
      if (ids.length) {
        const placeholders = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
        await client.query(
          `INSERT INTO user_regions (user_id, region_id) VALUES ${placeholders}`,
          [req.params.id, ...ids]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ ...userRow, region_ids: ids });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('User update error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
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
