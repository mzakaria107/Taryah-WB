const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

const router = express.Router();

/* ─────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────── */

/** Log invoice-note save to note_history (tied to invoice lifecycle) */
async function addInvoiceHistory(client, { invoice_id, customer_id, note_text, user_id }) {
  await client.query(
    `INSERT INTO note_history (invoice_id, customer_id, note_type, note_text, user_id)
     VALUES ($1, $2, 'invoice', $3, $4)`,
    [invoice_id || null, customer_id || null, note_text, user_id || null]
  );
}

/** Log customer-note save to customer_note_history (PROTECTED — never truncated) */
async function addCustomerHistory(client, { customer_id, note_text, user_id }) {
  await client.query(
    `INSERT INTO customer_note_history (customer_id, note_text, user_id)
     VALUES ($1, $2, $3)`,
    [customer_id, note_text, user_id || null]
  );
}

/* ─────────────────────────────────────────────────────────────
   GET /api/notes/report  — full note history (all customers)
   Shows customer notes from customer_note_history (protected)
   and invoice notes from note_history, merged.
───────────────────────────────────────────────────────────── */
router.get('/report', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const { search, note_type, from_date, to_date, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // ── Customer notes branch (from protected table) ────────────
    const custConds  = [];
    const custParams = [];
    let cp = 1;

    if (req.regionFilter) {
      custConds.push(
        `EXISTS (SELECT 1 FROM invoices WHERE customer_id = cnh.customer_id AND region_id = $${cp++})`
      );
      custParams.push(req.regionFilter);
    }
    if (from_date) { custConds.push(`cnh.created_at >= $${cp++}`);                              custParams.push(from_date); }
    if (to_date)   { custConds.push(`cnh.created_at < ($${cp++}::date + interval '1 day')`);    custParams.push(to_date); }
    if (search)    { custConds.push(`(cn_name.customer_name ILIKE $${cp} OR cnh.customer_id ILIKE $${cp})`); custParams.push(`%${search}%`); cp++; }

    const custWhere = custConds.length ? 'WHERE ' + custConds.join(' AND ') : '';

    // ── Invoice notes branch (from note_history) ────────────────
    const invConds  = [];
    const invParams = [];
    let ip = 1;

    if (req.regionFilter) {
      invConds.push(`EXISTS (SELECT 1 FROM invoices WHERE id = nh.invoice_id AND region_id = $${ip++})`);
      invParams.push(req.regionFilter);
    }
    if (from_date) { invConds.push(`nh.created_at >= $${ip++}`);                              invParams.push(from_date); }
    if (to_date)   { invConds.push(`nh.created_at < ($${ip++}::date + interval '1 day')`);    invParams.push(to_date); }
    if (search) {
      invConds.push(`(inv_n.customer_name ILIKE $${ip} OR COALESCE(nh.customer_id, inv.customer_id) ILIKE $${ip})`);
      invParams.push(`%${search}%`); ip++;
    }
    invConds.push(`nh.note_type = 'invoice'`);
    const invWhere = 'WHERE ' + invConds.join(' AND ');

    // Build the two branches (may be filtered by note_type)
    const includeCust = !note_type || note_type === 'all' || note_type === 'customer';
    const includeInv  = !note_type || note_type === 'all' || note_type === 'invoice';

    // We'll gather all combined rows then paginate in JS for simplicity
    // (the total row count is usually small enough)
    const parts = [];

    if (includeCust) {
      const cRes = await pool.query(
        `SELECT
           cnh.id,
           cnh.created_at,
           cnh.note_text,
           'customer'           AS note_type,
           cnh.customer_id,
           cn_name.customer_name,
           cn_name.customer_name_en,
           NULL::uuid           AS invoice_id,
           NULL::text           AS invoice_number,
           u.name               AS user_name
         FROM customer_note_history cnh
         LEFT JOIN users u ON u.id = cnh.user_id
         LEFT JOIN LATERAL (
           SELECT customer_name, customer_name_en
           FROM   invoices
           WHERE  customer_id = cnh.customer_id
           LIMIT  1
         ) cn_name ON true
         ${custWhere}`,
        custParams
      );
      parts.push(...cRes.rows);
    }

    if (includeInv) {
      const iRes = await pool.query(
        `SELECT
           nh.id,
           nh.created_at,
           nh.note_text,
           'invoice'            AS note_type,
           COALESCE(nh.customer_id, inv.customer_id) AS customer_id,
           inv_n.customer_name,
           inv_n.customer_name_en,
           nh.invoice_id,
           inv.invoice_number,
           u.name               AS user_name
         FROM note_history nh
         LEFT JOIN users    u   ON u.id  = nh.user_id
         LEFT JOIN invoices inv ON inv.id = nh.invoice_id
         LEFT JOIN LATERAL (
           SELECT customer_name, customer_name_en
           FROM   invoices
           WHERE  customer_id = COALESCE(nh.customer_id, inv.customer_id)
           LIMIT  1
         ) inv_n ON true
         ${invWhere}`,
        invParams
      );
      parts.push(...iRes.rows);
    }

    // Sort combined by created_at DESC, then paginate
    parts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const total    = parts.length;
    const pageRows = parts.slice(offset, offset + parseInt(limit));

    res.json({ total, page: parseInt(page), limit: parseInt(limit), rows: pageRows });
  } catch (err) {
    console.error('Notes report error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/notes/history/:customerId
   Returns full note history for one customer:
   - customer notes  → from customer_note_history (protected)
   - invoice notes   → from note_history
───────────────────────────────────────────────────────────── */
router.get('/history/:customerId', verifyToken, async (req, res) => {
  try {
    const { customerId } = req.params;

    const [custRes, invRes] = await Promise.all([
      // Customer notes — protected permanent table
      pool.query(
        `SELECT
           cnh.id,
           cnh.created_at,
           cnh.note_text,
           'customer' AS note_type,
           cnh.customer_id,
           NULL::uuid AS invoice_id,
           NULL::text AS invoice_number,
           u.name     AS user_name
         FROM customer_note_history cnh
         LEFT JOIN users u ON u.id = cnh.user_id
         WHERE cnh.customer_id = $1
         ORDER BY cnh.created_at DESC`,
        [customerId]
      ),
      // Invoice notes for this customer
      pool.query(
        `SELECT
           nh.id,
           nh.created_at,
           nh.note_text,
           nh.note_type,
           COALESCE(nh.customer_id, inv.customer_id) AS customer_id,
           nh.invoice_id,
           inv.invoice_number,
           u.name AS user_name
         FROM note_history nh
         LEFT JOIN users    u   ON u.id  = nh.user_id
         LEFT JOIN invoices inv ON inv.id = nh.invoice_id
         WHERE nh.note_type = 'invoice'
           AND (nh.customer_id = $1 OR inv.customer_id = $1)
         ORDER BY nh.created_at DESC`,
        [customerId]
      ),
    ]);

    const combined = [...custRes.rows, ...invRes.rows]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json(combined);
  } catch (err) {
    console.error('Customer notes history error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ─────────────────────────────────────────────────────────────
   DELETE /api/notes/history/:historyId  (super_admin only)
   Searches both history tables.
───────────────────────────────────────────────────────────── */
router.delete('/history/:historyId', verifyToken, async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'هذه العملية متاحة لمدير النظام فقط' });
  }
  try {
    const id = req.params.historyId;
    // Try customer_note_history first, then note_history
    const r1 = await pool.query('DELETE FROM customer_note_history WHERE id = $1', [id]);
    if (r1.rowCount) return res.json({ success: true });
    const r2 = await pool.query('DELETE FROM note_history WHERE id = $1', [id]);
    if (!r2.rowCount) return res.status(404).json({ error: 'السجل غير موجود' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete history error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ─────────────────────────────────────────────────────────────
   DELETE /api/notes/invoice/:invoiceId  (super_admin only)
───────────────────────────────────────────────────────────── */
router.delete('/invoice/:invoiceId', verifyToken, async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'هذه العملية متاحة لمدير النظام فقط' });
  }
  try {
    await pool.query('DELETE FROM notes WHERE invoice_id = $1', [req.params.invoiceId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete invoice note error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ─────────────────────────────────────────────────────────────
   DELETE /api/notes/customer/:customerId  (super_admin only)
   Deletes current note only — history is preserved.
───────────────────────────────────────────────────────────── */
router.delete('/customer/:customerId', verifyToken, async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'هذه العملية متاحة لمدير النظام فقط' });
  }
  try {
    // Remove current note but keep full history in customer_note_history
    await pool.query(
      'DELETE FROM customer_notes WHERE customer_id = $1',
      [req.params.customerId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Delete customer note error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET  /api/notes/invoice/:invoiceId
   PUT  /api/notes/invoice/:invoiceId   (upsert + history)
───────────────────────────────────────────────────────────── */
router.get('/invoice/:invoiceId', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.*, u.name AS author_name
       FROM notes n LEFT JOIN users u ON u.id = n.user_id
       WHERE n.invoice_id = $1`,
      [req.params.invoiceId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('Notes get error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.put('/invoice/:invoiceId', verifyToken, async (req, res) => {
  const { note_text } = req.body;
  const { invoiceId } = req.params;
  if (note_text === undefined) return res.status(400).json({ error: 'نص الملاحظة مطلوب' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inv = await client.query('SELECT id, customer_id FROM invoices WHERE id = $1', [invoiceId]);
    if (!inv.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    }

    const { rows } = await client.query(
      `INSERT INTO notes (id, invoice_id, user_id, note_text, note_type, updated_at)
       VALUES ($1, $2, $3, $4, 'invoice', NOW())
       ON CONFLICT (invoice_id)
       DO UPDATE SET note_text=$4, user_id=$3, updated_at=NOW()
       RETURNING *`,
      [uuidv4(), invoiceId, req.user.id, note_text]
    );

    await addInvoiceHistory(client, {
      invoice_id:  invoiceId,
      customer_id: inv.rows[0].customer_id,
      note_text,
      user_id:     req.user.id,
    });

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Invoice note upsert error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

/* ─────────────────────────────────────────────────────────────
   GET  /api/notes/customer/:customerId
   PUT  /api/notes/customer/:customerId  (upsert + protected history)

   ✅ Uses customer_notes table — NO FK to invoices
   ✅ History stored in customer_note_history — NO FK to invoices
   ✅ Completely safe from TRUNCATE invoices CASCADE
───────────────────────────────────────────────────────────── */
router.get('/customer/:customerId', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cn.*, u.name AS author_name
       FROM customer_notes cn
       LEFT JOIN users u ON u.id = cn.user_id
       WHERE cn.customer_id = $1`,
      [req.params.customerId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('Customer note get error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

router.put('/customer/:customerId', verifyToken, async (req, res) => {
  const { note_text } = req.body;
  const { customerId } = req.params;
  if (note_text === undefined) return res.status(400).json({ error: 'نص الملاحظة مطلوب' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert current note in protected table
    const { rows } = await client.query(
      `INSERT INTO customer_notes (id, customer_id, user_id, note_text, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (customer_id)
       DO UPDATE SET note_text = $4, user_id = $3, updated_at = NOW()
       RETURNING *`,
      [uuidv4(), customerId, req.user.id, note_text]
    );

    // Append to permanent audit trail
    await addCustomerHistory(client, {
      customer_id: customerId,
      note_text,
      user_id: req.user.id,
    });

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Customer note upsert error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

/* ─────────────────────────────────────────────────────────────
   Legacy  GET/PUT /api/notes/:invoiceId  (backward compat)
───────────────────────────────────────────────────────────── */
router.get('/:invoiceId', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.*, u.name AS author_name
       FROM notes n LEFT JOIN users u ON u.id = n.user_id
       WHERE n.invoice_id = $1`,
      [req.params.invoiceId]
    );
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

router.put('/:invoiceId', verifyToken, async (req, res) => {
  const { note_text } = req.body;
  const { invoiceId } = req.params;
  if (note_text === undefined) return res.status(400).json({ error: 'نص الملاحظة مطلوب' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = await client.query('SELECT id, customer_id FROM invoices WHERE id = $1', [invoiceId]);
    if (!inv.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الفاتورة غير موجودة' });
    }
    const { rows } = await client.query(
      `INSERT INTO notes (id, invoice_id, user_id, note_text, note_type, updated_at)
       VALUES ($1, $2, $3, $4, 'invoice', NOW())
       ON CONFLICT (invoice_id)
       DO UPDATE SET note_text=$4, user_id=$3, updated_at=NOW()
       RETURNING *`,
      [uuidv4(), invoiceId, req.user.id, note_text]
    );
    await addInvoiceHistory(client, {
      invoice_id:  invoiceId,
      customer_id: inv.rows[0].customer_id,
      note_text,
      user_id:     req.user.id,
    });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Note upsert error:', err);
    res.status(500).json({ error: 'خطأ في الخادم' });
  } finally {
    client.release();
  }
});

module.exports = router;
