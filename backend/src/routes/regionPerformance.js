/**
 * regionPerformance.js — GET /api/region-performance/*
 *
 * Region assessment + growth planning. Pulls every reading the planning
 * page needs from the existing dashboard tables:
 *   sales_activity → qty, net_revenue, bad_return_qty, visits, reps, customers
 *   invoices       → invoiced / debt ratio / current debt
 *   payments       → monthly collections
 *   sales_reps     → active rep + route counts (capacity baseline)
 *
 * Region scoping note: sales_activity.branch_name stores the ENGLISH region
 * name (e.g. "Riyadh"), while invoices/payments scope by regions.id — so the
 * branch filter is translated both ways (branchToRegionIds / resolveRegionBranch).
 */

const express = require('express');
const pool    = require('../db/pool');
const { verifyToken, applyRegionFilter, requirePagePermission } = require('../middleware/auth');

const router = express.Router();

const MONTH_AR = {
  1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
  7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
};

/* Daily-visit target band — the planning page measures actual visits/day
   against this and prices the gap. */
const VISIT_TARGET_MIN = 10;
const VISIT_TARGET_MAX = 15;

/* A region/category pair below this many units over the period is treated
   as too thin for its ASP to be trustworthy, so it can't set the
   cross-region price benchmark. */
const BENCHMARK_MIN_QTY = 100;

/* "direct" is the central-warehouse pseudo-rep, not a field rep. Its
   invoices carry millions in balance that would otherwise be attributed to
   whichever region it books under (Shaqraa) — same exclusion summary.js
   applies to every debt figure. */
const DIRECT_EXCLUDE = `LOWER(TRIM(COALESCE(i.sales_rep_name, ''))) <> 'direct'`;

/* ── Weight (kg) sold ─────────────────────────────────────────
   There is no weight column — the unit weight lives inside the item name, in
   three different shapes: "1000gm", "450 gm", "450g". The pattern is anchored
   on the trailing g/gm rather than "first number in the string", otherwise
   "2 pieces Chicken 600gm" would read as 2 grams instead of 600.
   Verified on production: all 39 distinct item names match, 0 of 123,205 lines
   unmatched, giving a plausible 0.947 kg average per unit.
   ──────────────────────────────────────────────────────────── */
const ITEM_GRAMS_SQL = `NULLIF(substring(sa.item_name_en from '([0-9]+(?:\\.[0-9]+)?) *[gG]'),'')::numeric`;

/* A "2 pieces Chicken 600gm" unit holds TWO 600g pieces, so the stated weight
   is per piece and must be doubled. Read as a general "N pieces" multiplier
   rather than a hardcoded item list, so the not-yet-selling -S variants and any
   future "3 pieces" line are handled without another code change.
   Safe by inspection: no item name in the table starts with a digit unless it
   is a "N pieces" item, so nothing else can match. */
const ITEM_PIECES_SQL = `COALESCE(NULLIF(substring(sa.item_name_en from '^ *([0-9]+) *[Pp]ieces?'),'')::numeric, 1)`;

const QTY_KG_SQL = `COALESCE(SUM(sa.qty * COALESCE(${ITEM_GRAMS_SQL},0) * ${ITEM_PIECES_SQL}),0)/1000.0`;

/* ════════════════════════════════════════════════════════════
   Weighted performance scorecard (منهجية التقييم والمعايير المرجعية)

   Six indicators, benchmarked against the PEER MEDIAN — regions against the
   median of all regions, a rep against the median of the reps in their own
   region. The median (not the mean) is the benchmark on purpose: one outlier
   region cannot drag the bar for everyone, which a mean would allow.

   Each indicator scores value ÷ benchmark, capped at 100% of its own weight —
   the same "achievement can never exceed the item's weight" rule already used
   in the commission engine. An indicator whose benchmark is zero or whose
   value is unavailable is DROPPED and the remaining weights are rescaled to
   100%, so an entity is never penalised for data that does not exist.
   ════════════════════════════════════════════════════════════ */
/* Target model, mirroring the methodology workbook:
     mode 'self'  → target = own value × factor  (an improvement goal on itself)
     mode 'fixed' → target = factor             (a flat bar, used for growth rates)
     floor:true   → the peer median also applies, so a laggard must at least
                    reach the middle of the field; for a lower-is-better metric
                    the floor becomes a ceiling (min instead of max).
   `dir:'low'` inverts the achievement ratio — a smaller value is better. */
/* Absolute company targets — these replaced the peer median as the floor.
   The median floor made every entity score the same 1/1.03 or 1/1.08 on a
   self-target, because target = value × factor cancels the value out. A fixed
   floor restores discrimination: whoever is below 14.00 ASP is measured
   against 14.00, so the ratio finally differs per region. */
const VISIT_TARGET_SCORE = 13;    // فواتير لكل مندوب/يوم — also the gap's baseline
// Single source of truth for the company ASP target: the scorecard floor AND the
// "الهدف العام" the mix table shows are the same number, so the frontend reads it
// back off the indicator definition instead of keeping its own copy.
const ASP_FIXED_TARGET   = 14.50;

const SCORE_INDICATORS = [
  { key: 'asp',            label: 'تحقق متوسط السعر',  weight: 20, dir: 'high', mode: 'self',  factor: 1.03, floorValue: ASP_FIXED_TARGET, hint: `هدف = الأعلى بين (ASP الحالي +3%) و${ASP_FIXED_TARGET.toFixed(2)}` },
  { key: 'inv_per_repday', label: 'إنتاجية الزيارات',  weight: 20, dir: 'high', mode: 'self',  factor: 1.08, floorValue: VISIT_TARGET_SCORE, hint: 'زيارات لكل مندوب/يوم (زيارة = عميل واحد في يوم واحد لمندوب واحد) — هدف = الأعلى بين (+8%) و13' },
  { key: 'kg_per_repday',  label: 'إنتاجية الكمية',    weight: 20, dir: 'high', mode: 'self',  factor: 1.08, floorValue: 800,   hint: 'كجم لكل مندوب/يوم — هدف = الأعلى بين (+8%) و800' },
  { key: 'inv_per_cust',   label: 'تكرار خدمة العميل', weight: 10, dir: 'high', mode: 'self',  factor: 1.08, floorValue: 5,     hint: 'فواتير لكل عميل شهرياً — هدف = الأعلى بين (+8%) و5' },
  { key: 'avg_invoice',    label: 'متوسط الفاتورة',    weight: 10, dir: 'high', mode: 'self',  factor: 1.03, floorValue: 1500,  hint: 'قيمة الفاتورة — هدف = الأعلى بين (+3%) و1500' },
  { key: 'visit_gap',      label: 'فجوة الزيارة',      weight: 5, dir: 'low',  mode: 'gap',   factor: 1,    floorValue: 0,     hint: 'هدف الزيارات (13) − الزيارات/مندوب/يوم الفعلية — الصفر هو الأفضل' },
  { key: 'mom_revenue',    label: 'زخم المبيعات',      weight: 5, dir: 'high', mode: 'fixed', factor: 1.08, floorValue: null,  hint: 'آخر 3 أشهر مكتملة ÷ أول 3 أشهر — هدف +8%' },
  { key: 'mom_qty',        label: 'زخم الكمية',        weight: 5,  dir: 'high', mode: 'fixed', factor: 1.08, floorValue: null,  hint: 'آخر 3 أشهر مكتملة ÷ أول 3 أشهر — هدف +8%' },
  { key: 'mom_invoices',   label: 'نمو الفواتير',      weight: 5,  dir: 'high', mode: 'fixed', factor: 1.08, floorValue: null,  hint: 'آخر 3 أشهر مكتملة ÷ أول 3 أشهر — هدف +8%' },
];

/* Narrative per indicator. `act` receives the entity's own target (or, for the
   gap, its own shortfall) so the recommendation carries a concrete number the
   region or rep can be held to — not generic advice. */
const ADVICE = {
  asp: {
    good: 'متوسط السعر عند الهدف أو أعلى',
    bad:  'متوسط السعر أقل من الهدف',
    act:  (t) => `رفع ASP تدريجياً إلى ${t.toFixed(2)} عبر تحسين مزيج الأصناف وضبط الخصومات`,
  },
  inv_per_repday: {
    good: 'إنتاجية الزيارات اليومية قوية',
    bad:  'عدد الزيارات اليومية منخفض',
    act:  (t) => `رفع الزيارات إلى ${t.toFixed(1)} زيارة/مندوب/يوم بخطة مسارات A/B/C`,
  },
  kg_per_repday: {
    good: 'كمية البيع اليومية مرتفعة',
    bad:  'كمية البيع اليومية أقل من الهدف',
    act:  (t) => `استهداف ${Math.round(t)} كجم/مندوب/يوم عبر البيع المتقاطع ورفع أوزان الأصناف`,
  },
  inv_per_cust: {
    good: 'تكرار خدمة العملاء جيد',
    bad:  'تكرار زيارة العميل منخفض',
    act:  (t) => `رفع التكرار إلى ${t.toFixed(1)} فاتورة/عميل شهرياً وتقسيم العملاء: A أسبوعي، B نصف شهري، C شهري`,
  },
  avg_invoice: {
    good: 'متوسط قيمة الفاتورة مرتفع',
    bad:  'متوسط قيمة الفاتورة منخفض',
    act:  (t) => `رفع متوسط الفاتورة إلى ${Math.round(t)} ر.س بزيادة عدد أسطر الفاتورة والبيع المتقاطع`,
  },
  visit_gap: {
    good: 'لا توجد فجوة عن هدف الزيارات',
    bad:  'فجوة واضحة عن هدف الزيارات',
    act:  (_t, v) => `إغلاق فجوة ${v.toFixed(1)} زيارة/يوم للوصول إلى هدف ${VISIT_TARGET_SCORE}`,
  },
  mom_revenue: {
    good: 'اتجاه المبيعات في آخر 3 أشهر إيجابي',
    bad:  'تراجع المبيعات في آخر 3 أشهر',
    act:  () => 'تنفيذ قائمة استعادة العملاء المتراجعين ومراجعة أسباب فقد المبيعات',
  },
  mom_qty: {
    good: 'نمو الكميات يدعم الاستدامة',
    bad:  'تراجع الكميات في آخر 3 أشهر',
    act:  () => 'مراجعة فجوة الأصناف لكل عميل ورفع الكميات على العملاء النشطين',
  },
  mom_invoices: {
    good: 'نمو عدد الفواتير إيجابي',
    bad:  'تراجع عدد الفواتير',
    act:  () => 'رفع التغطية اليومية وزيادة عدد الفواتير على العملاء الحاليين',
  },
};
const STRENGTH_AT = 1.00;   // met or beat its target
const WEAKNESS_AT = 0.85;   // materially short of it

/* Text bands replace the bare number on screen. */
const SCORE_BANDS = [
  { min: 85, label: 'متميز',        key: 'excellent' },
  { min: 70, label: 'قوي',          key: 'strong'    },
  { min: 55, label: 'متوسط',        key: 'average'   },
  { min: 40, label: 'يحتاج تحسين',  key: 'improve'   },
  { min: -Infinity, label: 'حرج',   key: 'critical'  },
];
const bandOf = s => (s == null ? null : SCORE_BANDS.find(b => s >= b.min));

