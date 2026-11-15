/**
 * GET /api/collections/after-refunds — «التحصيل بعد الاستردادات»
 *
 * Built straight from NetSuite (SuiteQL, same app_settings.netsuite_config the aging page uses),
 * because three things it needs exist nowhere in our own tables:
 *   • customer refunds (CustRfnd) — `payments` holds receipts only;
 *   • the warehouse (location) of each invoice a receipt paid;
 *   • the GL account a receipt was posted to (to exclude the «خزينة عملاء وموردين» clearing entries).
 *
 * Rules (verified to the riyal against the 1–15 Nov 2026 reference report):
 *   • collection = receipts (CustPymt) − customer refunds (CustRfnd) of the same day;
 *   • «المركز الرئيسي» = customers in category «عملاء دجاج حي»;
 *   • region = warehouse of the invoice each receipt was APPLIED to; the unapplied part of a receipt
 *     and every refund go to the warehouse of the customer's LATEST invoice;
 *   • daily average = completed days only (today excluded), Fridays excluded, main centre excluded;
 *   • «عن المتوسط» = (day without main centre − average) ÷ average.
 * Every exclusion is a query flag (1 = excluded, the default) so the page can include it on demand:
 *   ex_clearing, ex_main, ex_friday, ex_today, deduct_refunds.
 */
const express = require('express');
const pool    = require('../db/pool');
const { verifyToken } = require('../middleware/auth');
const { suiteQL } = require('../utils/netsuite');

const router = express.Router();

const MAIN_CATEGORY = 'عملاء دجاج حي';
const CLEARING_ACCOUNT_PREFIX = '150110'; // «خزينة عملاء وموردين» — cycle-closing settlements, not cash
const MAIN_REGION = 'المركز الرئيسي';

function regionOf(location) {
  const s = String(location || '').trim();
  if (!s) return 'غير محدد';
  if (s.startsWith('القصيم')) return 'القصيم';
  if (s.startsWith('الرياض') || s.startsWith('الخرج')) return 'الرياض والخرج';
  if (s.startsWith('حائل')) return 'حائل';
  if (s.startsWith('شقرا')) return 'شقراء';
  if (s.startsWith('الدوادمي')) return 'الدوادمي';
  if (s.startsWith('عرعر')) return 'عرعر';
  if (s.includes('دجاج حي')) return MAIN_REGION;
  return s;
}

async function nsConfig() {
  const r = await pool.query("SELECT value FROM app_settings WHERE key = 'netsuite_config'");
  const cfg = r.rows[0]?.value;
  if (!cfg || !cfg.account_id || !cfg.consumer_key) return null;
  return { accountId: cfg.account_id, consumerKey: cfg.consumer_key, consumerSecret: cfg.consumer_secret,
           tokenKey: cfg.token_key, tokenSecret: cfg.token_secret };
}

async function allPages(cfg, q) {
  let out = [], offset = 0;
  for (;;) {
    const page = await suiteQL(cfg, q, { limit: 1000, offset });
    out = out.concat(page.items || []);
    if (!page.hasMore) break;
    offset += 1000;
    if (offset > 200000) break; // safety
  }
  return out;
}

const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const toD = s => `TO_DATE('${s}','YYYY-MM-DD')`;
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Riyadh "today" (UTC+3) — the current day is the incomplete one
function riyadhToday() { return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10); }

const cache = new Map(); // key → { at, data }
const CACHE_MS = 3 * 60 * 1000;

