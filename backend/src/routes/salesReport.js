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
  // Any location containing "مخزن" → warehouse bucket (separate from regions).
  // This includes regional warehouses like "شقرا - المخزن المركزي".
  if (location.includes('مخزن')) return 'مخزن دجاج حي';
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

// Maps English DB region names → Arabic keywords that appear in NetSuite location strings
const EN_TO_AR_REGION = {
  'riyadh':         'الرياض',
  'al-qassem':      'القصيم',
  'al qassem':      'القصيم',
  'shaqraa':        'شقراء',
  'shaqra':         'شقراء',
  'al duwadmi':     'الدوادمي',
  'duwadmi':        'الدوادمي',
  'hael':           'حائل',
  'ha\'el':         'حائل',
  'arar':           'عرعر',
  'madinah':        'المدينة',
  'al madinah':     'المدينة',
  'hafir el batin': 'حفر الباطن',
  'hafr al batin':  'حفر الباطن',
  'dammam':         'الدمام',
  'al dammam':      'الدمام',
  'jeddah':         'جدة',
  'jedda':          'جدة',
};

// regionId may be a single id or an array of ids (a user can now be
// assigned more than one region) — returns the list of resolved Arabic
// region names to match against NetSuite branch labels.
async function resolveRegionName(regionId) {
  if (!regionId || (Array.isArray(regionId) && !regionId.length)) return null;
  const ids = Array.isArray(regionId) ? regionId : [regionId];
  try {
    const res = await pool.query('SELECT name_ar, name_en FROM regions WHERE id = ANY($1::int[])', [ids]);
    if (!res.rows.length) return null;
    const names = res.rows.map(row => {
      // name_ar/name_en currently stored as English — map to Arabic for NetSuite matching
      const enName = (row.name_ar || row.name_en || '').toLowerCase().trim();
      return EN_TO_AR_REGION[enName] || row.name_ar || null;
    }).filter(Boolean);
    return names.length ? names : null;
  } catch { return null; }
}

