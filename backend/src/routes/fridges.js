/**
 * routes/fridges.js
 * Refrigerator (asset) tracking
 *
 * GET  /api/fridges                        — list (filters: status, region_id, search)
 * GET  /api/fridges/stats                  — counts by status + region
 * GET  /api/fridges/customer-lookup        — ?code=XX → customer info, merged per field
 *                                             from customers (CM list) → invoices → sales_activity
 * POST /api/fridges/import                 — bulk Excel import
 * POST /api/fridges                        — create
 * GET  /api/fridges/:id                    — detail + transfer history
 * PUT  /api/fridges/:id                    — update
 * DELETE /api/fridges/:id                  — delete
 * POST /api/fridges/:id/transfer           — repair | reassign
 * PUT  /api/fridges/:id/pending-contract   — raise/clear "بانتظار توقيع العقد"
 */

const express = require('express');
const multer  = require('multer');
const xlsx    = require('xlsx');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();
const pool    = require('../db/pool');
const { verifyToken, requireRoles, applyRegionFilter } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// A region-restricted user (req.regionFilter is a non-empty array) may still
// narrow down to ONE of their own assigned regions via ?region_id= — honour
// it only if it's actually one of theirs, else fall back to their full set.
// An unrestricted user (req.regionFilter is null) can pick any region_id.
function resolveEffectiveRegionIds(req) {
  const requested = req.query.region_id ? Number(req.query.region_id) : null;
  if (req.regionFilter && req.regionFilter.length) {
    return (requested && req.regionFilter.includes(requested)) ? [requested] : req.regionFilter;
  }
  return requested ? [requested] : null;
}

// Contract files are named by convention "<contract number> - <customer
// name>.<ext>" (e.g. "1567 - شركة زاد العين الشمالى.jpeg") or just
// "<contract number>.<ext>" — pull the leading number so it can auto-fill
// the fridge's رقم العقد field instead of requiring manual re-entry.
function extractContractNumber(filename) {
  const m = String(filename || '').trim().match(/^(\d+)/);
  return m ? m[1] : null;
}

/* ── Contract file storage ─────────────────────────────────── */
const CONTRACT_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads', 'fridge-contracts');
if (!fs.existsSync(CONTRACT_DIR)) fs.mkdirSync(CONTRACT_DIR, { recursive: true });

function fixName(raw) {
  try { return Buffer.from(raw, 'latin1').toString('utf8'); } catch { return raw; }
}

const contractStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = path.join(CONTRACT_DIR, String(req.params.id || 'unknown'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ts   = Date.now();
    const name = fixName(file.originalname);
    const safe = name.replace(/[^a-zA-Z0-9.؀-ۿ_-]/g, '_');
    cb(null, `${ts}-${safe}`);
  },
});
const contractUpload = multer({
  storage: contractStorage,
  limits:  { fileSize: 50 * 1024 * 1024, files: 10 },
});

/* ── Roles allowed to write/modify fridges ─────────────────── */
const FRIDGE_EDITORS = ['super_admin', 'it_admin', 'fridge_admin'];
const canEdit = requireRoles(...FRIDGE_EDITORS);

/* Notes are field intelligence, not an asset change: supervisors and region
   managers are the people actually standing in front of the fridge, so they
   may write them even though they cannot move or delete the asset. Every save
   is attributed and kept in the append-only trail, so widening this does not
   cost traceability. */
const NOTE_ROLES = [...FRIDGE_EDITORS, 'supervisor', 'region_manager'];
const canWriteNote = requireRoles(...NOTE_ROLES);

router.use(verifyToken, applyRegionFilter);

/* ── Status labels ─────────────────────────────────────────── */
const STATUS_AR = {
  active:                'فعالة',
  inactive:              'غير فعالة',
  out_of_service:        'خارج الخدمة',
  damaged:               'تالفة',
  warehouse_maintenance: 'بالمستودع للصيانة',
  warehouse_new:         'بالمستودع جديدة',
  warehouse_used:        'بالمستودع مستعملة',
};

/* ── Customer lookup from invoices ─────────────────────────── */
router.get('/customer-lookup', async (req, res) => {
  const { code } = req.query;
  if (!code?.trim()) return res.json({ found: false });
  const c = code.trim();

  try {
    /* Three sources, best first:
         1. `customers` — the master loaded from "Customer List - CM". It is
            maintained deliberately and covers customers with no invoice yet.
         2. invoices    — what was true at the time of the last sale.
         3. sales_activity — last resort, has no route.
       Merged PER FIELD, not per source: the master may legitimately have a
       blank route or salesman, and falling back only when the whole master
       row is missing would throw away data that exists in invoices. */
    const [cmRes, invRes, saRes] = await Promise.all([
      pool.query(
        `SELECT c.customer_code, c.customer_name, c.customer_name_ar, c.route_code,
                c.region_id, c.salesman_name, c.branch_name_en, c.category_name,
                c.supervisor_name, r.name_ar AS region_name
           FROM customers c
           LEFT JOIN regions r ON r.id = c.region_id
          WHERE c.customer_code = $1`, [c]),
      pool.query(
        `SELECT DISTINCT
           i.customer_id AS customer_code, i.customer_name,
           i.route_id AS route_code, i.region_id,
           r.name_ar AS region_name, sa.salesrep_name
         FROM invoices i
         LEFT JOIN regions r ON r.id = i.region_id
         LEFT JOIN LATERAL (
           SELECT salesrep_name FROM sales_activity
           WHERE customer_code = i.customer_id
           ORDER BY report_year DESC, month_num DESC LIMIT 1
         ) sa ON true
         WHERE i.customer_id = $1
         LIMIT 1`, [c]),
      pool.query(
        `SELECT DISTINCT sa.customer_code, sa.customer_name, sa.salesrep_name,
                sa.branch_name, r.id AS region_id, r.name_ar AS region_name
           FROM sales_activity sa
           LEFT JOIN regions r ON r.name_ar = sa.branch_name OR r.name_en = sa.branch_name
          WHERE sa.customer_code = $1
          ORDER BY sa.customer_code LIMIT 1`, [c]),
    ]);

    const cm  = cmRes.rows[0]  || null;
    const inv = invRes.rows[0] || null;
    const sa  = saRes.rows[0]  || null;
    if (!cm && !inv && !sa) return res.json({ found: false });

    /* Which source actually supplied each value — the operator can then tell
       "came from the uploaded list" from "came from an old invoice". */
    const sources = {};
    const take = (field, candidates) => {
      for (const [src, val] of candidates) {
        const ok = val !== null && val !== undefined && String(val).trim() !== '';
        if (ok) { sources[field] = src; return val; }
      }
      return null;
    };

    const out = {
      found: true,
      customer_code: c,
      /* Arabic first — it is what the dashboard displays everywhere. The
         English master name is the fallback, then the invoice name (which is
         itself the Arabic `namelocal` column). Both are also returned
         separately so a caller can show the pair. */
      customer_name: take('customer_name', [
        ['customer_list_ar', cm?.customer_name_ar], ['customer_list', cm?.customer_name],
        ['invoices', inv?.customer_name], ['sales_activity', sa?.customer_name]]),
      customer_name_ar: cm?.customer_name_ar ?? inv?.customer_name ?? null,
      customer_name_en: cm?.customer_name ?? null,
      route_code: take('route_code', [
        ['customer_list', cm?.route_code], ['invoices', inv?.route_code]]),
      region_id: take('region_id', [
        ['customer_list', cm?.region_id], ['invoices', inv?.region_id], ['sales_activity', sa?.region_id]]),
      region_name: take('region_name', [
        ['customer_list', cm?.region_name], ['invoices', inv?.region_name], ['sales_activity', sa?.region_name]]),
      salesrep_name: take('salesrep_name', [
        ['customer_list', cm?.salesman_name], ['invoices', inv?.salesrep_name], ['sales_activity', sa?.salesrep_name]]),
      /* master-only extras — shown as context, not written to the fridge */
      category_name:   cm?.category_name   ?? null,
      supervisor_name: cm?.supervisor_name ?? null,
      sources,
      in_customer_list: !!cm,
      available_in: [cm && 'customer_list', inv && 'invoices', sa && 'sales_activity'].filter(Boolean),
    };
    return res.json(out);
  } catch (e) {
    console.error('[Fridges] customer-lookup:', e);
    return res.status(500).json({ error: e.message });
  }
});

