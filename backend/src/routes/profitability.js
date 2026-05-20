/**
 * routes/profitability.js
 *
 * Proxies & parses the NetSuite Profitability web-query report.
 * GET /api/profitability          — returns parsed data (15-min cache)
 * GET /api/profitability?refresh=1 — forces a fresh fetch
 */

const express = require('express');
const https   = require('https');
const http    = require('http');
const router  = express.Router();
const { verifyToken } = require('../middleware/auth');

const NETSUITE_URL =
  'https://9275514.app.netsuite.com/app/reporting/webquery.nl' +
  '?compid=9275514&entity=64075&email=nationalsales@taryahpoultry.com.sa' +
  '&role=1225&cr=564&hash=AAEJ7tMQklxqAw3dsXFvgOZxuk6pPR4l5DSEZPGOHGcNzp-hQsM';

/* ── In-memory cache (15 min) ───────────────────────────────── */
let _cache = { data: null, fetchedAt: null };
const CACHE_TTL = 15 * 60 * 1000;

/* ── Fetch URL (follow redirects once) ─────────────────────── */
function fetchUrl(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        return fetchUrl(res.headers.location, redirects - 1).then(resolve).catch(reject);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('NetSuite request timeout')); });
  });
}

/* ── HTML helpers ───────────────────────────────────────────── */
function decodeHtml(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function stripTags(s) {
  return decodeHtml((s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
}

/* ── Parse HTML table → rows ────────────────────────────────── */
function parseHtmlTable(html) {
  const rows = [];
  // Split on </tr> — each segment before it is one row
  const trParts = html.split(/<\/tr>/i);
  for (const part of trParts) {
    const trIdx = part.search(/<tr/i);
    if (trIdx === -1) continue;
    const trHtml = part.slice(trIdx);

    // tr attributes
    const attrM = trHtml.match(/<tr([^>]*)>/i);
    const attrs = attrM ? attrM[1].toLowerCase() : '';

    // cells — split on closing </td> or </th>
    const cells = [];
    const cellParts = trHtml.split(/<\/t[dh]>/i);
    for (const cp of cellParts) {
      const tdM = cp.match(/<t[dh][^>]*>([\s\S]*)/i);
      if (tdM) cells.push(stripTags(tdM[1]));
    }

    if (cells.length) rows.push({ attrs, cells });
  }
  return rows;
}

/* ── Number/percent parsers ─────────────────────────────────── */
function toNum(s) {
  if (s === null || s === undefined || s === '' || s === '-' || s === '—') return null;
  const n = parseFloat(String(s).replace(/,/g, '').replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}
function toPct(s) {
  if (!s) return null;
  return toNum(String(s).replace('%', ''));
}

/* ── Column name normalizer ─────────────────────────────────── */
function mapCol(h) {
  const u = (h || '').toUpperCase().replace(/\./g, '').trim();
  if (/GROSS\s*PROFIT\s*%|GP\s*%|GROSS.*PCT/.test(u))         return 'grossProfitPct';
  if (/GROSS\s*PROFIT/.test(u))                                return 'grossProfit';
  if (/AVG\s*COST|AVERAGE\s*COST/.test(u))                    return 'avgCost';
  if (/AVG\s*PRICE|AVERAGE\s*PRICE/.test(u))                  return 'avgPrice';
  if (/%\s*OF\s*TOTAL|%\s*TOTAL|%\s*REV/.test(u))            return 'pctRevenue';
  if (/TOTAL\s*REVENUE|TOTAL\s*REV/.test(u))                  return 'totalRevenue';
  if (/TOTAL\s*COST/.test(u))                                  return 'totalCost';
  if (/QTY|QUANTITY|SOLD/.test(u) && !/TYPE/.test(u))         return 'qty';
  if (/ITEM\s*TYPE|TYPE/.test(u))                              return 'itemType';
  if (/DESCRIPTION|DESC/.test(u))                              return 'description';
  if (/ITEM/.test(u) && !/TYPE/.test(u))                       return 'item';
  return null;
}

/* ── Find header row + build colIndex map ───────────────────── */
function detectHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const { cells } = rows[i];
    const mapped = {};
    let hits = 0;
    for (let j = 0; j < cells.length; j++) {
      const f = mapCol(cells[j]);
      if (f) { mapped[j] = f; hits++; }
    }
    if (hits >= 3) {
      console.log('[Profitability] Header row cells:', cells);
      console.log('[Profitability] Column map:', mapped);
      return { headerIdx: i, colMap: mapped };
    }
  }
  // Log first 3 rows if no header found
  console.log('[Profitability] No header found. First 3 rows:', rows.slice(0, 3).map(r => r.cells));
  return null;
}

/* ── Build a data object from a cells array + colMap ── */
function buildDataRow(cells, colMap) {
  const obj = {};
  for (const [idx, field] of Object.entries(colMap)) {
    const v = cells[+idx] ?? '';
    if (field === 'pctRevenue' || field === 'grossProfitPct') {
      obj[field] = toPct(v);
    } else if (field === 'item' || field === 'description' || field === 'itemType') {
      obj[field] = v;
    } else {
      obj[field] = toNum(v);
    }
  }
  // defaults
  obj.item        = obj.item        ?? '';
  obj.description = obj.description ?? '';
  obj.itemType    = obj.itemType    ?? '';
  return obj;
}

/* ── Parse and structure ────────────────────────────────────── */
function parseProfitability(html) {
  const allRows = parseHtmlTable(html);
  const found   = detectHeader(allRows);
  if (!found) return null;

  const { headerIdx, colMap } = found;
  const hasItemType = Object.values(colMap).includes('itemType');

  const dataRows = [];
  let totalRow   = null;

  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const { attrs, cells } = allRows[i];
    if (!cells.length) continue;
    if (cells.every(c => !c)) continue;

    const row = buildDataRow(cells, colMap);

    // Detect grand total row
    const first = (row.item || cells[0] || '').toLowerCase();
    if (first === 'total' || first === 'grand total' || first.startsWith('إجمالي')) {
      totalRow = row;
      continue;
    }

    // Mark as group row if: no description AND no itemType column but has qty/revenue
    const isGroupRow =
      attrs.includes('listsubtotalrow') ||
      attrs.includes('totalrow') ||
      attrs.includes('grouprow') ||
      (!row.description && !row.itemType && row.qty != null && row.item);

    row._isGroup = isGroupRow;
    row._attrs   = attrs;
    dataRows.push(row);
  }

  // Build groups
  const groups = [];
  let cur = null;

  if (hasItemType) {
    // Group by itemType column
    const map = {};
    for (const row of dataRows) {
      const type = row.itemType || row.item || 'غير محدد';
      if (!map[type]) map[type] = { type, summary: null, items: [] };
      if (!row.description && (row.qty != null || row.totalRevenue != null)) {
        map[type].summary = row;
      } else {
        map[type].items.push(row);
      }
    }
    for (const g of Object.values(map)) groups.push(g);
  } else {
    // Detect group rows structurally
    for (const row of dataRows) {
      if (row._isGroup) {
        if (cur) groups.push(cur);
        cur = { type: row.item, summary: row, items: [] };
      } else {
        if (!cur) cur = { type: 'غير محدد', summary: null, items: [] };
        cur.items.push(row);
      }
    }
    if (cur) groups.push(cur);
  }

  // For groups with no summary, compute from items
  for (const g of groups) {
    if (!g.summary && g.items.length) {
      g.summary = {
        item:          g.type,
        description:   '',
        qty:           g.items.reduce((s, r) => s + (r.qty || 0), 0),
        totalCost:     g.items.reduce((s, r) => s + (r.totalCost || 0), 0),
        totalRevenue:  g.items.reduce((s, r) => s + (r.totalRevenue || 0), 0),
        grossProfit:   g.items.reduce((s, r) => s + (r.grossProfit || 0), 0),
        pctRevenue:    null,
        avgCost:       null,
        avgPrice:      null,
        grossProfitPct: null,
        _computed:     true,
      };
      const rev = g.summary.totalRevenue;
      const cost = g.summary.totalCost;
      if (rev)        g.summary.grossProfitPct = ((rev - cost) / rev) * 100;
      if (g.summary.qty) {
        g.summary.avgCost  = cost / g.summary.qty;
        g.summary.avgPrice = rev  / g.summary.qty;
      }
    }
  }

  return { groups, totalRow };
}

/* ── Format numbers for response ────────────────────────────── */
function clean(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith('_')) continue;
    o[k] = v;
  }
  return o;
}

