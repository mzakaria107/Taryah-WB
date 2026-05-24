/**
 * salesReport.js
 * Live sales from NetSuite Web Query
 *
 * GET /api/sales-report           → today's sales  (cached 5 min)
 * GET /api/sales-report/refresh   → force-refresh today cache
 * GET /api/sales-report/monthly   → monthly sales  (cached 5 min)
 * GET /api/sales-report/monthly/refresh → force-refresh monthly cache
 */
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

/* ── NetSuite WebQuery URLs ─────────────────────────────────── */
const BASE =
  'https://9275514.app.netsuite.com/app/reporting/webquery.nl' +
  '?compid=9275514&entity=64075&email=nationalsales@taryahpoultry.com.sa&role=1225';

// Today's sales (cr=565)
const WEBQUERY_TODAY =
  BASE + '&cr=565&hash=AAEJ7tMQ30dgSVRK-91K_ubbZyAA6En2PifvkQVCqo7ouhJEoLk';

// Monthly sales (cr=567)
const WEBQUERY_MONTHLY =
  BASE + '&cr=567&hash=AAEJ7tMQGKQv037BDZpR5EltRFFM2LKzXUE6yFc_mwTtmJaNCxU';

/* ── Caches ─────────────────────────────────────────────────── */
let _cacheToday   = null, _cacheTodayAt   = 0;
let _cacheMonthly = null, _cacheMonthlyAt = 0;
const TTL = 5 * 60 * 1000;

/* ── HTML parser ─────────────────────────────────────────────── */
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

/* ── Region extractor ───────────────────────────────────────── */
function extractRegion(location = '') {
  if (!location) return 'أخرى';
  const m = location.match(/^(.*?)[\s]*[-–]?\s*منتج\s/);
  if (m && m[1].trim()) return m[1].trim();
  const m2 = location.match(/^([^-–]+)/);
  return m2 ? m2[1].trim() : location;
}

