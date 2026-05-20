/**
 * routes/profitability.js
 *
 * GET  /api/profitability           — parsed data (15-min cache)
 * GET  /api/profitability?refresh=1 — force fresh fetch + auto-save snapshot
 * GET  /api/profitability/daily     — daily snapshots (?year=&month= optional)
 * POST /api/profitability/snapshot  — manually save today's snapshot (admin)
 */

const express = require('express');
const https   = require('https');
const http    = require('http');
const router  = express.Router();
const { verifyToken, requireRoles } = require('../middleware/auth');
const pool    = require('../db/pool');

const NETSUITE_URL =
  'https://9275514.app.netsuite.com/app/reporting/webquery.nl' +
  '?compid=9275514&entity=64075&email=nationalsales@taryahpoultry.com.sa' +
  '&role=1225&cr=564&hash=AAEJ7tMQklxqAw3dsXFvgOZxuk6pPR4l5DSEZPGOHGcNzp-hQsM';

/* ── In-memory cache (15 min) ───────────────────────────────── */
let _cache = { data: null, fetchedAt: null };
const CACHE_TTL = 15 * 60 * 1000;

/* ── Fetch URL (follow redirects) ───────────────────────────── */
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
  const trParts = html.split(/<\/tr>/i);
  for (const part of trParts) {
    const trIdx = part.search(/<tr/i);
    if (trIdx === -1) continue;
    const trHtml = part.slice(trIdx);
    const attrM  = trHtml.match(/<tr([^>]*)>/i);
    const attrs  = attrM ? attrM[1].toLowerCase() : '';
    const cells  = [];
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

/* ── Find header row ────────────────────────────────────────── */
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
      console.log('[Profitability] Header:', cells);
      return { headerIdx: i, colMap: mapped };
    }
  }
  return null;
}

/* ── Build data row from cells ──────────────────────────────── */
function buildDataRow(cells, colMap) {
  const obj = {};
  for (const [idx, field] of Object.entries(colMap)) {
    const v = cells[+idx] ?? '';
    if (field === 'pctRevenue' || field === 'grossProfitPct') obj[field] = toPct(v);
    else if (field === 'item' || field === 'description' || field === 'itemType') obj[field] = v;
    else obj[field] = toNum(v);
  }
  obj.item        = obj.item        ?? '';
  obj.description = obj.description ?? '';
  obj.itemType    = obj.itemType    ?? '';
  if ((!obj.grossProfit || obj.grossProfit === 0) && obj.totalRevenue != null && obj.totalCost != null) {
    obj.grossProfit = obj.totalRevenue - obj.totalCost;
  }
  return obj;
}

/* ── Parse full HTML report ─────────────────────────────────── */
function parseProfitability(html) {
  const allRows = parseHtmlTable(html);
  const found   = detectHeader(allRows);
  if (!found) return null;
  const { headerIdx, colMap } = found;
  const hasItemType = Object.values(colMap).includes('itemType');
  const dataRows = [];
  let totalRow = null;

  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const { attrs, cells } = allRows[i];
    if (!cells.length || cells.every(c => !c)) continue;
    const row = buildDataRow(cells, colMap);
    const first = (row.item || cells[0] || '').toLowerCase();
    if (first === 'total' || first === 'grand total' || first.startsWith('إجمالي')) {
      totalRow = row; continue;
    }
    const isGroupRow =
      attrs.includes('listsubtotalrow') || attrs.includes('totalrow') || attrs.includes('grouprow') ||
      (!row.description && !row.itemType && row.qty != null && row.item);
    row._isGroup = isGroupRow;
    row._attrs   = attrs;
    dataRows.push(row);
  }

  const groups = [];
  let cur = null;
  if (hasItemType) {
    const map = {};
    for (const row of dataRows) {
      const type = row.itemType || row.item || 'غير محدد';
      if (!map[type]) map[type] = { type, summary: null, items: [] };
      if (!row.description && (row.qty != null || row.totalRevenue != null)) map[type].summary = row;
      else map[type].items.push(row);
    }
    for (const g of Object.values(map)) groups.push(g);
  } else {
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

  for (const g of groups) {
    if (!g.summary && g.items.length) {
      const rev = g.items.reduce((s, r) => s + (r.totalRevenue || 0), 0);
      const cost = g.items.reduce((s, r) => s + (r.totalCost   || 0), 0);
      const qty  = g.items.reduce((s, r) => s + (r.qty         || 0), 0);
      const gp   = rev - cost;
      g.summary = {
        item: g.type, description: '', qty, totalCost: cost, totalRevenue: rev,
        grossProfit: gp, pctRevenue: null,
        avgCost: qty > 0 ? cost / qty : null, avgPrice: qty > 0 ? rev / qty : null,
        grossProfitPct: rev > 0 ? (gp / rev) * 100 : null, _computed: true,
      };
    } else if (g.summary) {
      const rev = g.summary.totalRevenue, cost = g.summary.totalCost;
      if ((!g.summary.grossProfit || g.summary.grossProfit === 0) && rev != null && cost != null)
        g.summary.grossProfit = rev - cost;
      if (rev && (!g.summary.grossProfitPct || g.summary.grossProfitPct === 0))
        g.summary.grossProfitPct = ((rev - cost) / rev) * 100;
    }
  }
  return { groups, totalRow };
}