function median(values) {
  const v = values.filter(x => x != null && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/* entities: [{ key, peer, metrics:{...} }] — `peer` groups the median. */
function scoreEntities(entities) {
  const byPeer = new Map();
  entities.forEach(e => {
    if (!byPeer.has(e.peer)) byPeer.set(e.peer, []);
    byPeer.get(e.peer).push(e);
  });

  const benchmarks = {};
  byPeer.forEach((list, peer) => {
    benchmarks[peer] = {};
    SCORE_INDICATORS.forEach(ind => {
      benchmarks[peer][ind.key] = median(list.map(e => e.metrics[ind.key]));
    });
  });

  const scored = entities.map(e => {
    const med = benchmarks[e.peer] || {};
    const parts = [];
    let earned = 0, applicable = 0;
    SCORE_INDICATORS.forEach(ind => {
      const raw = e.metrics[ind.key];
      const val = raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw);
      const m   = med[ind.key];

      /* The visit gap is a shortfall, so its ideal is ZERO and the usual
         target/value ratio would divide by zero. It is scored as how much of
         the visit target was closed: gap 0 → full marks, gap = the whole
         target → nothing. */
      if (ind.mode === 'gap') {
        if (val == null || !Number.isFinite(val)) {
          parts.push({ key: ind.key, value: null, benchmark: 0, median: m ?? null,
                       ratio: null, points: null, weight: ind.weight, dir: ind.dir });
          return;
        }
        const r = Math.max(0, 1 - val / VISIT_TARGET_SCORE);
        const pts = r * ind.weight;
        earned += pts;
        applicable += ind.weight;
        parts.push({ key: ind.key, value: +val.toFixed(3), benchmark: 0,
                     median: m == null ? null : +Number(m).toFixed(3),
                     ratio: +r.toFixed(3), points: +pts.toFixed(2),
                     weight: ind.weight, dir: ind.dir });
        return;
      }

      /* 'self' grades the entity against an improvement on its OWN value; the
         absolute company target then applies as a floor, so a laggard cannot
         pass by improving 8% on a very low base. */
      let target = null;
      if (ind.mode === 'fixed') {
        target = ind.factor;
      } else if (val != null && val > 0) {
        target = val * ind.factor;
      }
      // The fixed company target stands on its own: a zero or negative value is
      // real data meaning very poor performance, so it must score ZERO against
      // that target rather than have the indicator dropped and its weight
      // rescaled away — dropping would reward a region for selling nothing.
      if (ind.floorValue != null) {
        target = target == null ? ind.floorValue : Math.max(target, ind.floorValue);
      }

      const usable = val != null && Number.isFinite(val) && target != null && target > 0;
      if (!usable) {
        parts.push({ key: ind.key, value: val, benchmark: target ?? null, median: m ?? null,
                     ratio: null, points: null, weight: ind.weight, dir: ind.dir });
        return;
      }
      const ratio  = val / target;
      const points = Math.max(0, Math.min(ratio, 1)) * ind.weight;
      earned += points;
      applicable += ind.weight;
      parts.push({
        key: ind.key, value: +val.toFixed(3), benchmark: +Number(target).toFixed(3),
        median: m == null ? null : +Number(m).toFixed(3),
        ratio: +ratio.toFixed(3), points: +points.toFixed(2), weight: ind.weight, dir: ind.dir,
      });
    });
    // Rescaled to 100% over the indicators that could actually be computed.
    const score = applicable > 0 ? +((earned / applicable) * 100).toFixed(1) : null;
    const band = bandOf(score);

    /* Strengths / weaknesses / actions, derived from the same parts so the
       narrative can never disagree with the number above it. Actions are
       ranked by POINTS LOST, not by ratio — a 20%-weight indicator at 90% costs
       more than a 5%-weight one at 60%, and should be fixed first. */
    const rated = parts.filter(p => p.ratio != null);
    const strengths = rated.filter(p => p.ratio >= STRENGTH_AT)
      .sort((a, b) => b.weight - a.weight)
      .map(p => ADVICE[p.key]?.good).filter(Boolean);
    const weakParts = rated.filter(p => p.ratio < WEAKNESS_AT)
      .sort((a, b) => (b.weight - b.points) - (a.weight - a.points));
    const weaknesses = weakParts.map(p => ADVICE[p.key]?.bad).filter(Boolean);
    const actions = weakParts.slice(0, 3).map(p => {
      const a = ADVICE[p.key];
      return a ? a.act(Number(p.benchmark), Number(p.value)) : null;
    }).filter(Boolean);

    return {
      ...e,
      score,
      band:     band ? band.label : null,
      band_key: band ? band.key   : null,
      weight_applied: applicable,
      parts,
      strengths: strengths.length ? strengths : ['قاعدة عملاء قابلة للبناء والتحسين'],
      weaknesses: weaknesses.length ? weaknesses : ['لا توجد فجوة جوهرية عن الأهداف'],
      actions: actions.length ? actions
        : ['تثبيت الأداء ومتابعة السعر والكمية والزيارات أسبوعياً مقابل المستهدف'],
      points_lost: +rated.reduce((s, p) => s + (p.weight - p.points), 0).toFixed(1),
    };
  });

  scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  scored.forEach((e, i) => { e.rank = e.score == null ? null : i + 1; });
  return { scored, benchmarks };
}

/* ── Region ⇄ branch translation ──────────────────────────── */
async function resolveRegionBranch(regionIds) {
  if (!regionIds || !regionIds.length) return null;
  const r = await pool.query('SELECT name_ar, name_en FROM regions WHERE id = ANY($1::int[])', [regionIds]);
  if (!r.rows.length) return null;
  const names = r.rows.flatMap(x => [x.name_ar, x.name_en]).filter(Boolean);
  return names.length ? names : null;
}

async function branchToRegionIds(branch) {
  if (!branch) return null;
  const vals = Array.isArray(branch) ? branch : [branch];
  const r = await pool.query(
    'SELECT id FROM regions WHERE name_en = ANY($1::text[]) OR name_ar = ANY($1::text[])',
    [vals]
  );
  return r.rows.length ? r.rows.map(x => x.id) : null;
}

/* ── Working days (skip Friday + named holidays) — same calculator as
   summary.js / performanceDashboard.js so every page agrees. ── */
const HOLIDAYS = [
  { year: 2026, month: 5, days: [27, 28, 29] }, // عيد الأضحى 1447هـ
];
function isHoliday(y, m, d) {
  return HOLIDAYS.some(h => h.year === y && h.month === m && h.days.includes(d));
}
function workingDays(year, month) {
  const today   = new Date();
  const isCur   = today.getFullYear() === year && today.getMonth() + 1 === month;
  const lastDay = isCur ? today.getDate() : new Date(year, month, 0).getDate();
  let n = 0;
  for (let d = 1; d <= lastDay; d++) {
    if (new Date(year, month - 1, d).getDay() !== 5 && !isHoliday(year, month, d)) n++;
  }
  return Math.max(n, 1);
}

/* ── Least-squares slope/intercept over (index, value) points — powers the
   trend-based forecast baseline. Returns null for <2 usable points. ── */
function linearTrend(values) {
  const pts = values.map((v, i) => [i, Number(v) || 0]).filter(p => Number.isFinite(p[1]));
  const n = pts.length;
  if (n < 2) return null;
  const sumX = pts.reduce((s, p) => s + p[0], 0);
  const sumY = pts.reduce((s, p) => s + p[1], 0);
  const sumXY = pts.reduce((s, p) => s + p[0] * p[1], 0);
  const sumXX = pts.reduce((s, p) => s + p[0] * p[0], 0);
  const denom = n * sumXX - sumX * sumX;
  if (!denom) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  return {
    slope:  +slope.toFixed(2),
    intercept: +intercept.toFixed(2),
    // Average month-over-month growth implied by the fitted line, as a %
    // of the mean — a stabler growth input than raw first/last comparison.
    slope_pct: meanY > 0 ? +((slope / meanY) * 100).toFixed(2) : null,
  };
}

/* ════════════════════════════════════════════════════════════
   GET /api/region-performance/filters
════════════════════════════════════════════════════════════ */
router.get('/filters', verifyToken, applyRegionFilter, async (req, res) => {
  try {
    const allowed = (req.regionFilter && req.regionFilter.length)
      ? await resolveRegionBranch(req.regionFilter) : null;
    const params = [];
    let branchSql = '';
    if (allowed) { params.push(allowed); branchSql = `AND TRIM(branch_name) = ANY($1::text[])`; }

    const [brRes, yrRes, catRes, itemCatRes] = await Promise.all([
      // Union with the regions table (not just sales_activity) so a
      // brand-new region (e.g. Jeddah) is selectable immediately, before
      // its first sales_activity upload ever lands.
      pool.query(`
        SELECT branch_name FROM (
          SELECT DISTINCT TRIM(branch_name) AS branch_name
          FROM sales_activity
          WHERE branch_name IS NOT NULL AND TRIM(branch_name) <> '' ${branchSql}
          UNION
          SELECT DISTINCT name_en AS branch_name FROM regions
          WHERE name_en IS NOT NULL AND TRIM(name_en) <> '' AND fleet_only = false ${allowed ? 'AND name_en = ANY($1::text[])' : ''}
        ) b
        ORDER BY 1`, params),
      pool.query(`SELECT DISTINCT report_year::int AS y FROM sales_activity ORDER BY y DESC`),
      pool.query(`
        SELECT DISTINCT TRIM(category_name) AS c
        FROM sales_activity
        WHERE category_name IS NOT NULL AND TRIM(category_name) <> ''
        ORDER BY 1`),
      // Item categories, biggest first — the include/exclude toggles are shown
      // in this order so the ones that actually move the numbers come first.
      pool.query(`
        SELECT TRIM(item_category_en) AS c, COALESCE(SUM(qty),0)::bigint AS qty
        FROM sales_activity
        WHERE item_category_en IS NOT NULL AND TRIM(item_category_en) <> ''
        GROUP BY 1 ORDER BY qty DESC`),
    ]);

    res.json({
      branches:   brRes.rows.map(r => r.branch_name),
      years:      yrRes.rows.map(r => r.y),
      categories: catRes.rows.map(r => r.c),
      item_categories: itemCatRes.rows.map(r => ({ name: r.c, qty: Number(r.qty) })),
      visit_target: { min: VISIT_TARGET_MIN, max: VISIT_TARGET_MAX },
    });
  } catch (err) {
    console.error('[RegionPerformance] filters:', err);
    res.status(500).json({ error: 'خطأ في جلب قوائم الفلترة' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /api/region-performance/assessment
   ?branch=&year=2026&from_month=1&to_month=6&cust_category=
════════════════════════════════════════════════════════════ */
/* Customer-category (sales-channel) scope.
   Accepts a REPEATED `cust_category` key so the caller can keep several channels
   at once, or drop one and keep the rest — the two things a single-value select
   could not express. A lone value still works unchanged, so old links and any
   caller that never learned about the list keep behaving exactly as before.
   Returns a lower-cased array (or null for "الكل"), because every comparison
   site below matches case-insensitively on the trimmed name. */
/* Day precision on top of the month range.

   Expressed as "drop what falls before from_day in the FIRST month and after
   to_day in the LAST month" rather than a BETWEEN on a built date, for two
   reasons: the month grouping every query below depends on stays untouched, and
   a from/to day that does not exist in that month (31 in a 30-day month, 29 in
   February) can never raise a date-construction error — it simply clamps to
   nothing extra. With 1 → 31 the fragment is empty, so an unclamped request
   produces byte-identical SQL to the version before days existed.

   The numbers are interpolated, not bound: both have already been through
   parseInt + a 1..31 clamp at the top of the route, so they cannot carry
   anything but an integer. */
function dayClampSql(fromMonth, toMonth, fromDay, toDay, monthExpr, dayExpr) {
  let sql = '';
  if (fromDay > 1)  sql += ` AND NOT (${monthExpr} = ${fromMonth} AND ${dayExpr} < ${fromDay})`;
  if (toDay   < 31) sql += ` AND NOT (${monthExpr} = ${toMonth} AND ${dayExpr} > ${toDay})`;
  return sql;
}

function custCatScope(query) {
  let v = query.cust_category;
  if (v == null) return null;
  if (!Array.isArray(v)) v = [v];
  const out = [...new Set(v.map(x => String(x).trim().toLowerCase()).filter(Boolean))];
  return out.length ? out : null;
}

router.get('/assessment', verifyToken, applyRegionFilter, async (req, res) => {
  const year      = parseInt(req.query.year) || new Date().getFullYear();
  const fromMonth = Math.max(1,  parseInt(req.query.from_month) || 1);
  const toMonth   = Math.min(12, parseInt(req.query.to_month)   || 6);
  const custCat   = custCatScope(req.query);
  /* Optional day bounds inside the first / last selected month. Absent, or
     1 → 31, means whole months and changes nothing. */
  const fromDay   = Math.min(31, Math.max(1, parseInt(req.query.from_day) || 1));
  const toDay     = Math.min(31, Math.max(1, parseInt(req.query.to_day)   || 31));

  if (toMonth < fromMonth) return res.status(400).json({ error: 'نطاق الأشهر غير صحيح' });
  if (fromMonth === toMonth && toDay < fromDay) {
    return res.status(400).json({ error: 'نطاق الأيام غير صحيح' });
  }

  try {
    /* RBAC overrides any client-supplied branch. */
    let branch = req.query.branch || null;
    if (req.regionFilter && req.regionFilter.length) {
      branch = await resolveRegionBranch(req.regionFilter);
    }
    const regionIds = branch ? await branchToRegionIds(branch) : null;

    const months = [];
    for (let m = fromMonth; m <= toMonth; m++) months.push(m);

    /* ── sales_activity filter fragments ─────────────────────
       $1 = year, $2 = months[]; branch / category appended after. */
    const saParams = [year, months];
    let p = 3;
    let branchSql = '';
    if (branch) {
      saParams.push(Array.isArray(branch) ? branch : [branch]);
      branchSql = ` AND TRIM(sa.branch_name) = ANY($${p++}::text[])`;
    }
    let catSql = '';
    if (custCat) {
      saParams.push(custCat);
      catSql = ` AND LOWER(TRIM(COALESCE(sa.category_name,''))) = ANY($${p++}::text[])`;
    }
    /* Item-category scope. Sent as a repeated `item_category` key listing the
       categories to KEEP, so an unfiltered request stays byte-identical to
       before and nothing changes for callers that don't use it. */
    let itemCats = req.query.item_category || null;
    if (itemCats && !Array.isArray(itemCats)) itemCats = [itemCats];
    let itemCatSql = '';
    if (itemCats && itemCats.length) {
      saParams.push(itemCats);
      itemCatSql = ` AND TRIM(COALESCE(sa.item_category_en,'')) = ANY($${p++}::text[])`;
    }
    /* Same clamp, expressed once per table shape. sales_activity carries its
       own month/day columns; invoices, payments and quality issues carry a real
       date, so the month and day are taken from it. */
    const saDayClamp  = dayClampSql(fromMonth, toMonth, fromDay, toDay, 'sa.month_num', 'sa.day');
    const invDayClamp = dayClampSql(fromMonth, toMonth, fromDay, toDay,
                                    'EXTRACT(MONTH FROM i.invoice_date)', 'EXTRACT(DAY FROM i.invoice_date)');
    const payDayClamp = dayClampSql(fromMonth, toMonth, fromDay, toDay,
                                    'EXTRACT(MONTH FROM p.tran_date)', 'EXTRACT(DAY FROM p.tran_date)');
    const qiDayClamp  = dayClampSql(fromMonth, toMonth, fromDay, toDay,
                                    'EXTRACT(MONTH FROM qi.issue_date)', 'EXTRACT(DAY FROM qi.issue_date)');

    const saWhere = `sa.report_year = $1 AND sa.month_num = ANY($2::int[])${branchSql}${catSql}${itemCatSql}${saDayClamp}`;

    /* ── Full-year (Jan–Dec) filter, same branch/category scope, used only
       by the H1-vs-current-vs-H2 category comparison below — independent
       of the from/to month sliders since "أول 6 أشهر من العام" means the
       calendar half, not whatever range happens to be selected. */
    const fullYearMonths = Array.from({ length: 12 }, (_, i) => i + 1);
    const fyParams = [year, fullYearMonths];
    let fyP = 3;
    let fyBranchSql = '';
    if (branch) {
      fyParams.push(Array.isArray(branch) ? branch : [branch]);
      fyBranchSql = ` AND TRIM(sa.branch_name) = ANY($${fyP++}::text[])`;
    }
    let fyCatSql = '';
    if (custCat) {
      fyParams.push(custCat);
      fyCatSql = ` AND LOWER(TRIM(COALESCE(sa.category_name,''))) = ANY($${fyP++}::text[])`;
    }
    if (itemCats && itemCats.length) {
      fyParams.push(itemCats);
      fyCatSql += ` AND TRIM(COALESCE(sa.item_category_en,'')) = ANY($${fyP++}::text[])`;
    }
    const fyWhere = `sa.report_year = $1 AND sa.month_num = ANY($2::int[])${fyBranchSql}${fyCatSql}`;

    /* ── Churn definitions — kept identical to تقرير العملاء
       (salesActivity.js `/region-stats`), which is the reference for these
       numbers across the app:
         • جديد   = the customer's FIRST month in this report_year, and it has
                    no invoice in any earlier year          → truly new
         • عائد   = same first month this year, but it DOES have invoices from
                    an earlier year                         → returning
         • مفقود  = traded last month, did not trade this month
       The earlier rule here was "not present in the previous month", which
       counted a customer that merely skipped a month as new — that is why
       August read 40 instead of 8. جديد/عائد therefore look at the whole year
       up to that month, NOT just the month before, and NOT just the selected
       range. Only مفقود still needs a previous-month baseline. */
    const scopeSql = alias => {
      let s = '', k = 2;
      if (branch)  s += ` AND TRIM(${alias}.branch_name) = ANY($${k++}::text[])`;
      if (custCat) s += ` AND LOWER(TRIM(COALESCE(${alias}.category_name,''))) = ANY($${k++}::text[])`;
      return s;
    };
    const newParams = [year];
    if (branch)  newParams.push(Array.isArray(branch) ? branch : [branch]);
    if (custCat) newParams.push(custCat);

    const firstSeenCte = `
      WITH first_seen AS (
        SELECT sa.customer_code, MIN(sa.month_num)::int AS first_month
        FROM sales_activity sa
        WHERE sa.report_year = $1${scopeSql('sa')}
        GROUP BY 1
      )`;
    const priorYearJoin = `
      LEFT JOIN LATERAL (
        SELECT i.customer_id FROM invoices i
        WHERE i.customer_id = fs.customer_code AND i.year < $1 LIMIT 1
      ) prev ON true`;

    const newOverallQ = pool.query(`
      ${firstSeenCte}
      SELECT fs.first_month AS month_num,
             COUNT(*)::int                                             AS new_total,
             COUNT(*) FILTER (WHERE prev.customer_id IS NOT NULL)::int AS returning_cnt,
             COUNT(*) FILTER (WHERE prev.customer_id IS NULL)::int     AS truly_new_cnt
      FROM first_seen fs${priorYearJoin}
      GROUP BY 1
    `, newParams);

    /* Same set, attributed to the branch(es) the customer traded in during
       that first month — matching how /region-stats splits its new customers
       by region (the "first appearance" test itself stays global). */
    const newByRegionQ = pool.query(`
      ${firstSeenCte}
      SELECT fs.first_month AS month_num,
             COALESCE(NULLIF(TRIM(sa2.branch_name),''),'غير محدد') AS branch,
             COUNT(DISTINCT sa2.customer_code)::int AS new_total,
             COUNT(DISTINCT sa2.customer_code) FILTER (WHERE prev.customer_id IS NOT NULL)::int AS returning_cnt,
             COUNT(DISTINCT sa2.customer_code) FILTER (WHERE prev.customer_id IS NULL)::int     AS truly_new_cnt
      FROM first_seen fs
      JOIN sales_activity sa2
        ON sa2.customer_code = fs.customer_code
       AND sa2.report_year = $1
       AND sa2.month_num = fs.first_month${scopeSql('sa2')}
      ${priorYearJoin}
      GROUP BY 1,2
    `, newParams);

    /* Baseline for مفقودون only: the month immediately BEFORE the selected
       range, so the first row of a single-month range still has a comparison
       point. Crosses the year boundary for January. */
    const baseMonth = fromMonth === 1 ? 12 : fromMonth - 1;
    const baseYear  = fromMonth === 1 ? year - 1 : year;
    const baseParams = [baseYear, baseMonth];
    let bp = 3;
    let baseBranchSql = '';
    if (branch) {
      baseParams.push(Array.isArray(branch) ? branch : [branch]);
      baseBranchSql = ` AND TRIM(sa.branch_name) = ANY($${bp++}::text[])`;
    }
    let baseCatSql = '';
    if (custCat) {
      baseParams.push(custCat);
      baseCatSql = ` AND LOWER(TRIM(COALESCE(sa.category_name,''))) = ANY($${bp++}::text[])`;
    }
    if (itemCats && itemCats.length) {
      baseParams.push(itemCats);
      baseCatSql += ` AND TRIM(COALESCE(sa.item_category_en,'')) = ANY($${bp++}::text[])`;
    }
    const baseCodesQ = pool.query(`
      SELECT COALESCE(NULLIF(TRIM(sa.branch_name),''),'غير محدد') AS branch, sa.customer_code
      FROM sales_activity sa
      WHERE sa.report_year = $1 AND sa.month_num = $2${baseBranchSql}${baseCatSql}
      GROUP BY 1,2
    `, baseParams);

    /* Same baseline month's qty/revenue — lets the FIRST row of the range show
       a real "ASP الشهر السابق" instead of "—" even though that month sits
       outside the selected range. */
    const baseSalesQ = pool.query(`
      SELECT COALESCE(NULLIF(TRIM(sa.branch_name),''),'غير محدد') AS branch,
             COALESCE(SUM(sa.qty),0)::bigint          AS qty,
             COALESCE(SUM(sa.net_revenue),0)::numeric AS revenue
      FROM sales_activity sa
      WHERE sa.report_year = $1 AND sa.month_num = $2${baseBranchSql}${baseCatSql}
      GROUP BY 1
    `, baseParams);

    /* ── 1. Monthly sales / damages / customers ──────────────── */
    const monthlySalesQ = pool.query(`
      SELECT sa.month_num::int                            AS month_num,
             COALESCE(SUM(sa.qty),0)::bigint              AS qty,
             ${QTY_KG_SQL}                                AS qty_kg,
             COUNT(DISTINCT sa.invoice_number)::int       AS invoices,
             COALESCE(SUM(sa.net_revenue),0)::numeric     AS revenue,
             COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS damages,
             COUNT(DISTINCT sa.customer_code)::int        AS active_customers,
             COUNT(DISTINCT sa.salesrep_name)::int        AS active_reps,
             COUNT(*)::int                                AS invoice_lines
      FROM sales_activity sa
      WHERE ${saWhere}
      GROUP BY sa.month_num ORDER BY sa.month_num
    `, saParams);

    /* Inactive = net qty <= 0 for the month (app-wide rule). */
    const monthlyInactiveQ = pool.query(`
      SELECT month_num, COUNT(*)::int AS inactive_customers FROM (
        SELECT sa.month_num::int AS month_num, sa.customer_code, SUM(sa.qty) AS net_qty
        FROM sales_activity sa WHERE ${saWhere}
        GROUP BY sa.month_num, sa.customer_code
      ) c WHERE net_qty <= 0 GROUP BY month_num
    `, saParams);

    /* Visits = distinct (rep, customer, day); active_days = distinct days
       the rep actually recorded activity — the honest denominator for
       visits/day (an absent day shouldn't dilute daily productivity). */
    const monthlyVisitsQ = pool.query(`
      SELECT month_num,
             COUNT(*)::int                                   AS visits,
             COUNT(DISTINCT (salesrep_name, day))::int       AS rep_days,
             COUNT(DISTINCT day)::int                        AS calendar_days
      FROM (
        SELECT DISTINCT sa.month_num::int AS month_num, TRIM(sa.salesrep_name) AS salesrep_name,
               sa.customer_code, sa.day
        FROM sales_activity sa
        WHERE ${saWhere} AND sa.day IS NOT NULL
          AND sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) <> ''
      ) v GROUP BY month_num
    `, saParams);

    /* ── 2. Customer-category / item breakdowns ──────────────── */
    const byCustCatQ = pool.query(`
      SELECT COALESCE(NULLIF(TRIM(sa.category_name),''),'غير محدد') AS name,
             COALESCE(SUM(sa.qty),0)::bigint            AS qty,
             COALESCE(SUM(sa.net_revenue),0)::numeric   AS revenue,
             COALESCE(SUM(sa.bad_return_qty),0)::bigint AS damages,
             COUNT(DISTINCT sa.customer_code)::int      AS customers
      FROM sales_activity sa WHERE ${saWhere}
      GROUP BY 1 ORDER BY revenue DESC
    `, saParams);

    const byItemCatQ = pool.query(`
      SELECT COALESCE(NULLIF(TRIM(sa.item_category_en),''),'غير محدد') AS name,
             COALESCE(SUM(sa.qty),0)::bigint            AS qty,
             COALESCE(SUM(sa.net_revenue),0)::numeric   AS revenue,
             COALESCE(SUM(sa.bad_return_qty),0)::bigint AS damages
      FROM sales_activity sa WHERE ${saWhere}
      GROUP BY 1 ORDER BY revenue DESC
    `, saParams);

    /* Cross-region ASP benchmark per customer category — deliberately NOT
       branch-filtered. A category with very little volume in one region
       produces a misleading ASP (a handful of odd lines can swing it), so
       the planning model can pin such a category to the best price any
       region actually achieves instead of trusting the local figure.
       Regions below BENCHMARK_MIN_QTY units are ignored as noise; if none
       qualify, the caller falls back to the all-region blended ASP. */
    const benchParams = [year, months];
    const benchmarkQ = pool.query(`
      WITH per_branch AS (
        SELECT COALESCE(NULLIF(TRIM(sa.category_name),''),'غير محدد') AS name,
               COALESCE(NULLIF(TRIM(sa.branch_name),''),'غير محدد')   AS branch,
               SUM(sa.qty)::numeric         AS qty,
               SUM(sa.net_revenue)::numeric AS revenue
        FROM sales_activity sa
        WHERE sa.report_year = $1 AND sa.month_num = ANY($2::int[])${saDayClamp}
        GROUP BY 1,2
      ), scored AS (
        SELECT name, branch, qty, revenue, revenue / NULLIF(qty,0) AS asp
        FROM per_branch WHERE qty >= ${BENCHMARK_MIN_QTY}
      ), best AS (
        SELECT DISTINCT ON (name) name, branch, qty, asp
        FROM scored WHERE asp IS NOT NULL
        ORDER BY name, asp DESC
      ), overall AS (
        SELECT name, SUM(revenue) / NULLIF(SUM(qty),0) AS asp_all, SUM(qty) AS qty_all
        FROM per_branch GROUP BY 1
      )
      SELECT o.name,
             b.branch      AS best_branch,
             b.asp         AS best_asp,
             b.qty         AS best_qty,
             o.asp_all,
             o.qty_all
      FROM overall o LEFT JOIN best b ON b.name = o.name
    `, benchParams);

    const byItemQ = pool.query(`
      SELECT COALESCE(NULLIF(TRIM(sa.item_name_en),''),'غير محدد')     AS name,
             COALESCE(NULLIF(TRIM(sa.item_category_en),''),'غير محدد') AS category,
             COALESCE(SUM(sa.qty),0)::bigint            AS qty,
             COALESCE(SUM(sa.net_revenue),0)::numeric   AS revenue,
             COALESCE(SUM(sa.bad_return_qty),0)::bigint AS damages
      FROM sales_activity sa WHERE ${saWhere}
      GROUP BY 1,2 ORDER BY revenue DESC LIMIT 60
    `, saParams);

    /* Full calendar-year, per-month breakdown by category — powers the
       H1-avg / current-month / H2-avg comparison (independent of the
       from/to month filter, see fyWhere above). */
    const custCatMonthlyQ = pool.query(`
      SELECT COALESCE(NULLIF(TRIM(sa.category_name),''),'غير محدد') AS name,
             sa.month_num::int                          AS month_num,
             COALESCE(SUM(sa.qty),0)::bigint             AS qty,
             COALESCE(SUM(sa.net_revenue),0)::numeric    AS revenue
      FROM sales_activity sa WHERE ${fyWhere}
      GROUP BY 1,2
    `, fyParams);

    const itemCatMonthlyQ = pool.query(`
      SELECT COALESCE(NULLIF(TRIM(sa.item_category_en),''),'غير محدد') AS name,
             sa.month_num::int                          AS month_num,
             COALESCE(SUM(sa.qty),0)::bigint             AS qty,
             COALESCE(SUM(sa.net_revenue),0)::numeric    AS revenue
      FROM sales_activity sa WHERE ${fyWhere}
      GROUP BY 1,2
    `, fyParams);

    /* Region-wide (not category-filtered) monthly presence for the full
       year — determines which calendar months are "reported" so H1/H2
       averages skip not-yet-uploaded months instead of diluting with
       false zeros. */
    const fyReportedParams = [year, fullYearMonths];
    let fyReportedSql = '';
    if (branch) {
      fyReportedParams.push(Array.isArray(branch) ? branch : [branch]);
      fyReportedSql = ` AND TRIM(sa.branch_name) = ANY($3::text[])`;
    }
    const yearReportedQ = pool.query(`
      SELECT sa.month_num::int AS month_num, COUNT(*)::int AS invoice_lines
      FROM sales_activity sa
      WHERE sa.report_year = $1 AND sa.month_num = ANY($2::int[])${fyReportedSql}
      GROUP BY 1
    `, fyReportedParams);

    /* ── 3. Per-rep totals + monthly trend ───────────────────── */
    const byRepQ = pool.query(`
      SELECT TRIM(sa.salesrep_name)                       AS rep,
             COALESCE(MAX(TRIM(sa.branch_name)),'')       AS branch,
             COALESCE(SUM(sa.qty),0)::bigint              AS qty,
             ${QTY_KG_SQL}                                AS qty_kg,
             COALESCE(SUM(sa.net_revenue),0)::numeric     AS revenue,
             COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS damages,
             COUNT(DISTINCT sa.invoice_number)::int       AS invoices,
             COUNT(DISTINCT sa.customer_code)::int        AS customers
      FROM sales_activity sa
      WHERE ${saWhere} AND sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) <> ''
      GROUP BY 1 ORDER BY revenue DESC
    `, saParams);

    const repMonthlyQ = pool.query(`
      SELECT TRIM(sa.salesrep_name) AS rep, sa.month_num::int AS month_num,
             COALESCE(SUM(sa.qty),0)::bigint            AS qty,
             COALESCE(SUM(sa.net_revenue),0)::numeric   AS revenue,
             COUNT(DISTINCT sa.invoice_number)::int     AS invoices
      FROM sales_activity sa
      WHERE ${saWhere} AND sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) <> ''
      GROUP BY 1,2
    `, saParams);

    const repVisitsQ = pool.query(`
      SELECT rep,
             COUNT(*)::int                          AS visits,
             COUNT(DISTINCT (month_num, day))::int  AS active_days
      FROM (
        SELECT DISTINCT TRIM(sa.salesrep_name) AS rep, sa.month_num::int AS month_num,
               sa.customer_code, sa.day
        FROM sales_activity sa
        WHERE ${saWhere} AND sa.day IS NOT NULL
          AND sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) <> ''
      ) v GROUP BY rep
    `, saParams);

    /* ── 4. Invoices (monthly invoiced + debt ratio) ─────────── */
    const invParams = [year, months];
    let invRegionSql = '';
    if (regionIds) { invParams.push(regionIds); invRegionSql = ` AND i.region_id = ANY($3::int[])`; }
    const monthlyInvQ = pool.query(`
      SELECT EXTRACT(MONTH FROM i.invoice_date)::int      AS month_num,
             COUNT(*)::int                                AS invoices,
             COALESCE(SUM(i.original_amount),0)::numeric  AS invoiced,
             COALESCE(SUM(i.paid_amount),0)::numeric      AS paid,
             COALESCE(SUM(i.balance),0)::numeric          AS balance
      FROM invoices i
      WHERE i.year = $1 AND EXTRACT(MONTH FROM i.invoice_date) = ANY($2::int[])${invDayClamp}
        AND ${DIRECT_EXCLUDE}${invRegionSql}
      GROUP BY 1 ORDER BY 1
    `, invParams);

    /* Current debt = plain unconditional SUM(balance) across ALL periods
       (the app-wide confirmed rule), minus the 'direct' pseudo-rep. */
    const debtParams = [];
    let debtRegionSql = '';
    if (regionIds) { debtParams.push(regionIds); debtRegionSql = ` AND i.region_id = ANY($1::int[])`; }
    const currentDebtQ = pool.query(`
      SELECT COALESCE(SUM(i.balance),0)::numeric      AS current_debt,
             COUNT(DISTINCT i.customer_id)::int       AS registered_customers
      FROM invoices i WHERE ${DIRECT_EXCLUDE}${debtRegionSql}
    `, debtParams);

    /* ── 5. Monthly collections (payments) ───────────────────── */
    const payParams = [year, months];
    let paySql = '';
    if (regionIds) {
      payParams.push(regionIds);
      paySql = ` AND p.customer_code IN (
        SELECT DISTINCT i.customer_id FROM invoices i WHERE i.region_id = ANY($3::int[])
      )`;
    }
    const monthlyPayQ = pool.query(`
      SELECT EXTRACT(MONTH FROM p.tran_date)::int      AS month_num,
             COALESCE(SUM(p.total_paid),0)::numeric    AS collected,
             COUNT(*)::int                             AS tx_count
      FROM payments p
      WHERE EXTRACT(YEAR FROM p.tran_date) = $1
        AND EXTRACT(MONTH FROM p.tran_date) = ANY($2::int[])${payDayClamp}${paySql}
      GROUP BY 1 ORDER BY 1
    `, payParams);

    /* ── 6. Capacity now: active reps + routes on the books ──── */
    const capParams = [];
    let capSql = '';
    if (regionIds) { capParams.push(regionIds); capSql = ` AND sr.region_id = ANY($1::int[])`; }
    const capacityQ = pool.query(`
      SELECT COUNT(DISTINCT sr.id)::int       AS reps_on_books,
             COUNT(DISTINCT sr.route_id)::int AS routes_on_books
      FROM sales_reps sr WHERE sr.is_active${capSql}
    `, capParams);

    /* Quality-issues (توالف الجودة) cost per month — the uploaded
       "Quality Issues Quantity and Cost" report, distinct from
       sales_activity.bad_return_qty ("توالف %" a few columns over). */
    const qiParams = [year, months];
    let qiRegionSql = '';
    if (regionIds) { qiParams.push(regionIds); qiRegionSql = ` AND qi.region_id = ANY($3::int[])`; }
    const qiQ = pool.query(`
      SELECT EXTRACT(MONTH FROM qi.issue_date)::int AS month_num,
             COUNT(*)::int                                AS issue_count,
             COALESCE(SUM(ABS(qi.quantity)),0)::numeric    AS qty,
             COALESCE(SUM(ABS(qi.total_cost)),0)::numeric  AS cost
      FROM quality_issues qi
      WHERE EXTRACT(YEAR FROM qi.issue_date) = $1
        AND EXTRACT(MONTH FROM qi.issue_date) = ANY($2::int[])${qiDayClamp}${qiRegionSql}
      GROUP BY 1
    `, qiParams);

    /* ── 7. Every monthly metric again, grouped by region ─────
       Powers the per-region detail rows under each month. Same WHERE
       clauses as the overall series with the branch added to GROUP BY, so
       the region rows always foot back to the month row above them. */
    const REG_KEY = `COALESCE(NULLIF(TRIM(sa.branch_name),''),'غير محدد')`;

    const regSalesQ = pool.query(`
      SELECT ${REG_KEY} AS branch, sa.month_num::int AS month_num,
             COALESCE(SUM(sa.qty),0)::bigint              AS qty,
             ${QTY_KG_SQL}                                AS qty_kg,
             COUNT(DISTINCT sa.invoice_number)::int       AS invoices,
             COALESCE(SUM(sa.net_revenue),0)::numeric     AS revenue,
             COALESCE(SUM(sa.bad_return_qty),0)::bigint   AS damages,
             COUNT(DISTINCT sa.customer_code)::int        AS active_customers,
             COUNT(DISTINCT sa.salesrep_name)::int        AS active_reps,
             COUNT(*)::int                                AS invoice_lines
      FROM sales_activity sa WHERE ${saWhere}
      GROUP BY 1,2
    `, saParams);

    const regInactiveQ = pool.query(`
      SELECT branch, month_num, COUNT(*)::int AS inactive_customers FROM (
        SELECT ${REG_KEY} AS branch, sa.month_num::int AS month_num,
               sa.customer_code, SUM(sa.qty) AS net_qty
        FROM sales_activity sa WHERE ${saWhere}
        GROUP BY 1,2,3
      ) c WHERE net_qty <= 0 GROUP BY 1,2
    `, saParams);

    const regVisitsQ = pool.query(`
      SELECT branch, month_num,
             COUNT(*)::int                             AS visits,
             COUNT(DISTINCT (salesrep_name, day))::int AS rep_days
      FROM (
        SELECT DISTINCT ${REG_KEY} AS branch, sa.month_num::int AS month_num,
               TRIM(sa.salesrep_name) AS salesrep_name, sa.customer_code, sa.day
        FROM sales_activity sa
        WHERE ${saWhere} AND sa.day IS NOT NULL
          AND sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) <> ''
      ) v GROUP BY 1,2
    `, saParams);

    const regCodesQ = pool.query(`
      SELECT ${REG_KEY} AS branch, sa.month_num::int AS month_num, sa.customer_code
      FROM sales_activity sa WHERE ${saWhere}
      GROUP BY 1,2,3
    `, saParams);

    const regInvQ = pool.query(`
      SELECT i.region_id, EXTRACT(MONTH FROM i.invoice_date)::int AS month_num,
             COALESCE(SUM(i.original_amount),0)::numeric AS invoiced,
             COALESCE(SUM(i.balance),0)::numeric         AS balance
      FROM invoices i
      WHERE i.year = $1 AND EXTRACT(MONTH FROM i.invoice_date) = ANY($2::int[])${invDayClamp}
        AND ${DIRECT_EXCLUDE}${invRegionSql}
      GROUP BY 1,2
    `, invParams);

    /* A customer can hold invoices in more than one region; charging its
       payments to every one of them would inflate the column. Each customer
       is therefore booked to the region holding most of its invoices. */
    const regPayQ = pool.query(`
      WITH cust_region AS (
        SELECT DISTINCT ON (i.customer_id) i.customer_id, i.region_id
        FROM invoices i WHERE i.region_id IS NOT NULL
        GROUP BY i.customer_id, i.region_id
        ORDER BY i.customer_id, COUNT(*) DESC
      )
      SELECT cr.region_id, EXTRACT(MONTH FROM p.tran_date)::int AS month_num,
             COALESCE(SUM(p.total_paid),0)::numeric AS collected
      FROM payments p
      JOIN cust_region cr ON cr.customer_id = p.customer_code
      WHERE EXTRACT(YEAR FROM p.tran_date) = $1
        AND EXTRACT(MONTH FROM p.tran_date) = ANY($2::int[])${payDayClamp}
        ${regionIds ? 'AND cr.region_id = ANY($3::int[])' : ''}
      GROUP BY 1,2
    `, payParams);

    const regQiQ = pool.query(`
      SELECT qi.region_id, EXTRACT(MONTH FROM qi.issue_date)::int AS month_num,
             COUNT(*)::int                                AS issue_count,
             COALESCE(SUM(ABS(qi.quantity)),0)::numeric   AS qty,
             COALESCE(SUM(ABS(qi.total_cost)),0)::numeric AS cost
      FROM quality_issues qi
      WHERE EXTRACT(YEAR FROM qi.issue_date) = $1
        AND EXTRACT(MONTH FROM qi.issue_date) = ANY($2::int[])${qiDayClamp}${qiRegionSql}
      GROUP BY 1,2
    `, qiParams);

    const regionsQ = pool.query('SELECT id, name_ar, name_en FROM regions WHERE fleet_only = false');

    const [
      salesRes, inactiveRes, visitsRes,
      custCatRes, itemCatRes, itemRes,
      repRes, repMonthlyRes, repVisitsRes,
      invRes, debtRes, payRes, capRes,
      custCatMonthlyRes, itemCatMonthlyRes, yearReportedRes,
      qiRes, benchmarkRes,
      regSalesRes, regInactiveRes, regVisitsRes, regCodesRes,
      regInvRes, regPayRes, regQiRes, regionsRes,
      baseCodesRes, newOverallRes, newByRegionRes, baseSalesRes,
    ] = await Promise.all([
      monthlySalesQ, monthlyInactiveQ, monthlyVisitsQ,
      byCustCatQ, byItemCatQ, byItemQ,
      byRepQ, repMonthlyQ, repVisitsQ,
      monthlyInvQ, currentDebtQ, monthlyPayQ, capacityQ,
      custCatMonthlyQ, itemCatMonthlyQ, yearReportedQ,
      qiQ, benchmarkQ,
      regSalesQ, regInactiveQ, regVisitsQ, regCodesQ,
      regInvQ, regPayQ, regQiQ, regionsQ,
      baseCodesQ, newOverallQ, newByRegionQ, baseSalesQ,
    ]);

    /* Baseline-month ASP, overall and per branch — the comparison point for
       the first row of the range. */
    const aspOf = (qty, rev) => {
      const q = Number(qty || 0), v = Number(rev || 0);
      return q > 0 ? v / q : null;
    };
    const baseAspByBranch = new Map();
    let baseQtySum = 0, baseRevSum = 0;
    baseSalesRes.rows.forEach(r => {
      baseQtySum += Number(r.qty || 0);
      baseRevSum += Number(r.revenue || 0);
      baseAspByBranch.set(String(r.branch).trim().toLowerCase(), aspOf(r.qty, r.revenue));
    });
    const baseAspOverall = aspOf(baseQtySum, baseRevSum);

    /* Customer sets for the month before the range — the churn baseline.
       If that month has no rows at all it was simply never uploaded; using an
       empty set would then report every customer as "new", so we fall back to
       null (renders "—") instead of inventing a churn number. */
    const baseCodesAll = new Set();
    const baseCodesByBranch = new Map();
    baseCodesRes.rows.forEach(r => {
      baseCodesAll.add(r.customer_code);
      const k = String(r.branch).trim().toLowerCase();
      if (!baseCodesByBranch.has(k)) baseCodesByBranch.set(k, new Set());
      baseCodesByBranch.get(k).add(r.customer_code);
    });
    const hasBaseline = baseCodesAll.size > 0;

    /* ── Assemble the monthly series ─────────────────────────── */
    const idx = (rows, key = 'month_num') => Object.fromEntries(rows.map(r => [Number(r[key]), r]));
    const sMap = idx(salesRes.rows), iaMap = idx(inactiveRes.rows), vMap = idx(visitsRes.rows);
    const invMap = idx(invRes.rows), payMap = idx(payRes.rows);
    const qiMap  = idx(qiRes.rows);

    /* Customer sets per month → new / lost (churn) */
    const codesQ = await pool.query(`
      SELECT sa.month_num::int AS month_num, sa.customer_code
      FROM sales_activity sa WHERE ${saWhere}
      GROUP BY 1,2
    `, saParams);
    const codesByMonth = {};
    codesQ.rows.forEach(r => {
      const m = Number(r.month_num);
      (codesByMonth[m] = codesByMonth[m] || new Set()).add(r.customer_code);
    });

    /* One builder for BOTH the overall series and the per-region breakdown, so
       a metric can never drift between the month row and its region rows. */
    function buildMonthRow({ m, s = {}, ia = {}, v = {}, inv = {}, pay = {}, qi = {}, cur, prev, nw }) {
      const qty      = Number(s.qty || 0);
      const revenue  = Number(s.revenue || 0);
      const damages  = Number(s.damages || 0);
      const visits   = Number(v.visits || 0);
      const repDays  = Number(v.rep_days || 0);
      const reps     = Number(s.active_reps || 0);
      const invoiced = Number(inv.invoiced || 0);
      const balance  = Number(inv.balance || 0);
      const collected= Number(pay.collected || 0);
      const wd       = workingDays(year, m);

      // جديد / عائد come from the first-appearance-this-year query, so a month
      // with sales but no first-timers is a real 0, not a missing "—".
      const hasSales = Number(s.invoice_lines || 0) > 0;
      const newCustomers  = hasSales ? Number(nw?.truly_new_cnt  || 0) : null;
      const returningCust = hasSales ? Number(nw?.returning_cnt  || 0) : null;
      const newTotal      = hasSales ? Number(nw?.new_total      || 0) : null;
      // مفقود still needs the previous month.
      const lostCustomers = prev && cur ? [...prev].filter(c => !cur.has(c)).length : null;

      return {
        month_num: m,
        month_name: MONTH_AR[m],
        working_days: wd,
        // A month with no invoice lines at all is "not reported yet", not
        // "sold zero" — trend regression, the forecast baseline and coverage
        // must skip it or a range ending in a future month reads as a crash.
        has_data: Number(s.invoice_lines || 0) > 0,
        qty, revenue,
        // Net kg: qty × the unit weight parsed from the item name ÷ 1000.
        qty_kg: +Number(s.qty_kg || 0).toFixed(1),
        // Distinct invoices (not lines) — the scorecard's productivity numerator.
        invoices_count: Number(s.invoices || 0),
        asp: qty > 0 ? +(revenue / qty).toFixed(2) : null,
        damages,
        damages_pct: qty > 0 ? +((damages / qty) * 100).toFixed(2) : null,
        active_customers:   Number(s.active_customers || 0),
        inactive_customers: Number(ia.inactive_customers || 0),
        new_customers:       newCustomers,   // جدد   — first ever, no prior-year invoices
        returning_customers: returningCust,  // عائدون — first month this year, but traded before
        new_total:           newTotal,       // جدد + عائدون
        lost_customers:      lostCustomers,
        active_reps: reps,
        visits,
        rep_days: repDays,
        // Visits per rep-day = the real daily field productivity.
        visits_per_day: repDays > 0 ? +(visits / repDays).toFixed(2) : null,
        // Same denominator for weight, so the two productivity indicators in the
        // scorecard can be read straight off this table.
        kg_per_rep_day: repDays > 0 ? +(Number(s.qty_kg || 0) / repDays).toFixed(1) : null,
        // Capacity-based view: what each rep achieved per official working day.
        visits_per_rep_per_wd: reps > 0 ? +(visits / (reps * wd)).toFixed(2) : null,
        revenue_per_visit:    visits > 0 ? +(revenue / visits).toFixed(2) : null,
        revenue_per_customer: Number(s.active_customers) > 0
          ? +(revenue / Number(s.active_customers)).toFixed(2) : null,
        qty_per_rep: reps > 0 ? Math.round(qty / reps) : null,
        invoiced,
        invoice_balance: balance,
        debt_ratio: invoiced > 0 ? +((balance / invoiced) * 100).toFixed(2) : null,
        collected,
        collection_pct: invoiced > 0 ? +((collected / invoiced) * 100).toFixed(2) : null,
        // توالف الجودة — from the uploaded Quality Issues report, NOT
        // derived from sales_activity like damages/damages_pct above.
        qi_issue_count: Number(qi.issue_count || 0),
        qi_qty:  Number(qi.qty  || 0),
        qi_cost: Number(qi.cost || 0),
      };
    }

    const newMap = idx(newOverallRes.rows);
    const newByBranch = new Map();
    newByRegionRes.rows.forEach(r =>
      newByBranch.set(`${String(r.branch).trim().toLowerCase()}|${Number(r.month_num)}`, r));

    const monthly = months.map((m, i) => {
      const prevM = months[i - 1];
      return buildMonthRow({
        m, nw: newMap[m],
        s: sMap[m], ia: iaMap[m], v: vMap[m], inv: invMap[m], pay: payMap[m], qi: qiMap[m],
        cur:  codesByMonth[m] || new Set(),
        prev: prevM ? (codesByMonth[prevM] || new Set())
                    : (hasBaseline ? baseCodesAll : null),
      });
    });

    /* ASP of the preceding month + the % change against it. Month m-1 is used
       even when it falls outside the selected range, so the first row is a
       real comparison rather than "—". */
    const withAspDelta = (row, prevAsp) => {
      row.prev_asp = prevAsp != null ? +Number(prevAsp).toFixed(2) : null;
      row.asp_delta_pct = (row.prev_asp > 0 && row.asp != null)
        ? +(((row.asp - row.prev_asp) / row.prev_asp) * 100).toFixed(2)
        : null;
      return row;
    };
    monthly.forEach((r, i) => withAspDelta(r, i > 0 ? monthly[i - 1].asp : baseAspOverall));

    /* ── Same rows, broken out per region ─────────────────────
       Sales-side data keys on sa.branch_name (English identifier); the
       invoice / payment / quality-issue tables key on region_id, so the two
       sides are stitched via the regions table (name_ar AND name_en are both
       tried — name_ar historically stores the English branch identifier). */
    const regionKeyToId = new Map();
    regionsRes.rows.forEach(r => {
      [r.name_ar, r.name_en].filter(Boolean)
        .forEach(n => regionKeyToId.set(String(n).trim().toLowerCase(), Number(r.id)));
    });
    const ridOf = br => regionKeyToId.get(String(br || '').trim().toLowerCase()) ?? null;

    const byBM = (rows, keyFn) => {
      const map = new Map();
      rows.forEach(r => map.set(keyFn(r), r));
      return map;
    };
    const bk = (b, m) => `${String(b).trim().toLowerCase()}|${Number(m)}`;
    const rk = (id, m) => `${id == null ? '' : Number(id)}|${Number(m)}`;

    const rSales    = byBM(regSalesRes.rows,    r => bk(r.branch, r.month_num));
    const rInactive = byBM(regInactiveRes.rows, r => bk(r.branch, r.month_num));
    const rVisits   = byBM(regVisitsRes.rows,   r => bk(r.branch, r.month_num));
    const rInv      = byBM(regInvRes.rows,      r => rk(r.region_id, r.month_num));
    const rPay      = byBM(regPayRes.rows,      r => rk(r.region_id, r.month_num));
    const rQi       = byBM(regQiRes.rows,       r => rk(r.region_id, r.month_num));

    const rCodes = new Map();   // "branch|month" → Set(customer_code)
    regCodesRes.rows.forEach(r => {
      const k = bk(r.branch, r.month_num);
      if (!rCodes.has(k)) rCodes.set(k, new Set());
      rCodes.get(k).add(r.customer_code);
    });

    // Only regions that actually reported sales in the window get rows.
    const regionBranches = [...new Set(regSalesRes.rows.map(r => String(r.branch).trim()))]
      .filter(Boolean).sort((a, b) => a.localeCompare(b, 'ar'));

    const monthly_by_region = [];
    regionBranches.forEach(branchName => {
      const rid = ridOf(branchName);
      months.forEach((m, i) => {
        const prevM = months[i - 1];
        const row = buildMonthRow({
          m,
          nw: newByBranch.get(bk(branchName, m)),
          s:  rSales.get(bk(branchName, m)),
          ia: rInactive.get(bk(branchName, m)),
          v:  rVisits.get(bk(branchName, m)),
          inv: rInv.get(rk(rid, m)),
          pay: rPay.get(rk(rid, m)),
          qi:  rQi.get(rk(rid, m)),
          cur:  rCodes.get(bk(branchName, m)) || new Set(),
          prev: prevM
            ? (rCodes.get(bk(branchName, prevM)) || new Set())
            : (hasBaseline
                ? (baseCodesByBranch.get(String(branchName).trim().toLowerCase()) || new Set())
                : null),
        });
        // Previous month is read from the raw map, not from the pushed array —
        // months with no data are skipped below, so the array is not contiguous.
        const prevAsp = prevM
          ? aspOf(rSales.get(bk(branchName, prevM))?.qty, rSales.get(bk(branchName, prevM))?.revenue)
          : (baseAspByBranch.get(String(branchName).trim().toLowerCase()) ?? null);
        withAspDelta(row, prevAsp);

        // A region with nothing at all in a month adds noise, not information.
        if (!row.has_data && !row.invoiced && !row.collected && !row.qi_cost) return;
        monthly_by_region.push({ ...row, branch: branchName, region_id: rid });
      });
    });

    /* ── Scorecard inputs ─────────────────────────────────────
       Momentum windows: the last 3 COMPLETE reported months vs the first 3.
       The running calendar month is excluded because it is only part-billed —
       including a month with 6 working days would read as a collapse. With a
       Jan–Aug range in August this resolves to May–Jul vs Jan–Mar, exactly the
       window on the methodology sheet, and it rolls forward on its own. */
    const nowD = new Date();
    const isCurYear  = Number(year) === nowD.getFullYear();
    const curMonthNo = nowD.getMonth() + 1;
    const reportedNums = monthly.filter(r => r.has_data).map(r => r.month_num);
    const completeNums = reportedNums.filter(m => !(isCurYear && m === curMonthNo));
    const lateWindow  = completeNums.slice(-3);
    const earlyWindow = reportedNums.slice(0, 3);
    // Overlapping windows would compare a period with itself.
    const momentumUsable = lateWindow.length > 0 && earlyWindow.length > 0
      && lateWindow[0] > earlyWindow[earlyWindow.length - 1];

    const momentumOf = (seriesByMonth, field) => {
      if (!momentumUsable) return null;
      const sumWin = win => win.reduce((s, m) => s + Number(seriesByMonth[m]?.[field] || 0), 0);
      const early = sumWin(earlyWindow);
      const late  = sumWin(lateWindow);
      return early > 0 ? late / early : null;
    };

    /* Regions — peer group is the whole company, so all regions share one median. */
    const regionAgg = new Map();
    monthly_by_region.forEach(r => {
      if (!regionAgg.has(r.branch)) {
        regionAgg.set(r.branch, { qty: 0, qty_kg: 0, revenue: 0, invoices: 0, visits: 0, rep_days: 0, byMonth: {} });
      }
      const a = regionAgg.get(r.branch);
      a.qty += Number(r.qty || 0);
      a.qty_kg += Number(r.qty_kg || 0);
      a.revenue += Number(r.revenue || 0);
      a.invoices += Number(r.invoices_count || 0);
      a.visits   += Number(r.visits || 0);
      a.rep_days += Number(r.rep_days || 0);
      a.byMonth[r.month_num] = { qty: Number(r.qty || 0), revenue: Number(r.revenue || 0),
                                 invoices: Number(r.invoices_count || 0) };
    });
    // Customers are distinct per region across the period, not a monthly sum.
    const regionCustomers = new Map();
    regCodesRes.rows.forEach(r => {
      const b = String(r.branch).trim();
      if (!regionCustomers.has(b)) regionCustomers.set(b, new Set());
      regionCustomers.get(b).add(r.customer_code);
    });
    const nRepMonths = Math.max(1, reportedNums.length);

    const regionEntities = [...regionAgg.entries()].map(([branchName, a]) => {
      const custs = regionCustomers.get(branchName)?.size || 0;
      return {
        key: branchName, peer: 'ALL', name: branchName,
        qty: Math.round(a.qty), qty_kg: +a.qty_kg.toFixed(1), revenue: Math.round(a.revenue),
        invoices: a.invoices, rep_days: a.rep_days, customers: custs,
        metrics: {
          asp:            a.qty > 0 ? a.revenue / a.qty : null,
          inv_per_repday: a.rep_days > 0 ? a.visits / a.rep_days : null,
          kg_per_repday:  a.rep_days > 0 ? a.qty_kg / a.rep_days : null,
          inv_per_cust:   custs > 0 ? a.invoices / custs / nRepMonths : null,
          avg_invoice:    a.invoices > 0 ? a.revenue / a.invoices : null,
          // Shortfall against the 13 invoices/rep/day target — never negative,
          // a region that beats the target simply has no gap.
          visit_gap:      a.rep_days > 0 ? Math.max(0, VISIT_TARGET_SCORE - a.visits / a.rep_days) : null,
          mom_revenue:    momentumOf(a.byMonth, 'revenue'),
          mom_qty:        momentumOf(a.byMonth, 'qty'),
          mom_invoices:   momentumOf(a.byMonth, 'invoices'),
        },
      };
    });
    const regionScore = scoreEntities(regionEntities);

    /* Reps — peer group is the rep's own region, per the methodology note. */
    const repVisitMap = Object.fromEntries(repVisitsRes.rows.map(r => [r.rep, r]));
    const repSeries = {};
    repMonthlyRes.rows.forEach(r => {
      (repSeries[r.rep] = repSeries[r.rep] || {})[Number(r.month_num)] =
        { qty: Number(r.qty || 0), revenue: Number(r.revenue || 0), invoices: Number(r.invoices || 0) };
    });
    const repEntities = repRes.rows.map(r => {
      const rv = repVisitMap[r.rep] || {};
      const repDays = Number(rv.active_days || 0);
      const repVisits = Number(rv.visits || 0);
      const qty = Number(r.qty || 0), rev = Number(r.revenue || 0);
      const kg = Number(r.qty_kg || 0), inv = Number(r.invoices || 0), cust = Number(r.customers || 0);
      return {
        key: r.rep, peer: r.branch || 'غير محدد', name: r.rep, branch: r.branch,
        qty: Math.round(qty), qty_kg: +kg.toFixed(1), revenue: Math.round(rev),
        invoices: inv, rep_days: repDays, customers: cust,
        metrics: {
          asp:            qty > 0 ? rev / qty : null,
          inv_per_repday: repDays > 0 ? repVisits / repDays : null,
          kg_per_repday:  repDays > 0 ? kg / repDays : null,
          inv_per_cust:   cust > 0 ? inv / cust / nRepMonths : null,
          avg_invoice:    inv > 0 ? rev / inv : null,
          visit_gap:      repDays > 0 ? Math.max(0, VISIT_TARGET_SCORE - repVisits / repDays) : null,
          mom_revenue:    momentumOf(repSeries[r.rep] || {}, 'revenue'),
          mom_qty:        momentumOf(repSeries[r.rep] || {}, 'qty'),
          mom_invoices:   momentumOf(repSeries[r.rep] || {}, 'invoices'),
        },
      };
    });
    const repScore = scoreEntities(repEntities);
    const repScoreByName = Object.fromEntries(repScore.scored.map(e => [e.key, e]));

    /* ── Period totals + averages ──────────────────────────────
       Averages and trends run over reported months only, so selecting a
       range that reaches into the future doesn't dilute every reading. */
    const reported = monthly.filter(r => r.has_data);
    const nReported = reported.length || 1;
    const sum = (k) => monthly.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const avgOf = (k) => {
      const vals = reported.map(r => r[k]).filter(v => v != null && Number.isFinite(Number(v)));
      return vals.length ? +(vals.reduce((s, v) => s + Number(v), 0) / vals.length).toFixed(2) : null;
    };

    const totalQty     = sum('qty');
    const totalRevenue = sum('revenue');
    const totalDamages = sum('damages');
    const totalVisits  = sum('visits');
    const totalRepDays = sum('rep_days');
    const totalInvoiced= sum('invoiced');
    const totalCollected = sum('collected');
    const cap = capRes.rows[0] || {};
    const debt = debtRes.rows[0] || {};

    // Peak active reps in the period = the capacity the region actually
    // fielded (a rep who worked only part of the period still counts).
    const peakReps = Math.max(0, ...monthly.map(r => r.active_reps));
    const avgVpd   = totalRepDays > 0 ? +(totalVisits / totalRepDays).toFixed(2) : null;

    /* Visit-gap opportunity — the headline planning lever: how much revenue
       the region leaves on the table by averaging below the target band.
       Priced at the period's actual revenue-per-visit. A region whose net
       revenue is zero or negative (returns only) has no meaningful
       per-visit value, so no opportunity is claimed rather than a
       nonsensical negative one. */
    const revPerVisit = totalVisits > 0 ? totalRevenue / totalVisits : 0;
    const avgRepDaysPerMonth = nReported ? totalRepDays / nReported : 0;
    function visitGap(targetVpd) {
      if (!avgVpd || avgVpd >= targetVpd || revPerVisit <= 0) {
        return { gap_vpd: 0, monthly_visits: 0, monthly_revenue: 0 };
      }
      const gapVpd = targetVpd - avgVpd;
      const extraVisits = gapVpd * avgRepDaysPerMonth;
      return {
        gap_vpd: +gapVpd.toFixed(2),
        monthly_visits: Math.round(extraVisits),
        monthly_revenue: Math.round(extraVisits * revPerVisit),
      };
    }

    /* ── H1-avg / current-month / H2-avg per category ────────────
       "أول 6 أشهر من العام" = calendar Jan–Jun, always — independent of
       the from/to filter. Only months the region has actually reported
       count toward either average (see yearReportedQ), so a partial H2
       (e.g. only July so far) still shows a fair per-month average. */
    const yearReportedMonths = new Set(
      yearReportedRes.rows.filter(r => Number(r.invoice_lines) > 0).map(r => Number(r.month_num))
    );
    const now = new Date();
    const currentMonthNum = (now.getFullYear() === year) ? (now.getMonth() + 1) : null;
    const h1Months = [1, 2, 3, 4, 5, 6].filter(m => yearReportedMonths.has(m));
    /* Previous month = the latest REPORTED month before the current one. Using
       currentMonthNum-1 blindly would show an empty column whenever a month was
       never uploaded. */
    const prevMonthNum = currentMonthNum
      ? ([...yearReportedMonths].filter(m => m < currentMonthNum).sort((a, b) => b - a)[0] ?? null)
      : ([...yearReportedMonths].sort((a, b) => b - a)[0] ?? null);
    const h2Months = [7, 8, 9, 10, 11, 12].filter(m => yearReportedMonths.has(m));

    function buildHalfYearStats(monthlyRows) {
      const byName = {};
      monthlyRows.forEach(r => {
        const name = r.name;
        (byName[name] = byName[name] || {})[Number(r.month_num)] = {
          qty: Number(r.qty), revenue: Number(r.revenue),
        };
      });
      const avgOfMonths = (cells, monthsArr, key) => {
        if (!monthsArr.length) return null;
        const vals = monthsArr.map(m => (cells[m]?.[key]) || 0);
        return +(vals.reduce((s, v) => s + v, 0) / monthsArr.length).toFixed(2);
      };
      const out = {};
      Object.keys(byName).forEach(name => {
        const cells = byName[name];
        const curCell  = currentMonthNum && yearReportedMonths.has(currentMonthNum) ? cells[currentMonthNum] : null;
        const prevCell = prevMonthNum ? cells[prevMonthNum] : null;
        const h1Revenue = avgOfMonths(cells, h1Months, 'revenue');
        const h2Revenue = avgOfMonths(cells, h2Months, 'revenue');
        out[name] = {
          h1_avg_qty:     avgOfMonths(cells, h1Months, 'qty'),
          h1_avg_revenue: h1Revenue,
          h2_avg_qty:     avgOfMonths(cells, h2Months, 'qty'),
          h2_avg_revenue: h2Revenue,
          current_qty:     curCell ? curCell.qty : null,
          current_revenue: curCell ? curCell.revenue : null,
          prev_month_qty:     prevCell ? prevCell.qty : null,
          prev_month_revenue: prevCell ? prevCell.revenue : null,
          prev_vs_h1_revenue_pct: (h1Revenue && prevCell)
            ? +(((prevCell.revenue - h1Revenue) / h1Revenue) * 100).toFixed(1) : null,
          // H2-vs-H1 % move — the headline "نصف أول مقابل نصف ثاني" comparison.
          h2_vs_h1_revenue_pct: (h1Revenue && h2Months.length)
            ? +(((h2Revenue - h1Revenue) / h1Revenue) * 100).toFixed(1) : null,
          current_vs_h1_revenue_pct: (h1Revenue && curCell)
            ? +(((curCell.revenue - h1Revenue) / h1Revenue) * 100).toFixed(1) : null,
        };
      });
      return out;
    }

    const custCatHalfYear = buildHalfYearStats(custCatMonthlyRes.rows);
    const itemCatHalfYear = buildHalfYearStats(itemCatMonthlyRes.rows);

    res.json({
      meta: {
        year, from_month: fromMonth, to_month: toMonth,
        month_names: MONTH_AR,
        branch: branch ? (Array.isArray(branch) ? branch : [branch]) : null,
        item_categories: (itemCats && itemCats.length) ? itemCats : null,
        cust_category: custCat,
        from_day: fromDay,
        to_day: toDay,
        day_clamped: fromDay > 1 || toDay < 31,
        visit_target: { min: VISIT_TARGET_MIN, max: VISIT_TARGET_MAX },
        region_locked: !!(req.regionFilter && req.regionFilter.length),
        half_year: {
          current_month_num: currentMonthNum,
          current_month_name: currentMonthNum ? MONTH_AR[currentMonthNum] : null,
          prev_month_num: prevMonthNum,
          prev_month_name: prevMonthNum ? MONTH_AR[prevMonthNum] : null,
          h1_months_reported: h1Months.length,
          h2_months_reported: h2Months.length,
        },
      },

      monthly,
      monthly_by_region,
      scorecard: {
        indicators: SCORE_INDICATORS,
        momentum: {
          early: earlyWindow, late: lateWindow, usable: momentumUsable,
          early_names: earlyWindow.map(m => MONTH_AR[m]),
          late_names:  lateWindow.map(m => MONTH_AR[m]),
          excluded_current_month: isCurYear && reportedNums.includes(curMonthNo) ? MONTH_AR[curMonthNo] : null,
        },
        months_counted: nRepMonths,
        regions: regionScore.scored,
        region_benchmarks: regionScore.benchmarks.ALL || {},
        reps: repScore.scored,
        rep_benchmarks: repScore.benchmarks,
      },
      // Which month جدد/مفقودون of the FIRST row were measured against.
      churn_baseline: { year: baseYear, month: baseMonth, month_name: MONTH_AR[baseMonth], has_data: hasBaseline },

      totals: {
        qty: totalQty,
        qty_kg: +sum('qty_kg').toFixed(1),
        // Distinct customers over the WHOLE period. Category rows cannot be
        // summed for this — one customer buying from two channels appears in
        // both — so the totals row needs its own count.
        customers_distinct: new Set(
          Object.values(codesByMonth).flatMap(set => [...set])
        ).size,
        revenue: totalRevenue,
        asp: totalQty > 0 ? +(totalRevenue / totalQty).toFixed(2) : null,
        damages: totalDamages,
        damages_pct: totalQty > 0 ? +((totalDamages / totalQty) * 100).toFixed(2) : null,
        avg_monthly_qty:     Math.round(totalQty / nReported),
        avg_monthly_revenue: Math.round(totalRevenue / nReported),
        avg_monthly_damages: Math.round(totalDamages / nReported),
        visits: totalVisits,
        rep_days: totalRepDays,
        avg_visits_per_day: avgVpd,
        avg_active_customers: avgOf('active_customers'),
        avg_inactive_customers: avgOf('inactive_customers'),
        avg_active_reps: avgOf('active_reps'),
        peak_active_reps: peakReps,
        revenue_per_visit:    totalVisits > 0 ? +(totalRevenue / totalVisits).toFixed(2) : null,
        revenue_per_rep_month: peakReps ? Math.round(totalRevenue / peakReps / nReported) : null,
        qty_per_rep_month:     peakReps ? Math.round(totalQty / peakReps / nReported) : null,
        months_reported: reported.length,
        invoiced: totalInvoiced,
        collected: totalCollected,
        collection_pct: totalInvoiced > 0 ? +((totalCollected / totalInvoiced) * 100).toFixed(2) : null,
        avg_debt_ratio: avgOf('debt_ratio'),
        qi_cost: sum('qi_cost'),
        qi_qty: sum('qi_qty'),
      },

      current: {
        current_debt: Number(debt.current_debt || 0),
        registered_customers: Number(debt.registered_customers || 0),
        reps_on_books: Number(cap.reps_on_books || 0),
        routes_on_books: Number(cap.routes_on_books || 0),
        // Coverage = customers who bought in the last REPORTED month ÷
        // customers ever invoiced in the region. Using the last month of the
        // selected range would read 0% whenever that month hasn't happened yet.
        coverage_pct: Number(debt.registered_customers) > 0 && reported.length
          ? +((reported[reported.length - 1].active_customers / Number(debt.registered_customers)) * 100).toFixed(1)
          : null,
      },

      visit_gap: {
        target_min: VISIT_TARGET_MIN,
        target_max: VISIT_TARGET_MAX,
        actual_vpd: avgVpd,
        avg_rep_days_per_month: Math.round(avgRepDaysPerMonth),
        revenue_per_visit: +revPerVisit.toFixed(2),
        at_min: visitGap(VISIT_TARGET_MIN),
        at_max: visitGap(VISIT_TARGET_MAX),
      },

      // Regression over reported months only — including not-yet-reported
      // months would read as a collapse and poison the forecast default.
      trend: {
        qty:      linearTrend(reported.map(r => r.qty)),
        revenue:  linearTrend(reported.map(r => r.revenue)),
        visits:   linearTrend(reported.map(r => r.visits)),
        customers:linearTrend(reported.map(r => r.active_customers)),
        asp:      linearTrend(reported.map(r => r.asp)),
      },

      by_customer_category: custCatRes.rows.map(r => ({
        name: r.name,
        qty: Number(r.qty), revenue: Number(r.revenue),
        damages: Number(r.damages), customers: Number(r.customers),
        asp: Number(r.qty) > 0 ? +(Number(r.revenue) / Number(r.qty)).toFixed(2) : null,
        revenue_share: totalRevenue > 0 ? +((Number(r.revenue) / totalRevenue) * 100).toFixed(1) : 0,
        ...(custCatHalfYear[r.name] || {}),
      })),

      /* Cross-region price benchmark per customer category. `asp` is the
         best price any region with real volume achieved; `asp_all` is the
         all-region blend used as a fallback when no region qualifies. */
      category_asp_benchmark: benchmarkRes.rows.map(r => ({
        name: r.name,
        asp: r.best_asp != null ? +Number(r.best_asp).toFixed(2) : null,
        branch: r.best_branch || null,
        qty: r.best_qty != null ? Number(r.best_qty) : null,
        asp_all: r.asp_all != null ? +Number(r.asp_all).toFixed(2) : null,
        qty_all: r.qty_all != null ? Number(r.qty_all) : null,
        min_qty: BENCHMARK_MIN_QTY,
      })),

      by_item_category: itemCatRes.rows.map(r => ({
        name: r.name,
        qty: Number(r.qty), revenue: Number(r.revenue), damages: Number(r.damages),
        asp: Number(r.qty) > 0 ? +(Number(r.revenue) / Number(r.qty)).toFixed(2) : null,
        revenue_share: totalRevenue > 0 ? +((Number(r.revenue) / totalRevenue) * 100).toFixed(1) : 0,
        ...(itemCatHalfYear[r.name] || {}),
      })),

      by_item: itemRes.rows.map(r => ({
        name: r.name, category: r.category,
        qty: Number(r.qty), revenue: Number(r.revenue), damages: Number(r.damages),
        asp: Number(r.qty) > 0 ? +(Number(r.revenue) / Number(r.qty)).toFixed(2) : null,
        revenue_share: totalRevenue > 0 ? +((Number(r.revenue) / totalRevenue) * 100).toFixed(1) : 0,
      })),

      by_rep: (() => {
        const vMapRep = Object.fromEntries(repVisitsRes.rows.map(r => [r.rep, r]));
        const mByRep = {};
        repMonthlyRes.rows.forEach(r => {
          (mByRep[r.rep] = mByRep[r.rep] || {})[Number(r.month_num)] = r;
        });
        return repRes.rows.map(r => {
          const qty = Number(r.qty), revenue = Number(r.revenue);
          const rv  = vMapRep[r.rep] || {};
          const visits = Number(rv.visits || 0);
          const activeDays = Number(rv.active_days || 0);
          const series = months.map(m => {
            const cell = (mByRep[r.rep] || {})[m];
            return {
              month_num: m,
              qty: cell ? Number(cell.qty) : 0,
              revenue: cell ? Number(cell.revenue) : 0,
            };
          });
          const vpd = activeDays > 0 ? +(visits / activeDays).toFixed(2) : null;
          const sc = repScoreByName[r.rep];
          return {
            rep: r.rep, branch: r.branch,
            qty, revenue,
            qty_kg: +Number(r.qty_kg || 0).toFixed(1),
            invoices: Number(r.invoices || 0),
            // Weighted scorecard vs the median rep of this rep's own region.
            score: sc?.score ?? null,
            strengths:  sc?.strengths  ?? null,
            weaknesses: sc?.weaknesses ?? null,
            actions:    sc?.actions    ?? null,
            score_band: sc?.band ?? null,
            score_band_key: sc?.band_key ?? null,
            score_rank: sc?.rank ?? null,
            score_parts: sc?.parts ?? null,
            asp: qty > 0 ? +(revenue / qty).toFixed(2) : null,
            customers: Number(r.customers),
            damages: Number(r.damages),
            damages_pct: qty > 0 ? +((Number(r.damages) / qty) * 100).toFixed(2) : null,
            visits, active_days: activeDays,
            visits_per_day: vpd,
            kg_per_day: activeDays > 0 ? +(Number(r.qty_kg || 0) / activeDays).toFixed(1) : null,
            visit_status: vpd == null ? null
              : vpd >= VISIT_TARGET_MAX ? 'excellent'
              : vpd >= VISIT_TARGET_MIN ? 'ontarget'
              : vpd >= VISIT_TARGET_MIN * 0.7 ? 'below' : 'critical',
            revenue_per_visit: visits > 0 ? +(revenue / visits).toFixed(2) : null,
            months_active: series.filter(s => s.qty !== 0 || s.revenue !== 0).length,
            trend_slope_pct: (linearTrend(series.map(s => s.revenue)) || {}).slope_pct ?? null,
            series,
          };
        });
      })(),

      rep_month_matrix: repMonthlyRes.rows.map(r => ({
        rep: r.rep, month_num: Number(r.month_num),
        qty: Number(r.qty), revenue: Number(r.revenue),
      })),
    });
  } catch (err) {
    console.error('[RegionPerformance] assessment:', err);
    res.status(500).json({ error: 'خطأ في جلب تقييم أداء المنطقة' });
  }
});

/* ════════════════════════════════════════════════════════════
   GET /period-compare — region matrix comparing TWO arbitrary date ranges
   (مقارنة بين فترتين). Unlike /assessment this is DAY-precise, not month
   based: sales_activity keeps year/month/day in three smallint columns, so
   the date is rebuilt with make_date(). Verified on production — `day` is
   populated on all 455,021 rows across 2024–2026, so no row is silently
   dropped by the date reconstruction.

   Seven metrics per region, each returned for both periods so the frontend
   can render value/diff/growth% without re-deriving anything:
     qty (صافي الكميات) · damages (التوالف) · qi_cost (توالف الجودة) ·
     customers (العملاء) · collected (التحصيل) · revenue (قيمة المبيعات) ·
     asp (متوسط السعر = revenue ÷ qty, NOT an average of ASPs)

   Region keying is the same stitch as monthly_by_region: sales/damages/
   customers key on sa.branch_name, while payments and quality_issues key on
   region_id, joined through the regions table on BOTH name_ar and name_en
   (see the region-name gotcha in CLAUDE.md). Payments are booked to each
   customer's PRIMARY region so a multi-region customer isn't counted twice.
════════════════════════════════════════════════════════════ */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* growth is only meaningful against a positive base: a region that sold
   nothing in period A has an undefined growth rate, not an infinite one. */
function growthPct(a, b) {
  const A = Number(a) || 0, B = Number(b) || 0;
  if (A <= 0) return null;
  return ((B - A) / A) * 100;
}

/* ════════════════════════════════════════════════════════════
   GET /asp-daily — daily ASP per region, grouped into weeks

   Day-precise like /period-compare (make_date over the three smallint
   columns). Answers three questions the monthly view cannot:
     • how ASP moves day to day inside a week,
     • which region is the cheapest on any given day,
     • each region's average across ALL days in the range.

   The overall average is total revenue ÷ total quantity — NOT the mean of
   the daily ASPs. A mean of daily figures would weight a 300-unit Tuesday
   the same as a 30,000-unit Sunday and would not reconcile with any other
   ASP on the site.

   Weeks start on SATURDAY: the business works Sat–Thu and rests Friday, so a
   Sunday-start week would split every working week across two blocks.
════════════════════════════════════════════════════════════ */
const WEEK_START_DOW = 6;   // 0=Sun … 6=Sat

/* A region-day carrying almost no volume produces a meaningless ASP (a
   handful of odd lines swings it), so it is not allowed to be reported as
   "the cheapest region today". Same idea as BENCHMARK_MIN_QTY. */
const DAILY_MIN_QTY = 100;

function weekStartOf(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const shift = (d.getUTCDay() - WEEK_START_DOW + 7) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

router.get('/asp-daily', verifyToken, applyRegionFilter, async (req, res) => {
  const year      = parseInt(req.query.year) || new Date().getFullYear();
  const fromMonth = Math.max(1,  parseInt(req.query.from_month) || 1);
  const toMonth   = Math.min(12, parseInt(req.query.to_month)   || 12);
  const fromDay   = Math.min(31, Math.max(1, parseInt(req.query.from_day) || 1));
  const toDay     = Math.min(31, Math.max(1, parseInt(req.query.to_day)   || 31));
  if (toMonth < fromMonth) return res.status(400).json({ error: 'نطاق الأشهر غير صحيح' });
  if (fromMonth === toMonth && toDay < fromDay) {
    return res.status(400).json({ error: 'نطاق الأيام غير صحيح' });
  }

  const minQty = Number.isFinite(Number(req.query.min_qty))
    ? Math.max(0, Number(req.query.min_qty)) : DAILY_MIN_QTY;

  try {
    let branch = req.query.branch || null;
    if (req.regionFilter && req.regionFilter.length) {
      branch = await resolveRegionBranch(req.regionFilter);
    }
    const custCat = custCatScope(req.query);
    let itemCats  = req.query.item_category || null;
    if (itemCats && !Array.isArray(itemCats)) itemCats = [itemCats];

    const months = [];
    for (let m = fromMonth; m <= toMonth; m++) months.push(m);

    const params = [year, months];
    let p = 3;
    let extra = dayClampSql(fromMonth, toMonth, fromDay, toDay, 'sa.month_num', 'sa.day');
    if (branch) {
      params.push(Array.isArray(branch) ? branch : [branch]);
      extra += ` AND TRIM(sa.branch_name) = ANY($${p++}::text[])`;
    }
    if (custCat) {
      params.push(custCat);
      extra += ` AND LOWER(TRIM(COALESCE(sa.category_name,''))) = ANY($${p++}::text[])`;
    }
    if (itemCats && itemCats.length) {
      params.push(itemCats);
      extra += ` AND TRIM(COALESCE(sa.item_category_en,'')) = ANY($${p++}::text[])`;
    }

    const { rows } = await pool.query(`
      SELECT to_char(make_date(sa.report_year::int, sa.month_num::int, sa.day::int), 'YYYY-MM-DD') AS d,
             COALESCE(NULLIF(TRIM(sa.branch_name),''),'غير محدد') AS branch,
             COALESCE(SUM(sa.qty),0)::bigint          AS qty,
             COALESCE(SUM(sa.net_revenue),0)::numeric AS revenue,
             COUNT(DISTINCT sa.invoice_number)::int   AS invoices
      FROM sales_activity sa
      WHERE sa.report_year = $1 AND sa.month_num = ANY($2::int[])
        AND sa.day IS NOT NULL${extra}
      GROUP BY 1,2
      ORDER BY 1,2
    `, params);

    const aspOf = (rev, qty) => (qty > 0 ? rev / qty : null);

    /* ── per region-day ── */
    const cells = rows.map(r => {
      const qty = Number(r.qty), revenue = Number(r.revenue);
      return { date: r.d, branch: r.branch, qty, revenue,
               invoices: Number(r.invoices), asp: aspOf(revenue, qty) };
    });

    const dayKeys = [...new Set(cells.map(c => c.date))].sort();
    const branches = [...new Set(cells.map(c => c.branch))].sort();

    /* ── weeks (Saturday-start) ── */
    const weekMap = new Map();
    dayKeys.forEach(d => {
      const ws = weekStartOf(d);
      if (!weekMap.has(ws)) weekMap.set(ws, []);
      weekMap.get(ws).push(d);
    });
    const weeks = [...weekMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([start, days], i) => ({ week_start: start, week_no: i + 1, days }));

    /* ── company total per day, and the cheapest region that day ── */
    const byDay = new Map();
    cells.forEach(c => {
      if (!byDay.has(c.date)) byDay.set(c.date, []);
      byDay.get(c.date).push(c);
    });
    /* "Which region is cheapest today" only means something when there is
       more than one region in scope. Filtered to a single region it would be
       the lowest on every single day (208 of 214 for Riyadh) — a true but
       useless statement that reads like a finding. */
    const rankLowest = branches.length > 1;
    const lowestCounts = {};
    const day_totals = dayKeys.map(d => {
      const list = byDay.get(d) || [];
      const qty = list.reduce((s, c) => s + c.qty, 0);
      const revenue = list.reduce((s, c) => s + c.revenue, 0);
      /* Only regions above the volume floor may be called "the lowest", and
         only with a POSITIVE price. A 12-unit day would otherwise win the
         title every time, and a returns-dominated day (net revenue below
         zero — Riyadh 2026-07-26: 311 units, −1,232 ر.س) would win it
         always, since no real price can beat a negative number. */
      const eligible = rankLowest ? list.filter(c => c.qty >= minQty && c.asp != null && c.asp > 0) : [];
      let low = null;
      if (eligible.length) {
        low = eligible.reduce((a, b) => (b.asp < a.asp ? b : a));
        lowestCounts[low.branch] = (lowestCounts[low.branch] || 0) + 1;
      }
      return {
        date: d, week_start: weekStartOf(d), qty, revenue, asp: aspOf(revenue, qty),
        regions_reporting: list.length,
        lowest_branch: low ? low.branch : null,
        lowest_asp: low ? low.asp : null,
      };
    });

    /* ── per-region totals across ALL days (the «المتوسط العام» column) ── */
    const region_totals = branches.map(b => {
      const list = cells.filter(c => c.branch === b);
      const qty = list.reduce((s, c) => s + c.qty, 0);
      const revenue = list.reduce((s, c) => s + c.revenue, 0);
      /* Min/max are taken only over days that clear the volume floor. A day
         dominated by returns has negative net quantity and yields an ASP like
         −3.96 — an artifact of the arithmetic, not a price anyone charged.
         Such days stay in `cells` (the grid still shows what happened) but
         must not become the region's reported minimum. */
      const solid = list.filter(c => c.asp != null && c.asp > 0 && c.qty >= minQty);
      const negativeDays = list.filter(c => c.asp != null && c.asp <= 0).length;
      const min = solid.length ? solid.reduce((a, c) => (c.asp < a.asp ? c : a)) : null;
      const max = solid.length ? solid.reduce((a, c) => (c.asp > a.asp ? c : a)) : null;
      return {
        branch: b, days: list.length, qty, revenue,
        asp: aspOf(revenue, qty),                    // weighted — the real average
        solid_days: solid.length,
        thin_days: list.length - solid.length - negativeDays,
        negative_days: negativeDays,
        min_asp: min ? min.asp : null, min_date: min ? min.date : null,
        max_asp: max ? max.asp : null, max_date: max ? max.date : null,
        lowest_days: lowestCounts[b] || 0,
      };
    }).sort((a, b) => (b.qty - a.qty));

    /* ── per-region weekly averages (weighted inside each week) ── */
    const weekly = [];
    weeks.forEach(w => {
      const inWeek = new Set(w.days);
      branches.forEach(b => {
        const list = cells.filter(c => c.branch === b && inWeek.has(c.date));
        if (!list.length) return;
        const qty = list.reduce((s, c) => s + c.qty, 0);
        const revenue = list.reduce((s, c) => s + c.revenue, 0);
        weekly.push({ week_start: w.week_start, branch: b, qty, revenue, asp: aspOf(revenue, qty) });
      });
    });

    const grandQty = cells.reduce((s, c) => s + c.qty, 0);
    const grandRev = cells.reduce((s, c) => s + c.revenue, 0);

    res.json({
      meta: { year, from_month: fromMonth, to_month: toMonth, min_qty: minQty,
              week_start_dow: WEEK_START_DOW, rank_lowest: rankLowest },
      days: dayKeys,
      branches,
      weeks,
      cells,
      weekly,
      day_totals,
      region_totals,
      totals: { qty: grandQty, revenue: grandRev, asp: aspOf(grandRev, grandQty), days: dayKeys.length },
    });
  } catch (err) {
    console.error('[RegionPerformance] asp-daily:', err);
    res.status(500).json({ error: 'خطأ في جلب تتبع ASP اليومي' });
  }
});

router.get('/period-compare', verifyToken, applyRegionFilter, async (req, res) => {
  const aFrom = String(req.query.a_from || '').trim();
  const aTo   = String(req.query.a_to   || '').trim();
  const bFrom = String(req.query.b_from || '').trim();
  const bTo   = String(req.query.b_to   || '').trim();

  for (const [label, v] of [['a_from',aFrom],['a_to',aTo],['b_from',bFrom],['b_to',bTo]]) {
    if (!ISO_DATE.test(v)) return res.status(400).json({ error: `تاريخ غير صحيح: ${label}` });
  }
  if (aTo < aFrom || bTo < bFrom) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح' });

  try {
    let branch = req.query.branch || null;
    if (req.regionFilter && req.regionFilter.length) {
      branch = await resolveRegionBranch(req.regionFilter);
    }
    const regionIds = branch ? await branchToRegionIds(branch) : null;

    const custCat = custCatScope(req.query);
    let itemCats  = req.query.item_category || null;
    if (itemCats && !Array.isArray(itemCats)) itemCats = [itemCats];

    /* ── sales_activity: both periods in ONE pass, tagged A/B ──
       $1..$4 = the four bounds; the branch/category filters follow. */
    const saParams = [aFrom, aTo, bFrom, bTo];
    let p = 5, extraSql = '';
    if (branch) {
      saParams.push(Array.isArray(branch) ? branch : [branch]);
      extraSql += ` AND TRIM(sa.branch_name) = ANY($${p++}::text[])`;
    }
    if (custCat) {
      saParams.push(custCat);
      extraSql += ` AND LOWER(TRIM(COALESCE(sa.category_name,''))) = ANY($${p++}::text[])`;
    }
    if (itemCats && itemCats.length) {
      saParams.push(itemCats);
      extraSql += ` AND TRIM(COALESCE(sa.item_category_en,'')) = ANY($${p++}::text[])`;
    }

    const SA_DATE = `make_date(sa.report_year::int, sa.month_num::int, sa.day::int)`;
    const PERIOD  = `CASE WHEN ${SA_DATE} BETWEEN $1::date AND $2::date THEN 'a'
                          WHEN ${SA_DATE} BETWEEN $3::date AND $4::date THEN 'b' END`;
    /* A row inside BOTH ranges (overlapping periods) lands in 'a' only — the
       CASE stops at its first true branch. Overlapping periods are a user
       error, not a data state to model, and this keeps every total honest. */
    const saScope = `sa.day IS NOT NULL
        AND (${SA_DATE} BETWEEN $1::date AND $2::date
          OR ${SA_DATE} BETWEEN $3::date AND $4::date)${extraSql}`;

    /* group=rep drills the same seven metrics down to the reps inside the
       selected region (the matrix's row label becomes the rep). Two of the
       metrics do not exist at rep level and are handled explicitly below
       rather than being faked. */
    const byRep = String(req.query.group || '') === 'rep';
    const GROUP_KEY = byRep
      ? `COALESCE(NULLIF(TRIM(sa.salesrep_name),''),'غير محدد')`
      : `COALESCE(NULLIF(TRIM(sa.branch_name),''),'غير محدد')`;

    const salesQ = pool.query(`
      SELECT ${GROUP_KEY} AS name,
             ${PERIOD}                                   AS period,
             COALESCE(SUM(sa.qty),0)::bigint             AS qty,
             COALESCE(SUM(sa.net_revenue),0)::numeric    AS revenue,
             COALESCE(SUM(sa.bad_return_qty),0)::bigint  AS damages,
             /* Value of the damaged units, priced on THEIR OWN line: a return
                line books a negative qty and a negative net_revenue, so
                net_revenue/qty is that line's unit price. Verified on
                production — all 773 damage lines in Jun–Jul 2026 carry qty<0
                (none at zero), so every one of them is priceable. Line-level
                pricing is also grouping-invariant: the reps of a region sum
                to exactly the region's figure, which a "damages × the group's
                blended ASP" estimate would not. */
             COALESCE(SUM(sa.bad_return_qty * (sa.net_revenue / NULLIF(sa.qty,0))),0)::numeric
                                                         AS damages_value,
             COUNT(DISTINCT sa.customer_code)::int       AS customers,
             COUNT(DISTINCT sa.invoice_number)::int      AS invoices,
             /* Visits = distinct (rep, customer, day) — same definition used
                by the main dashboard's visits/day KPI. rep_days = distinct
                (rep, day) the rep actually recorded activity, the honest
                denominator for a daily average (an absent day must not dilute
                it). FILTER excludes blank rep names so they don't collapse
                into one fake "visit". Grouping-invariant like damages_value:
                at rep level GROUP_KEY is already the rep, so this naturally
                degrades to that one rep's own distinct visit-days. */
             COUNT(DISTINCT (TRIM(sa.salesrep_name), sa.customer_code, sa.day))
               FILTER (WHERE sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) <> '')::int AS visits,
             COUNT(DISTINCT (TRIM(sa.salesrep_name), sa.day))
               FILTER (WHERE sa.salesrep_name IS NOT NULL AND TRIM(sa.salesrep_name) <> '')::int AS rep_days
      FROM sales_activity sa
      WHERE ${saScope}
      GROUP BY 1,2
    `, saParams);

    /* ── rep mode: payments per customer + the customer's primary rep ──
       `payments` has no rep column, so a payment is booked to the rep who
       served that customer most in the compared windows — the same
       "primary owner" rule the region mode uses for multi-region customers.
       A customer with no sales_activity line in either period has no owner
       and its payments land in `unattributed` rather than on an arbitrary
       rep. Scoped by cust_region so a rep drill never picks up another
       region's collections. */
    const custRepQ = !byRep ? null : pool.query(`
      SELECT DISTINCT ON (sa.customer_code) sa.customer_code,
             COALESCE(NULLIF(TRIM(sa.salesrep_name),''),'غير محدد') AS rep
      FROM sales_activity sa
      WHERE ${saScope}
      GROUP BY 1,2
      ORDER BY sa.customer_code, COUNT(*) DESC
    `, saParams);

    const payCustParams = [aFrom, aTo, bFrom, bTo];
    let payCustRegionSql = '';
    if (regionIds) { payCustParams.push(regionIds); payCustRegionSql = ` AND cr.region_id = ANY($5::int[])`; }
    const payByCustQ = !byRep ? null : pool.query(`
      WITH cust_region AS (
        SELECT DISTINCT ON (i.customer_id) i.customer_id, i.region_id
        FROM invoices i WHERE i.region_id IS NOT NULL
        GROUP BY i.customer_id, i.region_id
        ORDER BY i.customer_id, COUNT(*) DESC
      )
      SELECT p.customer_code,
             CASE WHEN p.tran_date::date BETWEEN $1::date AND $2::date THEN 'a'
                  WHEN p.tran_date::date BETWEEN $3::date AND $4::date THEN 'b' END AS period,
             COALESCE(SUM(p.total_paid),0)::numeric AS collected
      FROM payments p
      JOIN cust_region cr ON cr.customer_id = p.customer_code
      WHERE (p.tran_date::date BETWEEN $1::date AND $2::date
          OR p.tran_date::date BETWEEN $3::date AND $4::date)${payCustRegionSql}
      GROUP BY 1,2
    `, payCustParams);

    /* ── payments (التحصيل), booked to each customer's primary region ── */
    const payParams = [aFrom, aTo, bFrom, bTo];
    let payRegionSql = '';
    if (regionIds) { payParams.push(regionIds); payRegionSql = ` AND cr.region_id = ANY($5::int[])`; }
    const payQ = byRep ? null : pool.query(`
      WITH cust_region AS (
        SELECT DISTINCT ON (i.customer_id) i.customer_id, i.region_id
        FROM invoices i WHERE i.region_id IS NOT NULL
        GROUP BY i.customer_id, i.region_id
        ORDER BY i.customer_id, COUNT(*) DESC
      )
      SELECT cr.region_id,
             CASE WHEN p.tran_date::date BETWEEN $1::date AND $2::date THEN 'a'
                  WHEN p.tran_date::date BETWEEN $3::date AND $4::date THEN 'b' END AS period,
             COALESCE(SUM(p.total_paid),0)::numeric AS collected
      FROM payments p
      JOIN cust_region cr ON cr.customer_id = p.customer_code
      WHERE (p.tran_date::date BETWEEN $1::date AND $2::date
          OR p.tran_date::date BETWEEN $3::date AND $4::date)${payRegionSql}
      GROUP BY 1,2
    `, payParams);

    /* Company-wide payments with NO region join — a customer whose invoices
       all lack a region_id cannot be booked to any region, so the region rows
       under-foot the real collection total (~0.09% on live data). Comparing
       against this reveals exactly how much, instead of losing it silently.
       Only meaningful when looking at every region; a branch-scoped request
       has no company total to compare against. */
    const payAllQ = (regionIds || byRep) ? null : pool.query(`
      SELECT CASE WHEN p.tran_date::date BETWEEN $1::date AND $2::date THEN 'a'
                  WHEN p.tran_date::date BETWEEN $3::date AND $4::date THEN 'b' END AS period,
             COALESCE(SUM(p.total_paid),0)::numeric AS collected
      FROM payments p
      WHERE p.tran_date::date BETWEEN $1::date AND $2::date
         OR p.tran_date::date BETWEEN $3::date AND $4::date
      GROUP BY 1
    `, [aFrom, aTo, bFrom, bTo]);

    /* ── quality issues (توالف الجودة) ── */
    const qiParams = [aFrom, aTo, bFrom, bTo];
    let qiRegionSql = '';
    if (regionIds) { qiParams.push(regionIds); qiRegionSql = ` AND qi.region_id = ANY($5::int[])`; }
    const qiQ = pool.query(`
      SELECT qi.region_id,
             CASE WHEN qi.issue_date::date BETWEEN $1::date AND $2::date THEN 'a'
                  WHEN qi.issue_date::date BETWEEN $3::date AND $4::date THEN 'b' END AS period,
             COALESCE(SUM(ABS(qi.quantity)),0)::numeric   AS qi_qty,
             COALESCE(SUM(ABS(qi.total_cost)),0)::numeric AS qi_cost
      FROM quality_issues qi
      WHERE (qi.issue_date::date BETWEEN $1::date AND $2::date
          OR qi.issue_date::date BETWEEN $3::date AND $4::date)${qiRegionSql}
      GROUP BY 1,2
    `, qiParams);

    /* A customer that trades in two regions is distinct in each, so summing
       the region counts overstates the company total. The footer therefore
       gets its own un-grouped distinct count. */
    const custTotalQ = pool.query(`
      SELECT ${PERIOD} AS period, COUNT(DISTINCT sa.customer_code)::int AS customers
      FROM sales_activity sa
      WHERE ${saScope}
      GROUP BY 1
    `, saParams);

    const regionsQ = pool.query('SELECT id, name_ar, name_en FROM regions WHERE fleet_only = false');

    const [salesRes, payRes, qiRes, custTotalRes, regionsRes, payAllRes, custRepRes, payByCustRes] =
      await Promise.all([salesQ, payQ, qiQ, custTotalQ, regionsQ, payAllQ, custRepQ, payByCustQ]);

    /* ── stitch branch ↔ region_id, both directions ── */
    const keyToId  = new Map();
    const idToName = new Map();
    regionsRes.rows.forEach(r => {
      [r.name_ar, r.name_en].filter(Boolean)
        .forEach(n => keyToId.set(String(n).trim().toLowerCase(), Number(r.id)));
      idToName.set(Number(r.id), String(r.name_ar || r.name_en || '').trim());
    });

    const blank = () => ({
      qty: 0, revenue: 0, damages: 0, damages_value: 0, customers: 0, invoices: 0,
      qi_qty: 0, qi_cost: 0, collected: 0, visits: 0, rep_days: 0,
    });
    const rows = new Map();   // row key → { name, region_id, a, b }
    const ensure = (rowName, regionId) => {
      const k = String(rowName || 'غير محدد').trim().toLowerCase();
      if (!rows.has(k)) {
        rows.set(k, {
          name: String(rowName || 'غير محدد').trim(),
          /* in rep mode the row is a person, not a place — no region_id */
          region_id: byRep ? null : (regionId ?? keyToId.get(k) ?? null),
          a: blank(), b: blank(),
        });
      }
      const row = rows.get(k);
      if (!byRep && row.region_id == null && regionId != null) row.region_id = regionId;
      return row;
    };

    salesRes.rows.forEach(r => {
      if (r.period !== 'a' && r.period !== 'b') return;
      const row = ensure(r.name, byRep ? null : (keyToId.get(String(r.name).trim().toLowerCase()) ?? null));
      const t = row[r.period];
      t.qty           += Number(r.qty || 0);
      t.revenue       += Number(r.revenue || 0);
      t.damages       += Number(r.damages || 0);
      t.damages_value += Number(r.damages_value || 0);
      t.customers += Number(r.customers || 0);
      t.invoices  += Number(r.invoices || 0);
      t.visits    += Number(r.visits || 0);
      t.rep_days  += Number(r.rep_days || 0);
    });

    /* payments/QI arrive keyed by region_id — resolve back to the branch
       name so they land on the row the sales side already created. */
    const byRegionId = new Map();
    rows.forEach(row => { if (row.region_id != null) byRegionId.set(row.region_id, row); });
    const rowForRegion = rid => {
      if (rid == null) return null;
      if (byRegionId.has(rid)) return byRegionId.get(rid);
      const name = idToName.get(Number(rid));
      if (!name) return null;                       // unknown region → dropped, counted below
      const row = ensure(name, Number(rid));
      byRegionId.set(Number(rid), row);
      return row;
    };

    const unattributed = { a: { collected: 0, qi_cost: 0 }, b: { collected: 0, qi_cost: 0 } };
    const attributedPay = { a: 0, b: 0 };

    if (byRep) {
      /* customer → primary rep, then payments follow the customer */
      const repOf = new Map();
      custRepRes.rows.forEach(r => repOf.set(r.customer_code, r.rep));
      payByCustRes.rows.forEach(r => {
        if (r.period !== 'a' && r.period !== 'b') return;
        const v = Number(r.collected || 0);
        const rep = repOf.get(r.customer_code);
        if (!rep) { unattributed[r.period].collected += v; return; }
        ensure(rep, null)[r.period].collected += v;
      });
      /* quality_issues carries a region only — there is no rep dimension in
         the source report, so a per-rep figure would have to be invented.
         The rows report null (rendered "—") while the footer keeps the real
         region total, and `qi_by_row` tells the client which it is. */
      qiRes.rows.forEach(r => {
        if (r.period !== 'a' && r.period !== 'b') return;
        unattributed[r.period].qi_cost += Number(r.qi_cost || 0);
      });
      rows.forEach(row => { row.a.qi_cost = null; row.b.qi_cost = null;
                            row.a.qi_qty = null;  row.b.qi_qty = null; });
    } else {
      payRes.rows.forEach(r => {
        if (r.period !== 'a' && r.period !== 'b') return;
        const v = Number(r.collected || 0);
        attributedPay[r.period] += v;
        const row = rowForRegion(r.region_id == null ? null : Number(r.region_id));
        if (!row) { unattributed[r.period].collected += v; return; }
        row[r.period].collected += v;
      });
      qiRes.rows.forEach(r => {
        if (r.period !== 'a' && r.period !== 'b') return;
        const row = rowForRegion(r.region_id == null ? null : Number(r.region_id));
        if (!row) { unattributed[r.period].qi_cost += Number(r.qi_cost || 0); return; }
        row[r.period].qi_qty  += Number(r.qi_qty  || 0);
        row[r.period].qi_cost += Number(r.qi_cost || 0);
      });
    }
    /* payments the cust_region JOIN dropped entirely (customer has no invoice
       carrying a region_id) — they never reach the loop above */
    if (payAllRes) {
      payAllRes.rows.forEach(r => {
        if (r.period !== 'a' && r.period !== 'b') return;
        const missing = Number(r.collected || 0) - attributedPay[r.period];
        if (missing > 0.005) unattributed[r.period].collected += missing;
      });
    }

    /* ── derive ASP + diffs; totals are summed from the raw figures, so the
       total ASP is a blended revenue÷qty, never an average of region ASPs ── */
    const METRICS = ['qty', 'damages', 'damages_value', 'qi_cost', 'qi_qty',
                     'customers', 'collected', 'revenue'];
    const finish = t => {
      t.asp = t.qty > 0 ? t.revenue / t.qty : null;
      /* متوسط الزيارات اليومية = زيارات ÷ أيام عمل المندوب الفعلية. Same
         "rep_days, not calendar days" denominator as the main dashboard's
         visits/day KPI, so a rep who took days off isn't penalized for them. */
      t.avg_visits_per_day = t.rep_days > 0 ? +(t.visits / t.rep_days).toFixed(2) : null;
      return t;
    };
    /* A metric can be legitimately UNAVAILABLE rather than zero (توالف الجودة
       per rep), so every derived figure has to survive a null instead of
       turning into NaN and rendering as a number. */
    const deltas = (a, b) => {
      const d = {};
      [...METRICS, 'asp', 'avg_visits_per_day'].forEach(m => {
        const A = a[m], B = b[m];
        const known = A != null && B != null && Number.isFinite(Number(A)) && Number.isFinite(Number(B));
        d[`${m}_diff`]   = known ? Number(B) - Number(A) : null;
        d[`${m}_growth`] = known ? growthPct(A, B) : null;
      });
      return d;
    };

    const totalA = blank(), totalB = blank();
    const out = [...rows.values()].map(row => {
      ['a','b'].forEach(k => {
        const t = row[k], tot = k === 'a' ? totalA : totalB;
        Object.keys(t).forEach(f => { if (t[f] != null) tot[f] += t[f]; });
        finish(t);
      });
      return { ...row, delta: deltas(row.a, row.b) };
    }).sort((x, y) => y.b.revenue - x.b.revenue);

    /* replace the summed customer counts with the true distinct totals */
    custTotalRes.rows.forEach(r => {
      if (r.period === 'a') totalA.customers = Number(r.customers || 0);
      if (r.period === 'b') totalB.customers = Number(r.customers || 0);
    });

    /* The footer must be the true company figure, so what no region could
       claim is added back there (and reported in `unattributed` so the gap
       between the footer and the sum of the rows is explainable). */
    totalA.collected += unattributed.a.collected;
    totalB.collected += unattributed.b.collected;
    totalA.qi_cost   += unattributed.a.qi_cost;
    totalB.qi_cost   += unattributed.b.qi_cost;

    finish(totalA); finish(totalB);

    const dayCount = (from, to) =>
      Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;

    res.json({
      periods: {
        a: { from: aFrom, to: aTo, days: dayCount(aFrom, aTo) },
        b: { from: bFrom, to: bTo, days: dayCount(bFrom, bTo) },
        overlap: !(aTo < bFrom || bTo < aFrom),
      },
      group: byRep ? 'rep' : 'region',
      /* which metrics actually exist at this grouping — the client renders
         "—" plus a note instead of a fabricated zero for the rest */
      row_metrics: byRep
        ? { qi_cost: false, collected: 'derived' }   // collected via the customer's primary rep
        : { qi_cost: true,  collected: true },
      rows: out,
      totals: { a: totalA, b: totalB, delta: deltas(totalA, totalB) },
      /* honest reporting of anything that could not be attributed to a
         region — the region rows would otherwise silently under-foot */
      unattributed,
    });
  } catch (err) {
    console.error('[RegionPerformance] period-compare:', err);
    res.status(500).json({ error: 'خطأ في مقارنة الفترتين' });
  }
});

/* ════════════════════════════════════════════════════════════
   Saved growth-plan settings, per region — reuses the generic
   app_settings key/value table (same pattern as the Hypermarkets/
   Category-Performance "insight note"). Key = region_growth_plan:<branch>
   ("all" when no specific region is selected). Gated by the page's own
   permission level (not a hardcoded admin-only role list) so any role
   granted edit access on "region_performance" via the Permissions screen
   can actually save — same fix applied to commissions.js.
════════════════════════════════════════════════════════════ */
function planKey(branch) {
  const b = (branch || '').trim() || 'all';
  return `region_growth_plan:${b}`;
}

router.get('/plan', verifyToken, requirePagePermission('region_performance', 1), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT value, updated_by, updated_at FROM app_settings WHERE key = $1',
      [planKey(req.query.branch)]
    );
    res.json(rows.length
      ? { plan: rows[0].value, updated_by: rows[0].updated_by, updated_at: rows[0].updated_at }
      : { plan: null }
    );
  } catch (err) {
    console.error('[RegionPerformance] plan GET:', err);
    res.status(500).json({ error: 'خطأ في جلب إعدادات الخطة المحفوظة' });
  }
});

/* Every saved per-region plan in one call. The "الكل" view uses it to build a
   company-wide plan out of the individual regions instead of starting blank. */
router.get('/plans', verifyToken, requirePagePermission('region_performance', 1), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value, updated_at FROM app_settings
       WHERE key LIKE 'region_growth_plan:%' ORDER BY key`
    );
    res.json({
      plans: rows
        .map(r => ({ branch: r.key.slice('region_growth_plan:'.length), plan: r.value, updated_at: r.updated_at }))
        // 'all' is the aggregate itself — never an input to its own aggregation.
        .filter(r => r.branch && r.branch !== 'all'),
    });
  } catch (err) {
    console.error('[RegionPerformance] plans GET:', err);
    res.status(500).json({ error: 'خطأ في جلب خطط المناطق' });
  }
});

router.put('/plan', verifyToken, requirePagePermission('region_performance', 2), async (req, res) => {
  try {
    const key = planKey(req.query.branch);
    const value = req.body || {};
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_by = $3, updated_at = NOW()`,
      [key, JSON.stringify(value), req.user.email || req.user.name || req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[RegionPerformance] plan PUT:', err);
    res.status(500).json({ error: 'خطأ في حفظ إعدادات الخطة' });
  }
});

module.exports = router;
