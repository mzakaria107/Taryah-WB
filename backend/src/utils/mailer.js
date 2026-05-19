/**
 * mailer.js — thin wrapper around nodemailer.
 * SMTP config comes from environment variables:
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM
 * If any required var is missing, sendMail silently logs a warning and returns.
 */
const nodemailer = require('nodemailer');

function createTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  return nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   parseInt(SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
    tls:    { rejectUnauthorized: false },
  });
}

/**
 * sendMail({ to, cc, subject, html })
 * `to` and `cc` can be a string or array of strings.
 * Returns true on success, false on failure (never throws).
 */
async function sendMail({ to, cc, subject, html }) {
  const transport = createTransport();
  if (!transport) {
    console.warn('[Mailer] SMTP not configured — skipping email send.');
    return false;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  // Normalise recipients
  const toList  = Array.isArray(to)  ? to.join(',')  : (to  || '');
  const ccList  = Array.isArray(cc)  ? cc.join(',')  : (cc  || '');

  if (!toList) return false;

  try {
    const info = await transport.sendMail({
      from,
      to:      toList,
      cc:      ccList || undefined,
      subject,
      html,
    });
    console.log('[Mailer] Sent:', info.messageId);
    return true;
  } catch (err) {
    console.error('[Mailer] Send error:', err.message);
    return false;
  }
}

/* ── Email templates ──────────────────────────────────────────── */

function taskAssignedHtml({ task, supervisorName, regionName, assignerName }) {
  const due = task.due_date
    ? new Date(task.due_date).toLocaleDateString('ar-SA', { year:'numeric', month:'long', day:'numeric' })
    : 'غير محدد';

  const priorityLabel = { low:'منخفضة', medium:'متوسطة', high:'عالية', urgent:'عاجلة' }[task.priority] || task.priority;

  return `
  <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:#1d4ed8;padding:20px 24px;">
      <h2 style="color:#fff;margin:0;font-size:18px;">📋 مهمة جديدة — فريق المبيعات</h2>
    </div>
    <div style="padding:24px;">
      <p style="font-size:15px;color:#111827;">مرحباً <strong>${supervisorName}</strong>،</p>
      <p style="color:#374151;">تم تعيين مهمة جديدة لك من قِبل <strong>${assignerName}</strong>.</p>

      <table style="width:100%;border-collapse:collapse;margin-top:16px;">
        <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:600;color:#6b7280;width:35%;">المهمة</td>
            <td style="padding:8px 12px;font-weight:700;color:#111827;">${task.title}</td></tr>
        <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:600;color:#6b7280;">المنطقة</td>
            <td style="padding:8px 12px;">${regionName}</td></tr>
        <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:600;color:#6b7280;">الأولوية</td>
            <td style="padding:8px 12px;"><span style="background:#fef3c7;color:#92400e;padding:2px 10px;border-radius:999px;font-size:12px;">${priorityLabel}</span></td></tr>
        <tr><td style="padding:8px 12px;background:#f9fafb;font-weight:600;color:#6b7280;">الموعد النهائي</td>
            <td style="padding:8px 12px;color:#dc2626;font-weight:600;">${due}</td></tr>
        ${task.description ? `<tr><td style="padding:8px 12px;background:#f9fafb;font-weight:600;color:#6b7280;">التفاصيل</td>
            <td style="padding:8px 12px;">${task.description}</td></tr>` : ''}
      </table>

      <p style="margin-top:20px;color:#374151;">يرجى تسجيل الدخول للنظام لاستلام المهمة والتأكيد على استلامها.</p>
    </div>
    <div style="background:#f9fafb;padding:12px 24px;font-size:12px;color:#9ca3af;text-align:center;">
      نظام إدارة مهام فريق المبيعات
    </div>
  </div>`;
}

function taskAcknowledgedHtml({ task, supervisorName, assignerName, note }) {
  return `
  <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:#059669;padding:20px 24px;">
      <h2 style="color:#fff;margin:0;font-size:18px;">✅ تم استلام المهمة</h2>
    </div>
    <div style="padding:24px;">
      <p style="font-size:15px;color:#111827;">مرحباً <strong>${assignerName}</strong>،</p>
      <p style="color:#374151;">قام <strong>${supervisorName}</strong> باستلام المهمة <strong>"${task.title}"</strong> والتأكيد على بدء العمل.</p>
      ${note ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;margin-top:12px;"><strong>ملاحظة الاستلام:</strong><br>${note}</div>` : ''}
    </div>
    <div style="background:#f9fafb;padding:12px 24px;font-size:12px;color:#9ca3af;text-align:center;">نظام إدارة مهام فريق المبيعات</div>
  </div>`;
}

function taskCompletedHtml({ task, supervisorName, assignerName, note }) {
  const completedAt = task.completed_at
    ? new Date(task.completed_at).toLocaleString('ar-SA')
    : '';
  return `
  <div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:#7c3aed;padding:20px 24px;">
      <h2 style="color:#fff;margin:0;font-size:18px;">🏁 تم إنجاز المهمة</h2>
    </div>
    <div style="padding:24px;">
      <p style="font-size:15px;color:#111827;">مرحباً <strong>${assignerName}</strong>،</p>
      <p style="color:#374151;">أعلن <strong>${supervisorName}</strong> عن إنجاز المهمة <strong>"${task.title}"</strong>.</p>
      ${completedAt ? `<p style="color:#6b7280;font-size:13px;">وقت الانتهاء: ${completedAt}</p>` : ''}
      ${note ? `<div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:12px 16px;margin-top:12px;"><strong>تقرير الإنجاز:</strong><br>${note}</div>` : ''}
    </div>
    <div style="background:#f9fafb;padding:12px 24px;font-size:12px;color:#9ca3af;text-align:center;">نظام إدارة مهام فريق المبيعات</div>
  </div>`;
}

module.exports = { sendMail, taskAssignedHtml, taskAcknowledgedHtml, taskCompletedHtml };
