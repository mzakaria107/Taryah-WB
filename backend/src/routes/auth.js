const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 12;

// POST /api/auth/register  — super_admin only
router.post('/register', verifyToken, async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'إنشاء المستخدمين متاح للمدير العام فقط' });
  }

  const { name, email, password, role, region_id } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'الاسم والبريد الإلكتروني وكلمة المرور مطلوبة' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  }

  const allowed = ['super_admin','it_admin','sales_manager','top_management','supervisor','region_manager','sales_rep','fridge_admin','viewer'];
  if (role && !allowed.includes(role)) {
    return res.status(400).json({ error: 'الدور غير صالح' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم بالفعل' });
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const id = uuidv4();

    const { rows } = await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role, region_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING id, name, email, role, region_id, is_active, created_at`,
      [id, name, email, password_hash, role || 'viewer', region_id || null]
    );

    res.status(201).json({ user: rows[0] });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, password_hash, role, region_id, is_active FROM users WHERE email = $1',
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'بيانات الاعتماد غير صحيحة' });
    }

    const user = rows[0];
    if (user.is_active === false) {
      return res.status(403).json({ error: 'الحساب موقوف، تواصل مع المدير العام' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'بيانات الاعتماد غير صحيحة' });
    }

    // Track last login time
    await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id]);

    const payload = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      region_id: user.region_id,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRY || '24h',
    });

    res.json({ token, user: payload });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /api/auth/heartbeat — keeps last_seen_at current while user is active
router.post('/heartbeat', verifyToken, async (req, res) => {
  try {
    await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch {
    res.json({ ok: false }); // non-fatal
  }
});

// GET /api/auth/me
router.get('/me', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.region_id, u.created_at,
              r.name_ar AS region_name_ar, r.name_en AS region_name_en
       FROM users u
       LEFT JOIN regions r ON r.id = u.region_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
