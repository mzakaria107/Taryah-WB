/**
 * routes/targetApprovals.js — منطقة اعتماد الأهداف الشهرية
 *
 * POST /api/target-approvals/send            — admin/sales_manager: send this
 *                                                period's targets to every
 *                                                active user in each region
 * GET  /api/target-approvals/status           — per-region send + approval status
 * GET  /api/target-approvals/:id              — one request's detail (for the
 *                                                approval modal opened from a
 *                                                notification)
 * POST /api/target-approvals/:id/approve      — record the caller's approval
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { verifyToken, requireRoles } = require('../middleware/auth');

const SEND_ROLES = ['super_admin', 'it_admin', 'sales_manager'];

router.use(verifyToken);

/* ── POST /send — { year, month, region_id? } ─────────────────
   Sends (or re-sends) the target-approval request for every region
   that has at least one active rep, notifying every active user whose
   region_id matches. Re-sending refreshes sent_at/sent_by but keeps any
   approvals already recorded. If region_id is given, only that region
   is sent. ── */
router.post('/send', requireRoles(...SEND_ROLES), async (req, res) => {
  const year     = parseInt(req.body.year, 10);
  const month    = parseInt(req.body.month, 10);
  const regionId = req.body.region_id ? parseInt(req.body.region_id, 10) : null;
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'سنة/شهر غير صحيح' });
  }

  try {
    const regionsRes = await pool.query(
      `SELECT DISTINCT r.id, r.name_ar
       FROM regions r
       JOIN sales_reps sr ON sr.region_id = r.id AND sr.is_active
       WHERE $1::int IS NULL OR r.id = $1
       ORDER BY r.name_ar`,
      [regionId]
    );
    if (!regionsRes.rows.length) return res.json({ sent: [] });

    const sent = [];
    for (const region of regionsRes.rows) {
      const reqRes = await pool.query(
        `INSERT INTO target_approval_requests (year, month, region_id, sent_by, sent_by_name)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (year, month, region_id) DO UPDATE SET
           sent_by = EXCLUDED.sent_by, sent_by_name = EXCLUDED.sent_by_name, sent_at = NOW()
         RETURNING id`,
        [year, month, region.id, req.user.id, req.user.name]
      );
      const requestId = reqRes.rows[0].id;

      const usersRes = await pool.query(
        `SELECT DISTINCT u.id
         FROM users u
         JOIN user_regions ur ON ur.user_id = u.id
         WHERE u.is_active = true AND ur.region_id = $1`,
        [region.id]
      );
      const recipients = usersRes.rows.map(r => r.id);

      if (recipients.length) {
        const title = `أهداف ${month}/${year} — ${region.name_ar}`;
        const body  = `تم رفع الأهداف الشهرية لمنطقة ${region.name_ar}. برجاء المراجعة والموافقة عليها.`;
        // column order: user_id, title, body, is_read, target_request_id (type is a fixed literal)
        const placeholders = recipients.map((_, i) => {
          const b = i * 5;
          return `($${b+1}, $${b+2}, $${b+3}, 'target_approval', $${b+4}, $${b+5})`;
        }).join(', ');
        const params = recipients.flatMap(uid => [uid, title, body, false, requestId]);
        await pool.query(
          `INSERT INTO notifications (user_id, title, body, type, is_read, target_request_id)
           VALUES ${placeholders}`,
          params
        );
      }

      sent.push({ region_id: region.id, region_name: region.name_ar, recipients_count: recipients.length, request_id: requestId });
    }

    res.json({ sent });
  } catch (err) {
    console.error('[TargetApprovals] send error:', err.message);
    res.status(500).json({ error: 'خطأ في إرسال الأهداف للاعتماد' });
  }
});

/* ── GET /status?year=&month= ─────────────────────────────────
   Per-region send + approval status for the targets table's
   "حالة التعميد" column. ── */
