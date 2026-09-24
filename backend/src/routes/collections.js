/**
 * collections.js — GET /api/collections/performance
 *
 * Returns daily payment totals broken down by region, plus KPI summary.
 *
 * Query params:
 *   year, month          – default: current month (used when no date_from/date_to)
 *   date_from, date_to   – explicit date range override (YYYY-MM-DD)
 *   region_id            – filter to a single region (optional)
 */

const express = require('express');
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

const router = express.Router();

/* ── Branch → region matching for the live feed. NetSuite's "Location:
   Name" branch strings (e.g. "شقرا منتج تام - ميرنا", "الرياض - منتج تام
   ميرنا") always start with the region name, so a normalized prefix
   match against regions.name_ar is enough — no need for the hierarchical
   colon-parsing currentStock.js's Location field requires. ── */
function normalizeArabic(s) {
  return String(s || '')
    .replace(/[ً-ٟ]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ء/g, '')
    .trim();
}
function branchMatchesRegion(branch, targetNameAr) {
  if (!branch || !targetNameAr) return false;
  return normalizeArabic(branch).startsWith(normalizeArabic(targetNameAr));
}
// regions.name_ar actually stores the English branch identifier used
// elsewhere in the app (e.g. "Al-Qassem", "Riyadh") — but NetSuite's live
// feed "Location: Name" is genuine Arabic ("القصيم", "الرياض"), so a
// region-scoped user's filter needs a translation table, or
// branchMatchesRegion() silently matches nothing and the live feed always
// shows empty for any region_manager/supervisor. Same fix as currentStock.js.
const ARABIC_REGION_NAME = {
  'Riyadh':          'الرياض',
  'Al-Qassem':       'القصيم',
  'Shaqraa':         'شقرا',
  'Al Duwadmi':      'الدوادمي',
  'Hael':            'حائل',
  'Arar':            'عرعر',
  'Madinah':         'المدينة المنورة',
  'Hafir El Batin':  'حفر الباطن',
  'Dammam':          'الدمام',
  'Jeddah':          'جدة',
};
async function resolveRegionNames(regionIds) {
  if (!regionIds || !regionIds.length) return [];
  const r = await pool.query('SELECT name_ar FROM regions WHERE id = ANY($1::int[])', [regionIds]);
  return r.rows.map(row => ARABIC_REGION_NAME[row.name_ar] || row.name_ar).filter(Boolean);
}

/* ── NetSuite Web Query report link — "Collections with payment methods"
   (cr=516). Same pattern as currentStock.js/salesReport.js: auth is baked
   into the hash token, plain HTTP GET, HTML <table> response. The report
   itself is configured with a "Today" relative date filter in NetSuite,
   so it always reflects the current day with no date param needed. ── */
const COLLECTIONS_LIVE_URL =
  'https://9275514.app.netsuite.com/app/reporting/webquery.nl' +
  '?compid=9275514&entity=64075&email=nationalsales@taryahpoultry.com.sa' +
  '&role=1225&cr=516&hash=AAEJ7tMQ9sNEIkUofh-qG-oQJSVduTGY7GMwvdjWh4bzz7-yzpE';

function cleanCell(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .trim();
}

function parseHTMLTable(html) {
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const extractCells = trHtml => {
    const cells = [];
    const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let m;
    while ((m = re.exec(trHtml)) !== null) cells.push(cleanCell(m[1]));
    return cells;
  };

  const allTrs = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) allTrs.push(m[1]);
  if (!allTrs.length) return { headers: [], rows: [] };

  const headers = extractCells(allTrs[0]);
  const rows = [];
  for (let i = 1; i < allTrs.length; i++) {
    const cells = extractCells(allTrs[i]);
    if (!cells.length || cells.every(c => c === '')) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = cells[idx] ?? ''; });
    rows.push(row);
  }
  return { headers, rows };
}

// NetSuite renders amounts as Excel-formula cells, e.g. "=-1754.25"
function parseAmount(v) {
  const n = parseFloat(String(v || '').replace(/^=/, '').replace(/,/g, '').trim());
  return isNaN(n) ? 0 : Math.abs(n);
}

let _liveCache = null;
let _liveCacheAt = 0;
const LIVE_CACHE_TTL = 60_000; // 1 minute — matches the frontend's auto-refresh interval