/* ── Parse number — handles "=16800", "1,234.56" ───────────── */
function parseNum(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).replace(/^=/, '').replace(/,/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/* ── Normalize column keys ──────────────────────────────────── */
function normalizeRow(raw) {
  const keys = Object.keys(raw);
  const vals = Object.values(raw);

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
  const date  = (findKey('Date', 'التاريخ', 'تاريخ') ?? '').toString();

  return { qty, total, location: loc, itemType: itype, itemName: iname, salesRep: rep, date };
}

/* ── Build hierarchical structure ──────────────────────────── */
function buildHierarchy(rawRows) {
  const normalized = rawRows.map(normalizeRow);
  console.log(`[SalesReport] parsed ${rawRows.length} rows`);

  normalized.forEach(r => {
    if (!r.salesRep || r.salesRep === '- Unassigned -') r.salesRep = 'غير محدد';
  });

  const rows = normalized.filter(r => r.itemName && !(r.qty === 0 && r.total === 0));
  console.log(`[SalesReport] after filter: ${rows.length} rows`);
  if (rows[0]) console.log('[SalesReport] filtered row[0]:', rows[0]);

  const regionMap = {};
  for (const r of rows) {
    const region = extractRegion(r.location);
    if (!regionMap[region]) regionMap[region] = {};
    if (!regionMap[region][r.salesRep]) regionMap[region][r.salesRep] = [];
    const itemAvg = r.qty !== 0 ? r.total / Math.abs(r.qty) : 0;
    regionMap[region][r.salesRep].push({
      itemName: r.itemName,
      itemType: r.itemType,
      qty:      r.qty,
      total:    r.total,
      avgPrice: itemAvg,
      date:     r.date || null,
    });
  }

  const regions = Object.entries(regionMap).map(([regionName, reps]) => {
    const repArr = Object.entries(reps).map(([repName, items]) => {
      const repQty   = items.reduce((s, i) => s + i.qty,   0);
      const repTotal = items.reduce((s, i) => s + i.total, 0);
      const repAvg   = repQty !== 0 ? repTotal / Math.abs(repQty) : 0;
      return {
        repName,
        qty:      repQty,
        total:    repTotal,
        avgPrice: repAvg,
        items: items.sort((a,b) => b.total - a.total),
      };
    }).sort((a,b) => b.total - a.total);

    const regionQty   = repArr.reduce((s,r) => s + r.qty,   0);
    const regionTotal = repArr.reduce((s,r) => s + r.total, 0);
    const regionAvg   = regionQty !== 0 ? regionTotal / Math.abs(regionQty) : 0;

    return {
      regionName,
      qty:      regionQty,
      total:    regionTotal,
      avgPrice: regionAvg,
      repsCount: repArr.length,
      reps: repArr,
    };
  }).sort((a,b) => b.total - a.total);

  // KPIs
  const posRows = rows.filter(r => r.qty > 0);
  const negRows = rows.filter(r => r.total < 0);
  const totalRevenue = rows.reduce((s,r) => s + r.total, 0);  // net
  const totalQty     = rows.reduce((s,r) => s + r.qty,   0);  // net
  const totalReturns = Math.abs(negRows.reduce((s,r) => s + r.total, 0));

  const bestRegion = [...regions].sort((a,b) =>
    posRows.filter(r=>extractRegion(r.location)===b.regionName).reduce((s,r)=>s+r.total,0) -
    posRows.filter(r=>extractRegion(r.location)===a.regionName).reduce((s,r)=>s+r.total,0)
  )[0];

  // Date range (present when monthly query includes Date column)
  const dates = rows.map(r => r.date).filter(Boolean);
  const dateRange = dates.length
    ? { from: dates[dates.length - 1], to: dates[0] }
    : null;

  const kpi = {
    totalRevenue,
    totalQty,
    totalReturns,
    regionsCount:  regions.length,
    repsCount:     new Set(rows.map(r=>r.salesRep)).size,
    topRegion:     bestRegion?.regionName || regions[0]?.regionName || '—',
    topRep:        regions[0]?.reps[0]?.repName || '—',
    dateRange,
  };

  return { kpi, regions };
}

/* ── Region helpers ─────────────────────────────────────────── */
async function resolveRegionName(regionId) {
  if (!regionId) return null;
  try {
    const res = await pool.query('SELECT name_ar FROM regions WHERE id = $1', [regionId]);
    return res.rows[0]?.name_ar || null;
  } catch { return null; }
}

function filterByRegion(data, regionName) {
  if (!regionName || !data) return data;
  const filteredRegions = data.regions.filter(r =>
    r.regionName === regionName ||
    r.regionName.includes(regionName) ||
    regionName.includes(r.regionName)
  );
  // Recompute KPI from filtered regions
  const allItems = filteredRegions.flatMap(r => r.reps.flatMap(rep => rep.items));
  const posItems = allItems.filter(i => i.qty > 0);
  const negItems = allItems.filter(i => i.total < 0);
  const totalRevenue = allItems.reduce((s, i) => s + i.total, 0);
  const totalQty     = allItems.reduce((s, i) => s + i.qty,   0);
  const totalReturns = Math.abs(negItems.reduce((s, i) => s + i.total, 0));
  const kpi = {
    ...data.kpi,
    totalRevenue,
    totalQty,
    totalReturns,
    regionsCount: filteredRegions.length,
    repsCount:    new Set(filteredRegions.flatMap(r => r.reps.map(rep => rep.repName))).size,
    topRegion:    filteredRegions[0]?.regionName || '—',
    topRep:       filteredRegions[0]?.reps[0]?.repName || '—',
  };
  return { kpi, regions: filteredRegions };
}

/* ── Generic fetch ──────────────────────────────────────────── */
async function fetchData(url) {
  const res = await fetch(url, {
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

/* ── Routes: Today ──────────────────────────────────────────── */
router.get('/', verifyToken, applyRegionFilter, async (req, res) => {
  const force = req.query.refresh === '1';
  if (!force && _cacheToday && Date.now() - _cacheTodayAt < TTL) {
    const regionName = await resolveRegionName(req.regionFilter);
    return res.json(filterByRegion(_cacheToday, regionName));
  }
  try {
    _cacheToday  = await fetchData(WEBQUERY_TODAY);
    _cacheTodayAt = Date.now();
    const regionName = await resolveRegionName(req.regionFilter);
    res.json(filterByRegion(_cacheToday, regionName));
  } catch (err) {
    console.error('[SalesReport/today] fetch error:', err.message);
    if (_cacheToday) {
      const regionName = await resolveRegionName(req.regionFilter);
      return res.json({ ...filterByRegion(_cacheToday, regionName), stale: true });
    }
    res.status(502).json({ error: 'تعذّر جلب البيانات من NetSuite' });
  }
});

router.get('/refresh', verifyToken, applyRegionFilter, async (req, res) => {
  _cacheToday = null; _cacheTodayAt = 0;
  try {
    _cacheToday  = await fetchData(WEBQUERY_TODAY);
    _cacheTodayAt = Date.now();
    const regionName = await resolveRegionName(req.regionFilter);
    const data = filterByRegion(_cacheToday, regionName);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ── Routes: Monthly ────────────────────────────────────────── */
router.get('/monthly', verifyToken, applyRegionFilter, async (req, res) => {
  const force = req.query.refresh === '1';
  if (!force && _cacheMonthly && Date.now() - _cacheMonthlyAt < TTL) {
    const regionName = await resolveRegionName(req.regionFilter);
    return res.json(filterByRegion(_cacheMonthly, regionName));
  }
  try {
    _cacheMonthly  = await fetchData(WEBQUERY_MONTHLY);
    _cacheMonthlyAt = Date.now();
    const regionName = await resolveRegionName(req.regionFilter);
    res.json(filterByRegion(_cacheMonthly, regionName));
  } catch (err) {
    console.error('[SalesReport/monthly] fetch error:', err.message);
    if (_cacheMonthly) {
      const regionName = await resolveRegionName(req.regionFilter);
      return res.json({ ...filterByRegion(_cacheMonthly, regionName), stale: true });
    }
    res.status(502).json({ error: 'تعذّر جلب البيانات من NetSuite' });
  }
});

router.get('/monthly/refresh', verifyToken, applyRegionFilter, async (req, res) => {
  _cacheMonthly = null; _cacheMonthlyAt = 0;
  try {
    _cacheMonthly  = await fetchData(WEBQUERY_MONTHLY);
    _cacheMonthlyAt = Date.now();
    const regionName = await resolveRegionName(req.regionFilter);
    const data = filterByRegion(_cacheMonthly, regionName);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
