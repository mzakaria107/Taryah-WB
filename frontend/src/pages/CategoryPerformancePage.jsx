import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './CategoryPerformancePage.css';

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
  return Number(n).toLocaleString('en-SA', { maximumFractionDigits: dec });
}

/* ── Deviation badge ──────────────────────────────────────── */
function Dev({ pct, invert = false, size = 'md' }) {
  if (pct == null) return null;
  const positive = invert ? pct < 0 : pct > 0;
  const neutral  = pct === 0;
  const cls = neutral ? 'cp-dev--flat' : positive ? 'cp-dev--up' : 'cp-dev--down';
  const arrow = neutral ? '→' : positive ? '↑' : '↓';
  return (
    <span className={`cp-dev cp-dev--${size} ${cls}`}>
      {arrow} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/* ── KPI Card ─────────────────────────────────────────────── */
function KpiCard({ icon, label, value, sub, deviation, invertDev = false, accent, big = false }) {
  return (
    <div className={`cp-kpi${accent ? ` cp-kpi--${accent}` : ''}${big ? ' cp-kpi--big' : ''}`}>
      {icon && <span className="cp-kpi__icon">{icon}</span>}
      <div className="cp-kpi__body">
        <div className="cp-kpi__label">{label}</div>
        <div className="cp-kpi__value">{value}</div>
        {sub && <div className="cp-kpi__sub">{sub}</div>}
        {deviation != null && <Dev pct={deviation} invert={invertDev} size="sm" />}
      </div>
    </div>
  );
}

/* ── Trend Bar Chart ──────────────────────────────────────── */
function TrendChart({ trend, highlight, labelKey = 'month_name' }) {
  if (!trend?.length) return <div className="cp-empty">لا توجد بيانات</div>;
  const maxQty = Math.max(...trend.map(t => t.total_qty), 1);

  return (
    <div className="cp-trend">
      <div className="cp-trend__cols">
        {trend.map((t, i) => {
          const isHL = highlight != null && t.month_num === highlight;
          const qtyPct = (t.total_qty / maxQty * 100).toFixed(1);
          const retPct = (t.total_returns / maxQty * 100).toFixed(1);
          return (
            <div key={i} className={`cp-trend__col${isHL ? ' cp-trend__col--active' : ''}`}>
              <div className="cp-trend__bars">
                <div className="cp-trend__bar-wrap" title={`كمية: ${fmt(t.total_qty)}`}>
                  <div className="cp-trend__bar cp-trend__bar--qty"
                       style={{ height: `${qtyPct}%` }} />
                </div>
                <div className="cp-trend__bar-wrap" title={`مرتجعات: ${fmt(t.total_returns)}`}>
                  <div className="cp-trend__bar cp-trend__bar--ret"
                       style={{ height: `${retPct}%` }} />
                </div>
              </div>
              <div className="cp-trend__label">{t[labelKey]}</div>
              <div className="cp-trend__qty">{fmt(t.total_qty)}</div>
              {t.total_returns > 0 && (
                <div className="cp-trend__ret">↩{fmt(t.total_returns)}</div>
              )}
            </div>
          );
        })}
      </div>
      <div className="cp-trend__legend">
        <span className="cp-trend__legend-item cp-trend__legend-item--qty">■ كمية المبيعات</span>
        <span className="cp-trend__legend-item cp-trend__legend-item--ret">■ المرتجعات</span>
      </div>
    </div>
  );
}

/* ── Horizontal bar ──────────────────────────────────────── */
function HBar({ rows, valueKey, labelKey, colorClass = 'cp-bar--primary', maxBars = 12 }) {
  const capped = rows.slice(0, maxBars);
  const max    = Math.max(...capped.map(r => Number(r[valueKey]) || 0), 1);
  return (
    <div className="cp-hbar">
      {capped.map((r, i) => {
        const val = Number(r[valueKey]) || 0;
        const w   = (val / max * 100).toFixed(1);
        return (
          <div key={i} className="cp-hbar__row">
            <span className="cp-hbar__label" title={r[labelKey]}>{r[labelKey]}</span>
            <div className="cp-hbar__track">
              <div className={`cp-hbar__fill ${colorClass}`} style={{ width: `${w}%` }} />
            </div>
            <span className="cp-hbar__val">{fmt(val)}</span>
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
    <th className={`cp-th${active ? ' cp-th--sorted' : ''}`} onClick={() => onSort(col)}>
      {children}
      <span className={`cp-sort${active ? ' cp-sort--active' : ''}`}>
        {active ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ' ⇅'}
      </span>
    </th>
  );
}

/* ── Generic multi-select dropdown ──────────────────────────── */
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
    if (has && selected.length === 1) return;
    const next = has ? selected.filter(x => x !== v) : [...selected, v];
    onChange(next.sort((a, b) => a - b));
  };

  const singleLabel = options.find(o => o.value === selected[0])?.label ?? selected[0];
  const label = selected.length > 1 ? multiLabel(selected.length) : String(singleLabel);

  return (
    <div className="cp-year-ms" ref={ref}>
      <button type="button" className="cp-year-ms__btn" onClick={() => setOpen(o => !o)}>
        {label} <span className="cp-year-ms__caret">▾</span>
      </button>
      {open && (
        <div className="cp-year-ms__panel">
          {options.map(o => (
            <label key={o.value} className="cp-year-ms__opt">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Customer search box + results ─────────────────────────── */
function CustomerSearchBox({ onSelect }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const { data } = useQuery({
    queryKey: ['cp-customer-search', q],
    queryFn: () => client.get('/category-performance/customer-search', { params: { q } }).then(r => r.data),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });

  const results = data?.results || [];

  return (
    <div className="cp-search-group" ref={ref}>
      <input
        type="text"
        className="cp-search-input"
        placeholder="ابحث باسم العميل أو رقمه…"
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && q.trim().length >= 2 && (
        <div className="cp-search-results">
          {results.length === 0 ? (
            <div className="cp-search-empty">لا توجد نتائج</div>
          ) : (
            results.map(r => (
              <div
                key={r.customer_code}
                className="cp-search-result"
                onClick={() => { onSelect(r.customer_code); setOpen(false); setQ(''); }}
              >
                <span className="cp-search-result__name">{r.customer_name}</span>
                <span className="cp-search-result__meta">{r.customer_code} · {r.branch_name || '—'}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ── Customer performance panel (modal) ──────────────────────
   Full annual performance for a single customer, across ALL
   categories — independent of the page's selected category filter. */
function CustomerPerformancePanel({ customerCode, onClose }) {
  const [panelYear, setPanelYear] = useState(currentYear);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['cp-customer-detail', customerCode, panelYear],
    queryFn: () => client.get(`/category-performance/customer/${encodeURIComponent(customerCode)}`, {
      params: { year: panelYear },
    }).then(r => r.data),
    enabled: !!customerCode,
    staleTime: 60_000,
  });

  return (
    <div className="cp-cust-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="cp-cust-panel">
        <div className="cp-cust-panel__header">
          <div>
            <div className="cp-cust-panel__title">
              {isLoading ? 'جارٍ التحميل…' : data?.customer?.customer_name || '—'}
            </div>
            {data?.customer && (
              <div className="cp-cust-panel__sub">
                {data.customer.customer_code} · {data.customer.branch_name || '—'} · {data.customer.salesrep_name || '—'}
              </div>
            )}
          </div>
          <button className="cp-cust-panel__close" onClick={onClose}>✕</button>
        </div>

        {isError && <div className="cp-error">تعذّر تحميل بيانات العميل.</div>}

        {data && (
          <>
            <div className="cp-cust-panel__year">
              <label>السنة</label>
              <select value={panelYear} onChange={e => setPanelYear(Number(e.target.value))}>
                {(data.available_years?.length ? data.available_years : [currentYear]).map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>

            <div className="cp-kpi-row">
              <KpiCard icon="📦" accent="blue" label="إجمالي الكمية" value={fmt(data.totals.total_qty)} />
              <KpiCard icon="↩️" accent="orange" label="المرتجعات" value={fmt(data.totals.total_returns)}
                sub={`نسبة المرتجعات: ${fmt(data.totals.returns_pct, 1)}%`} />
              <KpiCard icon="💰" accent="green" label="صافي الإيرادات" value={`${fmt(data.totals.net_revenue)} ر.س`} />
            </div>

            <div className="cp-card">
              <div className="cp-card__title">الأداء الشهري — {panelYear}</div>
              <TrendChart trend={data.months} highlight={new Date().getFullYear() === panelYear ? (new Date().getMonth() + 1) : null} />
            </div>

            {data.by_category?.length > 0 && (
              <div className="cp-table-wrap">
                <table className="cp-table">
                  <thead>
                    <tr>
                      <th>فئة العميل</th>
                      <th>الكمية</th>
                      <th>المرتجعات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_category.map(c => (
                      <tr key={c.category_name}>
                        <td className="cp-td-name">{c.category_name}</td>
                        <td className="cp-td-num cp-td-bold">{fmt(c.total_qty)}</td>
                        <td className="cp-td-num">{c.total_returns > 0 ? fmt(c.total_returns) : <span className="cp-dash">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   Main Page
═══════════════════════════════════════════════════════════ */
export default function CategoryPerformancePage() {
  const { user } = useAuth();
  const isAdmin  = user && ADMIN_ROLES.includes(user.role);
  const qc = useQueryClient();

  /* ── Category filter — empty string = "الكل" (all categories) ── */
  const { data: categoriesData } = useQuery({
    queryKey: ['cp-categories'],
    queryFn: () => client.get('/category-performance/categories').then(r => r.data),
    staleTime: 10 * 60 * 1000,
  });
  const categories = categoriesData?.categories || [];
  const categoriesLoaded = categoriesData !== undefined;
  const [category, setCategory] = useState('');
  const categoryLabel = category || 'الكل';
  const didInitCategory = useRef(false);
  useEffect(() => {
    if (!didInitCategory.current && categories.length) {
      didInitCategory.current = true;
      setCategory(categories[0]);
    }
  }, [categories]);

  /* ── Customer search / detail panel ──────────────────────── */
  const [selectedCustomerCode, setSelectedCustomerCode] = useState(null);

  /* ── Admin insight note — per selected category ──────────── */
  const insightKey = categoriesLoaded ? `category_performance_insight_note_${category || 'all'}` : null;
  const { data: insightNoteData } = useQuery({
    queryKey: ['cp-insight-note', insightKey],
    queryFn: () => client.get(`/settings/${insightKey}`).then(r => r.data.value || ''),
    enabled: !!insightKey,
    staleTime: 60 * 1000,
  });
  const [insightNoteDraft, setInsightNoteDraft] = useState(null);
  const [insightNoteSaving, setInsightNoteSaving] = useState(false);
  const insightNoteText = insightNoteDraft !== null ? insightNoteDraft : (insightNoteData || '');

  const saveInsightNote = async () => {
    if (!insightKey) return;
    setInsightNoteSaving(true);
    try {
      await client.put(`/settings/${insightKey}`, { value: insightNoteText });
      qc.invalidateQueries(['cp-insight-note', insightKey]);
      setInsightNoteDraft(null);
    } catch {
      // keep draft
    } finally {
      setInsightNoteSaving(false);
    }
  };

  const [selectedYears, setSelectedYears] = useState([currentYear]);
  const year = selectedYears[0];
  const yearsLabel = selectedYears.length > 1 ? [...selectedYears].sort((a,b)=>a-b).join('، ') : String(year);

  const [selectedMonths, setSelectedMonths] = useState([currentMonth]);
  const month = selectedMonths[0];
  const primaryMonthName = MONTHS.find(m => m[0] === month)?.[1] || '';
  const monthsLabel = selectedMonths.length > 1
    ? [...selectedMonths].sort((a,b)=>a-b).map(m => MONTHS.find(x => x[0] === m)?.[1] || m).join('، ')
    : primaryMonthName;

  const [branchName, setBranchName] = useState('');
  const [repName,    setRepName]    = useState('');
  const [activeTab,  setActiveTab]  = useState('general');

  const [repSort, setRepSort]       = useState({ col: 'total_qty', dir: 'desc' });
  const [custSort, setCustSort]     = useState({ col: 'total_qty', dir: 'desc' });
  const [itemSort, setItemSort]     = useState({ col: 'total_qty', dir: 'desc' });

  const handleRepSort  = useCallback(col => setRepSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);
  const handleCustSort = useCallback(col => setCustSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);
  const handleItemSort = useCallback(col => setItemSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);

  const [custMatrixMetrics, setCustMatrixMetrics] = useState({ qty: true, returns: true, revenue: true });
  const toggleCustMatrixMetric = useCallback((key) => {
    setCustMatrixMetrics(prev => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.qty && !next.returns && !next.revenue) next.qty = true;
      return next;
    });
  }, []);

  const [regionMatrixMetrics, setRegionMatrixMetrics] = useState({ qty: true, returns: true, revenue: true });
  const toggleRegionMatrixMetric = useCallback((key) => {
    setRegionMatrixMetrics(prev => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.qty && !next.returns && !next.revenue) next.qty = true;
      return next;
    });
  }, []);

  /* ── Filters query ─────────────────────────────────────── */
  const { data: filters } = useQuery({
    queryKey: ['cp-filters', category, year],
    queryFn: () => client.get('/category-performance/filters', { params: { category, year } }).then(r => r.data),
    enabled: categoriesLoaded,
    staleTime: 5 * 60 * 1000,
  });

  const repOptions = useMemo(() => {
    if (!filters?.reps) return [];
    return branchName ? filters.reps.filter(r => r.branch === branchName) : filters.reps;
  }, [filters, branchName]);

  /* ── Main data query ───────────────────────────────────── */
  const params = new URLSearchParams({ category, years: selectedYears.join(','), months: selectedMonths.join(',') });
  if (branchName) params.set('branch_name', branchName);
  if (repName)    params.set('salesrep_name', repName);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['cp-summary', category, selectedYears.join(','), selectedMonths.join(','), branchName, repName],
    queryFn:  () => client.get(`/category-performance/summary?${params}`).then(r => r.data),
    enabled: categoriesLoaded,
    staleTime: 2 * 60 * 1000,
  });

  /* ── Overview (whole-period) query ─────────────────────── */
  const overviewParams = new URLSearchParams({ category });
  if (branchName) overviewParams.set('branch_name', branchName);
  if (repName)    overviewParams.set('salesrep_name', repName);

  const { data: overview, isLoading: isOverviewLoading, isError: isOverviewError } = useQuery({
    queryKey: ['cp-overview', category, branchName, repName],
    queryFn:  () => client.get(`/category-performance/overview?${overviewParams}`).then(r => r.data),
    enabled: categoriesLoaded,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Item matrix ────────────────────────────────────────── */
  const matrixParams = new URLSearchParams({ category, year });
  if (branchName) matrixParams.set('branch_name', branchName);
  if (repName)    matrixParams.set('salesrep_name', repName);

  const { data: itemMatrix, isLoading: isMatrixLoading, isError: isMatrixError } = useQuery({
    queryKey: ['cp-item-matrix', category, year, branchName, repName],
    queryFn:  () => client.get(`/category-performance/item-matrix?${matrixParams}`).then(r => r.data),
    enabled: categoriesLoaded,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Item totals — whole period ────────────────────────── */
  const itemOverviewParams = new URLSearchParams({ category });
  if (branchName) itemOverviewParams.set('branch_name', branchName);
  if (repName)    itemOverviewParams.set('salesrep_name', repName);

  const { data: itemOverview, isLoading: isItemOverviewLoading, isError: isItemOverviewError } = useQuery({
    queryKey: ['cp-item-overview', category, branchName, repName],
    queryFn:  () => client.get(`/category-performance/item-overview?${itemOverviewParams}`).then(r => r.data),
    enabled: categoriesLoaded,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Customer matrix — whole period ────────────────────── */
  const custMatrixParams = new URLSearchParams({ category });
  if (branchName) custMatrixParams.set('branch_name', branchName);
  if (repName)    custMatrixParams.set('salesrep_name', repName);

  const { data: custMatrix, isLoading: isCustMatrixLoading, isError: isCustMatrixError } = useQuery({
    queryKey: ['cp-customer-matrix', category, branchName, repName],
    queryFn:  () => client.get(`/category-performance/customer-matrix?${custMatrixParams}`).then(r => r.data),
    enabled: categoriesLoaded,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Sorted reps / customers / items ───────────────────── */
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
    return [...data.by_item].filter(it => it.total_qty > 0).sort((a, b) => a.total_qty - b.total_qty).slice(0, 10);
  }, [data]);

  const topItemsAllTime = useMemo(() => {
    if (!itemOverview?.items) return [];
    return [...itemOverview.items].sort((a, b) => b.total_qty - a.total_qty).slice(0, 10);
  }, [itemOverview]);

  const bottomItemsAllTime = useMemo(() => {
    if (!itemOverview?.items) return [];
    return [...itemOverview.items].filter(it => it.total_qty > 0).sort((a, b) => a.total_qty - b.total_qty).slice(0, 10);
  }, [itemOverview]);

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
    const zeroCell = () => ({ total_qty: 0, total_returns: 0, net_revenue: 0 });

    const branchTotals = {};
    const cellByBranchMonth = {};
    const colTotals = Array.from({ length: 12 }, zeroCell);
    const grandTotal = zeroCell();
    let maxQty = 1;

    overview.branch_month_matrix.forEach(c => {
      cellByBranchMonth[`${c.branch_name}-${c.month_num}`] = c;
      if (c.total_qty > maxQty) maxQty = c.total_qty;

      if (!branchTotals[c.branch_name]) branchTotals[c.branch_name] = zeroCell();
      branchTotals[c.branch_name].total_qty     += c.total_qty;
      branchTotals[c.branch_name].total_returns += c.total_returns;
      branchTotals[c.branch_name].net_revenue   += c.net_revenue;

      const col = colTotals[c.month_num - 1];
      col.total_qty     += c.total_qty;
      col.total_returns += c.total_returns;
      col.net_revenue   += c.net_revenue;

      grandTotal.total_qty     += c.total_qty;
      grandTotal.total_returns += c.total_returns;
      grandTotal.net_revenue   += c.net_revenue;
    });

    const branches = Object.keys(branchTotals).sort((a, b) => branchTotals[b].total_qty - branchTotals[a].total_qty);
    return { branches, cellByBranchMonth, branchTotals, colTotals, grandTotal, maxQty };
  }, [overview]);

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

  const d    = data;
  const cur  = d?.cur;
  const prev = d?.prev;
  const dev  = d?.deviation;

  function handlePrint() {
    const prevTitle = document.title;
    document.title = `${categoryLabel} — ${monthsLabel} ${yearsLabel}`;
    window.print();
    window.onafterprint = () => { document.title = prevTitle; };
  }

  /* ── Excel export ─────────────────────────────────────────── */
  const handleExport = useCallback(() => {
    if (!data) return;
    const wb = XLSX.utils.book_new();

    const kpiRows = [
      ['التقرير', `${categoryLabel} — ${monthsLabel} ${yearsLabel}`],
      ['المنطقة', branchName || 'جميع المناطق'],
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

    const custHeader = ['كود العميل', 'اسم العميل', 'المنطقة', 'المندوب', 'الكمية', 'المرتجعات', 'نسبة المرتجعات %', 'عدد الفواتير'];
    const custRows = [...(data.customers || [])].sort((a, b) => b.total_qty - a.total_qty).map(c => [
      c.customer_code, c.customer_name, c.branch_name || '', c.salesrep_name || '',
      Number(c.total_qty) || 0, Number(c.total_returns) || 0, Number(c.returns_pct) || 0, Number(c.invoice_count) || 0,
    ]);
    const ws4 = XLSX.utils.aoa_to_sheet([custHeader, ...custRows]);
    ws4['!cols'] = [{ wch: 14 }, { wch: 28 }, { wch: 16 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws4, 'العملاء');

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

    if (overview) {
      const ovRows = [
        ['الفترة', `${overview.period.from_year} — ${overview.period.to_year}`],
        ['إجمالي الكمية', overview.totals.total_qty],
        ['إجمالي المرتجعات', overview.totals.total_returns],
        ['نسبة المرتجعات %', overview.totals.returns_pct],
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
    XLSX.writeFile(wb, `${categoryLabel}_${monthsLabel.replace(/[،\s]+/g, '-')}_${yearsLabel.replace(/[،\s]+/g, '-')}_${today}.xlsx`);
  }, [data, overview, categoryLabel, monthName, prevMonthName, monthsLabel, yearsLabel, branchName, repName, cur, prev, dev]);

  function CmpRow({ label, curVal, prevVal, pct, invert = false }) {
    return (
      <div className="cp-cmp-row">
        <span className="cp-cmp-label">{label}</span>
        <span className="cp-cmp-cur">{curVal}</span>
        <span className="cp-cmp-prev">{prevVal}</span>
        <span className="cp-cmp-dev"><Dev pct={pct} invert={invert} size="sm" /></span>
      </div>
    );
  }

  return (
    <div className="cp-page">

      {/* ── Print header ─────────────────────────────────── */}
      <div className="cp-print-header">
        <div className="cp-print-logo">📊 تقرير أداء فئة العملاء — {categoryLabel}</div>
        <div className="cp-print-sub">{monthsLabel} {yearsLabel}{branchName ? ` · ${branchName}` : ''}{repName ? ` · ${repName}` : ''}</div>
      </div>

      {/* ── Page header ──────────────────────────────────── */}
      <div className="cp-header cp-no-print">
        <div className="cp-header__left">
          <span className="cp-header__icon">📊</span>
          <div>
            <div className="cp-header__title">أداء فئات العملاء</div>
            <div className="cp-header__sub">تقرير أداء مبيعات ومرتجعات عام حسب فئة العميل، مع بحث بأداء عميل محدد</div>
          </div>
        </div>
        <div className="cp-header__actions">
          <button className="cp-btn cp-btn--outline" onClick={handleExport} disabled={!data}>📊 تصدير Excel</button>
          <button className="cp-btn cp-btn--outline" onClick={handlePrint}>🖨️ طباعة</button>
        </div>
      </div>

      {/* ── Filters ──────────────────────────────────────── */}
      <div className="cp-filters cp-no-print">
        <div className="cp-filter-group">
          <label>فئة العميل</label>
          <select value={category} onChange={e => { setCategory(e.target.value); setBranchName(''); setRepName(''); }}>
            <option value="">الكل</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="cp-filter-group">
          <label>السنة</label>
          <MultiSelectDropdown
            options={YEARS.map(y => ({ value: y, label: y }))}
            selected={selectedYears} onChange={setSelectedYears}
            multiLabel={n => `${n} سنوات`} />
        </div>
        <div className="cp-filter-group">
          <label>الشهر</label>
          <MultiSelectDropdown
            options={MONTHS.map(([v, l]) => ({ value: v, label: l }))}
            selected={selectedMonths} onChange={setSelectedMonths}
            multiLabel={n => `${n} أشهر`} />
        </div>
        <div className="cp-filter-group">
          <label>المنطقة</label>
          <select value={branchName} onChange={e => { setBranchName(e.target.value); setRepName(''); }}>
            <option value="">جميع المناطق</option>
            {(filters?.branches || []).map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div className="cp-filter-group">
          <label>المندوب</label>
          <select value={repName} onChange={e => setRepName(e.target.value)}>
            <option value="">جميع المناديب</option>
            {repOptions.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
          </select>
        </div>
        <div className="cp-filter-group">
          <label>بحث عن عميل</label>
          <CustomerSearchBox onSelect={setSelectedCustomerCode} />
        </div>
        {(branchName || repName) && (
          <button className="cp-btn cp-btn--ghost" onClick={() => { setBranchName(''); setRepName(''); }}>
            ✕ إعادة تعيين
          </button>
        )}
      </div>

      {selectedCustomerCode && (
        <CustomerPerformancePanel customerCode={selectedCustomerCode} onClose={() => setSelectedCustomerCode(null)} />
      )}

      {/* ── Loading / Error ─────────────────────────────── */}
      {(isLoading || !categoriesLoaded) && (
        <div className="cp-loading"><div className="cp-spinner"/><span>جاري التحميل…</span></div>
      )}
      {isError && !isLoading && (
        <div className="cp-error">حدث خطأ في تحميل البيانات — يرجى المحاولة مجدداً.</div>
      )}

      {d && !isLoading && (
        <>
          {/* ── Period badge ──────────────────────────────── */}
          <div className="cp-period">
            <span className="cp-period__cur">{monthsLabel} {yearsLabel}</span>
            <span className="cp-period__vs">مقارنةً بـ</span>
            <span className="cp-period__prev">{prevMonthName}</span>
            <span className="cp-period__wd">· أيام العمل: {d.meta.working_days_cur}</span>
          </div>

          {/* ══════════════════════════════════════════════
              KPI ROW 1 — Sales Performance
          ══════════════════════════════════════════════ */}
          <div className="cp-section-title">مؤشرات المبيعات</div>
          <div className="cp-kpi-row">
            <KpiCard big icon="📦" accent="blue" label="إجمالي الكمية"
              value={fmt(cur?.total_qty)} sub={`الشهر الماضي: ${fmt(prev?.total_qty)}`} deviation={dev?.qty_pct} />
            <KpiCard big icon="📅" accent="blue" label="المتوسط اليومي"
              value={fmt(cur?.daily_avg, 1)} sub={`الشهر الماضي: ${fmt(prev?.daily_avg, 1)}`} deviation={dev?.daily_avg_pct} />
            <KpiCard big icon="🏪" accent="purple" label="متوسط الكمية / عميل"
              value={fmt(cur?.avg_per_customer, 1)} sub={`${fmt(cur?.active_customers)} عميل نشط`} />
            <KpiCard big icon="↩️" accent="orange" label="نسبة المرتجعات"
              value={`${fmt(cur?.returns_pct, 1)}%`}
              sub={`الكمية: ${fmt(cur?.total_returns)} · الشهر الماضي: ${fmt(prev?.returns_pct, 1)}%`}
              deviation={dev?.returns_delta} invertDev />
          </div>

          {/* ══════════════════════════════════════════════
              KPI ROW 2 — Customer Movement
          ══════════════════════════════════════════════ */}
          <div className="cp-section-title">حركة العملاء</div>
          <div className="cp-kpi-row">
            <KpiCard icon="✅" accent="green" label="العملاء المتعاملون"
              value={fmt(cur?.active_customers)} sub={`الشهر الماضي: ${fmt(prev?.active_customers)}`} deviation={dev?.customers_pct} />
            <KpiCard icon="🆕" accent="blue" label="عملاء جدد"
              value={fmt(cur?.new_customers)} sub={`أول ظهور في ${monthsLabel}`} />
            <KpiCard icon="⛔" accent="red" label="عملاء متوقفون"
              value={fmt(cur?.stopped_customers)} sub={`كانوا نشطين في ${prevMonthName}`} />
            <KpiCard icon="⚪" accent="muted" label="كمية صفر أو سالبة"
              value={fmt(cur?.inactive_customers)} sub="لديهم فواتير بكمية ≤ 0" />
          </div>

          {/* ══════════════════════════════════════════════
              Trend Chart + Comparison Table
          ══════════════════════════════════════════════ */}
          <div className="cp-section-title">الاتجاه الشهري — {yearsLabel}</div>
          <div className="cp-twin-grid">
            <div className="cp-card">
              <div className="cp-card__title">مقارنة المبيعات والمرتجعات شهرياً</div>
              <TrendChart trend={d.trend} highlight={month} />
            </div>

            <div className="cp-card">
              <div className="cp-card__title">المقارنة الشهرية — {monthName} vs {prevMonthName}</div>
              <div className="cp-cmp">
                <div className="cp-cmp-head">
                  <span></span><span>{monthName}</span><span>{prevMonthName}</span><span>الانحراف</span>
                </div>
                <CmpRow label="إجمالي الكمية" curVal={fmt(cur?.total_qty)} prevVal={fmt(prev?.total_qty)} pct={dev?.qty_pct} />
                <CmpRow label="المتوسط اليومي" curVal={fmt(cur?.daily_avg, 1)} prevVal={fmt(prev?.daily_avg, 1)} pct={dev?.daily_avg_pct} />
                <CmpRow label="المرتجعات" curVal={fmt(cur?.total_returns)} prevVal={fmt(prev?.total_returns)}
                  pct={cur?.total_returns != null && prev?.total_returns != null && prev.total_returns > 0
                    ? +((cur.total_returns - prev.total_returns) / prev.total_returns * 100).toFixed(1) : null}
                  invert />
                <CmpRow label="نسبة المرتجعات %" curVal={`${fmt(cur?.returns_pct, 1)}%`} prevVal={`${fmt(prev?.returns_pct, 1)}%`}
                  pct={dev?.returns_delta} invert />
                <CmpRow label="العملاء النشطون" curVal={fmt(cur?.active_customers)} prevVal={fmt(prev?.active_customers)} pct={dev?.customers_pct} />
              </div>

              {dev?.qty_pct != null && (
                <div className={`cp-achievement${dev.qty_pct >= 0 ? ' cp-achievement--pos' : ' cp-achievement--neg'}`}>
                  {dev.qty_pct >= 10  && '🚀 نمو ممتاز'}
                  {dev.qty_pct >= 0 && dev.qty_pct < 10 && '✅ أداء مستقر'}
                  {dev.qty_pct < 0 && dev.qty_pct >= -10 && '⚠️ تراجع طفيف'}
                  {dev.qty_pct < -10 && '🔴 تراجع ملحوظ — يحتاج متابعة'}
                  <span className="cp-achievement__num">{dev.qty_pct >= 0 ? '+' : ''}{dev.qty_pct}% عن الشهر الماضي</span>
                </div>
              )}
            </div>
          </div>

          {/* ══════════════════════════════════════════════
              Tabs
          ══════════════════════════════════════════════ */}
          <div className="cp-tabs cp-no-print">
            {[
              ['general',  'نظرة عامة'],
              ['regions',  'المناطق'],
              ['reps',     'المناديب'],
              ['customers','العملاء'],
              ['items',    'أداء الأصناف'],
            ].map(([k, l]) => (
              <button key={k} className={`cp-tab${activeTab === k ? ' cp-tab--active' : ''}`} onClick={() => setActiveTab(k)}>{l}</button>
            ))}
          </div>

          {/* ══════════════════════════════════════════════
              TAB: General overview
          ══════════════════════════════════════════════ */}
          {activeTab === 'general' && (
            <div className="cp-tab-content">
              {isOverviewLoading && (
                <div className="cp-loading"><div className="cp-spinner"/><span>جاري التحميل…</span></div>
              )}
              {isOverviewError && !isOverviewLoading && (
                <div className="cp-error">حدث خطأ في تحميل النظرة العامة.</div>
              )}
              {overview && !isOverviewLoading && (
                <>
                  <div className="cp-period">
                    <span className="cp-period__cur">كامل الفترة: {overview.period.from_year} — {overview.period.to_year}</span>
                    <span className="cp-period__wd">· {overview.period.months_count} شهر بيانات</span>
                  </div>

                  <div className="cp-kpi-row">
                    <KpiCard big icon="📦" accent="blue" label="إجمالي الكمية (كل الفترة)" value={fmt(overview.totals.total_qty)} />
                    <KpiCard big icon="↩️" accent="orange" label="إجمالي المرتجعات" value={fmt(overview.totals.total_returns)}
                      sub={`نسبة المرتجعات: ${fmt(overview.totals.returns_pct, 1)}%`} />
                    <KpiCard big icon="🧾" accent="purple" label="عدد الفواتير المدخلة" value={fmt(overview.totals.invoice_count)} />
                    <KpiCard big icon="✅" accent="green" label="العملاء المتعاملون" value={fmt(overview.totals.active_customers)} sub="عبر كامل الفترة" />
                    <KpiCard big icon="💰" accent="green" label="صافي الإيرادات (كل الفترة)" value={`${fmt(overview.totals.net_revenue)} ر.س`} />
                  </div>

                  {overview.best_branch && (
                    <div className="cp-best-branch">
                      <span className="cp-best-branch__crown">🏆</span>
                      <div className="cp-best-branch__body">
                        <div className="cp-best-branch__lbl">أفضل فرع أداءً</div>
                        <div className="cp-best-branch__name">{overview.best_branch.branch_name}</div>
                      </div>
                      <div className="cp-best-branch__stats">
                        <span><strong>{fmt(overview.best_branch.total_qty)}</strong> كمية</span>
                        <span><strong>{fmt(overview.best_branch.invoice_count)}</strong> فاتورة</span>
                        <span><strong>{fmt(overview.best_branch.active_customers)}</strong> عميل</span>
                      </div>
                    </div>
                  )}

                  {branchInsights && (
                    <div className="cp-card cp-insight-card">
                      <div className="cp-card__title">💡 Insight — نظرة سريعة</div>
                      <div className="cp-insight-grid">
                        <div className="cp-insight-item cp-insight-item--pos">
                          <span className="cp-insight-icon">📈</span>
                          <div>
                            <div className="cp-insight-lbl">أفضل فرع مبيعاً</div>
                            <div className="cp-insight-val">{branchInsights.bestSales.branch_name}</div>
                            <div className="cp-insight-sub">{fmt(branchInsights.bestSales.total_qty)} كمية</div>
                          </div>
                        </div>
                        <div className="cp-insight-item cp-insight-item--neg">
                          <span className="cp-insight-icon">📉</span>
                          <div>
                            <div className="cp-insight-lbl">أقل فرع مبيعاً</div>
                            <div className="cp-insight-val">{branchInsights.worstSales.branch_name}</div>
                            <div className="cp-insight-sub">{fmt(branchInsights.worstSales.total_qty)} كمية</div>
                          </div>
                        </div>
                        <div className="cp-insight-item cp-insight-item--neg">
                          <span className="cp-insight-icon">↩️</span>
                          <div>
                            <div className="cp-insight-lbl">أكثر فرع مرتجعات</div>
                            <div className="cp-insight-val">{branchInsights.mostReturns.branch_name}</div>
                            <div className="cp-insight-sub">{fmt(branchInsights.mostReturns.total_returns)} مرتجعات</div>
                          </div>
                        </div>
                        <div className="cp-insight-item cp-insight-item--pos">
                          <span className="cp-insight-icon">✅</span>
                          <div>
                            <div className="cp-insight-lbl">أقل فرع مرتجعات (توالف)</div>
                            <div className="cp-insight-val">{branchInsights.leastReturns.branch_name}</div>
                            <div className="cp-insight-sub">{fmt(branchInsights.leastReturns.total_returns)} مرتجعات</div>
                          </div>
                        </div>
                      </div>

                      <div className="cp-insight-note">
                        <div className="cp-insight-note__lbl">ملاحظة الإدارة</div>
                        {isAdmin ? (
                          <>
                            <textarea
                              className="cp-insight-note__input" rows={3}
                              placeholder="اكتب تعليقاً أو نقاطاً حول أداء هذه الفئة…"
                              value={insightNoteText}
                              onChange={e => setInsightNoteDraft(e.target.value)}
                            />
                            <div className="cp-insight-note__actions">
                              <button type="button" className="cp-btn cp-btn--outline"
                                disabled={insightNoteSaving || insightNoteDraft === null} onClick={saveInsightNote}>
                                {insightNoteSaving ? 'جارٍ الحفظ…' : '💾 حفظ الملاحظة'}
                              </button>
                              {insightNoteDraft !== null && (
                                <button type="button" className="cp-btn cp-btn--ghost" onClick={() => setInsightNoteDraft(null)}>إلغاء</button>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="cp-insight-note__readonly">
                            {insightNoteText ? insightNoteText : <span className="cp-dash">لا توجد ملاحظات بعد</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="cp-card">
                    <div className="cp-card__title">ترند الأداء الشهري لكامل الفترة — المبيعات والمرتجعات</div>
                    <TrendChart trend={overview.trend} labelKey="label" />
                  </div>

                  {overviewMatrix && (
                    <div className="cp-card">
                      <div className="cp-card__title cp-card__title--with-filters">
                        <span>مصفوفة الأداء الشهري لكامل الفترة حسب المنطقة — مبيعات ومرتجعات وإيرادات</span>
                        <span className="cp-metric-toggle">
                          <button type="button" className={`cp-metric-btn${regionMatrixMetrics.qty ? ' cp-metric-btn--active cp-metric-btn--qty' : ''}`}
                            onClick={() => toggleRegionMatrixMetric('qty')}>المبيعات</button>
                          <button type="button" className={`cp-metric-btn${regionMatrixMetrics.revenue ? ' cp-metric-btn--active cp-metric-btn--revenue' : ''}`}
                            onClick={() => toggleRegionMatrixMetric('revenue')}>الإيرادات</button>
                          <button type="button" className={`cp-metric-btn${regionMatrixMetrics.returns ? ' cp-metric-btn--active cp-metric-btn--returns' : ''}`}
                            onClick={() => toggleRegionMatrixMetric('returns')}>المرتجعات</button>
                        </span>
                      </div>
                      <div className="cp-matrix-wrap">
                        <table className="cp-matrix-table">
                          <thead>
                            <tr>
                              <th className="cp-matrix-th-item">المنطقة</th>
                              {MONTHS.map(([mn, ml]) => <th key={mn} className="cp-matrix-th-month">{ml}</th>)}
                              <th className="cp-matrix-th-total">الإجمالي</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overviewMatrix.branches.map(br => {
                              const rowTotal = overviewMatrix.branchTotals[br];
                              return (
                                <tr key={br}>
                                  <td className="cp-matrix-td-item">{br}</td>
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
                                      <td key={mn} className="cp-matrix-td-cell" style={{ background: bg }}>
                                        {showQty && <span className="cp-matrix-qty">{fmt(qty)}</span>}
                                        {showReturns && <span className="cp-matrix-ret">↩{fmt(returns)}</span>}
                                        {showRevenue && <span className="cp-matrix-rev">{fmt(revenue)} ر.س</span>}
                                        {!showQty && !showReturns && !showRevenue && <span className="cp-matrix-dash">—</span>}
                                      </td>
                                    );
                                  })}
                                  <td className="cp-matrix-td-total">
                                    {regionMatrixMetrics.qty && <span className="cp-matrix-qty">{fmt(rowTotal.total_qty)}</span>}
                                    {regionMatrixMetrics.returns && rowTotal.total_returns > 0 && <span className="cp-matrix-ret">↩{fmt(rowTotal.total_returns)}</span>}
                                    {regionMatrixMetrics.revenue && rowTotal.net_revenue > 0 && <span className="cp-matrix-rev">{fmt(rowTotal.net_revenue)} ر.س</span>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="cp-matrix-tf-row">
                              <td className="cp-matrix-td-item cp-matrix-td-item--tf">الإجمالي</td>
                              {overviewMatrix.colTotals.map((col, i) => (
                                <td key={i} className="cp-matrix-td-total">
                                  {regionMatrixMetrics.qty && <span className="cp-matrix-qty">{fmt(col.total_qty)}</span>}
                                  {regionMatrixMetrics.returns && col.total_returns > 0 && <span className="cp-matrix-ret">↩{fmt(col.total_returns)}</span>}
                                  {regionMatrixMetrics.revenue && col.net_revenue > 0 && <span className="cp-matrix-rev">{fmt(col.net_revenue)} ر.س</span>}
                                </td>
                              ))}
                              <td className="cp-matrix-td-total cp-matrix-td-grand">
                                {regionMatrixMetrics.qty && <span className="cp-matrix-qty">{fmt(overviewMatrix.grandTotal.total_qty)}</span>}
                                {regionMatrixMetrics.returns && overviewMatrix.grandTotal.total_returns > 0 && <span className="cp-matrix-ret">↩{fmt(overviewMatrix.grandTotal.total_returns)}</span>}
                                {regionMatrixMetrics.revenue && overviewMatrix.grandTotal.net_revenue > 0 && <span className="cp-matrix-rev">{fmt(overviewMatrix.grandTotal.net_revenue)} ر.س</span>}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  )}

                  <div className="cp-card">
                    <div className="cp-card__title">أفضل الفروع (مرتبة حسب الكمية)</div>
                    <HBar rows={overview.by_branch} valueKey="total_qty" labelKey="branch_name" colorClass="cp-bar--primary" />
                  </div>

                  <div className="cp-table-wrap">
                    {(() => {
                      const grandQty = overview.by_branch.reduce((s, b) => s + Number(b.total_qty || 0), 0);
                      return (
                        <table className="cp-table">
                          <thead>
                            <tr>
                              <th style={{width:32}}>#</th>
                              <th>الفرع</th><th>الكمية</th><th>نسبة الحصة</th><th>العملاء</th>
                              <th>عدد الفواتير</th><th>المرتجعات</th><th>نسبة المرتجعات</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overview.by_branch.map((b, i) => {
                              const sharePct = grandQty > 0 ? (Number(b.total_qty || 0) / grandQty) * 100 : 0;
                              return (
                                <tr key={b.branch_name}>
                                  <td className="cp-td-rank">{i === 0 ? '🏆' : i + 1}</td>
                                  <td className="cp-td-name">{b.branch_name}</td>
                                  <td className="cp-td-num cp-td-bold">{fmt(b.total_qty)}</td>
                                  <td className="cp-td-num">{sharePct.toFixed(1)}%</td>
                                  <td className="cp-td-num">{fmt(b.active_customers)}</td>
                                  <td className="cp-td-num">{fmt(b.invoice_count)}</td>
                                  <td className="cp-td-num">{b.total_returns > 0 ? <span className="cp-ret-badge">{fmt(b.total_returns)}</span> : <span className="cp-dash">—</span>}</td>
                                  <td className="cp-td-num">{b.returns_pct > 0 ? <span className="cp-ret-pct">{b.returns_pct}%</span> : <span className="cp-dash">—</span>}</td>
                                </tr>
                              );
                            })}
                            {overview.by_branch.length === 0 && <tr><td colSpan={8} className="cp-empty">لا توجد بيانات</td></tr>}
                          </tbody>
                          {overview.by_branch.length > 0 && (() => {
                            const sum = (key) => overview.by_branch.reduce((s, b) => s + Number(b[key] || 0), 0);
                            const totalReturns = sum('total_returns');
                            const pct = grandQty > 0 ? (totalReturns / grandQty) * 100 : 0;
                            return (
                              <tfoot>
                                <tr className="cp-tfoot-row">
                                  <td></td>
                                  <td className="cp-td-name cp-td-bold">الإجمالي</td>
                                  <td className="cp-td-num cp-td-bold">{fmt(grandQty)}</td>
                                  <td className="cp-td-num cp-td-bold">100%</td>
                                  <td className="cp-td-num cp-td-bold">{fmt(sum('active_customers'))}</td>
                                  <td className="cp-td-num cp-td-bold">{fmt(sum('invoice_count'))}</td>
                                  <td className="cp-td-num cp-td-bold">{fmt(totalReturns)}</td>
                                  <td className="cp-td-num cp-td-bold">{pct.toFixed(1)}%</td>
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
            <div className="cp-tab-content">
              <div className="cp-twin-grid">
                <div className="cp-card">
                  <div className="cp-card__title">الكمية حسب المنطقة</div>
                  <HBar rows={d.by_region} valueKey="total_qty" labelKey="branch_name" colorClass="cp-bar--primary" />
                </div>
                <div className="cp-card">
                  <div className="cp-card__title">المرتجعات حسب المنطقة</div>
                  <HBar rows={d.by_region} valueKey="total_returns" labelKey="branch_name" colorClass="cp-bar--danger" />
                </div>
              </div>

              <div className="cp-table-wrap">
                <table className="cp-table">
                  <thead>
                    <tr>
                      <th>المنطقة</th><th>الكمية</th><th>الشهر الماضي</th><th>الانحراف</th>
                      <th>العملاء</th><th>المرتجعات</th><th>نسبة المرتجعات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.by_region.map((r, i) => {
                      const dv = r.prev_qty > 0 ? +((r.total_qty - r.prev_qty) / r.prev_qty * 100).toFixed(1) : null;
                      return (
                        <tr key={i}>
                          <td className="cp-td-name">{r.branch_name}</td>
                          <td className="cp-td-num cp-td-bold">{fmt(r.total_qty)}</td>
                          <td className="cp-td-num cp-td-muted">{fmt(r.prev_qty)}</td>
                          <td className="cp-td-num"><Dev pct={dv} size="sm" /></td>
                          <td className="cp-td-num">{fmt(r.active_customers)}</td>
                          <td className="cp-td-num">{r.total_returns > 0 ? <span className="cp-ret-badge">{fmt(r.total_returns)}</span> : <span className="cp-dash">—</span>}</td>
                          <td className="cp-td-num">{r.returns_pct > 0 ? <span className="cp-ret-pct">{r.returns_pct}%</span> : <span className="cp-dash">—</span>}</td>
                        </tr>
                      );
                    })}
                    {d.by_region.length === 0 && <tr><td colSpan={7} className="cp-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Reps
          ══════════════════════════════════════════════ */}
          {activeTab === 'reps' && (
            <div className="cp-tab-content">
              <div className="cp-twin-grid">
                <div className="cp-card">
                  <div className="cp-card__title">الكمية حسب المندوب (أعلى 10)</div>
                  <HBar rows={[...d.by_rep].sort((a,b)=>b.total_qty-a.total_qty).slice(0,10)}
                        valueKey="total_qty" labelKey="salesrep_name" colorClass="cp-bar--accent" />
                </div>
                <div className="cp-card">
                  <div className="cp-card__title">المرتجعات حسب المندوب (أعلى 10)</div>
                  <HBar rows={[...d.by_rep].sort((a,b)=>b.total_returns-a.total_returns).slice(0,10)}
                        valueKey="total_returns" labelKey="salesrep_name" colorClass="cp-bar--danger" />
                </div>
              </div>

              <div className="cp-table-wrap">
                <table className="cp-table">
                  <thead>
                    <tr>
                      <th style={{width:32}}>#</th><th>المندوب</th><th>المنطقة</th>
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
                          <td className="cp-td-rank">{rank}</td>
                          <td className="cp-td-name">{r.salesrep_name}</td>
                          <td className="cp-td-muted" style={{fontSize:'0.74rem'}}>{r.branch_name}</td>
                          <td className="cp-td-num cp-td-bold">{fmt(r.total_qty)}</td>
                          <td className="cp-td-num cp-td-muted">{fmt(r.prev_qty)}</td>
                          <td className="cp-td-num"><Dev pct={dv} size="sm" /></td>
                          <td className="cp-td-num">{fmt(r.active_customers)}</td>
                          <td className="cp-td-num">{r.total_returns > 0 ? <span className="cp-ret-badge">{fmt(r.total_returns)}</span> : <span className="cp-dash">—</span>}</td>
                          <td className="cp-td-num">{r.returns_pct > 0 ? <span className="cp-ret-pct">{r.returns_pct}%</span> : <span className="cp-dash">—</span>}</td>
                        </tr>
                      );
                    })}
                    {sortedReps.length === 0 && <tr><td colSpan={9} className="cp-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Customers
          ══════════════════════════════════════════════ */}
          {activeTab === 'customers' && (
            <div className="cp-tab-content">
              <div className="cp-cust-meta">
                <span>إجمالي العملاء: <strong>{fmt(d.customers.length)}</strong></span>
                <span>إجمالي الكمية: <strong>{fmt(cur?.total_qty)}</strong></span>
                <span>إجمالي المرتجعات: <strong>{fmt(cur?.total_returns)}</strong></span>
              </div>
              <div className="cp-table-wrap">
                <table className="cp-table">
                  <thead>
                    <tr>
                      <th style={{width:32}}>#</th><th>اسم العميل</th><th>المنطقة</th><th>المندوب</th>
                      <Th col="total_qty"      sortCol={custSort.col} sortDir={custSort.dir} onSort={handleCustSort}>الكمية</Th>
                      <Th col="total_returns"  sortCol={custSort.col} sortDir={custSort.dir} onSort={handleCustSort}>المرتجعات</Th>
                      <Th col="returns_pct"    sortCol={custSort.col} sortDir={custSort.dir} onSort={handleCustSort}>نسبة المرتجعات</Th>
                      <Th col="invoice_count"  sortCol={custSort.col} sortDir={custSort.dir} onSort={handleCustSort}>الفواتير</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCusts.map((c, i) => (
                      <tr key={c.customer_code} className={c.total_qty <= 0 ? 'cp-tr--inactive' : ''}
                          onClick={() => setSelectedCustomerCode(c.customer_code)} style={{ cursor: 'pointer' }}>
                        <td className="cp-td-rank">{i + 1}</td>
                        <td className="cp-td-name">{c.customer_name}<span className="cp-td-code"> ({c.customer_code})</span></td>
                        <td className="cp-td-muted" style={{fontSize:'0.74rem'}}>{c.branch_name || '—'}</td>
                        <td className="cp-td-muted" style={{fontSize:'0.74rem'}}>{c.salesrep_name || '—'}</td>
                        <td className={`cp-td-num${c.total_qty <= 0 ? ' cp-td-muted' : ' cp-td-bold'}`}>{fmt(c.total_qty)}</td>
                        <td className="cp-td-num">{c.total_returns > 0 ? <span className="cp-ret-badge">{fmt(c.total_returns)}</span> : <span className="cp-dash">—</span>}</td>
                        <td className="cp-td-num">{c.returns_pct > 0 ? <span className={`cp-ret-pct${c.returns_pct >= 30 ? ' cp-ret-pct--high' : ''}`}>{c.returns_pct}%</span> : <span className="cp-dash">—</span>}</td>
                        <td className="cp-td-num cp-td-muted">{fmt(c.invoice_count)}</td>
                      </tr>
                    ))}
                    {sortedCusts.length === 0 && <tr><td colSpan={8} className="cp-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="cp-card" style={{marginTop: 4}}>
                <div className="cp-card__title cp-card__title--with-filters">
                  <span>
                    مصفوفة الأداء الشهري لكامل الفترة حسب العميل — مبيعات ومرتجعات وإيرادات
                    {custMatrix?.items?.length ? ` (أعلى ${custMatrix.items.length} عميلاً حسب الكمية)` : ''}
                  </span>
                  <span className="cp-metric-toggle">
                    <button type="button" className={`cp-metric-btn${custMatrixMetrics.qty ? ' cp-metric-btn--active cp-metric-btn--qty' : ''}`}
                      onClick={() => toggleCustMatrixMetric('qty')}>المبيعات</button>
                    <button type="button" className={`cp-metric-btn${custMatrixMetrics.revenue ? ' cp-metric-btn--active cp-metric-btn--revenue' : ''}`}
                      onClick={() => toggleCustMatrixMetric('revenue')}>الإيرادات</button>
                    <button type="button" className={`cp-metric-btn${custMatrixMetrics.returns ? ' cp-metric-btn--active cp-metric-btn--returns' : ''}`}
                      onClick={() => toggleCustMatrixMetric('returns')}>المرتجعات</button>
                  </span>
                </div>
                {isCustMatrixLoading && (
                  <div className="cp-loading"><div className="cp-spinner"/><span>جاري التحميل…</span></div>
                )}
                {isCustMatrixError && !isCustMatrixLoading && (
                  <div className="cp-error">حدث خطأ في تحميل مصفوفة العملاء.</div>
                )}
                {custMatrix && custMatrixTotals && !isCustMatrixLoading && (
                  <div className="cp-matrix-wrap">
                    <table className="cp-matrix-table">
                      <thead>
                        <tr>
                          <th className="cp-matrix-th-item">العميل</th>
                          <th className="cp-matrix-th-month">المنطقة</th>
                          {MONTHS.map(([mn, ml]) => <th key={mn} className="cp-matrix-th-month">{ml}</th>)}
                          <th className="cp-matrix-th-total">الإجمالي</th>
                        </tr>
                      </thead>
                      <tbody>
                        {custMatrix.items.map(it => (
                          <tr key={it.customer_code} onClick={() => setSelectedCustomerCode(it.customer_code)} style={{ cursor: 'pointer' }}>
                            <td className="cp-matrix-td-item" title={it.customer_code}>{it.customer_name}</td>
                            <td className="cp-matrix-td-cell cp-matrix-td-branch">{it.branch_name}</td>
                            {it.months.map(mo => {
                              const intensity = custMatrix.max_qty > 0 ? mo.qty / custMatrix.max_qty : 0;
                              const bg = mo.qty > 0 ? `rgba(59,130,246,${0.08 + intensity * 0.55})` : 'transparent';
                              const showQty     = custMatrixMetrics.qty && mo.qty > 0;
                              const showReturns = custMatrixMetrics.returns && mo.returns > 0;
                              const showRevenue = custMatrixMetrics.revenue && mo.revenue > 0;
                              return (
                                <td key={mo.month} className="cp-matrix-td-cell" style={{ background: bg }}>
                                  {showQty && <span className="cp-matrix-qty">{fmt(mo.qty)}</span>}
                                  {showReturns && <span className="cp-matrix-ret">↩{fmt(mo.returns)}</span>}
                                  {showRevenue && <span className="cp-matrix-rev">{fmt(mo.revenue)} ر.س</span>}
                                  {!showQty && !showReturns && !showRevenue && <span className="cp-matrix-dash">—</span>}
                                </td>
                              );
                            })}
                            <td className="cp-matrix-td-total">
                              {custMatrixMetrics.qty && <span className="cp-matrix-qty">{fmt(it.annual_qty)}</span>}
                              {custMatrixMetrics.returns && it.annual_returns > 0 && <span className="cp-matrix-ret">↩{fmt(it.annual_returns)}</span>}
                              {custMatrixMetrics.revenue && it.annual_revenue > 0 && <span className="cp-matrix-rev">{fmt(it.annual_revenue)} ر.س</span>}
                            </td>
                          </tr>
                        ))}
                        {(!custMatrix.items || custMatrix.items.length === 0) && (
                          <tr><td colSpan={15} className="cp-empty">لا توجد بيانات</td></tr>
                        )}
                      </tbody>
                      {custMatrix.items.length > 0 && (
                        <tfoot>
                          <tr className="cp-matrix-tf-row">
                            <td className="cp-matrix-td-item cp-matrix-td-item--tf">الإجمالي</td>
                            <td className="cp-matrix-td-cell"></td>
                            {custMatrixTotals.colTotals.map((col, i) => (
                              <td key={i} className="cp-matrix-td-total">
                                {custMatrixMetrics.qty && <span className="cp-matrix-qty">{fmt(col.qty)}</span>}
                                {custMatrixMetrics.returns && col.returns > 0 && <span className="cp-matrix-ret">↩{fmt(col.returns)}</span>}
                                {custMatrixMetrics.revenue && col.revenue > 0 && <span className="cp-matrix-rev">{fmt(col.revenue)} ر.س</span>}
                              </td>
                            ))}
                            <td className="cp-matrix-td-total cp-matrix-td-grand">
                              {custMatrixMetrics.qty && <span className="cp-matrix-qty">{fmt(custMatrixTotals.grandTotal.qty)}</span>}
                              {custMatrixMetrics.returns && custMatrixTotals.grandTotal.returns > 0 && <span className="cp-matrix-ret">↩{fmt(custMatrixTotals.grandTotal.returns)}</span>}
                              {custMatrixMetrics.revenue && custMatrixTotals.grandTotal.revenue > 0 && <span className="cp-matrix-rev">{fmt(custMatrixTotals.grandTotal.revenue)} ر.س</span>}
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
              TAB: Items
          ══════════════════════════════════════════════ */}
          {activeTab === 'items' && (
            <div className="cp-tab-content">
              <div className="cp-cust-meta">
                <span>إجمالي الأصناف: <strong>{fmt(d.by_item.length)}</strong></span>
                <span>إجمالي الكمية: <strong>{fmt(cur?.total_qty)}</strong></span>
                <span>إجمالي المرتجعات: <strong>{fmt(cur?.total_returns)}</strong></span>
              </div>

              <div className="cp-twin-grid">
                <div className="cp-card">
                  <div className="cp-card__title">🏆 أهم الأصناف مبيعاً (أعلى 10)</div>
                  <HBar rows={topItems} valueKey="total_qty" labelKey="item_name" colorClass="cp-bar--primary" />
                </div>
                <div className="cp-card">
                  <div className="cp-card__title">⚠️ أقل الأصناف مبيعاً (أدنى 10)</div>
                  <HBar rows={bottomItems} valueKey="total_qty" labelKey="item_name" colorClass="cp-bar--danger" />
                </div>
              </div>

              {isItemOverviewLoading && (
                <div className="cp-loading"><div className="cp-spinner"/><span>جاري التحميل…</span></div>
              )}
              {isItemOverviewError && !isItemOverviewLoading && (
                <div className="cp-error">حدث خطأ في تحميل إجمالي الأصناف لكامل الفترة.</div>
              )}
              {itemOverview && !isItemOverviewLoading && (
                <div className="cp-twin-grid">
                  <div className="cp-card">
                    <div className="cp-card__title">🏆 أهم الأصناف مبيعاً (كامل الفترة — أعلى 10)</div>
                    <HBar rows={topItemsAllTime} valueKey="total_qty" labelKey="item_name" colorClass="cp-bar--primary" />
                  </div>
                  <div className="cp-card">
                    <div className="cp-card__title">⚠️ أقل الأصناف مبيعاً (كامل الفترة — أدنى 10)</div>
                    <HBar rows={bottomItemsAllTime} valueKey="total_qty" labelKey="item_name" colorClass="cp-bar--danger" />
                  </div>
                </div>
              )}

              <div className="cp-table-wrap">
                <table className="cp-table">
                  <thead>
                    <tr>
                      <th style={{width:32}}>#</th><th>الصنف</th><th>الفئة</th>
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
                        <tr key={`${it.item_name}-${it.item_category}`} className={it.total_qty <= 0 ? 'cp-tr--inactive' : ''}>
                          <td className="cp-td-rank">{i + 1}</td>
                          <td className="cp-td-name">{it.item_name}</td>
                          <td className="cp-td-muted" style={{fontSize:'0.74rem'}}>{it.item_category}</td>
                          <td className={`cp-td-num${it.total_qty <= 0 ? ' cp-td-muted' : ' cp-td-bold'}`}>{fmt(it.total_qty)}</td>
                          <td className="cp-td-num cp-td-muted">{fmt(it.prev_qty)}</td>
                          <td className="cp-td-num"><Dev pct={dv} size="sm" /></td>
                          <td className="cp-td-num">{it.total_returns > 0 ? <span className="cp-ret-badge">{fmt(it.total_returns)}</span> : <span className="cp-dash">—</span>}</td>
                          <td className="cp-td-num">{it.returns_pct > 0 ? <span className={`cp-ret-pct${it.returns_pct >= 30 ? ' cp-ret-pct--high' : ''}`}>{it.returns_pct}%</span> : <span className="cp-dash">—</span>}</td>
                          <td className="cp-td-num cp-td-muted">{fmt(it.invoice_count)}</td>
                        </tr>
                      );
                    })}
                    {sortedItems.length === 0 && <tr><td colSpan={9} className="cp-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="cp-card" style={{marginTop: 4}}>
                <div className="cp-card__title">
                  مصفوفة الأداء الشهري للأصناف — {year} (أعلى {itemMatrix?.items?.length || 0} صنفاً حسب الكمية السنوية)
                </div>
                {isMatrixLoading && (
                  <div className="cp-loading"><div className="cp-spinner"/><span>جاري التحميل…</span></div>
                )}
                {isMatrixError && !isMatrixLoading && (
                  <div className="cp-error">حدث خطأ في تحميل المصفوفة.</div>
                )}
                {itemMatrix && !isMatrixLoading && (
                  <div className="cp-matrix-wrap">
                    <table className="cp-matrix-table">
                      <thead>
                        <tr>
                          <th className="cp-matrix-th-item">الصنف</th>
                          {Object.entries(itemMatrix.month_names).map(([mn, ml]) => (
                            <th key={mn} className="cp-matrix-th-month">{ml}</th>
                          ))}
                          <th className="cp-matrix-th-total">الإجمالي</th>
                        </tr>
                      </thead>
                      <tbody>
                        {itemMatrix.items.map(it => (
                          <tr key={it.item_name}>
                            <td className="cp-matrix-td-item" title={it.item_category}>{it.item_name}</td>
                            {it.months.map(mo => {
                              const intensity = itemMatrix.max_qty > 0 ? mo.qty / itemMatrix.max_qty : 0;
                              const bg = mo.qty > 0 ? `rgba(59,130,246,${0.08 + intensity * 0.55})` : 'transparent';
                              return (
                                <td key={mo.month} className="cp-matrix-td-cell" style={{ background: bg }}>
                                  {mo.qty > 0 ? <span className="cp-matrix-qty">{fmt(mo.qty)}</span> : <span className="cp-matrix-dash">—</span>}
                                  {mo.returns > 0 && <span className="cp-matrix-ret">↩{fmt(mo.returns)}</span>}
                                </td>
                              );
                            })}
                            <td className="cp-matrix-td-total">
                              <span className="cp-matrix-qty">{fmt(it.annual_qty)}</span>
                              {it.annual_returns > 0 && <span className="cp-matrix-ret">↩{fmt(it.annual_returns)}</span>}
                            </td>
                          </tr>
                        ))}
                        {(!itemMatrix.items || itemMatrix.items.length === 0) && (
                          <tr><td colSpan={14} className="cp-empty">لا توجد بيانات</td></tr>
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
