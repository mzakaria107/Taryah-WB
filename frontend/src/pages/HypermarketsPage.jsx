import React, { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '../api/client';
import './HypermarketsPage.css';

/* ── Constants ─────────────────────────────────────────────── */
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
  return Number(n).toLocaleString('ar-SA', { maximumFractionDigits: dec });
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

/* ── Trend Bar Chart ──────────────────────────────────────── */
function TrendChart({ trend, highlight }) {
  if (!trend?.length) return <div className="hm-empty">لا توجد بيانات</div>;
  const maxQty     = Math.max(...trend.map(t => t.total_qty), 1);
  const maxReturns = Math.max(...trend.map(t => t.total_returns), 1);

  return (
    <div className="hm-trend">
      <div className="hm-trend__cols">
        {trend.map((t, i) => {
          const isHL = t.month_num === highlight;
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
              <div className="hm-trend__label">{t.month_name}</div>
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

/* ═══════════════════════════════════════════════════════════
   Main Page
═══════════════════════════════════════════════════════════ */
export default function HypermarketsPage() {
  const [year,       setYear]       = useState(currentYear);
  const [month,      setMonth]      = useState(currentMonth);
  const [branchName, setBranchName] = useState('');
  const [repName,    setRepName]    = useState('');
  const [activeTab,  setActiveTab]  = useState('overview');

  /* Sort state for reps table */
  const [repSort, setRepSort]       = useState({ col: 'total_qty', dir: 'desc' });
  /* Sort state for customers table */
  const [custSort, setCustSort]     = useState({ col: 'total_qty', dir: 'desc' });

  const handleRepSort  = useCallback(col => setRepSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);
  const handleCustSort = useCallback(col => setCustSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);

  /* ── Filters query ─────────────────────────────────────── */
  const { data: filters } = useQuery({
    queryKey: ['hm-filters', year],
    queryFn: () => client.get(`/hypermarkets/filters?year=${year}`).then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const repOptions = useMemo(() => {
    if (!filters?.reps) return [];
    return branchName ? filters.reps.filter(r => r.branch === branchName) : filters.reps;
  }, [filters, branchName]);

  /* ── Main data query ───────────────────────────────────── */
  const params = new URLSearchParams({ year, month });
  if (branchName) params.set('branch_name', branchName);
  if (repName)    params.set('salesrep_name', repName);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['hm-summary', year, month, branchName, repName],
    queryFn:  () => client.get(`/hypermarkets/summary?${params}`).then(r => r.data),
    staleTime: 2 * 60 * 1000,
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

  /* ── Derived values ──────────────────────────────────────── */
  const monthName     = MONTHS.find(m => m[0] === month)?.[1] || '';
  const prevMonthName = MONTHS.find(m => m[0] === (month === 1 ? 12 : month - 1))?.[1] || '';

  function handlePrint() {
    const prev = document.title;
    document.title = `Hypermarkets — ${monthName} ${year}`;
    window.print();
    window.onafterprint = () => { document.title = prev; };
  }

  const d   = data;
  const cur  = d?.cur;
  const prev = d?.prev;
  const dev  = d?.deviation;

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
        <div className="hm-print-sub">{monthName} {year}{branchName ? ` · ${branchName}` : ''}{repName ? ` · ${repName}` : ''}</div>
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
        <button className="hm-btn hm-btn--outline" onClick={handlePrint}>🖨️ طباعة</button>
      </div>

      {/* ── Filters ──────────────────────────────────────── */}
      <div className="hm-filters hm-no-print">
        {[
          { label: 'السنة', el:
            <select value={year} onChange={e => setYear(+e.target.value)}>
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select> },
          { label: 'الشهر', el:
            <select value={month} onChange={e => setMonth(+e.target.value)}>
              {MONTHS.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
            </select> },
          { label: 'المنطقة', el:
            <select value={branchName} onChange={e => { setBranchName(e.target.value); setRepName(''); }}>
              <option value="">جميع المناطق</option>
              {(filters?.branches || []).map(b => <option key={b} value={b}>{b}</option>)}
            </select> },
          { label: 'المندوب', el:
            <select value={repName} onChange={e => setRepName(e.target.value)}>
              <option value="">جميع المناديب</option>
              {repOptions.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
            </select> },
        ].map(({ label, el }) => (
          <div key={label} className="hm-filter-group">
            <label>{label}</label>
            {el}
          </div>
        ))}
        {(branchName || repName) && (
          <button className="hm-btn hm-btn--ghost" onClick={() => { setBranchName(''); setRepName(''); }}>
            ✕ إعادة تعيين
          </button>
        )}
      </div>

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
            <span className="hm-period__cur">{monthName} {year}</span>
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
              sub={`أول ظهور في ${monthName}`}
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
          <div className="hm-section-title">الاتجاه الشهري — {year}</div>
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
              ['overview', 'المناطق'],
              ['reps',     'المناديب'],
              ['customers','العملاء'],
            ].map(([k, l]) => (
              <button
                key={k}
                className={`hm-tab${activeTab === k ? ' hm-tab--active' : ''}`}
                onClick={() => setActiveTab(k)}
              >{l}</button>
            ))}
          </div>

          {/* ══════════════════════════════════════════════
              TAB: Regions
          ══════════════════════════════════════════════ */}
          {activeTab === 'overview' && (
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
            </div>
          )}
        </>
      )}
    </div>
  );
}