async function fetchLiveCollections() {
  const now = Date.now();
  if (_liveCache && (now - _liveCacheAt) < LIVE_CACHE_TTL) {
    return { ..._liveCache, stale: false, cached: true };
  }
  try {
    const res = await fetch(COLLECTIONS_LIVE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'text/html,*/*',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`NetSuite HTTP ${res.status}`);
    const html = await res.text();
    const { rows: rawRows } = parseHTMLTable(html);

    // The report's Type column carries both "Payment" (money IN) and
    // "Customer Refund" (money OUT, back to the customer) rows, and
    // NetSuite renders BOTH with a positive "Amount Charged" — there is no
    // sign to key off. Summing every row's absolute amount (the original
    // bug here) silently ADDS refunds to the collected total instead of
    // netting them out, which is exactly what a live user comparison against
    // NetSuite's own totals caught: dashboard showed 163,975 for a day whose
    // real net collection (NetSuite's "Amount Paid" figure) was 153,749 —
    // an ~10,226 gap that matched that day's refund rows almost to the SAR.
    // A refund is money the company gave back, so it must SUBTRACT from
    // "collected today", not add to it — hence the sign flip below.
    const rows = rawRows.map((r, i) => {
      const type = r['Type'] || '';
      const isRefund = /refund/i.test(type);
      const magnitude = parseAmount(r['Amount Charged']);
      return {
        id:              i,
        document_number: r['Document Number'] || '',
        customer:        r['Customer'] || '',
        salesman:        r['Salesman'] || '',
        branch:          r['Location: Name'] || '',
        payment_method:  r['Payment Method (Transaction): Name'] || '',
        date:            r['Date'] || '',
        type,
        is_refund:       isRefund,
        amount:          isRefund ? -magnitude : magnitude,
      };
    }).filter(r => r.document_number); // drop trailing blank report rows

    const total = +rows.reduce((s, r) => s + r.amount, 0).toFixed(2);
    const result = { rows, total, count: rows.length, configured: true, fetched_at: new Date().toISOString() };
    _liveCache = result;
    _liveCacheAt = now;
    return { ...result, stale: false, cached: false };
  } catch (err) {
    console.error('[Collections] live NetSuite fetch failed:', err.message);
    if (_liveCache) return { ..._liveCache, stale: true, cached: true };
    throw err;
  }
}

/* ── Date helpers ───────────────────────────────────────────── */
function padMonth(m) { return String(m).padStart(2, '0'); }

