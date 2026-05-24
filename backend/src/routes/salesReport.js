/**
 * salesReport.js
 * Live sales transactions from NetSuite Web Query (cr=565)
 * GET /api/sales-report          → hierarchical JSON (cached 5 min)
 * GET /api/sales-report/refresh  → force-refresh cache
 */
const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../middleware/auth');

const WEBQUERY_URL =
  'https://9275514.app.netsuite.com/app/reporting/webquery.nl' +
  '?compid=9275514&entity=64075&email=nationalsales@taryahpoultry.com.sa' +
  '&role=1225&cr=565&hash=AAEJ7tMQ30dgSVRK-91K_ubbZyAA6En2PifvkQVCqo7ouhJEoLk';

/* ── Cache ─────────────────────────────────────────────────── */
let _cache = null, _cacheAt = 0;
const TTL  = 5 * 60 * 1000;

/* ── HTML parser (reused from currentStock pattern) ─────────── */
function parseHTMLTable(html) {
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const clean = s =>
    s.replace(/<[^>]+>/g, '')
     .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
     .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
     .replace(/&#\d+;/g, '').trim();

  const extractCells = trHtml => {
    const cells = []; const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi; let m;
    while ((m = re.exec(trHtml)) !== null) cells.push(clean(m[1]));
    return cells;
  };

  const allTrs = []; const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi; let m;
  while ((m = trRe.exec(html)) !== null) allTrs.push(m[1]);
  if (!allTrs.length) return [];

  let headers = [];
  const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
  while ((m = thRe.exec(html)) !== null) headers.push(clean(m[1]));

  let dataStart = 0;
  if (!headers.length) { headers = extractCells(allTrs[0]); dataStart = 1; }

  const rows = [];
  for (let i = dataStart; i < allTrs.length; i++) {
    const cells = extractCells(allTrs[i]);
    if (!cells.length || cells.every(c => c === '')) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = cells[idx] ?? ''; });
    rows.push(row);
  }
  console.log('[SalesReport] HTML headers:', headers);
  return rows;
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (!lines.length) return [];
  function parseLine(line) {
    const cells = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQ && line[i+1]==='"') { cur+='"'; i++; } else inQ=!inQ; }
      else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur=''; }
      else cur += ch;
    }
    cells.push(cur.trim()); return cells;
  }
  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    if (cells.every(c => c === '')) continue;
    const row = {}; headers.forEach((h, idx) => { row[h] = cells[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}

/* ── Region extractor from location string ─────────────────── */
function extractRegion(location = '') {
  if (!location) return 'أخرى';
  // "الرياض - منتج تام ميرنا"  → "الرياض"
  // "شقرا منتج تام - ميرنا"    → "شقرا"
  // "عرعر- منتج تام"            → "عرعر"
  // "الدمام - منتج تام"         → "الدمام"
  const m = location.match(/^(.*?)[\s]*[-–]?\s*منتج\s/);
  if (m && m[1].trim()) return m[1].trim();
  const m2 = location.match(/^([^-–]+)/);
  return m2 ? m2[1].trim() : location;
}

/* ── Parse number — handles "=16800", "1,234.56", "-155400" ── */
function parseNum(v) {
  if (v === null || v === undefined) return 0;
  // NetSuite HTML export wraps numbers in Excel formula style: "=16800"
  const s = String(v).replace(/^=/, '').replace(/,/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/* ── Normalize column keys — map by header name or by index ── */
function normalizeRow(raw) {
  const keys = Object.keys(raw);
  const vals = Object.values(raw);

  // Try to match by known English header names first
  const findKey = (...candidates) => {
    for (const c of candidates) {
      const k = keys.find(k => k.toLowerCase().includes(c.toLowerCase()));
      if (k) return raw[k];
    }
    return null;
  };

  const qty   = parseNum(findKey('Quantity', 'qty', 'كمية')  ?? vals[0]);
  const total = parseNum(findKey('Transaction Total', 'total', 'إجمالي') ?? vals[1]);
  const loc   = (findKey('Location', 'موقع') ?? vals[2] ?? '').toString();
  const itype = (findKey('Item Type', 'نوع الصنف') ?? vals[3] ?? '').toString();
  const iname = (findKey('Item: Name', 'Item Name', 'الصنف') ?? vals[4] ?? '').toString();
  const rep   = (findKey('Sales Rep', 'مندوب') ?? vals[5] ?? '').toString();

  return { qty, total, location: loc, itemType: itype, itemName: iname, salesRep: rep };
}

/* ── Build hierarchical structure ──────────────────────────── */
function buildHierarchy(rawRows) {
  // Filter out non-sales rows (unassigned reps, special warehouses, zero-qty & zero-total)
  const normalized = rawRows.map(normalizeRow);
  console.log(`[SalesReport] parsed ${rawRows.length} rows`);

  // Replace unassigned rep placeholder with a readable label
  normalized.forEach(r => {
    if (!r.salesRep || r.salesRep === '- Unassigned -') r.salesRep = 'غير محدد';
  });

  const rows = normalized
    .filter(r =>
      r.itemName &&
      !(r.qty === 0 && r.total === 0)
    );
  console.log(`[SalesReport] after filter: ${rows.length} rows`);
  if (rows[0]) console.log('[SalesReport] filtered row[0]:', rows[0]);

  // Region map: { regionName → { repName → [ {itemName, itemType, qty, total} ] } }
  const regionMap = {};

  for (const r of rows) {
    const region = extractRegion(r.location);
    if (!regionMap[region]) regionMap[region] = {};
    if (!regionMap[region][r.salesRep]) regionMap[region][r.salesRep] = [];
    regionMap[region][r.salesRep].push({
      itemName: r.itemName,
      itemType: r.itemType,
      qty:      r.qty,
      total:    r.total,
    });
  }

  // Convert to array with aggregates
  const regions = Object.entries(regionMap).map(([regionName, reps]) => {
    const repArr = Object.entries(reps).map(([repName, items]) => {
      const repQty   = items.reduce((s, i) => s + i.qty,   0);
      const repTotal = items.reduce((s, i) => s + i.total, 0);
      const repQtyPos   = items.filter(i=>i.qty>0).reduce((s,i)=>s+i.qty,0);
      const repTotalPos = items.filter(i=>i.total>0).reduce((s,i)=>s+i.total,0);
      return {
        repName,
        qty: repQty, total: repTotal,
        netQty: repQtyPos, netTotal: repTotalPos,
        items: items.sort((a,b) => b.total - a.total),
      };
    }).sort((a,b) => b.netTotal - a.netTotal);

    const regionQty   = repArr.reduce((s,r) => s + r.qty,      0);
    const regionTotal = repArr.reduce((s,r) => s + r.total,    0);
    const regionPos   = repArr.reduce((s,r) => s + r.netTotal, 0);

    return {
      regionName,
      qty: regionQty, total: regionTotal, netTotal: regionPos,
      repsCount: repArr.length,
      reps: repArr,
    };
  }).sort((a,b) => b.netTotal - a.netTotal);

  // KPIs
  const allItems = rows.filter(r => r.qty > 0);
  const kpi = {
    totalRevenue:  allItems.reduce((s,r) => s + r.total, 0),
    totalQty:      allItems.reduce((s,r) => s + r.qty,   0),
    totalReturns:  Math.abs(rows.filter(r=>r.total<0).reduce((s,r)=>s+r.total,0)),
    regionsCount:  regions.length,
    repsCount:     new Set(rows.map(r=>r.salesRep)).size,
    topRegion:     regions[0]?.regionName || '—',
    topRep:        regions[0]?.reps[0]?.repName || '—',
  };

  return { kpi, regions };
}

/* ── Fetch from NetSuite ────────────────────────────────────── */
async function fetchData() {
  const res = await fetch(WEBQUERY_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,text/csv,*/*' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`NetSuite HTTP ${res.status}`);
  const ct   = res.headers.get('content-type') || '';
  const text = await res.text();
  const raw  = (ct.includes('html') || text.trimStart().startsWith('<'))
    ? parseHTMLTable(text)
    : parseCSV(text);
  return buildHierarchy(raw);
}

/* ── Routes ─────────────────────────────────────────────────── */
router.get('/', verifyToken, async (req, res) => {
  const force = req.query.refresh === '1';
  if (!force && _cache && Date.now() - _cacheAt < TTL) return res.json(_cache);
  try {
    _cache  = await fetchData();
    _cacheAt = Date.now();
    res.json(_cache);
  } catch (err) {
    console.error('[SalesReport] fetch error:', err.message);
    if (_cache) return res.json({ ..._cache, stale: true });
    res.status(502).json({ error: 'تعذّر جلب البيانات من NetSuite' });
  }
});

router.get('/refresh', verifyToken, async (req, res) => {
  _cache = null; _cacheAt = 0;
  try {
    _cache  = await fetchData();
    _cacheAt = Date.now();
    res.json({ ok: true, ..._cache });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
