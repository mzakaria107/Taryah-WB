const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const pool     = require('../db/pool');
const { verifyToken, requireRoles } = require('../middleware/auth');
const { sendMail, taskAssignedHtml, taskAcknowledgedHtml, taskCompletedHtml } = require('../utils/mailer');
const { createTaskNotification } = require('../utils/notifHelper');

const router = express.Router();

// ── Upload dir ───────────────────────────────────────────────────
const uploadDir = path.join(process.env.UPLOAD_DIR || './uploads', 'tasks');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer sends filenames as Latin-1 encoded bytes of what is actually UTF-8.
// Re-decode to get the correct Arabic/Unicode filename.
function fixName(raw) {
  try { return Buffer.from(raw, 'latin1').toString('utf8'); } catch { return raw; }
}

const taskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename:    (_req, file, cb) => {
    const ts   = Date.now();
    const name = fixName(file.originalname);
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${ts}-${safe}`);
  },
});
const taskUpload = multer({ storage: taskStorage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── Access helpers ───────────────────────────────────────────────
const ADMIN_ROLES = ['super_admin', 'it_admin'];
const isAdmin = (user) => ADMIN_ROLES.includes(user.role);

// Build region WHERE clause based on user role
function regionWhere(user, alias = '') {
  const col = alias ? `${alias}.region_id` : 'region_id';
  if (isAdmin(user)) return { sql: '', vals: [], nextP: 1 };
  return { sql: ` AND ${col} = $1`, vals: [user.region_id], nextP: 2 };
}

// ════════════════════════════════════════════════════════════════
//  SUPERVISORS
// ════════════════════════════════════════════════════════════════

// GET /supervisors
router.get('/supervisors', verifyToken, async (req, res) => {
  try {
    const rw = regionWhere(req.user);
    const result = await pool.query(
      `SELECT s.id, s.name, s.email, s.phone, s.is_active, s.created_at,
              s.region_id, r.name_ar AS region_name_ar, r.name_en AS region_name_en
       FROM sales_supervisors s
       LEFT JOIN regions r ON r.id = s.region_id
       WHERE 1=1 ${rw.sql.replace('$1', `$${rw.nextP === 1 ? 1 : 1}`)}
       ORDER BY r.name_ar, s.name`,
      rw.vals
    );
    res.json({ supervisors: result.rows });
  } catch (err) {
    console.error('[SalesTasks] supervisors list error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /supervisors  (admin only)
router.post('/supervisors', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const { name, region_id, email, phone } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'اسم المشرف مطلوب' });

  try {
    const result = await pool.query(
      `INSERT INTO sales_supervisors (name, region_id, email, phone, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, region_id, email, phone, is_active, created_at`,
      [name.trim(), region_id || null, email?.trim() || null, phone?.trim() || null, req.user.id]
    );
    res.status(201).json({ supervisor: result.rows[0] });
  } catch (err) {
    console.error('[SalesTasks] create supervisor error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// PUT /supervisors/:id  (admin only)
router.put('/supervisors/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  const { name, region_id, email, phone, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE sales_supervisors SET
         name      = COALESCE($1, name),
         region_id = COALESCE($2, region_id),
         email     = COALESCE($3, email),
         phone     = COALESCE($4, phone),
         is_active = COALESCE($5, is_active)
       WHERE id = $6
       RETURNING id, name, region_id, email, phone, is_active`,
      [name?.trim() || null, region_id || null, email?.trim() || null,
       phone?.trim() || null, is_active != null ? is_active : null, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'المشرف غير موجود' });
    res.json({ supervisor: result.rows[0] });
  } catch (err) {
    console.error('[SalesTasks] update supervisor error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// DELETE /supervisors/:id  (admin only)
router.delete('/supervisors/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    await pool.query('DELETE FROM sales_supervisors WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[SalesTasks] delete supervisor error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ════════════════════════════════════════════════════════════════
//  TASKS — LIST & CREATE
// ════════════════════════════════════════════════════════════════

// GET /tasks
router.get('/tasks', verifyToken, async (req, res) => {
  const { status, region_id, supervisor_id } = req.query;
  try {
    const conds  = ['1=1'];
    const vals   = [];
    let p = 1;

    // Region access control
    if (!isAdmin(req.user)) {
      conds.push(`t.region_id = $${p++}`);
      vals.push(req.user.region_id);
    } else if (region_id) {
      conds.push(`t.region_id = $${p++}`);
      vals.push(parseInt(region_id, 10));
    }

    if (status)      { conds.push(`t.status = $${p++}`);           vals.push(status); }
    if (supervisor_id) { conds.push(`t.supervisor_id = $${p++}`);  vals.push(supervisor_id); }

    const result = await pool.query(
      `SELECT
         t.id, t.title, t.description, t.priority, t.status,
         t.due_date, t.created_at, t.updated_at,
         t.acknowledged_at, t.started_at, t.completed_at,
         t.assigner_name, t.assigner_email, t.assignee_email,
         t.region_id,
         r.name_ar  AS region_name_ar,
         r.name_en  AS region_name_en,
         t.supervisor_id,
         s.name     AS supervisor_name,
         (SELECT COUNT(*) FROM sales_task_notes  n WHERE n.task_id = t.id) AS notes_count,
         (SELECT COUNT(*) FROM sales_task_files  f WHERE f.task_id = t.id) AS files_count
       FROM sales_tasks t
       LEFT JOIN regions           r ON r.id = t.region_id
       LEFT JOIN sales_supervisors s ON s.id = t.supervisor_id
       WHERE ${conds.join(' AND ')}
       ORDER BY
         CASE t.status
           WHEN 'pending'      THEN 1
           WHEN 'acknowledged' THEN 2
           WHEN 'in_progress'  THEN 3
           WHEN 'completed'    THEN 5
           WHEN 'cancelled'    THEN 6
           ELSE 4
         END,
         CASE t.priority
           WHEN 'urgent' THEN 1 WHEN 'high' THEN 2
           WHEN 'medium' THEN 3 ELSE 4
         END,
         t.due_date ASC NULLS LAST,
         t.created_at DESC`,
      vals
    );
    res.json({ tasks: result.rows });
  } catch (err) {
    console.error('[SalesTasks] tasks list error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /tasks  (with optional file upload)
router.post('/tasks', verifyToken, taskUpload.array('files', 5), async (req, res) => {
  const {
    title, description, region_id, supervisor_id,
    assigner_email, assignee_email, cc_emails,
    due_date, priority,
  } = req.body;

  if (!title?.trim())       return res.status(400).json({ error: 'عنوان المهمة مطلوب' });
  if (!supervisor_id)       return res.status(400).json({ error: 'يجب تحديد المشرف' });

  // Non-admins can only create tasks for their own region
  const taskRegion = parseInt(region_id, 10) || null;
  if (!isAdmin(req.user) && taskRegion !== req.user.region_id) {
    return res.status(403).json({ error: 'لا يمكنك تعيين مهمة لمنطقة أخرى' });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Get supervisor & region info for email
    const supRes = await dbClient.query(
      `SELECT s.name, s.email, r.name_ar, r.name_en
       FROM sales_supervisors s
       LEFT JOIN regions r ON r.id = s.region_id
       WHERE s.id = $1`,
      [supervisor_id]
    );
    const sup = supRes.rows[0] || {};

    const taskRes = await dbClient.query(
      `INSERT INTO sales_tasks
         (title, description, region_id, supervisor_id, assigned_by,
          assigner_name, assigner_email, assignee_email, cc_emails,
          due_date, priority, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
       RETURNING *`,
      [
        title.trim(),
        description?.trim() || null,
        taskRegion,
        supervisor_id,
        req.user.id,
        req.user.name || req.user.email || 'مسؤول',
        assigner_email?.trim() || null,
        assignee_email?.trim() || sup.email || null,
        cc_emails?.trim() || null,
        due_date || null,
        priority || 'medium',
      ]
    );
    const task = taskRes.rows[0];

    // Save uploaded files (assignment stage)
    if (req.files?.length) {
      for (const f of req.files) {
        await dbClient.query(
          `INSERT INTO sales_task_files
             (task_id, original_name, stored_name, file_size, mime_type, upload_stage, uploaded_by, uploaded_by_name)
           VALUES ($1,$2,$3,$4,$5,'assignment',$6,$7)`,
          [task.id, fixName(f.originalname), f.filename, f.size, f.mimetype,
           req.user.id, req.user.name || req.user.email]
        );
      }
    }

    await dbClient.query('COMMIT');

    // ── Send email notifications (non-blocking) ──
    const regionName   = sup.name_ar || sup.name_en || 'غير محدد';
    const supervisorName = sup.name || 'المشرف';
    const assignerName = req.user.name || req.user.email || 'المسؤول';

    const toList   = [assignee_email?.trim(), sup.email].filter(Boolean);
    const ccList   = [assigner_email?.trim(), ...(cc_emails ? cc_emails.split(',').map(e => e.trim()) : [])].filter(Boolean);

    if (toList.length) {
      sendMail({
        to:      toList,
        cc:      ccList,
        subject: `📋 مهمة جديدة: ${task.title}`,
        html:    taskAssignedHtml({ task, supervisorName, regionName, assignerName }),
      }).catch(() => {});
    }

    // In-app notifications
    createTaskNotification({
      regionId:      taskRegion,
      excludeUserId: req.user.id,
      title:         `📋 مهمة جديدة: ${task.title}`,
      body:          `تم إنشاء مهمة جديدة في منطقة ${regionName} بواسطة ${assignerName}`,
      type:          'task_created',
      taskId:        task.id,
    }).catch(() => {});

    res.status(201).json({ task });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    // Clean up uploaded files on error
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
    console.error('[SalesTasks] create task error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    dbClient.release();
  }
});

// ════════════════════════════════════════════════════════════════
//  TASK DETAIL & UPDATES
// ════════════════════════════════════════════════════════════════

// GET /tasks/:id
router.get('/tasks/:id', verifyToken, async (req, res) => {
  try {
    const taskRes = await pool.query(
      `SELECT t.*, r.name_ar AS region_name_ar, r.name_en AS region_name_en,
              s.name AS supervisor_name, s.email AS supervisor_email
       FROM sales_tasks t
       LEFT JOIN regions           r ON r.id = t.region_id
       LEFT JOIN sales_supervisors s ON s.id = t.supervisor_id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!taskRes.rowCount) return res.status(404).json({ error: 'المهمة غير موجودة' });
    const task = taskRes.rows[0];

    // Region check for non-admin
    if (!isAdmin(req.user) && task.region_id !== req.user.region_id) {
      return res.status(403).json({ error: 'ليس لديك صلاحية لعرض هذه المهمة' });
    }

    const [notesRes, filesRes] = await Promise.all([
      pool.query(
        `SELECT * FROM sales_task_notes WHERE task_id = $1 ORDER BY added_at ASC`,
        [req.params.id]
      ),
      pool.query(
        `SELECT * FROM sales_task_files WHERE task_id = $1 ORDER BY uploaded_at ASC`,
        [req.params.id]
      ),
    ]);

    res.json({ task, notes: notesRes.rows, files: filesRes.rows });
  } catch (err) {
    console.error('[SalesTasks] task detail error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// PUT /tasks/:id/acknowledge
router.put('/tasks/:id/acknowledge', verifyToken, async (req, res) => {
  const { note } = req.body;
  try {
    const result = await pool.query(
      `UPDATE sales_tasks SET
         status               = 'acknowledged',
         acknowledged_at      = NOW(),
         acknowledgement_note = $1,
         updated_at           = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [note?.trim() || null, req.params.id]
    );
    if (!result.rowCount) return res.status(400).json({ error: 'المهمة غير موجودة أو لا يمكن استلامها' });
    const task = result.rows[0];

    // Notify assigner
    const supRes = await pool.query(`SELECT name FROM sales_supervisors WHERE id = $1`, [task.supervisor_id]);
    const supervisorName = supRes.rows[0]?.name || 'المشرف';

    const toList = [task.assigner_email].filter(Boolean);
    const ccList = task.cc_emails ? task.cc_emails.split(',').map(e => e.trim()).filter(Boolean) : [];
    if (toList.length) {
      sendMail({
        to:      toList,
        cc:      ccList,
        subject: `✅ تم استلام المهمة: ${task.title}`,
        html:    taskAcknowledgedHtml({ task, supervisorName, assignerName: task.assigner_name, note }),
      }).catch(() => {});
    }

    // In-app notifications
    createTaskNotification({
      regionId:      task.region_id,
      excludeUserId: req.user.id,
      title:         `👀 تم استلام المهمة: ${task.title}`,
      body:          `المشرف ${supervisorName} أكّد استلام المهمة`,
      type:          'task_acknowledged',
      taskId:        task.id,
    }).catch(() => {});

    res.json({ task });
  } catch (err) {
    console.error('[SalesTasks] acknowledge error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// PUT /tasks/:id/start
router.put('/tasks/:id/start', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE sales_tasks SET
         status     = 'in_progress',
         started_at = NOW(),
         updated_at = NOW()
       WHERE id = $1 AND status IN ('pending','acknowledged')
       RETURNING *`,
      [req.params.id]
    );
    if (!result.rowCount) return res.status(400).json({ error: 'لا يمكن تحديث حالة المهمة' });
    const task = result.rows[0];

    // In-app notifications
    createTaskNotification({
      regionId:      task.region_id,
      excludeUserId: req.user.id,
      title:         `⚙️ بدأ تنفيذ المهمة: ${task.title}`,
      body:          'تم تغيير حالة المهمة إلى قيد التنفيذ',
      type:          'task_started',
      taskId:        task.id,
    }).catch(() => {});

    res.json({ task });
  } catch (err) {
    console.error('[SalesTasks] start error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// PUT /tasks/:id/complete  (with optional file upload)
router.put('/tasks/:id/complete', verifyToken, taskUpload.array('files', 5), async (req, res) => {
  const { note } = req.body;
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const result = await dbClient.query(
      `UPDATE sales_tasks SET
         status          = 'completed',
         completed_at    = NOW(),
         completion_note = $1,
         updated_at      = NOW()
       WHERE id = $2 AND status NOT IN ('completed','cancelled')
       RETURNING *`,
      [note?.trim() || null, req.params.id]
    );
    if (!result.rowCount) {
      await dbClient.query('ROLLBACK');
      return res.status(400).json({ error: 'لا يمكن إكمال هذه المهمة' });
    }
    const task = result.rows[0];

    // Save completion files
    if (req.files?.length) {
      for (const f of req.files) {
        await dbClient.query(
          `INSERT INTO sales_task_files
             (task_id, original_name, stored_name, file_size, mime_type, upload_stage, uploaded_by, uploaded_by_name)
           VALUES ($1,$2,$3,$4,$5,'completion',$6,$7)`,
          [task.id, fixName(f.originalname), f.filename, f.size, f.mimetype,
           req.user.id, req.user.name || req.user.email]
        );
      }
    }

    await dbClient.query('COMMIT');

    // Notify assigner
    const supRes = await pool.query(`SELECT name FROM sales_supervisors WHERE id = $1`, [task.supervisor_id]);
    const supervisorName = supRes.rows[0]?.name || 'المشرف';
    const toList = [task.assigner_email].filter(Boolean);
    const ccList = task.cc_emails ? task.cc_emails.split(',').map(e => e.trim()).filter(Boolean) : [];
    if (toList.length) {
      sendMail({
        to:      toList,
        cc:      ccList,
        subject: `🏁 تم إنجاز المهمة: ${task.title}`,
        html:    taskCompletedHtml({ task, supervisorName, assignerName: task.assigner_name, note }),
      }).catch(() => {});
    }

    // In-app notifications
    createTaskNotification({
      regionId:      task.region_id,
      excludeUserId: req.user.id,
      title:         `✅ تم إنجاز المهمة: ${task.title}`,
      body:          note ? `ملاحظة الإنجاز: ${note}` : 'تم إنجاز المهمة بنجاح',
      type:          'task_completed',
      taskId:        task.id,
    }).catch(() => {});

    res.json({ task });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
    console.error('[SalesTasks] complete error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    dbClient.release();
  }
});

// PUT /tasks/:id/cancel  (admin only)
router.put('/tasks/:id/cancel', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE sales_tasks SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND status NOT IN ('completed','cancelled') RETURNING *`,
      [req.params.id]
    );
    if (!result.rowCount) return res.status(400).json({ error: 'لا يمكن إلغاء هذه المهمة' });
    const cancelledTask = result.rows[0];

    // In-app notifications
    createTaskNotification({
      regionId:      cancelledTask.region_id,
      excludeUserId: req.user.id,
      title:         `❌ تم إلغاء المهمة: ${cancelledTask.title}`,
      body:          'تم إلغاء المهمة بواسطة المسؤول',
      type:          'task_cancelled',
      taskId:        cancelledTask.id,
    }).catch(() => {});

    res.json({ task: cancelledTask });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// DELETE /tasks/:id  (admin only)
router.delete('/tasks/:id', verifyToken, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    // Files will be cascade-deleted by DB; clean up physical files too
    const filesRes = await pool.query(
      `SELECT stored_name FROM sales_task_files WHERE task_id = $1`, [req.params.id]
    );
    await pool.query('DELETE FROM sales_tasks WHERE id = $1', [req.params.id]);

    for (const f of filesRes.rows) {
      const fp = path.join(uploadDir, f.stored_name);
      try { fs.unlinkSync(fp); } catch (_) {}
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[SalesTasks] delete error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ════════════════════════════════════════════════════════════════
//  NOTES
// ════════════════════════════════════════════════════════════════

router.post('/tasks/:id/notes', verifyToken, async (req, res) => {
  const { note_text } = req.body;
  if (!note_text?.trim()) return res.status(400).json({ error: 'نص الملاحظة مطلوب' });

  try {
    const result = await pool.query(
      `INSERT INTO sales_task_notes (task_id, note_text, added_by, added_by_name)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.params.id, note_text.trim(), req.user.id, req.user.name || req.user.email]
    );
    await pool.query(`UPDATE sales_tasks SET updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.status(201).json({ note: result.rows[0] });
  } catch (err) {
    console.error('[SalesTasks] add note error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ════════════════════════════════════════════════════════════════
//  FILES
// ════════════════════════════════════════════════════════════════

router.post('/tasks/:id/files', verifyToken, taskUpload.array('files', 5), async (req, res) => {
  const { stage = 'note' } = req.body;
  if (!req.files?.length) return res.status(400).json({ error: 'لم يتم رفع ملفات' });

  try {
    const saved = [];
    for (const f of req.files) {
      const r = await pool.query(
        `INSERT INTO sales_task_files
           (task_id, original_name, stored_name, file_size, mime_type, upload_stage, uploaded_by, uploaded_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.params.id, fixName(f.originalname), f.filename, f.size, f.mimetype,
         stage, req.user.id, req.user.name || req.user.email]
      );
      saved.push(r.rows[0]);
    }
    await pool.query(`UPDATE sales_tasks SET updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.status(201).json({ files: saved });
  } catch (err) {
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
    console.error('[SalesTasks] upload file error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// GET /tasks/files/:storedName  — download file
router.get('/files/:storedName', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.*, t.region_id FROM sales_task_files f
       JOIN sales_tasks t ON t.id = f.task_id
       WHERE f.stored_name = $1`,
      [req.params.storedName]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'الملف غير موجود' });
    const file = result.rows[0];

    if (!isAdmin(req.user) && file.region_id !== req.user.region_id) {
      return res.status(403).json({ error: 'ليس لديك صلاحية' });
    }

    const fp = path.join(uploadDir, file.stored_name);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'الملف غير موجود على الخادم' });

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
    res.sendFile(path.resolve(fp));
  } catch (err) {
    console.error('[SalesTasks] download error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ── GET /regions (for supervisor form) ──────────────────────────
router.get('/regions', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name_ar, name_en FROM regions ORDER BY name_ar`
    );
    res.json({ regions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