function monthRange(year, month) {
  const from = `${year}-${padMonth(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${padMonth(month)}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

/* ─────────────────────────────────────────────────────────────
   GET /api/collections/performance
───────────────────────────────────────────────────────────── */
router.get('/performance', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const year     = parseInt(req.query.year)  || new Date().getFullYear();
    const month    = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const regionId = req.query.region_id ? parseInt(req.query.region_id) : null;

    let dateFrom = (req.query.date_from || '').trim() || null;
    let dateTo   = (req.query.date_to   || '').trim() || null;

    // Fall back to full month when no explicit range
    if (!dateFrom || !dateTo) {
      const r = monthRange(year, month);
      dateFrom = r.from;
      dateTo   = r.to;
    }

    /* ── Region lookup ───────────────────────────────────────── */
    const regionsRes = await pool.query(
      'SELECT id, name_ar FROM regions WHERE fleet_only = false ORDER BY id'
    );
    const allRegions = regionsRes.rows;

    /* ── Main query: daily totals per region ─────────────────── */
    // Region-payment link: customer_code → invoices.customer_id → invoices.region_id
    // A customer can hold invoices in more than one region; a plain DISTINCT on
    // (customer_id, region_id) then produces one row per region and fans a
    // multi-region customer's payment out into every one of them, double-
    // counting it. Each customer is booked to the region holding most of its
    // invoices instead — same fix as regionPerformance.js's regPayQ.
    const vals = [dateFrom, dateTo];
    let regionClause = '';
    if (regionId) {
      vals.push(regionId);
      regionClause = `AND r.id = $${vals.length}`;
    }

    const dailySQL = `
      SELECT
        p.tran_date::text                        AS tran_date,
        r.id                                     AS region_id,
        r.name_ar                                AS region_name,
        ROUND(SUM(p.total_paid)::numeric, 2)     AS total_paid,
        ROUND(SUM(p.cash)::numeric, 2)           AS cash,
        ROUND(SUM(p.cheque)::numeric, 2)         AS cheque,
        ROUND(SUM(p.bank_tran)::numeric, 2)      AS bank_tran,
        ROUND(SUM(p.pos)::numeric, 2)            AS pos,
        COUNT(*)::int                            AS tx_count,
        COUNT(DISTINCT p.customer_code)::int     AS customer_count
      FROM payments p
      JOIN (
        SELECT DISTINCT ON (customer_id) customer_id, region_id
        FROM invoices
        WHERE region_id IS NOT NULL
        GROUP BY customer_id, region_id
        ORDER BY customer_id, COUNT(*) DESC
      ) inv ON inv.customer_id = p.customer_code
      JOIN regions r ON r.id = inv.region_id
      WHERE p.tran_date BETWEEN $1 AND $2
        ${regionClause}
      GROUP BY p.tran_date, r.id, r.name_ar
      ORDER BY p.tran_date, r.id
    `;

    /* ── KPI totals ──────────────────────────────────────────── */
    const kpiSQL = `
      SELECT
        ROUND(SUM(p.total_paid)::numeric, 2)     AS total_paid,
        ROUND(SUM(p.cash)::numeric, 2)           AS cash,
        ROUND(SUM(p.cheque)::numeric, 2)         AS cheque,
        ROUND(SUM(p.bank_tran)::numeric, 2)      AS bank_tran,
        ROUND(SUM(p.pos)::numeric, 2)            AS pos,
        COUNT(*)::int                            AS tx_count,
        COUNT(DISTINCT p.customer_code)::int     AS customer_count,
        COUNT(DISTINCT p.tran_date)::int         AS active_days
      FROM payments p
      JOIN (
        SELECT DISTINCT ON (customer_id) customer_id, region_id
        FROM invoices
        WHERE region_id IS NOT NULL
        GROUP BY customer_id, region_id
        ORDER BY customer_id, COUNT(*) DESC
      ) inv ON inv.customer_id = p.customer_code
      JOIN regions r ON r.id = inv.region_id
      WHERE p.tran_date BETWEEN $1 AND $2
        ${regionClause}
    `;

    /* ── Region totals (for the summary row / comparison) ─────── */
    const regionTotalsSQL = `
      SELECT
        r.id                                     AS region_id,
        r.name_ar                                AS region_name,
        ROUND(SUM(p.total_paid)::numeric, 2)     AS total_paid,
        ROUND(SUM(p.cash)::numeric, 2)           AS cash,
        ROUND(SUM(p.cheque)::numeric, 2)         AS cheque,
        ROUND(SUM(p.bank_tran)::numeric, 2)      AS bank_tran,
        ROUND(SUM(p.pos)::numeric, 2)            AS pos,
        COUNT(*)::int                            AS tx_count,
        COUNT(DISTINCT p.customer_code)::int     AS customer_count
      FROM payments p
      JOIN (
        SELECT DISTINCT ON (customer_id) customer_id, region_id
        FROM invoices
        WHERE region_id IS NOT NULL
        GROUP BY customer_id, region_id
        ORDER BY customer_id, COUNT(*) DESC
      ) inv ON inv.customer_id = p.customer_code
      JOIN regions r ON r.id = inv.region_id
      WHERE p.tran_date BETWEEN $1 AND $2
        ${regionClause}
      GROUP BY r.id, r.name_ar
      ORDER BY SUM(p.total_paid) DESC
    `;

    const [dailyRes, kpiRes, regionTotalsRes] = await Promise.all([
      pool.query(dailySQL, vals),
      pool.query(kpiSQL,   vals),
      pool.query(regionTotalsSQL, vals),
    ]);

    res.json({
      date_from:     dateFrom,
      date_to:       dateTo,
      year,
      month,
      kpis:          kpiRes.rows[0] || {},
      daily:         dailyRes.rows,
      region_totals: regionTotalsRes.rows,
      regions:       allRegions,
    });
  } catch (err) {
    console.error('collections/performance error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/collections/live-today
   Live feed of today's Customer Payments straight from NetSuite —
   report CUSTOMREPORT_516 "Collections with payment methods" (the report
   itself is filtered to "Today" in NetSuite). 1-minute in-memory cache;
   falls back to the last successful fetch (flagged `stale: true`) if
   NetSuite is unreachable.
───────────────────────────────────────────────────────────── */
router.get('/live-today', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const result = await fetchLiveCollections();
    if (!req.regionFilter || !req.regionFilter.length) return res.json(result);

    const regionNames = await resolveRegionNames(req.regionFilter);
    if (!regionNames.length) return res.json(result);

    const rows = result.rows.filter(r => regionNames.some(name => branchMatchesRegion(r.branch, name)));
    const total = +rows.reduce((s, r) => s + r.amount, 0).toFixed(2);
    res.json({ ...result, rows, total, count: rows.length });
  } catch (err) {
    console.error('collections/live-today error:', err);
    res.status(502).json({ error: 'تعذّر الاتصال بـ NetSuite', configured: true, rows: [], total: 0, count: 0 });
  }
});

module.exports = router;