/* ── Remove internal fields ─────────────────────────────────── */
function clean(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) { if (!k.startsWith('_')) o[k] = v; }
  return o;
}

/* ── Working-days helpers ───────────────────────────────────── */
function countWorkingDays(year, month, fromDay, toDay) {
  let count = 0;
  for (let d = fromDay; d <= toDay; d++) {
    if (new Date(year, month, d).getDay() !== 5) count++;
  }
  return count;
}

/* ── Core: fetch from NetSuite, parse, cache, save snapshot ─── */
async function fetchFromNetSuite() {
  console.log('[Profitability] Fetching from NetSuite...');
  const html   = await fetchUrl(NETSUITE_URL);
  const parsed = parseProfitability(html);
  if (!parsed) throw new Error('تعذّر تحليل HTML من NetSuite');

  const data = {
    groups: parsed.groups.map(g => ({
      type:    g.type,
      summary: g.summary ? clean(g.summary) : null,
      items:   g.items.map(clean),
    })),
    total: parsed.totalRow ? clean(parsed.totalRow) : null,
  };

  _cache = { data, fetchedAt: Date.now() };

  // Aggregate totals for snapshot
  const totalRevenue   = data.groups.reduce((s, g) => s + (g.summary?.totalRevenue || 0), 0);
  const totalCost      = data.groups.reduce((s, g) => s + (g.summary?.totalCost    || 0), 0);
  const grossProfit    = totalRevenue - totalCost;
  const grossProfitPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
  const qty            = data.groups.reduce((s, g) => s + (g.summary?.qty          || 0), 0);
  const today          = new Date().toISOString().slice(0, 10);

  await pool.query(`
    INSERT INTO profitability_snapshots
      (snapshot_date, total_revenue, total_cost, gross_profit, gross_profit_pct, qty)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (snapshot_date) DO UPDATE SET
      total_revenue    = EXCLUDED.total_revenue,
      total_cost       = EXCLUDED.total_cost,
      gross_profit     = EXCLUDED.gross_profit,
      gross_profit_pct = EXCLUDED.gross_profit_pct,
      qty              = EXCLUDED.qty,
      created_at       = NOW()
  `, [today, totalRevenue, totalCost, grossProfit, grossProfitPct, qty]);
  console.log(`[Profitability] Snapshot saved for ${today} — revenue: ${totalRevenue}`);

  return data;
}

/* Export for cron scheduler */
module.exports.fetchFromNetSuite = fetchFromNetSuite;

/* ══════════════════════════════════════════════════════════════
   GET /api/profitability/daily
   Supports ?year=2026&month=5 (1-based month)
   ══════════════════════════════════════════════════════════════ */