/* ── Bulk refresh route + salesrep from each fridge's CURRENT customer ──
   The route (خط السير) and salesman a fridge shows must follow the customer it
   is currently registered to. Transfers keep them in step automatically (see
   /transfer and the request-approval handler), but a re-uploaded "Customer
   List - CM" can move a route to a different salesman without any fridge being
   transferred — this button reconciles every fridge in one pass.

   Precedence matches /customer-lookup: customers master → invoices → sales_activity.
   Only fridges whose customer is actually known somewhere are touched; a fridge
   whose customer_code matches nothing is left exactly as it was. */
router.post('/refresh-customer-data', canEdit, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH cust AS (
         SELECT f.id,
                COALESCE(c.route_code, inv.route_id)                          AS route_code,
                COALESCE(NULLIF(TRIM(c.salesman_name), ''), sa.salesrep_name) AS salesrep_name,
                (c.customer_code IS NOT NULL
                 OR inv.route_id IS NOT NULL
                 OR sa.salesrep_name IS NOT NULL)                            AS known
         FROM fridges f
         LEFT JOIN customers c ON c.customer_code = f.customer_code
         LEFT JOIN LATERAL (
           SELECT i.route_id FROM invoices i
            WHERE i.customer_id = f.customer_code AND i.route_id IS NOT NULL
            LIMIT 1
         ) inv ON true
         LEFT JOIN LATERAL (
           SELECT salesrep_name FROM sales_activity
            WHERE customer_code = f.customer_code
            ORDER BY report_year DESC, month_num DESC LIMIT 1
         ) sa ON true
         WHERE f.customer_code IS NOT NULL
       )
       UPDATE fridges f SET
         route_code    = cust.route_code,
         salesrep_name = COALESCE(cust.salesrep_name, f.salesrep_name),
         updated_by    = $1,
         updated_at    = NOW()
       FROM cust
       WHERE cust.id = f.id
         AND cust.known
         AND (f.route_code    IS DISTINCT FROM cust.route_code
           OR f.salesrep_name IS DISTINCT FROM COALESCE(cust.salesrep_name, f.salesrep_name))
       RETURNING f.id`,
      [req.user.id]
    );
    const totalRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM fridges WHERE customer_code IS NOT NULL`
    );
    res.json({ updated: rows.length, total_with_customer: totalRes.rows[0].c });
  } catch (e) {
    console.error('[Fridges] refresh-customer-data:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ── Stats ─────────────────────────────────────────────────── */
router.get('/stats', async (req, res) => {
  const effectiveIds = resolveEffectiveRegionIds(req);
  const regionArr   = effectiveIds ? `ARRAY[${effectiveIds.map(Number).join(',')}]::int[]` : null;
  const regionWhere = regionArr ? `WHERE f.region_id = ANY(${regionArr})` : '';
  const regionAnd   = regionArr ? `AND f.region_id = ANY(${regionArr})` : '';
  try {
    const [statusRes, regionRes, multiRes, regionStatusRes, pendingRes] = await Promise.all([
      pool.query(
        `SELECT status, COUNT(*) AS cnt FROM fridges f ${regionWhere} GROUP BY status ORDER BY cnt DESC`
      ),
      pool.query(
        `SELECT r.name_ar AS region, COUNT(*) AS cnt
         FROM fridges f
         LEFT JOIN regions r ON r.id = f.region_id
         ${regionWhere}
         GROUP BY r.name_ar ORDER BY cnt DESC`
      ),
      pool.query(
        `SELECT customer_code, customer_name, COUNT(*) AS fridge_count
         FROM fridges f WHERE customer_code IS NOT NULL ${regionAnd}
         GROUP BY customer_code, customer_name
         HAVING COUNT(*) > 1
         ORDER BY fridge_count DESC`
      ),
      /* Per-region × per-status breakdown */
      pool.query(
        `SELECT
           COALESCE(r.name_ar, 'غير محدد') AS region_name,
           r.id                             AS region_id,
           f.status,
           COUNT(*)::int                   AS cnt
         FROM fridges f
         LEFT JOIN regions r ON r.id = f.region_id
         ${regionWhere}
         GROUP BY r.id, r.name_ar, f.status
         ORDER BY r.name_ar NULLS LAST, f.status`
      ),
      /* Fridges handed to a new customer without a signed contract yet.
         Oldest first — those are the ones that need chasing. */
      pool.query(
        `SELECT f.id, f.asset_number, f.customer_code, f.customer_name,
                f.pending_contract_since,
                COALESCE(r.name_ar, 'غير محدد') AS region_name,
                GREATEST(0, EXTRACT(DAY FROM NOW() - f.pending_contract_since)::int) AS days_waiting
         FROM fridges f
         LEFT JOIN regions r ON r.id = f.region_id
         WHERE f.pending_contract ${regionAnd}
         ORDER BY f.pending_contract_since ASC NULLS LAST`
      ),
    ]);

    /* Group region-status rows into a map: region_name → { status: cnt } */
    const regionMap = {};
    for (const row of regionStatusRes.rows) {
      const key = row.region_name;
      if (!regionMap[key]) {
        regionMap[key] = { region_name: key, region_id: row.region_id, by_status: {} };
      }
      regionMap[key].by_status[row.status] = row.cnt;
    }
    const by_region_status = Object.values(regionMap)
      .map(r => ({
        ...r,
        total:       Object.values(r.by_status).reduce((s, v) => s + v, 0),
      }))
      .sort((a, b) => b.total - a.total);

    res.json({
      by_status:              statusRes.rows,
      by_region:              regionRes.rows,
      by_region_status,
      multi_fridge_customers: multiRes.rows,
      pending_contracts:      pendingRes.rows,
      total: statusRes.rows.reduce((s, r) => s + parseInt(r.cnt), 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Bulk Excel Import ─────────────────────────────────────── */
router.post('/import', canEdit, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم إرفاق ملف' });

  // ── Parse Excel ──────────────────────────────────────────────
  let rows;
  try {
    const wb   = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'تعذّر قراءة الملف — تأكد من أنه Excel صالح' });
  }

  if (!rows.length) return res.status(400).json({ error: 'الملف فارغ أو لا يحتوي على بيانات' });

  // ── Column name normalizer ────────────────────────────────────
  const ALIASES = {
    asset_number:    ['رقم الثلاجة','رقم الأصل','رقم الاصل','asset_number','Asset Number','AssetNumber','رقم ثلاجة'],
    customer_code:   ['رقم العميل','كود العميل','customer_code','Customer Code','CustomerCode','رقم_العميل'],
    customer_name:   ['اسم العميل','customer_name','Customer Name','CustomerName'],
    region_name:     ['المنطقة','اسم المنطقة','region','region_name','Branch','branch_name'],
    route_code:      ['رقم الخط','الخط','route_code','Route','RouteCode','route'],
    salesrep_name:   ['اسم المندوب','المندوب','salesrep_name','Salesrep','Sales Rep','مندوب المبيعات'],
    contract_number: ['رقم العقد','contract_number','Contract Number','ContractNumber'],
    contract_date:   ['تاريخ العقد','contract_date','Contract Date','ContractDate'],
    status:          ['الحالة','status','Status'],
    notes:           ['ملاحظات','notes','Notes','ملاحظة'],
  };

  // Build a map: header_in_file → canonical_field
  const headers = Object.keys(rows[0]);
  const colMap  = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      const found = headers.find(h => h.trim() === alias || h.trim().toLowerCase() === alias.toLowerCase());
      if (found) { colMap[found] = field; break; }
    }
  }

  // ── Valid status values ───────────────────────────────────────
  const VALID_STATUSES = new Set([
    'active','inactive','out_of_service','damaged',
    'warehouse_maintenance','warehouse_new','warehouse_used',
  ]);
  const STATUS_AR_TO_EN = {
    'فعالة': 'active',
    'غير فعالة': 'inactive',
    'خارج الخدمة': 'out_of_service',
    'تالفة': 'damaged',
    'بالمستودع للصيانة': 'warehouse_maintenance',
    'بالمستودع جديدة': 'warehouse_new',
    'بالمستودع مستعملة': 'warehouse_used',
  };

  // ── Customer info cache (avoid repeated DB lookups) ───────────
  const customerCache = {};
  async function lookupCustomer(code) {
    if (!code) return null;
    if (customerCache[code] !== undefined) return customerCache[code];
    try {
      const invRes = await pool.query(
        `SELECT DISTINCT
           i.customer_id AS customer_code,
           i.customer_name,
           i.route_id    AS route_code,
           i.region_id,
           r.name_ar     AS region_name,
           sa.salesrep_name
         FROM invoices i
         LEFT JOIN regions r ON r.id = i.region_id
         LEFT JOIN LATERAL (
           SELECT salesrep_name FROM sales_activity
           WHERE customer_code = i.customer_id
           ORDER BY report_year DESC, month_num DESC LIMIT 1
         ) sa ON true
         WHERE i.customer_id = $1
         LIMIT 1`,
        [code]
      );
      if (invRes.rowCount) { customerCache[code] = invRes.rows[0]; return invRes.rows[0]; }
      const saRes = await pool.query(
        `SELECT DISTINCT sa.customer_code, sa.customer_name, sa.salesrep_name,
           r.id AS region_id, r.name_ar AS region_name
         FROM sales_activity sa
         LEFT JOIN regions r ON r.name_ar = sa.branch_name OR r.name_en = sa.branch_name
         WHERE sa.customer_code = $1
         ORDER BY sa.customer_code LIMIT 1`,
        [code]
      );
      customerCache[code] = saRes.rowCount ? saRes.rows[0] : null;
    } catch { customerCache[code] = null; }
    return customerCache[code];
  }

  // ── Region name → id cache ────────────────────────────────────
  let regionMap = {};
  try {
    const rRes = await pool.query(`SELECT id, name_ar, name_en FROM regions`);
    rRes.rows.forEach(r => {
      if (r.name_ar) regionMap[r.name_ar.trim()] = r.id;
      if (r.name_en) regionMap[r.name_en.trim()] = r.id;
    });
  } catch (_) {}

  // ── Process rows ──────────────────────────────────────────────
  const inserted = [];
  const skipped  = [];
  const errors   = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const rowNum = i + 2; // +2 because Excel row 1 = header, data starts row 2

    // Map to canonical fields
    const mapped = {};
    for (const [rawCol, val] of Object.entries(raw)) {
      const field = colMap[rawCol];
      if (field) mapped[field] = val != null ? String(val).trim() : '';
    }

    // Asset number is required
    const assetNum = mapped.asset_number?.trim();
    if (!assetNum) {
      errors.push({ row: rowNum, error: 'رقم الثلاجة مفقود', data: mapped });
      continue;
    }

    // Resolve customer info
    const custCode = mapped.customer_code?.trim() || null;
    let custName   = mapped.customer_name?.trim() || null;
    let regionId   = null;
    let routeCode  = mapped.route_code ? parseInt(mapped.route_code) || null : null;
    let salesrep   = mapped.salesrep_name?.trim() || null;

    // Try to resolve region from name column
    if (mapped.region_name) {
      regionId = regionMap[mapped.region_name.trim()] || null;
    }

    // Auto-fill from customer lookup if customer_code is given
    if (custCode) {
      const info = await lookupCustomer(custCode);
      if (info) {
        if (!custName)  custName  = info.customer_name  || null;
        if (!regionId)  regionId  = info.region_id      || null;
        if (!routeCode) routeCode = info.route_code     ? parseInt(info.route_code) : null;
        if (!salesrep)  salesrep  = info.salesrep_name  || null;
      }
    }

    // Resolve status
    let status = 'active';
    if (mapped.status) {
      const s = mapped.status.trim();
      if (VALID_STATUSES.has(s))              status = s;
      else if (STATUS_AR_TO_EN[s])            status = STATUS_AR_TO_EN[s];
    }

    // Contract date — xlsx may return a Date object or string
    let contractDate = null;
    if (mapped.contract_date) {
      const rawDate = mapped.contract_date;
      if (rawDate instanceof Date)            contractDate = rawDate.toISOString().split('T')[0];
      else if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) contractDate = rawDate.slice(0, 10);
      else if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(rawDate)) {
        const [d, m, y] = rawDate.split('/');
        contractDate = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      } else if (/^\d{1,2}-\d{1,2}-\d{4}/.test(rawDate)) {
        const [d, m, y] = rawDate.split('-');
        contractDate = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      }
    }

    // Insert with conflict skip
    try {
      const result = await pool.query(
        `INSERT INTO fridges
           (asset_number, customer_code, customer_name, region_id, route_code,
            salesrep_name, contract_number, contract_date, status, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         ON CONFLICT (asset_number) DO NOTHING
         RETURNING id`,
        [
          assetNum,
          custCode,
          custName,
          regionId,
          routeCode,
          salesrep,
          mapped.contract_number?.trim() || null,
          contractDate,
          status,
          mapped.notes?.trim() || null,
          req.user.id,
        ]
      );

      if (result.rowCount > 0) {
        inserted.push(assetNum);
      } else {
        skipped.push({ asset_number: assetNum, reason: 'رقم الثلاجة موجود بالفعل' });
      }
    } catch (e) {
      errors.push({ row: rowNum, error: e.message, data: { asset_number: assetNum } });
    }
  }

  res.json({
    total:    rows.length,
    inserted: inserted.length,
    skipped:  skipped.length,
    errors:   errors.length,
    inserted_list: inserted,
    skipped_list:  skipped,
    error_list:    errors,
  });
});