/* ══════════════════════════════════════════════════════════════
   GET /api/profitability
   ══════════════════════════════════════════════════════════════ */
router.get('/', verifyToken, async (req, res) => {
  const forceRefresh = req.query.refresh === '1';

  if (!forceRefresh && _cache.data &&
      _cache.fetchedAt && (Date.now() - _cache.fetchedAt) < CACHE_TTL) {
    return res.json({ ..._cache.data, fromCache: true, fetchedAt: _cache.fetchedAt });
  }

  try {
    console.log('[Profitability] Fetching from NetSuite...');
    const html   = await fetchUrl(NETSUITE_URL);
    const parsed = parseProfitability(html);

    if (!parsed) {
      if (_cache.data) {
        return res.json({ ..._cache.data, fromCache: true, fetchedAt: _cache.fetchedAt, stale: true });
      }
      return res.status(502).json({ error: 'تعذّر تحليل بيانات NetSuite — تحقق من الرابط' });
    }

    const data = {
      groups:   parsed.groups.map(g => ({
        type:    g.type,
        summary: g.summary ? clean(g.summary) : null,
        items:   g.items.map(clean),
      })),
      total: parsed.totalRow ? clean(parsed.totalRow) : null,
    };

    _cache = { data, fetchedAt: Date.now() };
    console.log(`[Profitability] Parsed ${data.groups.length} groups`);
    res.json({ ...data, fromCache: false, fetchedAt: Date.now() });

  } catch (err) {
    console.error('[Profitability]', err.message);
    if (_cache.data) {
      return res.json({ ..._cache.data, fromCache: true, fetchedAt: _cache.fetchedAt, stale: true });
    }
    res.status(502).json({ error: 'تعذّر الاتصال بـ NetSuite: ' + err.message });
  }
});

module.exports = router;
