/**
 * notifHelper.js
 * Helper to create in-app notifications for task events.
 * Notifications are sent to:
 *   • All admins (super_admin / it_admin)
 *   • All users whose region_id matches the task's region_id
 */

const pool = require('../db/pool');

const ADMIN_ROLES = ['super_admin', 'it_admin'];

/**
 * Resolve the list of user UUIDs to notify.
 * @param {number|null} regionId - The task's region id
 * @param {string|null} excludeUserId - Don't notify the actor themselves
 */
async function resolveRecipients(regionId, excludeUserId = null) {
  const { rows } = await pool.query(
    `SELECT id FROM users
     WHERE role = ANY($1)
        OR ($2::integer IS NOT NULL AND region_id = $2)`,
    [ADMIN_ROLES, regionId]
  );
  return rows
    .map(r => r.id)
    .filter(id => id !== excludeUserId);
}

/**
 * Insert one notification row per recipient (deduped).
 * @param {object} opts
 * @param {number|null} opts.regionId
 * @param {string|null} opts.excludeUserId
 * @param {string}      opts.title
 * @param {string}      opts.body
 * @param {string}      opts.type
 * @param {string|null} opts.taskId
 */
async function createTaskNotification({ regionId, excludeUserId = null, title, body, type = 'task', taskId = null }) {
  try {
    const recipients = await resolveRecipients(regionId, excludeUserId);
    if (!recipients.length) return;

    // Build bulk INSERT values
    const values = recipients.map((uid, i) => {
      const base = i * 5;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    }).join(', ');

    const params = recipients.flatMap(uid => [uid, title, body, type, taskId]);

    await pool.query(
      `INSERT INTO notifications (user_id, title, body, type, task_id)
       VALUES ${values}`,
      params
    );
  } catch (err) {
    console.error('[notifHelper] failed to create notifications:', err.message);
  }
}

module.exports = { createTaskNotification };