function filterByRegion(data, regionNames) {
  if (!regionNames || !data) return data;
  const names = Array.isArray(regionNames) ? regionNames : [regionNames];
  if (!names.length) return data;

  // Normalize: collapse whitespace, strip diacritics for comparison
  const norm = s => String(s).trim().replace(/\s+/g, ' ');
  const dbNames = names.map(norm);

  const filteredRegions = data.regions.filter(r => {
    const rName = norm(r.regionName);
    return dbNames.some(dbName => {
      if (rName === dbName) return true;
      if (rName.includes(dbName)) return true;
      if (dbName.includes(rName)) return true;
      // Word-level: any significant word (>1 char) from dbName appears in rName
      const words = dbName.split(/\s+/).filter(w => w.length > 1);
      return words.some(w => rName.includes(w));
    });
  });

  console.log(`[SalesReport] filterByRegion "${dbNames.join(', ')}": ${filteredRegions.length}/${data.regions.length} matched`);
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

/* ── Arabic first-letter → Latin phoneme (for fuzzy matching) ── */
const AR_INIT = {
  'أ':'a','ا':'a','إ':'i','آ':'a','ء':'a','ع':'a',
  'ب':'b','ت':'t','ث':'t',
  'ج':'j','ح':'h','خ':'k',
  'د':'d','ذ':'d','ر':'r','ز':'z',
  'س':'s','ش':'s','ص':'s','ض':'d',
  'ط':'t','ظ':'d','غ':'g',
  'ف':'f','ق':'k','ك':'k','ل':'l',
  'م':'m','ن':'n','ه':'h','ة':'h',
  'و':'w','ي':'y','ى':'y',
};
function wordInitials(name) {
  return (name || '').trim().split(/\s+/)
    .filter(w => w.length > 0)
    .map(w => AR_INIT[w[0]] || w[0].toLowerCase())
    .join('');
}
function initSimilarity(a, b) {
  if (!a || !b) return 0;
  const shorter = a.length < b.length ? a : b;
  const longer  = a.length < b.length ? b : a;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) matches++;
  }
  return matches / longer.length;
}
/* Build fuzzy alias: for each Arabic rep name, find best DB English match */
function buildAliasMap(dbRepCategories) {
  const dbKeys = Object.keys(dbRepCategories);
  const dbInitials = dbKeys.map(k => ({ key: k, initials: wordInitials(k) }));
  return function resolveAlias(repName) {
    const key = (repName || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (dbRepCategories[key]) return dbRepCategories[key]; // exact match
    // Fuzzy: compute initials signature and find best DB match
    const sig = wordInitials(key);
    let best = null, bestScore = 0;
    for (const db of dbInitials) {
      const score = initSimilarity(sig, db.initials);
      if (score > bestScore && score >= 0.75) { best = db.key; bestScore = score; }
    }
    return best ? dbRepCategories[best] : null;
  };
}

/* ── GET /sales-report/rep-categories ──────────────────────── */
router.get('/rep-categories', verifyToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT
         LOWER(TRIM(COALESCE(salesrep_name,''))) AS rep,
         NULLIF(TRIM(category_name),'')          AS category
       FROM sales_activity
       WHERE TRIM(COALESCE(salesrep_name,'')) <> ''
         AND TRIM(COALESCE(category_name,''))  <> ''
       ORDER BY rep, category`
    );
    const repCategories = {};
    const allCats = new Set();
    for (const r of rows) {
      if (!r.rep || !r.category) continue;
      allCats.add(r.category);
      if (!repCategories[r.rep]) repCategories[r.rep] = [];
      if (!repCategories[r.rep].includes(r.category))
        repCategories[r.rep].push(r.category);
    }
    // Build initials index for fuzzy matching (Arabic↔English)
    const initialsIndex = Object.entries(repCategories).map(([rep, cats]) => ({
      rep, cats, initials: wordInitials(rep),
    }));
    res.json({ repCategories, categories: [...allCats].sort(), initialsIndex });
  } catch (err) {
    console.error('[SalesReport] rep-categories error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ══════════════════════════════════════════════════════════════
   GET /sales-report/branch-summary — drillable Branch → Rep →
   Category → Customer summary table (Qty / Value / Avg Price / Returns /
   Quality Issue / Customers / Collections), built from OUR OWN data —
   sales_activity + payments + quality_issues — NOT the live NetSuite feed
   the rest of this file pulls from.

   Modeled on a NetSuite inventory-adjustment report that also carries
   Free/Good Return/Expire columns; those three have NO equivalent in
   sales_activity (only a single undifferentiated bad_return_qty exists,
   with no "جيد/تالف/منتهي الصلاحية" split) and are deliberately left out
   rather than shown as a fabricated zero — "لا يوجد مصدر لها" is meta.qty_caveat.

   Quality Issue is branch-level ONLY (from quality_issues, which carries a
   region_id but no salesman/category/customer dimension) — every deeper
   level returns quality_issue: null, same caveat the reference report
   itself carries for its own Quality Issue column.
   ══════════════════════════════════════════════════════════════ */
const BS_LEVELS = ['branch', 'rep', 'category', 'customer'];

router.get('/branch-summary', verifyToken, applyRegionFilter, async (req, res) => {
  const year      = parseInt(req.query.year) || new Date().getFullYear();
  const fromMonth = Math.max(1,  parseInt(req.query.from_month) || 1);
  const toMonth   = Math.min(12, parseInt(req.query.to_month)   || 12);
  /* An explicit calendar range (date_from/date_to) overrides year/month
     entirely and can span multiple months or years — sales_activity has
     no real date column, so it's reconstructed per row via make_date()
     from report_year/month_num/day (day is NOT NULL on every row). */
  const dateFrom = (req.query.date_from || '').trim();
  const dateTo   = (req.query.date_to   || '').trim();
  const useRange = !!(dateFrom && dateTo);
  const level     = BS_LEVELS.includes(req.query.level) ? req.query.level : 'branch';
  const pBranch   = (req.query.branch   || '').trim() || null;
  const pRep      = (req.query.rep      || '').trim() || null;
  const pCategory = (req.query.category || '').trim() || null;

  if (useRange && dateTo < dateFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });
  if (!useRange && toMonth < fromMonth) return res.status(400).json({ error: 'نطاق الأشهر غير صحيح' });
  if (level !== 'branch' && !pBranch) return res.status(400).json({ error: 'المنطقة مطلوبة لهذا المستوى' });
  if (level === 'category' || level === 'customer') {
    if (!pRep) return res.status(400).json({ error: 'المندوب مطلوب لهذا المستوى' });
  }
  if (level === 'customer' && !pCategory) return res.status(400).json({ error: 'فئة العميل مطلوبة لهذا المستوى' });

  try {
    /* RBAC: a region_manager's own branch always wins over whatever the
       client asked for, exactly like every other region-scoped report. */
    let branch = pBranch;
    if (req.regionFilter && req.regionFilter.length) {
      const r = await pool.query('SELECT name_ar FROM regions WHERE id = ANY($1::int[])', [req.regionFilter]);
      const allowed = r.rows.map(x => x.name_ar);
      if (!branch || !allowed.includes(branch)) branch = allowed[0] || null;
    }
    if (level !== 'branch' && !branch) return res.status(400).json({ error: 'المنطقة مطلوبة لهذا المستوى' });

    const groupExpr = {
      branch:   `COALESCE(NULLIF(TRIM(sa.branch_name),''),'غير محدد')`,
      rep:      `COALESCE(NULLIF(TRIM(sa.salesrep_name),''),'غير محدد')`,
      category: `COALESCE(NULLIF(TRIM(sa.category_name),''),'غير محدد')`,
      customer: `sa.customer_code || '|' || COALESCE(NULLIF(TRIM(sa.customer_name),''),sa.customer_code)`,
    }[level];

    let params, saDateWhere, payDateWhere, qiDateWhere;
    if (useRange) {
      params       = [dateFrom, dateTo];
      saDateWhere  = `make_date(sa.report_year::int, sa.month_num::int, sa.day::int) BETWEEN $1::date AND $2::date`;
      payDateWhere = `p.tran_date BETWEEN $1::date AND $2::date`;
      qiDateWhere  = `qi.issue_date BETWEEN $1::date AND $2::date`;
    } else {
      params       = [year, fromMonth, toMonth];
      saDateWhere  = `sa.report_year = $1 AND sa.month_num BETWEEN $2 AND $3`;
      payDateWhere = `EXTRACT(YEAR FROM p.tran_date) = $1 AND EXTRACT(MONTH FROM p.tran_date) BETWEEN $2 AND $3`;
      qiDateWhere  = `EXTRACT(YEAR FROM qi.issue_date) = $1 AND EXTRACT(MONTH FROM qi.issue_date) BETWEEN $2 AND $3`;
    }
    let where = saDateWhere;
    if (branch)     { params.push(branch);     where += ` AND TRIM(sa.branch_name) = $${params.length}`; }
    if (pRep)       { params.push(pRep);       where += ` AND TRIM(sa.salesrep_name) = $${params.length}`; }
    if (pCategory)  { params.push(pCategory);  where += ` AND TRIM(sa.category_name) = $${params.length}`; }

    const aggQ = pool.query(`
      SELECT ${groupExpr} AS label,
             COALESCE(SUM(sa.qty),0)::bigint            AS qty,
             COALESCE(SUM(sa.net_revenue),0)::numeric   AS value,
             COALESCE(SUM(sa.bad_return_qty),0)::bigint AS returns,
             COUNT(DISTINCT sa.customer_code)::int      AS customers
      FROM sales_activity sa
      WHERE ${where}
      GROUP BY ${groupExpr}
      ORDER BY value DESC
    `, params);

    /* Collections: each customer attributed to the ONE label (within this
       exact scope) where they moved the most qty — same "dominant bucket"
       rule regionPerformance.js uses for multi-region customers — so a
       customer split across two reps this period is not double-counted
       into both reps' collection totals. */
    const collQ = pool.query(`
      WITH cust_totals AS (
        SELECT sa.customer_code, ${groupExpr} AS label, SUM(sa.qty) AS qty
        FROM sales_activity sa
        WHERE ${where}
        GROUP BY sa.customer_code, ${groupExpr}
      ), cust_label AS (
        SELECT DISTINCT ON (customer_code) customer_code, label
        FROM cust_totals ORDER BY customer_code, qty DESC
      )
      SELECT cl.label, COALESCE(SUM(p.total_paid),0)::numeric AS collected
      FROM cust_label cl
      JOIN payments p ON p.customer_code = cl.customer_code
      WHERE ${payDateWhere}
      GROUP BY cl.label
    `, params);

    /* Quality issue — branch level only, region_id resolved the same way
       every other route in this app does: regions.name_ar stores the
       English branch identifier that sales_activity.branch_name also
       uses, so the two columns match directly. */
    const qiQ = level === 'branch'
      ? pool.query(`
          SELECT r.name_ar AS label, COALESCE(SUM(ABS(qi.quantity)),0)::bigint AS quantity
          FROM quality_issues qi
          JOIN regions r ON r.id = qi.region_id
          WHERE ${qiDateWhere}
          GROUP BY r.name_ar
        `, params)
      : Promise.resolve({ rows: [] });

    const [{ rows: aggRows }, { rows: collRows }, { rows: qiRows }] = await Promise.all([aggQ, collQ, qiQ]);

    const collByLabel = Object.fromEntries(collRows.map(r => [r.label, Number(r.collected)]));
    const qiByLabel   = Object.fromEntries(qiRows.map(r => [r.label, Number(r.quantity)]));

    const rows = aggRows.map(r => {
      const qty = Number(r.qty);
      const value = Number(r.value);
      const [customerCode, customerName] = level === 'customer' ? r.label.split('|') : [null, null];
      return {
        label:        level === 'customer' ? (customerName || customerCode) : r.label,
        customer_code: customerCode,
        qty,
        value: +value.toFixed(2),
        avg_price: qty > 0 ? +(value / qty).toFixed(2) : 0,
        returns: Number(r.returns),
        quality_issue: level === 'branch' ? (qiByLabel[r.label] ?? 0) : null,
        customers: Number(r.customers),
        // collQ groups by the SAME groupExpr as aggQ at every level (including
        // "customer_code|customer_name" for level=customer), so r.label is
        // always the right join key — splitting it into customerCode here
        // was a stale leftover that made every customer-level lookup miss.
        collections: +(collByLabel[r.label] ?? 0).toFixed(2),
        drillable: level !== 'customer',
      };
    });

    const totals = rows.reduce((t, r) => ({
      qty: t.qty + r.qty,
      value: t.value + r.value,
      returns: t.returns + r.returns,
      quality_issue: level === 'branch' ? t.quality_issue + (r.quality_issue || 0) : null,
      customers: t.customers + r.customers,
      collections: t.collections + r.collections,
    }), { qty: 0, value: 0, returns: 0, quality_issue: 0, customers: 0, collections: 0 });
    totals.avg_price = totals.qty > 0 ? +(totals.value / totals.qty).toFixed(2) : 0;
    totals.value = +totals.value.toFixed(2);
    totals.collections = +totals.collections.toFixed(2);

    res.json({
      level, rows, totals,
      meta: {
        year, from_month: fromMonth, to_month: toMonth,
        use_range: useRange, date_from: useRange ? dateFrom : null, date_to: useRange ? dateTo : null,
        branch: branch || null, rep: pRep, category: pCategory,
        next_level: level === 'branch' ? 'rep' : level === 'rep' ? 'category' : level === 'category' ? 'customer' : null,
        qty_caveat: 'الكمية الإجمالية والقيمة من مبيعات النظام؛ لا يتوفر لدينا مصدر لأعمدة Free / Good Return / Expire — التوالف المعروضة هي bad_return_qty فقط، دون تمييز جيد/تالف/منتهي الصلاحية.',
        quality_issue_caveat: 'توالف الجودة متاحة على مستوى المنطقة فقط — تعديلات المخزون في NetSuite لا تحمل بُعد مندوب/فئة/عميل.',
      },
    });
  } catch (err) {
    console.error('[SalesReport] branch-summary error:', err.message);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

module.exports = router;