router.get('/daily', verifyToken, async (req, res) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear());
    const month = parseInt(req.query.month || now.getMonth() + 1); // 1-based from client
    const jsMonth = month - 1; // 0-based for JS Date

    const daysInMonth        = new Date(year, jsMonth + 1, 0).getDate();
    const isCurrentMonth     = year === now.getFullYear() && jsMonth === now.getMonth();
    const dayUpTo            = isCurrentMonth ? now.getDate() : daysInMonth;
    const workingDaysElapsed = countWorkingDays(year, jsMonth, 1, dayUpTo);
    const totalWorkingDays   = countWorkingDays(year, jsMonth, 1, daysInMonth);

    // Fetch snapshots for the requested month with daily increments via LAG
    // Also pull last snapshot from previous month for first-day delta
    const { rows } = await pool.query(`
      WITH base AS (
        SELECT
          snapshot_date,
          total_revenue,
          total_cost,
          gross_profit,
          gross_profit_pct,
          qty,
          LAG(total_revenue) OVER (ORDER BY snapshot_date) AS prev_revenue,
          LAG(gross_profit)  OVER (ORDER BY snapshot_date) AS prev_gross_profit,
          LAG(qty)           OVER (ORDER BY snapshot_date) AS prev_qty
        FROM profitability_snapshots
        WHERE snapshot_date >= (date_trunc('month', $1::date) - interval '1 day')
          AND snapshot_date <= (date_trunc('month', $1::date) + interval '1 month' - interval '1 day')
      )
      SELECT
        snapshot_date,
        total_revenue,
        total_cost,
        gross_profit,
        gross_profit_pct,
        qty,
        ROUND(total_revenue - COALESCE(prev_revenue, 0), 2) AS daily_revenue,
        ROUND(gross_profit  - COALESCE(prev_gross_profit, 0), 2) AS daily_gross_profit,
        ROUND(qty           - COALESCE(prev_qty, 0)::numeric, 0)::int AS daily_qty
      FROM base
      WHERE snapshot_date >= date_trunc('month', $1::date)
      ORDER BY snapshot_date DESC
    `, [`${year}-${String(month).padStart(2,'0')}-01`]);

    // Available months list for the month picker
    const { rows: months } = await pool.query(`
      SELECT DISTINCT
        EXTRACT(YEAR  FROM snapshot_date)::int AS year,
        EXTRACT(MONTH FROM snapshot_date)::int AS month
      FROM profitability_snapshots
      ORDER BY year DESC, month DESC
      LIMIT 24
    `);

    res.json({ snapshots: rows, workingDaysElapsed, totalWorkingDays, year, month, availableMonths: months });
  } catch (err) {
    console.error('[Profitability/daily]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/profitability/import-daily
   Import one day's individual (non-cumulative) data.
   Body: { snapshot_date, daily_revenue, daily_cost, daily_gross_profit, daily_qty }
   The endpoint computes the running cumulative from existing rows.
   ══════════════════════════════════════════════════════════════ */
router.post('/import-daily', verifyToken, requireRoles('super_admin', 'it_admin', 'sales_manager', 'top_management'), async (req, res) => {
  try {
    const { snapshot_date, daily_revenue, daily_cost, daily_gross_profit, daily_qty } = req.body;
    if (!snapshot_date || daily_revenue == null) {
      return res.status(400).json({ error: 'snapshot_date and daily_revenue are required' });
    }

    // Get the previous day's cumulative total (most recent row in same month)
    const { rows: prev } = await pool.query(`
      SELECT total_revenue, total_cost, gross_profit, qty
      FROM profitability_snapshots
      WHERE snapshot_date >= date_trunc('month', $1::date)
        AND snapshot_date <  $1::date
        AND source = 'excel'
      ORDER BY snapshot_date DESC
      LIMIT 1
    `, [snapshot_date]);

    const prevRow = prev[0] || {};
    const cumRev  = (parseFloat(prevRow.total_revenue) || 0) + parseFloat(daily_revenue);
    const cumCost = (parseFloat(prevRow.total_cost)    || 0) + parseFloat(daily_cost || 0);
    const cumGP   = (parseFloat(prevRow.gross_profit)  || 0) + parseFloat(daily_gross_profit || 0);
    const cumQty  = (parseInt(prevRow.qty)             || 0) + parseInt(daily_qty || 0);
    const cumGPPct = cumRev > 0 ? (cumGP / cumRev) * 100 : 0;

    await pool.query(`
      INSERT INTO profitability_snapshots
        (snapshot_date, total_revenue, total_cost, gross_profit, gross_profit_pct, qty, source)
      VALUES ($1,$2,$3,$4,$5,$6,'excel')
      ON CONFLICT (snapshot_date) DO UPDATE SET
        total_revenue    = EXCLUDED.total_revenue,
        total_cost       = EXCLUDED.total_cost,
        gross_profit     = EXCLUDED.gross_profit,
        gross_profit_pct = EXCLUDED.gross_profit_pct,
        qty              = EXCLUDED.qty,
        source           = 'excel',
        created_at       = NOW()
    `, [snapshot_date, cumRev, cumCost, cumGP, cumGPPct, cumQty]);

    console.log(`[Profitability/import-daily] ${snapshot_date}: daily=${daily_revenue} cumulative=${cumRev}`);
    res.json({ ok: true, snapshot_date, daily_revenue, cumulative_revenue: cumRev });
  } catch (err) {
    console.error('[Profitability/import-daily]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/profitability/snapshot  — manual snapshot (admin)
   ══════════════════════════════════════════════════════════════ */
router.post('/snapshot', verifyToken, requireRoles('super_admin', 'it_admin', 'sales_manager', 'top_management'), async (req, res) => {
  try {
    const data = await fetchFromNetSuite();
    res.json({ ok: true, savedAt: new Date().toISOString(), groups: data.groups.length });
  } catch (err) {
    console.error('[Profitability/snapshot]', err.message);
    res.status(502).json({ error: err.message });
  }
});

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
    const data = await fetchFromNetSuite();
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
module.exports.fetchFromNetSuite = fetchFromNetSuite;