async function loadRange(cfg, from, to) {
  // 1. Receipts + refunds (one row per document)
  const docs = await allPages(cfg, `
    SELECT t.id id, TO_CHAR(t.trandate,'YYYY-MM-DD') d, t.type type, t.foreigntotal amt, t.entity cust,
           t.tranid tranid, BUILTIN.DF(t.entity) cust_name,
           CASE WHEN BUILTIN.DF(c.category) = '${MAIN_CATEGORY}' THEN 1 ELSE 0 END main
    FROM transaction t JOIN customer c ON c.id = t.entity
    WHERE t.type IN ('CustPymt','CustRfnd') AND t.trandate BETWEEN ${toD(from)} AND ${toD(to)}
    ORDER BY t.id`);
  // 2. Receipts posted to the clearing account
  const clearing = await allPages(cfg, `
    SELECT DISTINCT tal.transaction id
    FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction
    WHERE t.type = 'CustPymt' AND t.trandate BETWEEN ${toD(from)} AND ${toD(to)}
      AND tal.debit > 0 AND BUILTIN.DF(tal.account) LIKE '${CLEARING_ACCOUNT_PREFIX}%'
    ORDER BY tal.transaction`);
  // 3. Applications of receipts to invoices, with the invoice's warehouse — in 7-day windows
  //    (a whole month in one SuiteQL statement is slow enough to time out)
  const apps = [];
  for (let s = from; s <= to; s = addDays(s, 7)) {
    const e = addDays(s, 6) < to ? addDays(s, 6) : to;
    apps.push(...await allPages(cfg, `
      SELECT ptll.nextdoc pay, BUILTIN.DF(tl.location) loc, ptll.foreignamount amt
      FROM PreviousTransactionLineLink ptll
      JOIN transaction pay ON pay.id = ptll.nextdoc
      JOIN transaction inv ON inv.id = ptll.previousdoc
      JOIN transactionline tl ON tl.transaction = inv.id AND tl.id = 1
      WHERE pay.type = 'CustPymt' AND inv.type = 'CustInvc' AND pay.trandate BETWEEN ${toD(s)} AND ${toD(e)}
      ORDER BY ptll.nextdoc, ptll.previousdoc`));
  }
  // 4. Latest-invoice warehouse for customers with refunds or unapplied receipts
  const appliedByPay = new Map();
  apps.forEach(a => appliedByPay.set(Number(a.pay), (appliedByPay.get(Number(a.pay)) || 0) + Number(a.amt || 0)));
  const needCust = new Set();
  docs.forEach(d => {
    if (d.type === 'CustRfnd') needCust.add(Number(d.cust));
    else if (Math.abs(Number(d.amt) - (appliedByPay.get(Number(d.id)) || 0)) > 0.005) needCust.add(Number(d.cust));
  });
  const custLoc = new Map();
  const ids = [...needCust];
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900).join(',');
    const rows = await allPages(cfg, `
      SELECT x.entity cust, BUILTIN.DF(tl.location) loc
      FROM (SELECT i.entity entity, MAX(i.id) mid FROM transaction i
            WHERE i.type = 'CustInvc' AND i.entity IN (${chunk}) GROUP BY i.entity) x
      JOIN transactionline tl ON tl.transaction = x.mid AND tl.id = 1
      ORDER BY x.entity`);
    rows.forEach(r => custLoc.set(Number(r.cust), r.loc));
  }
  return { docs, clearing: new Set(clearing.map(r => Number(r.id))), apps, appliedByPay, custLoc };
}