router.get('/status', async (req, res) => {
  const year  = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  if (!year || !month) return res.status(400).json({ error: 'سنة/شهر غير صحيح' });

  try {
    const reqRes = await pool.query(
      `SELECT tar.id, tar.region_id, tar.sent_by_name, tar.sent_at
       FROM target_approval_requests tar
       WHERE tar.year = $1 AND tar.month = $2`,
      [year, month]
    );
    if (!reqRes.rows.length) return res.json({ regions: {} });

    const requestIds = reqRes.rows.map(r => r.id);
    const apprRes = await pool.query(
      `SELECT request_id, approved_by, approved_by_name, approved_at
       FROM target_approvals WHERE request_id = ANY($1::uuid[])
       ORDER BY approved_at`,
      [requestIds]
    );
    const approvalsByRequest = {};
    apprRes.rows.forEach(a => {
      if (!approvalsByRequest[a.request_id]) approvalsByRequest[a.request_id] = [];
      approvalsByRequest[a.request_id].push({
        user_id: a.approved_by, name: a.approved_by_name, approved_at: a.approved_at,
      });
    });

    const regions = {};
    reqRes.rows.forEach(r => {
      regions[r.region_id] = {
        request_id: r.id,
        sent_by_name: r.sent_by_name,
        sent_at: r.sent_at,
        approvals: approvalsByRequest[r.id] || [],
      };
    });

    res.json({ regions });
  } catch (err) {
    console.error('[TargetApprovals] status error:', err.message);
    res.status(500).json({ error: 'خطأ في جلب حالة الاعتماد' });
  }
});

/* ── GET /:id — request detail (for the notification's approval modal) ── */
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT tar.id, tar.year, tar.month, tar.region_id, reg.name_ar AS region_name,
              tar.sent_by_name, tar.sent_at
       FROM target_approval_requests tar
       JOIN regions reg ON reg.id = tar.region_id
       WHERE tar.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });

    const apprRes = await pool.query(
      `SELECT approved_by AS user_id, approved_by_name AS name, approved_at
       FROM target_approvals WHERE request_id = $1 ORDER BY approved_at`,
      [req.params.id]
    );

    res.json({ ...r.rows[0], approvals: apprRes.rows });
  } catch (err) {
    console.error('[TargetApprovals] detail error:', err.message);
    res.status(500).json({ error: 'خطأ في جلب تفاصيل الطلب' });
  }
});

/* ── POST /:id/approve ─────────────────────────────────────────
   Only admins or a user belonging to the request's own region may
   approve it. ── */
router.post('/:id/approve', async (req, res) => {
  try {
    const reqRow = await pool.query(
      `SELECT region_id FROM target_approval_requests WHERE id = $1`,
      [req.params.id]
    );
    if (!reqRow.rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });

    const isAdmin = ['super_admin', 'it_admin'].includes(req.user.role);
    const userRegionIds = (Array.isArray(req.user.region_ids) && req.user.region_ids.length)
      ? req.user.region_ids
      : (req.user.region_id ? [req.user.region_id] : []);
    if (!isAdmin && !userRegionIds.map(String).includes(String(reqRow.rows[0].region_id))) {
      return res.status(403).json({ error: 'لا يمكنك اعتماد أهداف منطقة أخرى' });
    }

    await pool.query(
      `INSERT INTO target_approvals (request_id, approved_by, approved_by_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (request_id, approved_by) DO NOTHING`,
      [req.params.id, req.user.id, req.user.name]
    );

    await pool.query(
      `UPDATE notifications SET is_read = true
       WHERE target_request_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );

    const apprRes = await pool.query(
      `SELECT approved_by AS user_id, approved_by_name AS name, approved_at
       FROM target_approvals WHERE request_id = $1 ORDER BY approved_at`,
      [req.params.id]
    );
    res.json({ ok: true, approvals: apprRes.rows });
  } catch (err) {
    console.error('[TargetApprovals] approve error:', err.message);
    res.status(500).json({ error: 'خطأ في تسجيل الموافقة' });
  }
});

module.exports = router;
