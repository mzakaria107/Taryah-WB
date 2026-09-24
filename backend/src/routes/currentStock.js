/**
 * Current Stock — live inventory from NetSuite Web Query
 * GET  /api/current-stock          → JSON rows (cached 10 min)
 * GET  /api/current-stock/export   → Excel download
 */
const express = require('express');
const router  = express.Router();
const xlsx    = require('xlsx');
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter } = require('../middleware/auth');

const WEBQUERY_URL =
  'https://9275514.app.netsuite.com/app/reporting/webquery.nl' +
  '?compid=9275514&entity=64075&email=nationalsales@taryahpoultry.com.sa' +
  '&role=1225&cr=576&hash=AAEJ7tMQXF96_vqpStcG0Dzw6A6KidxwPn3wETdSaN3iEY0Mah8';

/* ── Location → region matching (server-side mirror of the same
   getRegion() logic CurrentStockPage.jsx uses to label the pivot table,
   so a region_manager's server response is actually scoped — not just
   hidden client-side). NetSuite's Location hierarchy text doesn't equal
   regions.name_ar verbatim (e.g. "شقرا" vs "شقراء"), so comparison is
   done on normalized/prefix-matched Arabic text, not strict equality. ── */
const LOC_OVERRIDES = {
  'التصميم المخزن المركزي': 'شقرا - مخزن مركزي',
};
const SEGMENT_OVERRIDES = {
  'الخرج': 'الرياض',
  'الخرج - المخزن المركزي': 'الرياض',
};
const TYPE_SUFFIXES = [
  { test: 'منتج مواد تغذية وتغليف', remove: / - منتج مواد تغذية وتغليف$/i, keep: ' مواد تغذية' },
  { test: 'منتج دام ميردا',         remove: / - منتج دام ميردا$/i,         keep: '' },
  { test: 'منتج دام',               remove: / - منتج دام$/i,               keep: '' },
  { test: '- منتج',                 remove: / - منتج.*$/i,                  keep: '' },
];
function getRegionLabel(loc) {
  if (!loc) return null;
  const clean = loc.trim();
  if (LOC_OVERRIDES[clean]) return LOC_OVERRIDES[clean];
  const parts   = clean.split(':').map(s => s.trim()).filter(Boolean);
  let   segment = parts[parts.length - 1] || clean;
  for (const { test, remove, keep } of TYPE_SUFFIXES) {
    if (segment.includes(test)) { segment = segment.replace(remove, keep).trim(); break; }
  }
  return SEGMENT_OVERRIDES[segment] ?? segment;
}
function normalizeArabic(s) {
  return String(s || '')
    .replace(/[ً-ٟ]/g, '')   // diacritics
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ء/g, '')                 // drop standalone hamza (شقراء → شقرا)
    .trim();
}
function rowMatchesRegion(row, locCol, targetNameAr) {
  const label = getRegionLabel(row[locCol]);
  if (!label) return false;
  return normalizeArabic(label).startsWith(normalizeArabic(targetNameAr));
}
function detectLocCol(headers) {
  return (
    headers.find(h => h.toLowerCase() === 'location') ||
    headers.find(h => ['موقع', 'فرع', 'مقر', 'subsidiary'].some(k => h.toLowerCase().includes(k))) ||
    headers[0] || ''
  );
}
// regions.name_ar actually stores the English branch identifier used
// elsewhere in the app (e.g. "Al-Qassem", "Riyadh") — but NetSuite's raw
// Location text is genuine Arabic ("القصيم", "الرياض"), so matching a
// region_manager's assigned region against it needs a translation table,
// or rowMatchesRegion() silently matches nothing and every region-scoped
// user sees an empty current-stock table.
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

/* ── In-memory cache ─────────────────────────────────────── */
let _cache = { headers: null, rows: null, fetchedAt: null };
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/* ── CSV parser (handles quoted fields, unicode) ─────────── */
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (!lines.length) return { headers: [], rows: [] };

  function parseLine(line) {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        cells.push(cur.trim()); cur = '';
      } else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    if (cells.every(c => c === '')) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = cells[idx] ?? ''; });
    rows.push(row);
  }
  return { headers, rows };
}

