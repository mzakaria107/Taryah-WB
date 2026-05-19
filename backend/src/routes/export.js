const express = require('express');
const xlsx    = require('xlsx');
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

const router = express.Router();

/* ── Shared condition builder (mirrors invoices.js) ─ */
function buildConditions(q, req) {
  const { year, month, years, months, status, customer_type,
          region_id, route_id, search, customer_id, sales_rep_name } = q;
  const conditions = [], params = [];
  let p = 1;

  if (req.regionFilter) {
    conditions.push(`region_id = $${p++}`); params.push(req.regionFilter);
  } else if (region_id) {
    conditions.push(`region_id = $${p++}`); params.push(parseInt(region_id, 10));
  }
  if (years) {
    const arr = years.split(',').map(n => parseInt(n, 10)).filter(Boolean);
    if (arr.length === 1) { conditions.push(`year = $${p++}`); params.push(arr[0]); }
    else if (arr.length > 1) { conditions.push(`year = ANY($${p++}::int[])`); params.push(arr); }
  } else if (year) {
    conditions.push(`year = $${p++}`); params.push(parseInt(year, 10));
  }
  if (months) {
    const arr = months.split(',').map(n => parseInt(n, 10)).filter(Boolean);
    if (arr.length === 1) { conditions.push(`EXTRACT(MONTH FROM invoice_date) = $${p++}`); params.push(arr[0]); }
    else if (arr.length > 1) { conditions.push(`EXTRACT(MONTH FROM invoice_date) = ANY($${p++}::int[])`); params.push(arr); }
  } else if (month) {
    conditions.push(`EXTRACT(MONTH FROM invoice_date) = $${p++}`); params.push(parseInt(month, 10));
  }
  if (status === 'due') { conditions.push(`status IN ('partial','unpaid')`); }
  else if (status) { conditions.push(`status = $${p++}`); params.push(status); }
  if (customer_type) { conditions.push(`customer_type = $${p++}`); params.push(customer_type); }
  if (route_id) { conditions.push(`route_id = $${p++}`); params.push(parseInt(route_id, 10)); }
  if (sales_rep_name) { conditions.push(`sales_rep_name = $${p++}`); params.push(sales_rep_name); }
  if (customer_id) { conditions.push(`customer_id = $${p++}`); params.push(String(customer_id)); }
  if (search) {
    conditions.push(`(customer_name ILIKE $${p} OR customer_name_en ILIKE $${p})`);
    params.push(`%${search}%`); p++;
  }
  return { conditions, params, p };
}

// ─────────────────────────────────────────────────────────
// GET /api/export/excel
// Full Excel workbook: Sheet1=Customers, Sheet2=Invoices
// Respects all active filters + includes notes
// ─────────────────────────────────────────────────────────
/* Allow token via query string for direct file downloads */
function tokenFromQuery(req, res, next) {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}

