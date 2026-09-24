import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './HypermarketsPage.css';

/* ── Constants ─────────────────────────────────────────────── */
const ADMIN_ROLES = ['super_admin', 'it_admin'];
const MONTHS = [
  [1,'يناير'],[2,'فبراير'],[3,'مارس'],[4,'أبريل'],
  [5,'مايو'],[6,'يونيو'],[7,'يوليو'],[8,'أغسطس'],
  [9,'سبتمبر'],[10,'أكتوبر'],[11,'نوفمبر'],[12,'ديسمبر'],
];
const currentYear  = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;
const YEARS = [currentYear - 1, currentYear, currentYear + 1];

/* ── Helpers ────────────────────────────────────────────────── */
function fmt(n, dec = 0) {
  if (n == null) return '—';
  // 'en-SA' matches the rest of the app (e.g. PerformanceDashboardPage) —
  // Western digits with Arabic-appropriate grouping, instead of 'ar-SA'
  // which renders Arabic-Indic numerals (٣٬٨٠٦).
  return Number(n).toLocaleString('en-SA', { maximumFractionDigits: dec });
}

/* ── Deviation badge ──────────────────────────────────────── */
function Dev({ pct, invert = false, size = 'md' }) {
  if (pct == null) return null;
  const positive = invert ? pct < 0 : pct > 0;
  const neutral  = pct === 0;
  const cls = neutral ? 'hm-dev--flat' : positive ? 'hm-dev--up' : 'hm-dev--down';
  const arrow = neutral ? '→' : positive ? '↑' : '↓';
  return (
    <span className={`hm-dev hm-dev--${size} ${cls}`}>
      {arrow} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/* ── KPI Card ─────────────────────────────────────────────── */
function KpiCard({ icon, label, value, sub, deviation, invertDev = false, accent, big = false }) {
  return (
    <div className={`hm-kpi${accent ? ` hm-kpi--${accent}` : ''}${big ? ' hm-kpi--big' : ''}`}>
      {icon && <span className="hm-kpi__icon">{icon}</span>}
      <div className="hm-kpi__body">
        <div className="hm-kpi__label">{label}</div>
        <div className="hm-kpi__value">{value}</div>
        {sub && <div className="hm-kpi__sub">{sub}</div>}
        {deviation != null && <Dev pct={deviation} invert={invertDev} size="sm" />}
      </div>
    </div>
  );
}

/* ── Trend Bar Chart ──────────────────────────────────────────
   labelKey lets the overview (multi-year) trend show "شهر سنة"
   instead of just the month name used by the single-year view. */
function TrendChart({ trend, highlight, labelKey = 'month_name' }) {
  if (!trend?.length) return <div className="hm-empty">لا توجد بيانات</div>;
  const maxQty = Math.max(...trend.map(t => t.total_qty), 1);

  return (
    <div className="hm-trend">
      <div className="hm-trend__cols">
        {trend.map((t, i) => {
          const isHL = highlight != null && t.month_num === highlight;
          const qtyPct = (t.total_qty / maxQty * 100).toFixed(1);
          const retPct = (t.total_returns / maxQty * 100).toFixed(1);
          return (
            <div key={i} className={`hm-trend__col${isHL ? ' hm-trend__col--active' : ''}`}>
              <div className="hm-trend__bars">
                <div className="hm-trend__bar-wrap" title={`كمية: ${fmt(t.total_qty)}`}>
                  <div className="hm-trend__bar hm-trend__bar--qty"
                       style={{ height: `${qtyPct}%` }} />
                </div>
                <div className="hm-trend__bar-wrap" title={`مرتجعات: ${fmt(t.total_returns)}`}>
                  <div className="hm-trend__bar hm-trend__bar--ret"
                       style={{ height: `${retPct}%` }} />
                </div>
              </div>
              <div className="hm-trend__label">{t[labelKey]}</div>
              <div className="hm-trend__qty">{fmt(t.total_qty)}</div>
              {t.total_returns > 0 && (
                <div className="hm-trend__ret">↩{fmt(t.total_returns)}</div>
              )}
            </div>
          );
        })}
      </div>
      <div className="hm-trend__legend">
        <span className="hm-trend__legend-item hm-trend__legend-item--qty">■ كمية المبيعات</span>
        <span className="hm-trend__legend-item hm-trend__legend-item--ret">■ المرتجعات</span>
      </div>
    </div>
  );
}

/* ── Horizontal bar ──────────────────────────────────────── */
function HBar({ rows, valueKey, labelKey, colorClass = 'hm-bar--primary', maxBars = 12 }) {
  const capped = rows.slice(0, maxBars);
  const max    = Math.max(...capped.map(r => Number(r[valueKey]) || 0), 1);
  return (
    <div className="hm-hbar">
      {capped.map((r, i) => {
        const val = Number(r[valueKey]) || 0;
        const w   = (val / max * 100).toFixed(1);
        return (
          <div key={i} className="hm-hbar__row">
            <span className="hm-hbar__label" title={r[labelKey]}>{r[labelKey]}</span>
            <div className="hm-hbar__track">
              <div className={`hm-hbar__fill ${colorClass}`} style={{ width: `${w}%` }} />
            </div>
            <span className="hm-hbar__val">{fmt(val)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Sortable Th ─────────────────────────────────────────── */
function Th({ col, sortCol, sortDir, onSort, children }) {
  const active = sortCol === col;
  return (
    <th className={`hm-th${active ? ' hm-th--sorted' : ''}`} onClick={() => onSort(col)}>
      {children}
      <span className={`hm-sort${active ? ' hm-sort--active' : ''}`}>
        {active ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ' ⇅'}
      </span>
    </th>
  );
}

/* ── Generic multi-select dropdown ──────────────────────────
   Compact checkbox popover (never allows an empty selection).
   `options` is [{ value, label }]; used for both the year and
   month filters with the same behavior. ── */
function MultiSelectDropdown({ options, selected, onChange, multiLabel }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const toggle = (v) => {
    const has = selected.includes(v);
    if (has && selected.length === 1) return; // keep at least one option selected
    const next = has ? selected.filter(x => x !== v) : [...selected, v];
    onChange(next.sort((a, b) => a - b));
  };

  const singleLabel = options.find(o => o.value === selected[0])?.label ?? selected[0];
  const label = selected.length > 1 ? multiLabel(selected.length) : String(singleLabel);

  return (
    <div className="hm-year-ms" ref={ref}>
      <button type="button" className="hm-year-ms__btn" onClick={() => setOpen(o => !o)}>
        {label} <span className="hm-year-ms__caret">▾</span>
      </button>
      {open && (
        <div className="hm-year-ms__panel">
          {options.map(o => (
            <label key={o.value} className="hm-year-ms__opt">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Region multi-select ──────────────────────────────────────
   Unlike MultiSelectDropdown above (years/months, which always need at
   least one value selected), regions default to EMPTY meaning "جميع
   المناطق" — so unticking one from that state reads as "كل المناطق عدا
   هذه" in a single click, which is the "اهمال البعض" half of the request;
   "فقط" next to a row gives the other half, a single region in one click.
   Kept as its own component (not a MultiSelectDropdown variant) because
   the two need genuinely different minimum-selection rules. */
function RegionMultiSelect({ branches, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const active = selected.length ? selected : branches;
  const set = next => onChange(next.length === 0 || next.length === branches.length ? [] : next);
  const toggle = b => set(active.includes(b)
    ? (active.length === 1 ? active : active.filter(x => x !== b))
    : [...active, b]);

  const label = !selected.length ? 'جميع المناطق'
    : selected.length === 1 ? selected[0]
    : selected.length === branches.length - 1
      ? `الكل عدا ${branches.find(b => !selected.includes(b))}`
      : `${selected.length} مناطق`;

  return (
    <div className="hm-year-ms" ref={ref}>
      <button type="button" className="hm-year-ms__btn" onClick={() => setOpen(o => !o)} title={selected.length ? selected.join('، ') : 'جميع المناطق'}>
        {label} <span className="hm-year-ms__caret">▾</span>
      </button>
      {open && (
        <div className="hm-year-ms__panel">
          <div className="hm-region-ms__head">
            <button type="button" className="hm-region-ms__mini" onClick={() => onChange([])}>الكل</button>
            <span className="hm-region-ms__count">{active.length} / {branches.length}</span>
          </div>
          {branches.map(b => {
            const on = active.includes(b);
            return (
              <div key={b} className={`hm-region-ms__row${on ? ' hm-region-ms__row--on' : ''}`}>
                <label className="hm-year-ms__opt">
                  <input type="checkbox" checked={on} onChange={() => toggle(b)} />
                  {b}
                </label>
                <button type="button" className="hm-region-ms__only" onClick={() => set([b])}>فقط</button>
              </div>
            );
          })}
          {!branches.length && <div className="hm-region-ms__empty">لا توجد مناطق</div>}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   Main Page
═══════════════════════════════════════════════════════════ */
export default function HypermarketsPage() {
  const { user } = useAuth();
  const isAdmin  = user && ADMIN_ROLES.includes(user.role);
  const qc = useQueryClient();
  const expenseFileRef = useRef(null);
  const [expenseUploading, setExpenseUploading] = useState(false);
  const [expenseMsg, setExpenseMsg] = useState('');

  const handleExpenseFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    setExpenseUploading(true);
    setExpenseMsg('');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await client.post('/hypermarkets/branch-expenses/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setExpenseMsg(`تم حفظ ${res.data.saved} شهراً${res.data.errors?.length ? ` (${res.data.errors.length} أخطاء)` : ''}`);
      qc.invalidateQueries(['hm-overview']);
    } catch (err) {
      setExpenseMsg(err.response?.data?.error || 'فشل رفع الملف');
    } finally {
      setExpenseUploading(false);
    }
  };

  /* ── Admin insight note — free-text comment stored in the generic
     app_settings key/value table (same API used by SMTP/sidebar-order
     settings elsewhere), shown on the Insight card below. ── */
  const { data: insightNoteData } = useQuery({
    queryKey: ['hm-insight-note'],
    queryFn: () => client.get('/settings/hypermarkets_insight_note').then(r => r.data.value || ''),
    staleTime: 60 * 1000,
  });
  const [insightNoteDraft, setInsightNoteDraft] = useState(null); // null = not editing yet
  const [insightNoteSaving, setInsightNoteSaving] = useState(false);
  const insightNoteText = insightNoteDraft !== null ? insightNoteDraft : (insightNoteData || '');

  const saveInsightNote = async () => {
    setInsightNoteSaving(true);
    try {
      await client.put('/settings/hypermarkets_insight_note', { value: insightNoteText });
      qc.invalidateQueries(['hm-insight-note']);
      setInsightNoteDraft(null);
    } catch {
      // keep the draft on screen so the admin doesn't lose what they typed
    } finally {
      setInsightNoteSaving(false);
    }
  };

  const [selectedYears, setSelectedYears] = useState([currentYear]);
  const year = selectedYears[0]; // primary year — used wherever a single year is needed (item-matrix, labels, export filenames)
  const yearsLabel = selectedYears.length > 1 ? [...selectedYears].sort((a,b)=>a-b).join('، ') : String(year);

  const [selectedMonths, setSelectedMonths] = useState([currentMonth]);
  const month = selectedMonths[0]; // primary month — used wherever a single month is needed (labels, export filenames)
  // Declared here (not reusing the later `monthName` const) to avoid a TDZ
  // ReferenceError — this runs before that later declaration's line executes.
  const primaryMonthName = MONTHS.find(m => m[0] === month)?.[1] || '';
  const monthsLabel = selectedMonths.length > 1
    ? [...selectedMonths].sort((a,b)=>a-b).map(m => MONTHS.find(x => x[0] === m)?.[1] || m).join('، ')
    : primaryMonthName;

  /* Kept regions; empty = جميع المناطق (see RegionMultiSelect). */
  const [branchNames, setBranchNames] = useState([]);
  const [repName,    setRepName]    = useState('');
  const [activeTab,  setActiveTab]  = useState('general');

  /* ── Calendar date-range filter — an alternative to year/month, not an
     addition to it: when active it overrides the year/month multi-select
     entirely and can span multiple months/years (backend rebuilds the real
     date from sales_activity's report_year/month_num/day). Same pattern as
     DiscountShopsPage.jsx (this page's own clone). Wired through to every
     API call the page makes that also honors years/months (main summary,
     item matrix, item overview, customer matrix) so the whole page
     consistently reflects one selected period. ── */
  function monthBoundsHM(y, m) {
    const today   = new Date();
    const isCur   = today.getFullYear() === y && today.getMonth() + 1 === m;
    const lastDay = isCur ? today.getDate() : new Date(y, m, 0).getDate();
    const pad = n => String(n).padStart(2, '0');
    return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay)}` };
  }
  const [useDateRange, setUseDateRange] = useState(false);
  const defaultRangeHM = monthBoundsHM(currentYear, currentMonth);
  const [dateFrom, setDateFrom] = useState(defaultRangeHM.from);
  const [dateTo,   setDateTo]   = useState(defaultRangeHM.to);
  const rangeInvalid = useDateRange && dateFrom && dateTo && dateTo < dateFrom;

  /* Sort state for reps table */
  const [repSort, setRepSort]       = useState({ col: 'total_qty', dir: 'desc' });
  /* Sort state for customers table */
  const [custSort, setCustSort]     = useState({ col: 'total_qty', dir: 'desc' });
  /* Sort state for items table */
  const [itemSort, setItemSort]     = useState({ col: 'total_qty', dir: 'desc' });

  const handleRepSort  = useCallback(col => setRepSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);
  const handleCustSort = useCallback(col => setCustSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);
  const handleItemSort = useCallback(col => setItemSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);

  /* Metric visibility toggle for the customer × month matrix — allows
     showing any single-or-multiple combination of qty/returns/revenue. */
  const [custMatrixMetrics, setCustMatrixMetrics] = useState({ qty: true, returns: true, revenue: true });
  const toggleCustMatrixMetric = useCallback((key) => {
    setCustMatrixMetrics(prev => {
      const next = { ...prev, [key]: !prev[key] };
      // never allow all three to be turned off — fall back to qty
      if (!next.qty && !next.returns && !next.revenue) next.qty = true;
      return next;
    });
  }, []);

  /* Same metric visibility toggle, for the region × month matrix. */
  const [regionMatrixMetrics, setRegionMatrixMetrics] = useState({ qty: true, returns: true, revenue: true });
  const toggleRegionMatrixMetric = useCallback((key) => {
    setRegionMatrixMetrics(prev => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.qty && !next.returns && !next.revenue) next.qty = true;
      return next;
    });
  }, []);

  /* Two toggles to exclude parts of the "creation vendor / marketing
     support" fee from the credit-note deduction shown in the expense
     matrix. The uploaded data has a single combined column for this
     fee — it never carries both a listing charge and a marketing
     charge in the same month (e.g. Dec 2025 = 235,750 listing-only,
     Apr 2026 = 57,500 marketing-only) — so the two fee types are told
     apart by magnitude: amounts ≥ 100,000 are the one-off "رسوم
     إدراج" (listing) charge, smaller nonzero amounts are the
     recurring "رسوم تسويق" (marketing support) charge. */
  const FEE_SPLIT_THRESHOLD = 100000;
  const [excludeListingFee, setExcludeListingFee] = useState(false);
  const [excludeMarketingSupportFee, setExcludeMarketingSupportFee] = useState(false);
  const effCreditNote = (c) => {
    const excludedAmt =
      (excludeListingFee ? (c?.listing_fee || 0) : 0) +
      (excludeMarketingSupportFee ? (c?.marketing_fee || 0) : 0);
    return (c?.total_credit_note || 0) - excludedAmt;
  };

  /* ── Filters query ─────────────────────────────────────── */
  const { data: filters } = useQuery({
    queryKey: ['hm-filters', year],
    queryFn: () => client.get(`/hypermarkets/filters?year=${year}`).then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const repOptions = useMemo(() => {
    if (!filters?.reps) return [];
    return branchNames.length ? filters.reps.filter(r => branchNames.includes(r.branch)) : filters.reps;
  }, [filters, branchNames]);

  /* Written out in full on the print sheet and the Excel export, since
     whoever reads the paper has no filter bar to check the scope against. */
  const allBranches = filters?.branches || [];
  const branchLabel = !branchNames.length ? 'جميع المناطق'
    : branchNames.length === allBranches.length - 1
      ? `الكل عدا ${allBranches.find(b => !branchNames.includes(b))}`
      : branchNames.join('، ');

  /* ── Main data query ───────────────────────────────────── */
  const params = useDateRange
    ? new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    : new URLSearchParams({ years: selectedYears.join(','), months: selectedMonths.join(',') });
  branchNames.forEach(b => params.append('branch_name', b));
  if (repName)    params.set('salesrep_name', repName);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['hm-summary', useDateRange, useDateRange ? dateFrom : selectedYears.join(','),
               useDateRange ? dateTo : selectedMonths.join(','), branchNames.join('|'), repName],
    queryFn:  () => client.get(`/hypermarkets/summary?${params}`).then(r => r.data),
    enabled: !rangeInvalid,
    staleTime: 2 * 60 * 1000,
  });

  /* ── Overview (whole-period) query — powers the "نظرة عامة" tab ── */
  const overviewParams = new URLSearchParams();
  branchNames.forEach(b => overviewParams.append('branch_name', b));
  if (repName)    overviewParams.set('salesrep_name', repName);

  const { data: overview, isLoading: isOverviewLoading, isError: isOverviewError } = useQuery({
    queryKey: ['hm-overview', branchNames.join('|'), repName],
    queryFn:  () => client.get(`/hypermarkets/overview?${overviewParams}`).then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  /* ── Item matrix (monthly sales/returns per item, selected year, or the
       calendar range when active — overrides ?year= entirely) ── */
  const matrixParams = useDateRange
    ? new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    : new URLSearchParams({ year });
  branchNames.forEach(b => matrixParams.append('branch_name', b));
  if (repName)    matrixParams.set('salesrep_name', repName);

  const { data: itemMatrix, isLoading: isMatrixLoading, isError: isMatrixError } = useQuery({
    queryKey: ['hm-item-matrix', useDateRange, useDateRange ? dateFrom : year, useDateRange ? dateTo : null, branchNames.join('|'), repName],
    queryFn:  () => client.get(`/hypermarkets/item-matrix?${matrixParams}`).then(r => r.data),
    enabled: !rangeInvalid,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Item totals for the whole period (every year, not just the
       selected month) — powers the "كامل الفترة" best/worst cards.
       Honors the calendar range when active, same as the other tabs. ── */
  const itemOverviewParams = useDateRange
    ? new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    : new URLSearchParams();
  branchNames.forEach(b => itemOverviewParams.append('branch_name', b));
  if (repName)    itemOverviewParams.set('salesrep_name', repName);

  const { data: itemOverview, isLoading: isItemOverviewLoading, isError: isItemOverviewError } = useQuery({
    queryKey: ['hm-item-overview', useDateRange, useDateRange ? dateFrom : null, useDateRange ? dateTo : null, branchNames.join('|'), repName],
    queryFn:  () => client.get(`/hypermarkets/item-overview?${itemOverviewParams}`).then(r => r.data),
    enabled: !rangeInvalid,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Customer matrix (whole-period monthly sales/returns/revenue, or
       narrowed to the calendar range when active) ── */
  const custMatrixParams = useDateRange
    ? new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    : new URLSearchParams();
  branchNames.forEach(b => custMatrixParams.append('branch_name', b));
  if (repName)    custMatrixParams.set('salesrep_name', repName);

  const { data: custMatrix, isLoading: isCustMatrixLoading, isError: isCustMatrixError } = useQuery({
    queryKey: ['hm-customer-matrix', useDateRange, useDateRange ? dateFrom : null, useDateRange ? dateTo : null, branchNames.join('|'), repName],
    queryFn:  () => client.get(`/hypermarkets/customer-matrix?${custMatrixParams}`).then(r => r.data),
    enabled: !rangeInvalid,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Sorted reps & customers ────────────────────────────── */
  const sortedReps = useMemo(() => {
    if (!data?.by_rep) return [];
    const dir = repSort.dir === 'desc' ? -1 : 1;
    return [...data.by_rep].sort((a, b) => (Number(b[repSort.col]) - Number(a[repSort.col])) * dir);
  }, [data, repSort]);

  const sortedCusts = useMemo(() => {
    if (!data?.customers) return [];
    const dir = custSort.dir === 'desc' ? -1 : 1;
    return [...data.customers].sort((a, b) => (Number(b[custSort.col]) - Number(a[custSort.col])) * dir);
  }, [data, custSort]);

  const sortedItems = useMemo(() => {
    if (!data?.by_item) return [];
    const dir = itemSort.dir === 'desc' ? -1 : 1;
    return [...data.by_item].sort((a, b) => (Number(b[itemSort.col]) - Number(a[itemSort.col])) * dir);
  }, [data, itemSort]);

  const topItems = useMemo(() => {
    if (!data?.by_item) return [];
    return [...data.by_item].sort((a, b) => b.total_qty - a.total_qty).slice(0, 10);
  }, [data]);

  const bottomItems = useMemo(() => {
    if (!data?.by_item) return [];
    return [...data.by_item]
      .filter(it => it.total_qty > 0)
      .sort((a, b) => a.total_qty - b.total_qty)
      .slice(0, 10);
  }, [data]);

  const topItemsAllTime = useMemo(() => {
    if (!itemOverview?.items) return [];
    return [...itemOverview.items].sort((a, b) => b.total_qty - a.total_qty).slice(0, 10);
  }, [itemOverview]);

  const bottomItemsAllTime = useMemo(() => {
    if (!itemOverview?.items) return [];
    return [...itemOverview.items]
      .filter(it => it.total_qty > 0)
      .sort((a, b) => a.total_qty - b.total_qty)
      .slice(0, 10);
  }, [itemOverview]);

  /* ── Branch × month matrix (qty/returns/revenue summed across every
       year present) for the "نظرة عامة" tab — includes row totals
       (per branch, across all months) and column totals (per month,
       across all branches), plus a grand total. ── */
  /* ── Insight card: best/worst branch by sales, most/least returns ── */
  const branchInsights = useMemo(() => {
    if (!overview?.by_branch?.length) return null;
    const byQtyDesc = [...overview.by_branch].sort((a, b) => b.total_qty - a.total_qty);
    const byReturnsDesc = [...overview.by_branch].sort((a, b) => b.total_returns - a.total_returns);
    return {
      bestSales:    byQtyDesc[0],
      worstSales:   byQtyDesc[byQtyDesc.length - 1],
      mostReturns:  byReturnsDesc[0],
      leastReturns: byReturnsDesc[byReturnsDesc.length - 1],
    };
  }, [overview]);

  const overviewMatrix = useMemo(() => {
    if (!overview?.branch_month_matrix?.length) return null;
    const zeroCell = () => ({ total_qty: 0, total_returns: 0, gross_revenue: 0, net_revenue: 0 });

    const branchTotals    = {}; // branch_name → summed cell (row total)
    const cellByBranchMonth = {};
    const colTotals = Array.from({ length: 12 }, zeroCell); // index 0 = month 1
    const grandTotal = zeroCell();
    let maxQty = 1;

    overview.branch_month_matrix.forEach(c => {
      cellByBranchMonth[`${c.branch_name}-${c.month_num}`] = c;
      if (c.total_qty > maxQty) maxQty = c.total_qty;

      if (!branchTotals[c.branch_name]) branchTotals[c.branch_name] = zeroCell();
      branchTotals[c.branch_name].total_qty      += c.total_qty;
      branchTotals[c.branch_name].total_returns  += c.total_returns;
      branchTotals[c.branch_name].gross_revenue  += c.gross_revenue;
      branchTotals[c.branch_name].net_revenue    += c.net_revenue;

      const col = colTotals[c.month_num - 1];
      col.total_qty     += c.total_qty;
      col.total_returns += c.total_returns;
      col.gross_revenue += c.gross_revenue;
      col.net_revenue   += c.net_revenue;

      grandTotal.total_qty     += c.total_qty;
      grandTotal.total_returns += c.total_returns;
      grandTotal.gross_revenue += c.gross_revenue;
      grandTotal.net_revenue   += c.net_revenue;
    });

    const branches = Object.keys(branchTotals).sort((a, b) => branchTotals[b].total_qty - branchTotals[a].total_qty);
    return { branches, cellByBranchMonth, branchTotals, colTotals, grandTotal, maxQty };
  }, [overview]);

  /* ── Expense (credit note) matrix — branch × month, for the "توزيع
       الخصومات بالأشهر" table in the "نظرة عامة" tab ── */
  const expenseMatrix = useMemo(() => {
    if (!overview?.expense_month_matrix?.length) return null;
    const zeroCell = () => ({ fixed_rebate: 0, sell_out: 0, creation_vendor_marketing: 0, total_credit_note: 0, listing_fee: 0, marketing_fee: 0 });

    const branchTotals   = {};
    const cellByBranchMonth = {};
    const colTotals = Array.from({ length: 12 }, zeroCell);
    const grandTotal = zeroCell();
    let maxAmount = 1;

    overview.expense_month_matrix.forEach(raw => {
      // Split the combined fee into "listing" vs "marketing" HERE, at
      // single branch-month granularity, before any summation — doing
      // the magnitude split on an already-aggregated total (e.g. a
      // grand total mixing several months) would misclassify it.
      const cvm = raw.creation_vendor_marketing || 0;
      const isListing = cvm >= FEE_SPLIT_THRESHOLD;
      const c = {
        ...raw,
        listing_fee:   isListing ? cvm : 0,
        marketing_fee: (!isListing && cvm > 0) ? cvm : 0,
      };
      cellByBranchMonth[`${c.branch_name}-${c.month_num}`] = c;
      if (c.total_credit_note > maxAmount) maxAmount = c.total_credit_note;

      if (!branchTotals[c.branch_name]) branchTotals[c.branch_name] = zeroCell();
      branchTotals[c.branch_name].fixed_rebate              += c.fixed_rebate;
      branchTotals[c.branch_name].sell_out                  += c.sell_out;
      branchTotals[c.branch_name].creation_vendor_marketing += c.creation_vendor_marketing;
      branchTotals[c.branch_name].total_credit_note         += c.total_credit_note;
      branchTotals[c.branch_name].listing_fee               += c.listing_fee;
      branchTotals[c.branch_name].marketing_fee              += c.marketing_fee;

      const col = colTotals[c.month_num - 1];
      col.fixed_rebate              += c.fixed_rebate;
      col.sell_out                  += c.sell_out;
      col.creation_vendor_marketing += c.creation_vendor_marketing;
      col.total_credit_note         += c.total_credit_note;
      col.listing_fee               += c.listing_fee;
      col.marketing_fee             += c.marketing_fee;

      grandTotal.fixed_rebate              += c.fixed_rebate;
      grandTotal.sell_out                  += c.sell_out;
      grandTotal.creation_vendor_marketing += c.creation_vendor_marketing;
      grandTotal.total_credit_note         += c.total_credit_note;
      grandTotal.listing_fee               += c.listing_fee;
      grandTotal.marketing_fee             += c.marketing_fee;
    });

    const branches = Object.keys(branchTotals).sort((a, b) => branchTotals[b].total_credit_note - branchTotals[a].total_credit_note);
    return { branches, cellByBranchMonth, branchTotals, colTotals, grandTotal, maxAmount };
  }, [overview]);

  /* Whole-period fee amount currently excluded by the two toggles above
     — used to keep the "إجمالي إشعارات الخصم" / "صافي الإيرادات" KPI
     cards in sync with the expense-matrix toggles instead of always
     showing the backend's unadjusted totals. */
  const kpiExcludedFee = expenseMatrix
    ? (excludeListingFee ? expenseMatrix.grandTotal.listing_fee : 0) +
      (excludeMarketingSupportFee ? expenseMatrix.grandTotal.marketing_fee : 0)
    : 0;

  /* ── Revenue reconciliation rows for the expense matrix — scoped ONLY
       to the branch(es) that actually have expense records (e.g.
       Carrefour). Sourced from `expense_branch_revenue`, which the
       backend matches by customer_name (Carrefour stores are recorded
       there in Arabic, e.g. "كارفور الرياض بارك" — there is no
       sales_activity branch_name or customer_name literally spelled
       "Carrefour"). Summing whole-company revenue instead would let
       unrelated branches mask a branch's own loss for a given month. ── */
  const expenseRevenueTotals = useMemo(() => {
    if (!overview?.expense_branch_revenue) return null;
    const colGross = Array.from({ length: 12 }, () => 0);
    let grandGross = 0;
    overview.expense_branch_revenue.forEach(r => {
      colGross[r.month_num - 1] += r.gross_revenue;
      grandGross += r.gross_revenue;
    });
    return { colGross, grandGross };
  }, [overview]);

  /* ── Customer × month matrix column/grand totals (row totals already
       come pre-computed per customer as annual_qty/returns/revenue) ── */
  const custMatrixTotals = useMemo(() => {
    if (!custMatrix?.items?.length) return null;
    const zeroCell = () => ({ qty: 0, returns: 0, revenue: 0 });
    const colTotals = Array.from({ length: 12 }, zeroCell);
    const grandTotal = zeroCell();
    custMatrix.items.forEach(it => {
      it.months.forEach((mo, i) => {
        colTotals[i].qty     += mo.qty;
        colTotals[i].returns += mo.returns;
        colTotals[i].revenue += mo.revenue;
      });
      grandTotal.qty     += it.annual_qty;
      grandTotal.returns += it.annual_returns;
      grandTotal.revenue += it.annual_revenue;
    });
    return { colTotals, grandTotal };
  }, [custMatrix]);

  /* ── Derived values ──────────────────────────────────────── */
  const monthName     = MONTHS.find(m => m[0] === month)?.[1] || '';
  const prevMonthName = MONTHS.find(m => m[0] === (month === 1 ? 12 : month - 1))?.[1] || '';

  // Declared here (before handleExport) since its useCallback dependency
  // array reads cur/prev/dev — referencing them before this point would be
  // a TDZ ReferenceError ("Cannot access 'x' before initialization").
  const d    = data;
  const cur  = d?.cur;
  const prev = d?.prev;
  const dev  = d?.deviation;

  function handlePrint() {
    const prev = document.title;
    document.title = `Hypermarkets — ${monthsLabel} ${yearsLabel}`;
    window.print();
    window.onafterprint = () => { document.title = prev; };
  }

  /* ── Excel export ─────────────────────────────────────────── */
  const handleExport = useCallback(() => {
    if (!data) return;
    const wb = XLSX.utils.book_new();

    /* ── Sheet 1: KPI summary ── */
    const kpiRows = [
      ['التقرير', `Hypermarkets — ${monthsLabel} ${yearsLabel}`],
      ['المنطقة', branchLabel],
      ['المندوب', repName || 'جميع المناديب'],
      ['أيام العمل', data.meta?.working_days_cur ?? ''],
      [''],
      ['المؤشر', monthName, prevMonthName, 'الانحراف %'],
      ['إجمالي الكمية',       fmt(cur?.total_qty),         fmt(prev?.total_qty),         dev?.qty_pct ?? ''],
      ['المتوسط اليومي',      fmt(cur?.daily_avg, 1),      fmt(prev?.daily_avg, 1),      dev?.daily_avg_pct ?? ''],
      ['متوسط الكمية/عميل',   fmt(cur?.avg_per_customer,1), '', ''],
      ['المرتجعات',           fmt(cur?.total_returns),     fmt(prev?.total_returns),     ''],
      ['نسبة المرتجعات %',    fmt(cur?.returns_pct,1),      fmt(prev?.returns_pct,1),     dev?.returns_delta ?? ''],
      ['العملاء المتعاملون',  fmt(cur?.active_customers),   fmt(prev?.active_customers),  dev?.customers_pct ?? ''],
      ['عملاء جدد',           fmt(cur?.new_customers), '', ''],
      ['عملاء متوقفون',       fmt(cur?.stopped_customers), '', ''],
      ['كمية صفر أو سالبة',   fmt(cur?.inactive_customers), '', ''],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(kpiRows);
    ws1['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'ملخص KPI');

    /* ── Sheet 2: Regions ── */
    const regHeader = ['المنطقة', 'الكمية', 'الشهر الماضي', 'الانحراف %', 'العملاء', 'المرتجعات', 'نسبة المرتجعات %'];
    const regRows = (data.by_region || []).map(r => {
      const dv = r.prev_qty > 0 ? +((r.total_qty - r.prev_qty) / r.prev_qty * 100).toFixed(1) : '';
      return [
        r.branch_name, Number(r.total_qty) || 0, Number(r.prev_qty) || 0, dv,
        Number(r.active_customers) || 0, Number(r.total_returns) || 0, Number(r.returns_pct) || 0,
      ];
    });
    const ws2 = XLSX.utils.aoa_to_sheet([regHeader, ...regRows]);
    ws2['!cols'] = [{ wch: 20 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'المناطق');

    /* ── Sheet 3: Reps ── */
    const repHeader = ['المندوب', 'المنطقة', 'الكمية', 'الشهر الماضي', 'الانحراف %', 'العملاء', 'المرتجعات', 'نسبة المرتجعات %'];
    const repRows = [...(data.by_rep || [])].sort((a, b) => b.total_qty - a.total_qty).map(r => {
      const dv = r.prev_qty > 0 ? +((r.total_qty - r.prev_qty) / r.prev_qty * 100).toFixed(1) : '';
      return [
        r.salesrep_name, r.branch_name, Number(r.total_qty) || 0, Number(r.prev_qty) || 0, dv,
        Number(r.active_customers) || 0, Number(r.total_returns) || 0, Number(r.returns_pct) || 0,
      ];
    });
    const ws3 = XLSX.utils.aoa_to_sheet([repHeader, ...repRows]);
    ws3['!cols'] = [{ wch: 26 }, { wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'المناديب');

    /* ── Sheet 4: Customers ── */
    const custHeader = ['كود العميل', 'اسم العميل', 'المنطقة', 'المندوب', 'الكمية', 'المرتجعات', 'نسبة المرتجعات %', 'عدد الفواتير'];
    const custRows = [...(data.customers || [])].sort((a, b) => b.total_qty - a.total_qty).map(c => [
      c.customer_code, c.customer_name, c.branch_name || '', c.salesrep_name || '',
      Number(c.total_qty) || 0, Number(c.total_returns) || 0, Number(c.returns_pct) || 0, Number(c.invoice_count) || 0,
    ]);
    const ws4 = XLSX.utils.aoa_to_sheet([custHeader, ...custRows]);
    ws4['!cols'] = [{ wch: 14 }, { wch: 28 }, { wch: 16 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws4, 'العملاء');

    /* ── Sheet: Items ── */
    const itemHeader = ['الصنف', 'الفئة', 'الكمية', 'الشهر الماضي', 'الانحراف %', 'المرتجعات', 'نسبة المرتجعات %', 'عدد الفواتير'];
    const itemRows = [...(data.by_item || [])].sort((a, b) => b.total_qty - a.total_qty).map(it => {
      const dv = it.prev_qty > 0 ? +((it.total_qty - it.prev_qty) / it.prev_qty * 100).toFixed(1) : '';
      return [
        it.item_name, it.item_category, Number(it.total_qty) || 0, Number(it.prev_qty) || 0, dv,
        Number(it.total_returns) || 0, Number(it.returns_pct) || 0, Number(it.invoice_count) || 0,
      ];
    });
    const wsItems = XLSX.utils.aoa_to_sheet([itemHeader, ...itemRows]);
    wsItems['!cols'] = [{ wch: 28 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsItems, 'الأصناف');

    /* ── Sheet 5: Whole-period overview (if loaded) ── */
    if (overview) {
      const ovRows = [
        ['الفترة', `${overview.period.from_year} — ${overview.period.to_year}`],
        ['إجمالي الكمية', overview.totals.total_qty],
        ['إجمالي المرتجعات', overview.totals.total_returns],
        ['نسبة المرتجعات %', overview.totals.returns_pct],
        ['الإيرادات قبل الخصم', overview.totals.gross_revenue],
        ['إجمالي إشعارات الخصم', overview.totals.total_credit_notes],
        ['صافي الإيرادات', overview.totals.net_revenue],
        ['عدد الفواتير المدخلة', overview.totals.invoice_count],
        ['العملاء المتعاملون', overview.totals.active_customers],
        [''],
        ['أفضل الفروع (كل الفترة)'],
        ['الفرع', 'الكمية', 'العملاء', 'عدد الفواتير', 'المرتجعات', 'نسبة المرتجعات %'],
        ...overview.by_branch.map(b => [b.branch_name, b.total_qty, b.active_customers, b.invoice_count, b.total_returns, b.returns_pct]),
        [''],
        ['الترند الشهري (كل الفترة)'],
        ['الشهر', 'الكمية', 'المرتجعات', 'صافي الإيرادات', 'العملاء', 'عدد الفواتير'],
        ...overview.trend.map(t => [t.label, t.total_qty, t.total_returns, t.net_revenue, t.active_customers, t.invoice_count]),
      ];
      const ws5 = XLSX.utils.aoa_to_sheet(ovRows);
      ws5['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, ws5, 'نظرة عامة');
    }

    const today = new Date().toLocaleDateString('en-CA');
    XLSX.writeFile(wb, `Hypermarkets_${monthsLabel.replace(/[،\s]+/g, '-')}_${yearsLabel.replace(/[،\s]+/g, '-')}_${today}.xlsx`);
  }, [data, overview, monthName, prevMonthName, monthsLabel, yearsLabel, branchLabel, repName, cur, prev, dev]);

  /* ── Comparison row helper ───────────────────────────────── */
  function CmpRow({ label, curVal, prevVal, pct, invert = false }) {
    return (
      <div className="hm-cmp-row">
        <span className="hm-cmp-label">{label}</span>
        <span className="hm-cmp-cur">{curVal}</span>
        <span className="hm-cmp-prev">{prevVal}</span>
        <span className="hm-cmp-dev"><Dev pct={pct} invert={invert} size="sm" /></span>
      </div>
    );
  }

  return (
    <div className="hm-page">

      {/* ── Print header ─────────────────────────────────── */}
      <div className="hm-print-header">
        <div className="hm-print-logo">🏪 Hypermarkets Performance Report</div>
        <div className="hm-print-sub">{useDateRange ? `${dateFrom} → ${dateTo}` : `${monthsLabel} ${yearsLabel}`}{branchNames.length ? ` · ${branchLabel}` : ''}{repName ? ` · ${repName}` : ''}</div>
      </div>

      {/* ── Page header ──────────────────────────────────── */}
      <div className="hm-header hm-no-print">
        <div className="hm-header__left">
          <span className="hm-header__icon">🏪</span>
          <div>
            <div className="hm-header__title">Hypermarkets</div>
            <div className="hm-header__sub">تقرير أداء مبيعات ومرتجعات فئة Hypermarkets</div>
          </div>
        </div>
        <div className="hm-header__actions">
          <button className="hm-btn hm-btn--outline" onClick={handleExport} disabled={!data}>📊 تصدير Excel</button>
          <button className="hm-btn hm-btn--outline" onClick={handlePrint}>🖨️ طباعة</button>
        </div>
      </div>

      {/* ── Filters ──────────────────────────────────────── */}
      <div className="hm-filters hm-no-print">
        <label className="hm-range-toggle">
          <input type="checkbox" checked={useDateRange}
                 onChange={e => setUseDateRange(e.target.checked)} />
          فترة محددة بالتاريخ
        </label>

        {useDateRange ? (
          <>
            <div className="hm-filter-group">
              <label>من تاريخ</label>
              <input type="date" value={dateFrom} max={dateTo || undefined}
                     onChange={e => setDateFrom(e.target.value)} />
            </div>
            <div className="hm-filter-group">
              <label>إلى تاريخ</label>
              <input type="date" value={dateTo} min={dateFrom || undefined}
                     onChange={e => setDateTo(e.target.value)} />
            </div>
          </>
        ) : (
          <>
            <div className="hm-filter-group">
              <label>السنة</label>
              <MultiSelectDropdown
                options={YEARS.map(y => ({ value: y, label: y }))}
                selected={selectedYears} onChange={setSelectedYears}
                multiLabel={n => `${n} سنوات`} />
            </div>
            <div className="hm-filter-group">
              <label>الشهر</label>
              <MultiSelectDropdown
                options={MONTHS.map(([v, l]) => ({ value: v, label: l }))}
                selected={selectedMonths} onChange={setSelectedMonths}
                multiLabel={n => `${n} أشهر`} />
            </div>
          </>
        )}

        <div className="hm-filter-group">
          <label>المنطقة</label>
          <RegionMultiSelect
            branches={allBranches}
            selected={branchNames}
            onChange={next => { setBranchNames(next); setRepName(''); }}
          />
        </div>
        <div className="hm-filter-group">
          <label>المندوب</label>
          <select value={repName} onChange={e => setRepName(e.target.value)}>
            <option value="">جميع المناديب</option>
            {repOptions.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
          </select>
        </div>

        {(branchNames.length > 0 || repName) && (
          <button className="hm-btn hm-btn--ghost" onClick={() => { setBranchNames([]); setRepName(''); }}>
            ✕ إعادة تعيين
          </button>
        )}
      </div>

      {rangeInvalid && (
        <div className="hm-error">نطاق التاريخ غير صحيح — «إلى» قبل «من».</div>
      )}

      {/* ── Loading / Error ─────────────────────────────── */}
      {isLoading && (
        <div className="hm-loading"><div className="hm-spinner"/><span>جاري التحميل…</span></div>
      )}
      {isError && !isLoading && (
        <div className="hm-error">حدث خطأ في تحميل البيانات — يرجى المحاولة مجدداً.</div>
      )}

      {d && !isLoading && (
        <>
          {/* ── Period badge ──────────────────────────────── */}
          <div className="hm-period">
            <span className="hm-period__cur">{monthsLabel} {yearsLabel}</span>
            <span className="hm-period__vs">مقارنةً بـ</span>
            <span className="hm-period__prev">{prevMonthName}</span>
            <span className="hm-period__wd">· أيام العمل: {d.meta.working_days_cur}</span>
          </div>

          {/* ══════════════════════════════════════════════
              KPI ROW 1 — Sales Performance
          ══════════════════════════════════════════════ */}
          <div className="hm-section-title">مؤشرات المبيعات</div>
          <div className="hm-kpi-row">
            <KpiCard big
              icon="📦" accent="blue"
              label="إجمالي الكمية"
              value={fmt(cur?.total_qty)}
              sub={`الشهر الماضي: ${fmt(prev?.total_qty)}`}
              deviation={dev?.qty_pct}
            />
            <KpiCard big
              icon="📅" accent="blue"
              label="المتوسط اليومي"
              value={fmt(cur?.daily_avg, 1)}
              sub={`الشهر الماضي: ${fmt(prev?.daily_avg, 1)}`}
              deviation={dev?.daily_avg_pct}
            />
            <KpiCard big
              icon="🏪" accent="purple"
              label="متوسط الكمية / عميل"
              value={fmt(cur?.avg_per_customer, 1)}
              sub={`${fmt(cur?.active_customers)} عميل نشط`}
            />
            <KpiCard big
              icon="↩️" accent="orange"
              label="نسبة المرتجعات"
              value={`${fmt(cur?.returns_pct, 1)}%`}
              sub={`الكمية: ${fmt(cur?.total_returns)} · الشهر الماضي: ${fmt(prev?.returns_pct, 1)}%`}
              deviation={dev?.returns_delta}
              invertDev
            />
          </div>

          {/* ══════════════════════════════════════════════
              KPI ROW 2 — Customer Movement
          ══════════════════════════════════════════════ */}
          <div className="hm-section-title">حركة العملاء</div>
          <div className="hm-kpi-row">
            <KpiCard
              icon="✅" accent="green"
              label="العملاء المتعاملون"
              value={fmt(cur?.active_customers)}
              sub={`الشهر الماضي: ${fmt(prev?.active_customers)}`}
              deviation={dev?.customers_pct}
            />
            <KpiCard
              icon="🆕" accent="blue"
              label="عملاء جدد"
              value={fmt(cur?.new_customers)}
              sub={`أول ظهور في ${monthsLabel}`}
            />
            <KpiCard
              icon="⛔" accent="red"
              label="عملاء متوقفون"
              value={fmt(cur?.stopped_customers)}
              sub={`كانوا نشطين في ${prevMonthName}`}
            />
            <KpiCard
              icon="⚪" accent="muted"
              label="كمية صفر أو سالبة"
              value={fmt(cur?.inactive_customers)}
              sub="لديهم فواتير بكمية ≤ 0"
            />
          </div>

          {/* ══════════════════════════════════════════════
              Trend Chart + Comparison Table
          ══════════════════════════════════════════════ */}
          <div className="hm-section-title">الاتجاه الشهري — {yearsLabel}</div>
          <div className="hm-twin-grid">
            {/* Trend chart */}
            <div className="hm-card">
              <div className="hm-card__title">مقارنة المبيعات والمرتجعات شهرياً</div>
              <TrendChart trend={d.trend} highlight={month} />
            </div>

            {/* Month-over-month comparison table */}
            <div className="hm-card">
              <div className="hm-card__title">
                المقارنة الشهرية — {monthName} vs {prevMonthName}
              </div>
              <div className="hm-cmp">
                <div className="hm-cmp-head">
                  <span></span>
                  <span>{monthName}</span>
                  <span>{prevMonthName}</span>
                  <span>الانحراف</span>
                </div>
                <CmpRow
                  label="إجمالي الكمية"
                  curVal={fmt(cur?.total_qty)}
                  prevVal={fmt(prev?.total_qty)}
                  pct={dev?.qty_pct}
                />
                <CmpRow
                  label="المتوسط اليومي"
                  curVal={fmt(cur?.daily_avg, 1)}
                  prevVal={fmt(prev?.daily_avg, 1)}
                  pct={dev?.daily_avg_pct}
                />
                <CmpRow
                  label="المرتجعات"
                  curVal={fmt(cur?.total_returns)}
                  prevVal={fmt(prev?.total_returns)}
                  pct={cur?.total_returns != null && prev?.total_returns != null && prev.total_returns > 0
                    ? +((cur.total_returns - prev.total_returns) / prev.total_returns * 100).toFixed(1)
                    : null}
                  invert
                />
                <CmpRow
                  label="نسبة المرتجعات %"
                  curVal={`${fmt(cur?.returns_pct, 1)}%`}
                  prevVal={`${fmt(prev?.returns_pct, 1)}%`}
                  pct={dev?.returns_delta}
                  invert
                />
                <CmpRow
                  label="العملاء النشطون"
                  curVal={fmt(cur?.active_customers)}
                  prevVal={fmt(prev?.active_customers)}
                  pct={dev?.customers_pct}
                />
              </div>

              {/* Achievement indicator */}
              {dev?.qty_pct != null && (
                <div className={`hm-achievement${dev.qty_pct >= 0 ? ' hm-achievement--pos' : ' hm-achievement--neg'}`}>
                  {dev.qty_pct >= 10  && '🚀 نمو ممتاز'}
                  {dev.qty_pct >= 0 && dev.qty_pct < 10 && '✅ أداء مستقر'}
                  {dev.qty_pct < 0 && dev.qty_pct >= -10 && '⚠️ تراجع طفيف'}
                  {dev.qty_pct < -10 && '🔴 تراجع ملحوظ — يحتاج متابعة'}
                  <span className="hm-achievement__num">
                    {dev.qty_pct >= 0 ? '+' : ''}{dev.qty_pct}% عن الشهر الماضي
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ══════════════════════════════════════════════
              Tabs
          ══════════════════════════════════════════════ */}
          <div className="hm-tabs hm-no-print">
            {[
              ['general',  'نظرة عامة'],
              ['regions',  'المناطق'],
              ['reps',     'المناديب'],
              ['customers','العملاء'],
              ['items',    'أداء الأصناف'],
            ].map(([k, l]) => (
              <button
                key={k}
                className={`hm-tab${activeTab === k ? ' hm-tab--active' : ''}`}
                onClick={() => setActiveTab(k)}
              >{l}</button>
            ))}
          </div>

          {/* ══════════════════════════════════════════════
              TAB: General overview — whole-period performance
          ══════════════════════════════════════════════ */}
          {activeTab === 'general' && (
            <div className="hm-tab-content">
              {isOverviewLoading && (
                <div className="hm-loading"><div className="hm-spinner"/><span>جاري التحميل…</span></div>
              )}
              {isOverviewError && !isOverviewLoading && (
                <div className="hm-error">حدث خطأ في تحميل النظرة العامة.</div>
              )}
              {overview && !isOverviewLoading && (
                <>
                  <div className="hm-period">
                    <span className="hm-period__cur">
                      كامل الفترة: {overview.period.from_year} — {overview.period.to_year}
                    </span>
                    <span className="hm-period__wd">· {overview.period.months_count} شهر بيانات</span>
                    {isAdmin && (
                      <span className="hm-expense-upload">
                        <input
                          type="file" ref={expenseFileRef} accept=".xlsx,.xls,.csv"
                          style={{ display: 'none' }} onChange={handleExpenseFile}
                        />
                        <button
                          type="button" className="hm-btn hm-btn--outline"
                          disabled={expenseUploading}
                          onClick={() => expenseFileRef.current?.click()}
                          title="رفع جدول مصروفات الفرع الشهرية (كارفور) لخصمها من صافي الإيرادات"
                        >
                          {expenseUploading ? 'جارٍ الرفع…' : '📤 رفع مصروفات الفرع'}
                        </button>
                        {expenseMsg && <span className="hm-expense-upload__msg">{expenseMsg}</span>}
                      </span>
                    )}
                  </div>

                  <div className="hm-kpi-row hm-kpi-row--overview">
                    <KpiCard big icon="📦" accent="blue"
                      label="إجمالي الكمية (كل الفترة)"
                      value={fmt(overview.totals.total_qty)} />
                    <KpiCard big icon="↩️" accent="orange"
                      label="إجمالي المرتجعات"
                      value={fmt(overview.totals.total_returns)}
                      sub={`نسبة المرتجعات: ${fmt(overview.totals.returns_pct, 1)}%`} />
                    <KpiCard big icon="🧾" accent="purple"
                      label="عدد الفواتير المدخلة"
                      value={fmt(overview.totals.invoice_count)} />
                    <KpiCard big icon="✅" accent="green"
                      label="العملاء المتعاملون"
                      value={fmt(overview.totals.active_customers)}
                      sub="عبر كامل الفترة" />
                    <KpiCard big icon="💵" accent="blue"
                      label="الإيرادات قبل الخصم (كل الفترة)"
                      value={`${fmt(overview.totals.gross_revenue)} ر.س`}
                      sub="قبل خصم إشعارات الخصم" />
                    <KpiCard big icon="🧮" accent="orange"
                      label="إجمالي إشعارات الخصم"
                      value={`${fmt(overview.totals.total_credit_notes - kpiExcludedFee)} ر.س`}
                      sub={kpiExcludedFee > 0 ? `مصروفات الفرع (رِبيت كارفور) — بعد استبعاد ${fmt(kpiExcludedFee)} ر.س` : 'مصروفات الفرع (رِبيت كارفور)'} />
                    <KpiCard big icon="💰" accent="green"
                      label="صافي الإيرادات (كل الفترة)"
                      value={`${fmt(overview.totals.net_revenue + kpiExcludedFee)} ر.س`}
                      sub="بعد خصم مصروفات الفرع (رِبيت كارفور)" />
                  </div>

                  {overview.best_branch && (
                    <div className="hm-best-branch">
                      <span className="hm-best-branch__crown">🏆</span>
                      <div className="hm-best-branch__body">
                        <div className="hm-best-branch__lbl">أفضل فرع أداءً</div>
                        <div className="hm-best-branch__name">{overview.best_branch.branch_name}</div>
                      </div>
                      <div className="hm-best-branch__stats">
                        <span><strong>{fmt(overview.best_branch.total_qty)}</strong> كمية</span>
                        <span><strong>{fmt(overview.best_branch.invoice_count)}</strong> فاتورة</span>
                        <span><strong>{fmt(overview.best_branch.active_customers)}</strong> عميل</span>
                      </div>
                    </div>
                  )}

                  {/* ── Insight card: quick highlights + admin comment ── */}
                  {branchInsights && (
                    <div className="hm-card hm-insight-card">
                      <div className="hm-card__title">💡 Insight — نظرة سريعة</div>
                      <div className="hm-insight-grid">
                        <div className="hm-insight-item hm-insight-item--pos">
                          <span className="hm-insight-icon">📈</span>
                          <div>
                            <div className="hm-insight-lbl">أفضل فرع مبيعاً</div>
                            <div className="hm-insight-val">{branchInsights.bestSales.branch_name}</div>
                            <div className="hm-insight-sub">{fmt(branchInsights.bestSales.total_qty)} كمية</div>
                          </div>
                        </div>
                        <div className="hm-insight-item hm-insight-item--neg">
                          <span className="hm-insight-icon">📉</span>
                          <div>
                            <div className="hm-insight-lbl">أقل فرع مبيعاً</div>
                            <div className="hm-insight-val">{branchInsights.worstSales.branch_name}</div>
                            <div className="hm-insight-sub">{fmt(branchInsights.worstSales.total_qty)} كمية</div>
                          </div>
                        </div>
                        <div className="hm-insight-item hm-insight-item--neg">
                          <span className="hm-insight-icon">↩️</span>
                          <div>
                            <div className="hm-insight-lbl">أكثر فرع مرتجعات</div>
                            <div className="hm-insight-val">{branchInsights.mostReturns.branch_name}</div>
                            <div className="hm-insight-sub">{fmt(branchInsights.mostReturns.total_returns)} مرتجعات</div>
                          </div>
                        </div>
                        <div className="hm-insight-item hm-insight-item--pos">
                          <span className="hm-insight-icon">✅</span>
                          <div>
                            <div className="hm-insight-lbl">أقل فرع مرتجعات (توالف)</div>
                            <div className="hm-insight-val">{branchInsights.leastReturns.branch_name}</div>
                            <div className="hm-insight-sub">{fmt(branchInsights.leastReturns.total_returns)} مرتجعات</div>
                          </div>
                        </div>
                      </div>

                      {/* ── Admin free-text comment ── */}
                      <div className="hm-insight-note">
                        <div className="hm-insight-note__lbl">ملاحظة الإدارة</div>
                        {isAdmin ? (
                          <>
                            <textarea
                              className="hm-insight-note__input"
                              rows={3}
                              placeholder="اكتب تعليقاً أو نقاطاً حول أداء هذا الشهر…"
                              value={insightNoteText}
                              onChange={e => setInsightNoteDraft(e.target.value)}
                            />
                            <div className="hm-insight-note__actions">
                              <button
                                type="button" className="hm-btn hm-btn--outline"
                                disabled={insightNoteSaving || insightNoteDraft === null}
                                onClick={saveInsightNote}
                              >
                                {insightNoteSaving ? 'جارٍ الحفظ…' : '💾 حفظ الملاحظة'}
                              </button>
                              {insightNoteDraft !== null && (
                                <button
                                  type="button" className="hm-btn hm-btn--ghost"
                                  onClick={() => setInsightNoteDraft(null)}
                                >إلغاء</button>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="hm-insight-note__readonly">
                            {insightNoteText ? insightNoteText : <span className="hm-dash">لا توجد ملاحظات بعد</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="hm-card">
                    <div className="hm-card__title">ترند الأداء الشهري لكامل الفترة — المبيعات والمرتجعات</div>
                    <TrendChart trend={overview.trend} labelKey="label" />
                  </div>

                  {/* ── Branch × month matrix: qty, returns & revenue heatmap ── */}
                  {overviewMatrix && (
                    <div className="hm-card">
                      <div className="hm-card__title hm-card__title--with-filters">
                        <span>مصفوفة الأداء الشهري لكامل الفترة حسب المنطقة — مبيعات ومرتجعات وإيرادات</span>
                        <span className="hm-metric-toggle">
                          <button type="button"
                            className={`hm-metric-btn${regionMatrixMetrics.qty ? ' hm-metric-btn--active hm-metric-btn--qty' : ''}`}
                            onClick={() => toggleRegionMatrixMetric('qty')}>المبيعات</button>
                          <button type="button"
                            className={`hm-metric-btn${regionMatrixMetrics.revenue ? ' hm-metric-btn--active hm-metric-btn--revenue' : ''}`}
                            onClick={() => toggleRegionMatrixMetric('revenue')}>الإيرادات</button>
                          <button type="button"
                            className={`hm-metric-btn${regionMatrixMetrics.returns ? ' hm-metric-btn--active hm-metric-btn--returns' : ''}`}
                            onClick={() => toggleRegionMatrixMetric('returns')}>المرتجعات</button>
                        </span>
                      </div>
                      <div className="hm-matrix-wrap">
                        <table className="hm-matrix-table">
                          <thead>
                            <tr>
                              <th className="hm-matrix-th-item">المنطقة</th>
                              {MONTHS.map(([mn, ml]) => (
                                <th key={mn} className="hm-matrix-th-month">{ml}</th>
                              ))}
                              <th className="hm-matrix-th-total">الإجمالي</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overviewMatrix.branches.map(br => {
                              const rowTotal = overviewMatrix.branchTotals[br];
                              return (
                                <tr key={br}>
                                  <td className="hm-matrix-td-item">{br}</td>
                                  {MONTHS.map(([mn]) => {
                                    const cell = overviewMatrix.cellByBranchMonth[`${br}-${mn}`];
                                    const qty = cell?.total_qty || 0;
                                    const returns = cell?.total_returns || 0;
                                    const revenue = cell?.net_revenue || 0;
                                    const intensity = overviewMatrix.maxQty > 0 ? qty / overviewMatrix.maxQty : 0;
                                    const bg = qty > 0 ? `rgba(59,130,246,${0.08 + intensity * 0.55})` : 'transparent';
                                    const showQty     = regionMatrixMetrics.qty && qty > 0;
                                    const showReturns = regionMatrixMetrics.returns && returns > 0;
                                    const showRevenue = regionMatrixMetrics.revenue && revenue > 0;
                                    return (
                                      <td key={mn} className="hm-matrix-td-cell" style={{ background: bg }}>
                                        {showQty && <span className="hm-matrix-qty">{fmt(qty)}</span>}
                                        {showReturns && <span className="hm-matrix-ret">↩{fmt(returns)}</span>}
                                        {showRevenue && <span className="hm-matrix-rev">{fmt(revenue)} ر.س</span>}
                                        {!showQty && !showReturns && !showRevenue && <span className="hm-matrix-dash">—</span>}
                                      </td>
                                    );
                                  })}
                                  <td className="hm-matrix-td-total">
                                    {regionMatrixMetrics.qty && <span className="hm-matrix-qty">{fmt(rowTotal.total_qty)}</span>}
                                    {regionMatrixMetrics.returns && rowTotal.total_returns > 0 && <span className="hm-matrix-ret">↩{fmt(rowTotal.total_returns)}</span>}
                                    {regionMatrixMetrics.revenue && rowTotal.net_revenue > 0 && <span className="hm-matrix-rev">{fmt(rowTotal.net_revenue)} ر.س</span>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="hm-matrix-tf-row">
                              <td className="hm-matrix-td-item hm-matrix-td-item--tf">الإجمالي</td>
                              {overviewMatrix.colTotals.map((col, i) => (
                                <td key={i} className="hm-matrix-td-total">
                                  {regionMatrixMetrics.qty && <span className="hm-matrix-qty">{fmt(col.total_qty)}</span>}
                                  {regionMatrixMetrics.returns && col.total_returns > 0 && <span className="hm-matrix-ret">↩{fmt(col.total_returns)}</span>}
                                  {regionMatrixMetrics.revenue && col.net_revenue > 0 && <span className="hm-matrix-rev">{fmt(col.net_revenue)} ر.س</span>}
                                </td>
                              ))}
                              <td className="hm-matrix-td-total hm-matrix-td-grand">
                                {regionMatrixMetrics.qty && <span className="hm-matrix-qty">{fmt(overviewMatrix.grandTotal.total_qty)}</span>}
                                {regionMatrixMetrics.returns && overviewMatrix.grandTotal.total_returns > 0 && <span className="hm-matrix-ret">↩{fmt(overviewMatrix.grandTotal.total_returns)}</span>}
                                {regionMatrixMetrics.revenue && overviewMatrix.grandTotal.net_revenue > 0 && <span className="hm-matrix-rev">{fmt(overviewMatrix.grandTotal.net_revenue)} ر.س</span>}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* ── Expense (credit note) matrix — branch × month ── */}
                  {expenseMatrix && (
                    <div className="hm-card">
                      <div className="hm-card__title hm-card__title--with-filters">
                        <span>مصفوفة إشعارات الخصم الشهرية حسب الفرع — خصم ثابت ومبيعات نقاط بيع ورسوم إدراج ودعم تسويق</span>
                        <div className="hm-fee-toggle-group">
                          <button
                            type="button"
                            className={`hm-fee-toggle${excludeListingFee ? ' hm-fee-toggle--active' : ''}`}
                            onClick={() => setExcludeListingFee(v => !v)}
                          >
                            {excludeListingFee ? '✅ رسوم الإدراج مستبعدة' : '🚫 استبعاد رسوم الإدراج'}
                          </button>
                          <button
                            type="button"
                            className={`hm-fee-toggle${excludeMarketingSupportFee ? ' hm-fee-toggle--active' : ''}`}
                            onClick={() => setExcludeMarketingSupportFee(v => !v)}
                          >
                            {excludeMarketingSupportFee ? '✅ رسوم التسويق مستبعدة' : '🚫 استبعاد رسوم التسويق'}
                          </button>
                        </div>
                      </div>
                      <div className="hm-matrix-wrap">
                        <table className="hm-matrix-table">
                          <thead>
                            <tr>
                              <th className="hm-matrix-th-item">الفرع</th>
                              {MONTHS.map(([mn, ml]) => (
                                <th key={mn} className="hm-matrix-th-month">{ml}</th>
                              ))}
                              <th className="hm-matrix-th-total">الإجمالي</th>
                            </tr>
                          </thead>
                          <tbody>
                            {expenseMatrix.branches.map(br => {
                              const rowTotal = expenseMatrix.branchTotals[br];
                              return (
                                <tr key={br}>
                                  <td className="hm-matrix-td-item">{br}</td>
                                  {MONTHS.map(([mn]) => {
                                    const cell = expenseMatrix.cellByBranchMonth[`${br}-${mn}`];
                                    const total = effCreditNote(cell);
                                    const intensity = expenseMatrix.maxAmount > 0 ? total / expenseMatrix.maxAmount : 0;
                                    const bg = total > 0 ? `rgba(220,38,38,${0.06 + intensity * 0.45})` : 'transparent';
                                    return (
                                      <td key={mn} className="hm-matrix-td-cell" style={{ background: bg }}>
                                        {total > 0
                                          ? <span className="hm-matrix-qty">{fmt(total)} ر.س</span>
                                          : <span className="hm-matrix-dash">—</span>}
                                        {cell?.fixed_rebate > 0 && <span className="hm-matrix-ret">Fixed Rebate {fmt(cell.fixed_rebate)}</span>}
                                        {cell?.sell_out > 0 && <span className="hm-matrix-ret">Sell-Out {fmt(cell.sell_out)}</span>}
                                        {cell?.listing_fee > 0 && (
                                          <span className={`hm-matrix-ret${excludeListingFee ? ' hm-matrix-ret--excluded' : ''}`}>
                                            إدراج {fmt(cell.listing_fee)}{excludeListingFee ? ' (مستبعد)' : ''}
                                          </span>
                                        )}
                                        {cell?.marketing_fee > 0 && (
                                          <span className={`hm-matrix-ret${excludeMarketingSupportFee ? ' hm-matrix-ret--excluded' : ''}`}>
                                            تسويق {fmt(cell.marketing_fee)}{excludeMarketingSupportFee ? ' (مستبعد)' : ''}
                                          </span>
                                        )}
                                      </td>
                                    );
                                  })}
                                  <td className="hm-matrix-td-total">
                                    <span className="hm-matrix-qty">{fmt(effCreditNote(rowTotal))} ر.س</span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="hm-matrix-tf-row">
                              <td className="hm-matrix-td-item hm-matrix-td-item--tf">الإجمالي</td>
                              {expenseMatrix.colTotals.map((col, i) => {
                                const colAmt = effCreditNote(col);
                                return (
                                  <td key={i} className="hm-matrix-td-total">
                                    <span className="hm-matrix-qty">{colAmt > 0 ? `${fmt(colAmt)} ر.س` : '—'}</span>
                                  </td>
                                );
                              })}
                              <td className="hm-matrix-td-total hm-matrix-td-grand">
                                <span className="hm-matrix-qty">{fmt(effCreditNote(expenseMatrix.grandTotal))} ر.س</span>
                              </td>
                            </tr>
                            {expenseRevenueTotals && (
                              <>
                                <tr className="hm-matrix-tf-row hm-matrix-tf-row--revenue">
                                  <td className="hm-matrix-td-item hm-matrix-td-item--tf">
                                    الإيرادات الشهرية ({expenseMatrix.branches.join('، ')})
                                  </td>
                                  {expenseRevenueTotals.colGross.map((gross, i) => {
                                    const hasData = gross !== 0 || effCreditNote(expenseMatrix.colTotals[i]) !== 0;
                                    return (
                                      <td key={i} className="hm-matrix-td-total">
                                        <span className="hm-matrix-qty">{hasData ? `${fmt(gross)} ر.س` : '—'}</span>
                                      </td>
                                    );
                                  })}
                                  <td className="hm-matrix-td-total hm-matrix-td-grand">
                                    <span className="hm-matrix-qty">{fmt(expenseRevenueTotals.grandGross)} ر.س</span>
                                  </td>
                                </tr>
                                <tr className="hm-matrix-tf-row hm-matrix-tf-row--net">
                                  <td className="hm-matrix-td-item hm-matrix-td-item--tf">الإيرادات بعد خصم المصاريف</td>
                                  {expenseRevenueTotals.colGross.map((gross, i) => {
                                    const expenseAmt = effCreditNote(expenseMatrix.colTotals[i]);
                                    const hasData = gross !== 0 || expenseAmt !== 0;
                                    // Live subtraction of the two rows directly above — not a
                                    // pre-computed value — so this is transparently "Revenue − Expense",
                                    // and a genuinely negative result (expenses exceeding revenue
                                    // that month) is shown as-is instead of being hidden as "—".
                                    const net = gross - expenseAmt;
                                    return (
                                      <td key={i} className="hm-matrix-td-total">
                                        <span className={`hm-matrix-qty${net < 0 ? ' hm-matrix-qty--neg' : ''}`}>
                                          {hasData ? `${fmt(net)} ر.س` : '—'}
                                        </span>
                                      </td>
                                    );
                                  })}
                                  <td className="hm-matrix-td-total hm-matrix-td-grand">
                                    {(() => {
                                      const grandNet = expenseRevenueTotals.grandGross - effCreditNote(expenseMatrix.grandTotal);
                                      return (
                                        <span className={`hm-matrix-qty${grandNet < 0 ? ' hm-matrix-qty--neg' : ''}`}>
                                          {fmt(grandNet)} ر.س
                                        </span>
                                      );
                                    })()}
                                  </td>
                                </tr>
                              </>
                            )}
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  )}

                  <div className="hm-card">
                    <div className="hm-card__title">أفضل الفروع (مرتبة حسب الكمية)</div>
                    <HBar rows={overview.by_branch} valueKey="total_qty" labelKey="branch_name" colorClass="hm-bar--primary" />
                  </div>

                  <div className="hm-table-wrap">
                    {(() => {
                      const grandQty = overview.by_branch.reduce((s, b) => s + Number(b.total_qty || 0), 0);
                      return (
                        <table className="hm-table">
                          <thead>
                            <tr>
                              <th style={{width:32}}>#</th>
                              <th>الفرع</th>
                              <th>الكمية</th>
                              <th>نسبة الحصة</th>
                              <th>العملاء</th>
                              <th>عدد الفواتير</th>
                              <th>المرتجعات</th>
                              <th>نسبة المرتجعات</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overview.by_branch.map((b, i) => {
                              const sharePct = grandQty > 0 ? (Number(b.total_qty || 0) / grandQty) * 100 : 0;
                              return (
                                <tr key={b.branch_name}>
                                  <td className="hm-td-rank">{i === 0 ? '🏆' : i + 1}</td>
                                  <td className="hm-td-name">{b.branch_name}</td>
                                  <td className="hm-td-num hm-td-bold">{fmt(b.total_qty)}</td>
                                  <td className="hm-td-num">{sharePct.toFixed(1)}%</td>
                                  <td className="hm-td-num">{fmt(b.active_customers)}</td>
                                  <td className="hm-td-num">{fmt(b.invoice_count)}</td>
                                  <td className="hm-td-num">{b.total_returns > 0 ? <span className="hm-ret-badge">{fmt(b.total_returns)}</span> : <span className="hm-dash">—</span>}</td>
                                  <td className="hm-td-num">{b.returns_pct > 0 ? <span className="hm-ret-pct">{b.returns_pct}%</span> : <span className="hm-dash">—</span>}</td>
                                </tr>
                              );
                            })}
                            {overview.by_branch.length === 0 && <tr><td colSpan={8} className="hm-empty">لا توجد بيانات</td></tr>}
                          </tbody>
                          {overview.by_branch.length > 0 && (() => {
                            const sum = (key) => overview.by_branch.reduce((s, b) => s + Number(b[key] || 0), 0);
                            const totalReturns = sum('total_returns');
                            // Overall returns rate = total returns ÷ total qty (weighted),
                            // not a simple average of each branch's own percentage.
                            const pct = grandQty > 0 ? (totalReturns / grandQty) * 100 : 0;
                            return (
                              <tfoot>
                                <tr className="hm-tfoot-row">
                                  <td></td>
                                  <td className="hm-td-name hm-td-bold">الإجمالي</td>
                                  <td className="hm-td-num hm-td-bold">{fmt(grandQty)}</td>
                                  <td className="hm-td-num hm-td-bold">100%</td>
                                  <td className="hm-td-num hm-td-bold">{fmt(sum('active_customers'))}</td>
                                  <td className="hm-td-num hm-td-bold">{fmt(sum('invoice_count'))}</td>
                                  <td className="hm-td-num hm-td-bold">{fmt(totalReturns)}</td>
                                  <td className="hm-td-num hm-td-bold">{pct.toFixed(1)}%</td>
                                </tr>
                              </tfoot>
                            );
                          })()}
                        </table>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Regions
          ══════════════════════════════════════════════ */}
          {activeTab === 'regions' && (
            <div className="hm-tab-content">
              <div className="hm-twin-grid">
                <div className="hm-card">
                  <div className="hm-card__title">الكمية حسب المنطقة</div>
                  <HBar rows={d.by_region} valueKey="total_qty" labelKey="branch_name" colorClass="hm-bar--primary" />
                </div>
                <div className="hm-card">
                  <div className="hm-card__title">المرتجعات حسب المنطقة</div>
                  <HBar rows={d.by_region} valueKey="total_returns" labelKey="branch_name" colorClass="hm-bar--danger" />
                </div>
              </div>

              <div className="hm-table-wrap">
                <table className="hm-table">
                  <thead>
                    <tr>
                      <th>المنطقة</th>
                      <th>الكمية</th>
                      <th>الشهر الماضي</th>
                      <th>الانحراف</th>
                      <th>العملاء</th>
                      <th>المرتجعات</th>
                      <th>نسبة المرتجعات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.by_region.map((r, i) => {
                      const dv = r.prev_qty > 0 ? +((r.total_qty - r.prev_qty) / r.prev_qty * 100).toFixed(1) : null;
                      return (
                        <tr key={i}>
                          <td className="hm-td-name">{r.branch_name}</td>
                          <td className="hm-td-num hm-td-bold">{fmt(r.total_qty)}</td>
                          <td className="hm-td-num hm-td-muted">{fmt(r.prev_qty)}</td>
                          <td className="hm-td-num"><Dev pct={dv} size="sm" /></td>
                          <td className="hm-td-num">{fmt(r.active_customers)}</td>
                          <td className="hm-td-num">{r.total_returns > 0 ? <span className="hm-ret-badge">{fmt(r.total_returns)}</span> : <span className="hm-dash">—</span>}</td>
                          <td className="hm-td-num">{r.returns_pct > 0 ? <span className="hm-ret-pct">{r.returns_pct}%</span> : <span className="hm-dash">—</span>}</td>
                        </tr>
                      );
                    })}
                    {d.by_region.length === 0 && <tr><td colSpan={7} className="hm-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Reps
          ══════════════════════════════════════════════ */}
          {activeTab === 'reps' && (
            <div className="hm-tab-content">
              <div className="hm-twin-grid">
                <div className="hm-card">
                  <div className="hm-card__title">الكمية حسب المندوب (أعلى 10)</div>
                  <HBar rows={[...d.by_rep].sort((a,b)=>b.total_qty-a.total_qty).slice(0,10)}
                        valueKey="total_qty" labelKey="salesrep_name" colorClass="hm-bar--accent" />
                </div>
                <div className="hm-card">
                  <div className="hm-card__title">المرتجعات حسب المندوب (أعلى 10)</div>
                  <HBar rows={[...d.by_rep].sort((a,b)=>b.total_returns-a.total_returns).slice(0,10)}
                        valueKey="total_returns" labelKey="salesrep_name" colorClass="hm-bar--danger" />
                </div>
              </div>

              <div className="hm-table-wrap">
                <table className="hm-table">
                  <thead>
                    <tr>
                      <th style={{width:32}}>#</th>
                      <th>المندوب</th>
                      <th>المنطقة</th>
                      <Th col="total_qty"        sortCol={repSort.col} sortDir={repSort.dir} onSort={handleRepSort}>الكمية</Th>
                      <Th col="prev_qty"         sortCol={repSort.col} sortDir={repSort.dir} onSort={handleRepSort}>الشهر الماضي</Th>
                      <th>الانحراف</th>
                      <Th col="active_customers" sortCol={repSort.col} sortDir={repSort.dir} onSort={handleRepSort}>العملاء</Th>
                      <Th col="total_returns"    sortCol={repSort.col} sortDir={repSort.dir} onSort={handleRepSort}>المرتجعات</Th>
                      <Th col="returns_pct"      sortCol={repSort.col} sortDir={repSort.dir} onSort={handleRepSort}>نسبة المرتجعات</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedReps.map((r, i) => {
                      const rank = [...d.by_rep].sort((a,b)=>b[repSort.col]-a[repSort.col]).findIndex(x=>x.salesrep_name===r.salesrep_name)+1;
                      const dv = r.prev_qty > 0 ? +((r.total_qty - r.prev_qty) / r.prev_qty * 100).toFixed(1) : null;
                      return (
                        <tr key={r.salesrep_name}>
                          <td className="hm-td-rank">{rank}</td>
                          <td className="hm-td-name">{r.salesrep_name}</td>
                          <td className="hm-td-muted" style={{fontSize:'0.74rem'}}>{r.branch_name}</td>
                          <td className="hm-td-num hm-td-bold">{fmt(r.total_qty)}</td>
                          <td className="hm-td-num hm-td-muted">{fmt(r.prev_qty)}</td>
                          <td className="hm-td-num"><Dev pct={dv} size="sm" /></td>
                          <td className="hm-td-num">{fmt(r.active_customers)}</td>
                          <td className="hm-td-num">{r.total_returns > 0 ? <span className="hm-ret-badge">{fmt(r.total_returns)}</span> : <span className="hm-dash">—</span>}</td>
                          <td className="hm-td-num">{r.returns_pct > 0 ? <span className="hm-ret-pct">{r.returns_pct}%</span> : <span className="hm-dash">—</span>}</td>
                        </tr>
                      );
                    })}
                    {sortedReps.length === 0 && <tr><td colSpan={9} className="hm-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Customers
          ══════════════════════════════════════════════ */}
          {activeTab === 'customers' && (
            <div className="hm-tab-content">
              <div className="hm-cust-meta">
                <span>إجمالي العملاء: <strong>{fmt(d.customers.length)}</strong></span>
                <span>إجمالي الكمية: <strong>{fmt(cur?.total_qty)}</strong></span>
                <span>إجمالي المرتجعات: <strong>{fmt(cur?.total_returns)}</strong></span>
              </div>
              <div className="hm-table-wrap">
                <table className="hm-table">
                  <thead>
                    <tr>
                      <th style={{width:32}}>#</th>
                      <th>اسم العميل</th>
                      <th>المنطقة</th>
                      <th>المندوب</th>
                      <Th col="total_qty"      sortCol={custSort.col} sortDir={custSort.dir} onSort={handleCustSort}>الكمية</Th>
                      <Th col="total_returns"  sortCol={custSort.col} sortDir={custSort.dir} onSort={handleCustSort}>المرتجعات</Th>
                      <Th col="returns_pct"    sortCol={custSort.col} sortDir={custSort.dir} onSort={handleCustSort}>نسبة المرتجعات</Th>
                      <Th col="invoice_count"  sortCol={custSort.col} sortDir={custSort.dir} onSort={handleCustSort}>الفواتير</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCusts.map((c, i) => (
                      <tr key={c.customer_code}
                          className={c.total_qty <= 0 ? 'hm-tr--inactive' : ''}>
                        <td className="hm-td-rank">{i + 1}</td>
                        <td className="hm-td-name">
                          {c.customer_name}
                          <span className="hm-td-code"> ({c.customer_code})</span>
                        </td>
                        <td className="hm-td-muted" style={{fontSize:'0.74rem'}}>{c.branch_name || '—'}</td>
                        <td className="hm-td-muted" style={{fontSize:'0.74rem'}}>{c.salesrep_name || '—'}</td>
                        <td className={`hm-td-num${c.total_qty <= 0 ? ' hm-td-muted' : ' hm-td-bold'}`}>{fmt(c.total_qty)}</td>
                        <td className="hm-td-num">
                          {c.total_returns > 0
                            ? <span className="hm-ret-badge">{fmt(c.total_returns)}</span>
                            : <span className="hm-dash">—</span>}
                        </td>
                        <td className="hm-td-num">
                          {c.returns_pct > 0
                            ? <span className={`hm-ret-pct${c.returns_pct >= 30 ? ' hm-ret-pct--high' : ''}`}>{c.returns_pct}%</span>
                            : <span className="hm-dash">—</span>}
                        </td>
                        <td className="hm-td-num hm-td-muted">{fmt(c.invoice_count)}</td>
                      </tr>
                    ))}
                    {sortedCusts.length === 0 && (
                      <tr><td colSpan={8} className="hm-empty">لا توجد بيانات</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* ── Whole-period matrix: qty/returns/revenue per customer ── */}
              <div className="hm-card" style={{marginTop: 4}}>
                <div className="hm-card__title hm-card__title--with-filters">
                  <span>
                    مصفوفة الأداء الشهري لكامل الفترة حسب العميل — مبيعات ومرتجعات وإيرادات
                    {custMatrix?.items?.length ? ` (أعلى ${custMatrix.items.length} عميلاً حسب الكمية)` : ''}
                  </span>
                  <span className="hm-metric-toggle">
                    <button type="button"
                      className={`hm-metric-btn${custMatrixMetrics.qty ? ' hm-metric-btn--active hm-metric-btn--qty' : ''}`}
                      onClick={() => toggleCustMatrixMetric('qty')}>المبيعات</button>
                    <button type="button"
                      className={`hm-metric-btn${custMatrixMetrics.revenue ? ' hm-metric-btn--active hm-metric-btn--revenue' : ''}`}
                      onClick={() => toggleCustMatrixMetric('revenue')}>الإيرادات</button>
                    <button type="button"
                      className={`hm-metric-btn${custMatrixMetrics.returns ? ' hm-metric-btn--active hm-metric-btn--returns' : ''}`}
                      onClick={() => toggleCustMatrixMetric('returns')}>المرتجعات</button>
                  </span>
                </div>
                {isCustMatrixLoading && (
                  <div className="hm-loading"><div className="hm-spinner"/><span>جاري التحميل…</span></div>
                )}
                {isCustMatrixError && !isCustMatrixLoading && (
                  <div className="hm-error">حدث خطأ في تحميل مصفوفة العملاء.</div>
                )}
                {custMatrix && custMatrixTotals && !isCustMatrixLoading && (
                  <div className="hm-matrix-wrap">
                    <table className="hm-matrix-table">
                      <thead>
                        <tr>
                          <th className="hm-matrix-th-item">العميل</th>
                          <th className="hm-matrix-th-month">المنطقة</th>
                          {MONTHS.map(([mn, ml]) => (
                            <th key={mn} className="hm-matrix-th-month">{ml}</th>
                          ))}
                          <th className="hm-matrix-th-total">الإجمالي</th>
                        </tr>
                      </thead>
                      <tbody>
                        {custMatrix.items.map(it => (
                          <tr key={it.customer_code}>
                            <td className="hm-matrix-td-item" title={it.customer_code}>{it.customer_name}</td>
                            <td className="hm-matrix-td-cell hm-matrix-td-branch">{it.branch_name}</td>
                            {it.months.map(mo => {
                              const intensity = custMatrix.max_qty > 0 ? mo.qty / custMatrix.max_qty : 0;
                              const bg = mo.qty > 0 ? `rgba(59,130,246,${0.08 + intensity * 0.55})` : 'transparent';
                              const showQty     = custMatrixMetrics.qty && mo.qty > 0;
                              const showReturns = custMatrixMetrics.returns && mo.returns > 0;
                              const showRevenue = custMatrixMetrics.revenue && mo.revenue > 0;
                              return (
                                <td key={mo.month} className="hm-matrix-td-cell" style={{ background: bg }}>
                                  {showQty && <span className="hm-matrix-qty">{fmt(mo.qty)}</span>}
                                  {showReturns && <span className="hm-matrix-ret">↩{fmt(mo.returns)}</span>}
                                  {showRevenue && <span className="hm-matrix-rev">{fmt(mo.revenue)} ر.س</span>}
                                  {!showQty && !showReturns && !showRevenue && <span className="hm-matrix-dash">—</span>}
                                </td>
                              );
                            })}
                            <td className="hm-matrix-td-total">
                              {custMatrixMetrics.qty && <span className="hm-matrix-qty">{fmt(it.annual_qty)}</span>}
                              {custMatrixMetrics.returns && it.annual_returns > 0 && <span className="hm-matrix-ret">↩{fmt(it.annual_returns)}</span>}
                              {custMatrixMetrics.revenue && it.annual_revenue > 0 && <span className="hm-matrix-rev">{fmt(it.annual_revenue)} ر.س</span>}
                            </td>
                          </tr>
                        ))}
                        {(!custMatrix.items || custMatrix.items.length === 0) && (
                          <tr><td colSpan={15} className="hm-empty">لا توجد بيانات</td></tr>
                        )}
                      </tbody>
                      {custMatrix.items.length > 0 && (
                        <tfoot>
                          <tr className="hm-matrix-tf-row">
                            <td className="hm-matrix-td-item hm-matrix-td-item--tf">الإجمالي</td>
                            <td className="hm-matrix-td-cell"></td>
                            {custMatrixTotals.colTotals.map((col, i) => (
                              <td key={i} className="hm-matrix-td-total">
                                {custMatrixMetrics.qty && <span className="hm-matrix-qty">{fmt(col.qty)}</span>}
                                {custMatrixMetrics.returns && col.returns > 0 && <span className="hm-matrix-ret">↩{fmt(col.returns)}</span>}
                                {custMatrixMetrics.revenue && col.revenue > 0 && <span className="hm-matrix-rev">{fmt(col.revenue)} ر.س</span>}
                              </td>
                            ))}
                            <td className="hm-matrix-td-total hm-matrix-td-grand">
                              {custMatrixMetrics.qty && <span className="hm-matrix-qty">{fmt(custMatrixTotals.grandTotal.qty)}</span>}
                              {custMatrixMetrics.returns && custMatrixTotals.grandTotal.returns > 0 && <span className="hm-matrix-ret">↩{fmt(custMatrixTotals.grandTotal.returns)}</span>}
                              {custMatrixMetrics.revenue && custMatrixTotals.grandTotal.revenue > 0 && <span className="hm-matrix-rev">{fmt(custMatrixTotals.grandTotal.revenue)} ر.س</span>}
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Items — monthly sales/returns by item
          ══════════════════════════════════════════════ */}
          {activeTab === 'items' && (
            <div className="hm-tab-content">
              <div className="hm-cust-meta">
                <span>إجمالي الأصناف: <strong>{fmt(d.by_item.length)}</strong></span>
                <span>إجمالي الكمية: <strong>{fmt(cur?.total_qty)}</strong></span>
                <span>إجمالي المرتجعات: <strong>{fmt(cur?.total_returns)}</strong></span>
              </div>

              <div className="hm-twin-grid">
                <div className="hm-card">
                  <div className="hm-card__title">🏆 أهم الأصناف مبيعاً (أعلى 10)</div>
                  <HBar rows={topItems} valueKey="total_qty" labelKey="item_name" colorClass="hm-bar--primary" />
                </div>
                <div className="hm-card">
                  <div className="hm-card__title">⚠️ أقل الأصناف مبيعاً (أدنى 10)</div>
                  <HBar rows={bottomItems} valueKey="total_qty" labelKey="item_name" colorClass="hm-bar--danger" />
                </div>
              </div>

              {/* ── Same cards again, but summing the whole period (every
                   year present) instead of just the selected month ── */}
              {isItemOverviewLoading && (
                <div className="hm-loading"><div className="hm-spinner"/><span>جاري التحميل…</span></div>
              )}
              {isItemOverviewError && !isItemOverviewLoading && (
                <div className="hm-error">حدث خطأ في تحميل إجمالي الأصناف لكامل الفترة.</div>
              )}
              {itemOverview && !isItemOverviewLoading && (
                <div className="hm-twin-grid">
                  <div className="hm-card">
                    <div className="hm-card__title">🏆 أهم الأصناف مبيعاً (كامل الفترة — أعلى 10)</div>
                    <HBar rows={topItemsAllTime} valueKey="total_qty" labelKey="item_name" colorClass="hm-bar--primary" />
                  </div>
                  <div className="hm-card">
                    <div className="hm-card__title">⚠️ أقل الأصناف مبيعاً (كامل الفترة — أدنى 10)</div>
                    <HBar rows={bottomItemsAllTime} valueKey="total_qty" labelKey="item_name" colorClass="hm-bar--danger" />
                  </div>
                </div>
              )}

              <div className="hm-table-wrap">
                <table className="hm-table">
                  <thead>
                    <tr>
                      <th style={{width:32}}>#</th>
                      <th>الصنف</th>
                      <th>الفئة</th>
                      <Th col="total_qty"      sortCol={itemSort.col} sortDir={itemSort.dir} onSort={handleItemSort}>الكمية</Th>
                      <Th col="prev_qty"       sortCol={itemSort.col} sortDir={itemSort.dir} onSort={handleItemSort}>الشهر الماضي</Th>
                      <th>الانحراف</th>
                      <Th col="total_returns"  sortCol={itemSort.col} sortDir={itemSort.dir} onSort={handleItemSort}>المرتجعات</Th>
                      <Th col="returns_pct"    sortCol={itemSort.col} sortDir={itemSort.dir} onSort={handleItemSort}>نسبة المرتجعات</Th>
                      <Th col="invoice_count"  sortCol={itemSort.col} sortDir={itemSort.dir} onSort={handleItemSort}>الفواتير</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedItems.map((it, i) => {
                      const dv = it.prev_qty > 0 ? +((it.total_qty - it.prev_qty) / it.prev_qty * 100).toFixed(1) : null;
                      return (
                        <tr key={`${it.item_name}-${it.item_category}`}
                            className={it.total_qty <= 0 ? 'hm-tr--inactive' : ''}>
                          <td className="hm-td-rank">{i + 1}</td>
                          <td className="hm-td-name">{it.item_name}</td>
                          <td className="hm-td-muted" style={{fontSize:'0.74rem'}}>{it.item_category}</td>
                          <td className={`hm-td-num${it.total_qty <= 0 ? ' hm-td-muted' : ' hm-td-bold'}`}>{fmt(it.total_qty)}</td>
                          <td className="hm-td-num hm-td-muted">{fmt(it.prev_qty)}</td>
                          <td className="hm-td-num"><Dev pct={dv} size="sm" /></td>
                          <td className="hm-td-num">
                            {it.total_returns > 0
                              ? <span className="hm-ret-badge">{fmt(it.total_returns)}</span>
                              : <span className="hm-dash">—</span>}
                          </td>
                          <td className="hm-td-num">
                            {it.returns_pct > 0
                              ? <span className={`hm-ret-pct${it.returns_pct >= 30 ? ' hm-ret-pct--high' : ''}`}>{it.returns_pct}%</span>
                              : <span className="hm-dash">—</span>}
                          </td>
                          <td className="hm-td-num hm-td-muted">{fmt(it.invoice_count)}</td>
                        </tr>
                      );
                    })}
                    {sortedItems.length === 0 && (
                      <tr><td colSpan={9} className="hm-empty">لا توجد بيانات</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* ── Monthly matrix: qty & returns per item, whole year ── */}
              <div className="hm-card" style={{marginTop: 4}}>
                <div className="hm-card__title">
                  مصفوفة الأداء الشهري للأصناف — {year} (أعلى {itemMatrix?.items?.length || 0} صنفاً حسب الكمية السنوية)
                </div>
                {isMatrixLoading && (
                  <div className="hm-loading"><div className="hm-spinner"/><span>جاري التحميل…</span></div>
                )}
                {isMatrixError && !isMatrixLoading && (
                  <div className="hm-error">حدث خطأ في تحميل المصفوفة.</div>
                )}
                {itemMatrix && !isMatrixLoading && (
                  <div className="hm-matrix-wrap">
                    <table className="hm-matrix-table">
                      <thead>
                        <tr>
                          <th className="hm-matrix-th-item">الصنف</th>
                          {Object.entries(itemMatrix.month_names).map(([mn, ml]) => (
                            <th key={mn} className="hm-matrix-th-month">{ml}</th>
                          ))}
                          <th className="hm-matrix-th-total">الإجمالي</th>
                        </tr>
                      </thead>
                      <tbody>
                        {itemMatrix.items.map(it => (
                          <tr key={it.item_name}>
                            <td className="hm-matrix-td-item" title={it.item_category}>{it.item_name}</td>
                            {it.months.map(mo => {
                              const intensity = itemMatrix.max_qty > 0 ? mo.qty / itemMatrix.max_qty : 0;
                              const bg = mo.qty > 0 ? `rgba(59,130,246,${0.08 + intensity * 0.55})` : 'transparent';
                              return (
                                <td key={mo.month} className="hm-matrix-td-cell" style={{ background: bg }}>
                                  {mo.qty > 0
                                    ? <span className="hm-matrix-qty">{fmt(mo.qty)}</span>
                                    : <span className="hm-matrix-dash">—</span>}
                                  {mo.returns > 0 && <span className="hm-matrix-ret">↩{fmt(mo.returns)}</span>}
                                </td>
                              );
                            })}
                            <td className="hm-matrix-td-total">
                              <span className="hm-matrix-qty">{fmt(it.annual_qty)}</span>
                              {it.annual_returns > 0 && <span className="hm-matrix-ret">↩{fmt(it.annual_returns)}</span>}
                            </td>
                          </tr>
                        ))}
                        {(!itemMatrix.items || itemMatrix.items.length === 0) && (
                          <tr><td colSpan={14} className="hm-empty">لا توجد بيانات</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