/* ── List ──────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  const { status, search, customer_code, pending_contract } = req.query;
  // Region-restricted users always see only their assigned regions,
  // narrowed further to one of them if ?region_id= picks a valid one
  const effectiveRegionIds = resolveEffectiveRegionIds(req);

  const conds = [];
  const vals  = [];
  let p = 1;

  if (status) {
    conds.push(`f.status = $${p++}`);
    vals.push(status);
  }
  if (effectiveRegionIds) {
    conds.push(`f.region_id = ANY($${p++}::int[])`);
    vals.push(effectiveRegionIds);
  }
  if (customer_code) {
    conds.push(`f.customer_code = $${p++}`);
    vals.push(customer_code);
  }
  // ?pending_contract=1 → only fridges still waiting for a signed contract,
  // so the alert banner can link straight to the list it is counting
  if (pending_contract === '1' || pending_contract === 'true') {
    conds.push(`f.pending_contract`);
  }
  if (search) {
    conds.push(`(
      f.asset_number   ILIKE $${p}   OR
      f.customer_code  ILIKE $${p}   OR
      f.customer_name  ILIKE $${p}   OR
      f.contract_number ILIKE $${p}
    )`);
    vals.push(`%${search}%`);
    p++;
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT
         f.*,
         r.name_ar AS region_name,
         (SELECT COUNT(*) FROM fridges f2
          WHERE f2.customer_code = f.customer_code AND f.customer_code IS NOT NULL
         )::int AS customer_fridge_count,
         (SELECT COUNT(*) FROM fridge_contracts fc WHERE fc.fridge_id = f.id)::int AS contract_count,
         /* latest note + how many have been written, for the notes column */
         fn.note_text       AS note_text,
         fn.updated_at      AS note_updated_at,
         fn.updated_by_name AS note_updated_by_name,
         (SELECT COUNT(*) FROM fridge_notes_history fh WHERE fh.fridge_id = f.id)::int AS note_count
       FROM fridges f
       LEFT JOIN regions r ON r.id = f.region_id
       LEFT JOIN fridge_notes fn ON fn.fridge_id = f.id
       ${where}
       ORDER BY f.updated_at DESC
       LIMIT 500`,
      vals
    );
    res.json({ fridges: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Create ────────────────────────────────────────────────── */
router.post('/', canEdit, async (req, res) => {
  const {
    asset_number, customer_code, customer_name,
    region_id, route_code, salesrep_name,
    contract_number, contract_date, status, notes,
  } = req.body;

  if (!asset_number?.trim()) return res.status(400).json({ error: 'رقم الثلاجة مطلوب' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO fridges
         (asset_number, customer_code, customer_name, region_id, route_code,
          salesrep_name, contract_number, contract_date, status, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       RETURNING *`,
      [
        asset_number.trim(),
        customer_code?.trim() || null,
        customer_name?.trim() || null,
        region_id ? Number(region_id) : null,
        route_code ? Number(route_code) : null,
        salesrep_name?.trim() || null,
        contract_number?.trim() || null,
        contract_date || null,
        status || 'active',
        notes?.trim() || null,
        req.user.id,
      ]
    );
    res.status(201).json({ fridge: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'رقم الثلاجة موجود بالفعل' });
    res.status(500).json({ error: e.message });
  }
});

