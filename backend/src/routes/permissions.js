const express = require('express');
const pool = require('../db/pool');
const { verifyToken, requireRoles } = require('../middleware/auth');

const router = express.Router();

const VALID_ROLES = ['super_admin','it_admin','supervisor','region_manager','sales_rep','fridge_admin','viewer'];
const VALID_PAGES = ['dashboard','invoices','reports','customer_detail','sales_activity','sales_tasks',
                     'fridges','stock','current_stock','upload','users','permissions'];

// GET /api/permissions — returns { pageKey: { role: level } }
router.get('/', verifyToken, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT page_key, role, access_level FROM page_permissions ORDER BY page_key, role'
    );
    const result = {};
    for (const r of rows) {
      if (!result[r.page_key]) result[r.page_key] = {};
      result[r.page_key][r.role] = r.access_level;
    }
    res.json(result);
  } catch (err) {
    console.error('Permissions GET error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// PUT /api/permissions/:pageKey/:role — super_admin only
router.put('/:pageKey/:role', verifyToken, requireRoles('super_admin'), async (req, res) => {
  const { pageKey, role } = req.params;
  const level = Number(req.body.level);

  if (!VALID_ROLES.includes(role))  return res.status(400).json({ error: 'دور غير صالح' });
  if (!VALID_PAGES.includes(pageKey)) return res.status(400).json({ error: 'صفحة غير صالحة' });
  if (![0, 1, 2].includes(level))  return res.status(400).json({ error: 'مستوى الصلاحية غير صالح' });

  // Prevent locking super_admin out of core pages
  if (role === 'super_admin' && ['dashboard','permissions'].includes(pageKey) && level === 0) {
    return res.status(400).json({ error: 'لا يمكن إزالة وصول المدير العام من هذه الصفحة' });
  }

  try {
    await pool.query(
      `INSERT INTO page_permissions (page_key, role, access_level) VALUES ($1,$2,$3)
       ON CONFLICT (page_key, role) DO UPDATE SET access_level = $3`,
      [pageKey, role, level]
    );
    res.json({ ok: true, page_key: pageKey, role, access_level: level });
  } catch (err) {
    console.error('Permission PUT error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