router.get('/excel', tokenFromQuery, verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const { conditions, params } = buildConditions(req.query, req);
    let p = params.length + 1;
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    // Qualify customer_id with i. to avoid ambiguity when joining notes table
    const joinedWhere = where.replace(/\bcustomer_id\b/g, 'i.customer_id');

    // ── Sheet 1: Customer summary + latest customer note (from protected table) ──
    const custRows = await pool.query(
      `SELECT
         i.customer_id                                       AS "كود العميل",
         MAX(i.customer_name)                               AS "اسم العميل (عربي)",
         MAX(i.customer_name_en)                            AS "اسم العميل (إنجليزي)",
         MAX(r.name_ar)                                     AS "المنطقة",
         MAX(i.route_id)                                    AS "خط السير",
         MAX(i.sales_rep_name)                              AS "المندوب",
         COUNT(*)                                           AS "عدد الفواتير",
         COALESCE(SUM(i.original_amount),0)::FLOAT          AS "إجمالي المعاملات",
         COALESCE(SUM(i.paid_amount),0)::FLOAT              AS "إجمالي المدفوع",
         COALESCE(SUM(i.balance),0)::FLOAT                  AS "إجمالي الرصيد",
         CASE WHEN SUM(i.original_amount)>0
              THEN ROUND(SUM(i.paid_amount)/SUM(i.original_amount)*100,2)::FLOAT
              ELSE 0 END                                    AS "نسبة التحصيل %",
         COUNT(*) FILTER (WHERE i.status='paid')            AS "فواتير مسددة",
         COUNT(*) FILTER (WHERE i.status='partial')         AS "فواتير جزئية",
         COUNT(*) FILTER (WHERE i.status='unpaid')          AS "فواتير غير مسددة",
         COALESCE(MAX(cn.note_text),'')                     AS "ملاحظات العميل"
       FROM invoices i
       LEFT JOIN regions        r  ON r.id = i.region_id
       LEFT JOIN customer_notes cn ON cn.customer_id = i.customer_id
       ${joinedWhere}
       GROUP BY i.customer_id
       ORDER BY SUM(i.balance) DESC`,
      params
    );

    // ── Sheet 2: Invoice details — limited to 10,000 rows to keep file size manageable ──
    // Full invoice data is available via CSV export
    const INV_LIMIT = 10000;
    const invRows = await pool.query(
      `SELECT
         i.customer_id                   AS "كود العميل",
         i.customer_name                 AS "اسم العميل (عربي)",
         i.customer_name_en              AS "اسم العميل (إنجليزي)",
         r.name_ar                       AS "المنطقة",
         i.route_id                      AS "خط السير",
         i.sales_rep_name                AS "المندوب",
         i.invoice_number                AS "رقم الفاتورة",
         TO_CHAR(i.invoice_date,'YYYY-MM-DD') AS "تاريخ المعاملة",
         i.year                          AS "السنة",
         i.original_amount::FLOAT        AS "إجمالي الفاتورة",
         i.paid_amount::FLOAT            AS "المدفوع",
         i.balance::FLOAT                AS "الرصيد",
         i.collection_rate::FLOAT        AS "نسبة التحصيل %",
         CASE i.status::text
           WHEN 'paid'    THEN 'مسدد'
           WHEN 'partial' THEN 'جزئي'
           WHEN 'unpaid'  THEN 'غير مسدد'
           ELSE i.status::text END       AS "الحالة",
         COALESCE(n.note_text,'')        AS "ملاحظات الفاتورة"
       FROM invoices i
       LEFT JOIN regions r ON r.id = i.region_id
       LEFT JOIN (SELECT invoice_id, note_text FROM notes WHERE note_type = 'invoice' OR note_type IS NULL) n
         ON n.invoice_id = i.id
       ${joinedWhere}
       ORDER BY i.customer_id, i.invoice_date DESC
       LIMIT ${INV_LIMIT}`,
      params
    );

    // ── Build workbook ────────────────────────────────────
    const wb = xlsx.utils.book_new();

    const wsCust = xlsx.utils.json_to_sheet(custRows.rows);
    styleSheet(wsCust, custRows.rows.length);
    xlsx.utils.book_append_sheet(wb, wsCust, 'إجمالي العملاء');

    const wsInv = xlsx.utils.json_to_sheet(invRows.rows);
    styleSheet(wsInv, invRows.rows.length);
    xlsx.utils.book_append_sheet(wb, wsInv, `تفاصيل الفواتير (أول ${INV_LIMIT.toLocaleString('en-SA')})`);

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const dateStr  = new Date().toISOString().slice(0, 10);
    const arName   = encodeURIComponent(`تقرير_الارصدة_${dateStr}.xlsx`);
    res.setHeader('Content-Disposition',
      `attachment; filename="balance_report_${dateStr}.xlsx"; filename*=UTF-8''${arName}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);

  } catch (err) {
    console.error('Export Excel error:', err);
    res.status(500).json({ error: 'فشل التصدير: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/export/csv
// CSV of customer summary (simple, fast)
// ─────────────────────────────────────────────────────────
router.get('/csv', tokenFromQuery, verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const { conditions, params } = buildConditions(req.query, req);
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const joinedWhere = where.replace(/\bcustomer_id\b/g, 'i.customer_id');

    const { rows } = await pool.query(
      `SELECT
         i.customer_id,
         MAX(i.customer_name)                               AS customer_name,
         MAX(i.customer_name_en)                            AS customer_name_en,
         MAX(r.name_ar)                                     AS region,
         MAX(i.route_id)                                    AS route_id,
         MAX(i.sales_rep_name)                              AS sales_rep,
         COUNT(*)                                           AS invoice_count,
         COALESCE(SUM(i.original_amount),0)::FLOAT          AS total_amount,
         COALESCE(SUM(i.paid_amount),0)::FLOAT              AS total_paid,
         COALESCE(SUM(i.balance),0)::FLOAT                  AS total_balance,
         CASE WHEN SUM(i.original_amount)>0
              THEN ROUND(SUM(i.paid_amount)/SUM(i.original_amount)*100,2)::FLOAT
              ELSE 0 END                                    AS collection_rate,
         COALESCE(MAX(cn.note_text),'')                     AS customer_note
       FROM invoices i
       LEFT JOIN regions        r  ON r.id = i.region_id
       LEFT JOIN customer_notes cn ON cn.customer_id = i.customer_id
       ${joinedWhere}
       GROUP BY i.customer_id
       ORDER BY SUM(i.balance) DESC`,
      params
    );

    const headers = [
      'كود العميل','اسم العميل','اسم العميل EN','المنطقة','خط السير','المندوب',
      'عدد الفواتير','إجمالي المعاملات','إجمالي المدفوع','إجمالي الرصيد',
      'نسبة التحصيل','ملاحظات العميل',
    ];
    const csvLines = [
      '﻿' + headers.join(','),   // BOM for Excel Arabic
      ...rows.map(r => [
        r.customer_id, `"${(r.customer_name||'').replace(/"/g,'""')}"`,
        `"${(r.customer_name_en||'').replace(/"/g,'""')}"`,
        `"${(r.region||'').replace(/"/g,'""')}"`,
        r.route_id || '', `"${(r.sales_rep||'').replace(/"/g,'""')}"`,
        r.invoice_count, r.total_amount, r.total_paid, r.total_balance,
        r.collection_rate, `"${(r.customer_note||'').replace(/"/g,'""')}"`,
      ].join(',')),
    ];

    const dateStr = new Date().toISOString().slice(0, 10);
    const arCsv   = encodeURIComponent(`تقرير_${dateStr}.csv`);
    res.setHeader('Content-Disposition',
      `attachment; filename="report_${dateStr}.csv"; filename*=UTF-8''${arCsv}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(csvLines.join('\n'));

  } catch (err) {
    console.error('Export CSV error:', err);
    res.status(500).json({ error: 'فشل التصدير: ' + err.message });
  }
});

/* ── Auto-width helper ───────────────────────────── */
function styleSheet(ws, rowCount) {
  if (!ws['!ref']) return;
  const range = xlsx.utils.decode_range(ws['!ref']);
  const colWidths = [];
  for (let C = range.s.c; C <= range.e.c; C++) {
    let max = 10;
    for (let R = range.s.r; R <= range.e.r; R++) {
      const cell = ws[xlsx.utils.encode_cell({ r: R, c: C })];
      if (cell && cell.v != null) {
        const len = String(cell.v).length;
        if (len > max) max = len;
      }
    }
    colWidths.push({ wch: Math.min(max + 2, 50) });
  }
  ws['!cols'] = colWidths;
}

module.exports = router;
