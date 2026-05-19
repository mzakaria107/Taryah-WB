/**
 * Current Stock — live inventory from NetSuite Web Query
 * GET  /api/current-stock          → JSON rows (cached 10 min)
 * GET  /api/current-stock/export   → Excel download
 */
const express = require('express');
const router  = express.Router();
const xlsx    = require('xlsx');
const { verifyToken } = require('../middleware/auth');

const WEBQUERY_URL =
  'https://9275514.app.netsuite.com/app/reporting/webquery.nl' +
  '?compid=9275514&entity=64075&email=nationalsales@taryahpoultry.com.sa' +
  '&role=1225&cr=543&hash=AAEJ7tMQkFEanZLtpFIfMVn8-bTk52H59LCI7TWNXZnc3OSXRds';

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

/* ── GET /api/current-stock ──────────────────────────────── */
router.get('/', verifyToken, async (req, res) => {
  const force = req.query.refresh === '1';

  if (
    !force &&
    _cache.rows &&
    _cache.fetchedAt &&
    Date.now() - _cache.fetchedAt < CACHE_TTL
  ) {
    return res.json({
      headers:   _cache.headers,
      rows:      _cache.rows,
      rowCount:  _cache.rows.length,
      fromCache: true,
      fetchedAt: _cache.fetchedAt,
    });
  }

  try {
    const { headers, rows } = await fetchFromNetsuite();
    _cache = { headers, rows, fetchedAt: Date.now() };
    console.log(`[CurrentStock] fetched ${rows.length} rows, ${headers.length} cols`);
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
      return res.json({
        headers:   _cache.headers,
        rows:      _cache.rows,
        rowCount:  _cache.rows.length,
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
router.get('/export', verifyToken, async (req, res) => {
  try {
    let headers, rows;
    if (_cache.rows) {
      ({ headers, rows } = _cache);
    } else {
      ({ headers, rows } = await fetchFromNetsuite());
      _cache = { headers, rows, fetchedAt: Date.now() };
    }

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