router.get('/after-refunds', verifyToken, async (req, res) => {
  try {
    const today = riyadhToday();
    let from = req.query.date_from, to = req.query.date_to;
    if (!isoDate(from) || !isoDate(to)) {
      const y = parseInt(req.query.year, 10) || Number(today.slice(0, 4));
      const m = parseInt(req.query.month, 10) || Number(today.slice(5, 7));
      from = `${y}-${String(m).padStart(2, '0')}-01`;
      to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    }
    if (to > today) to = today;
    if (to < from) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });
    const flag = (k, def = true) => (req.query[k] === undefined ? def : !['0', 'false'].includes(String(req.query[k])));
    const opt = {
      ex_clearing: flag('ex_clearing'), ex_main: flag('ex_main'), ex_friday: flag('ex_friday'),
      ex_today: flag('ex_today'), deduct_refunds: flag('deduct_refunds'),
    };

    const cfg = await nsConfig();
    if (!cfg) return res.status(503).json({ error: 'إعدادات الربط مع NetSuite (REST API) غير مكتملة — يدخلها مسؤول النظام من صفحة «المخزون» ← تبويب «الإعدادات» (Account ID و Consumer Key/Secret و Token Key/Secret)، ثم «اختبار الاتصال».', configured: false });

    const key = `${from}|${to}`;
    let raw = cache.get(key);
    if (!raw || req.query.refresh || Date.now() - raw.at > CACHE_MS) {
      raw = { at: Date.now(), data: await loadRange(cfg, from, to) };
      cache.set(key, raw);
      if (cache.size > 30) cache.delete(cache.keys().next().value);
    }
    const { docs, clearing, apps, appliedByPay, custLoc } = raw.data;

    // ── Per-day aggregation ──
    const days = new Map();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      days.set(d, { date: d, receipts: 0, refunds: 0, main: 0, customers: new Set(), regions: {} });
    }
    const custMonth = new Set();
    const excludedDocs = [];
    const docById = new Map(docs.map(d => [Number(d.id), d]));
    const addRegion = (day, region, amt) => { day.regions[region] = (day.regions[region] || 0) + amt; };

    docs.forEach(d => {
      const day = days.get(d.d); if (!day) return;
      const amt = Number(d.amt || 0);
      const isMain = Number(d.main) === 1;
      if (d.type === 'CustPymt') {
        if (clearing.has(Number(d.id))) {
          excludedDocs.push({ date: d.d, tranid: d.tranid, customer: d.cust_name, amount: amt });
          if (opt.ex_clearing) return;
        }
        day.receipts += amt;
        if (isMain) day.main += amt;
        day.customers.add(Number(d.cust)); custMonth.add(Number(d.cust));
        const unapplied = amt - (appliedByPay.get(Number(d.id)) || 0);
        if (Math.abs(unapplied) > 0.005) addRegion(day, isMain ? MAIN_REGION : regionOf(custLoc.get(Number(d.cust))), unapplied);
      } else {
        const r = Math.abs(amt);
        day.refunds += r;
        if (opt.deduct_refunds) {
          if (isMain) day.main -= r;
          addRegion(day, isMain ? MAIN_REGION : regionOf(custLoc.get(Number(d.cust))), -r);
        }
      }
    });
    apps.forEach(a => {
      const p = docById.get(Number(a.pay)); if (!p) return;
      if (opt.ex_clearing && clearing.has(Number(p.id))) return;
      const day = days.get(p.d); if (!day) return;
      addRegion(day, Number(p.main) === 1 ? MAIN_REGION : regionOf(a.loc), Number(a.amt || 0));
    });

    const dow = iso => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 5 = Friday
    const rows = [...days.values()].map(d => {
      const net = d.receipts - (opt.deduct_refunds ? d.refunds : 0);
      const withoutMain = net - d.main;
      return { date: d.date, dow: dow(d.date), is_friday: dow(d.date) === 5, is_today: d.date === today,
               receipts: +d.receipts.toFixed(2), refunds: +d.refunds.toFixed(2), net: +net.toFixed(2),
               main: +d.main.toFixed(2), without_main: +withoutMain.toFixed(2),
               customers: d.customers.size, regions: d.regions };
    });

    // Average base: which value, and which days count
    const base = r => (opt.ex_main ? r.without_main : r.net);
    const avgDays = rows.filter(r => !(opt.ex_friday && r.is_friday) && !(opt.ex_today && r.is_today));
    const avg = avgDays.length ? avgDays.reduce((s, r) => s + base(r), 0) / avgDays.length : 0;
    let cum = 0;
    rows.forEach(r => {
      cum += r.net; r.cumulative = +cum.toFixed(2);
      const counted = !(opt.ex_friday && r.is_friday) && !(opt.ex_today && r.is_today);
      r.vs_avg_pct = counted && avg > 0 ? +(((base(r) - avg) / avg) * 100).toFixed(1) : null;
    });

    // ── Region table ──
    const regionNames = new Set();
    rows.forEach(r => Object.keys(r.regions).forEach(k => regionNames.add(k)));
    if (opt.ex_main) regionNames.delete(MAIN_REGION);
    const last = rows[rows.length - 1];
    const regions = [...regionNames].map(name => {
      const cumR = rows.reduce((s, r) => s + (r.regions[name] || 0), 0);
      const avgR = avgDays.length ? avgDays.reduce((s, r) => s + (r.regions[name] || 0), 0) / avgDays.length : 0;
      return { region: name, today: +((last?.regions[name]) || 0).toFixed(2), cumulative: +cumR.toFixed(2), avg_daily: +avgR.toFixed(2) };
    }).sort((a, b) => b.cumulative - a.cumulative);
    const regTotal = regions.reduce((s, r) => s + r.cumulative, 0);
    regions.forEach(r => { r.share_pct = regTotal ? +((r.cumulative / regTotal) * 100).toFixed(1) : 0; });

    const sum = k => +rows.reduce((s, r) => s + r[k], 0).toFixed(2);
    const best = rows.reduce((b, r) => (!b || r.net > b.net ? r : b), null);
    rows.forEach(r => { r.regions = undefined; });

    res.json({
      period: { from, to, today },
      options: opt,
      kpis: {
        today_net: last?.net || 0, today_without_main: last?.without_main || 0, today_date: last?.date,
        cumulative: sum('net'), cumulative_without_main: sum('without_main'),
        avg_daily: +avg.toFixed(2), avg_days: avgDays.length,
        best_day: best ? { date: best.date, net: best.net } : null,
        refunds: sum('refunds'), receipts: sum('receipts'),
        refunds_pct: sum('receipts') ? +((sum('refunds') / sum('receipts')) * 100).toFixed(1) : 0,
        customers_period: custMonth.size, customers_today: last?.customers || 0,
        main_total: sum('main'),
      },
      days: rows,
      totals: { receipts: sum('receipts'), refunds: sum('refunds'), net: sum('net'), main: sum('main'),
                without_main: sum('without_main'), customers: custMonth.size },
      regions,
      region_totals: { today: +regions.reduce((s, r) => s + r.today, 0).toFixed(2), cumulative: +regTotal.toFixed(2),
                       avg_daily: +regions.reduce((s, r) => s + r.avg_daily, 0).toFixed(2) },
      excluded_docs: excludedDocs,
      fetched_at: new Date(raw.at).toISOString(),
    });
  } catch (err) {
    console.error('[Collections/after-refunds]', err.message);
    res.status(502).json({ error: 'تعذّر جلب البيانات من NetSuite: ' + err.message });
  }
});

module.exports = router;
