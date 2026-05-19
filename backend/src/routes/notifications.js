/**
 * routes/notifications.js
 * GET  /api/notifications          — last 40 notifications for current user
 * GET  /api/notifications/unread-count — just the count badge
 * POST /api/notifications/:id/read — mark one as read
 * POST /api/notifications/read-all — mark all as read
 * DELETE /api/notifications/:id    — delete one
 */

const express  = require('express');
const router   = express.Router();
const pool     = require('../db/pool');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

/* ── Unread count (for badge) ─────────────────────────────── */
router.get('/unread-count', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM notifications WHERE user_id=$1 AND is_read=false`,
      [req.user.id]
    );
    res.json({ count: parseInt(rows[0].cnt, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── List notifications ───────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, body, type, task_id, is_read, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 40`,
      [req.user.id]
    );
    res.json({ notifications: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Mark one as read ────────────────────────────────────── */
router.post('/:id/read', async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read=true WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Mark all as read ────────────────────────────────────── */
router.post('/read-all', async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read=true WHERE user_id=$1 AND is_read=false`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Delete one ──────────────────────────────────────────── */
router.delete('/:id', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM notifications WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