/* ── Sales Report ──────────────────────────────────────────── */
/*
 * GET /api/fridges/sales-report
 *
 * Data source: sales_activity (all uploaded customers — active + inactive)
 * LEFT JOIN fridges  → fridge_count (0 if no fridge for that customer)
 * LEFT JOIN regions  → region_name  (matched via sa.branch_name)
 *
 * Query params:
 *   year       — filter by report_year  (optional)
 *   month      — filter by month_num    (optional)
 *   day        — filter by day          (optional)
 *   region_id  — filter by region       (optional, matched via branch_name)
 *   trading    — 'active' | 'inactive'  (optional, based on total qty)
 *   search     — text search            (optional)
 */
router.get('/sales-report', async (req, res) => {
  const { year, month, day, trading, search } = req.query;
  // Region-restricted users always see only their assigned regions,
  // narrowed further to one of them if ?region_id= picks a valid one
  const region_ids = resolveEffectiveRegionIds(req);

  /*
   * Strategy:
   *   Base table = fridges  (all fridge-customers always appear)
   *
   *   Quantities JOIN  — period filters (year+month) go here.
   *     Requires BOTH year AND month to avoid cross-month totals.
   *     If no month selected → JOIN condition is FALSE → qty = 0.
   *
   *   Last-activity subquery — independent of period filter,
   *     always shows customer's most recent sale ever.
   *
   *   WHERE — fridge-level filters only (region, search).
   */

  let p = 1;
  const allVals = [];

  /*
   * Fix: pre-aggregate sales_activity PER CUSTOMER before joining fridges.
   * Without this, a customer with N fridges gets N×SUM instead of 1×SUM
   * because the JOIN creates a Cartesian product (N fridge rows × M invoice rows).
   *
   * The period filter reads sales_activity's OWN date columns
   * (report_year / month_num / day), not invoices.invoice_date.
   *
   * It used to INNER JOIN invoices to take the date from there, which silently
   * discarded every sale whose invoice is absent from the balance file — the
   * balance upload only carries invoices that still have an open balance. On
   * production that dropped 100% of Jeddah (806 units, the region has no
   * invoice rows at all) and 610 units of Riyadh: customers showed "غير
   * متعاملة" with 0 quantity while their sales sat in the table.
   *
   * The join bought nothing: across all 457,365 rows that DO match an invoice,
   * the two date sources disagree on year, month and day exactly ZERO times,
   * and July 2026 totals 804,014 either way.
   */

  /* ── Period filter params for the qty subquery ── */
  let saSubquery;
  if (year && month) {
    // Use invoices.invoice_date as the authoritative date
    saSubquery = `
      SELECT
        sa.customer_code,
        SUM(sa.qty)::int                        AS total_qty,
        COUNT(DISTINCT sa.invoice_number)::int  AS invoice_count,
        SUM(sa.bad_return_qty)::int             AS total_bad_return_qty
      FROM sales_activity sa
      WHERE sa.report_year = $${p++}
        AND sa.month_num   = $${p++}
        ${day ? `AND sa.day = $${p++}` : ''}
      GROUP BY sa.customer_code
    `;
    allVals.push(Number(year), Number(month));
    if (day) allVals.push(Number(day));
  } else {
    /* No month specified → no qty aggregation to avoid cross-month totals */
    saSubquery = `
      SELECT NULL::varchar AS customer_code,
             0::int        AS total_qty,
             0::int        AS invoice_count,
             0::int        AS total_bad_return_qty
      WHERE FALSE
    `;
  }

  /* ── WHERE: fridge-level filters ── */
  const whereParts = ['f.customer_code IS NOT NULL'];
  if (region_ids) {
    whereParts.push(`f.region_id = ANY($${p++}::int[])`);
    allVals.push(region_ids);
  }
  if (search?.trim()) {
    whereParts.push(`(
      f.customer_code ILIKE $${p} OR
      f.customer_name ILIKE $${p} OR
      f.salesrep_name ILIKE $${p}
    )`);
    allVals.push(`%${search.trim()}%`);
    p++;
  }

  /* ── HAVING: trading filter ── */
  let havingClause = '';
  if (trading === 'active')   havingClause = 'HAVING COALESCE(MAX(sa.total_qty), 0) > 0';
  if (trading === 'inactive') havingClause = 'HAVING COALESCE(MAX(sa.total_qty), 0) <= 0';

  try {
    const { rows } = await pool.query(
      `SELECT
         f.customer_code,
         MAX(f.customer_name)                               AS customer_name,
         MAX(r.name_ar)                                     AS region_name,
         MAX(f.salesrep_name)                               AS salesrep_name,
         COUNT(DISTINCT f.id)::int                                          AS fridge_count,
         COUNT(DISTINCT CASE WHEN f.status = 'active' THEN f.id END)::int  AS active_fridge_count,
         STRING_AGG(DISTINCT f.asset_number, ', '
                    ORDER BY f.asset_number)                               AS asset_numbers,
         STRING_AGG(DISTINCT NULLIF(TRIM(f.contract_number), ''), ', '
                    ORDER BY NULLIF(TRIM(f.contract_number), ''))          AS contract_numbers,
         -- Quantities from pre-aggregated subquery (one row per customer → no multiplication)
         COALESCE(MAX(sa.total_qty),           0)::int      AS total_qty,
         COALESCE(MAX(sa.invoice_count),       0)::int      AS invoice_count,
         COALESCE(MAX(sa.total_bad_return_qty),0)::int      AS total_bad_return_qty,
         -- Last activity: always from full history (independent of period filter)
         MAX(hist.last_ym)                                  AS last_active_ym,
         MAX(hist.last_month_name)                          AS last_month_name,
         MAX(hist.last_year)::int                           AS last_year,
         MAX(hist.last_day)::int                            AS last_day
       FROM fridges f
       LEFT JOIN (${saSubquery}) sa ON sa.customer_code = f.customer_code
       LEFT JOIN regions r           ON r.id = f.region_id
       LEFT JOIN (
         SELECT DISTINCT ON (sa2.customer_code)
           sa2.customer_code,
           sa2.report_year * 100 + sa2.month_num  AS last_ym,
           sa2.month_name                         AS last_month_name,
           sa2.report_year                        AS last_year,
           sa2.day                                AS last_day
         FROM sales_activity sa2
         JOIN invoices i2 ON i2.invoice_number = sa2.invoice_number
         WHERE sa2.qty > 0
         ORDER BY sa2.customer_code,
                  i2.invoice_date DESC NULLS LAST
       ) hist ON hist.customer_code = f.customer_code
       WHERE ${whereParts.join(' AND ')}
       GROUP BY f.customer_code
       ${havingClause}
       ORDER BY total_qty DESC, f.customer_code`,
      allVals
    );

    /* ── Summary totals ── */
    const totalQty      = rows.reduce((s, r) => s + r.total_qty, 0);
    const activeCount   = rows.filter(r => r.total_qty > 0).length;
    const inactiveCount = rows.filter(r => r.total_qty <= 0).length;

    /* ── Filter dropdown data ── */
    const yearsRes = await pool.query(
      `SELECT DISTINCT report_year FROM sales_activity ORDER BY report_year DESC`
    );

    let monthsRes = { rows: [] };
    if (year) {
      monthsRes = await pool.query(
        `SELECT DISTINCT month_num, month_name
         FROM sales_activity
         WHERE report_year = $1
         ORDER BY month_num`,
        [Number(year)]
      );
    }

    let daysRes = { rows: [] };
    if (year && month) {
      daysRes = await pool.query(
        `SELECT DISTINCT day
         FROM sales_activity
         WHERE report_year = $1 AND month_num = $2
           AND day IS NOT NULL
         ORDER BY day`,
        [Number(year), Number(month)]
      );
    }

    res.json({
      rows,
      summary: {
        total_customers:    rows.length,
        active_customers:   activeCount,
        inactive_customers: inactiveCount,
        total_qty:          totalQty,
      },
      years:  yearsRes.rows.map(r => r.report_year),
      months: monthsRes.rows,
      days:   daysRes.rows.map(r => r.day),
    });
  } catch (e) {
    console.error('[sales-report]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   FRIDGE TRANSFER REQUESTS — طلب نقل ثلاجة لعميل آخر

   A supervisor or region manager raises the request; the fridge does NOT
   move until a fridge admin (or system admin) approves it. Requests live in
   their own table — `fridge_transfers` keeps its meaning as "transfers that
   actually happened", so a pending request can never be mistaken for one.

   Both customers' route + salesman come from the `customers` master (the
   "Customer List - CM" upload) and are SNAPSHOT onto the request, so the
   printed sheet stays faithful to what was approved even after the master is
   re-uploaded and a route changes hands.
══════════════════════════════════════════════════════════════ */
const REQUEST_ROLES = ['supervisor', 'region_manager', 'sales_manager', 'super_admin', 'it_admin'];
const APPROVE_ROLES = ['fridge_admin', 'super_admin', 'it_admin'];
const canRequest = requireRoles(...REQUEST_ROLES);
const canApprove = requireRoles(...APPROVE_ROLES);

/* Route + salesman for a customer code, master first then the fridge's own
   record — the same precedence /customer-lookup uses. */
async function customerRouteInfo(code) {
  if (!code) return {};
  const { rows } = await pool.query(
    `SELECT c.customer_code, c.customer_name, c.customer_name_ar, c.route_code,
            c.route_name_en, c.salesman_name, c.region_id
       FROM customers c WHERE c.customer_code = $1`, [code]);
  if (rows.length) {
    const r = rows[0];
    return {
      customer_code: r.customer_code,
      customer_name: r.customer_name_ar || r.customer_name,
      route_code:    r.route_code,
      route_name:    r.route_name_en,
      salesman_name: r.salesman_name,
      region_id:     r.region_id,
    };
  }
  /* Not in the master — fall back to whatever the invoices know, so a request
     is still possible for a customer the CM file has not caught up with. */
  const inv = await pool.query(
    `SELECT i.customer_id AS customer_code, i.customer_name, i.route_id AS route_code,
            i.region_id, sa.salesrep_name AS salesman_name
       FROM invoices i
       LEFT JOIN LATERAL (
         SELECT salesrep_name FROM sales_activity
          WHERE customer_code = i.customer_id
          ORDER BY report_year DESC, month_num DESC LIMIT 1) sa ON true
      WHERE i.customer_id = $1 LIMIT 1`, [code]);
  return inv.rows[0] || { customer_code: code };
}

/* ── Raise a request ── */
router.post('/:id/transfer-requests', canRequest, async (req, res) => {
  const toCode = String(req.body?.to_customer_code || '').trim();
  const reason = String(req.body?.reason || '').trim() || null;
  if (!toCode) return res.status(400).json({ error: 'رقم العميل الجديد مطلوب' });

  try {
    const fRes = await pool.query(
      `SELECT f.*, r.name_ar AS region_name FROM fridges f
       LEFT JOIN regions r ON r.id = f.region_id WHERE f.id = $1`, [req.params.id]);
    if (!fRes.rowCount) return res.status(404).json({ error: 'الثلاجة غير موجودة' });
    const fridge = fRes.rows[0];

    if (fridge.customer_code && String(fridge.customer_code).trim() === toCode) {
      return res.status(400).json({ error: 'الثلاجة مسجّلة بالفعل على هذا العميل' });
    }

    const [from, to] = await Promise.all([
      customerRouteInfo(fridge.customer_code),
      customerRouteInfo(toCode),
    ]);

    const { rows } = await pool.query(
      `INSERT INTO fridge_transfer_requests
         (fridge_id, asset_number,
          from_customer_code, from_customer_name, from_route_code, from_route_name,
          from_salesman_name, from_region_id,
          to_customer_code, to_customer_name, to_route_code, to_route_name,
          to_salesman_name, to_region_id,
          reason, requested_by, requested_by_name, requested_by_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [req.params.id, fridge.asset_number,
       fridge.customer_code, from.customer_name || fridge.customer_name,
       from.route_code ?? fridge.route_code, from.route_name || null,
       from.salesman_name || fridge.salesrep_name, from.region_id ?? fridge.region_id,
       toCode, to.customer_name || null, to.route_code ?? null, to.route_name || null,
       to.salesman_name || null, to.region_id ?? null,
       reason, req.user.id, req.user.name || req.user.email, req.user.role]
    );
    const request = rows[0];

    /* Notify every approver. A request nobody sees is a request that never
       gets decided, so this is part of raising it, not an extra. */
    const approvers = await pool.query(
      /* users.role is the `user_role` ENUM — comparing it to a text[] fails
         with "operator does not exist: user_role = text", so cast it. */
      `SELECT id FROM users WHERE is_active = true AND role::text = ANY($1::text[])`,
      [APPROVE_ROLES]);
    if (approvers.rowCount) {
      const title = `طلب نقل ثلاجة ${fridge.asset_number}`;
      const body  = `${req.user.name || 'مستخدم'} يطلب نقل الثلاجة من `
                  + `${from.customer_name || fridge.customer_name || '—'} إلى ${to.customer_name || toCode}`
                  + ` — بانتظار موافقتكم.`;
      const vals = approvers.rows.map((_, i) => {
        const b = i * 5;
        return `($${b+1},$${b+2},$${b+3},'fridge_transfer_request',$${b+4},$${b+5})`;
      }).join(',');
      await pool.query(
        `INSERT INTO notifications (user_id, title, body, type, is_read, fridge_request_id)
         VALUES ${vals}`,
        approvers.rows.flatMap(u => [u.id, title, body, false, request.id]));
    }

    res.status(201).json({ request, notified: approvers.rowCount });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'يوجد طلب نقل معلّق لهذه الثلاجة بالفعل' });
    }
    console.error('[Fridges] transfer-request create:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ── List requests (pending by default) ── */
router.get('/transfer-requests', async (req, res) => {
  const status = String(req.query.status || 'pending');
  try {
    const { rows } = await pool.query(
      `SELECT tr.*, fr.name_ar AS from_region_name, tor.name_ar AS to_region_name,
              f.status AS fridge_status
         FROM fridge_transfer_requests tr
         LEFT JOIN regions fr  ON fr.id  = tr.from_region_id
         LEFT JOIN regions tor ON tor.id = tr.to_region_id
         LEFT JOIN fridges f   ON f.id   = tr.fridge_id
        WHERE ($1 = 'all' OR tr.status::text = $1)
        ORDER BY tr.requested_at DESC
        LIMIT 200`, [status]);
    res.json({ requests: rows, can_approve: APPROVE_ROLES.includes(req.user.role) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── One request (the printable sheet reads this) ── */
router.get('/transfer-requests/:reqId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tr.*, fr.name_ar AS from_region_name, tor.name_ar AS to_region_name,
              f.asset_number AS current_asset_number, f.status AS fridge_status,
              f.contract_number, f.contract_date
         FROM fridge_transfer_requests tr
         LEFT JOIN regions fr  ON fr.id  = tr.from_region_id
         LEFT JOIN regions tor ON tor.id = tr.to_region_id
         LEFT JOIN fridges f   ON f.id   = tr.fridge_id
        WHERE tr.id = $1`, [req.params.reqId]);
    if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود' });
    res.json({ request: rows[0], can_approve: APPROVE_ROLES.includes(req.user.role) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Approve → performs the actual transfer, in ONE transaction ── */
router.post('/transfer-requests/:reqId/approve', canApprove, async (req, res) => {
  const note = String(req.body?.note || '').trim() || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* FOR UPDATE: two approvers clicking at the same moment would otherwise
       both pass the status check and transfer the fridge twice. */
    const rRes = await client.query(
      `SELECT * FROM fridge_transfer_requests WHERE id = $1 FOR UPDATE`, [req.params.reqId]);
    if (!rRes.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'الطلب غير موجود' }); }
    const rq = rRes.rows[0];
    if (rq.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `الطلب ${rq.status === 'approved' ? 'معتمد بالفعل' : 'غير معلّق'}` });
    }

    const fRes = await client.query('SELECT * FROM fridges WHERE id = $1 FOR UPDATE', [rq.fridge_id]);
    if (!fRes.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'الثلاجة غير موجودة' }); }
    const fridge = fRes.rows[0];

    /* Same shape as a manual reassign so history stays uniform. The fridge is
       flagged as awaiting its contract: a new customer needs a contract signed
       by THAT customer (see the pending_contract note). */
    const tRes = await client.query(
      `INSERT INTO fridge_transfers
         (fridge_id, transfer_type, from_customer_code, from_customer_name,
          to_customer_code, to_customer_name, from_region_id, to_region_id,
          notes, created_by, created_by_name, pending_contract)
       VALUES ($1,'reassign',$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
       RETURNING id`,
      [rq.fridge_id, fridge.customer_code, fridge.customer_name,
       rq.to_customer_code, rq.to_customer_name, fridge.region_id, fridge.region_id,
       `اعتماد طلب نقل — مقدم الطلب: ${rq.requested_by_name || '—'}${rq.reason ? ' — ' + rq.reason : ''}`,
       req.user.id, req.user.name || req.user.email]);

    /* Pull the new customer's route + salesman FRESH at approval time (not the
       values snapshotted when the request was raised — the master may have
       moved on) so the fridge reflects who serves that customer right now. */
    const toInfo = await customerRouteInfo(rq.to_customer_code);

    await client.query(
      `UPDATE fridges SET
         customer_code = $1, customer_name = $2, status = 'active',
         route_code    = $5,
         salesrep_name = COALESCE($6, salesrep_name),
         pending_contract = TRUE,
         pending_contract_since = COALESCE(pending_contract_since, NOW()),
         updated_by = $3, updated_at = NOW()
       WHERE id = $4`,
      [rq.to_customer_code, rq.to_customer_name, req.user.id, rq.fridge_id,
       toInfo.route_code ?? null, toInfo.salesman_name || null]);

    const upd = await client.query(
      `UPDATE fridge_transfer_requests
          SET status='approved', decided_by=$1, decided_by_name=$2,
              decided_at=NOW(), decision_note=$3, transfer_id=$4
        WHERE id=$5 RETURNING *`,
      [req.user.id, req.user.name || req.user.email, note, tRes.rows[0].id, req.params.reqId]);

    if (rq.requested_by) {
      await client.query(
        `INSERT INTO notifications (user_id, title, body, type, is_read, fridge_request_id)
         VALUES ($1,$2,$3,'fridge_transfer_request',false,$4)`,
        [rq.requested_by, `تم اعتماد نقل الثلاجة ${rq.asset_number}`,
         `اعتمد ${req.user.name || 'مسؤول الثلاجات'} نقل الثلاجة إلى ${rq.to_customer_name || rq.to_customer_code}.`,
         req.params.reqId]);
    }

    await client.query('COMMIT');
    res.json({ request: upd.rows[0], transfer_id: tRes.rows[0].id });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[Fridges] transfer-request approve:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ── Reject — the fridge is not touched ── */
router.post('/transfer-requests/:reqId/reject', canApprove, async (req, res) => {
  const note = String(req.body?.note || '').trim() || null;
  try {
    const { rows } = await pool.query(
      `UPDATE fridge_transfer_requests
          SET status='rejected', decided_by=$1, decided_by_name=$2, decided_at=NOW(), decision_note=$3
        WHERE id=$4 AND status='pending'
        RETURNING *`,
      [req.user.id, req.user.name || req.user.email, note, req.params.reqId]);
    if (!rows.length) return res.status(409).json({ error: 'الطلب غير معلّق' });

    if (rows[0].requested_by) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, body, type, is_read, fridge_request_id)
         VALUES ($1,$2,$3,'fridge_transfer_request',false,$4)`,
        [rows[0].requested_by, `تم رفض نقل الثلاجة ${rows[0].asset_number}`,
         `رفض ${req.user.name || 'مسؤول الثلاجات'} الطلب${note ? ' — ' + note : ''}.`,
         req.params.reqId]);
    }
    res.json({ request: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Cancel — only the person who raised it ── */
router.post('/transfer-requests/:reqId/cancel', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE fridge_transfer_requests
          SET status='cancelled', decided_at=NOW()
        WHERE id=$1 AND status='pending' AND requested_by=$2
        RETURNING *`, [req.params.reqId, req.user.id]);
    if (!rows.length) return res.status(409).json({ error: 'لا يمكن إلغاء هذا الطلب' });
    res.json({ request: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Detail ────────────────────────────────────────────────── */
router.get('/:id', async (req, res) => {
  try {
    const [fridgeRes, histRes, contractsRes] = await Promise.all([
      pool.query(
        `SELECT f.*, r.name_ar AS region_name,
           (SELECT COUNT(*) FROM fridge_contracts fc WHERE fc.fridge_id = f.id)::int AS contract_count
         FROM fridges f
         LEFT JOIN regions r ON r.id = f.region_id
         WHERE f.id = $1`,
        [req.params.id]
      ),
      pool.query(
        `SELECT t.*, fr.name_ar AS from_region_name, tr.name_ar AS to_region_name
         FROM fridge_transfers t
         LEFT JOIN regions fr ON fr.id = t.from_region_id
         LEFT JOIN regions tr ON tr.id = t.to_region_id
         WHERE t.fridge_id = $1 ORDER BY t.transferred_at DESC`,
        [req.params.id]
      ),
      pool.query(
        `SELECT id, original_name, stored_name, file_size, mime_type, uploaded_at
         FROM fridge_contracts WHERE fridge_id = $1 ORDER BY uploaded_at DESC`,
        [req.params.id]
      ),
    ]);
    if (!fridgeRes.rowCount) return res.status(404).json({ error: 'الثلاجة غير موجودة' });
    res.json({ fridge: fridgeRes.rows[0], history: histRes.rows, contracts: contractsRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Update ────────────────────────────────────────────────── */
router.put('/:id', canEdit, async (req, res) => {
  const {
    asset_number, customer_code, customer_name,
    region_id, route_code, salesrep_name,
    contract_number, contract_date, status, notes,
  } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE fridges SET
         asset_number    = COALESCE($1, asset_number),
         customer_code   = $2,
         customer_name   = $3,
         region_id       = $4,
         route_code      = $5,
         salesrep_name   = $6,
         contract_number = $7,
         contract_date   = $8,
         status          = COALESCE($9, status),
         notes           = $10,
         updated_by      = $11,
         updated_at      = NOW()
       WHERE id = $12
       RETURNING *`,
      [
        asset_number?.trim() || null,
        customer_code?.trim() || null,
        customer_name?.trim() || null,
        region_id ? Number(region_id) : null,
        route_code ? Number(route_code) : null,
        salesrep_name?.trim() || null,
        contract_number?.trim() || null,
        contract_date || null,
        status || null,
        notes?.trim() || null,
        req.user.id,
        req.params.id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'الثلاجة غير موجودة' });
    res.json({ fridge: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'رقم الثلاجة موجود بالفعل' });
    res.status(500).json({ error: e.message });
  }
});

/* ── Delete ────────────────────────────────────────────────── */
router.delete('/:id', canEdit, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM fridges WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'الثلاجة غير موجودة' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Transfer (repair | reassign) ──────────────────────────── */
router.post('/:id/transfer', canEdit, async (req, res) => {
  const { transfer_type, to_customer_code, to_customer_name, notes, from_region_id, to_region_id, status, pending_contract } = req.body;
  if (!['repair', 'reassign'].includes(transfer_type)) {
    return res.status(400).json({ error: 'نوع النقل غير صحيح' });
  }
  if (transfer_type === 'reassign' && !to_customer_code?.trim()) {
    return res.status(400).json({ error: 'رقم العميل الجديد مطلوب للنقل' });
  }
  const FRIDGE_STATUSES = ['active', 'inactive', 'out_of_service', 'damaged', 'warehouse_maintenance', 'warehouse_new', 'warehouse_used'];
  if (transfer_type === 'repair' && status && !FRIDGE_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'حالة الثلاجة غير صحيحة' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Current fridge state
    const cur = await client.query(
      `SELECT customer_code, customer_name, region_id FROM fridges WHERE id = $1`,
      [req.params.id]
    );
    if (!cur.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'الثلاجة غير موجودة' }); }
    const { customer_code: fromCode, customer_name: fromName, region_id: curRegionId } = cur.rows[0];

    // Determine new state
    let newStatus     = transfer_type === 'repair' ? (status || 'warehouse_maintenance') : 'active';
    let newCustCode   = transfer_type === 'reassign' ? to_customer_code.trim() : null;
    let newCustName   = transfer_type === 'reassign' ? (to_customer_name?.trim() || null) : null;
    // Repair withdrawal records both the pickup region (منطقة السحب) and
    // delivery region (منطقة التسليم) chosen in the form — the fridge's
    // region_id then follows the delivery region. Reassign leaves the
    // fridge's existing region untouched.
    const logFromRegionId = transfer_type === 'repair' && from_region_id ? Number(from_region_id) : curRegionId;
    const logToRegionId   = transfer_type === 'repair' && to_region_id   ? Number(to_region_id)   : curRegionId;
    let newRegionId   = transfer_type === 'repair' ? logToRegionId : curRegionId;

    /* "بانتظار توقيع العقد" — only meaningful when the fridge changes hands.
       A repair withdrawal does not need a new contract, so the flag is
       ignored there rather than being silently stored and shown later. */
    const awaitingContract = transfer_type === 'reassign' && pending_contract === true;

    /* A reassign adopts the NEW customer's CURRENT route + salesman (customers
       master, invoices as fallback — the same precedence the استحضار button
       uses). A repair withdrawal leaves them untouched. */
    let newRoute = null, newRep = null;
    const applyRoute = transfer_type === 'reassign';
    if (applyRoute && newCustCode) {
      const info = await customerRouteInfo(newCustCode);
      newRoute = info.route_code ?? null;
      newRep   = info.salesman_name || null;
    }

    // Record transfer history
    await client.query(
      `INSERT INTO fridge_transfers
         (fridge_id, transfer_type, from_customer_code, from_customer_name,
          to_customer_code, to_customer_name, from_region_id, to_region_id, notes,
          created_by, created_by_name, pending_contract)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        req.params.id, transfer_type, fromCode, fromName,
        newCustCode, newCustName, logFromRegionId, logToRegionId,
        notes?.trim() || null, req.user.id, req.user.name || req.user.email,
        awaitingContract,
      ]
    );

    // Update fridge
    const { rows } = await client.query(
      `UPDATE fridges SET
         status        = $1,
         customer_code = $2,
         customer_name = $3,
         region_id     = $4,
         route_code    = CASE WHEN $8 THEN $9                          ELSE route_code    END,
         salesrep_name = CASE WHEN $8 THEN COALESCE($10, salesrep_name) ELSE salesrep_name END,
         updated_by    = $5,
         updated_at    = NOW(),
         pending_contract = $7,
         /* keep the ORIGINAL waiting-since date if it is already flagged, so
            "معلّقة منذ 40 يوماً" doesn't reset every time it is transferred */
         pending_contract_since = CASE
           WHEN $7 THEN COALESCE(pending_contract_since, NOW())
           ELSE NULL
         END
       WHERE id = $6
       RETURNING *`,
      [newStatus, newCustCode, newCustName, newRegionId, req.user.id, req.params.id, awaitingContract,
       applyRoute, newRoute, newRep]
    );

    await client.query('COMMIT');
    res.json({ fridge: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ══════════════════════════════════════════════════════════════
   NOTES  — /api/fridges/:id/note(s)

   Same two-table shape the sales-activity notes use: `fridge_notes` holds the
   ONE current note the list column shows, `fridge_notes_history` is an
   append-only trail so an edit never destroys what the previous user wrote.
══════════════════════════════════════════════════════════════ */

/* ── Full note trail for one fridge (newest first) ── */
router.get('/:id/notes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, note_text, saved_at, saved_by_name
         FROM fridge_notes_history
        WHERE fridge_id = $1
        ORDER BY saved_at DESC`,
      [req.params.id]
    );
    res.json({ history: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Save a note (upsert current + append to the trail) ── */
router.put('/:id/note', canWriteNote, async (req, res) => {
  const text = String(req.body?.note_text ?? '').trim();
  const savedByName = req.user.name || req.user.email || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const exists = await client.query('SELECT 1 FROM fridges WHERE id = $1', [req.params.id]);
    if (!exists.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الثلاجة غير موجودة' });
    }

    const { rows } = await client.query(
      `INSERT INTO fridge_notes (fridge_id, note_text, updated_at, updated_by, updated_by_name)
       VALUES ($1, $2, NOW(), $3, $4)
       ON CONFLICT (fridge_id) DO UPDATE
         SET note_text = EXCLUDED.note_text,
             updated_at = NOW(),
             updated_by = EXCLUDED.updated_by,
             updated_by_name = EXCLUDED.updated_by_name
       RETURNING note_text, updated_at, updated_by_name`,
      [req.params.id, text, req.user.id, savedByName]
    );

    /* An empty save means "clear the current note". It is still recorded in the
       trail — the fact that someone cleared it, and when, is itself history. */
    await client.query(
      `INSERT INTO fridge_notes_history (fridge_id, note_text, saved_by, saved_by_name)
       VALUES ($1, $2, $3, $4)`,
      [req.params.id, text, req.user.id, savedByName]
    );

    const cnt = await client.query(
      'SELECT COUNT(*)::int AS c FROM fridge_notes_history WHERE fridge_id = $1',
      [req.params.id]
    );

    await client.query('COMMIT');
    res.json({ note: rows[0], note_count: cnt.rows[0].c });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ══════════════════════════════════════════════════════════════
   CONTRACT FILES  — /api/fridges/:id/contracts
══════════════════════════════════════════════════════════════ */

/* ── List contracts ── */
router.get('/:id/contracts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, original_name, file_size, mime_type, uploaded_at
       FROM fridge_contracts WHERE fridge_id = $1 ORDER BY uploaded_at DESC`,
      [req.params.id]
    );
    res.json({ contracts: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Upload one or more contract files ── */
router.post(
  '/:id/contracts',
  canEdit,
  contractUpload.array('files', 10),
  async (req, res) => {
    if (!req.files?.length) return res.status(400).json({ error: 'لم يتم إرفاق ملفات' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const inserted = [];
      let derivedContractNumber = null;
      for (const f of req.files) {
        const originalName = fixName(f.originalname);
        if (!derivedContractNumber) derivedContractNumber = extractContractNumber(originalName);
        const { rows } = await client.query(
          `INSERT INTO fridge_contracts
             (fridge_id, original_name, stored_name, file_size, mime_type, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, original_name, file_size, mime_type, uploaded_at`,
          [req.params.id, originalName, f.filename, f.size, f.mimetype, req.user.id]
        );
        inserted.push(rows[0]);
      }

      // Auto-fill رقم العقد from the file name — only when the fridge doesn't
      // already have one on file, so a manually-entered number is never overwritten.
      let updatedFridge = null;
      if (derivedContractNumber) {
        const upd = await client.query(
          `UPDATE fridges SET contract_number = $1, updated_by = $2, updated_at = NOW()
           WHERE id = $3 AND (contract_number IS NULL OR TRIM(contract_number) = '')
           RETURNING contract_number`,
          [derivedContractNumber, req.user.id, req.params.id]
        );
        if (upd.rowCount) updatedFridge = upd.rows[0];
      }

      /* Uploading a contract IS the completion of a "بانتظار توقيع العقد"
         transfer, so the flag clears itself here. Doing it in the same
         transaction as the insert means the alert can never outlive the file
         it was waiting for. */
      const cleared = await client.query(
        `UPDATE fridges
            SET pending_contract = FALSE, pending_contract_since = NULL,
                updated_by = $1, updated_at = NOW()
          WHERE id = $2 AND pending_contract
          RETURNING id`,
        [req.user.id, req.params.id]
      );

      await client.query('COMMIT');
      res.status(201).json({
        contracts: inserted,
        count: inserted.length,
        contract_number: updatedFridge?.contract_number || null,
        pending_contract_cleared: cleared.rowCount > 0,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      // Clean up uploaded files on DB error
      for (const f of req.files) {
        try { fs.unlinkSync(f.path); } catch (_) {}
      }
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  }
);

/* ── Download a contract file ── */
router.get('/:id/contracts/:fileId/download', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM fridge_contracts WHERE id = $1 AND fridge_id = $2`,
      [req.params.fileId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'الملف غير موجود' });

    const file = rows[0];
    const filePath = path.join(CONTRACT_DIR, String(req.params.id), file.stored_name);

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'الملف محذوف من الخادم' });

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.sendFile(filePath);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Delete a contract file ── */
router.delete('/:id/contracts/:fileId', canEdit, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM fridge_contracts WHERE id = $1 AND fridge_id = $2 RETURNING *`,
      [req.params.fileId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'الملف غير موجود' });

    // Delete physical file
    const filePath = path.join(CONTRACT_DIR, String(req.params.id), rows[0].stored_name);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
