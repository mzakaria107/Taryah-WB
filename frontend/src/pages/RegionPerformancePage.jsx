import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './RegionPerformancePage.css';

/* Roles that must not see the planning / forecasting tab. The rest of the
   page (actuals, comparisons, scorecard) stays fully available to them —
   only the forward-looking targets and the scenario levers are withheld.
   NOTE: this is a UI restriction. The saved plan is still readable through
   GET /region-performance/plan(s), which other tabs legitimately consume
   (the ASP-target column of the half-year table). Hiding it from the API too
   would need a separate page_key in `page_permissions`. */
const PLAN_HIDDEN_ROLES = ['supervisor', 'region_manager'];

/* ── Constants ─────────────────────────────────────────────── */
const MONTHS = [
  [1,'يناير'],[2,'فبراير'],[3,'مارس'],[4,'أبريل'],
  [5,'مايو'],[6,'يونيو'],[7,'يوليو'],[8,'أغسطس'],
  [9,'سبتمبر'],[10,'أكتوبر'],[11,'نوفمبر'],[12,'ديسمبر'],
];
const MONTH_AR = Object.fromEntries(MONTHS);
/* Real length of the month, so 31 is never offered for June and 29/30 never
   for a non-leap February — an unselectable day would read as "no data". */
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/* A newly-hired rep / newly-opened route does not deliver a full month's
   productivity on day one — this ramp is applied to their contribution
   for their 1st, 2nd, and 3rd-onward month. */
const RAMP = [0.4, 0.7, 1.0];

/* Sales channels the business wants the ASP mix shift to land in, with the
   explicit share of the priority block each one receives. Listed in
   priority order; the weights are the business's own call, not derived
   from the ordering. If a region is missing a channel (or the user
   switches one off), the remaining weights renormalize between them. */
const ASP_FOCUS_PRIORITY = [
  { name: 'Groceries',      weight: 35 },
  { name: 'Shawerma Labs',  weight: 25 },
  { name: 'Discount Shops', weight: 20 },
  { name: 'Hypermarkets',   weight: 20 },
];
const aspPriorityRank   = (name) => ASP_FOCUS_PRIORITY.findIndex(p => p.name === name);
const aspPriorityWeight = (name) => (ASP_FOCUS_PRIORITY.find(p => p.name === name)?.weight ?? 0);

/* Core channels whose combined share is PROTECTED — they keep a fixed
   floor of total volume (split between them in their current
   proportions) so an ASP push can't hollow out the base business. */
const ASP_BASE_CHANNELS = ['Restaurant', 'Poultry Shops'];
// Fallback only — the live value comes from the scorecard's ASP indicator so
// the scoring floor and the "الهدف العام" shown in the mix table can never drift
// apart. Changing the target is a one-line edit in the backend indicator list.
const ASP_COMPANY_TARGET_FALLBACK = 14.50;

/* A region with almost no trade distorts every comparison on this page: it
   drags the medians, adds a near-empty row to every table and takes a place in
   the scorecard ranking. Excluding it is a display choice, so it is a filter
   rather than a hardcoded rule. */
/* Column reference for the monthly detail table. Kept as data next to the
   table it documents, so a formula change and its explanation move together.
   Only columns whose reading is genuinely ambiguous are listed — a column that
   says exactly what it is does not need a line here. */
const COLUMN_REFERENCE = [
  ['أيام العمل', 'أيام الشهر التقويمية عدا الجُمَع والعطل الرسمية. ليست عدد الأيام التي عمل فيها المندوبون فعلاً.'],
  ['الكمية', 'صافي الوحدات بعد خصم المرتجعات — قد تكون سالبة لفرع مرتجعاته أكبر من مبيعاته.'],
  ['متوسط كمية/يوم', 'الكمية ÷ أيام العمل التقويمية للصف. انتبه: «كجم/يوم» تُقسم على أيام‑المندوبين لا على أيام العمل، فالمقامان مختلفان.'],
  ['حصة الكمية %', 'في صف الشهر: كمية الشهر ÷ إجمالي كمية الفترة. في صف المنطقة: كمية المنطقة ÷ كمية الشهر نفسه — فتجمع صفوف المناطق 100% تحت كل شهر.'],
  ['كميات كجم', 'الكمية × وزن الوحدة المستخرج من اسم الصنف ÷ 1000. أصناف «2 pieces» يُضرب وزنها في عدد القطع.'],
  ['ASP', 'القيمة ÷ الكمية بالوحدات (لا بالكيلوجرام).'],
  ['ASP السابق · فرق %', 'ASP الشهر الذي يسبقه فعلياً حتى لو كان خارج النطاق المختار؛ والنسبة = مقدار تغيّره عنه.'],
  ['عملاء فعالون', 'كل عميل له أي سطر فاتورة في الشهر — ويشمل «غير فعال» بداخله، فلا يُجمعان.'],
  ['غير فعال', 'عميل ظهر في الشهر لكن صافي كميته صفر أو سالب (مرتجعات فقط).'],
  ['جدد', 'أول تعامل له على الإطلاق — لا فواتير في أي سنة سابقة.'],
  ['عائدون', 'أول شهر يتعامل فيه هذا العام، ولديه فواتير من سنوات سابقة.'],
  ['مفقودون', 'تعامل الشهر السابق ولم يتعامل هذا الشهر.'],
  ['مناديب', 'عدد المندوبين الذين سجّلوا أي حركة في الشهر.'],
  ['زيارات/يوم', 'الزيارات ÷ أيام‑المندوبين. «زيارة» = عميل واحد في يوم واحد لمندوب واحد مهما تعددت فواتيره.'],
  ['كجم/يوم', 'الكميات كجم ÷ أيام‑المندوبين. «يوم‑مندوب» = يوم عمل فيه مندوب فعلاً — وليس (عدد المناديب × أيام العمل).'],
  ['إيراد/زيارة', 'القيمة ÷ عدد الزيارات.'],
  ['إيراد/عميل', 'القيمة ÷ عدد العملاء الفعالين.'],
  ['توالف %', 'المرتجعات التالفة من حركة المندوبين ÷ الكمية.'],
  ['توالف الجودة', 'تكلفة التوالف بالريال من تقرير الجودة المرفوع — مصدر مختلف تماماً عن «توالف %» ولا يُقارن به.'],
  ['توالف الجودة (كمية)', 'كمية التوالف بالوحدات من نفس تقرير الجودة. مرّر المؤشر على عمود التكلفة لعدد الحالات.'],
  ['تحصيل %', 'ما حُصّل خلال الشهر ÷ ما فُوتر فيه. قد يتجاوز 100% لأن التحصيل يشمل فواتير أشهر سابقة.'],
  ['نسبة الدين %', 'رصيد الفواتير غير المسدد ÷ المفوتر في الشهر.'],
];

const EXCLUDABLE_BRANCH = 'Hafir El Batin';
const EXCLUDABLE_BRANCH_AR = 'حفر الباطن';
const ASP_BASE_FLOOR_DEFAULT = 50; // % of total quantity → priority block gets the other 50%
/* Every priority channel keeps at least this share of its own rank
   allocation, so chasing the ASP target can never zero out a channel the
   business deliberately put on the priority list. */
const ASP_MIN_KEEP_DEFAULT = 5;  // % of TOTAL quantity, per priority channel
/* Same guarantee for the base channels: each one keeps at least this
   share of total quantity inside the base block. */
const ASP_BASE_MIN_DEFAULT = 10; // % of TOTAL quantity, per base channel

/* Channels whose local ASP is unreliable because the region sells too
   little through them — a handful of odd lines swings the average. For
   these the planning model pins the best price any region with real
   volume actually achieved (see category_asp_benchmark), so the mix
   maths is driven by an attainable price rather than local noise. */
const ASP_PINNED_CATEGORIES = ['Groceries', 'Discount Shops'];

/* Channel allowed an explicit ceiling on its final share — Hypermarkets
   is a limited, contract-bound channel, so the plan must be able to stop
   it absorbing more volume than the business can actually place there. */
const ASP_CAP_CHANNELS = ['Groceries', 'Shawerma Labs', 'Hypermarkets'];

/* Ceiling on the monthly volume a NEWLY added rep is assumed to reach.
   Only applies where the region's average rep already sells more. */
const NEW_REP_QTY_CAP_DEFAULT = 20000; // units / month
const ASP_CAP_DEFAULT = 15; // % of total quantity

/* ── Formatters ────────────────────────────────────────────── */
const fmt = (n, dec = 0) =>
  n == null || !Number.isFinite(Number(n)) ? '—'
  : Number(n).toLocaleString('en-SA', { maximumFractionDigits: dec, minimumFractionDigits: dec ? dec : 0 });
const fmtM = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toLocaleString('en-SA', { maximumFractionDigits: 2 })}م`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toLocaleString('en-SA', { maximumFractionDigits: 1 })}ك`;
  return fmt(v);
};
const pct = (n, dec = 1) =>
  n == null || !Number.isFinite(Number(n)) ? '—' : `${Number(n).toFixed(dec)}%`;

/* ── Deviation badge ──────────────────────────────────────── */
function Dev({ value, invert = false, suffix = '%' }) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  const good = invert ? v < 0 : v > 0;
  const cls = v === 0 ? 'rp-dev--flat' : good ? 'rp-dev--up' : 'rp-dev--down';
  const arrow = v === 0 ? '→' : v > 0 ? '↑' : '↓';
  return <span className={`rp-dev rp-dev--sm ${cls}`}>{arrow} {Math.abs(v).toFixed(1)}{suffix}</span>;
}

/* ── KPI card ─────────────────────────────────────────────── */
function Kpi({ icon, label, value, sub, accent, dev, devInvert }) {
  return (
    <div className={`rp-kpi rp-kpi--big${accent ? ` rp-kpi--${accent}` : ''}`}>
      {icon && <span className="rp-kpi__icon">{icon}</span>}
      <div className="rp-kpi__body">
        <div className="rp-kpi__label">{label}</div>
        <div className="rp-kpi__value">{value}</div>
        {sub && <div className="rp-kpi__sub">{sub}</div>}
        {dev != null && <Dev value={dev} invert={devInvert} />}
      </div>
    </div>
  );
}