/* ── HTML table parser ───────────────────────────────────── */
function parseHTMLTable(html) {
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const clean = s =>
    s.replace(/<[^>]+>/g, '')
     .replace(/&nbsp;/g, ' ')
     .replace(/&amp;/g, '&')
     .replace(/&lt;/g, '<')
     .replace(/&gt;/g, '>')
     .replace(/&#\d+;/g, '')
     .trim();

  // Helper: extract all cells (td or th) from a <tr>...</tr> string
  const extractCells = trHtml => {
    const cells = [];
    const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let m;
    while ((m = re.exec(trHtml)) !== null) cells.push(clean(m[1]));
    return cells;
  };

  // Collect all <tr> blocks across the whole document
  const allTrs = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) allTrs.push(m[1]);

  if (!allTrs.length) return { headers: [], rows: [] };

  // Try <th> first; if none found, use first <tr> cells as headers
  let headers = [];
  const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
  while ((m = thRe.exec(html)) !== null) headers.push(clean(m[1]));

  let dataStart = 0;
  if (!headers.length) {
    // Use first row as headers
    headers = extractCells(allTrs[0]);
    dataStart = 1; // skip header row when building data rows
  }

  // Build data rows
  const rows = [];
  for (let i = dataStart; i < allTrs.length; i++) {
    const cells = extractCells(allTrs[i]);
    if (!cells.length || cells.every(c => c === '')) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = cells[idx] ?? ''; });
    rows.push(row);
  }

  console.log('[CurrentStock] HTML parsed headers:', headers.slice(0, 8));
  return { headers, rows };
}

/* ── Fetch & parse from NetSuite ─────────────────────────── */
async function fetchFromNetsuite() {
  const res = await fetch(WEBQUERY_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'text/html,text/csv,*/*',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`NetSuite HTTP ${res.status}`);

  const ct   = res.headers.get('content-type') || '';
  const text = await res.text();

  const isHtml = ct.includes('html') || text.trimStart().startsWith('<');
  return isHtml ? parseHTMLTable(text) : parseCSV(text);
}

// Scopes rows to the caller's region (region_manager only — see
// applyRegionFilter) by re-deriving each row's region label from its
// Location text, same as the frontend pivot table does for display.
async function scopeRowsToRegion(headers, rows, req) {
  if (!req.regionFilter || !req.regionFilter.length) return rows;
  const regionNames = await resolveRegionNames(req.regionFilter);
  if (!regionNames.length) return rows;
  const locCol = detectLocCol(headers);
  return rows.filter(row => regionNames.some(name => rowMatchesRegion(row, locCol, name)));
}

/* ── GET /api/current-stock ──────────────────────────────── */
router.get('/', verifyToken, applyRegionFilter, async (req, res) => {
  const force = req.query.refresh === '1';

  if (
    !force &&
    _cache.rows &&
    _cache.fetchedAt &&
    Date.now() - _cache.fetchedAt < CACHE_TTL
  ) {
    const rows = await scopeRowsToRegion(_cache.headers, _cache.rows, req);
    return res.json({
      headers:   _cache.headers,
      rows,
      rowCount:  rows.length,
      fromCache: true,
      fetchedAt: _cache.fetchedAt,
    });
  }

  try {
    const { headers, rows: allRows } = await fetchFromNetsuite();
    _cache = { headers, rows: allRows, fetchedAt: Date.now() };
    console.log(`[CurrentStock] fetched ${allRows.length} rows, ${headers.length} cols`);
    const rows = await scopeRowsToRegion(headers, allRows, req);
    res.json({
      headers,
      rows,
      rowCount:  rows.length,
      fromCache: false,
      fetchedAt: _cache.fetchedAt,
    });
  } catch (err) {
    console.error('[CurrentStock]', err.message);
    // Return stale cache if available rather than hard fail
    if (_cache.rows) {
      const rows = await scopeRowsToRegion(_cache.headers, _cache.rows, req);
      return res.json({
        headers:   _cache.headers,
        rows,
        rowCount:  rows.length,
        fromCache: true,
        stale:     true,
        fetchedAt: _cache.fetchedAt,
        warning:   err.message,
      });
    }
    res.status(502).json({ error: err.message });
  }
});

/* ── GET /api/current-stock/export ──────────────────────── */
router.get('/export', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    let headers, rows;
    if (_cache.rows) {
      ({ headers, rows } = _cache);
    } else {
      ({ headers, rows } = await fetchFromNetsuite());
      _cache = { headers, rows, fetchedAt: Date.now() };
    }
    rows = await scopeRowsToRegion(headers, rows, req);

    // Apply same filters as frontend if passed
    const { type_filter, loc_filter, search } = req.query;
    let filtered = rows;
    if (type_filter || loc_filter || search) {
      filtered = rows.filter(row => {
        if (type_filter && !Object.values(row).includes(type_filter)) return false;
        if (loc_filter  && !Object.values(row).includes(loc_filter))  return false;
        if (search) {
          const q = search.toLowerCase();
          if (!Object.values(row).some(v => String(v).toLowerCase().includes(q))) return false;
        }
        return true;
      });
    }

    const wsData = [headers, ...filtered.map(r => headers.map(h => r[h] ?? ''))];
    const ws  = xlsx.utils.aoa_to_sheet(wsData);

    // Auto column width
    ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length + 2, 12) }));

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'المخزون الحالي');

    const buf  = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const date = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="current-stock-${date}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('[CurrentStock/export]', err.message);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
