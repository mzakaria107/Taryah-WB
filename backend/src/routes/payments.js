const express = require('express');
const xlsx    = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const pool    = require('../db/pool');
const upload  = require('../middleware/upload');
const { verifyToken, requireRoles } = require('../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function safeFloat(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function serialToDate(serial) {
  if (!serial) return null;
  if (typeof serial === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(serial.trim()))
    return serial.trim();
  const num = parseFloat(serial);
  if (isNaN(num)) return null;
  try {
    const p = xlsx.SSF.parse_date_code(num);
    if (!p) return null;
    return `${p.y}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')}`;
  } catch { return null; }
}

// ─────────────────────────────────────────────
// POST /api/payments/upload
// Accepts Route Invoice Collection Payment.xlsx
// Upserts by document_number (safe re-upload)
// Columns: Tran Date | Journey ID | Visit Key | Transaction Key |
//          Invoice Number | Document Number | Route Code |
//          Bank Name English | Customercode | Customer Name |
//          Cash | Cheque | Bank Tran | POS
// ─────────────────────────────────────────────
const UPSERT_BATCH = 300;
const COLS_UPSERT  = 14; // matches placeholders below

async function batchUpsertPayments(dbClient, rows) {
  let inserted = 0, updated = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const chunk  = rows.slice(i, i + UPSERT_BATCH);
    const vals   = [];
    const ph     = chunk.map((r, idx) => {
      const b = idx * COLS_UPSERT;
      vals.push(
        r.document_number, r.invoice_number, r.customer_code,
        r.customer_name,   r.route_code,     r.bank_name,
        r.tran_date,       r.journey_id,     r.visit_key,
        r.transaction_key, r.cash,           r.cheque,
        r.bank_tran,       r.pos,
      );
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14})`;
    });

    const res = await dbClient.query(
      `INSERT INTO payments
         (document_number, invoice_number, customer_code, customer_name,
          route_code, bank_name, tran_date, journey_id, visit_key,
          transaction_key, cash, cheque, bank_tran, pos)
       VALUES ${ph.join(',')}
       ON CONFLICT (document_number) DO UPDATE SET
         invoice_number  = EXCLUDED.invoice_number,
         customer_code   = EXCLUDED.customer_code,
         customer_name   = EXCLUDED.customer_name,
         route_code      = EXCLUDED.route_code,
         bank_name       = EXCLUDED.bank_name,
         tran_date       = EXCLUDED.tran_date,
         journey_id      = EXCLUDED.journey_id,
         visit_key       = EXCLUDED.visit_key,
         transaction_key = EXCLUDED.transaction_key,
         cash            = EXCLUDED.cash,
         cheque          = EXCLUDED.cheque,
         bank_tran       = EXCLUDED.bank_tran,
         pos             = EXCLUDED.pos,
         uploaded_at     = NOW()`,
      vals
    );
    // pg doesn't give split insert/update counts from ON CONFLICT; estimate from rowCount
    inserted += chunk.length;
  }
  return inserted;
}

router.post(
  '/upload',
  verifyToken,
  requireRoles('super_admin', 'it_admin'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });

    try {
      console.log(`[Payments] Reading: ${req.file.originalname}`);
      const workbook = xlsx.readFile(req.file.path, {
        cellDates: false, dense: true, sheetStubs: false,
      });
      const rawRows = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
        defval: '', raw: true,
      });
      console.log(`[Payments] Parsed ${rawRows.length} rows`);

      if (!rawRows.length)
        return res.status(400).json({ error: 'الملف فارغ' });

      // ── Parse & aggregate by document_number ────────────────────
      // Some documents span multiple rows (e.g. cash on row A, POS on row B).
      // We GROUP BY document_number and SUM the payment columns.
      const docMap  = new Map();   // docNum → aggregated row
      const errors  = [];

      for (let i = 0; i < rawRows.length; i++) {
        const row    = rawRows[i];
        const rowNum = i + 2;

        const docNum = String(row['Document Number'] || '').trim();
        if (!docNum) { errors.push({ row: rowNum, error: 'Document Number مفقود' }); continue; }

        const cash     = safeFloat(row['Cash']);
        const cheque   = safeFloat(row['Cheque']);
        const bankTran = safeFloat(row['Bank Tran']);
        const pos      = safeFloat(row['POS']);

        if (docMap.has(docNum)) {
          // Accumulate payments onto existing record
          const existing = docMap.get(docNum);
          existing.cash      += cash;
          existing.cheque    += cheque;
          existing.bank_tran += bankTran;
          existing.pos       += pos;
        } else {
          docMap.set(docNum, {
            document_number: docNum,
            invoice_number:  String(row['Invoice Number'] || '').trim() || null,
            customer_code:   String(row['Customercode']   || '').trim() || null,
            customer_name:   String(row['Customer Name']  || '').trim() || null,
            route_code:      parseInt(row['Route Code'],10) || null,
            bank_name:       String(row['Bank Name English'] || '').trim() || null,
            tran_date:       serialToDate(row['Tran Date']),
            journey_id:      parseInt(row['Journey ID'],10) || null,
            visit_key:       parseInt(row['Visit Key'],10)  || null,
            transaction_key: parseInt(row['Transaction Key'],10) || null,
            cash, cheque, bank_tran: bankTran, pos,
          });
        }
      }

      const paymentRows = Array.from(docMap.values());
      console.log(`[Payments] ${rawRows.length} raw → ${paymentRows.length} aggregated, ${errors.length} skipped`);

      const dbClient = await pool.connect();
      let processed  = 0;
      try {
        await dbClient.query('BEGIN');
        processed = await batchUpsertPayments(dbClient, paymentRows);
        // Stamp uploaded_by on all rows just upserted (uploaded_at = NOW())
        await dbClient.query(
          `UPDATE payments SET uploaded_by = $1
           WHERE uploaded_at >= NOW() - INTERVAL '5 minutes'`,
          [req.user.id]
        );
        await dbClient.query('COMMIT');
      } catch (dbErr) {
        await dbClient.query('ROLLBACK');
        throw dbErr;
      } finally {
        dbClient.release();
      }

      console.log(`[Payments] Upserted ${processed} rows`);
      res.json({
        success:       true,
        rowsProcessed: processed,
        rowsSkipped:   errors.length,
        errors:        errors.slice(0, 50),
      });

    } catch (err) {
      console.error('[Payments] Upload error:', err.message);
      res.status(500).json({ error: 'فشل في معالجة الملف: ' + err.message });
    }
  }
);

// ─────────────────────────────────────────────
// GET /api/payments/customer/:customerId
// Returns:
//   summary  – totals by payment type for this customer
//   invoices – unpaid/partial invoices with their payment rows
//   all_payments – full payment list (all invoices)
// ─────────────────────────────────────────────
router.get('/customer/:customerId', verifyToken, async (req, res) => {
  const { customerId } = req.params;
  const { status } = req.query;    // optional: 'due' | 'paid' | 'all' (default: due)
  const showAll = status === 'all';

  try {
    // ── 1. Customer summary from invoices table ──
    const summaryQ = await pool.query(
      `SELECT
         SUM(p.cash)      AS total_cash,
         SUM(p.cheque)    AS total_cheque,
         SUM(p.bank_tran) AS total_bank_tran,
         SUM(p.pos)       AS total_pos,
         SUM(p.total_paid)AS total_paid,
         COUNT(*)         AS transaction_count,
         MIN(p.tran_date) AS first_date,
         MAX(p.tran_date) AS last_date
       FROM payments p
       WHERE p.customer_code = $1`,
      [customerId]
    );
    const summary = summaryQ.rows[0];

    // ── 2. Invoices with payment rows ──────────────
    // Get invoices (filtered by status unless showAll)
    const statusClause = showAll
      ? ''
      : `AND i.status IN ('unpaid','partial')`;

    const invQ = await pool.query(
      `SELECT
         i.id,
         i.invoice_number,
         i.invoice_date,
         i.year,
         i.original_amount,
         i.paid_amount,
         i.balance,
         i.status,
         i.collection_rate
       FROM invoices i
       WHERE i.customer_id = $1
         ${statusClause}
       ORDER BY i.invoice_date DESC`,
      [customerId]
    );

    const invoices = invQ.rows;

    if (!invoices.length) {
      return res.json({ summary, invoices: [], total_payment_count: 0 });
    }

    // ── 3. Payment rows for these invoices ─────────
    const invNumbers = [...new Set(invoices.map(r => r.invoice_number).filter(Boolean))];
    let paymentsByInvoice = {};

    if (invNumbers.length) {
      const ph  = invNumbers.map((_,i) => `$${i+1}`).join(',');
      const pQ  = await pool.query(
        `SELECT
           p.id,
           p.document_number,
           p.invoice_number,
           p.tran_date,
           p.bank_name,
           p.cash,
           p.cheque,
           p.bank_tran,
           p.pos,
           p.total_paid,
           p.journey_id
         FROM payments p
         WHERE p.invoice_number = ANY($1::text[])
           AND p.total_paid > 0
         ORDER BY p.tran_date ASC`,
        [invNumbers]
      );

      for (const p of pQ.rows) {
        const key = p.invoice_number;
        if (!paymentsByInvoice[key]) paymentsByInvoice[key] = [];
        paymentsByInvoice[key].push(p);
      }
    }

    // ── 4. Attach payments to invoices ─────────────
    const result = invoices.map(inv => ({
      ...inv,
      payments: paymentsByInvoice[inv.invoice_number] || [],
    }));

    // ── 5. Also return all customer payments (not just for filtered invoices)
    const allPQ = await pool.query(
      `SELECT
         p.document_number,
         p.invoice_number,
         p.tran_date,
         p.bank_name,
         p.route_code,
         p.cash,
         p.cheque,
         p.bank_tran,
         p.pos,
         p.total_paid
       FROM payments p
       WHERE p.customer_code = $1
         AND p.total_paid > 0
       ORDER BY p.tran_date DESC`,
      [customerId]
    );

    res.json({
      summary,
      invoices: result,
      all_payments: allPQ.rows,
    });

  } catch (err) {
    console.error('[Payments] customer error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// ─────────────────────────────────────────────
// GET /api/payments/stats
// Overall stats: total by type, date range, count
// ─────────────────────────────────────────────
router.get('/stats', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)              AS transaction_count,
        SUM(total_paid)       AS grand_total,
        SUM(cash)             AS total_cash,
        SUM(cheque)           AS total_cheque,
        SUM(bank_tran)        AS total_bank_tran,
        SUM(pos)              AS total_pos,
        COUNT(DISTINCT customer_code) AS customer_count,
        MIN(tran_date)        AS first_date,
        MAX(tran_date)        AS last_date
      FROM payments
      WHERE total_paid > 0
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error('[Payments] stats error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