/* ── Dual-bar monthly trend chart ─────────────────────────── */
function TrendChart({ rows, aKey, bKey, aLabel, bLabel, labelKey = 'month_name' }) {
  if (!rows?.length) return <div className="rp-empty">لا توجد بيانات</div>;
  const max = Math.max(...rows.map(r => Math.max(Number(r[aKey]) || 0, Number(r[bKey]) || 0)), 1);
  return (
    <div className="rp-trend">
      <div className="rp-trend__cols">
        {rows.map((r, i) => (
          <div key={i} className="rp-trend__col">
            <div className="rp-trend__bars">
              <div className="rp-trend__bar-wrap" title={`${aLabel}: ${fmt(r[aKey])}`}>
                <div className="rp-trend__bar rp-trend__bar--qty"
                     style={{ height: `${((Number(r[aKey]) || 0) / max * 100).toFixed(1)}%` }} />
              </div>
              {bKey && (
                <div className="rp-trend__bar-wrap" title={`${bLabel}: ${fmt(r[bKey])}`}>
                  <div className="rp-trend__bar rp-trend__bar--ret"
                       style={{ height: `${((Number(r[bKey]) || 0) / max * 100).toFixed(1)}%` }} />
                </div>
              )}
            </div>
            <div className="rp-trend__label">{r[labelKey]}</div>
            <div className="rp-trend__vals">
              <span className="rp-trend__qty rp-trend__qty--a">{fmtM(r[aKey])}</span>
              {bKey && <span className="rp-trend__qty rp-trend__qty--b">{fmtM(r[bKey])}</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="rp-trend__legend">
        <span className="rp-trend__legend-item rp-trend__legend-item--qty">■ {aLabel}</span>
        {bKey && <span className="rp-trend__legend-item rp-trend__legend-item--ret">■ {bLabel}</span>}
      </div>
    </div>
  );
}

/* ── Horizontal bar list ──────────────────────────────────── */
function HBar({ rows, valueKey, labelKey, colorClass = 'rp-bar--primary', maxBars = 12, money, decimals = 0 }) {
  const capped = (rows || []).slice(0, maxBars);
  const max = Math.max(...capped.map(r => Number(r[valueKey]) || 0), 1);
  return (
    <div className="rp-hbar">
      {capped.map((r, i) => (
        <div key={i} className="rp-hbar__row">
          <span className="rp-hbar__label" title={r[labelKey]}>{r[labelKey]}</span>
          <div className="rp-hbar__track">
            <div className={`rp-hbar__fill ${colorClass}`}
                 style={{ width: `${((Number(r[valueKey]) || 0) / max * 100).toFixed(1)}%` }} />
          </div>
          <span className="rp-hbar__val">{money ? fmtM(r[valueKey]) : fmt(r[valueKey], decimals)}</span>
        </div>
      ))}
      {!capped.length && <div className="rp-empty">لا توجد بيانات</div>}
    </div>
  );
}

/* ── Sortable table header ────────────────────────────────── */
function Th({ col, sort, onSort, children }) {
  const active = sort.col === col;
  return (
    <th className={`rp-th${active ? ' rp-th--sorted' : ''}`} onClick={() => onSort(col)}>
      {children}
      <span className={`rp-sort${active ? ' rp-sort--active' : ''}`}>
        {active ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ' ⇅'}
      </span>
    </th>
  );
}

/* ── Visits/day bar against the 10–15 target band ─────────── */
/* ASP change vs the previous month. A price drop is the thing worth spotting,
   so a negative renders red and a rise green — the opposite of a cost column. */
function AspDelta({ v }) {
  if (v == null || !Number.isFinite(Number(v))) return <span className="rp-muted">—</span>;
  const n = Number(v);
  if (Math.abs(n) < 0.05) return <span className="rp-muted">0.0%</span>;
  return (
    <span className={n > 0 ? 'rp-pos' : 'rp-neg'}>
      <bdi>{n > 0 ? '▲' : '▼'} {Math.abs(n).toFixed(1)}%</bdi>
    </span>
  );
}

/* Weighted scorecard cell — the band is the headline, the number is secondary.
   The tooltip spells out each indicator against ITS OWN target, since the
   target now differs per entity (own value +3%/+8%, floored at the median). */
function ScoreCell({ row, indicators = [] }) {
  if (row?.score == null) return <span className="rp-muted">—</span>;
  const parts = row.score_parts || row.parts || [];
  const band  = row.band || row.score_band;
  const key   = row.band_key || row.score_band_key || 'average';
  const tip = indicators.map(ind => {
    const p = parts.find(x => x.key === ind.key);
    if (!p || p.points == null) return `${ind.label} (${ind.weight}%): لا بيانات`;
    const arrow = ind.dir === 'low' ? '≤' : '≥';
    return `${ind.label} (${ind.weight}%): ${Number(p.value).toFixed(2)} — الهدف ${arrow} ${Number(p.benchmark).toFixed(2)}`
         + `${p.median != null ? ` (وسيط ${Number(p.median).toFixed(2)})` : ''}`
         + ` = ${Math.round(p.ratio * 100)}% ← ${p.points.toFixed(1)} من ${p.weight}`;
  }).join('\n');
  return (
    <span className={`rp-score rp-score--${key}`}
          title={`${tip}

المجموع: ${row.score}%  ·  الأوزان المحتسبة: ${row.weight_applied}%`}>
      <span className="rp-score-band">{band}</span>
      <span className="rp-score-meta">
        {row.score}{row.score_rank ? ` · #${row.score_rank}` : ''}
      </span>
    </span>
  );
}

/* Strengths / weaknesses / actions come from the scorecard parts, so the
   narrative can never contradict the score shown beside it. */
function AdviceCell({ items, kind }) {
  if (!items || !items.length) return <span className="rp-muted">—</span>;
  return (
    <ul className={`rp-advice rp-advice--${kind}`}>
      {items.map((t, i) => <li key={i}>{t}</li>)}
    </ul>
  );
}

function VisitBar({ vpd, status, max = 15 }) {
  if (vpd == null) return <span className="rp-dash">—</span>;
  const w = Math.min(100, (Number(vpd) / max) * 100);
  return (
    <div className="rp-vbar-wrap">
      <div className={`rp-vbar rp-vbar--${status || 'below'}`} style={{ width: `${w}%` }} />
      <span className="rp-vbar-txt">{Number(vpd).toFixed(1)}</span>
    </div>
  );
}

const VISIT_LABEL = { excellent: 'متميز', ontarget: 'داخل الهدف', below: 'أقل من الهدف', critical: 'حرج' };
const SCEN_LABEL = { conservative: 'محافظ', balanced: 'متوازن', ambitious: 'طموح', custom: 'مخصص' };

/* ── Rep×month matrix cell — respects the qty/revenue/both toggle ──── */
function renderRepMatrixCell(obj, metric) {
  const revenue = Number(obj?.revenue) || 0;
  const qty = Number(obj?.qty) || 0;
  if (metric === 'qty') {
    return qty !== 0 ? <span className="rp-matrix-qty">{fmt(qty)}</span> : <span className="rp-matrix-dash">—</span>;
  }
  if (metric === 'both') {
    if (!revenue && !qty) return <span className="rp-matrix-dash">—</span>;
    return (
      <span className="rp-matrix-both">
        <span className="rp-matrix-qty">{fmtM(revenue)}</span>
        <span className="rp-matrix-sub">{fmt(qty)} وحدة</span>
      </span>
    );
  }
  return revenue !== 0 ? <span className="rp-matrix-qty">{fmtM(revenue)}</span> : <span className="rp-matrix-dash">—</span>;
}

/* ── Plan-tab forecast cell — respects the qty/revenue/both toggle.
   `plus` renders a leading + and dashes non-positive values (lever
   contribution columns); without it zero still renders as a number. ── */
function renderPlanCell(rev, qty, metric, { plus = false } = {}) {
  const fmtOne = (v, isQty) => {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    if (plus && Number(v) <= 0) return '—';
    const txt = isQty ? fmt(Math.round(v)) : fmtM(v);
    return plus ? `+${txt}` : txt;
  };
  if (metric === 'qty') return fmtOne(qty, true);
  if (metric === 'both') {
    const revTxt = fmtOne(rev, false);
    const qtyTxt = fmtOne(qty, true);
    if (revTxt === '—' && qtyTxt === '—') return '—';
    return (
      <span className="rp-matrix-both">
        <span className="rp-matrix-qty">{revTxt}</span>
        <span className="rp-matrix-sub">{qtyTxt === '—' ? '—' : `${qtyTxt} وحدة`}</span>
      </span>
    );
  }
  return fmtOne(rev, false);
}

/* ASP achieved vs the target carried by the region's forecast, stacked in one
   cell: the value, the target beneath it, and what is still missing. The target
   is the blended mix target, so a channel's own gap against it is exactly the
   signal for whether growing that channel moves the blend up or down. */
function AspVsTarget({ value, target, note }) {
  if (value == null && target == null) return <span className="rp-muted">—</span>;
  const gap = (value != null && target != null) ? target - value : null;
  return (
    <span className="rp-asp-stack" title={note || undefined}>
      <bdi className="rp-asp-main">{value != null ? value.toFixed(2) : '—'}</bdi>
      {target != null && <bdi className="rp-asp-target">هدف {target.toFixed(2)}{note ? ' *' : ''}</bdi>}
      {gap != null && (
        gap > 0.005
          ? <bdi className="rp-asp-gap rp-neg">متبقٍ {gap.toFixed(2)}</bdi>
          : <bdi className="rp-asp-gap rp-pos">تحقق +{Math.abs(gap).toFixed(2)}</bdi>
      )}
    </span>
  );
}

/* ── H1-avg vs current-month vs H2-avg comparison table ───────
   "أول 6 أشهر من العام" (calendar Jan–Jun) vs the current month vs the
   average of the reported months since — the requested first-half /
   second-half growth comparison, per category/item. */
function HalfYearTable({ rows, halfYear, nameLabel, aspPlan, targetAsp, companyTarget, planActive, showShare = false }) {
  const [metric, setMetric] = useState('revenue'); // 'revenue' | 'qty' | 'both'
  if (!rows?.length) return null;
  /* The ASP block is only meaningful for sales channels (customer categories),
     because the mix plan reallocates share between channels — an item category
     has no share to move. */
  /* The three ASP columns come from each row's own revenue/qty, so they work
     for item categories too. Only the required-share column is channel-specific
     — an item category has no channel share to reallocate. */
  const showAsp = true;
  /* The target and the shares must come from the forecast the region actually
     runs on. Two things follow:
       · the block is live only when the ASP plan is switched INTO the forecast
         (`includeAspPlan`); otherwise the forecast ignores the mix entirely and
         showing its shares would describe a plan nobody selected.
       · the target is `achieved`, not the slider request — channel caps and
         floors can stop the mix short of what was asked, and the forecast is
         built on what the mix actually delivers. */
  const planLive  = Boolean(planActive && aspPlan);
  const planByName = (planLive && showShare) ? Object.fromEntries(aspPlan.rows.map(r => [r.name, r])) : null;
  const planTarget = planLive ? aspPlan.achieved : null;
  const aspOf = (rev, qty) => (Number(qty) > 0 ? Number(rev) / Number(qty) : null);
  const h1Full  = 'متوسط شهري لأشهر النصف الأول المُبلَّغة (يناير–يونيو)';
  const h1Label = 'متوسط ن.الأول';
  const prevLabel = halfYear?.prev_month_name ? `الشهر السابق · ${halfYear.prev_month_name}` : 'الشهر السابق';
  const curLabel  = halfYear?.current_month_name ? `الشهر الحالي · ${halfYear.current_month_name}` : 'الشهر الحالي';
  const h2Full  = 'متوسط شهري لأشهر النصف الثاني المُبلَّغة (يوليو وحتى الآن)';
  const h2Label = halfYear?.h2_months_reported
    ? `متوسط ن.الثاني · ${halfYear.h2_months_reported} شهر`
    : 'متوسط ن.الثاني';

  const pctChange = (a, b) => (a != null && a !== 0 && b != null) ? +(((b - a) / a) * 100).toFixed(1) : null;

  /* Footer totals. The headline change is the change of the TOTALS, not the
     mean of the row percentages — a channel that fell 100% from a tiny base
     would otherwise drag the company figure as hard as the largest channel.
     The plain row-average is still shown underneath, since it answers a
     different question: how the typical channel moved. */
  const tot = k => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const totals = {
    h1_rev: tot('h1_avg_revenue'), h1_qty: tot('h1_avg_qty'),
    cur_rev: tot('current_revenue'), cur_qty: tot('current_qty'),
    h2_rev: tot('h2_avg_revenue'), h2_qty: tot('h2_avg_qty'),
    prev_rev: tot('prev_month_revenue'), prev_qty: tot('prev_month_qty'),
  };
  const tBase = metric === 'qty' ? totals.h1_qty : totals.h1_rev;
  const tCur  = metric === 'qty' ? totals.cur_qty : totals.cur_rev;
  const tPrev = metric === 'qty' ? totals.prev_qty : totals.prev_rev;
  const tH2   = metric === 'qty' ? totals.h2_qty : totals.h2_rev;
  const meanOf = (fn) => {
    const v = rows.map(fn).filter(x => x != null && Number.isFinite(x));
    return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null;
  };
  const meanPrevPct = meanOf(r => pctChange(metric === 'qty' ? r.h1_avg_qty : r.h1_avg_revenue,
                                            metric === 'qty' ? r.prev_month_qty : r.prev_month_revenue));
  const meanCurPct = meanOf(r => pctChange(metric === 'qty' ? r.h1_avg_qty : r.h1_avg_revenue,
                                           metric === 'qty' ? r.current_qty : r.current_revenue));
  const meanH2Pct  = meanOf(r => pctChange(metric === 'qty' ? r.h1_avg_qty : r.h1_avg_revenue,
                                           metric === 'qty' ? r.h2_avg_qty : r.h2_avg_revenue));
  const renderVal = (rev, qty) => {
    if (rev == null && qty == null) return '—';
    if (metric === 'qty') return fmt(qty);
    if (metric === 'both') {
      return (
        <span className="rp-matrix-both">
          <span className="rp-matrix-qty">{fmtM(rev)}</span>
          <span className="rp-matrix-sub">{fmt(qty)} وحدة</span>
        </span>
      );
    }
    return fmtM(rev);
  };

  return (
    <>
      <div className="rp-matrix-header">
        <div className="rp-section-title" style={{ margin: 0 }}>مقارنة النصف الأول بالنصف الثاني — {nameLabel}</div>
        <div className="rp-metric-toggle">
          <button className={metric === 'revenue' ? 'active' : ''} onClick={() => setMetric('revenue')}>القيمة</button>
          <button className={metric === 'qty' ? 'active' : ''} onClick={() => setMetric('qty')}>الكمية</button>
          <button className={metric === 'both' ? 'active' : ''} onClick={() => setMetric('both')}>كلاهما</button>
        </div>
      </div>
      <div className="rp-mtable-wrap">
        <table className="rp-mtable rp-mtable--hy">
          <colgroup>
            {[
              110,        // الفئة
              88, 88, 74, // متوسط ن.الأول · الشهر السابق · تغيره
              88, 74,     // الشهر الحالي · تغيره
              88, 74,     // متوسط ن.الثاني · تغيره
              ...(showAsp ? [56, 56, 94] : []),
              ...(showShare ? [98] : []),
            ].map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <thead>
            <tr>
              <th>{nameLabel}</th>
              <th title={h1Full}>{h1Label}</th>
              <th title={`قيمة ${prevLabel}`}>{prevLabel}</th>
              <th title="تغير الشهر السابق عن متوسط النصف الأول">السابق مقابل ن.الأول</th>
              <th title={`قيمة ${curLabel}`}>{curLabel}</th>
              <th title="تغير الشهر الحالي عن متوسط النصف الأول">الحالي مقابل ن.الأول</th>
              <th title={h2Full}>{h2Label}</th>
              <th title="تغير متوسط النصف الثاني عن متوسط النصف الأول">ن.الثاني مقابل الأول</th>
              {showAsp && (<>
                <th className="rp-asp-col" title="ASP متوسط النصف الأول — القيمة ÷ الكمية">ASP ن.الأول</th>
                <th className="rp-asp-col" title="ASP الشهر الحالي — القيمة ÷ الكمية">ASP الحالي</th>
                <th className="rp-asp-col" title="ASP النصف الثاني، وتحته سعر القناة المستهدف في سيناريو التخطيط والمتبقي للوصول إليه">ASP ن.الثاني · المستهدف</th>
                {showShare && (
                  <th className="rp-asp-col" title="حصة القناة الحالية ← الحصة المطلوبة لبلوغ المستهدف">الحصة المطلوبة</th>
                )}
              </>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const base = metric === 'qty' ? r.h1_avg_qty : r.h1_avg_revenue;
              const cur  = metric === 'qty' ? r.current_qty : r.current_revenue;
              const h2   = metric === 'qty' ? r.h2_avg_qty : r.h2_avg_revenue;
              const prev = metric === 'qty' ? r.prev_month_qty : r.prev_month_revenue;
              const prevPct = pctChange(base, prev);
              const curPct = pctChange(base, cur);
              const h2Pct  = pctChange(base, h2);
              const pr = planByName ? planByName[r.name] : null;
              const aspH1  = aspOf(r.h1_avg_revenue, r.h1_avg_qty);
              const aspCur = aspOf(r.current_revenue, r.current_qty);
              const aspH2  = aspOf(r.h2_avg_revenue, r.h2_avg_qty);
              return (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td>{renderVal(r.h1_avg_revenue, r.h1_avg_qty)}</td>
                  <td>{renderVal(r.prev_month_revenue, r.prev_month_qty)}</td>
                  <td>{prevPct != null ? <Dev value={prevPct} /> : '—'}</td>
                  <td>{renderVal(r.current_revenue, r.current_qty)}</td>
                  <td>{curPct != null ? <Dev value={curPct} /> : '—'}</td>
                  <td>{renderVal(r.h2_avg_revenue, r.h2_avg_qty)}</td>
                  <td>{h2Pct != null ? <Dev value={h2Pct} /> : '—'}</td>
                  {showAsp && (<>
                    <td className="rp-asp-col">{aspH1 != null ? aspH1.toFixed(2) : '—'}</td>
                    <td className="rp-asp-col">{aspCur != null ? aspCur.toFixed(2) : '—'}</td>
                    <td className="rp-asp-col">
                      {/* Target = the ASP the saved scenario assumes for THIS channel,
                          not the blended figure — that is what the plan is priced on. */}
                      <AspVsTarget
                        value={aspH2}
                        target={pr ? Number(pr.asp) : planTarget}
                        note={pr && pr.asp_pinned
                          ? `سعر مثبَّت من ${pr.asp_pinned_from} — سعر المنطقة الفعلي ${Number(pr.local_asp).toFixed(2)}`
                          : null} />
                    </td>
                    {showShare && (
                    <td className="rp-asp-col">
                      {pr ? (
                        <span className="rp-share-cell">
                          <bdi className="rp-share-new">{pr.new_share.toFixed(1)}%</bdi>
                          <bdi className="rp-share-from">من {pr.share.toFixed(1)}%</bdi>
                          {Math.abs(pr.delta) >= 0.05 && (
                            <bdi className={pr.delta > 0 ? 'rp-pos' : 'rp-neg'}>
                              {pr.delta > 0 ? '▲' : '▼'} {Math.abs(pr.delta).toFixed(1)} نقطة
                            </bdi>
                          )}
                        </span>
                      ) : <span className="rp-muted">—</span>}
                    </td>
                    )}
                  </>)}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
              <tr>
                <td>{showShare ? 'الإجمالي / المزيج' : 'الإجمالي'}</td>
                <td>{renderVal(totals.h1_rev, totals.h1_qty)}</td>
                <td>{renderVal(totals.prev_rev, totals.prev_qty)}</td>
                <td>
                  <span className="rp-foot-chg">
                    {pctChange(tBase, tPrev) != null ? <Dev value={pctChange(tBase, tPrev)} /> : '—'}
                    {meanPrevPct != null && <bdi className="rp-foot-mean" title="متوسط نسب التغير عبر الصفوف">متوسط الصفوف {meanPrevPct}%</bdi>}
                  </span>
                </td>
                <td>{renderVal(totals.cur_rev, totals.cur_qty)}</td>
                <td>
                  <span className="rp-foot-chg">
                    {pctChange(tBase, tCur) != null ? <Dev value={pctChange(tBase, tCur)} /> : '—'}
                    {meanCurPct != null && <bdi className="rp-foot-mean" title="متوسط نسب التغير عبر الصفوف">متوسط الصفوف {meanCurPct}%</bdi>}
                  </span>
                </td>
                <td>{renderVal(totals.h2_rev, totals.h2_qty)}</td>
                <td>
                  <span className="rp-foot-chg">
                    {pctChange(tBase, tH2) != null ? <Dev value={pctChange(tBase, tH2)} /> : '—'}
                    {meanH2Pct != null && <bdi className="rp-foot-mean" title="متوسط نسب التغير عبر الصفوف">متوسط الصفوف {meanH2Pct}%</bdi>}
                  </span>
                </td>
                {showAsp && (<>
                <td className="rp-asp-col">{(() => {
                  const q = rows.reduce((s, r) => s + Number(r.h1_avg_qty || 0), 0);
                  const v = rows.reduce((s, r) => s + Number(r.h1_avg_revenue || 0), 0);
                  return q > 0 ? (v / q).toFixed(2) : '—';
                })()}</td>
                <td className="rp-asp-col">{(() => {
                  const q = rows.reduce((s, r) => s + Number(r.current_qty || 0), 0);
                  const v = rows.reduce((s, r) => s + Number(r.current_revenue || 0), 0);
                  return q > 0 ? (v / q).toFixed(2) : '—';
                })()}</td>
                <td className="rp-asp-col">{(() => {
                  const q = rows.reduce((s, r) => s + Number(r.h2_avg_qty || 0), 0);
                  const v = rows.reduce((s, r) => s + Number(r.h2_avg_revenue || 0), 0);
                  return <AspVsTarget value={q > 0 ? v / q : null} target={planTarget} />;
                })()}</td>
                {showShare && (
                  <td className="rp-asp-col">
                    {planLive
                      ? <bdi className="rp-share-new">{aspPlan.rows.reduce((s, r) => s + r.new_share, 0).toFixed(1)}%</bdi>
                      : <span className="rp-muted">—</span>}
                  </td>
                )}
                </>)}
              </tr>
            </tfoot>
        </table>
      </div>
      {showAsp && (
        <div className="rp-ctrl-hint" style={{ marginTop: 6 }}>
          {planLive ? (<>
            {showShare
              ? 'المستهدف لكل قناة = سعر بيعها المعتمد في سيناريو التخطيط والتوقعات، والحصة المطلوبة من نفس السيناريو. '
              : '«مستهدف ASP» مأخوذ من توقع هذه المنطقة المحدد في تبويب التخطيط والتوقعات. '}
            المستهدف المرجّح للمزيج <strong>{planTarget.toFixed(2)}</strong> وهو ASP الذي يبلغه المزيج فعلياً
            {targetAsp != null && Math.abs(Number(targetAsp) - planTarget) >= 0.005 && (
              <> (المطلوب على الشريط {Number(targetAsp).toFixed(2)} — والفارق سببه حدود الحصص القصوى/الدنيا)</>
            )}، والهدف العام للشركة <strong>{Number(companyTarget).toFixed(2)}</strong>
            {planTarget < Number(companyTarget) && (
              <span className="rp-neg"> — توقع المنطقة أقل من الهدف العام بمقدار
                {' '}{(Number(companyTarget) - planTarget).toFixed(2)}.</span>
            )}
          </>) : (
            <span className="rp-neg">
              خطة مزيج ASP غير مُفعَّلة ضمن توقع هذه المنطقة، لذلك لا يوجد مستهدف ولا حصص مطلوبة تُعرض هنا.
              فعِّل «التخطيط على أساس ASP» في تبويب التخطيط والتوقعات واحفظ الخطة لتظهر أرقامها.
            </span>
          )}
        </div>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   DAILY ASP TRACKING (تتبع ASP اليومي)

   One block per week — a six-month range is ~150 days, and 150 columns in
   one table is unreadable no matter how narrow the cells get. Each block is
   regions × the days of that week, plus the week's own weighted average, and
   a final summary table carries the overall average across ALL days.

   The lowest region of each day is flagged, but only among regions that sold
   at least `min_qty` units that day: a region that moved 12 units has an ASP
   driven by rounding, and letting it win "cheapest today" every day would
   bury the real signal.
═══════════════════════════════════════════════════════════ */
const DOW_AR = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const dayLabel = iso => {
  const d = new Date(iso + 'T00:00:00Z');
  return { dow: DOW_AR[d.getUTCDay()], num: `${d.getUTCDate()}/${d.getUTCMonth() + 1}` };
};

function AspCell({ cell, isLowest, minQty }) {
  if (!cell) return <span className="rp-muted">—</span>;
  if (cell.asp == null) return <span className="rp-muted">—</span>;
  const thin = cell.qty < minQty;
  const negative = cell.asp <= 0;
  const cls = negative ? 'rp-aspd-neg' : isLowest ? 'rp-aspd-low' : thin ? 'rp-aspd-thin' : '';
  const title = `${fmt(cell.qty)} وحدة · ${fmtM(cell.revenue)} ر.س`
    + (negative ? ' — يوم يغلب عليه المرتجع، والقيمة ليست سعراً' : thin ? ` — كمية أقل من ${minQty}، السعر غير مُعوَّل عليه` : '')
    + (isLowest ? ' — الأدنى في هذا اليوم' : '');
  return (
    <span className={`rp-aspd-cell ${cls}`} title={title}>
      <bdi>{cell.asp.toFixed(2)}</bdi>
      {thin && !negative && <span className="rp-aspd-flag">؟</span>}
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════
   فئة العميل — multi-select sales-channel filter.

   Stored as the KEPT list, and an EMPTY list means "الكل". Two reasons:
   a channel added to the catalogue later is then included by default instead
   of silently dropping out of every saved view, and an unfiltered request goes
   out byte-identical to the one the old single-value select produced — so
   "الكل" cannot start reading differently than it did before.

   Because empty means all, the boxes render as checked when nothing is picked.
   Unticking one from that state therefore yields "every channel except this
   one" in a single click, which is the exclusion case; ticking a few from
   scratch (or "فقط") gives the inclusion case. Both live in one control.
══════════════════════════════════════════════════════════════ */
function CustCatPicker({ all, value, onChange }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = e => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const esc  = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const selected = value.length ? value : all;
  /* Never let the last one be unticked — an empty scope would read as "الكل"
     and show the opposite of what the user just asked for. */
  const set = next => onChange(next.length === 0 || next.length === all.length ? [] : next);
  const toggle = c => set(selected.includes(c)
    ? (selected.length === 1 ? selected : selected.filter(x => x !== c))
    : [...selected, c]);

  const label = !value.length ? 'الكل'
    : value.length === 1 ? value[0]
    : value.length === all.length - 1 ? `الكل عدا ${all.find(c => !value.includes(c))}`
    : `${value.length} فئات`;

  return (
    <div className="rp-ms" ref={boxRef}>
      <button type="button" className={`rp-ms__btn${value.length ? ' rp-ms__btn--on' : ''}`}
              onClick={() => setOpen(o => !o)} title={value.length ? value.join('، ') : 'كل فئات العملاء'}>
        <span className="rp-ms__label">{label}</span>
        <span className="rp-ms__caret">▾</span>
      </button>
      {open && (
        <div className="rp-ms__menu">
          <div className="rp-ms__head">
            <button type="button" className="rp-ms__mini" onClick={() => onChange([])}>الكل</button>
            <span className="rp-ms__count">{selected.length} / {all.length}</span>
          </div>
          <div className="rp-ms__list">
            {all.map(c => {
              const on = selected.includes(c);
              return (
                <div key={c} className={`rp-ms__row${on ? ' rp-ms__row--on' : ''}`}>
                  <label className="rp-ms__opt">
                    <input type="checkbox" checked={on} onChange={() => toggle(c)} />
                    <span>{c}</span>
                  </label>
                  <button type="button" className="rp-ms__only" title="هذه الفئة وحدها"
                          onClick={() => set([c])}>فقط</button>
                </div>
              );
            })}
          </div>
          {!all.length && <div className="rp-ms__empty">لا توجد فئات</div>}
        </div>
      )}
    </div>
  );
}

function AspDailyTab({ branchParams, custCatParams, itemCatParams, year, fromMonth, toMonth, fromDay, toDay }) {
  const [minQty, setMinQty]   = useState(100);
  const [openWeeks, setOpenWeeks] = useState(null);   // null = all open

  const params = new URLSearchParams({ year, from_month: fromMonth, to_month: toMonth, min_qty: minQty });
  if (fromDay > 1) params.set('from_day', fromDay);
  if (toDay < 31)  params.set('to_day', toDay);
  branchParams.forEach(b => params.append('branch', b));
  custCatParams.forEach(c => params.append('cust_category', c));
  itemCatParams.forEach(c => params.append('item_category', c));

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['rp-asp-daily', year, fromMonth, toMonth, fromDay, toDay, minQty, branchParams.join('|'), custCatParams.join('|'), itemCatParams.join('|')],
    queryFn: () => client.get(`/region-performance/asp-daily?${params}`).then(r => r.data),
    staleTime: 2 * 60 * 1000,
  });

  /* "branch|date" → cell, so a week block is a pure lookup */
  const cellMap = useMemo(() => {
    const m = new Map();
    (data?.cells || []).forEach(c => m.set(`${c.branch}|${c.date}`, c));
    return m;
  }, [data]);
  const weeklyMap = useMemo(() => {
    const m = new Map();
    (data?.weekly || []).forEach(w => m.set(`${w.branch}|${w.week_start}`, w));
    return m;
  }, [data]);
  const dayTotalMap = useMemo(() => {
    const m = new Map();
    (data?.day_totals || []).forEach(d => m.set(d.date, d));
    return m;
  }, [data]);

  const weeks = data?.weeks || [];
  const isOpen = ws => openWeeks === null || openWeeks.has(ws);
  const toggleWeek = ws => setOpenWeeks(prev => {
    const next = new Set(prev === null ? weeks.map(w => w.week_start) : prev);
    if (next.has(ws)) next.delete(ws); else next.add(ws);
    return next;
  });

  /* regions ordered by volume — biggest first, same as everywhere else */
  const regions = (data?.region_totals || []).map(r => r.branch);

  return (
    <div className="rp-tab-content">
      <div className="rp-section-title rp-section-title--row">
        <span>تتبع متوسط سعر البيع (ASP) يومياً — مقسّماً بالأسابيع</span>
        <label className="rp-aspd-minqty">
          حد الكمية للاعتداد باليوم
          <input type="number" min="0" step="10" value={minQty}
                 onChange={e => setMinQty(Math.max(0, Number(e.target.value) || 0))} />
          وحدة
        </label>
        {weeks.length > 0 && (
          <button className="rp-mini-btn" onClick={() => setOpenWeeks(openWeeks === null ? new Set() : null)}>
            {openWeeks === null ? '▾ طيّ كل الأسابيع' : '▸ فتح كل الأسابيع'}
          </button>
        )}
      </div>

      {isLoading && <div className="rp-loading"><div className="rp-spinner"/><span>جاري حساب التتبع اليومي…</span></div>}
      {isError && !isLoading && (
        <div className="rp-error">تعذّر جلب التتبع اليومي{error?.response?.data?.error ? ` — ${error.response.data.error}` : ''}.</div>
      )}
      {data && !isLoading && !data.days.length && (
        <div className="rp-error">لا توجد بيانات يومية ضمن النطاق المختار.</div>
      )}

      {data && !isLoading && data.days.length > 0 && (<>
        <div className="rp-legend">
          <span className="rp-aspd-cell rp-aspd-low">00.00</span> الأدنى في اليوم ·
          <span className="rp-aspd-cell rp-aspd-thin">00.00؟</span> كمية أقل من الحد ·
          <span className="rp-aspd-cell rp-aspd-neg">00.00</span> يوم يغلب عليه المرتجع
          <span className="rp-legend-note">
            الأسبوع يبدأ السبت (يوم العمل الأول)، والجمعة إجازة فلا تظهر إن لم يكن بها بيع.
            «الأدنى» يُحتسب فقط بين المناطق التي تجاوزت حد الكمية في ذلك اليوم.
          </span>
        </div>

        {weeks.map(w => {
          const open = isOpen(w.week_start);
          return (
            <div key={w.week_start} className="rp-aspd-week">
              <div className="rp-aspd-week__head" onClick={() => toggleWeek(w.week_start)}>
                <span className="rp-aspd-week__toggle">{open ? '▾' : '▸'}</span>
                <strong>الأسبوع {w.week_no}</strong>
                <span className="rp-aspd-week__range">
                  {dayLabel(w.days[0]).num} — {dayLabel(w.days[w.days.length - 1]).num}
                  {' '}({w.days.length} يوم)
                </span>
              </div>

              {open && (
                <div className="rp-mtable-wrap">
                  <table className="rp-mtable rp-mtable--dense rp-mtable--aspd">
                    <colgroup>
                      <col style={{ width: 104 }} />
                      {w.days.map(d => <col key={d} style={{ width: 62 }} />)}
                      <col style={{ width: 74 }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>المنطقة</th>
                        {w.days.map(d => {
                          const l = dayLabel(d);
                          return (
                            <th key={d} title={d}>
                              <span className="rp-aspd-dow">{l.dow}</span>
                              <span className="rp-aspd-date">{l.num}</span>
                            </th>
                          );
                        })}
                        <th title="متوسط الأسبوع = إجمالي قيمة الأسبوع ÷ إجمالي كميته">متوسط الأسبوع</th>
                      </tr>
                    </thead>
                    <tbody>
                      {regions.map(b => {
                        const wk = weeklyMap.get(`${b}|${w.week_start}`);
                        return (
                          <tr key={b}>
                            <td><bdi>{b}</bdi></td>
                            {w.days.map(d => (
                              <td key={d}>
                                <AspCell
                                  cell={cellMap.get(`${b}|${d}`)}
                                  isLowest={dayTotalMap.get(d)?.lowest_branch === b}
                                  minQty={data.meta.min_qty}
                                />
                              </td>
                            ))}
                            <td>{wk?.asp != null
                              ? <bdi className="rp-aspd-wavg">{wk.asp.toFixed(2)}</bdi>
                              : <span className="rp-muted">—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>كل المناطق</td>
                        {w.days.map(d => {
                          const t = dayTotalMap.get(d);
                          return (
                            <td key={d} title={t ? `${fmt(t.qty)} وحدة` : ''}>
                              {t?.asp != null ? t.asp.toFixed(2) : '—'}
                            </td>
                          );
                        })}
                        <td>{(() => {
                          const qty = w.days.reduce((s, d) => s + (dayTotalMap.get(d)?.qty || 0), 0);
                          const rev = w.days.reduce((s, d) => s + (dayTotalMap.get(d)?.revenue || 0), 0);
                          return qty > 0 ? (rev / qty).toFixed(2) : '—';
                        })()}</td>
                      </tr>
                      {data.meta.rank_lowest && (
                      <tr>
                        <td className="rp-aspd-lowrow">الأدنى اليوم</td>
                        {w.days.map(d => {
                          const t = dayTotalMap.get(d);
                          return (
                            <td key={d} className="rp-aspd-lowrow">
                              {t?.lowest_branch
                                ? <bdi title={`${t.lowest_branch} · ${t.lowest_asp.toFixed(2)}`}>{t.lowest_branch}</bdi>
                                : <span className="rp-muted">—</span>}
                            </td>
                          );
                        })}
                        <td className="rp-aspd-lowrow" />
                      </tr>
                      )}
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          );
        })}

        {/* ── Overall summary: the "متوسط عام لجميع الأيام" column ── */}
        <div className="rp-section-title">المتوسط العام لجميع الأيام</div>
        <div className="rp-mtable-wrap">
          <table className="rp-mtable rp-mtable--dense">
            <thead>
              <tr>
                <th>المنطقة</th>
                <th title="عدد الأيام التي سجّلت فيها المنطقة أي حركة">أيام ببيانات</th>
                <th>إجمالي الكمية</th>
                <th title="إجمالي القيمة ÷ إجمالي الكمية لكل الأيام — متوسط مرجّح وليس متوسط المتوسطات">
                  المتوسط العام لجميع الأيام
                </th>
                <th title={`أدنى يوم بين الأيام التي تجاوزت ${data.meta.min_qty} وحدة`}>أدنى يوم</th>
                <th title={`أعلى يوم بين الأيام التي تجاوزت ${data.meta.min_qty} وحدة`}>أعلى يوم</th>
                {data.meta.rank_lowest && (
                  <th title="عدد الأيام التي كانت فيها المنطقة الأقل سعراً على مستوى الشركة">مرات الأدنى</th>
                )}
                <th title={`أيام كميتها أقل من ${data.meta.min_qty} وحدة — مستبعدة من الأدنى/الأعلى`}>أيام ضعيفة</th>
                <th title="أيام صافي إيرادها سالب (يغلب عليها المرتجع) — لا تُحتسب سعراً">أيام مرتجع</th>
              </tr>
            </thead>
            <tbody>
              {(data.region_totals || []).map(t => {
                const below = data.totals.asp != null && t.asp != null && t.asp < data.totals.asp;
                return (
                  <tr key={t.branch}>
                    <td><bdi>{t.branch}</bdi></td>
                    <td>{t.days}</td>
                    <td>{fmt(t.qty)}</td>
                    <td>
                      <bdi className={below ? 'rp-neg' : 'rp-pos'}>{t.asp != null ? t.asp.toFixed(2) : '—'}</bdi>
                      {below && <span className="rp-below-tag" title="أقل من المتوسط العام للشركة">↓</span>}
                    </td>
                    <td>{t.min_asp != null
                      ? <bdi title={t.min_date}>{t.min_asp.toFixed(2)}</bdi> : <span className="rp-muted">—</span>}</td>
                    <td>{t.max_asp != null
                      ? <bdi title={t.max_date}>{t.max_asp.toFixed(2)}</bdi> : <span className="rp-muted">—</span>}</td>
                    {data.meta.rank_lowest && (
                      <td>{t.lowest_days > 0
                        ? <bdi className="rp-neg">{t.lowest_days}</bdi> : <span className="rp-muted">0</span>}</td>
                    )}
                    <td>{t.thin_days > 0
                      ? <bdi className="rp-muted">{t.thin_days}</bdi> : <span className="rp-muted">0</span>}</td>
                    <td>{t.negative_days > 0
                      ? <bdi className="rp-ret" title="صافي الإيراد سالب — يوم مرتجعات">{t.negative_days}</bdi>
                      : <span className="rp-muted">0</span>}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>الإجمالي</td>
                <td>{data.totals.days}</td>
                <td>{fmt(data.totals.qty)}</td>
                <td>{data.totals.asp != null ? data.totals.asp.toFixed(2) : '—'}</td>
                <td colSpan={data.meta.rank_lowest ? 5 : 4} />
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="rp-ctrl-hint" style={{ marginTop: 8 }}>
          كل متوسط هنا مرجّح بالكمية (إجمالي القيمة ÷ إجمالي الكمية) وليس متوسطاً حسابياً للأيام —
          حتى لا يتساوى يوم بـ300 وحدة مع يوم بـ30,000 وحدة، ولتطابق الأرقام بقية صفحات النظام.
          {!data.meta.rank_lowest && (
            <> رصد «الأدنى يومياً» مخفي لأن النطاق الحالي يضم منطقة واحدة فقط — لا يوجد ما تُقارن به. </>
          )}
          «مرات الأدنى» تُحتسب فقط بين المناطق التي تجاوزت {data.meta.min_qty} وحدة في اليوم نفسه؛
          الأيام الأقل من ذلك تظهر في الشبكة بعلامة «؟» وتُستبعد من الأدنى/الأعلى ومن ترتيب الأدنى.
          كذلك تُستبعد أيام المرتجعات (صافي إيراد سالب) من كل ترتيب: قيمتها ليست سعراً، ولو تُركت
          لفازت بلقب «الأدنى» دائماً لأن لا سعر حقيقي يقلّ عن رقم سالب — وتظهر بلون مميز في الشبكة
          وبعمود مستقل في الجدول أدناه.
        </div>
      </>)}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MISSING SALES CHANNELS (قنوات بيع بلا تاريخ في المنطقة)

   A region that has never sold to, say, Groceries cannot reach that channel
   through the mix tilt — the tilt is multiplicative and zero stays zero. This
   panel lets the planner enter the channel explicitly: pick it, state the
   share it should reach by the end of the plan, and confirm the price. The
   price defaults to the cross-region benchmark (what another region actually
   achieves on that channel) because this region has no achieved price to use.
═══════════════════════════════════════════════════════════ */
function MissingChannels({ allChannels, model, plan, added, setAdded, benchmarks }) {
  const [pick, setPick] = useState('');

  const benchOf = useMemo(() => {
    const m = {};
    (benchmarks || []).forEach(b => { m[b.name] = b; });
    return m;
  }, [benchmarks]);

  /* A channel is "missing" when the region has no trading history for it.
     model.cats already excludes zero-quantity categories, so anything in the
     company-wide list that isn't there has nothing to grow from. */
  const present = new Set((model?.cats || []).filter(c => !c.is_new).map(c => c.name));
  const missing = (allChannels || []).filter(n => !present.has(n) && !(n in added));

  const benchPrice = name => {
    const b = benchOf[name];
    const v = b ? Number(b.asp ?? b.asp_all) : NaN;
    return Number.isFinite(v) && v > 0 ? +v.toFixed(2) : null;
  };

  const addChannel = () => {
    if (!pick) return;
    setAdded(prev => ({ ...prev, [pick]: { share: 5, price: benchPrice(pick) } }));
    setPick('');
  };
  const patch = (name, field, raw) => setAdded(prev => {
    const v = parseFloat(raw);
    return { ...prev, [name]: { ...prev[name], [field]: Number.isFinite(v) ? v : '' } };
  });
  const remove = name => setAdded(prev => { const n = { ...prev }; delete n[name]; return n; });

  const addedNames = Object.keys(added);
  const rowOf = name => (plan?.rows || []).find(r => r.name === name);

  return (
    <div className="rp-newchan">
      <div className="rp-newchan__head">
        <span className="rp-newchan__title">إضافة قناة بيع غير موجودة بالمنطقة</span>
        <span className="rp-newchan__sub">
          للقنوات التي لا يوجد لها تاريخ بيعي هنا — تدخل الخطة بحصة مستهدفة وسعر، لأن إعادة توزيع
          المزيج وحدها لا يمكنها تحريك قناة كميتها صفر.
        </span>
      </div>

      <div className="rp-newchan__add">
        <select value={pick} onChange={e => setPick(e.target.value)} disabled={!missing.length}>
          <option value="">
            {missing.length ? '— اختر قناة —' : 'كل القنوات لها تاريخ بيعي بالفعل'}
          </option>
          {missing.map(n => (
            <option key={n} value={n}>
              {n}{benchPrice(n) != null ? ` — سعر مرجعي ${benchPrice(n)} ر.س` : ' — لا يوجد سعر مرجعي'}
            </option>
          ))}
        </select>
        <button className="rp-mini-btn rp-mini-btn--on" onClick={addChannel} disabled={!pick}>
          ＋ إضافة
        </button>
      </div>

      {addedNames.length > 0 && (
        <table className="rp-newchan__table">
          <thead>
            <tr>
              <th>القناة</th><th>الحصة المستهدفة %</th><th>السعر (ASP)</th>
              <th>المصدر المرجعي</th><th>الكمية المستهدفة</th><th />
            </tr>
          </thead>
          <tbody>
            {addedNames.map(name => {
              const r = rowOf(name);
              const b = benchOf[name];
              return (
                <tr key={name}>
                  <td><bdi>🆕 {name}</bdi></td>
                  <td>
                    <input type="number" min="0" max="90" step="0.5"
                           value={added[name]?.share ?? ''}
                           onChange={e => patch(name, 'share', e.target.value)} />
                  </td>
                  <td>
                    <input type="number" min="0" step="0.01"
                           value={added[name]?.price ?? ''}
                           onChange={e => patch(name, 'price', e.target.value)} />
                  </td>
                  <td className="rp-newchan__src">
                    {b ? (b.asp != null ? <bdi>{b.branch} · {fmt(b.asp, 2)}</bdi>
                                        : <bdi>كل المناطق · {fmt(b.asp_all, 2)}</bdi>)
                       : <span className="rp-neg">لا يوجد — أدخل السعر يدوياً</span>}
                  </td>
                  <td>{r ? fmt(Math.round(r.new_qty)) : '—'}</td>
                  <td>
                    <button className="rp-mini-btn" onClick={() => remove(name)} title="إزالة">✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {plan?.reserved_pct > 0 && (
        <div className="rp-ctrl-hint" style={{ marginTop: 6 }}>
          القنوات المضافة تحجز <strong>{plan.reserved_pct.toFixed(1)}%</strong> من إجمالي الكمية،
          وتُخصم هذه النسبة من باقي القنوات بالتناسب مع حصصها (لا تُضاف كميات جديدة — الإجمالي الشهري
          ثابت كما هو في جدول التوقعات). حصة القناة الجديدة تتدرّج من صفر إلى المستهدف على مدى أشهر الخطة.
          {plan.reserved_pct >= 89.9 && (
            <span className="rp-neg"> الحد الأقصى المسموح 90% حمايةً للنشاط القائم.</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   PERIOD COMPARISON (مقارنة بين فترتين)

   A region × metric matrix comparing two arbitrary DATE ranges. It is
   deliberately independent of the page's year/month sliders — the whole
   point is comparing ranges the month filter cannot express (e.g. the first
   three weeks of two different months, or a promo window against its
   equivalent last year). The branch / customer-category / item-category
   filters DO still apply, so the tab answers the same scope as the rest of
   the page.

   Each metric shows: الفترة الأولى · الفترة الثانية · الفرق · نسبة النمو.
   Growth is (B−A)/A, and is "—" when A is zero — a region that sold nothing
   in the first period has no growth rate, and rendering ∞ or 100% would be
   a lie in a table people read as a scoreboard.
═══════════════════════════════════════════════════════════ */
const CMP_METRICS = [
  { key: 'qty',       label: 'صافي الكميات',  fmt: v => fmt(v),          hint: 'مجموع الكميات بعد المرتجع (SUM qty)' },
  /* Damage columns carry two lines: the unit count and its value. The value
     beside التوالف is DERIVED (units × that row's own ASP) because
     sales_activity books no revenue for returns — that is why it is labelled
     تقديرية. توالف الجودة is the opposite: its report gives a real cost, and
     the quantity is the secondary line. */
  { key: 'damages',   label: 'التوالف',        fmt: v => fmt(v),          invert: true,
    sub: 'damages_value', subFmt: v => fmtM(v), subUnit: 'ر.س',
    hint: 'كميات التوالف من تقرير المبيعات (bad_return_qty). السطر الثاني = قيمتها بالريال، محسوبة بسعر الوحدة المسجّل على سطر المرتجع نفسه — وليست تقديراً بمتوسط السعر.' },
  { key: 'qi_cost',   label: 'توالف الجودة',   fmt: v => fmtM(v),         invert: true,
    sub: 'qi_qty', subFmt: v => fmt(v), subUnit: 'وحدة',
    hint: 'تكلفة توالف الجودة بالريال من التقرير المرفوع. السطر الثاني = الكمية (وحدات) من نفس التقرير.' },
  { key: 'customers', label: 'العملاء',        fmt: v => fmt(v),          hint: 'عدد العملاء الذين تعاملوا خلال الفترة (عملاء مميزون)' },
  { key: 'avg_visits_per_day', label: 'متوسط الزيارات اليومية',
    fmt: v => (v == null ? '—' : Number(v).toFixed(1)),
    hint: 'إجمالي الزيارات (زيارة = مندوب + عميل + يوم مختلف) ÷ أيام عمل المندوب الفعلية خلال الفترة — وليس عدد أيام التقويم', dec: 1 },
  { key: 'revenue',   label: 'قيمة المبيعات',  fmt: v => fmtM(v),         hint: 'صافي الإيراد (net_revenue)' },
  { key: 'asp',       label: 'متوسط السعر',    fmt: v => (v == null ? '—' : Number(v).toFixed(2)),
    hint: 'القيمة ÷ الكمية — متوسط مرجّح، وليس متوسط متوسطات', dec: 2 },
];

/* diff cell: same colour logic as the growth cell so a row reads consistently.
   It formats with the metric's OWN formatter — a difference of 55,431 units
   must not be abbreviated to "55.4ك" when the two values beside it are shown
   in full. */
function CmpDelta({ value, invert, format = fmt }) {
  if (value == null || !Number.isFinite(Number(value))) return <span className="rp-muted">—</span>;
  const v = Number(value);
  if (v === 0) return <span className="rp-muted">0</span>;
  const good = invert ? v < 0 : v > 0;
  return <bdi className={good ? 'rp-pos' : 'rp-neg'}>{v > 0 ? '+' : '−'}{format(Math.abs(v))}</bdi>;
}

function CmpGrowth({ value, invert }) {
  if (value == null || !Number.isFinite(Number(value))) return <span className="rp-muted">—</span>;
  const v = Number(value);
  const good = invert ? v < 0 : v > 0;
  const cls = v === 0 ? 'rp-muted' : good ? 'rp-pos' : 'rp-neg';
  return <bdi className={cls}>{v > 0 ? '+' : ''}{v.toFixed(1)}%</bdi>;
}

/* Column widths. A metric whose cells carry two stacked figures needs more
   room than a single-number one — "+1,969" over "+18.2ك" does not fit the
   46px a plain growth cell is happy with. Kept here (not in CSS) so the
   colgroup and the table's min-width can never drift apart. */
const CMP_NAME_W   = 100;                    // "Al Duwadmi ‹" without clipping
/* النمو% is the widest short cell in practice ("+462.2%"), so it keeps as
   much room as الفرق even though it holds fewer characters on average. */
const CMP_W_PLAIN  = [47, 47, 44, 44];       // ف1 · ف2 · الفرق · النمو%
const CMP_W_STACKED= [53, 53, 52, 50];
const colWidths = m => (m.sub ? CMP_W_STACKED : CMP_W_PLAIN);
const CMP_TABLE_WIDTH = CMP_NAME_W +
  CMP_METRICS.reduce((s, m) => s + colWidths(m).reduce((a, b) => a + b, 0), 0);

/* One matrix cell. Metrics with a `sub` render two stacked lines (كمية /
   قيمة) inside the SAME column, so adding the second figure does not widen a
   table that already carries 29 columns. Pass either `t` (a period bucket) or
   `d` + kind ('diff' | 'growth'). */
function CmpCell({ m, t, d, kind }) {
  const line = (key, format) => {
    if (t) return format(t[key]);
    const v = d[`${key}_${kind === 'growth' ? 'growth' : 'diff'}`];
    return kind === 'growth'
      ? <CmpGrowth value={v} invert={m.invert} />
      : <CmpDelta  value={v} invert={m.invert} format={format} />;
  };
  if (!m.sub) return line(m.key, m.fmt);
  return (
    <span className="rp-cmp-2l">
      <span className="rp-cmp-2l__main">{line(m.key, m.fmt)}</span>
      <span className="rp-cmp-2l__sub">{line(m.sub, m.subFmt)}</span>
    </span>
  );
}

const iso = d => d.toISOString().slice(0, 10);

/* Presets exist because the two most common questions — "هذا الشهر مقابل
   الماضي" and "نفس الفترة من العام الماضي" — otherwise cost four manual
   date picks each time. */
function comparePresets() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();     // m is 0-based
  const first = (yy, mm) => new Date(Date.UTC(yy, mm, 1));
  const last  = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0));
  return [
    { key: 'mom', label: 'الشهر الحالي مقابل السابق',
      a: [iso(first(y, m - 1)), iso(last(y, m - 1))],
      b: [iso(first(y, m)),     iso(last(y, m))] },
    { key: 'yoy', label: 'الشهر الحالي مقابل نفسه العام الماضي',
      a: [iso(first(y - 1, m)), iso(last(y - 1, m))],
      b: [iso(first(y, m)),     iso(last(y, m))] },
    { key: 'q', label: 'آخر 3 أشهر مقابل التي قبلها',
      a: [iso(first(y, m - 6)), iso(last(y, m - 4))],
      b: [iso(first(y, m - 3)), iso(last(y, m - 1))] },
    { key: 'ytd', label: 'هذا العام حتى اليوم مقابل العام الماضي',
      a: [iso(first(y - 1, 0)), iso(new Date(Date.UTC(y - 1, m, now.getDate())))],
      b: [iso(first(y, 0)),     iso(new Date(Date.UTC(y, m, now.getDate())))] },
  ];
}

function PeriodCompareTab({ branch, branchParams, custCatParams, itemCatParams }) {
  const presets = useMemo(comparePresets, []);
  const [pA, setPA] = useState(() => presets[0].a);
  const [pB, setPB] = useState(() => presets[0].b);
  /* sort keys are "<metric>:<a|b|diff|growth>" (or the bare "branch") — the
     part is not optional, it names which of the four cells to read */
  const [sort, setSort] = useState({ col: 'revenue:b', dir: 'desc' });
  /* null = region level; a region name = drilled into that region's reps */
  const [drill, setDrill] = useState(null);

  const valid = pA[0] && pA[1] && pB[0] && pB[1] && pA[0] <= pA[1] && pB[0] <= pB[1];

  /* Drilling REPLACES the branch scope with the one region being drilled, so
     the reps listed are exactly that region's. */
  const scopeBranches = drill ? [drill] : branchParams;

  const params = new URLSearchParams({ a_from: pA[0], a_to: pA[1], b_from: pB[0], b_to: pB[1] });
  if (drill) params.set('group', 'rep');
  scopeBranches.forEach(b => params.append('branch', b));
  custCatParams.forEach(c => params.append('cust_category', c));
  itemCatParams.forEach(c => params.append('item_category', c));

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['rp-compare', pA.join('~'), pB.join('~'), drill || '', scopeBranches.join('|'), custCatParams.join('|'), itemCatParams.join('|')],
    queryFn: () => client.get(`/region-performance/period-compare?${params}`).then(r => r.data),
    enabled: !!valid,
    staleTime: 2 * 60 * 1000,
  });
  const isRepLevel = data?.group === 'rep';

  /* A region name that disappears from the filters (or a stale drill left
     behind by a filter change) must not strand the user on an empty table. */
  const branchKey = branchParams.join('|');
  useEffect(() => {
    if (drill && branchParams.length && !branchParams.includes(drill)) setDrill(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drill, branchKey]);

  const rows = useMemo(() => {
    const list = [...(data?.rows || [])];
    const { col, dir } = sort;
    const s = dir === 'asc' ? 1 : -1;
    list.sort((x, y) => {
      if (col === 'branch') return s * String(x.name).localeCompare(String(y.name), 'ar');
      const [m, part] = col.split(':');
      const get = r => part === 'growth' ? r.delta[`${m}_growth`]
                     : part === 'diff'   ? r.delta[`${m}_diff`]
                     : (r[part] ? r[part][m] : null);
      const xv = get(x), yv = get(y);
      if (xv == null && yv == null) return 0;
      if (xv == null) return 1;            // nulls always last, both directions
      if (yv == null) return -1;
      return s * (Number(xv) - Number(yv));
    });
    return list;
  }, [data, sort]);

  const onSort = col => setSort(p => ({ col, dir: p.col === col && p.dir === 'desc' ? 'asc' : 'desc' }));
  const sortCls = col => `rp-cmp-sortable${sort.col === col ? ' rp-cmp-sorted' : ''}`;
  const T = data?.totals;

  const setDate = (which, idx, v) =>
    (which === 'a' ? setPA : setPB)(prev => { const n = [...prev]; n[idx] = v; return n; });

  const applyPreset = p => { setPA(p.a); setPB(p.b); };
  const activePreset = presets.find(p =>
    p.a[0] === pA[0] && p.a[1] === pA[1] && p.b[0] === pB[0] && p.b[1] === pB[1]);

  return (
    <div className="rp-tab-content">
      <div className="rp-section-title">تحديد الفترتين</div>

      <div className="rp-cmp-presets rp-no-print">
        {presets.map(p => (
          <button key={p.key}
                  className={`rp-mini-btn${activePreset?.key === p.key ? ' rp-mini-btn--on' : ''}`}
                  onClick={() => applyPreset(p)}>{p.label}</button>
        ))}
      </div>

      <div className="rp-cmp-ranges">
        <div className="rp-cmp-range rp-cmp-range--a">
          <span className="rp-cmp-range__tag">الفترة الأولى</span>
          <label>من<input type="date" value={pA[0]} onChange={e => setDate('a', 0, e.target.value)} /></label>
          <label>إلى<input type="date" value={pA[1]} onChange={e => setDate('a', 1, e.target.value)} /></label>
          {data && <span className="rp-cmp-range__days">{data.periods.a.days} يوم</span>}
        </div>
        <div className="rp-cmp-range rp-cmp-range--b">
          <span className="rp-cmp-range__tag">الفترة الثانية</span>
          <label>من<input type="date" value={pB[0]} onChange={e => setDate('b', 0, e.target.value)} /></label>
          <label>إلى<input type="date" value={pB[1]} onChange={e => setDate('b', 1, e.target.value)} /></label>
          {data && <span className="rp-cmp-range__days">{data.periods.b.days} يوم</span>}
        </div>
      </div>

      {!valid && <div className="rp-error">تاريخ «من» يجب أن يسبق «إلى» في كلتا الفترتين.</div>}

      {data?.periods?.overlap && (
        <div className="rp-legend rp-cmp-warn">
          ⚠ الفترتان متداخلتان — الأيام المشتركة تُحتسب ضمن الفترة الأولى فقط، لذلك ستقرأ الفترة الثانية أقل من حقيقتها.
        </div>
      )}
      {data && data.periods.a.days !== data.periods.b.days && (
        <div className="rp-legend">
          ℹ طول الفترتين مختلف ({data.periods.a.days} مقابل {data.periods.b.days} يوم) — الفروق ونسب النمو هنا مطلقة
          وليست معدّلة حسب عدد الأيام.
        </div>
      )}

      {isLoading && <div className="rp-loading"><div className="rp-spinner"/><span>جاري حساب المقارنة…</span></div>}
      {isError && !isLoading && (
        <div className="rp-error">تعذّر جلب المقارنة{error?.response?.data?.error ? ` — ${error.response.data.error}` : ''}.</div>
      )}

      {data && !isLoading && (<>
        <div className="rp-section-title rp-section-title--row">
          {drill ? (<>
            <button className="rp-mini-btn rp-cmp-back" onClick={() => setDrill(null)}>
              ↩ رجوع لمستوى المناطق
            </button>
            <span>مصفوفة المقارنة بمناديب <bdi>{drill}</bdi></span>
          </>) : (
            <span>مصفوفة المقارنة بالمناطق <span className="rp-cmp-hint-inline">— اضغط اسم المنطقة لعرض مناديبها</span></span>
          )}
        </div>
        <div className="rp-mtable-wrap">
          <table className="rp-mtable rp-mtable--dense rp-mtable--cmp"
                 style={{ minWidth: CMP_TABLE_WIDTH }}>
            <colgroup>
              {/* 1 + 7×4 = 29 cols, summing to the table's CSS min-width
                  (CMP_TABLE_WIDTH). The two damage groups get wider columns
                  because their cells carry two stacked figures. */}
              <col style={{ width: CMP_NAME_W }} />
              {CMP_METRICS.map(m => (
                <React.Fragment key={m.key}>
                  {colWidths(m).map((w, i) => <col key={i} style={{ width: w }} />)}
                </React.Fragment>
              ))}
            </colgroup>
            <thead>
              <tr>
                <th rowSpan={2} className={sortCls('branch')} onClick={() => onSort('branch')}>
                  {isRepLevel ? 'المندوب' : 'المنطقة'}
                </th>
                {CMP_METRICS.map(m => (
                  <th key={m.key} colSpan={4} className="rp-cmp-group" title={m.hint}>
                    {m.label}
                    {m.sub && <span className="rp-cmp-group__units">
                      {m.key === 'damages' ? 'كمية · قيمة' : 'قيمة · كمية'}
                    </span>}
                  </th>
                ))}
              </tr>
              <tr>
                {CMP_METRICS.map(m => (
                  <React.Fragment key={m.key}>
                    <th className={sortCls(`${m.key}:a`)} onClick={() => onSort(`${m.key}:a`)} title="الفترة الأولى">ف1</th>
                    <th className={sortCls(`${m.key}:b`)} onClick={() => onSort(`${m.key}:b`)} title="الفترة الثانية">ف2</th>
                    <th className={sortCls(`${m.key}:diff`)} onClick={() => onSort(`${m.key}:diff`)}>الفرق</th>
                    <th className={sortCls(`${m.key}:growth`)} onClick={() => onSort(`${m.key}:growth`)}>النمو%</th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.name}>
                  <td>
                    {isRepLevel
                      ? <bdi>{r.name}</bdi>
                      : <button className="rp-cmp-drill" onClick={() => setDrill(r.name)}
                                title={`عرض مناديب ${r.name}`}>
                          <bdi>{r.name}</bdi> <span aria-hidden="true">‹</span>
                        </button>}
                  </td>
                  {CMP_METRICS.map(m => (
                    <React.Fragment key={m.key}>
                      <td className="rp-cmp-a"><CmpCell m={m} t={r.a} /></td>
                      <td className="rp-cmp-b"><CmpCell m={m} t={r.b} /></td>
                      <td><CmpCell m={m} d={r.delta} kind="diff" /></td>
                      <td><CmpCell m={m} d={r.delta} kind="growth" /></td>
                    </React.Fragment>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={1 + CMP_METRICS.length * 4} className="rp-muted">لا توجد بيانات في أي من الفترتين.</td></tr>
              )}
            </tbody>
            {T && (
              <tfoot>
                <tr>
                  <td>الإجمالي</td>
                  {CMP_METRICS.map(m => (
                    <React.Fragment key={m.key}>
                      <td><CmpCell m={m} t={T.a} /></td>
                      <td><CmpCell m={m} t={T.b} /></td>
                      <td><CmpCell m={m} d={T.delta} kind="diff" /></td>
                      <td><CmpCell m={m} d={T.delta} kind="growth" /></td>
                    </React.Fragment>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div className="rp-ctrl-hint" style={{ marginTop: 8 }}>
          ف1 = الفترة الأولى ({data.periods.a.from} ← {data.periods.a.to}) ·
          ف2 = الفترة الثانية ({data.periods.b.from} ← {data.periods.b.to}) ·
          الفرق = ف2 − ف1 · النمو% = (ف2 − ف1) ÷ ف1.
          في «التوالف» و«توالف الجودة» الانخفاض هو الأفضل، لذلك يظهر بالأخضر.
          كل خلية في العمودين سطران: «التوالف» = الكمية ثم قيمتها بالريال، مسعّرة بسعر الوحدة
          على سطر المرتجع نفسه (لا بمتوسط السعر)، ولذلك تتطابق عند التنقّل بين مستوى المناطق
          ومستوى المناديب. و«توالف الجودة» = التكلفة ثم الكمية، وكلتاهما من التقرير المرفوع مباشرة.
          إجمالي «العملاء» عدد مميز على المستوى الأعلى وليس مجموع الصفوف —
          العميل الذي يتعامل مع صفّين يُحتسب مرة واحدة في الإجمالي ومرة في كل صف.
          {isRepLevel && (
            <> <strong>على مستوى المناديب:</strong> «توالف الجودة» غير متاح لكل مندوب —
               التقرير المرفوع يسجّل المنطقة فقط ولا يحمل بُعد المندوب، لذلك تظهر الخلايا «—»
               ويبقى إجمالي المنطقة في صف الإجمالي.</>
          )}
          {(() => {
            const u = data.unattributed || { a: {}, b: {} };
            const any = ['a','b'].some(k => (u[k]?.qi_cost > 0));
            if (!any) return null;
            const rowWord = isRepLevel ? 'المناديب' : 'المناطق';
            return (
              <> غير موزّع على {rowWord}
                 {' '}— توالف جودة{isRepLevel ? ' (إجمالي المنطقة)' : ''}:
                 ف1 {fmtM(u.a?.qi_cost || 0)} · ف2 {fmtM(u.b?.qi_cost || 0)} ر.س.
                 هذا المبلغ مضاف إلى صف الإجمالي فقط، لذلك مجموع الصفوف أقل من الإجمالي بهذا المقدار.
              </>
            );
          })()}
        </div>
      </>)}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
═══════════════════════════════════════════════════════════ */
export default function RegionPerformancePage() {
  const { user } = useAuth();
  const canPlan = !PLAN_HIDDEN_ROLES.includes(user?.role);

  /* ── Filters ── */
  const [branch, setBranch]       = useState('');
  const [year, setYear]           = useState(2026);
  const [fromMonth, setFromMonth] = useState(1);
  const [toMonth, setToMonth]     = useState(6);
  /* Day bounds inside the first / last selected month. 1 → 31 means whole
     months, and then nothing about the request changes. */
  const [fromDay, setFromDay]     = useState(1);
  const [toDay, setToDay]         = useState(31);
  /* Kept sales channels; empty = الكل (see CustCatPicker). */
  const [custCats, setCustCats]   = useState([]);
  const [excludeHafr, setExcludeHafr] = useState(false);
  const [showColRef, setShowColRef]   = useState(false);
  /* Item categories switched OUT of the readings. Stored as the EXCLUDED set so
     a category added to the catalogue later is included by default. */
  const [excludedItemCats, setExcludedItemCats] = useState([]);
  const [activeTab, setActiveTab] = useState('assess');
  /* Safety net: the planning tab is filtered out of the tab bar for the roles
     that may not see it, so this only fires if something else sets the tab —
     without it the page would render an empty body instead of falling back. */
  useEffect(() => {
    if (activeTab === 'plan' && !canPlan) setActiveTab('assess');
  }, [activeTab, canPlan]);

  const [repMatrixMetric, setRepMatrixMetric] = useState('revenue'); // 'revenue' | 'qty' | 'both'
  const [planMetric, setPlanMetric] = useState('revenue');           // 'revenue' | 'qty' | 'both' — plan tab tables
  const [repSort, setRepSort]   = useState({ col: 'revenue', dir: 'desc' });
  const [itemSort, setItemSort] = useState({ col: 'revenue', dir: 'desc' });
  const onRepSort  = useCallback(c => setRepSort(s => ({ col: c, dir: s.col === c && s.dir === 'desc' ? 'asc' : 'desc' })), []);
  const onItemSort = useCallback(c => setItemSort(s => ({ col: c, dir: s.col === c && s.dir === 'desc' ? 'asc' : 'desc' })), []);

  /* ── Planning inputs ── */
  const [growthPct, setGrowthPct]           = useState(3);
  const [newReps, setNewReps]               = useState(0);
  const [newRepsStart, setNewRepsStart]     = useState(7);
  const [newRoutes, setNewRoutes]           = useState(0);
  const [newRoutesStart, setNewRoutesStart] = useState(7);
  const [linkRepRoute, setLinkRepRoute]     = useState(true);
  const [newRepCapEnabled, setNewRepCapEnabled] = useState(true);
  const [newRepQtyCap, setNewRepQtyCap]     = useState(NEW_REP_QTY_CAP_DEFAULT);
  const [includeVisitUplift, setIncludeVisitUplift] = useState(false);
  const [targetVpd, setTargetVpd]           = useState(12);
  const [visitRealization, setVisitRealization] = useState(70);
  const [scenario, setScenario]             = useState('custom');
  /* ASP-based planning: target a blended average selling price and derive
     the customer-category (sales-channel) mix shift that reaches it. */
  const [includeAspPlan, setIncludeAspPlan] = useState(false);
  const [targetAsp, setTargetAsp]           = useState(null); // null → seeded from actuals
  const [aspFocusMode, setAspFocusMode]     = useState(true); // steer growth into ASP_FOCUS_PRIORITY
  // Raw text of the manual ASP box. Kept separate from targetAsp so typing
  // "1" on the way to "14.5" isn't instantly clamped to the range minimum —
  // the value is only parsed and committed on blur/Enter.
  const [aspInput, setAspInput]             = useState('');
  const [baseFloorPct, setBaseFloorPct]     = useState(ASP_BASE_FLOOR_DEFAULT);
  const [minKeepPct, setMinKeepPct]         = useState(ASP_MIN_KEEP_DEFAULT);
  const [baseMinPct, setBaseMinPct]         = useState(ASP_BASE_MIN_DEFAULT);
  /* Per-channel ceilings: { [channelName]: pct }. A key being present is
     what turns that channel's cap on, so one object carries both the
     on/off state and the value, and serializes straight into the saved
     plan. */
  const [channelCaps, setChannelCaps]       = useState({});
  // Channels the user has switched OFF: they sit out of the methodology
  // entirely and simply keep their current share.
  const [excludedChannels, setExcludedChannels] = useState([]);
  /* Manual per-channel price overrides: { channelName: number }. An entry here
     replaces whatever the model would otherwise use (local ASP, or the pinned
     cross-region benchmark), so the whole forecast re-prices on it. */
  const [priceOverrides, setPriceOverrides] = useState({});
  /* Sales channels the region has NO trading history for, added to the plan by
     hand: { [name]: { share, price } }. A channel with zero quantity can never
     be grown by the multiplicative mix tilt (anything × 0 is 0), so it cannot
     be modelled like the others — it needs a target share stated outright and
     a price, since the region has no achieved price of its own to use. */
  const [newChannels, setNewChannels] = useState({});
  const newChannelsKey = JSON.stringify(newChannels);
  const aspSeededRef = useRef(undefined);
  const baseFloor = Math.max(0, Math.min(95, Number(baseFloorPct) || 0)) / 100;
  const minKeep   = Math.max(0, Math.min(100, Number(minKeepPct) || 0)) / 100;
  const capsKey   = JSON.stringify(Object.keys(channelCaps).sort().map(k => [k, channelCaps[k]]));
  const toggleCap = (name) => setChannelCaps(prev => {
    const next = { ...prev };
    if (name in next) delete next[name]; else next[name] = ASP_CAP_DEFAULT;
    return next;
  });
  const setCapValue = (name, v) => setChannelCaps(prev => ({ ...prev, [name]: v }));
  const baseMin   = Math.max(0, Math.min(50, Number(baseMinPct) || 0)) / 100;
  const excludedKey = excludedChannels.slice().sort().join('|'); // stable memo dep
  const setChannelPrice = useCallback((name, raw) => {
    setPriceOverrides(prev => {
      const next = { ...prev };
      const v = parseFloat(raw);
      if (!Number.isFinite(v) || v <= 0) delete next[name];
      else next[name] = +v.toFixed(2);
      return next;
    });
  }, []);
  const clearChannelPrice = useCallback(name => {
    setPriceOverrides(prev => { const n = { ...prev }; delete n[name]; return n; });
  }, []);
  const clearAllPrices = useCallback(() => setPriceOverrides({}), []);

  const toggleChannel = (name) => setExcludedChannels(prev =>
    prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
  // Lets the user exclude the forecast/scenario results from the printed
  // PDF (e.g. printing just the actual assessment without speculative
  // planning numbers) without leaving the planning tab.
  const [includePlanInPrint, setIncludePlanInPrint] = useState(true);

  /* ── Saved per-region plan ── */
  const [planStatus, setPlanStatus]         = useState(''); // '', 'saving', 'saved', 'error'
  const [planDerived, setPlanDerived]       = useState(null); // set when "الكل" was built from the regions
  const appliedPlanBranchRef = useRef(undefined); // branch we've already applied a saved plan for
  const autoSavedRef = useRef(false);             // one auto-save per branch selection

  const { data: savedPlanData } = useQuery({
    queryKey: ['rp-plan', branch],
    queryFn: () => client.get('/region-performance/plan', { params: { branch } }).then(r => r.data),
    staleTime: 60 * 1000,
  });

  /* All per-region plans — only needed by the "الكل" view, which builds its
     own plan out of them rather than starting from blank defaults. */
  const { data: allPlansData } = useQuery({
    queryKey: ['rp-plans-all'],
    queryFn: () => client.get('/region-performance/plans').then(r => r.data),
    staleTime: 60 * 1000,
    enabled: !branch,
  });

  /* ── Filters query ── */
  const { data: filters } = useQuery({
    queryKey: ['rp-filters'],
    queryFn: () => client.get('/region-performance/filters').then(r => r.data),
    staleTime: 10 * 60 * 1000,
  });

  /* ── Assessment query ── */
  const allBranches = filters?.branches || [];
  // Only meaningful while looking at every region; picking one region already scopes it.
  const excludeActive = excludeHafr && !branch && allBranches.includes(EXCLUDABLE_BRANCH);

  const allItemCats = (filters?.item_categories || []).map(c => c.name);
  // Send the KEEP list; an empty exclusion set sends nothing at all.
  const keptItemCats = allItemCats.filter(c => !excludedItemCats.includes(c));
  const itemCatActive = allItemCats.length > 0 && keptItemCats.length < allItemCats.length;

  /* The branch scope as a list of repeated `branch` params — one entry for a
     picked region, every region except the excluded one when the Hafr toggle
     is on, empty for "الكل". Shared with the period-comparison tab so both
     endpoints are always scoped identically. */
  const branchParams = branch
    ? [branch]
    : (excludeActive ? allBranches.filter(b => b !== EXCLUDABLE_BRANCH) : []);

  const params = new URLSearchParams({ year, from_month: fromMonth, to_month: toMonth });
  if (fromDay > 1) params.set('from_day', fromDay);
  if (toDay < 31)  params.set('to_day', toDay);
  branchParams.forEach(b => params.append('branch', b));
  custCats.forEach(c => params.append('cust_category', c));
  if (itemCatActive) keptItemCats.forEach(c => params.append('item_category', c));

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rp-assessment', branch, year, fromMonth, toMonth, fromDay, toDay, custCats.join('|'), excludeActive, keptItemCats.join('|')],
    queryFn: () => client.get(`/region-performance/assessment?${params}`).then(r => r.data),
    staleTime: 2 * 60 * 1000,
  });

  /* A month change can leave a day that does not exist there (31 → June, 30 →
     February). Clamp instead of resetting, so narrowing to "1–15" survives
     stepping through the months. */
  const fromDayMax = daysInMonth(year, fromMonth);
  const toDayMax   = daysInMonth(year, toMonth);
  useEffect(() => { if (fromDay > fromDayMax) setFromDay(fromDayMax); }, [fromDay, fromDayMax]);
  useEffect(() => { if (toDay < 31 && toDay > toDayMax) setToDay(toDayMax); }, [toDay, toDayMax]);

  const dayClamped = fromDay > 1 || toDay < 31;

  const monthly = data?.monthly || [];
  const totals  = data?.totals || {};
  const current = data?.current || {};
  const gap     = data?.visit_gap || {};
  const trend   = data?.trend || {};
  const scorecard = data?.scorecard || { indicators: [], regions: [], reps: [] };

  /* Per-region detail rows under each month row. */
  const [showMonthRegions, setShowMonthRegions] = useState(false);
  const [openMonths, setOpenMonths] = useState(() => new Set());

  const monthRegions = useMemo(() => {
    const map = new Map();
    (data?.monthly_by_region || []).forEach(r => {
      if (!map.has(r.month_num)) map.set(r.month_num, []);
      map.get(r.month_num).push(r);
    });
    // Biggest region first — that's the one that explains the month.
    map.forEach(list => list.sort((a, b) => (b.revenue || 0) - (a.revenue || 0)));
    return map;
  }, [data]);

  // The header button drives every month at once; the per-row +/− still works after.
  useEffect(() => {
    setOpenMonths(showMonthRegions ? new Set(monthRegions.keys()) : new Set());
  }, [showMonthRegions, monthRegions]);

  /* Below-average alerting is scoped to ASP only.
     "المتوسط العام" = the volume-weighted blended ASP of the whole period
     (total revenue ÷ total qty), NOT the plain mean of the region ASPs — a
     mean would let a tiny region with a freak price skew the benchmark. */
  const [highlightBelow, setHighlightBelow] = useState(true);

  const aspBenchmark = useMemo(() => {
    const rows = data?.monthly_by_region || [];
    const q = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    const v = rows.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
    return q > 0 ? v / q : null;
  }, [data]);

  /* مفقودون compares each month to the one before it — for the first row that
     month lies OUTSIDE the selected range, so say which one it was. */
  const churnHint = useMemo(() => {
    const b = data?.churn_baseline;
    if (!b) return '«مفقودون» = تعاملوا الشهر السابق ولم يتعاملوا هذا الشهر.';
    return b.has_data
      ? `«مفقودون» = تعاملوا الشهر السابق ولم يتعاملوا هذا الشهر — والشهر الأول في النطاق يُقارن بـ${b.month_name} ${b.year} خارج النطاق المختار.`
      : `«مفقودون» = تعاملوا الشهر السابق ولم يتعاملوا هذا الشهر — ولا توجد بيانات لـ${b.month_name} ${b.year}، لذلك يظهر «—» في الشهر الأول من النطاق.`;
  }, [data]);

  /* جدد / عائدون are first-appearances, so they SUM across months; مفقودون is
     a per-month event and sums too. Averaging any of them would be wrong. */
  const churnTotals = useMemo(() => monthly.reduce((a, m) => ({
    new:       a.new       + (m.new_customers       || 0),
    returning: a.returning + (m.returning_customers || 0),
    lost:      a.lost      + (m.lost_customers      || 0),
  }), { new: 0, returning: 0, lost: 0 }), [monthly]);

  /* The company ASP target, taken from the scorecard indicator that scores it. */
  const aspCompanyTarget = useMemo(() => {
    const ind = (data?.scorecard?.indicators || []).find(i => i.key === 'asp');
    return ind?.floorValue != null ? Number(ind.floorValue) : ASP_COMPANY_TARGET_FALLBACK;
  }, [data]);

  const aspIsWeak = useCallback(asp => (
    highlightBelow && aspBenchmark != null && asp != null &&
    Number.isFinite(Number(asp)) && Number(asp) < aspBenchmark
  ), [highlightBelow, aspBenchmark]);

  /* Daily throughput. Two different denominators answer two questions:
       · per WORKING DAY  → what the region ships on an average selling day
       · per REP-DAY      → what one rep ships on a day they actually worked
     Working days come from the reported months only, so a range reaching into
     the future does not dilute the average. */
  const daily = useMemo(() => {
    const reported = monthly.filter(m => m.has_data);
    const wd = reported.reduce((s, m) => s + (Number(m.working_days) || 0), 0);
    const rd = Number(totals.rep_days) || 0;
    const qty = Number(totals.qty) || 0;
    const kg  = Number(totals.qty_kg) || 0;
    return {
      working_days: wd,
      qty_per_day:     wd > 0 ? qty / wd : null,
      kg_per_day:      wd > 0 ? kg  / wd : null,
      qty_per_rep_day: rd > 0 ? qty / rd : null,
    };
  }, [monthly, totals]);

  /* Quantity share. The denominator differs by row on purpose: a month is a
     slice of the whole period, a region is a slice of its own month — which is
     what makes the region rows sum to 100% under each month. */
  const qtyShare = useCallback((part, whole) => {
    const w = Number(whole) || 0;
    if (!w) return '—';
    return `${((Number(part) || 0) / w * 100).toFixed(1)}%`;
  }, []);

  const toggleMonthRegions = useCallback(m => setOpenMonths(prev => {
    const next = new Set(prev);
    next.has(m) ? next.delete(m) : next.add(m);
    return next;
  }), []);

  /* Trend-implied monthly growth becomes the default / scenario anchor. */
  const trendGrowth = trend?.revenue?.slope_pct ?? null;
  const scenarioGrowth = useMemo(() => {
    const base = trendGrowth != null ? trendGrowth : 3;
    const clamp = v => Math.max(0, Math.min(30, +v.toFixed(1)));
    return {
      conservative: clamp(base * 0.5),
      balanced:     clamp(base < 1 ? 3 : base),
      ambitious:    clamp((base < 1 ? 3 : base) * 2 + 2),
    };
  }, [trendGrowth]);

  /* Company-wide plan assembled from the individual regions.
     Headcount adds up (12 new reps across the regions IS 12 nationally),
     while every rate is a QUANTITY-WEIGHTED average — a plain mean would let
     a region selling 3k units pull the national growth rate as hard as one
     selling 1.4M. Switches follow the weighted majority for the same reason. */
  const aggregatedAllPlan = useMemo(() => {
    const plans = (allPlansData?.plans || []).filter(x => x.plan && typeof x.plan === 'object');
    if (!plans.length) return null;

    // Weight = the region's own quantity over the period; falls back to 1 each
    // so the aggregate still works before the assessment has loaded.
    const qtyByBranch = {};
    (data?.monthly_by_region || []).forEach(r => {
      qtyByBranch[r.branch] = (qtyByBranch[r.branch] || 0) + (Number(r.qty) || 0);
    });
    const weighted = plans.map(x => ({ ...x, w: Math.max(0, qtyByBranch[x.branch] || 0) }));
    const wSum = weighted.reduce((s, x) => s + x.w, 0);
    const useW = wSum > 0;

    const sum = (key, dflt = 0) =>
      weighted.reduce((s, x) => s + (Number(x.plan[key] ?? dflt) || 0), 0);
    const avg = (key, dflt) => {
      const rows = weighted.filter(x => x.plan[key] != null && Number.isFinite(Number(x.plan[key])));
      if (!rows.length) return dflt;
      if (!useW) return +(rows.reduce((s, x) => s + Number(x.plan[key]), 0) / rows.length).toFixed(2);
      const w = rows.reduce((s, x) => s + x.w, 0);
      if (w <= 0) return +(rows.reduce((s, x) => s + Number(x.plan[key]), 0) / rows.length).toFixed(2);
      return +(rows.reduce((s, x) => s + Number(x.plan[key]) * x.w, 0) / w).toFixed(2);
    };
    const majority = (key, dflt) => {
      const rows = weighted.filter(x => typeof x.plan[key] === 'boolean');
      if (!rows.length) return dflt;
      const on = rows.filter(x => x.plan[key]).reduce((s, x) => s + (useW ? x.w : 1), 0);
      const all = rows.reduce((s, x) => s + (useW ? x.w : 1), 0);
      return on * 2 >= all;
    };
    const earliest = (key, dflt) => {
      const vals = weighted.map(x => Number(x.plan[key])).filter(Number.isFinite);
      return vals.length ? Math.min(...vals) : dflt;
    };
    // A channel is excluded nationally only if regions carrying most of the
    // volume exclude it — otherwise one small region would switch it off for all.
    const excludedAgg = (() => {
      const tally = {};
      weighted.forEach(x => (Array.isArray(x.plan.excludedChannels) ? x.plan.excludedChannels : [])
        .forEach(c => { tally[c] = (tally[c] || 0) + (useW ? x.w : 1); }));
      const total = weighted.reduce((s, x) => s + (useW ? x.w : 1), 0);
      return Object.entries(tally).filter(([, v]) => v * 2 > total).map(([c]) => c);
    })();
    const capsAgg = (() => {
      const acc = {};
      weighted.forEach(x => {
        const caps = (x.plan.channelCaps && typeof x.plan.channelCaps === 'object') ? x.plan.channelCaps : {};
        Object.entries(caps).forEach(([c, v]) => {
          if (!Number.isFinite(Number(v))) return;
          (acc[c] = acc[c] || []).push({ v: Number(v), w: useW ? x.w : 1 });
        });
      });
      const out = {};
      Object.entries(acc).forEach(([c, list]) => {
        const w = list.reduce((s, x) => s + x.w, 0);
        out[c] = +(w > 0 ? list.reduce((s, x) => s + x.v * x.w, 0) / w
                         : list.reduce((s, x) => s + x.v, 0) / list.length).toFixed(1);
      });
      return out;
    })();

    return {
      _regions: plans.length,
      _weighted: useW,
      scenario: 'custom',
      growthPct:        avg('growthPct', 3),
      newReps:          sum('newReps'),
      newRoutes:        sum('newRoutes'),
      newRepsStart:     earliest('newRepsStart', 7),
      newRoutesStart:   earliest('newRoutesStart', 7),
      linkRepRoute:     majority('linkRepRoute', true),
      newRepCapEnabled: majority('newRepCapEnabled', true),
      newRepQtyCap:     avg('newRepQtyCap', NEW_REP_QTY_CAP_DEFAULT),
      includeVisitUplift: majority('includeVisitUplift', false),
      targetVpd:        avg('targetVpd', 12),
      visitRealization: avg('visitRealization', 70),
      includeAspPlan:   majority('includeAspPlan', false),
      aspFocusMode:     majority('aspFocusMode', true),
      baseFloorPct:     avg('baseFloorPct', ASP_BASE_FLOOR_DEFAULT),
      minKeepPct:       avg('minKeepPct', ASP_MIN_KEEP_DEFAULT),
      baseMinPct:       avg('baseMinPct', ASP_BASE_MIN_DEFAULT),
      targetAsp:        avg('targetAsp', null),
      excludedChannels: excludedAgg,
      channelCaps:      capsAgg,
    };
  }, [allPlansData, data]);

  /* Apply a saved per-region plan once it arrives for the CURRENT branch —
     takes priority over the trend-based default below. Guarded by a ref
     (not state) so it fires exactly once per branch and never re-clobbers
     the user's own edits on a later refetch. */
  useEffect(() => {
    if (savedPlanData === undefined) return; // still loading
    /* "الكل" with no plan of its own waits for the per-region plans, then uses
       the aggregate instead of blank defaults. Without this wait the effect
       would fire once with defaults and never run again for this branch. */
    const needAggregate = !branch && !savedPlanData?.plan;
    if (needAggregate && allPlansData === undefined) return;
    if (appliedPlanBranchRef.current === branch) return; // already handled this branch
    appliedPlanBranchRef.current = branch;
    const raw = savedPlanData?.plan || (needAggregate ? aggregatedAllPlan : null);
    const p = (raw && typeof raw === 'object') ? raw : null;
    const fromAggregate = needAggregate && !!p;

    /* Every setting is written on every region switch — falling back to the
       default when this region's plan doesn't carry it. Previously each
       setter sat behind `if (p.x != null)`, so a region with no saved plan
       (or one saved before a setting existed) silently inherited whatever
       the previously-viewed region had, making per-region settings look
       global. Each region is now fully independent. */
    const pick = (key, dflt) => (p && p[key] != null ? p[key] : dflt);

    setScenario(pick('scenario', 'custom')); // 'custom' lets the trend seed growth below
    if (p && p.growthPct != null) setGrowthPct(p.growthPct);
    setNewReps(pick('newReps', 0));
    setNewRoutes(pick('newRoutes', 0));
    if (p && p.newRepsStart != null) setNewRepsStart(p.newRepsStart);
    if (p && p.newRoutesStart != null) setNewRoutesStart(p.newRoutesStart);
    setLinkRepRoute(pick('linkRepRoute', true));
    setNewRepCapEnabled(pick('newRepCapEnabled', true));
    setNewRepQtyCap(pick('newRepQtyCap', NEW_REP_QTY_CAP_DEFAULT));
    setIncludeVisitUplift(pick('includeVisitUplift', false));
    setTargetVpd(pick('targetVpd', 12));
    setVisitRealization(pick('visitRealization', 70));
    setIncludeAspPlan(pick('includeAspPlan', false));
    setAspFocusMode(pick('aspFocusMode', true));
    setBaseFloorPct(pick('baseFloorPct', ASP_BASE_FLOOR_DEFAULT));
    setMinKeepPct(pick('minKeepPct', ASP_MIN_KEEP_DEFAULT));
    setBaseMinPct(pick('baseMinPct', ASP_BASE_MIN_DEFAULT));
    setExcludedChannels(Array.isArray(p?.excludedChannels) ? p.excludedChannels : []);
    setPriceOverrides((p && p.priceOverrides && typeof p.priceOverrides === 'object') ? p.priceOverrides : {});
    setNewChannels((p && p.newChannels && typeof p.newChannels === 'object') ? p.newChannels : {});
    // Older plans stored a single Hypermarkets cap as capEnabled/capPct.
    setChannelCaps(
      (p && p.channelCaps && typeof p.channelCaps === 'object') ? p.channelCaps
      : (p && p.capEnabled) ? { Hypermarkets: p.capPct ?? ASP_CAP_DEFAULT }
      : {});

    setPlanDerived(fromAggregate ? { regions: p._regions, weighted: p._weighted } : null);
    if (p && p.targetAsp != null) {
      setTargetAsp(p.targetAsp);
      aspSeededRef.current = branch; // block the A₀ seeding effect
    } else {
      // No saved target → re-seed from THIS region's own blended ASP.
      setTargetAsp(null);
      aspSeededRef.current = undefined;
    }

    setPlanStatus(p ? 'loaded' : '');
  }, [savedPlanData, branch, allPlansData, aggregatedAllPlan]);

  /* Persist the derived company-wide plan once, so the next visit loads it
     back as a normal saved plan instead of re-deriving it. Runs after the
     state setters above have committed, hence the separate effect. */
  useEffect(() => {
    if (!planDerived || branch || autoSavedRef.current) return;
    autoSavedRef.current = true;
    savePlan().catch(() => { autoSavedRef.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planDerived, branch]);

  // Re-arm the one-shot auto-save whenever the selected region changes.
  useEffect(() => { autoSavedRef.current = false; }, [branch]);

  /* Seed the growth input from the trend once data arrives — skipped when a
     saved plan was just loaded for this branch (it already set its own
     growth%/scenario, which this would otherwise immediately overwrite). */
  useEffect(() => {
    const hasSavedPlan = !!savedPlanData?.plan;
    if (trendGrowth != null && scenario === 'custom' && !hasSavedPlan) {
      setGrowthPct(scenarioGrowth.balanced);
      setScenario('balanced');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendGrowth, savedPlanData]);

  useEffect(() => { setTargetVpd(v => Math.max(10, Math.min(15, v))); }, []);
  useEffect(() => { if (toMonth < fromMonth) setToMonth(fromMonth); }, [fromMonth, toMonth]);

  const applyScenario = (key) => {
    setScenario(key);
    setGrowthPct(scenarioGrowth[key]);
  };

  /* First forecastable month = the one after the last month that actually
     has data (the filter may end in a month that hasn't happened yet). */
  const fcFirstMonth = useMemo(() => {
    const reported = monthly.filter(m => m.has_data);
    if (!reported.length) return Math.min(12, toMonth + 1);
    return Math.min(12, Math.max(toMonth, reported[reported.length - 1].month_num) + 1);
  }, [monthly, toMonth]);

  /* Keep the "starts from" selects inside the forecast window, otherwise the
     <select> value wouldn't match any option and would silently desync. */
  useEffect(() => {
    setNewRepsStart(s => Math.max(s, fcFirstMonth));
    setNewRoutesStart(s => Math.max(s, fcFirstMonth));
  }, [fcFirstMonth]);

  const resetPlan = () => {
    setGrowthPct(scenarioGrowth.balanced);
    setScenario('balanced');
    setNewReps(0); setNewRoutes(0);
    setNewRepsStart(fcFirstMonth); setNewRoutesStart(fcFirstMonth);
    setLinkRepRoute(true);
    setNewRepCapEnabled(true); setNewRepQtyCap(NEW_REP_QTY_CAP_DEFAULT);
    setIncludeVisitUplift(false); setTargetVpd(12); setVisitRealization(70);
    setIncludeAspPlan(false); setAspFocusMode(true); setBaseFloorPct(ASP_BASE_FLOOR_DEFAULT);
    setMinKeepPct(ASP_MIN_KEEP_DEFAULT); setBaseMinPct(ASP_BASE_MIN_DEFAULT); setExcludedChannels([]);
    setChannelCaps({});
    if (aspModel) setTargetAsp(+aspModel.A0.toFixed(2));
    setPlanStatus('');
  };

  /* Save the current scenario settings as this region's default plan — next
     time this region is selected, they load back in automatically. */
  const savePlan = async () => {
    setPlanStatus('saving');
    try {
      await client.put('/region-performance/plan', {
        growthPct, scenario, newReps, newRepsStart, newRoutes, newRoutesStart,
        linkRepRoute, includeVisitUplift, targetVpd, visitRealization,
        includeAspPlan, targetAsp, aspFocusMode, baseFloorPct, minKeepPct, excludedChannels,
        channelCaps, baseMinPct, newRepCapEnabled, newRepQtyCap, priceOverrides, newChannels,
      }, { params: { branch } });
      setPlanStatus('saved');
    } catch (e) {
      setPlanStatus('error');
      throw e;
    }
  };

  /* ══════════════════════════════════════════════════════════
     ASP MIX MODEL — sales-channel (customer-category) mix shift
     ─────────────────────────────────────────────────────────
     The region's blended ASP is A₀ = Σ(wᵢ·aᵢ) across customer
     categories, where wᵢ is the category's share of QUANTITY and aᵢ its
     own actual ASP over the reported period. Raising the blended ASP
     without touching prices means selling relatively more through the
     higher-ASP channels, so we tilt the mix along a direction gᵢ:

         wᵢ' = wᵢ · (1 + k·gᵢ)      with   Σwᵢ·gᵢ = 0

     The zero-mean constraint makes the tilt preserve Σwᵢ' = 1 exactly,
     which collapses the new blend to A(k) = A₀ + k·Σwᵢ·gᵢ·aᵢ. So the
     required tilt is closed-form — no iteration, instant slider response.

     Two directions are available:
       • FOCUS (default) — gᵢ from the ASP_FOCUS_PRIORITY weights, so the
         extra volume lands in the channels the business chose to push,
         in that order, not wherever the arithmetic happens to favour.
       • PROPORTIONAL — gᵢ = aᵢ − A₀, spreading the shift across every
         above-average channel by how far above average it sits.

     Feasibility: no channel's share may go negative, which bounds k and
     therefore the reachable ASP. The slider is clamped to that real
     range rather than pretending any target is achievable by mix alone.
  ══════════════════════════════════════════════════════════ */
  const overridesKey = JSON.stringify(priceOverrides);
  const aspModel = useMemo(() => {
    const priceOverridesRef = priceOverrides;
    // Cross-region price benchmark, used to pin the ASP of channels whose
    // local figure is too thin to trust (ASP_PINNED_CATEGORIES).
    const bench = {};
    (data?.category_asp_benchmark || []).forEach(b => { bench[b.name] = b; });

    const cats = (data?.by_customer_category || [])
      .filter(c => Number(c.qty) > 0 && Number(c.asp) > 0)
      .map(c => {
        const localAsp = Number(c.asp);
        const b = bench[c.name];
        const pinned = ASP_PINNED_CATEGORIES.includes(c.name)
          && b && (b.asp != null || b.asp_all != null);
        // Prefer the best price a real-volume region achieved; fall back
        // to the all-region blend when no region cleared the noise floor.
        const pinnedAsp = pinned ? Number(b.asp ?? b.asp_all) : null;
        const isPinned = !!(pinned && Number.isFinite(pinnedAsp) && pinnedAsp > 0);
        const modelAsp = isPinned ? pinnedAsp : localAsp;
        // A manual override outranks both the benchmark and the local price.
        const ov = Number(priceOverridesRef[c.name]);
        const hasOv = Number.isFinite(ov) && ov > 0;
        return {
          name: c.name,
          qty: Number(c.qty),
          revenue: Number(c.revenue),
          asp: hasOv ? ov : modelAsp,
          local_asp: localAsp,
          default_asp: modelAsp,          // what the model would use with no override
          asp_override: hasOv ? ov : null,
          asp_pinned: isPinned,
          asp_pinned_from: pinned ? (b.asp != null ? b.branch : 'كل المناطق') : null,
        };
      });
    if (cats.length < 2) return null;

    /* Manually-added channels the region has never sold to. They join the mix
       with zero quantity, so they carry zero weight in A0 and in every tilt
       calculation — which is correct, they contribute nothing TODAY. Their
       share is injected at the end of aspPlan instead. Their price comes from
       the cross-region benchmark (what another region actually achieves),
       overridable by hand, because this region has no price of its own. */
    Object.entries(newChannels).forEach(([name, cfg]) => {
      if (cats.some(c => c.name === name)) return;   // it has history after all
      const b = bench[name];
      const benchAsp = b ? Number(b.asp ?? b.asp_all) : null;
      const manual = Number(cfg?.price);
      const asp = Number.isFinite(manual) && manual > 0
        ? manual
        : (Number.isFinite(benchAsp) && benchAsp > 0 ? benchAsp : null);
      if (!(asp > 0)) return;                        // no defensible price → skip
      cats.push({
        name, qty: 0, revenue: 0,
        asp, local_asp: null, default_asp: benchAsp ?? asp,
        asp_override: Number.isFinite(manual) && manual > 0 ? manual : null,
        asp_pinned: false, asp_pinned_from: null,
        is_new: true,
        target_share: Math.max(0, Math.min(90, Number(cfg?.share) || 0)),
        bench_from: b ? (b.asp != null ? b.branch : 'كل المناطق') : null,
      });
    });

    const totalQty = cats.reduce((s, c) => s + c.qty, 0);
    if (!totalQty) return null;
    const w  = cats.map(c => c.qty / totalQty);
    const A0 = cats.reduce((s, c, i) => s + w[i] * c.asp, 0);
    /* The ACTUAL blended ASP, using each channel's real achieved price. It
       reduces to total revenue ÷ total quantity, so it matches the ASP shown
       everywhere else on the page. A0 above substitutes the pinned benchmark
       for thin channels, which inflates it — right for the forward tilt maths,
       wrong as a statement of where the region stands today. */
    const A0Actual = cats.reduce((s, c, i) => s + w[i] * (c.local_asp ?? c.asp), 0);

    /* PROPORTIONAL — multiplicative tilt wᵢ' = wᵢ(1 + k·(aᵢ − A₀)). */
    const propDir = (() => {
      const g = cats.map(c => c.asp - A0);
      const denom = cats.reduce((s, c, i) => s + w[i] * g[i] * c.asp, 0);
      if (!(denom > 1e-9)) return null;
      let kHi = Infinity, kLo = -Infinity;
      g.forEach((gi, i) => {
        if (w[i] <= 0) return;
        if (gi < 0) kHi = Math.min(kHi, -1 / gi); // 1 + k·gᵢ ≥ 0
        if (gi > 0) kLo = Math.max(kLo, -1 / gi);
      });
      if (!Number.isFinite(kHi) || !Number.isFinite(kLo)) return null;
      return {
        kind: 'prop', g, denom,
        aspMax: +(A0 + kHi * denom).toFixed(2),
        aspMin: +(A0 + kLo * denom).toFixed(2),
      };
    })();

    /* FOCUS — STRUCTURED mix with a protected base.
       The volume splits into three blocks:
         • BASE (ASP_BASE_CHANNELS) — pinned to `baseFloor` of total and
           divided between those channels in their CURRENT proportions, so
           the bread-and-butter channels are never gutted to chase ASP.
         • OTHER — any channel in neither list keeps its current share.
         • PRIORITY — takes whatever is left, allocated by RANK weight
           (4/3/2/1 → 40/30/20/10%), then tilted within the block to land
           on the ASP target: pᵢ' = pᵢ(1 + m(aᵢ − ā)). That tilt keeps
           Σpᵢ' = 1, so the block ASP is ā + m·V and m is closed-form.
       Because the base block is fixed, the reachable ASP is bounded by
       what the priority block alone can contribute — pinning 60% to the
       two lowest-ASP channels genuinely caps the blend, and the slider
       range reflects that rather than hiding it. */
    const focusDir = (() => {
      const excludedSet = new Set(excludedChannels);
      const isExcluded = cats.map(c => excludedSet.has(c.name));
      const ranks = cats.map(c => aspPriorityWeight(c.name));
      if (!ranks.some(r => r > 0)) return null;

      /* NOTE: exclusion is applied at the very END (see aspPlan), not
         here. Every channel — excluded ones included — first receives its
         normal allocation, then the excluded shares are zeroed and handed
         out across ALL remaining channels in proportion to their own
         share. That is what "توزيع النسبة على كافة الفئات" means: base
         channels grow too, not just the priority block. Consequently the
         base percentage is a FLOOR — it can end above its setting once a
         channel is switched off. */
      const isBase = cats.map(c => ASP_BASE_CHANNELS.includes(c.name));
      const isPri  = cats.map((_c, i) => ranks[i] > 0 && !isBase[i]);
      // A channel on neither list holds its current share untouched.
      const isKeep = cats.map((_c, i) => !isBase[i] && !isPri[i]);

      const baseW = cats.reduce((s, _c, i) => s + (isBase[i] ? w[i] : 0), 0);
      const floor = baseW > 1e-9 ? Math.min(baseFloor, 0.95) : 0;
      /* Same guaranteed-minimum idea as the priority block, applied inside
         the base block: each base channel is handed an absolute floor of
         total quantity first, and only the remainder of the base block is
         split between them in their current proportions. Without it, a
         base channel that is small today stays small no matter what.
         Clamped to floor/nBase so the minimums can never exceed the block. */
      const nBase = cats.reduce((s, _c, i) => s + (isBase[i] ? 1 : 0), 0);
      const baseMinEach = nBase > 0 ? Math.min(baseMin, floor / nBase) : 0;
      const baseFree = Math.max(0, floor - baseMinEach * nBase);
      const baseShare = cats.map((_c, i) =>
        (isBase[i] && baseW > 0 ? baseMinEach + baseFree * (w[i] / baseW) : 0));
      const keepShare = cats.map((_c, i) => (isKeep[i] ? w[i] : 0));
      const keepTotal = keepShare.reduce((s, x) => s + x, 0);
      const priTotal = 1 - floor - keepTotal;
      if (!(priTotal > 1e-6)) return null;

      const rankSum = cats.reduce((s, _c, i) => s + (isPri[i] ? ranks[i] : 0), 0);
      if (!rankSum) return null;
      const p = cats.map((_c, i) => (isPri[i] ? ranks[i] / rankSum : 0));

      /* Guaranteed floor per priority channel, expressed as an ABSOLUTE
         share of total quantity (5% means 5% of everything sold, not 5%
         of the channel's own allocation). Only the leftover ("free")
         slice is tilted toward the higher-ASP channels, so no priority
         channel can be driven below its floor to chase the target.
         Clamped to priTotal/nPri so the floors can never demand more
         than the priority block actually has. */
      const nPri = cats.reduce((s, _c, i) => s + (isPri[i] ? 1 : 0), 0);
      const floorEach = nPri > 0 ? Math.min(minKeep, priTotal / nPri) : 0;
      const floorShare = cats.map((_c, i) => (isPri[i] ? floorEach : 0));
      const floorTotal = floorShare.reduce((s, x) => s + x, 0);
      const freeTotal = priTotal - floorTotal;

      const fixedContrib = cats.reduce(
        (s, c, i) => s + (baseShare[i] + keepShare[i] + floorShare[i]) * c.asp, 0);

      if (!(freeTotal > 1e-9)) {
        const only = fixedContrib; // fully pinned — nothing left to tilt
        return {
          kind: 'focus', isBase, isPri, isKeep, isExcluded, baseShare, keepShare, floorShare, floorEach, nPri, baseMinEach, nBase,
          priTotal, freeTotal: 0, p, q: p, aBar: 0, V: 0, fixedContrib, floor,
          aspMin: +only.toFixed(2), aspMax: +only.toFixed(2),
        };
      }

      // The free slice is shared out by the same rank weights, then tilted.
      const aBar = cats.reduce((s, c, i) => s + p[i] * c.asp, 0);
      const V = cats.reduce((s, c, i) => s + p[i] * Math.pow(c.asp - aBar, 2), 0);

      let mHi = Infinity, mLo = -Infinity;
      cats.forEach((c, i) => {
        if (!isPri[i] || p[i] <= 0) return;
        const d = c.asp - aBar;
        if (d < 0) mHi = Math.min(mHi, -1 / d);
        if (d > 0) mLo = Math.max(mLo, -1 / d);
      });
      if (!(V > 1e-9) || !Number.isFinite(mHi) || !Number.isFinite(mLo)) {
        const only = fixedContrib + freeTotal * aBar;
        return {
          kind: 'focus', isBase, isPri, isKeep, isExcluded, baseShare, keepShare, floorShare, floorEach, nPri, baseMinEach, nBase,
          priTotal, freeTotal, p, aBar, V: 0, fixedContrib, floor,
          aspMin: +only.toFixed(2), aspMax: +only.toFixed(2),
        };
      }
      const e1 = fixedContrib + freeTotal * (aBar + mHi * V);
      const e2 = fixedContrib + freeTotal * (aBar + mLo * V);
      return {
        kind: 'focus', isBase, isPri, isKeep, isExcluded, baseShare, keepShare, floorShare, floorEach, nPri, baseMinEach, nBase,
        priTotal, freeTotal, p, aBar, V, fixedContrib, floor,
        aspMax: +Math.max(e1, e2).toFixed(2),
        aspMin: +Math.min(e1, e2).toFixed(2),
      };
    })();

    if (!focusDir && !propDir) return null;

    const focusNames = ASP_FOCUS_PRIORITY.map(p => p.name).filter(n => cats.some(c => c.name === n));
    // Share of the PRIORITY block each priority channel receives at base
    // allocation (before the ASP tilt).
    const focusSplit = focusDir
      ? focusNames.map(n => {
          const i = cats.findIndex(c => c.name === n);
          return { name: n, pct: focusDir.p[i] * 100 };
        })
      : [];
    const baseNames = ASP_BASE_CHANNELS.filter(n => cats.some(c => c.name === n));
    return { cats, w, A0, A0Actual, totalQty, focusDir, propDir, focusNames, focusSplit, baseNames };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, baseFloor, minKeep, baseMin, excludedKey, overridesKey, newChannelsKey]);

  /* The focus direction only exists when at least one priority channel is
     present AND pushing it actually raises ASP; otherwise fall back. */
  const aspDir = (aspFocusMode && aspModel?.focusDir) ? aspModel.focusDir : aspModel?.propDir;

  /* Seed the ASP target from the region's own actual blended ASP once
     data arrives (and re-seed when the region changes). */
  useEffect(() => {
    if (!aspModel) return;
    if (aspSeededRef.current === branch) return;
    aspSeededRef.current = branch;
    setTargetAsp(+aspModel.A0.toFixed(2));
  }, [aspModel, branch]);

  /* Keep the target inside the active direction's reachable range —
     switching direction can shrink it (focus can only grow 3 channels). */
  useEffect(() => {
    if (!aspDir || targetAsp == null) return;
    const clamped = Math.min(aspDir.aspMax, Math.max(aspDir.aspMin, targetAsp));
    if (Math.abs(clamped - targetAsp) > 1e-6) setTargetAsp(+clamped.toFixed(2));
  }, [aspDir, targetAsp]);

  /* Mirror the committed target back into the text box (slider drags,
     saved-plan loads, resets, range clamping). */
  useEffect(() => {
    if (targetAsp != null) setAspInput(String(targetAsp));
  }, [targetAsp]);

  /* Parse + clamp the typed value; called on blur or Enter. */
  const commitAspInput = () => {
    const v = parseFloat(aspInput);
    if (!aspDir || !Number.isFinite(v)) {
      setAspInput(targetAsp == null ? '' : String(targetAsp)); // revert junk
      return;
    }
    const rounded = +Math.min(aspDir.aspMax, Math.max(aspDir.aspMin, v)).toFixed(2);
    setTargetAsp(rounded);
    setAspInput(String(rounded));
  };

  const aspPlan = useMemo(() => {
    if (!aspModel || !aspDir || targetAsp == null) return null;
    const { cats, w, A0, totalQty } = aspModel;
    let rawShare;
    if (aspDir.kind === 'focus') {
      // Base, kept and floor blocks are all fixed; only the free slice is
      // tilted, so solve m for the ASP the free slice still has to deliver.
      const { freeTotal, p, aBar, V, fixedContrib, baseShare, keepShare, floorShare, isPri } = aspDir;
      let freeRaw = cats.map(() => 0);
      if (freeTotal > 1e-9) {
        const needFromFree = (targetAsp - fixedContrib) / freeTotal;
        const m = V > 1e-9 ? (needFromFree - aBar) / V : 0;
        freeRaw = cats.map((c, i) => (isPri[i] ? Math.max(0, p[i] * (1 + m * (c.asp - aBar))) : 0));
        const freeSum = freeRaw.reduce((s, x) => s + x, 0);
        // Renormalize the free slice only — the pinned blocks stay exact.
        freeRaw = freeRaw.map(x => (freeSum > 0 ? (x / freeSum) * freeTotal : 0));
      }
      rawShare = cats.map((_c, i) => baseShare[i] + keepShare[i] + floorShare[i] + freeRaw[i]);
      /* Drop the switched-off channels and hand their share to EVERY
         remaining channel in proportion to its own share — base included.
         Doing it here (rather than removing them from the allocation)
         is what makes the redistribution reach all categories. */
      if (aspDir.isExcluded.some(Boolean)) {
        const kept = rawShare.map((s, i) => (aspDir.isExcluded[i] ? 0 : s));
        const keptSum = kept.reduce((s, x) => s + x, 0);
        rawShare = keptSum > 1e-9 ? kept.map(x => x / keptSum) : kept;
      }
      /* Hard ceiling on the capped channel. Anything above it is handed
         back to the other channels in proportion to their own share, so
         the mix still totals 100%. Applied after the tilt, so the ASP
         actually achieved may fall a little short of the requested
         target — that gap is reported rather than hidden. */
      /* Ceilings are applied by clamp-and-redistribute. It has to iterate:
         handing one capped channel's excess to the others can push a
         second capped channel over its own ceiling, so repeat until
         nothing is over (or there's nowhere left to put the excess). */
      const capFracOf = cats.map(c =>
        (c.name in channelCaps)
          ? Math.max(0, Math.min(100, Number(channelCaps[c.name]) || 0)) / 100
          : null);
      if (capFracOf.some(v => v != null)) {
        for (let pass = 0; pass < 12; pass++) {
          let excess = 0;
          rawShare = rawShare.map((s, i) => {
            const cap = capFracOf[i];
            if (cap != null && s > cap + 1e-12) { excess += s - cap; return cap; }
            return s;
          });
          if (excess <= 1e-12) break;
          // Receivers: not excluded, not already sitting at their own cap.
          const pool = rawShare.map((s, i) => {
            if (aspDir.isExcluded[i]) return 0;
            const cap = capFracOf[i];
            if (cap != null && s >= cap - 1e-12) return 0;
            return s;
          });
          const poolSum = pool.reduce((s, x) => s + x, 0);
          if (poolSum <= 1e-12) break; // every channel capped — infeasible
          rawShare = rawShare.map((s, i) => s + excess * (pool[i] / poolSum));
        }
        // Safety: if the caps were collectively infeasible the shares can
        // fall short of 100%; renormalize so the mix is always valid.
        const tot = rawShare.reduce((s, x) => s + x, 0);
        if (tot > 1e-9 && Math.abs(tot - 1) > 1e-9) rawShare = rawShare.map(x => x / tot);
      }
    } else {
      const k = (targetAsp - A0) / aspDir.denom;
      const raw = cats.map((_c, i) => Math.max(0, w[i] * (1 + k * aspDir.g[i])));
      const sum = raw.reduce((s, x) => s + x, 0);
      rawShare = raw.map(x => (sum > 0 ? x / sum : 0));
    }
    /* Manually-added channels: reserve the share the user asked for and take
       it proportionally off everything else. A multiplicative tilt can never
       lift a channel off zero, so this is the only honest way to model
       entering a channel — state the share it should reach, and let the rest
       of the mix give it up pro rata. Reservation is capped at 90% so the
       existing business can never be zeroed out by a typo. */
    const newIdx = cats.map((c, i) => (c.is_new ? i : -1)).filter(i => i >= 0);
    let reservedTotal = 0;
    if (newIdx.length) {
      const want = newIdx.reduce((s, i) => s + (cats[i].target_share || 0) / 100, 0);
      reservedTotal = Math.min(0.9, want);
      const scale = want > 1e-9 ? reservedTotal / want : 0;   // shrink pro rata if clamped
      const existingSum = rawShare.reduce((s, x, i) => s + (cats[i].is_new ? 0 : x), 0);
      rawShare = rawShare.map((x, i) => cats[i].is_new
        ? ((cats[i].target_share || 0) / 100) * scale
        : (existingSum > 1e-9 ? (x / existingSum) * (1 - reservedTotal) : 0));
    }

    let rows = cats.map((c, i) => {
      const ns = rawShare[i] * 100;
      return {
        ...c,
        share: w[i] * 100,
        new_share: ns,
        delta: ns - w[i] * 100,
        new_qty: rawShare[i] * totalQty,
        focus_rank: aspPriorityRank(c.name),
        is_base: aspDir.kind === 'focus' ? aspDir.isBase[i] : false,
        /* a manually-added channel is never "excluded" — isExcluded/isBase are
           indexed against the ORIGINAL cats array and would read undefined */
        is_excluded: (!c.is_new && aspDir.kind === 'focus') ? !!aspDir.isExcluded[i] : false,
      };
    });
    const achieved = rows.reduce((s, r) => s + (r.new_share / 100) * r.asp, 0);
    // Priority channels first (in their configured order), then the rest
    // by ASP — so the table reads as the focus plan it is.
    rows.sort((a, b) => {
      const ra = a.focus_rank === -1 ? 99 : a.focus_rank;
      const rb = b.focus_rank === -1 ? 99 : b.focus_rank;
      return ra !== rb ? ra - rb : b.asp - a.asp;
    });
    return { rows, achieved: +achieved.toFixed(2), reserved_pct: reservedTotal * 100 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspModel, aspDir, targetAsp, capsKey]);

  /* ══════════════════════════════════════════════════════════
     FORECAST ENGINE (client-side so sliders respond instantly)
  ══════════════════════════════════════════════════════════ */
  const forecast = useMemo(() => {
    if (!data || !monthly.length) return null;

    /* Baseline = average of the last 3 REPORTED months — steadier than the
       final month alone (which can be a seasonal dip), and skipping
       not-yet-reported months so a range reaching into the future doesn't
       drag the baseline toward zero. */
    const reported = monthly.filter(m => m.has_data);
    if (!reported.length) return null;
    const tail = reported.slice(-3);
    const baseRev = tail.reduce((s, m) => s + Number(m.revenue || 0), 0) / tail.length;
    const baseQty = tail.reduce((s, m) => s + Number(m.qty || 0), 0) / tail.length;

    /* Forecast the months after the last one that actually has data — not
       after the filter's end month, which may already be in the future. */
    const lastReported = reported[reported.length - 1].month_num;
    const fcStart = Math.max(toMonth, lastReported) + 1;
    const fcMonths = [];
    for (let m = fcStart; m <= 12; m++) fcMonths.push(m);
    if (!fcMonths.length) return null;

    const nMonths   = reported.length;
    /* A new rep is modelled on the region's AVERAGE rep productivity, but
       in a strong region that average is set by established reps with
       mature routes — a newcomer realistically won't match it. The cap
       holds a new rep's steady-state volume down to a believable ceiling;
       it only bites when the regional average is above it, so weaker
       regions are unaffected. Revenue is scaled by the same ratio so the
       new rep's implied ASP stays equal to the region's. */
    const revPerRepRaw = Number(totals.revenue_per_rep_month || 0);
    const qtyPerRepRaw = Number(totals.qty_per_rep_month || 0);
    const capQty       = newRepCapEnabled ? Math.max(0, Number(newRepQtyCap) || 0) : Infinity;
    const qtyPerRep    = Math.min(qtyPerRepRaw, capQty);
    const repCapBites  = qtyPerRepRaw > 0 && qtyPerRep < qtyPerRepRaw - 1e-9;
    const repRatio     = qtyPerRepRaw > 0 ? qtyPerRep / qtyPerRepRaw : 1;
    const revPerRep    = revPerRepRaw * repRatio;
    const routesNow = Number(current.routes_on_books || 0);
    const revPerRoute = routesNow > 0 ? Number(totals.revenue || 0) / routesNow / nMonths : 0;
    const qtyPerRoute = routesNow > 0 ? Number(totals.qty || 0) / routesNow / nMonths : 0;

    /* A new rep normally opens a new route — counting both in full would
       double-count the same incremental capacity. */
    const effRoutes = linkRepRoute ? Math.max(0, newRoutes - newReps) : newRoutes;

    const ramp = (monthsSinceStart) =>
      monthsSinceStart < 0 ? 0 : RAMP[Math.min(monthsSinceStart, RAMP.length - 1)];

    /* Visit-gap uplift: pricing the shortfall against the chosen daily
       target at the period's actual revenue-per-visit, discounted by a
       realization factor (not every extra visit converts fully). */
    const gapVpd = Math.max(0, Number(targetVpd) - Number(gap.actual_vpd || 0));
    const upliftRevFull = gapVpd * Number(gap.avg_rep_days_per_month || 0) * Number(gap.revenue_per_visit || 0);
    const upliftRev = includeVisitUplift ? upliftRevFull * (visitRealization / 100) : 0;
    const aspNow = Number(totals.asp || 0);
    const upliftQty = aspNow > 0 ? upliftRev / aspNow : 0;

    const g = Number(growthPct) / 100;

    /* ASP uplift: a channel-mix shift raises the price realized per unit
       without changing how many units move, so it adds revenue and zero
       quantity. The blend is ramped linearly to the target across the
       horizon — re-weighting a region's sales mix lands gradually, not
       on the first of next month. */
    const aspTarget = (includeAspPlan && aspPlan && aspNow > 0) ? aspPlan.achieved : null;

    const rows = fcMonths.map((m, i) => {
      const growthRev = baseRev * (Math.pow(1 + g, i + 1) - 1);
      const growthQty = baseQty * (Math.pow(1 + g, i + 1) - 1);
      const rRep   = ramp(m - newRepsStart);
      const rRoute = ramp(m - newRoutesStart);
      const repsRev   = newReps   * revPerRep   * rRep;
      const repsQty   = newReps   * qtyPerRep   * rRep;
      const routesRev = effRoutes * revPerRoute * rRoute;
      const routesQty = effRoutes * qtyPerRoute * rRoute;
      const vRev = upliftRev;
      const vQty = upliftQty;

      const totalQty = baseQty + growthQty + repsQty + routesQty + vQty;

      let aspRev = 0, aspMonth = aspNow;
      if (aspTarget != null) {
        aspMonth = aspNow + (aspTarget - aspNow) * ((i + 1) / fcMonths.length);
        aspRev = totalQty * (aspMonth - aspNow);
      }

      const totalRev = baseRev + growthRev + repsRev + routesRev + vRev + aspRev;

      return {
        month_num: m,
        month_name: MONTH_AR[m],
        base_revenue: baseRev,
        growth_revenue: growthRev,
        reps_revenue: repsRev,
        routes_revenue: routesRev,
        visit_revenue: vRev,
        asp_revenue: aspRev,
        asp_month: aspMonth,
        total_revenue: totalRev,
        base_qty: baseQty,
        growth_qty: growthQty,
        reps_qty: repsQty,
        routes_qty: routesQty,
        visit_qty: vQty,
        asp_qty: 0, // mix shift moves value, not volume
        total_qty: totalQty,
        vs_base_pct: baseRev > 0 ? ((totalRev - baseRev) / baseRev) * 100 : null,
        vs_base_qty_pct: baseQty > 0 ? ((totalQty - baseQty) / baseQty) * 100 : null,
      };
    });

    const sumBy = (k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
    const h2Rev = sumBy('total_revenue');
    const h2Qty = sumBy('total_qty');
    const h1Rev = Number(totals.revenue || 0);
    const h1Qty = Number(totals.qty || 0);
    const flatH2Rev = baseRev * rows.length; // no growth, no additions
    const flatH2Qty = baseQty * rows.length;

    return {
      rows,
      base_monthly_revenue: baseRev,
      base_monthly_qty: baseQty,
      h1_revenue: h1Rev, h1_qty: h1Qty,
      h2_revenue: h2Rev, h2_qty: h2Qty,
      flat_h2_revenue: flatH2Rev,
      flat_h2_qty: flatH2Qty,
      uplift_vs_flat: h2Rev - flatH2Rev,
      uplift_vs_flat_qty: h2Qty - flatH2Qty,
      uplift_vs_flat_pct: flatH2Rev > 0 ? ((h2Rev - flatH2Rev) / flatH2Rev) * 100 : null,
      year_revenue: h1Rev + h2Rev,
      year_qty: h1Qty + h2Qty,
      h2_vs_h1_pct: h1Rev > 0 ? ((h2Rev - h1Rev) / h1Rev) * 100 : null,
      h2_vs_h1_qty_pct: h1Qty > 0 ? ((h2Qty - h1Qty) / h1Qty) * 100 : null,
      from_new_reps: sumBy('reps_revenue'),
      from_new_routes: sumBy('routes_revenue'),
      from_visits: sumBy('visit_revenue'),
      from_growth: sumBy('growth_revenue'),
      from_new_reps_qty: sumBy('reps_qty'),
      from_new_routes_qty: sumBy('routes_qty'),
      from_visits_qty: sumBy('visit_qty'),
      from_growth_qty: sumBy('growth_qty'),
      from_asp: sumBy('asp_revenue'),
      from_asp_qty: 0,
      asp_now: aspNow,
      asp_target: aspTarget,
      eff_routes: effRoutes,
      rev_per_rep: revPerRep,
      qty_per_rep: qtyPerRep,
      qty_per_rep_raw: qtyPerRepRaw,
      rep_cap_bites: repCapBites,
      rev_per_route: revPerRoute,
      uplift_full: upliftRevFull,
      gap_vpd: gapVpd,
    };
  }, [data, monthly, totals, current, gap, toMonth, growthPct, newReps, newRepsStart,
      newRoutes, newRoutesStart, linkRepRoute, includeVisitUplift, targetVpd, visitRealization,
      includeAspPlan, aspPlan, newRepCapEnabled, newRepQtyCap]);

  /* Monthly channel-quantity distribution. The month's TOTAL quantity is
     taken verbatim from the main forecast row, and the channel shares are
     the same linear ramp the ASP path uses — so the per-channel columns
     always sum back to exactly the forecast's monthly and annual
     quantities, and the row's blended ASP equals the forecast's ASP for
     that month by construction.
     Declared AFTER `forecast`: it reads `forecast` in its dependency
     array, which is evaluated on every render — placing it earlier hits
     the const's temporal dead zone and blanks the page. */
  const aspMonthly = useMemo(() => {
    if (!includeAspPlan || !aspPlan || !forecast?.rows?.length) return null;
    const n = forecast.rows.length;
    const channels = aspPlan.rows;
    const months = forecast.rows.map((r, i) => {
      const ramp = (i + 1) / n;
      const cells = channels.map(c => {
        const sharePct = c.share + (c.new_share - c.share) * ramp;
        return { share: sharePct, qty: (sharePct / 100) * r.total_qty };
      });
      const asp = cells.reduce((s, cell, ci) => s + (cell.share / 100) * channels[ci].asp, 0);
      return { month_num: r.month_num, month_name: r.month_name, total_qty: r.total_qty, asp, cells };
    });
    const channelTotals = channels.map((_c, ci) => months.reduce((s, m) => s + m.cells[ci].qty, 0));
    return { channels, months, channelTotals, grandQty: months.reduce((s, m) => s + m.total_qty, 0) };
  }, [includeAspPlan, aspPlan, forecast]);

  /* ── Auto insights ── */
  const insights = useMemo(() => {
    if (!data || !monthly.length) return [];
    const out = [];
    const last = monthly[monthly.length - 1];
    const vt = data.meta?.visit_target || { min: 10, max: 15 };

    if (totals.avg_visits_per_day != null) {
      const v = totals.avg_visits_per_day;
      if (v < vt.min) {
        out.push({ kind: 'bad', icon: '🚶', title: `الزيارات أقل من الهدف: ${v.toFixed(1)} مقابل ${vt.min}`,
          desc: `رفع المتوسط إلى ${vt.min} زيارة/يوم يضيف نحو ${fmt(gap.at_min?.monthly_revenue)} ر.س شهرياً بنفس إيراد الزيارة الحالي.` });
      } else if (v < vt.max) {
        out.push({ kind: 'warn', icon: '🚶', title: `الزيارات داخل الهدف: ${v.toFixed(1)} زيارة/يوم`,
          desc: `الوصول للحد الأعلى ${vt.max} يضيف نحو ${fmt(gap.at_max?.monthly_revenue)} ر.س شهرياً — أكبر رافعة نمو متاحة بدون تكلفة إضافية.` });
      } else {
        out.push({ kind: 'good', icon: '🚶', title: `الزيارات متميزة: ${v.toFixed(1)} زيارة/يوم`,
          desc: 'الفريق يفوق الحد الأعلى للهدف — النمو القادم يحتاج مناديب أو خطوط سير إضافية.' });
      }
    }

    if (last?.lost_customers != null && last?.new_customers != null) {
      const net = last.new_customers - last.lost_customers;
      if (net < 0) {
        out.push({ kind: 'bad', icon: '📉', title: `صافي فقدان عملاء في ${last.month_name}: ${net}`,
          desc: `فقد ${last.lost_customers} عميل واكتسب ${last.new_customers} فقط — استرجاع نصف المفقودين يعيد نحو ${fmt(Math.round((last.lost_customers / 2) * (last.revenue_per_customer || 0)))} ر.س شهرياً.` });
      } else if (net > 0) {
        out.push({ kind: 'good', icon: '📈', title: `صافي نمو عملاء في ${last.month_name}: +${net}`,
          desc: `اكتسب ${last.new_customers} عميل مقابل فقدان ${last.lost_customers}.` });
      }
    }

    if (trend?.asp?.slope != null) {
      const s = trend.asp.slope;
      out.push({
        kind: s > 0 ? 'good' : s < 0 ? 'warn' : 'good',
        icon: '💵',
        title: `متوسط سعر البيع ASP ${s > 0 ? 'صاعد' : s < 0 ? 'هابط' : 'مستقر'}: ${fmt(totals.asp, 2)} ر.س`,
        desc: s !== 0
          ? `يتغير بمقدار ${s > 0 ? '+' : ''}${fmt(s, 2)} ر.س شهرياً — أثر مزيج الأصناف والأسعار على القيمة.`
          : 'ثابت خلال الفترة.',
      });
    }

    if (current.coverage_pct != null) {
      const c = current.coverage_pct;
      out.push({
        kind: c < 50 ? 'bad' : c < 70 ? 'warn' : 'good',
        icon: '🎯',
        title: `التغطية ${pct(c)} من العملاء المسجلين`,
        desc: `${fmt(last?.active_customers)} عميل متعامل من ${fmt(current.registered_customers)} مسجل — تنشيط 10% من غير المتعاملين يضيف نحو ${fmt(Math.round((current.registered_customers - (last?.active_customers || 0)) * 0.1 * (last?.revenue_per_customer || 0)))} ر.س شهرياً.`,
      });
    }

    if (totals.damages_pct != null) {
      const d = totals.damages_pct;
      out.push({
        kind: d > 2 ? 'bad' : d > 1 ? 'warn' : 'good',
        icon: '🗑️',
        title: `نسبة التوالف ${pct(d, 2)}`,
        desc: `متوسط ${fmt(totals.avg_monthly_damages)} وحدة شهرياً بإجمالي ${fmt(totals.damages)} وحدة خلال الفترة.`,
      });
    }

    if (totals.collection_pct != null) {
      const cp = totals.collection_pct;
      out.push({
        kind: cp >= 95 ? 'good' : cp >= 85 ? 'warn' : 'bad',
        icon: '💰',
        title: `معدل التحصيل ${pct(cp)}`,
        desc: `حُصّل ${fmtM(totals.collected)} ر.س مقابل ${fmtM(totals.invoiced)} ر.س مفوتر. الدين الحالي: ${fmt(current.current_debt)} ر.س.`,
      });
    }

    return out;
  }, [data, monthly, totals, current, gap, trend]);

  /* ── Sorted collections ── */
  const sortedReps = useMemo(() => {
    const rows = data?.by_rep || [];
    const dir = repSort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = a[repSort.col], bv = b[repSort.col];
      if (typeof av === 'string' || typeof bv === 'string')
        return String(bv ?? '').localeCompare(String(av ?? ''), 'ar') * dir;
      return ((Number(bv) || 0) - (Number(av) || 0)) * dir;
    });
  }, [data, repSort]);

  const sortedItems = useMemo(() => {
    const rows = data?.by_item || [];
    const dir = itemSort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = a[itemSort.col], bv = b[itemSort.col];
      if (typeof av === 'string' || typeof bv === 'string')
        return String(bv ?? '').localeCompare(String(av ?? ''), 'ar') * dir;
      return ((Number(bv) || 0) - (Number(av) || 0)) * dir;
    });
  }, [data, itemSort]);

  const branchLabel = branch || 'كل المناطق';
  /* With a day clamp the label must say so — "أغسطس 2026" over a range that
     actually stops on the 15th is the kind of caption that gets a partial
     month read as a collapse. */
  const periodLabel = dayClamped
    ? `${fromDay} ${MONTH_AR[fromMonth]} – ${Math.min(toDay, toDayMax)} ${MONTH_AR[toMonth]} ${year}`
    : `${MONTH_AR[fromMonth]} – ${MONTH_AR[toMonth]} ${year}`;
  /* Written out in full on the print sheet and the Excel export: whoever reads
     the paper has no filter bar to check what the numbers were scoped to. */
  const allCustCats = filters?.categories || [];
  const custCatLabel = !custCats.length ? 'الكل'
    : custCats.length === allCustCats.length - 1
      ? `الكل عدا ${allCustCats.find(c => !custCats.includes(c))}`
      : custCats.join('، ');

  function handlePrint() {
    const prev = document.title;
    document.title = `تقييم أداء المنطقة — ${branchLabel} — ${periodLabel}`;
    window.print();
    window.onafterprint = () => { document.title = prev; };
  }

  /* ── Excel export ─────────────────────────────────────────
     Mirrors what the page actually shows: every table, every column added
     to the screen, the per-region breakdown nested under each month, both
     scorecards with their narrative, and the ASP mix plan. A sheet is
     skipped only when its data does not exist, never silently truncated. */
  const handleExport = useCallback(() => {
    if (!data) return;
    const wb = XLSX.utils.book_new();
    const sc = data.scorecard || null;
    const add = (name, rows, widths) => {
      const ws = XLSX.utils.aoa_to_sheet(rows);
      if (widths) ws['!cols'] = widths;
      XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    };
    const W = (n, w = 14) => Array.from({ length: n }, () => ({ wch: w }));

    /* 1 ── Period KPIs, the cards at the top of the page */
    add('ملخص المؤشرات', [
      ['تقييم أداء المنطقة', branchLabel],
      ['الفترة', periodLabel],
      ['فئة العميل', custCatLabel],
      [''],
      ['المؤشر', 'القيمة', 'تفصيل'],
      ['إجمالي الكمية (وحدة)', totals.qty, `متوسط شهري: ${totals.avg_monthly_qty ?? ''}`],
      ['إجمالي الكميات (كجم)', totals.qty_kg, ''],
      ['إجمالي القيمة (ر.س)', totals.revenue, `متوسط شهري: ${totals.avg_monthly_revenue ?? ''}`],
      ['متوسط سعر البيع ASP', totals.asp, 'لكل وحدة'],
      ['متوسط الزيارات اليومية', totals.avg_visits_per_day, `الهدف ${gap.target_min ?? 10}–${gap.target_max ?? 15} زيارة/يوم`],
      ['متوسط الكميات اليومية (وحدة)', daily.qty_per_day == null ? '' : Math.round(daily.qty_per_day),
       `${daily.working_days} يوم عمل · ${daily.kg_per_day == null ? '' : Math.round(daily.kg_per_day)} كجم/يوم`],
      ['متوسط الكميات لكل مندوب/يوم', daily.qty_per_rep_day == null ? '' : Math.round(daily.qty_per_rep_day),
       `مقسومة على أيام-المندوبين الفعلية (${totals.rep_days ?? ''})`],
      ['معدل التغطية %', current.coverage_pct ?? '', `مسجلون: ${current.registered_customers ?? ''}`],
      ['المناديب النشطة', totals.peak_active_reps, `على الدفاتر: ${current.reps_on_books ?? ''} · خطوط سير: ${current.routes_on_books ?? ''}`],
      ['نسبة التوالف %', totals.damages_pct, `${totals.damages ?? ''} وحدة`],
      ['توالف الجودة (ر.س)', totals.qi_cost, `الكمية: ${totals.qi_qty ?? ''} وحدة`],
      ['التحصيل %', totals.collection_pct, `محصّل ${totals.collected ?? ''} من ${totals.invoiced ?? ''}`],
      ['الدين الحالي', current.current_debt ?? '', ''],
      ['أيام عمل المندوبين', totals.rep_days ?? '', 'يوم-مندوب فعلي'],
    ], [{ wch: 30 }, { wch: 18 }, { wch: 44 }]);

    /* 2 ── Monthly detail, with each month's regions nested beneath it */
    const mH = ['الشهر','المنطقة','أيام العمل','الكمية','متوسط كمية/يوم','حصة الكمية %','كميات كجم','القيمة','ASP','ASP السابق','فرق ASP %',
                'عملاء فعالون','غير فعال','جدد','عائدون','مفقودون','مناديب','أيام-مندوب','زيارات','زيارات/يوم',
                'كجم/يوم','إيراد/زيارة','إيراد/عميل','توالف','توالف %','توالف الجودة','توالف الجودة (كمية)','حالات الجودة',
                'مفوتر','محصّل','تحصيل %','نسبة الدين %'];
    const mLine = (label, region, m, whole) => [
      label, region, m.working_days, m.qty,
      Number(m.working_days) > 0 ? Math.round(Number(m.qty) / Number(m.working_days)) : '',
      (Number(whole) || 0) ? +((Number(m.qty) || 0) / Number(whole) * 100).toFixed(1) : '',
      m.qty_kg, m.revenue, m.asp, m.prev_asp, m.asp_delta_pct,
      m.active_customers, m.inactive_customers, m.new_customers ?? '', m.returning_customers ?? '',
      m.lost_customers ?? '', m.active_reps, m.rep_days, m.visits, m.visits_per_day, m.kg_per_rep_day,
      m.revenue_per_visit, m.revenue_per_customer, m.damages, m.damages_pct, m.qi_cost, m.qi_qty, m.qi_issue_count,
      m.invoiced, m.collected, m.collection_pct, m.debt_ratio,
    ];
    const byMonthRegions = {};
    (data.monthly_by_region || []).forEach(r => {
      (byMonthRegions[r.month_num] = byMonthRegions[r.month_num] || []).push(r);
    });
    const mRows = [];
    monthly.forEach(m => {
      mRows.push(mLine(m.month_name, 'الإجمالي', m, totals.qty));
      (byMonthRegions[m.month_num] || [])
        .sort((a, b) => Number(b.revenue) - Number(a.revenue))
        .forEach(r => mRows.push(mLine(m.month_name, r.branch, r, m.qty)));
    });
    mRows.push(['الإجمالي / المتوسط', '', '', totals.qty,
      daily.qty_per_day == null ? '' : Math.round(daily.qty_per_day), 100, totals.qty_kg, totals.revenue, totals.asp, '', '',
      totals.avg_active_customers, totals.avg_inactive_customers, '', '', '',
      totals.peak_active_reps, totals.rep_days, totals.visits, totals.avg_visits_per_day,
      totals.rep_days > 0 ? +(totals.qty_kg / totals.rep_days).toFixed(1) : '',
      totals.revenue_per_visit, '', totals.damages, totals.damages_pct, totals.qi_cost, totals.qi_qty, '',
      totals.invoiced, totals.collected, totals.collection_pct, totals.avg_debt_ratio]);
    add('التقييم الشهري', [
      ['التقرير', `تقييم أداء المنطقة — ${branchLabel}`], ['الفترة', periodLabel], [''],
      mH, ...mRows,
    ], [{ wch: 12 }, { wch: 16 }, ...W(mH.length - 2)]);

    /* 3 ── The column reference, so the file explains its own numbers */
    add('طريقة حساب الأعمدة',
      [['العمود', 'طريقة الحساب'], ...COLUMN_REFERENCE.map(([t, def]) => [t, def])],
      [{ wch: 22 }, { wch: 110 }]);

    /* 4 + 5 ── Weighted scorecards: regions, then reps */
    if (sc && sc.indicators && sc.indicators.length) {
      const indH = sc.indicators.map(i => `${i.label} (${i.weight}%)`);
      const scHead = ['#', 'الاسم', ...indH, 'التقييم', 'التصنيف', 'الأوزان المحتسبة', 'نقاط ضائعة',
                      'نقاط القوة', 'نقاط الضعف', 'التوصية العملية'];
      const scLine = e => [
        e.rank ?? '', e.name,
        ...sc.indicators.map(i => {
          const p = (e.parts || []).find(x => x.key === i.key);
          return (p && p.value != null) ? p.value : '';
        }),
        e.score ?? '', e.band ?? '', e.weight_applied ?? '', e.points_lost ?? '',
        (e.strengths || []).join(' · '), (e.weaknesses || []).join(' · '), (e.actions || []).join(' · '),
      ];
      const tail = ['', '', '', '', '', '', ''];
      const targetLine = ['', 'الهدف الثابت', ...sc.indicators.map(i =>
        i.mode === 'gap' ? 0 : (i.floorValue != null ? i.floorValue : i.factor)), ...tail];
      const medianLine = ['', 'وسيط المناطق (للعلم)', ...sc.indicators.map(i =>
        (sc.region_benchmarks && sc.region_benchmarks[i.key] != null) ? sc.region_benchmarks[i.key] : ''), ...tail];
      const momentumNote = (sc.momentum && sc.momentum.usable)
        ? `الزخم: ${(sc.momentum.late_names || []).join('–')} مقابل ${(sc.momentum.early_names || []).join('–')}`
          + (sc.momentum.excluded_current_month ? ` (استُبعد ${sc.momentum.excluded_current_month} — شهر جارٍ غير مكتمل)` : '')
        : 'الزخم غير محسوب — النطاق المختار أقصر من أن يُقارن';
      const scW = [{ wch: 5 }, { wch: 20 }, ...W(sc.indicators.length, 15),
                   { wch: 9 }, { wch: 14 }, { wch: 9 }, { wch: 9 },
                   { wch: 46 }, { wch: 46 }, { wch: 62 }];
      add('تقييم المناطق', [
        ['المنهجية', 'هدف كل مؤشر = الأعلى بين (قيمة الجهة +3% أو +8%) والهدف الثابت للشركة. النتيجة = القيمة ÷ الهدف بحد أقصى وزن المؤشر، ثم يُعاد ترجيح المجموع على 100%'],
        ['', momentumNote], [''],
        scHead, ...(sc.regions || []).map(scLine), targetLine, medianLine,
      ], scW);
      add('تقييم المناديب', [
        ['ملاحظة', 'نفس المنهجية ونفس الأهداف الثابتة المطبَّقة على المناطق'], [''],
        ['#', 'المندوب', 'المنطقة', ...scHead.slice(2)],
        ...(sc.reps || []).map(e => { const l = scLine(e); return [l[0], l[1], e.branch || '', ...l.slice(2)]; }),
      ], [{ wch: 5 }, { wch: 26 }, { wch: 14 }, ...scW.slice(2)]);
    }

    /* 6 + 7 ── Half-year comparison, as the two tables present it */
    const planByName = (includeAspPlan && aspPlan)
      ? Object.fromEntries(aspPlan.rows.map(r => [r.name, r])) : null;
    const aspOf = (rev, qty) => (Number(qty) > 0 ? +(Number(rev) / Number(qty)).toFixed(2) : '');
    const pct2 = (a, b) => (a && b != null) ? +(((b - a) / a) * 100).toFixed(1) : '';
    const hyH = ['الفئة','متوسط ن.الأول (قيمة)','متوسط ن.الأول (كمية)','الشهر السابق (قيمة)','الشهر السابق (كمية)',
                 'تغير الشهر السابق عن ن.الأول %','الشهر الحالي (قيمة)','الشهر الحالي (كمية)',
                 'تغير الحالي عن ن.الأول %','متوسط ن.الثاني (قيمة)','متوسط ن.الثاني (كمية)','تغير ن.الثاني عن الأول %',
                 'ASP ن.الأول','ASP الحالي','ASP ن.الثاني','مستهدف ASP','المتبقي للهدف',
                 'الحصة الحالية %','الحصة المطلوبة %','الفارق (نقطة)'];
    const hyRows = (rows, withShare) => (rows || []).map(r => {
      const pr = (withShare && planByName) ? planByName[r.name] : null;
      const a2 = aspOf(r.h2_avg_revenue, r.h2_avg_qty);
      const tgt = (includeAspPlan && aspPlan) ? aspPlan.achieved : '';
      return [r.name, r.h1_avg_revenue, r.h1_avg_qty,
        r.prev_month_revenue, r.prev_month_qty, pct2(r.h1_avg_revenue, r.prev_month_revenue),
        r.current_revenue, r.current_qty,
        pct2(r.h1_avg_revenue, r.current_revenue), r.h2_avg_revenue, r.h2_avg_qty,
        pct2(r.h1_avg_revenue, r.h2_avg_revenue),
        aspOf(r.h1_avg_revenue, r.h1_avg_qty), aspOf(r.current_revenue, r.current_qty), a2,
        tgt, (tgt !== '' && a2 !== '') ? +(tgt - a2).toFixed(2) : '',
        pr ? +pr.share.toFixed(1) : '', pr ? +pr.new_share.toFixed(1) : '', pr ? +pr.delta.toFixed(1) : ''];
    });
    if (data.by_customer_category && data.by_customer_category.length) {
      add('مقارنة النصفين - العملاء', [hyH, ...hyRows(data.by_customer_category, true)],
        [{ wch: 18 }, ...W(hyH.length - 1, 17)]);
    }
    if (data.by_item_category && data.by_item_category.length) {
      add('مقارنة النصفين - الأصناف',
        [hyH.slice(0, 16), ...hyRows(data.by_item_category, false).map(r => r.slice(0, 16))],
        [{ wch: 22 }, ...W(15, 17)]);
    }

    /* 8-10 ── Plain breakdown tables */
    const catH = ['فئة العميل','الكمية','القيمة','ASP','حصة القيمة %','عملاء','توالف'];
    add('فئات العملاء', [catH, ...(data.by_customer_category || []).map(c =>
      [c.name, c.qty, c.revenue, c.asp, c.revenue_share, c.customers, c.damages])], W(catH.length, 16));

    const icH = ['فئة الصنف','الكمية','القيمة','ASP','حصة القيمة %','توالف'];
    add('فئات الأصناف', [icH, ...(data.by_item_category || []).map(c =>
      [c.name, c.qty, c.revenue, c.asp, c.revenue_share, c.damages])], W(icH.length, 18));

    const itH = ['الصنف','الفئة','الكمية','القيمة','ASP','حصة القيمة %','توالف'];
    add('الأصناف', [itH, ...(data.by_item || []).map(c =>
      [c.name, c.category, c.qty, c.revenue, c.asp, c.revenue_share, c.damages])],
      [{ wch: 30 }, { wch: 20 }, ...W(itH.length - 2)]);

    /* 11 ── Reps, carrying every column the on-screen table now has */
    const rH = ['المندوب','المنطقة','التقييم','التصنيف','الكمية','كميات كجم','القيمة','ASP','فواتير','عملاء',
                'زيارات','أيام عمل','زيارات/يوم','كجم/يوم','الحالة','إيراد/زيارة','توالف %','ترند القيمة %'];
    add('المناديب', [rH, ...(data.by_rep || []).map(r =>
      [r.rep, r.branch, r.score ?? '', r.score_band ?? '', r.qty, r.qty_kg, r.revenue, r.asp, r.invoices,
       r.customers, r.visits, r.active_days, r.visits_per_day, r.kg_per_day,
       VISIT_LABEL[r.visit_status] || '', r.revenue_per_visit, r.damages_pct, r.trend_slope_pct])],
      [{ wch: 28 }, { wch: 14 }, ...W(rH.length - 2, 13)]);

    /* 12 ── Rep x month matrix */
    if (data.rep_month_matrix && data.rep_month_matrix.length) {
      const repNames = [...new Set(data.rep_month_matrix.map(x => x.rep))];
      const mm = {};
      data.rep_month_matrix.forEach(x => { (mm[x.rep] = mm[x.rep] || {})[x.month_num] = x; });
      const head = ['المندوب', ...monthly.map(m => `${m.month_name} (قيمة)`), ...monthly.map(m => `${m.month_name} (كمية)`)];
      add('مصفوفة المناديب × الشهور', [head, ...repNames.map(rep => [
        rep,
        ...monthly.map(m => (mm[rep] && mm[rep][m.month_num] ? mm[rep][m.month_num].revenue : 0)),
        ...monthly.map(m => (mm[rep] && mm[rep][m.month_num] ? mm[rep][m.month_num].qty : 0)),
      ])], [{ wch: 28 }, ...W(monthly.length * 2, 13)]);
    }

    /* 13 ── ASP mix plan */
    if (canPlan && aspPlan && aspPlan.rows && aspPlan.rows.length) {
      add('خطة مزيج ASP', [
        ['مفعّلة ضمن التوقع', includeAspPlan ? 'نعم' : 'لا'],
        ['ASP الحالي', aspModel ? +aspModel.A0Actual.toFixed(2) : ''],
        ['ASP المحتسب في المزيج (بأسعار مثبَّتة)', aspModel ? +aspModel.A0.toFixed(2) : ''],
        ['المستهدف المطلوب (الشريط)', targetAsp ?? ''],
        ['ASP الذي يبلغه المزيج', aspPlan.achieved],
        ['الهدف العام للشركة', aspCompanyTarget],
        [''],
        ['القناة','ASP المستخدم','ASP الفعلي للمنطقة','مثبَّت من','الحصة الحالية %','الحصة المطلوبة %','الفارق (نقطة)','الكمية المستهدفة'],
        ...aspPlan.rows.map(r => [r.name, r.asp, r.local_asp ?? r.asp,
          r.asp_pinned ? (r.asp_pinned_from || 'مرجع') : '',
          +r.share.toFixed(1), +r.new_share.toFixed(1), +r.delta.toFixed(1), Math.round(r.new_qty)]),
      ], [{ wch: 24 }, ...W(7, 18)]);
    }

    /* 14 ── Forecast */
    if (canPlan && forecast) {
      const fH = ['الشهر','الأساس','+ النمو','+ مناديب جدد','+ خطوط سير','+ رفع الزيارات','الإجمالي المتوقع','الكمية المتوقعة','مقابل الأساس %'];
      const fRows = forecast.rows.map(r => [
        r.month_name, Math.round(r.base_revenue), Math.round(r.growth_revenue),
        Math.round(r.reps_revenue), Math.round(r.routes_revenue), Math.round(r.visit_revenue),
        Math.round(r.total_revenue), Math.round(r.total_qty), r.vs_base_pct != null ? +r.vs_base_pct.toFixed(1) : '',
      ]);
      add('الخطة والتوقعات', [
        ['فروض الخطة'],
        ['نمو شهري %', growthPct],
        ['مناديب جدد', newReps, 'من شهر', MONTH_AR[newRepsStart]],
        ['خطوط سير جديدة', newRoutes, 'المحتسب فعلياً', forecast.eff_routes],
        ['رفع الزيارات مُضمَّن', includeVisitUplift ? 'نعم' : 'لا', 'الهدف', targetVpd, 'نسبة التحقق %', visitRealization],
        ['خطة ASP مُضمَّنة', includeAspPlan ? 'نعم' : 'لا', 'ASP المستهدف', aspPlan ? aspPlan.achieved : ''],
        ['متوسط إيراد المندوب/شهر', Math.round(forecast.rev_per_rep)],
        ['متوسط إيراد خط السير/شهر', Math.round(forecast.rev_per_route)],
        [''],
        fH, ...fRows,
        [''],
        ['إجمالي النصف الأول (فعلي)', Math.round(forecast.h1_revenue)],
        ['إجمالي المتبقي (متوقع)', Math.round(forecast.h2_revenue)],
        ['إجمالي العام', Math.round(forecast.year_revenue)],
        ['نمو المتبقي مقابل الفعلي %', forecast.h2_vs_h1_pct != null ? +forecast.h2_vs_h1_pct.toFixed(1) : ''],
        ['الزيادة مقابل الثبات', Math.round(forecast.uplift_vs_flat)],
      ], [{ wch: 26 }, ...W(fH.length - 1, 16)]);
    }

    const today = new Date().toLocaleDateString('en-CA');
    XLSX.writeFile(wb, `تقييم_المنطقة_${branchLabel}_${year}_${today}.xlsx`);
  }, [data, monthly, totals, current, gap, daily, forecast, branchLabel, periodLabel, year, custCatLabel,
      growthPct, newReps, newRepsStart, newRoutes, includeVisitUplift, targetVpd, visitRealization,
      aspPlan, aspModel, targetAsp, includeAspPlan, aspCompanyTarget]);


  /* ══════════════════════════════════════════════════════════ */
  return (
    <div className="rp-page">

      {/* ── Print header ── */}
      <div className="rp-print-header">
        <div className="rp-print-logo">📈 تقييم أداء المنطقة والتخطيط للنمو — {branchLabel}</div>
        <div className="rp-print-sub">{periodLabel}{custCats.length ? ` · ${custCatLabel}` : ''}</div>
      </div>

      {/* ── Page header ── */}
      <div className="rp-header rp-no-print">
        <div className="rp-header__left">
          <span className="rp-header__icon">📈</span>
          <div>
            <div className="rp-header__title">تقييم أداء المناطق والتخطيط للنمو</div>
            <div className="rp-header__sub">
              تقييم شامل للمبيعات والعملاء والزيارات والتحصيل، مع محرك توقعات وأهداف نمو للمتبقي من العام
            </div>
          </div>
        </div>
        <div className="rp-header__actions">
          {canPlan && (
          <label className="rp-print-toggle" title="عند إيقافه، لا يظهر قسم التخطيط والتوقعات (السيناريو) عند الطباعة">
            <input
              type="checkbox"
              checked={includePlanInPrint}
              onChange={e => setIncludePlanInPrint(e.target.checked)}
            />
            تضمين السيناريو بالطباعة
          </label>
          )}
          <button className="rp-btn rp-btn--outline" onClick={handleExport} disabled={!data}>📊 تصدير Excel</button>
          <button className="rp-btn rp-btn--outline" onClick={handlePrint}>🖨️ طباعة</button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="rp-filters rp-no-print">
        <div className="rp-filter-group">
          <label>المنطقة</label>
          <select value={branch} onChange={e => setBranch(e.target.value)} disabled={data?.meta?.region_locked}>
            <option value="">كل المناطق</option>
            {(filters?.branches || []).map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div className="rp-filter-group">
          <label>السنة</label>
          <select value={year} onChange={e => setYear(Number(e.target.value))}>
            {(filters?.years?.length ? filters.years : [2026, 2025]).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="rp-filter-group">
          <label>من شهر</label>
          <select value={fromMonth} onChange={e => setFromMonth(Number(e.target.value))}>
            {MONTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="rp-filter-group">
          <label>إلى شهر</label>
          <select value={toMonth} onChange={e => setToMonth(Number(e.target.value))}>
            {MONTHS.filter(([v]) => v >= fromMonth).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="rp-filter-group rp-filter-group--day">
          <label>من يوم</label>
          <select value={fromDay} onChange={e => setFromDay(Number(e.target.value))}>
            {Array.from({ length: fromDayMax }, (_, i) => i + 1)
              .map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="rp-filter-group rp-filter-group--day">
          <label>إلى يوم</label>
          <select value={Math.min(toDay, toDayMax)} onChange={e => setToDay(Number(e.target.value))}>
            {Array.from({ length: toDayMax }, (_, i) => i + 1)
              /* Same month: the end day can never precede the start day. */
              .filter(d => fromMonth !== toMonth || d >= fromDay)
              .map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="rp-filter-group">
          <label>فئة العميل</label>
          <CustCatPicker all={filters?.categories || []} value={custCats} onChange={setCustCats} />
        </div>
        {!branch && allBranches.includes(EXCLUDABLE_BRANCH) && (
          <label className={`rp-excl-toggle${excludeHafr ? ' rp-excl-toggle--on' : ''}`}
                 title={`${EXCLUDABLE_BRANCH_AR} شبه متوقفة، ووجودها يسحب وسيط المناطق ويشغل مرتبة في ترتيب التقييم`}>
            <input type="checkbox" checked={excludeHafr} onChange={e => setExcludeHafr(e.target.checked)} />
            استبعاد {EXCLUDABLE_BRANCH_AR}
          </label>
        )}
        {(branch || custCats.length || excludeHafr || excludedItemCats.length || fromMonth !== 1 || toMonth !== 6 || dayClamped) && (
          <button className="rp-btn rp-btn--ghost"
                  onClick={() => { setBranch(''); setCustCats([]); setFromMonth(1); setToMonth(6); setFromDay(1); setToDay(31);
                                   setExcludeHafr(false); setExcludedItemCats([]); }}>
            ✕ إعادة تعيين
          </button>
        )}
      </div>

      {allItemCats.length > 0 && (
        <div className="rp-itemcat-bar rp-no-print">
          <span className="rp-itemcat-label">فئات الأصناف المُدرَجة:</span>
          {(filters?.item_categories || []).map(c => {
            const on = !excludedItemCats.includes(c.name);
            return (
              <button key={c.name} type="button"
                      className={`rp-itemcat-chip${on ? ' rp-itemcat-chip--on' : ''}`}
                      title={on ? `مُدرَجة — اضغط لإهمالها (${fmt(c.qty)} وحدة)` : `مُهمَلة — اضغط لإدراجها (${fmt(c.qty)} وحدة)`}
                      disabled={on && excludedItemCats.length >= allItemCats.length - 1}
                      onClick={() => setExcludedItemCats(prev =>
                        prev.includes(c.name) ? prev.filter(x => x !== c.name)
                        : (prev.length >= allItemCats.length - 1 ? prev : [...prev, c.name]))}>
                {on ? '☑' : '☐'} {c.name}
              </button>
            );
          })}
          {excludedItemCats.length > 0 && (
            <>
              <button type="button" className="rp-itemcat-chip rp-itemcat-chip--all"
                      onClick={() => setExcludedItemCats([])}>↺ إدراج الكل</button>
              <span className="rp-itemcat-note">
                كل القراءات والنتائج في الصفحة محسوبة على {fmt(keptItemCats.length)} من {fmt(allItemCats.length)} فئة
              </span>
            </>
          )}
        </div>
      )}

      {isLoading && <div className="rp-loading"><div className="rp-spinner"/><span>جاري التحميل…</span></div>}
      {isError && !isLoading && <div className="rp-error">حدث خطأ في تحميل البيانات — يرجى المحاولة مجدداً.</div>}

      {data && !isLoading && (
        <>
          <div className="rp-period">
            <span className="rp-period__cur">{branchLabel}</span>
            <span className="rp-period__vs">·</span>
            <span className="rp-period__prev">{periodLabel}</span>
            <span className="rp-period__wd">
              · {totals.months_reported ?? monthly.length} أشهر ببيانات
              {totals.months_reported != null && totals.months_reported < monthly.length
                ? ` من ${monthly.length} مختارة` : ''}
              {' '}· {fmt(totals.rep_days)} يوم عمل فعلي للمناديب
            </span>
          </div>

          {/* ── Tabs ── */}
          <div className="rp-tabs rp-no-print">
            {[
              ['assess',  'التقييم'],
              ['mix',     'الفئات والأصناف'],
              ['reps',    'المناديب'],
              ['compare', 'مقارنة فترتين'],
              ['aspd',    'تتبع ASP اليومي'],
              ...(canPlan ? [['plan', 'التخطيط والتوقعات']] : []),
            ].map(([k, l]) => (
              <button key={k} className={`rp-tab${activeTab === k ? ' rp-tab--active' : ''}`}
                      onClick={() => setActiveTab(k)}>{l}</button>
            ))}
          </div>

          {/* ══════════════════════════════════════════
              TAB 1 — ASSESSMENT
          ══════════════════════════════════════════ */}
          {activeTab === 'assess' && (
            <div className="rp-tab-content">
              <div className="rp-section-title">مؤشرات الفترة</div>
              <div className="rp-kpi-row">
                <Kpi icon="📦" accent="blue" label="إجمالي الكمية" value={fmt(totals.qty)}
                     sub={`متوسط شهري: ${fmt(totals.avg_monthly_qty)}`}
                     dev={trend?.qty?.slope_pct} />
                <Kpi icon="💵" accent="green" label="إجمالي القيمة" value={`${fmtM(totals.revenue)} ر.س`}
                     sub={`متوسط شهري: ${fmtM(totals.avg_monthly_revenue)} ر.س`}
                     dev={trend?.revenue?.slope_pct} />
                <Kpi icon="🏷️" accent="purple" label="متوسط سعر البيع ASP" value={`${fmt(totals.asp, 2)} ر.س`}
                     sub={`لكل وحدة · ترند ${fmt(trend?.asp?.slope, 2)}/شهر`}
                     dev={trend?.asp?.slope_pct} />
                <Kpi icon="🚶" accent={totals.avg_visits_per_day >= 10 ? 'green' : 'orange'}
                     label="متوسط الزيارات اليومية" value={fmt(totals.avg_visits_per_day, 1)}
                     sub={`الهدف ${gap.target_min}–${gap.target_max} زيارة/يوم`} />
                <Kpi icon="📅" accent="blue" label="متوسط الكميات اليومية"
                     value={`${fmt(daily.qty_per_day)} وحدة`}
                     sub={`${fmt(daily.kg_per_day)} كجم/يوم · ${fmt(daily.qty_per_rep_day)} وحدة/مندوب/يوم`
                          + ` · ${fmt(daily.working_days)} يوم عمل`} />
              </div>

              <div className="rp-kpi-row">
                <Kpi icon="✅" accent="green" label="العملاء المتعاملون (آخر شهر)"
                     value={fmt(monthly[monthly.length - 1]?.active_customers)}
                     sub={`متوسط الفترة: ${fmt(totals.avg_active_customers, 1)} · مسجلون: ${fmt(current.registered_customers)}`}
                     dev={trend?.customers?.slope_pct} />
                <Kpi icon="🎯" accent={current.coverage_pct >= 60 ? 'green' : 'orange'}
                     label="معدل التغطية" value={pct(current.coverage_pct)}
                     sub="متعاملون ÷ مسجلون بالمنطقة" />
                <Kpi icon="👥" accent="blue" label="المناديب النشطة" value={fmt(totals.peak_active_reps)}
                     sub={`على الدفاتر: ${fmt(current.reps_on_books)} · خطوط سير: ${fmt(current.routes_on_books)}`} />
                <Kpi icon="🗑️" accent={totals.damages_pct > 1 ? 'red' : 'muted'}
                     label="نسبة التوالف" value={pct(totals.damages_pct, 2)}
                     sub={`${fmt(totals.damages)} وحدة · متوسط ${fmt(totals.avg_monthly_damages)}/شهر`} />
              </div>

              <div className="rp-kpi-row">
                <Kpi icon="💰" accent="green" label="معدل التحصيل" value={pct(totals.collection_pct)}
                     sub={`${fmtM(totals.collected)} محصّل من ${fmtM(totals.invoiced)} مفوتر`} />
                <Kpi icon="🏦" accent="red" label="الدين الحالي" value={`${fmt(current.current_debt)} ر.س`}
                     sub="صافي الرصيد القائم (بدون مبيعات direct)" />
                <Kpi icon="📊" accent="orange" label="متوسط نسبة الدين الشهري" value={pct(totals.avg_debt_ratio, 2)}
                     sub="رصيد الشهر ÷ مفوتر الشهر" />
                <Kpi icon="⚡" accent="purple" label="إيراد لكل زيارة" value={`${fmt(totals.revenue_per_visit)} ر.س`}
                     sub={`${fmt(totals.visits)} زيارة · إيراد/مندوب/شهر ${fmtM(totals.revenue_per_rep_month)}`} />
              </div>

              {/* Visit-gap callout */}
              {gap.at_max?.monthly_revenue > 0 && (
                <div className="rp-gap">
                  <span className="rp-gap-icon">🚀</span>
                  <div className="rp-gap-body">
                    <div className="rp-gap-title">فرصة نمو من رفع الزيارات اليومية</div>
                    <div className="rp-gap-desc">
                      المتوسط الحالي <strong>{fmt(gap.actual_vpd, 1)}</strong> زيارة/يوم لكل مندوب.
                      عند إيراد <strong>{fmt(gap.revenue_per_visit)}</strong> ر.س لكل زيارة و
                      <strong> {fmt(gap.avg_rep_days_per_month)}</strong> يوم-مندوب شهرياً:
                    </div>
                  </div>
                  <div className="rp-gap-stats">
                    <div className="rp-gap-stat">
                      <div className="rp-gap-stat-val">{fmtM(gap.at_min?.monthly_revenue)}</div>
                      <div className="rp-gap-stat-lbl">ر.س/شهر عند {gap.target_min} زيارة</div>
                    </div>
                    <div className="rp-gap-stat">
                      <div className="rp-gap-stat-val">{fmtM(gap.at_max?.monthly_revenue)}</div>
                      <div className="rp-gap-stat-lbl">ر.س/شهر عند {gap.target_max} زيارة</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Insights */}
              {insights.length > 0 && (
                <>
                  <div className="rp-section-title">قراءات وتوصيات</div>
                  <div className="rp-insights">
                    {insights.map((ins, i) => (
                      <div key={i} className={`rp-insight rp-insight--${ins.kind}`}>
                        <span className="rp-insight-icon">{ins.icon}</span>
                        <div>
                          <div className="rp-insight-title">{ins.title}</div>
                          <div className="rp-insight-desc">{ins.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Trends */}
              <div className="rp-section-title">الاتجاه الشهري</div>
              <div className="rp-twin-grid">
                <div className="rp-card">
                  <div className="rp-card__title">الكمية مقابل التوالف</div>
                  <TrendChart rows={monthly} aKey="qty" bKey="damages" aLabel="الكمية" bLabel="التوالف" />
                </div>
                <div className="rp-card">
                  <div className="rp-card__title">القيمة مقابل التحصيل</div>
                  <TrendChart rows={monthly} aKey="revenue" bKey="collected" aLabel="القيمة" bLabel="المحصّل" />
                </div>
              </div>

              {/* Monthly detail table */}
              <div className="rp-section-title rp-section-title--row">
                <span>التقييم الشهري التفصيلي</span>
                {monthRegions.size > 0 && (<>
                  <button className="rp-mini-btn" onClick={() => setShowMonthRegions(v => !v)}>
                    {showMonthRegions ? '▾ إخفاء تفاصيل المناطق' : '▸ إظهار تفاصيل المناطق'}
                  </button>
                  <button className={`rp-mini-btn${highlightBelow ? ' rp-mini-btn--on' : ''}`}
                          onClick={() => setHighlightBelow(v => !v)}
                          title="تمييز الفروع التي يقل ASP لديها عن المتوسط العام للفترة المختارة">
                    ⚠ تمييز ASP الأقل من المتوسط
                  </button>
                </>)}
              </div>
              {monthRegions.size > 0 && highlightBelow && aspBenchmark != null && (
                <div className="rp-legend">
                  <span className="rp-legend-swatch rp-legend-swatch--row"/>
                  فرع ASP لديه أقل من المتوسط العام
                  <strong className="rp-legend-val">{aspBenchmark.toFixed(2)}</strong>
                  <span className="rp-legend-note">
                    المتوسط العام لـ ASP = إجمالي القيمة ÷ إجمالي الكمية لكل الفروع في الفترة المختارة
                    (متوسط مرجّح بالكمية، حتى لا يُخِلّ فرع صغير بالمرجع). النسبة بجانب ASP = مقدار الانحراف عنه.
                  </span>
                </div>
              )}
              <div className="rp-mtable-wrap">
                <table className="rp-mtable rp-mtable--dense rp-mtable--monthly">
                  <colgroup>
                    {[
                      78,  // الشهر
                      38,  // أيام العمل
                      62,  // الكمية
                      56,  // متوسط كمية/يوم
                      46,  // حصة الكمية %
                      62,  // كميات كجم
                      54,  // القيمة
                      40,  // ASP
                      44,  // ASP السابق
                      48,  // فرق ASP %
                      44,  // عملاء فعالون
                      38,  // غير فعال
                      38,  // جدد
                      42,  // عائدون
                      42,  // مفقودون
                      38,  // مناديب
                      56,  // زيارات/يوم
                      44,  // كجم/يوم
                      46,  // إيراد/زيارة
                      46,  // إيراد/عميل
                      42,  // توالف %
                      48,  // توالف الجودة
                      50,  // توالف الجودة (كمية)
                      44,  // تحصيل %
                      46,  // نسبة الدين %
                    ].map((w, i) => <col key={i} style={{ width: w }} />)}
                  </colgroup>
                  <thead>
                    <tr>
                      <th>الشهر</th><th>أيام العمل</th><th>الكمية</th>
                      <th title="الكمية ÷ أيام العمل التقويمية للشهر — بخلاف «كجم/يوم» التي تُقسم على أيام المندوبين">متوسط كمية/يوم</th>
                      <th title="في صف الشهر: حصته من إجمالي كمية الفترة. في صف المنطقة: حصتها من كمية الشهر نفسه.">حصة الكمية %</th>
                      <th title="الكمية × وزن الوحدة المستخرج من اسم الصنف ÷ 1000">كميات كجم</th>
                      <th>القيمة</th><th>ASP</th>
                      <th title="ASP الشهر السابق — يُقرأ حتى لو كان خارج النطاق المختار">ASP السابق</th>
                      <th title="نسبة تغيّر ASP الحالي عن الشهر السابق">فرق ASP %</th>
                      <th>عملاء فعالون</th><th>غير فعال</th>
                      <th title="عملاء تعاملوا لأول مرة نهائياً — لا توجد لهم فواتير في أي سنة سابقة">🆕 جدد</th>
                      <th title="أول شهر يتعاملون فيه هذا العام، لكن لديهم فواتير من سنوات سابقة">🔄 عائدون</th>
                      <th title={churnHint}>مفقودون</th>
                      <th>مناديب</th><th>زيارات/يوم</th>
                      <th title="الكميات كجم ÷ أيام المندوبين — نفس مؤشر «إنتاجية الكمية» في جدول التقييم">كجم/يوم</th>
                      <th>إيراد/زيارة</th><th>إيراد/عميل</th>
                      <th>توالف %</th>
                      <th title="تكلفة توالف الجودة من التقرير المرفوع">توالف الجودة</th>
                      <th title="كمية توالف الجودة (وحدات) من نفس التقرير">توالف الجودة (كمية)</th>
                      <th>تحصيل %</th><th>نسبة الدين %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthly.map(m => (
                      <React.Fragment key={m.month_num}>
                      <tr style={m.has_data ? undefined : { opacity: .45 }}>
                        <td>
                          {monthRegions.has(m.month_num) && (
                            <button className="rp-row-toggle"
                              onClick={() => toggleMonthRegions(m.month_num)}
                              title="تفاصيل المناطق">
                              {openMonths.has(m.month_num) ? '−' : '+'}
                            </button>
                          )}
                          {m.month_name}{m.has_data ? '' : ' (لا بيانات)'}
                        </td>
                        <td>{m.working_days}</td>
                        <td>{fmt(m.qty)}</td>
                        <td>{fmt(m.working_days > 0 ? m.qty / m.working_days : null)}</td>
                        <td className="rp-share-pct">{qtyShare(m.qty, totals.qty)}</td>
                        <td>{fmt(m.qty_kg, 0)}</td>
                        <td>{fmtM(m.revenue)}</td>
                        <td>{fmt(m.asp, 2)}</td>
                        <td>{fmt(m.prev_asp, 2)}</td>
                        <td><AspDelta v={m.asp_delta_pct} /></td>
                        <td>{fmt(m.active_customers)}</td>
                        <td>{m.inactive_customers > 0 ? <span className="rp-neg">{fmt(m.inactive_customers)}</span> : '—'}</td>
                        <td>{m.new_customers ? <span className="rp-pos">+{m.new_customers}</span> : '—'}</td>
                        <td>{m.returning_customers ? <span className="rp-ret">↻{m.returning_customers}</span> : '—'}</td>
                        <td>{m.lost_customers == null ? '—' : (m.lost_customers > 0 ? <span className="rp-neg">−{m.lost_customers}</span> : '—')}</td>
                        <td>{fmt(m.active_reps)}</td>
                        <td>
                          <VisitBar vpd={m.visits_per_day}
                                    status={m.visits_per_day == null ? null
                                      : m.visits_per_day >= gap.target_max ? 'excellent'
                                      : m.visits_per_day >= gap.target_min ? 'ontarget'
                                      : m.visits_per_day >= gap.target_min * 0.7 ? 'below' : 'critical'}
                                    max={gap.target_max} />
                        </td>
                        <td>{fmt(m.kg_per_rep_day, 0)}</td>
                        <td>{fmt(m.revenue_per_visit)}</td>
                        <td>{fmt(m.revenue_per_customer)}</td>
                        <td>{m.damages_pct > 1 ? <span className="rp-neg">{pct(m.damages_pct, 2)}</span> : pct(m.damages_pct, 2)}</td>
                        <td>
                          {m.qi_cost > 0
                            ? <span className="rp-neg" title={`${fmt(m.qi_issue_count)} حالة`}>{fmtM(m.qi_cost)}</span>
                            : '—'}
                        </td>
                        <td>{m.qi_qty > 0 ? <span className="rp-neg">{fmt(m.qi_qty)}</span> : '—'}</td>
                        <td>{pct(m.collection_pct)}</td>
                        <td>{pct(m.debt_ratio, 2)}</td>
                      </tr>
                      {openMonths.has(m.month_num) && (monthRegions.get(m.month_num) || []).map(r => (
                        <tr key={`${m.month_num}-${r.branch}`}
                            className={`rp-subrow${aspIsWeak(r.asp) ? ' rp-subrow--alert' : ''}`}>
                          <td className="rp-subrow-name">↳ {r.branch}</td>
                          <td>{r.working_days}</td>
                          <td>{fmt(r.qty)}</td>
                          <td>{fmt(r.working_days > 0 ? r.qty / r.working_days : null)}</td>
                          <td className="rp-share-pct">{qtyShare(r.qty, m.qty)}</td>
                          <td>{fmt(r.qty_kg, 0)}</td>
                          <td>{fmtM(r.revenue)}</td>
                          <td className={aspIsWeak(r.asp) ? 'rp-cell-alert' : undefined}>
                            {fmt(r.asp, 2)}
                            {aspIsWeak(r.asp) && (
                              <span className="rp-below-tag"
                                    title={`أقل من متوسط ASP العام (${aspBenchmark.toFixed(2)})`}>
                                {Math.round(((r.asp - aspBenchmark) / aspBenchmark) * 100)}%
                              </span>
                            )}
                          </td>
                          <td>{fmt(r.prev_asp, 2)}</td>
                          <td><AspDelta v={r.asp_delta_pct} /></td>
                          <td>{fmt(r.active_customers)}</td>
                          <td>{r.inactive_customers > 0 ? <span className="rp-neg">{fmt(r.inactive_customers)}</span> : '—'}</td>
                          <td>{r.new_customers ? <span className="rp-pos">+{r.new_customers}</span> : '—'}</td>
                          <td>{r.returning_customers ? <span className="rp-ret">↻{r.returning_customers}</span> : '—'}</td>
                          <td>{r.lost_customers == null ? '—' : (r.lost_customers > 0 ? <span className="rp-neg">−{r.lost_customers}</span> : '—')}</td>
                          <td>{fmt(r.active_reps)}</td>
                          <td>
                            <VisitBar vpd={r.visits_per_day}
                                      status={r.visits_per_day == null ? null
                                        : r.visits_per_day >= gap.target_max ? 'excellent'
                                        : r.visits_per_day >= gap.target_min ? 'ontarget'
                                        : r.visits_per_day >= gap.target_min * 0.7 ? 'below' : 'critical'}
                                      max={gap.target_max} />
                          </td>
                          <td>{fmt(r.kg_per_rep_day, 0)}</td>
                          <td>{fmt(r.revenue_per_visit)}</td>
                          <td>{fmt(r.revenue_per_customer)}</td>
                          <td>{r.damages_pct > 1 ? <span className="rp-neg">{pct(r.damages_pct, 2)}</span> : pct(r.damages_pct, 2)}</td>
                          <td>{r.qi_cost > 0
                            ? <span className="rp-neg" title={`${fmt(r.qi_issue_count)} حالة`}>{fmtM(r.qi_cost)}</span>
                            : '—'}</td>
                          <td>{r.qi_qty > 0 ? <span className="rp-neg">{fmt(r.qi_qty)}</span> : '—'}</td>
                          <td>{pct(r.collection_pct)}</td>
                          <td>{pct(r.debt_ratio, 2)}</td>
                        </tr>
                      ))}
                      </React.Fragment>
                    ))}
                    {!monthly.length && <tr><td colSpan={25} className="rp-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                  {monthly.length > 0 && (
                    <tfoot>
                      <tr>
                        <td>الإجمالي / المتوسط</td>
                        <td>—</td>
                        <td>{fmt(totals.qty)}</td>
                        <td>{fmt(daily.qty_per_day)}</td>
                        <td className="rp-share-pct">100.0%</td>
                        <td>{fmt(totals.qty_kg, 0)}</td>
                        <td>{fmtM(totals.revenue)}</td>
                        <td>{fmt(totals.asp, 2)}</td>
                        {/* A period aggregate has no single "previous month" —
                            showing one here would invite a wrong reading. */}
                        <td>—</td><td>—</td>
                        <td>{fmt(totals.avg_active_customers, 1)}</td>
                        <td>{fmt(totals.avg_inactive_customers, 1)}</td>
                        <td>{churnTotals.new ? <span className="rp-pos">+{churnTotals.new}</span> : '—'}</td>
                        <td>{churnTotals.returning ? <span className="rp-ret">↻{churnTotals.returning}</span> : '—'}</td>
                        <td>{churnTotals.lost ? <span className="rp-neg">−{churnTotals.lost}</span> : '—'}</td>
                        <td>{fmt(totals.peak_active_reps)}</td>
                        <td>{fmt(totals.avg_visits_per_day, 1)}</td>
                        <td>{fmt(totals.rep_days > 0 ? totals.qty_kg / totals.rep_days : null, 0)}</td>
                        <td>{fmt(totals.revenue_per_visit)}</td>
                        <td>—</td>
                        <td>{pct(totals.damages_pct, 2)}</td>
                        <td>{totals.qi_cost > 0 ? fmtM(totals.qi_cost) : '—'}</td>
                        <td>{totals.qi_qty > 0 ? fmt(totals.qi_qty) : '—'}</td>
                        <td>{pct(totals.collection_pct)}</td>
                        <td>{pct(totals.avg_debt_ratio, 2)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>

              <div className="rp-colref">
                <button type="button" className="rp-mini-btn" onClick={() => setShowColRef(v => !v)}>
                  {showColRef ? '▾ إخفاء طريقة حساب الأعمدة' : '▸ طريقة حساب الأعمدة'}
                </button>
                {showColRef && (
                  <div className="rp-colref-body">
                    <dl className="rp-colref-list">
                      {COLUMN_REFERENCE.map(([term, def]) => (
                        <div className="rp-colref-item" key={term}>
                          <dt>{term}</dt>
                          <dd>{def}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="rp-colref-foot">{churnHint}</div>
                  </div>
                )}
              </div>

              {/* ── Weighted scorecard ── */}
              {scorecard.regions?.length > 0 && (<>
                <div className="rp-section-title">منهجية التقييم والمعايير المرجعية</div>
                <div className="rp-legend" style={{ marginBottom: 10 }}>
                  <span className="rp-legend-note" style={{ marginBottom: 4 }}>
                    المقارنة المرجعية للمناطق = وسيط المناطق، وللمندوب = وسيط مناديب منطقته.
                    هدف كل مؤشر = الأعلى بين (قيمة المنطقة الحالية +3% أو +8%) وبين الهدف الثابت للشركة،
                    والنتيجة = القيمة ÷ الهدف بحد أقصى وزن المؤشر، ثم يُعاد ترجيح المجموع على 100%.
                    «فجوة الزيارة» = هدف الزيارات (13) ناقص الزيارات الفعلية، والصفر هو الأفضل.
                    {scorecard.momentum?.usable
                      ? ` الزخم يقارن ${scorecard.momentum.late_names.join('–')} بـ${scorecard.momentum.early_names.join('–')}`
                        + (scorecard.momentum.excluded_current_month
                            ? ` (استُبعد ${scorecard.momentum.excluded_current_month} لأنه شهر جارٍ غير مكتمل).`
                            : '.')
                      : ' الزخم غير محسوب — النطاق المختار أقصر من أن يُقارن.'}
                  </span>
                </div>
                <div className="rp-mtable-wrap">
                  <table className="rp-mtable rp-mtable--dense rp-mtable--score">
                    <colgroup>
                      <col style={{ width: 26 }} />
                      <col style={{ width: 86 }} />
                      {scorecard.indicators.map(ind => <col key={ind.key} style={{ width: 60 }} />)}
                      <col style={{ width: 80 }} />
                      <col style={{ width: '15%' }} />
                      <col style={{ width: '15%' }} />
                      <col style={{ width: '20%' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>المنطقة</th>
                        {scorecard.indicators.map(ind => (
                          <th key={ind.key} title={ind.hint}>{ind.label}<br/><span className="rp-score-w">{ind.weight}%</span></th>
                        ))}
                        <th>التقييم</th>
                        <th className="rp-advice-th">نقاط القوة</th>
                        <th className="rp-advice-th">نقاط الضعف</th>
                        <th className="rp-advice-th">التوصية العملية</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scorecard.regions.map(r => (
                        <tr key={r.key}>
                          <td>{r.rank ?? '—'}</td>
                          <td style={{ fontWeight: 700 }}>{r.name}</td>
                          {scorecard.indicators.map(ind => {
                            const p = (r.parts || []).find(x => x.key === ind.key);
                            if (!p || p.points == null) return <td key={ind.key}><span className="rp-muted">—</span></td>;
                            return (
                              <td key={ind.key}
                                  className={p.ratio < 1 ? 'rp-cell-alert' : undefined}
                                  title={`${Number(p.value).toFixed(2)} — الهدف ${ind.dir === 'low' ? '≤' : '≥'} ${Number(p.benchmark).toFixed(2)}`
                                       + `${p.median != null ? ` · وسيط ${Number(p.median).toFixed(2)}` : ''}`
                                       + ` — ${p.points.toFixed(1)} من ${p.weight} نقطة`}>
                                {Number(p.value).toFixed(Math.abs(p.value) >= 100 ? 0 : 2)}
                                <span className="rp-score-ratio">
                                  {Math.round(p.ratio * 100)}% · {Number(p.benchmark).toFixed(p.benchmark >= 100 ? 0 : 2)}
                                </span>
                              </td>
                            );
                          })}
                          <td><ScoreCell row={r} indicators={scorecard.indicators} /></td>
                          <td className="rp-advice-td"><AdviceCell items={r.strengths}  kind="good"/></td>
                          <td className="rp-advice-td"><AdviceCell items={r.weaknesses} kind="bad"/></td>
                          <td className="rp-advice-td"><AdviceCell items={r.actions}    kind="act"/></td>
                        </tr>
                      ))}
                      <tr className="rp-score-bench">
                        <td/><td title="الهدف الثابت للشركة — أرضية تنطبق على جميع المناطق والمناديب">الهدف الثابت</td>
                        {scorecard.indicators.map(ind => (
                          <td key={ind.key}>
                            {ind.mode === 'gap' ? '0'
                              : ind.floorValue != null ? Number(ind.floorValue).toFixed(ind.floorValue >= 100 ? 0 : 2)
                              : ind.mode === 'fixed' ? Number(ind.factor).toFixed(2) : '—'}
                          </td>
                        ))}
                        <td>—</td><td/><td/><td/>
                      </tr>
                      <tr className="rp-score-bench rp-score-bench--soft">
                        <td/><td title="وسيط المناطق — معروض للمقارنة فقط، ولا يدخل في احتساب التقييم">وسيط المناطق</td>
                        {scorecard.indicators.map(ind => (
                          <td key={ind.key}>
                            {scorecard.region_benchmarks?.[ind.key] != null
                              ? Number(scorecard.region_benchmarks[ind.key])
                                  .toFixed(scorecard.region_benchmarks[ind.key] >= 100 ? 0 : 2) : '—'}
                          </td>
                        ))}
                        <td>—</td><td/><td/><td/>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>)}

            </div>
          )}

          {/* ══════════════════════════════════════════
              TAB 2 — MIX (categories & items)
          ══════════════════════════════════════════ */}
          {activeTab === 'mix' && (
            <div className="rp-tab-content">
              <div className="rp-section-title">فئات العملاء</div>
              <div className="rp-twin-grid">
                <div className="rp-card">
                  <div className="rp-card__title">القيمة حسب فئة العميل</div>
                  <HBar rows={data.by_customer_category} valueKey="revenue" labelKey="name" money />
                </div>
                <div className="rp-card">
                  <div className="rp-card__title">الكمية حسب فئة العميل</div>
                  <HBar rows={data.by_customer_category} valueKey="qty" labelKey="name" colorClass="rp-bar--accent" />
                </div>
              </div>
              <div className="rp-mtable-wrap" style={{ marginTop: 12 }}>
                <table className="rp-mtable">
                  <thead>
                    <tr><th>فئة العميل</th><th>الكمية</th><th>القيمة</th><th>ASP</th>
                        <th>حصة القيمة</th><th>عملاء</th><th>توالف</th></tr>
                  </thead>
                  <tbody>
                    {(data.by_customer_category || []).map(c => (
                      <tr key={c.name}>
                        <td>{c.name}</td><td>{fmt(c.qty)}</td><td>{fmtM(c.revenue)}</td>
                        <td>{fmt(c.asp, 2)}</td><td>{pct(c.revenue_share)}</td>
                        <td>{fmt(c.customers)}</td><td>{fmt(c.damages)}</td>
                      </tr>
                    ))}
                    {(data.by_customer_category || []).length > 0 && (() => {
                      const rows = data.by_customer_category;
                      const q = rows.reduce((a, c) => a + (Number(c.qty) || 0), 0);
                      const v = rows.reduce((a, c) => a + (Number(c.revenue) || 0), 0);
                      const d = rows.reduce((a, c) => a + (Number(c.damages) || 0), 0);
                      return (
                        <tr className="rp-cat-total">
                          <td>الإجمالي</td>
                          <td>{fmt(q)}</td>
                          <td>{fmtM(v)}</td>
                          {/* weighted, not the mean of the column */}
                          <td>{fmt(q > 0 ? v / q : null, 2)}</td>
                          <td>{pct(100)}</td>
                          <td title="عدد العملاء المتعاملين خلال الفترة دون تكرار — لا يساوي جمع العمود لأن العميل قد يشتري من أكثر من قناة">
                            {totals.customers_distinct != null ? fmt(totals.customers_distinct) : '—'}
                          </td>
                          <td>{fmt(d)}</td>
                        </tr>
                      );
                    })()}
                    {!(data.by_customer_category || []).length && <tr><td colSpan={7} className="rp-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                </table>
              </div>

              <HalfYearTable rows={data.by_customer_category} halfYear={data.meta?.half_year} nameLabel="فئة العميل"
                             aspPlan={aspPlan} targetAsp={targetAsp} companyTarget={aspCompanyTarget}
                             planActive={includeAspPlan} showShare />

              <div className="rp-section-title">فئات الأصناف</div>
              <div className="rp-twin-grid">
                <div className="rp-card">
                  <div className="rp-card__title">القيمة حسب فئة الصنف</div>
                  <HBar rows={data.by_item_category} valueKey="revenue" labelKey="name" money />
                </div>
                <div className="rp-card">
                  <div className="rp-card__title">متوسط سعر البيع ASP حسب فئة الصنف</div>
                  <HBar rows={[...(data.by_item_category || [])].sort((a, b) => (b.asp || 0) - (a.asp || 0))}
                        valueKey="asp" labelKey="name" colorClass="rp-bar--accent" decimals={2} />
                </div>
              </div>
              <div className="rp-mtable-wrap" style={{ marginTop: 12 }}>
                <table className="rp-mtable">
                  <thead>
                    <tr><th>فئة الصنف</th><th>الكمية</th><th>القيمة</th><th>ASP</th>
                        <th>حصة القيمة</th><th>توالف</th></tr>
                  </thead>
                  <tbody>
                    {(data.by_item_category || []).map(c => (
                      <tr key={c.name}>
                        <td>{c.name}</td><td>{fmt(c.qty)}</td><td>{fmtM(c.revenue)}</td>
                        <td>{fmt(c.asp, 2)}</td><td>{pct(c.revenue_share)}</td><td>{fmt(c.damages)}</td>
                      </tr>
                    ))}
                    {(data.by_item_category || []).length > 0 && (() => {
                      const rows = data.by_item_category;
                      const q = rows.reduce((a, c) => a + (Number(c.qty) || 0), 0);
                      const v = rows.reduce((a, c) => a + (Number(c.revenue) || 0), 0);
                      const d = rows.reduce((a, c) => a + (Number(c.damages) || 0), 0);
                      return (
                        <tr className="rp-cat-total">
                          <td>الإجمالي</td>
                          <td>{fmt(q)}</td>
                          <td>{fmtM(v)}</td>
                          <td>{fmt(q > 0 ? v / q : null, 2)}</td>
                          <td>{pct(100)}</td>
                          <td>{fmt(d)}</td>
                        </tr>
                      );
                    })()}
                    {!(data.by_item_category || []).length && <tr><td colSpan={6} className="rp-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                </table>
              </div>

              <HalfYearTable rows={data.by_item_category} halfYear={data.meta?.half_year} nameLabel="فئة الصنف"
                             aspPlan={aspPlan} targetAsp={targetAsp} companyTarget={aspCompanyTarget}
                             planActive={includeAspPlan} />

              <div className="rp-section-title">الأصناف (أعلى 60 بالقيمة)</div>
              <div className="rp-mtable-wrap">
                <table className="rp-mtable">
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>#</th>
                      <Th col="name" sort={itemSort} onSort={onItemSort}>الصنف</Th>
                      <th>الفئة</th>
                      <Th col="qty" sort={itemSort} onSort={onItemSort}>الكمية</Th>
                      <Th col="revenue" sort={itemSort} onSort={onItemSort}>القيمة</Th>
                      <Th col="asp" sort={itemSort} onSort={onItemSort}>ASP</Th>
                      <Th col="revenue_share" sort={itemSort} onSort={onItemSort}>حصة القيمة</Th>
                      <Th col="damages" sort={itemSort} onSort={onItemSort}>توالف</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedItems.map((it, i) => (
                      <tr key={`${it.name}-${i}`}>
                        <td>{i + 1}</td>
                        <td>{it.name}</td>
                        <td style={{ fontSize: '0.72rem', color: '#64748b' }}>{it.category}</td>
                        <td>{fmt(it.qty)}</td><td>{fmtM(it.revenue)}</td>
                        <td>{fmt(it.asp, 2)}</td><td>{pct(it.revenue_share)}</td><td>{fmt(it.damages)}</td>
                      </tr>
                    ))}
                    {!sortedItems.length && <tr><td colSpan={8} className="rp-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════
              TAB 3 — REPS
          ══════════════════════════════════════════ */}
          {activeTab === 'reps' && (
            <div className="rp-tab-content">
              <div className="rp-cust-meta">
                <span>عدد المناديب: <strong>{fmt((data.by_rep || []).length)}</strong></span>
                <span>متوسط الزيارات/يوم: <strong>{fmt(totals.avg_visits_per_day, 1)}</strong></span>
                <span>الهدف: <strong>{gap.target_min}–{gap.target_max}</strong></span>
                <span>داخل الهدف: <strong>{(data.by_rep || []).filter(r => ['ontarget', 'excellent'].includes(r.visit_status)).length}</strong></span>
                <span>أقل من الهدف: <strong>{(data.by_rep || []).filter(r => ['below', 'critical'].includes(r.visit_status)).length}</strong></span>
              </div>

              <div className="rp-twin-grid">
                <div className="rp-card">
                  <div className="rp-card__title">القيمة حسب المندوب</div>
                  <HBar rows={[...(data.by_rep || [])].sort((a, b) => b.revenue - a.revenue)}
                        valueKey="revenue" labelKey="rep" money maxBars={15} />
                </div>
                <div className="rp-card">
                  <div className="rp-card__title">الزيارات اليومية حسب المندوب</div>
                  <HBar rows={[...(data.by_rep || [])].sort((a, b) => (b.visits_per_day || 0) - (a.visits_per_day || 0))}
                        valueKey="visits_per_day" labelKey="rep" colorClass="rp-bar--accent" maxBars={15} decimals={1} />
                </div>
              </div>

              <div className="rp-mtable-wrap" style={{ marginTop: 12 }}>
                <table className="rp-mtable rp-mtable--dense rp-mtable--reps">
                  <colgroup>
                    <col style={{ width: 24 }} />{/* # */}
                    <col style={{ width: 130 }} />{/* المندوب */}
                    <col style={{ width: 84 }} />{/* التقييم */}
                    <col style={{ width: 52 }} />{/* الكمية */}
                    <col style={{ width: 50 }} />{/* القيمة */}
                    <col style={{ width: 42 }} />{/* ASP */}
                    <col style={{ width: 40 }} />{/* عملاء */}
                    <col style={{ width: 44 }} />{/* زيارات */}
                    <col style={{ width: 40 }} />{/* أيام عمل */}
                    <col style={{ width: 62 }} />{/* زيارات/يوم */}
                    <col style={{ width: 52 }} />{/* كجم/يوم */}
                    <col style={{ width: 70 }} />{/* الحالة */}
                    <col style={{ width: 48 }} />{/* إيراد/زيارة */}
                    <col style={{ width: 46 }} />{/* توالف % */}
                    <col style={{ width: 46 }} />{/* الترند */}
                    <col style={{ width: 50 }} />{/* مسار القيمة */}
                    <col style={{ width: '14%' }} />
                    <col style={{ width: '14%' }} />
                    <col style={{ width: '18%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>#</th>
                      <Th col="rep" sort={repSort} onSort={onRepSort}>المندوب</Th>
                      <Th col="score" sort={repSort} onSort={onRepSort}>التقييم</Th>
                      <Th col="qty" sort={repSort} onSort={onRepSort}>الكمية</Th>
                      <Th col="revenue" sort={repSort} onSort={onRepSort}>القيمة</Th>
                      <Th col="asp" sort={repSort} onSort={onRepSort}>ASP</Th>
                      <Th col="customers" sort={repSort} onSort={onRepSort}>عملاء</Th>
                      <Th col="visits" sort={repSort} onSort={onRepSort}>زيارات</Th>
                      <Th col="active_days" sort={repSort} onSort={onRepSort}>أيام عمل</Th>
                      <Th col="visits_per_day" sort={repSort} onSort={onRepSort}>زيارات/يوم</Th>
                      <Th col="kg_per_day" sort={repSort} onSort={onRepSort}>كجم/يوم</Th>
                      <th>الحالة</th>
                      <Th col="revenue_per_visit" sort={repSort} onSort={onRepSort}>إيراد/زيارة</Th>
                      <Th col="damages_pct" sort={repSort} onSort={onRepSort}>توالف %</Th>
                      <Th col="trend_slope_pct" sort={repSort} onSort={onRepSort}>الترند</Th>
                      <th>مسار القيمة</th>
                      <th className="rp-advice-th">نقاط القوة</th>
                      <th className="rp-advice-th">نقاط الضعف</th>
                      <th className="rp-advice-th">التوصية العملية</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedReps.map((r, i) => {
                      const maxS = Math.max(...r.series.map(s => s.revenue), 1);
                      return (
                        <tr key={r.rep}>
                          <td>{i + 1}</td>
                          <td style={{ whiteSpace: 'normal' }}>{r.rep}</td>
                          <td><ScoreCell row={r} indicators={scorecard.indicators} /></td>
                          <td>{fmt(r.qty)}</td>
                          <td>{fmtM(r.revenue)}</td>
                          <td>{fmt(r.asp, 2)}</td>
                          <td>{fmt(r.customers)}</td>
                          <td>{fmt(r.visits)}</td>
                          <td>{fmt(r.active_days)}</td>
                          <td style={{ minWidth: 100 }}>
                            <VisitBar vpd={r.visits_per_day} status={r.visit_status} max={gap.target_max} />
                          </td>
                          <td>{fmt(r.kg_per_day, 0)}</td>
                          <td>
                            {r.visit_status
                              ? <span className={`rp-pill rp-pill--${r.visit_status}`}>{VISIT_LABEL[r.visit_status]}</span>
                              : '—'}
                          </td>
                          <td>{fmt(r.revenue_per_visit)}</td>
                          <td>{r.damages_pct > 1 ? <span className="rp-neg">{pct(r.damages_pct, 2)}</span> : pct(r.damages_pct, 2)}</td>
                          <td><Dev value={r.trend_slope_pct} /></td>
                          <td>
                            <span className="rp-spark">
                              {r.series.map((s, si) => (
                                <span key={si}
                                      className={`rp-spark-bar${si === r.series.length - 1 ? ' rp-spark-bar--last' : ''}`}
                                      style={{ height: `${Math.max(2, (s.revenue / maxS) * 24)}px` }}
                                      title={`${MONTH_AR[s.month_num]}: ${fmtM(s.revenue)}`} />
                              ))}
                            </span>
                          </td>
                          <td className="rp-advice-td"><AdviceCell items={r.strengths}  kind="good"/></td>
                          <td className="rp-advice-td"><AdviceCell items={r.weaknesses} kind="bad"/></td>
                          <td className="rp-advice-td"><AdviceCell items={r.actions}    kind="act"/></td>
                        </tr>
                      );
                    })}
                    {!sortedReps.length && <tr><td colSpan={19} className="rp-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                </table>
              </div>

              {/* Rep × month matrix */}
              <div className="rp-matrix-header">
                <div className="rp-section-title" style={{ margin: 0 }}>مصفوفة ترند المناديب</div>
                <div className="rp-metric-toggle">
                  <button className={repMatrixMetric === 'revenue' ? 'active' : ''} onClick={() => setRepMatrixMetric('revenue')}>القيمة</button>
                  <button className={repMatrixMetric === 'qty' ? 'active' : ''} onClick={() => setRepMatrixMetric('qty')}>الكمية</button>
                  <button className={repMatrixMetric === 'both' ? 'active' : ''} onClick={() => setRepMatrixMetric('both')}>كلاهما</button>
                </div>
              </div>
              <div className="rp-matrix-wrap">
                <table className="rp-matrix-table">
                  <thead>
                    <tr>
                      <th className="rp-matrix-th-item">المندوب</th>
                      {monthly.map(m => <th key={m.month_num} className="rp-matrix-th-month">{m.month_name}</th>)}
                      <th className="rp-matrix-th-total">الإجمالي</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedReps.map(r => {
                      const maxAll = Math.max(...(data.by_rep || []).flatMap(x => x.series.map(s => s.revenue)), 1);
                      return (
                        <tr key={r.rep}>
                          <td className="rp-matrix-td-item">{r.rep}</td>
                          {r.series.map(s => {
                            const inten = maxAll > 0 ? s.revenue / maxAll : 0;
                            return (
                              <td key={s.month_num} className="rp-matrix-td-cell"
                                  style={{ background: s.revenue > 0 ? `rgba(59,130,246,${0.08 + inten * 0.55})` : 'transparent' }}>
                                {renderRepMatrixCell(s, repMatrixMetric)}
                              </td>
                            );
                          })}
                          <td className="rp-matrix-td-total">{renderRepMatrixCell(r, repMatrixMetric)}</td>
                        </tr>
                      );
                    })}
                    {!sortedReps.length && <tr><td colSpan={monthly.length + 2} className="rp-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                  <tfoot>
                    <tr className="rp-matrix-tf-row">
                      <td className="rp-matrix-td-item rp-matrix-td-item--tf">الإجمالي</td>
                      {monthly.map(m => (
                        <td key={m.month_num} className="rp-matrix-td-total">
                          {renderRepMatrixCell(m, repMatrixMetric)}
                        </td>
                      ))}
                      <td className="rp-matrix-td-total rp-matrix-td-grand">
                        {renderRepMatrixCell(totals, repMatrixMetric)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════
              TAB 4 — PERIOD COMPARISON (two arbitrary date ranges)
          ══════════════════════════════════════════ */}
          {activeTab === 'compare' && (
            <PeriodCompareTab
              branch={branch}
              branchParams={branchParams}
              custCatParams={custCats}
              itemCatParams={itemCatActive ? keptItemCats : []}
            />
          )}

          {/* ══════════════════════════════════════════
              TAB 5 — DAILY ASP TRACKING (by week)
          ══════════════════════════════════════════ */}
          {activeTab === 'aspd' && (
            <AspDailyTab
              branchParams={branchParams}
              custCatParams={custCats}
              itemCatParams={itemCatActive ? keptItemCats : []}
              year={year}
              fromMonth={fromMonth}
              toMonth={toMonth}
              fromDay={fromDay}
              toDay={toDay}
            />
          )}

          {/* ══════════════════════════════════════════
              TAB 6 — PLANNING / FORECAST
          ══════════════════════════════════════════ */}
          {activeTab === 'plan' && canPlan && (
            <div className="rp-tab-content">
              {!forecast ? (
                <div className="rp-error">
                  لا توجد أشهر متبقية للتوقع — اختر «إلى شهر» أقل من ديسمبر لعرض خطة المتبقي من العام.
                </div>
              ) : (
                <div className="rp-plan-grid">

                  {/* ── Controls ── */}
                  {/* ── Controls (right side) — excluded from print when the toggle above is off ── */}
                  <div className={`rp-controls${includePlanInPrint ? '' : ' rp-no-print'}`}>
                    <div className="rp-ctrl">
                      <div className="rp-ctrl-label"><span>سيناريو جاهز</span></div>
                      <div className="rp-scenarios">
                        {[['conservative','محافظ'],['balanced','متوازن'],['ambitious','طموح']].map(([k, l]) => (
                          <button key={k} className={`rp-scen-btn${scenario === k ? ' rp-scen-btn--active' : ''}`}
                                  onClick={() => applyScenario(k)}>
                            {l}<br/><span style={{ fontSize: '0.66rem', opacity: .85 }}>{scenarioGrowth[k]}%</span>
                          </button>
                        ))}
                      </div>
                      <div className="rp-ctrl-hint">
                        مبنية على ترند القيمة الفعلي للفترة ({trendGrowth != null ? `${trendGrowth}%/شهر` : 'غير متاح'}).
                      </div>
                    </div>

                    <div className="rp-ctrl">
                      <div className="rp-ctrl-label">
                        <span>نسبة النمو الشهرية</span>
                        <span className="rp-ctrl-val">{growthPct}%</span>
                      </div>
                      <input type="range" className="rp-range" min="0" max="25" step="0.5"
                             value={growthPct}
                             onChange={e => { setGrowthPct(Number(e.target.value)); setScenario('custom'); }} />
                      <div className="rp-ctrl-hint">نمو مركّب شهرياً فوق متوسط آخر 3 أشهر فعلية.</div>
                    </div>

                    <div className="rp-ctrl-divider" />

                    <div className="rp-ctrl">
                      <div className="rp-ctrl-label"><span>مناديب جدد</span><span className="rp-ctrl-val">{newReps}</span></div>
                      <input type="number" className="rp-num" min="0" max="20" value={newReps}
                             onChange={e => setNewReps(Math.max(0, Number(e.target.value) || 0))} />
                      <div className="rp-ctrl-label" style={{ marginTop: 8 }}><span>يبدأون من شهر</span></div>
                      <select className="rp-num" value={newRepsStart}
                              onChange={e => setNewRepsStart(Number(e.target.value))}>
                        {forecast.rows.map(r => <option key={r.month_num} value={r.month_num}>{r.month_name}</option>)}
                      </select>
                      <div className="rp-ctrl-hint">
                        متوسط إيراد المندوب: {fmtM(forecast.rev_per_rep)} ر.س/شهر · إنتاجية تدريجية
                        {' '}{RAMP.map(r => `${r * 100}%`).join(' → ')}
                      </div>

                      <label className="rp-check" style={{ marginTop: 10 }}>
                        <input type="checkbox" checked={newRepCapEnabled}
                               onChange={e => setNewRepCapEnabled(e.target.checked)} />
                        سقف لكمية المندوب الجديد الشهرية
                      </label>
                      {newRepCapEnabled && (
                        <>
                          <input type="number" className="rp-num" min="0" step="1000"
                                 style={{ marginTop: 6 }}
                                 value={newRepQtyCap}
                                 onChange={e => setNewRepQtyCap(Math.max(0, Number(e.target.value) || 0))} />
                          <div className="rp-ctrl-hint">
                            {forecast.rep_cap_bites
                              ? <>متوسط المندوب بالمنطقة {fmt(Math.round(forecast.qty_per_rep_raw))} وحدة/شهر —
                                  أعلى من السقف، فيُحتسب المندوب الجديد بـ
                                  {' '}<strong>{fmt(Math.round(forecast.qty_per_rep))} وحدة/شهر</strong> فقط.</>
                              : <>متوسط المندوب بالمنطقة {fmt(Math.round(forecast.qty_per_rep_raw))} وحدة/شهر —
                                  أقل من السقف، فلا يُطبَّق ويُحتسب المتوسط كما هو.</>}
                          </div>
                        </>
                      )}
                    </div>

                    <div className="rp-ctrl">
                      <div className="rp-ctrl-label"><span>خطوط سير جديدة</span><span className="rp-ctrl-val">{newRoutes}</span></div>
                      <input type="number" className="rp-num" min="0" max="20" value={newRoutes}
                             onChange={e => setNewRoutes(Math.max(0, Number(e.target.value) || 0))} />
                      <div className="rp-ctrl-label" style={{ marginTop: 8 }}><span>تبدأ من شهر</span></div>
                      <select className="rp-num" value={newRoutesStart}
                              onChange={e => setNewRoutesStart(Number(e.target.value))}>
                        {forecast.rows.map(r => <option key={r.month_num} value={r.month_num}>{r.month_name}</option>)}
                      </select>
                      <label className="rp-check" style={{ marginTop: 8 }}>
                        <input type="checkbox" checked={linkRepRoute} onChange={e => setLinkRepRoute(e.target.checked)} />
                        كل مندوب جديد يشغّل خط سير جديد — لا يُحتسب مرتين
                        {linkRepRoute && newRoutes > 0 && ` (المحتسب: ${forecast.eff_routes})`}
                      </label>
                      <div className="rp-ctrl-hint">
                        متوسط إيراد خط السير: {fmtM(forecast.rev_per_route)} ر.س/شهر
                      </div>
                    </div>

                    <div className="rp-ctrl-divider" />

                    <div className="rp-ctrl">
                      <label className="rp-check">
                        <input type="checkbox" checked={includeVisitUplift}
                               onChange={e => setIncludeVisitUplift(e.target.checked)} />
                        <strong>تضمين أثر رفع الزيارات اليومية</strong>
                      </label>
                      {includeVisitUplift && (
                        <>
                          <div className="rp-ctrl-label" style={{ marginTop: 10 }}>
                            <span>هدف الزيارات/يوم</span><span className="rp-ctrl-val">{targetVpd}</span>
                          </div>
                          <input type="range" className="rp-range" min="10" max="15" step="0.5"
                                 value={targetVpd} onChange={e => setTargetVpd(Number(e.target.value))} />
                          <div className="rp-ctrl-label" style={{ marginTop: 8 }}>
                            <span>نسبة التحقق</span><span className="rp-ctrl-val">{visitRealization}%</span>
                          </div>
                          <input type="range" className="rp-range" min="0" max="100" step="5"
                                 value={visitRealization} onChange={e => setVisitRealization(Number(e.target.value))} />
                          <div className="rp-ctrl-hint">
                            الحالي {fmt(gap.actual_vpd, 1)} → الهدف {targetVpd} (فجوة {fmt(forecast.gap_vpd, 1)}).
                            الأثر الكامل {fmtM(forecast.uplift_full)} ر.س/شهر، والمحتسب {fmtM(forecast.uplift_full * visitRealization / 100)} ر.س/شهر.
                          </div>
                        </>
                      )}
                    </div>

                    {/* ── ASP mix planning ── */}
                    {aspModel && aspDir && (
                      <>
                        <div className="rp-ctrl-divider" />
                        <div className="rp-ctrl">
                          <label className="rp-check">
                            <input type="checkbox" checked={includeAspPlan}
                                   onChange={e => setIncludeAspPlan(e.target.checked)} />
                            <strong>التخطيط حسب متوسط سعر البيع (ASP)</strong>
                          </label>
                          {includeAspPlan && (
                            <>
                              <div className="rp-ctrl-label" style={{ marginTop: 10 }}>
                                <span>ASP المستهدف</span>
                                <input
                                  type="number"
                                  className="rp-asp-input"
                                  step="0.01"
                                  min={aspDir.aspMin}
                                  max={aspDir.aspMax}
                                  value={aspInput}
                                  onChange={e => setAspInput(e.target.value)}
                                  onBlur={commitAspInput}
                                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                                  title={`اكتب قيمة بين ${fmt(aspDir.aspMin, 2)} و ${fmt(aspDir.aspMax, 2)} ثم اضغط Enter`}
                                />
                              </div>
                              <input type="range" className="rp-range"
                                     min={aspDir.aspMin} max={aspDir.aspMax} step="0.05"
                                     value={targetAsp ?? aspModel.A0}
                                     onChange={e => setTargetAsp(Number(e.target.value))} />
                              <div className="rp-ctrl-hint">
                                اسحب الشريط أو اكتب القيمة مباشرة في الخانة (تُضبط داخل المدى الممكن عند الضغط على Enter أو الخروج من الخانة).
                              </div>
                              <div className="rp-ctrl-hint">
                                الحالي {fmt(aspModel.A0Actual, 2)} ر.س · المدى الممكن
                                {' '}{fmt(aspDir.aspMin, 2)} — {fmt(aspDir.aspMax, 2)} ر.س
                                {aspPlan && Math.abs(aspPlan.achieved - (targetAsp ?? 0)) > 0.01 && (
                                  <> · المحقق فعلياً {fmt(aspPlan.achieved, 2)} ر.س</>
                                )}
                              </div>

                              {aspModel.focusDir && (
                                <label className="rp-check" style={{ marginTop: 10 }}>
                                  <input type="checkbox" checked={aspFocusMode}
                                         onChange={e => setAspFocusMode(e.target.checked)} />
                                  توجيه الزيادة حسب أولويات التركيز
                                </label>
                              )}
                              {aspFocusMode && aspModel.focusDir && (
                                <>
                                  <div className="rp-ctrl-label" style={{ marginTop: 8 }}>
                                    <span>الحد الأدنى لحصة القنوات الأساسية ({aspModel.baseNames.join(' + ')})</span>
                                    <span className="rp-ctrl-val">{baseFloorPct}%</span>
                                  </div>
                                  <input type="range" className="rp-range" min="0" max="90" step="5"
                                         value={baseFloorPct}
                                         onChange={e => setBaseFloorPct(Number(e.target.value))} />

                                  <div className="rp-ctrl-label" style={{ marginTop: 8 }}>
                                    <span>الحد الأدنى المضمون لكل قناة أساسية (من إجمالي الكمية)</span>
                                    <span className="rp-ctrl-val">{baseMinPct}%</span>
                                  </div>
                                  <input type="range" className="rp-range" min="0" max="40" step="1"
                                         value={baseMinPct}
                                         onChange={e => setBaseMinPct(Number(e.target.value))} />
                                  <div className="rp-ctrl-hint">
                                    لن تقل حصة أي قناة أساسية عن هذه النسبة، والباقي من كتلة الأساس
                                    يُقسَّم بينها بنسبها الحالية.
                                    {aspDir.baseMinEach != null && aspDir.nBase > 0 && (
                                      <> المطبَّق فعلياً {fmt(aspDir.baseMinEach * 100, 1)}% لكل قناة
                                        ({aspDir.nBase} قنوات من أصل {baseFloorPct}%)
                                        {aspDir.baseMinEach < baseMin - 1e-9 && (
                                          <strong> — مخفَّض تلقائياً لأن المطلوب يتجاوز المتاح.</strong>
                                        )}.
                                      </>
                                    )}
                                  </div>

                                  <div className="rp-ctrl-label" style={{ marginTop: 8 }}>
                                    <span>الحد الأدنى المضمون لكل قناة أولوية (من إجمالي الكمية)</span>
                                    <span className="rp-ctrl-val">{minKeepPct}%</span>
                                  </div>
                                  <input type="range" className="rp-range" min="0" max="25" step="1"
                                         value={minKeepPct}
                                         onChange={e => setMinKeepPct(Number(e.target.value))} />
                                  <div className="rp-ctrl-hint">
                                    لن تقل حصة أي قناة أولوية عن هذه النسبة من <strong>إجمالي كمية المنطقة</strong>.
                                    {aspDir.floorEach != null && aspDir.nPri > 0 && (
                                      <> المطبَّق فعلياً {fmt(aspDir.floorEach * 100, 1)}% لكل قناة
                                        ({aspDir.nPri} قنوات = {fmt(aspDir.floorEach * aspDir.nPri * 100, 1)}%
                                        من أصل {fmt(aspDir.priTotal * 100, 1)}% المتاحة لقنوات الأولوية)
                                        {aspDir.floorEach < minKeep - 1e-9 && (
                                          <strong> — مخفَّض تلقائياً لأن المطلوب يتجاوز المتاح.</strong>
                                        )}.
                                      </>
                                    )}
                                  </div>

                                  {ASP_CAP_CHANNELS.filter(n => aspModel.cats.some(c => c.name === n)).length > 0 && (
                                    <>
                                      <div className="rp-ctrl-divider" style={{ margin: '12px 0' }} />
                                      <div className="rp-ctrl-label"><span>حدود قصوى لحصص القنوات</span></div>
                                      {ASP_CAP_CHANNELS
                                        .filter(n => aspModel.cats.some(c => c.name === n))
                                        .map(n => {
                                          const on = n in channelCaps;
                                          return (
                                            <div key={n} style={{ marginTop: 6 }}>
                                              <label className="rp-check">
                                                <input type="checkbox" checked={on}
                                                       onChange={() => toggleCap(n)} />
                                                <bdi>{n}</bdi>
                                                {on && <span className="rp-ctrl-val" style={{ marginInlineStart: 'auto' }}>{channelCaps[n]}%</span>}
                                              </label>
                                              {on && (
                                                <input type="range" className="rp-range" min="0" max="60" step="1"
                                                       value={channelCaps[n]}
                                                       onChange={e => setCapValue(n, Number(e.target.value))} />
                                              )}
                                            </div>
                                          );
                                        })}
                                      <div className="rp-ctrl-hint">
                                        لن تتجاوز حصة أي قناة مُفعَّل لها حد أقصى هذه النسبة مهما كان الهدف،
                                        والفائض يُوزَّع على باقي القنوات بالتناسب.
                                      </div>
                                    </>
                                  )}
                                </>
                              )}
                              <div className="rp-ctrl-hint">
                                {aspFocusMode && aspModel.focusDir
                                  ? <>يُثبَّت {baseFloorPct}% من الكمية لـ{' '}{aspModel.baseNames.join(' + ')}
                                      {' '}(مقسومة بينهما بنسبتهما الحالية)، والباقي
                                      {' '}{(100 - baseFloorPct)}% يوزَّع على قنوات الأولوية:{' '}
                                      {/* <bdi> isolates each "Name NN%" pair — without it the RTL
                                          paragraph reorders the numbers and a channel ends up
                                          displaying its neighbour's percentage. */}
                                      {aspModel.focusSplit.map((f, i) => (
                                        <React.Fragment key={f.name}>
                                          {i > 0 ? ' · ' : ''}<bdi>{f.name} {f.pct.toFixed(0)}%</bdi>
                                        </React.Fragment>
                                      ))}
                                      {' '}ثم يُعدَّل التوزيع داخلها للوصول للهدف.</>
                                  : <>توزيع تناسبي: كل قناة أعلى من المتوسط تزيد بقدر بُعدها عنه.</>}
                              </div>
                              <div className="rp-ctrl-hint">
                                إجمالي الكمية لا يتغير — الأثر على القيمة وحدها.
                              </div>
                            </>
                          )}
                        </div>
                      </>
                    )}

                    <div className="rp-ctrl-divider" />

                    <div className="rp-ctrl">
                      <button
                        type="button"
                        className="rp-ctrl-save"
                        onClick={savePlan}
                        disabled={planStatus === 'saving'}
                      >
                        {planStatus === 'saving' ? '⏳ جارٍ الحفظ…'
                          : branch ? '💾 حفظ إعدادات المنطقة' : '💾 حفظ إعدادات كل المناطق'}
                      </button>
                      {!branch && planDerived && (
                        <div className="rp-ctrl-hint rp-ctrl-hint--ok">
                          ✓ تم تعبئة الإعدادات تلقائياً من خطط {planDerived.regions} منطقة محفوظة
                          {planDerived.weighted ? ' (المتوسطات مرجّحة بكمية كل منطقة)' : ''}
                          {' '}— أعداد المناديب وخطوط السير مجموعة، والنسب متوسطة — وحُفظت باسم «كل المناطق».
                        </div>
                      )}
                      {!branch && !planDerived && planStatus !== 'saved' && (
                        <div className="rp-ctrl-hint">
                          لا توجد خطط منطقة محفوظة بعد لبناء خطة «كل المناطق» منها — احفظ خطة منطقة أو أكثر أولاً.
                        </div>
                      )}
                      {!branch && planStatus === 'saved' && (
                        <div className="rp-ctrl-hint rp-ctrl-hint--ok">
                          ✓ تم حفظ إعدادات «كل المناطق» — ستُحمَّل تلقائياً في المرة القادمة.
                        </div>
                      )}
                      {branch && planStatus === 'saved' && (
                        <div className="rp-ctrl-hint rp-ctrl-hint--ok">
                          ✓ تم حفظ الإعدادات لمنطقة {branch} — ستُحمَّل تلقائياً في المرة القادمة.
                        </div>
                      )}
                      {branch && planStatus === 'loaded' && (
                        <div className="rp-ctrl-hint rp-ctrl-hint--ok">
                          ✓ تم تحميل إعدادات محفوظة مسبقاً لمنطقة {branch}.
                        </div>
                      )}
                      {branch && planStatus === 'error' && (
                        <div className="rp-ctrl-hint" style={{ color: '#dc2626' }}>تعذّر الحفظ — حاول مجدداً.</div>
                      )}
                    </div>

                    <button className="rp-ctrl-reset" onClick={resetPlan}>↺ إعادة ضبط الخطة</button>
                  </div>

                  {/* ── Results — excluded from print when the toggle above is off ── */}
                  <div className={includePlanInPrint ? undefined : 'rp-no-print'}>
                    {/* Print-only settings recap — the sliders/inputs on the right
                        don't print usefully, so this compact line replaces them
                        (see .rp-plan-print-summary in the print stylesheet). */}
                    <p className="rp-plan-print-summary">
                      <strong>السيناريو المطبّق: {SCEN_LABEL[scenario] || scenario}</strong> · نمو شهري {growthPct}%
                      {newReps > 0 && ` · ${newReps} مناديب جدد من ${MONTH_AR[newRepsStart]}`}
                      {newRoutes > 0 && ` · ${newRoutes} خطوط سير جديدة من ${MONTH_AR[newRoutesStart]}${linkRepRoute ? ' (غير مكرر مع المناديب)' : ''}`}
                      {includeVisitUplift && ` · رفع الزيارات لهدف ${targetVpd}/يوم بنسبة تحقق ${visitRealization}%`}
                      {includeAspPlan && aspPlan && ` · ASP مستهدف ${fmt(aspPlan.achieved, 2)} ر.س (الحالي ${fmt(aspModel.A0Actual, 2)}) عبر تعديل مزيج القنوات`}
                    </p>
                    <div className="rp-fc-cards">
                      <div className="rp-fc-card rp-fc-card--base">
                        <div className="rp-fc-lbl">الأساس الشهري (متوسط آخر 3 أشهر)</div>
                        <div className="rp-fc-val">{fmtM(forecast.base_monthly_revenue)}</div>
                        <div className="rp-fc-sub">ر.س · {fmt(Math.round(forecast.base_monthly_qty))} وحدة</div>
                      </div>
                      <div className="rp-fc-card rp-fc-card--target">
                        <div className="rp-fc-lbl">المتوقع للمتبقي ({forecast.rows.length} أشهر)</div>
                        <div className="rp-fc-val">{fmtM(forecast.h2_revenue)}</div>
                        <div className="rp-fc-sub">ر.س · {fmt(Math.round(forecast.h2_qty))} وحدة</div>
                      </div>
                      <div className="rp-fc-card rp-fc-card--growth">
                        <div className="rp-fc-lbl">الزيادة مقابل الثبات على الأساس</div>
                        <div className={`rp-fc-val ${forecast.uplift_vs_flat >= 0 ? 'rp-fc-val--pos' : 'rp-fc-val--neg'}`}>
                          {forecast.uplift_vs_flat >= 0 ? '+' : ''}{fmtM(forecast.uplift_vs_flat)}
                        </div>
                        <div className="rp-fc-sub">ر.س · {pct(forecast.uplift_vs_flat_pct)}</div>
                      </div>
                      <div className="rp-fc-card rp-fc-card--year">
                        <div className="rp-fc-lbl">إجمالي العام (فعلي + متوقع)</div>
                        <div className="rp-fc-val">{fmtM(forecast.year_revenue)}</div>
                        <div className="rp-fc-sub">
                          ر.س · المتبقي مقابل الفعلي {pct(forecast.h2_vs_h1_pct)}
                        </div>
                      </div>
                    </div>

                    <div className="rp-card">
                      <div className="rp-card__title">
                        توزيع مصادر النمو للمتبقي من العام {planMetric === 'qty' ? '(بالكمية)' : '(بالقيمة)'}
                      </div>
                      <HBar
                        rows={(planMetric === 'qty' ? [
                          { name: 'النمو الطبيعي / التسعير', v: forecast.from_growth_qty },
                          { name: 'مناديب جدد', v: forecast.from_new_reps_qty },
                          { name: 'خطوط سير جديدة', v: forecast.from_new_routes_qty },
                          { name: 'رفع الزيارات اليومية', v: forecast.from_visits_qty },
                        ] : [
                          { name: 'النمو الطبيعي / التسعير', v: forecast.from_growth },
                          { name: 'مناديب جدد', v: forecast.from_new_reps },
                          { name: 'خطوط سير جديدة', v: forecast.from_new_routes },
                          { name: 'رفع الزيارات اليومية', v: forecast.from_visits },
                          { name: 'رفع ASP (تعديل مزيج القنوات)', v: forecast.from_asp },
                        ]).filter(r => r.v > 0).sort((a, b) => b.v - a.v)}
                        valueKey="v" labelKey="name" money={planMetric !== 'qty'} maxBars={4}
                      />
                      {[forecast.from_growth, forecast.from_new_reps, forecast.from_new_routes, forecast.from_visits]
                        .every(v => v <= 0) && (
                        <div className="rp-ctrl-hint">
                          لم تُضَف أي روافع نمو بعد — عدّل نسبة النمو أو أضف مناديب/خطوط سير من اليسار.
                        </div>
                      )}
                    </div>

                    <div className="rp-matrix-header">
                      <div className="rp-section-title" style={{ margin: 0 }}>جدول التوقعات الشهري</div>
                      <div className="rp-metric-toggle">
                        <button className={planMetric === 'revenue' ? 'active' : ''} onClick={() => setPlanMetric('revenue')}>القيمة</button>
                        <button className={planMetric === 'qty' ? 'active' : ''} onClick={() => setPlanMetric('qty')}>الكمية</button>
                        <button className={planMetric === 'both' ? 'active' : ''} onClick={() => setPlanMetric('both')}>كلاهما</button>
                      </div>
                    </div>
                    <div className="rp-mtable-wrap">
                      <table className="rp-fc-table">
                        <thead>
                          <tr>
                            <th>الشهر</th><th>الأساس</th><th>+ النمو</th><th>+ مناديب</th>
                            <th>+ خطوط سير</th><th>+ زيارات</th>
                            {includeAspPlan && <th>+ ASP</th>}
                            <th>الإجمالي المتوقع</th>
                            <th>مقابل الأساس</th>
                          </tr>
                        </thead>
                        <tbody>
                          {forecast.rows.map(r => {
                            const vsPct = planMetric === 'qty' ? r.vs_base_qty_pct : r.vs_base_pct;
                            return (
                              <tr key={r.month_num}>
                                <td>{r.month_name}</td>
                                <td>{renderPlanCell(r.base_revenue, r.base_qty, planMetric)}</td>
                                <td className={r.growth_revenue > 0 ? 'rp-fc-add' : ''}>
                                  {renderPlanCell(r.growth_revenue, r.growth_qty, planMetric, { plus: true })}
                                </td>
                                <td className={r.reps_revenue > 0 ? 'rp-fc-add' : ''}>
                                  {renderPlanCell(r.reps_revenue, r.reps_qty, planMetric, { plus: true })}
                                </td>
                                <td className={r.routes_revenue > 0 ? 'rp-fc-add' : ''}>
                                  {renderPlanCell(r.routes_revenue, r.routes_qty, planMetric, { plus: true })}
                                </td>
                                <td className={r.visit_revenue > 0 ? 'rp-fc-add' : ''}>
                                  {renderPlanCell(r.visit_revenue, r.visit_qty, planMetric, { plus: true })}
                                </td>
                                {includeAspPlan && (
                                  <td className={r.asp_revenue > 0 ? 'rp-fc-add' : ''}
                                      title={`ASP الشهر: ${fmt(r.asp_month, 2)} ر.س`}>
                                    {renderPlanCell(r.asp_revenue, r.asp_qty, planMetric, { plus: true })}
                                  </td>
                                )}
                                <td className="rp-fc-total">{renderPlanCell(r.total_revenue, r.total_qty, planMetric)}</td>
                                <td className={vsPct >= 0 ? 'rp-pos' : 'rp-neg'}>{pct(vsPct)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td>الإجمالي</td>
                            <td>{renderPlanCell(forecast.base_monthly_revenue * forecast.rows.length, forecast.base_monthly_qty * forecast.rows.length, planMetric)}</td>
                            <td>{renderPlanCell(forecast.from_growth, forecast.from_growth_qty, planMetric, { plus: true })}</td>
                            <td>{renderPlanCell(forecast.from_new_reps, forecast.from_new_reps_qty, planMetric, { plus: true })}</td>
                            <td>{renderPlanCell(forecast.from_new_routes, forecast.from_new_routes_qty, planMetric, { plus: true })}</td>
                            <td>{renderPlanCell(forecast.from_visits, forecast.from_visits_qty, planMetric, { plus: true })}</td>
                            {includeAspPlan && (
                              <td>{renderPlanCell(forecast.from_asp, forecast.from_asp_qty, planMetric, { plus: true })}</td>
                            )}
                            <td className="rp-fc-total">{renderPlanCell(forecast.h2_revenue, forecast.h2_qty, planMetric)}</td>
                            <td>—</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>

                    <div className="rp-section-title">مقارنة السيناريوهات (بنفس فروض المناديب وخطوط السير والزيارات)</div>
                    <div className="rp-mtable-wrap">
                      <table className="rp-fc-table">
                        <thead>
                          <tr>
                            <th>السيناريو</th><th>نمو شهري</th><th>متوقع المتبقي</th>
                            <th>إجمالي العام</th><th>مقابل الفعلي</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[['conservative','محافظ'],['balanced','متوازن'],['ambitious','طموح']].map(([k, l]) => {
                            const g = scenarioGrowth[k] / 100;
                            const base = forecast.base_monthly_revenue;
                            const baseQ = forecast.base_monthly_qty;
                            const fixed = forecast.from_new_reps + forecast.from_new_routes + forecast.from_visits + forecast.from_asp;
                            const fixedQ = forecast.from_new_reps_qty + forecast.from_new_routes_qty + forecast.from_visits_qty;
                            const compound = forecast.rows.reduce((s, _r, i) => s + Math.pow(1 + g, i + 1), 0);
                            const h2 = base * compound + fixed;
                            const h2Q = baseQ * compound + fixedQ;
                            const yr = forecast.h1_revenue + h2;
                            const yrQ = forecast.h1_qty + h2Q;
                            const vs = planMetric === 'qty'
                              ? (forecast.h1_qty > 0 ? ((h2Q - forecast.h1_qty) / forecast.h1_qty) * 100 : null)
                              : (forecast.h1_revenue > 0 ? ((h2 - forecast.h1_revenue) / forecast.h1_revenue) * 100 : null);
                            return (
                              <tr key={k} style={scenario === k ? { background: '#eff6ff' } : undefined}>
                                <td>{l}{scenario === k ? ' ✓' : ''}</td>
                                <td>{scenarioGrowth[k]}%</td>
                                <td>{renderPlanCell(h2, h2Q, planMetric)}</td>
                                <td className="rp-fc-total">{renderPlanCell(yr, yrQ, planMetric)}</td>
                                <td className={vs >= 0 ? 'rp-pos' : 'rp-neg'}>{pct(vs)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {includeAspPlan && aspPlan && (
                      <>
                        <div className="rp-section-title">
                          خطة مزيج قنوات البيع للوصول لـ ASP {fmt(aspPlan.achieved, 2)} ر.س
                          {' '}(الحالي {fmt(aspModel.A0Actual, 2)})
                        </div>
                        <div className="rp-mtable-wrap">
                          <table className="rp-fc-table">
                            <thead>
                              <tr>
                                <th>ضمن المنهجية</th>
                                <th>قناة البيع (فئة العميل)</th>
                                <th title="اضغط على الرقم لتعديله — التوقع يُعاد حسابه على السعر الجديد">
                                  ASP المستخدم
                                  {Object.keys(priceOverrides).length > 0 && (
                                    <button type="button" className="rp-price-reset rp-price-reset--all"
                                            onClick={clearAllPrices}
                                            title="الرجوع للأسعار الافتراضية في كل القنوات">
                                      ↺ الكل ({Object.keys(priceOverrides).length})
                                    </button>
                                  )}
                                </th>
                                <th>حصة الكمية الحالية</th><th>الحصة المستهدفة</th>
                                <th>التغير</th>
                                {/* Two quantity columns: the same past period re-split by
                                    the target mix (a reference restatement), and the real
                                    forward-looking forecast volume for the months left. */}
                                <th>كمية الفترة الماضية بالمزيج الجديد</th>
                                {aspMonthly && (
                                  <th>الكمية المتوقعة للمتبقي ({forecast.rows.length} أشهر)</th>
                                )}
                              </tr>
                            </thead>
                            <tbody>
                              {aspPlan.rows.map((r, i) => (
                                <tr key={r.name} style={r.is_excluded ? { opacity: .55 } : undefined}>
                                  <td>
                                    <label className="rp-chan-toggle"
                                           title={r.is_excluded
                                             ? 'مُستبعَدة — حصتها تُوزَّع على كافة القنوات الأخرى بالتناسب'
                                             : 'مشمولة في إعادة التوزيع'}>
                                      <input type="checkbox"
                                             checked={!r.is_excluded}
                                             onChange={() => toggleChannel(r.name)} />
                                    </label>
                                  </td>
                                  <td>
                                    {r.is_excluded ? <span title="مُستبعَدة — حصتها موزَّعة على كافة القنوات الأخرى">🚫 </span>
                                      : r.is_base ? <span title="قناة أساسية محمية">🔒 </span> : null}
                                    {r.name}
                                  </td>
                                  <td>
                                    <span className="rp-price-cell">
                                      <input
                                        type="number" step="0.01" min="0"
                                        className={`rp-price-input${r.asp_override != null ? ' rp-price-input--edited' : ''}`}
                                        value={r.asp_override != null ? r.asp_override : +Number(r.asp).toFixed(2)}
                                        onChange={e => setChannelPrice(r.name, e.target.value)}
                                        title="عدّل السعر لإعادة حساب التوقع على أساسه" />
                                      {r.asp_override != null && (
                                        <button type="button" className="rp-price-reset"
                                                onClick={() => clearChannelPrice(r.name)}
                                                title={`الرجوع للافتراضي ${fmt(r.default_asp, 2)} ر.س`}>↺</button>
                                      )}
                                      {r.asp_override != null ? (
                                        <span className="rp-matrix-sub">الافتراضي {fmt(r.default_asp, 2)}</span>
                                      ) : r.asp_pinned && (
                                        <span className="rp-asp-pin"
                                              title={`سعر مثبّت — أعلى ASP محقق لهذه الفئة على مستوى المناطق (${r.asp_pinned_from}). السعر المحلي ${fmt(r.local_asp, 2)} ر.س غير موثوق لقلة الكمية.`}>
                                          📌<span className="rp-matrix-sub"> محلي {fmt(r.local_asp, 2)}</span>
                                        </span>
                                      )}
                                    </span>
                                  </td>
                                  <td>{pct(r.share)}</td>
                                  <td className="rp-fc-total">{pct(r.new_share)}</td>
                                  <td className={r.delta >= 0 ? 'rp-pos' : 'rp-neg'}>
                                    {r.delta >= 0 ? '+' : ''}{fmt(r.delta, 1)} نقطة
                                  </td>
                                  <td>{fmt(Math.round(r.new_qty))}</td>
                                  {aspMonthly && (
                                    <td className="rp-fc-total">{fmt(Math.round(aspMonthly.channelTotals[i]))}</td>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr>
                                <td />
                                <td>الإجمالي</td>
                                {/* Blended ASP on both sides of the shift. This cell used to
                                    show only the target under an "ASP الفعلي" header, which
                                    read as if the region already sold at that price. */}
                                <td>
                                  <span className="rp-asp-totals">
                                    <span className="rp-asp-totals__cur"
                                          title={Math.abs(aspModel.A0 - aspModel.A0Actual) >= 0.005
                                            ? `ASP الفعلي للفترة. المزيج يُحتسب على ${fmt(aspModel.A0, 2)} لأن قنوات رقيقة الحجم تُقيَّم بسعر مثبَّت من منطقة أخرى.`
                                            : undefined}>
                                      الحالي {fmt(aspModel.A0Actual, 2)}
                                    </span>
                                    <span className="rp-asp-totals__tgt">المستهدف {fmt(aspPlan.achieved, 2)}</span>
                                  </span>
                                </td>
                                <td>{pct(aspPlan.rows.reduce((s, r) => s + r.share, 0))}</td>
                                <td className="rp-fc-total">{pct(aspPlan.rows.reduce((s, r) => s + r.new_share, 0))}</td>
                                <td>—</td>
                                <td>{fmt(Math.round(aspPlan.rows.reduce((s, r) => s + r.new_qty, 0)))}</td>
                                {aspMonthly && (
                                  <td className="rp-fc-total">{fmt(Math.round(aspMonthly.grandQty))}</td>
                                )}
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                        <div className="rp-ctrl-hint" style={{ marginTop: 8 }}>
                          {aspFocusMode && aspModel.focusDir
                            ? <>🔒 القنوات الأساسية ({aspModel.baseNames.join(' + ')}) مثبَّتة على
                                {' '}{baseFloorPct}% من الكمية مجتمعةً، مقسومة بينهما بنسبتهما الحالية.
                                الباقي ({100 - baseFloorPct}%) يوزَّع على قنوات الأولوية بحسب ترتيبها
                                ({aspModel.focusSplit.map((f, i) => (
                                  <React.Fragment key={f.name}>
                                    {i > 0 ? ' · ' : ''}<bdi>{f.name} {f.pct.toFixed(0)}%</bdi>
                                  </React.Fragment>
                                ))})
                                بغض النظر عن حجمها الحالي. يُضمن لكل قناة {minKeepPct}% من حصتها المقررة،
                                والمتبقي فقط هو ما يُعاد توزيعه للوصول لهدف الـ ASP — فلا تُهمَل أي قناة أولوية.
                                {' '}🚫 القناة المُلغى تحديدها تنزل إلى صفر وتُوزَّع حصتها بالكامل على كافة القنوات الأخرى بالتناسب مع حصة كل منها — بما فيها القنوات الأساسية، ولذلك قد تتجاوز حصتها الحد المحدد لها.
                                {' '}📌 الفئات المؤشَّرة يُستخدم لها أعلى ASP محقق على مستوى المناطق بدل السعر
                                المحلي، لأن كميتها في المنطقة أقل من أن يكون متوسط سعرها موثوقاً.</>
                            : <>الفئات الأعلى من متوسط السعر الحالي تزيد حصتها، والأقل تقل.</>}
                          {' '}إجمالي الكمية ثابت، فالأثر يظهر على القيمة وحدها. النِسَب مُعادة التطبيع
                          لتساوي 100%، ولذلك قد يختلف الـ ASP المحقق قليلاً عن المستهدف عند حدود المدى الممكن.
                        </div>
                        <div className="rp-ctrl-hint" style={{ marginTop: 4 }}>
                          <strong>الفرق بين عمودَي الكمية:</strong> «كمية الفترة الماضية بالمزيج الجديد» مرجعية —
                          نفس كمية الفترة المعروضة ({fmt(aspModel.totalQty)} وحدة) موزَّعة بالمزيج المستهدف،
                          لتوضيح حجم التحوّل المطلوب. أما «الكمية المتوقعة للمتبقي» فهي الكمية المستقبلية
                          الحقيقية من جدول التوقعات، وتفصيلها الشهري في الجدول التالي.
                        </div>

                        {/* Monthly per-channel quantity distribution */}
                        {aspMonthly && (
                          <>
                            <div className="rp-section-title">التوزيع الشهري للكميات حسب القناة + مسار الـ ASP</div>
                            <div className="rp-matrix-wrap">
                              <table className="rp-matrix-table">
                                <thead>
                                  <tr>
                                    <th className="rp-matrix-th-month">ضمن المنهجية</th>
                                    <th className="rp-matrix-th-item">قناة البيع</th>
                                    {aspMonthly.months.map(m => (
                                      <th key={m.month_num} className="rp-matrix-th-month">{m.month_name}</th>
                                    ))}
                                    <th className="rp-matrix-th-total">الإجمالي</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {aspMonthly.channels.map((c, ci) => (
                                    <tr key={c.name} style={c.is_excluded ? { opacity: .55 } : undefined}>
                                      <td className="rp-matrix-td-cell">
                                        <label className="rp-chan-toggle"
                                               title={c.is_excluded
                                                 ? 'مُستبعَدة — حصتها تُوزَّع على كافة القنوات الأخرى بالتناسب'
                                                 : 'مشمولة في إعادة التوزيع'}>
                                          <input type="checkbox"
                                                 checked={!c.is_excluded}
                                                 onChange={() => toggleChannel(c.name)} />
                                        </label>
                                      </td>
                                      <td className="rp-matrix-td-item">
                                        {c.is_excluded ? <span title="مُستبعَدة — حصتها موزَّعة على كافة القنوات الأخرى">🚫 </span>
                                          : c.focus_rank !== -1 && aspFocusMode && aspModel.focusDir
                                            ? <span title="قناة أولوية">★ </span> : null}
                                        {c.is_new && <span title="قناة مضافة يدوياً — لا يوجد لها تاريخ بيعي في المنطقة">🆕 </span>}
                                        {c.name}
                                        <span className="rp-matrix-sub">
                                          {' '}· {fmt(c.asp, 2)} ر.س{c.asp_pinned ? ' 📌' : ''}
                                          {c.is_new ? (c.asp_override ? ' (سعر يدوي)' : ' (سعر مرجعي)') : ''}
                                        </span>
                                      </td>
                                      {aspMonthly.months.map(m => (
                                        <td key={m.month_num} className="rp-matrix-td-cell">
                                          <span className="rp-matrix-qty">{fmt(Math.round(m.cells[ci].qty))}</span>
                                          <span className="rp-matrix-sub">{pct(m.cells[ci].share)}</span>
                                        </td>
                                      ))}
                                      <td className="rp-matrix-td-total">
                                        <span className="rp-matrix-qty">{fmt(Math.round(aspMonthly.channelTotals[ci]))}</span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot>
                                  <tr className="rp-matrix-tf-row">
                                    <td className="rp-matrix-td-total" />
                                    <td className="rp-matrix-td-item rp-matrix-td-item--tf">إجمالي الكمية</td>
                                    {aspMonthly.months.map(m => (
                                      <td key={m.month_num} className="rp-matrix-td-total">
                                        <span className="rp-matrix-qty">{fmt(Math.round(m.total_qty))}</span>
                                      </td>
                                    ))}
                                    <td className="rp-matrix-td-total rp-matrix-td-grand">
                                      <span className="rp-matrix-qty">{fmt(Math.round(aspMonthly.grandQty))}</span>
                                    </td>
                                  </tr>
                                  <tr className="rp-matrix-tf-row">
                                    <td className="rp-matrix-td-total" />
                                    <td className="rp-matrix-td-item rp-matrix-td-item--tf">
                                      ASP الشهري
                                      <span className="rp-matrix-sub">الحالي {fmt(aspModel.A0Actual, 2)}</span>
                                    </td>
                                    {aspMonthly.months.map(m => (
                                      <td key={m.month_num} className="rp-matrix-td-total">
                                        <span className="rp-matrix-qty">{fmt(m.asp, 2)}</span>
                                      </td>
                                    ))}
                                    <td className="rp-matrix-td-total rp-matrix-td-grand">
                                      {/* End state, i.e. the ASP the ramp lands on */}
                                      <span className="rp-matrix-qty">{fmt(aspPlan.achieved, 2)}</span>
                                      <span className="rp-matrix-sub">المستهدف</span>
                                    </td>
                                  </tr>
                                </tfoot>
                              </table>
                            </div>
                            <div className="rp-ctrl-hint" style={{ marginTop: 8 }}>
                              إجمالي الكمية الشهري هنا مطابق تماماً لجدول التوقعات الشهري أعلاه — خطة الـ ASP
                              تعيد توزيع نفس الكميات على القنوات ولا تغيّرها. حصص القنوات تتدرّج شهرياً من
                              المزيج الحالي إلى المستهدف، ولذلك يتدرّج الـ ASP معها.
                            </div>

                            <MissingChannels
                              allChannels={filters?.categories || []}
                              model={aspModel}
                              plan={aspPlan}
                              added={newChannels}
                              setAdded={setNewChannels}
                              benchmarks={data?.category_asp_benchmark || []}
                            />
                          </>
                        )}
                      </>
                    )}

                    <div className="rp-ctrl-hint" style={{ marginTop: 10 }}>
                      منهجية التوقع: الأساس = متوسط آخر 3 أشهر فعلية (أكثر ثباتاً من الشهر الأخير وحده)، ثم يُطبَّق
                      نمو مركّب شهرياً. مساهمة المندوب/خط السير الجديد = متوسط إنتاجية الموجودين فعلياً مضروبة في
                      منحنى إنتاجية تدريجي ({RAMP.map(r => `${r * 100}%`).join(' → ')}) لأن الجديد لا ينتج بكامل
                      طاقته من أول شهر. أثر رفع الزيارات مُقوَّم بإيراد الزيارة الفعلي ومخفَّض بنسبة تحقق قابلة للتعديل.
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
