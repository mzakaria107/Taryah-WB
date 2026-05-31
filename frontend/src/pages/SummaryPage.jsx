import React, { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import client from '../api/client';
import './SummaryPage.css';

/* ── Constants ────────────────────────────────────────────── */
const MONTHS = [
  [1,'يناير'],[2,'فبراير'],[3,'مارس'],[4,'أبريل'],
  [5,'مايو'],[6,'يونيو'],[7,'يوليو'],[8,'أغسطس'],
  [9,'سبتمبر'],[10,'أكتوبر'],[11,'نوفمبر'],[12,'ديسمبر'],
];
const currentYear  = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;
const YEARS = [currentYear - 1, currentYear, currentYear + 1];

/* ── Helpers ──────────────────────────────────────────────── */
function fmt(n, decimals = 0) {
  if (n == null) return '—';
  return Number(n).toLocaleString('ar-SA', { maximumFractionDigits: decimals });
}
function fmtCurrency(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('ar-SA', { maximumFractionDigits: 0 }) + ' ر.س';
}
function devSign(pct) {
  if (pct == null) return null;
  if (pct > 0) return 'up';
  if (pct < 0) return 'down';
  return 'flat';
}

/* ── Deviation Badge ──────────────────────────────────────── */
function DevBadge({ pct, invert = false }) {
  if (pct == null) return null;
  const sign     = invert ? (pct < 0 ? 'up' : pct > 0 ? 'down' : 'flat') : devSign(pct);
  const absVal   = Math.abs(pct).toFixed(1);
  const arrow    = sign === 'up' ? '↑' : sign === 'down' ? '↓' : '→';
  return (
    <span className={`sm-dev sm-dev--${sign}`}>
      {arrow} {absVal}%
    </span>
  );
}

/* ── CSS Bar Chart ────────────────────────────────────────── */
function BarChart({ rows, valueKey, labelKey, colorClass = 'sm-bar--primary', maxBars = 12 }) {
  const capped = rows.slice(0, maxBars);
  const max    = Math.max(...capped.map(r => Number(r[valueKey]) || 0), 1);
  return (
    <div className="sm-barchart">
      {capped.map((r, i) => {
        const val = Number(r[valueKey]) || 0;
        const pct = (val / max * 100).toFixed(1);
        return (
          <div key={i} className="sm-barchart__row">
            <span className="sm-barchart__label" title={r[labelKey]}>{r[labelKey]}</span>
            <div className="sm-barchart__track">
              <div
                className={`sm-barchart__fill ${colorClass}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="sm-barchart__val">{fmt(val)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── KPI Card ─────────────────────────────────────────────── */
function KpiCard({ icon, label, value, sub, deviation, invertDev = false, accent }) {
  return (
    <div className={`sm-kpi ${accent ? `sm-kpi--${accent}` : ''}`}>
      {icon && <div className="sm-kpi__icon">{icon}</div>}
      <div className="sm-kpi__body">
        <div className="sm-kpi__label">{label}</div>
        <div className="sm-kpi__value">{value}</div>
        {sub && <div className="sm-kpi__sub">{sub}</div>}
        {deviation != null && <DevBadge pct={deviation} invert={invertDev} />}
      </div>
    </div>
  );
}

/* ── Sortable table header ────────────────────────────────── */
function Th({ col, sortCol, sortDir, onSort, children, align = 'right' }) {
  const active = sortCol === col;
  return (
    <th
      className={`sm-th${active ? ' sm-th--sorted' : ''}`}
      style={{ textAlign: align, cursor: 'pointer' }}
      onClick={() => onSort(col)}
    >
      {children}
      <span className={`sm-sort ${active ? 'sm-sort--active' : ''}`}>
        {active ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ' ⇅'}
      </span>
    </th>
  );
}

/* ═══════════════════════════════════════════════════════════
   Main Page
═══════════════════════════════════════════════════════════ */
export default function SummaryPage() {
  /* ── Filter state ─────────────────────────────────────── */
  const [year,       setYear]       = useState(currentYear);
  const [month,      setMonth]      = useState(currentMonth);
  const [branchName, setBranchName] = useState('');
  const [repName,    setRepName]    = useState('');
  const [activeTab,  setActiveTab]  = useState('overview'); // overview | regions | reps | debt

  /* ── Rep sort ─────────────────────────────────────────── */
  const [repSortCol, setRepSortCol] = useState('total_qty');
  const [repSortDir, setRepSortDir] = useState('desc');
  const handleRepSort = useCallback(col => {
    setRepSortCol(c => {
      if (c === col) { setRepSortDir(d => d === 'desc' ? 'asc' : 'desc'); return col; }
      setRepSortDir('desc'); return col;
    });
  }, []);

  /* ── Debt rep sort ────────────────────────────────────── */
  const [debtRepSortCol, setDebtRepSortCol] = useState('total_balance');
  const [debtRepSortDir, setDebtRepSortDir] = useState('desc');
  const handleDebtRepSort = useCallback(col => {
    setDebtRepSortCol(c => {
      if (c === col) { setDebtRepSortDir(d => d === 'desc' ? 'asc' : 'desc'); return col; }
      setDebtRepSortDir('desc'); return col;
    });
  }, []);

  /* ── API: filters ─────────────────────────────────────── */
  const { data: filters } = useQuery({
    queryKey: ['summary-filters', year],
    queryFn: () => client.get(`/summary/filters?year=${year}`).then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  /* ── Filtered rep list for dropdown ──────────────────── */
  const repOptions = useMemo(() => {
    if (!filters?.reps) return [];
    if (!branchName) return filters.reps;
    return filters.reps.filter(r => r.branch === branchName);
  }, [filters, branchName]);

  /* ── API: summary data ───────────────────────────────── */
  const params = new URLSearchParams({ year, month });
  if (branchName) params.set('branch_name', branchName);
  if (repName)    params.set('salesrep_name', repName);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['summary', year, month, branchName, repName],
    queryFn: () => client.get(`/summary?${params}`).then(r => r.data),
    staleTime: 2 * 60 * 1000,
  });

  /* ── Sorted reps ──────────────────────────────────────── */
  const sortedReps = useMemo(() => {
    if (!data?.reps) return [];
    const dir = repSortDir === 'desc' ? -1 : 1;
    return [...data.reps].sort((a, b) => (Number(b[repSortCol]) - Number(a[repSortCol])) * dir);
  }, [data, repSortCol, repSortDir]);

  const sortedDebtReps = useMemo(() => {
    if (!data?.debt?.by_rep) return [];
    const dir = debtRepSortDir === 'desc' ? -1 : 1;
    return [...data.debt.by_rep].sort((a, b) => (Number(b[debtRepSortCol]) - Number(a[debtRepSortCol])) * dir);
  }, [data, debtRepSortCol, debtRepSortDir]);

  /* ── Handle branch change ─────────────────────────────── */
  function handleBranchChange(v) {
    setBranchName(v);
    setRepName('');  // reset rep when branch changes
  }

  /* ── Reset filters ─────────────────────────────────────── */
  function resetFilters() { setBranchName(''); setRepName(''); }

  /* ── Month name ───────────────────────────────────────── */
  const monthName = MONTHS.find(m => m[0] === month)?.[1] || '';
  const prevMonthNum  = month === 1 ? 12 : month - 1;
  const prevMonthName = MONTHS.find(m => m[0] === prevMonthNum)?.[1] || '';

  /* ── Print ────────────────────────────────────────────── */
  function handlePrint() {
    const prev = document.title;
    document.title = `الملخص العام - ${monthName} ${year}`;
    window.print();
    window.onafterprint = () => { document.title = prev; };
  }

  /* ─────────────────────────────────────────────────────── */
  const s    = data?.sales;
  const col  = data?.collections;
  const debt = data?.debt;

  return (
    <div className="sm-page">
      {/* ── Print Header ─────────────────────────────────── */}
      <div className="sm-print-header">
        <div className="sm-print-title">الملخص العام — {monthName} {year}</div>
        <div className="sm-print-sub">
          {branchName ? `المنطقة: ${branchName}` : 'جميع المناطق'}
          {repName ? ` · المندوب: ${repName}` : ''}
        </div>
      </div>

      {/* ── Page header ──────────────────────────────────── */}
      <div className="sm-header sm-no-print">
        <div className="sm-header__title">
          <span className="sm-header__icon">📊</span>
          الملخص العام
        </div>
        <div className="sm-header__actions">
          <button className="sm-btn sm-btn--outline" onClick={handlePrint}>🖨️ طباعة</button>
        </div>
      </div>

      {/* ── Filters ──────────────────────────────────────── */}
      <div className="sm-filters sm-no-print">
        <div className="sm-filter-group">
          <label>السنة</label>
          <select value={year} onChange={e => setYear(+e.target.value)}>
            {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="sm-filter-group">
          <label>الشهر</label>
          <select value={month} onChange={e => setMonth(+e.target.value)}>
            {MONTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="sm-filter-group">
          <label>المنطقة</label>
          <select value={branchName} onChange={e => handleBranchChange(e.target.value)}>
            <option value="">جميع المناطق</option>
            {(filters?.branches || []).map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div className="sm-filter-group">
          <label>المندوب</label>
          <select value={repName} onChange={e => setRepName(e.target.value)}>
            <option value="">جميع المناديب</option>
            {repOptions.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
          </select>
        </div>
        {(branchName || repName) && (
          <button className="sm-btn sm-btn--ghost sm-no-print" onClick={resetFilters}>✕ إعادة تعيين</button>
        )}
      </div>

      {/* ── Loading / Error ───────────────────────────────── */}
      {isLoading && (
        <div className="sm-loading">
          <div className="sm-spinner" />
          <span>جاري تحميل البيانات…</span>
        </div>
      )}
      {isError && !isLoading && (
        <div className="sm-error">حدث خطأ أثناء تحميل البيانات. يرجى المحاولة مجدداً.</div>
      )}

      {data && !isLoading && (
        <>
          {/* ── Period badge ────────────────────────────── */}
          <div className="sm-period-badge">
            <span className="sm-period-cur">{monthName} {year}</span>
            <span className="sm-period-vs">مقارنةً بـ</span>
            <span className="sm-period-prev">{prevMonthName} {month === 1 ? year - 1 : year}</span>
            <span className="sm-period-wd">· أيام العمل: {data.meta.working_days_cur}</span>
          </div>

          {/* ── KPI Row 1: Customers ─────────────────────── */}
          <div className="sm-section-title">العملاء</div>
          <div className="sm-kpi-row">
            <KpiCard
              icon="🟢"
              accent="green"
              label="العملاء النشطون"
              value={fmt(s?.cur?.active_customers)}
              sub={`الشهر الماضي: ${fmt(s?.prev?.active_customers)}`}
              deviation={s?.prev?.active_customers > 0
                ? +((s.cur.active_customers - s.prev.active_customers) / s.prev.active_customers * 100).toFixed(1)
                : null}
            />
            <KpiCard
              icon="🔴"
              accent="red"
              label="العملاء المتوقفون"
              value={fmt(data.stopped_customers)}
              sub="نشطون الشهر الماضي، غائبون هذا الشهر"
            />
            <KpiCard
              icon="⚪"
              accent="muted"
              label="العملاء غير المتعاملين"
              value={fmt(s?.cur?.inactive_customers)}
              sub={`إجمالي الشهر: كمية ≤ 0`}
            />
          </div>

          {/* ── KPI Row 2: Sales ─────────────────────────── */}
          <div className="sm-section-title">المبيعات الشهرية</div>
          <div className="sm-kpi-row">
            <KpiCard
              icon="📦"
              accent="blue"
              label="إجمالي الكمية"
              value={fmt(s?.cur?.total_qty)}
              sub={`الشهر الماضي: ${fmt(s?.prev?.total_qty)}`}
              deviation={s?.deviation_pct}
            />
            <KpiCard
              icon="📅"
              accent="blue"
              label="المتوسط اليومي"
              value={fmt(s?.cur?.daily_avg, 1)}
              sub={`الشهر الماضي: ${fmt(s?.prev?.daily_avg, 1)}`}
              deviation={s?.prev?.daily_avg > 0
                ? +((s.cur.daily_avg - s.prev.daily_avg) / s.prev.daily_avg * 100).toFixed(1)
                : null}
            />
            <KpiCard
              icon="↩️"
              accent="orange"
              label="نسبة المرتجعات"
              value={`${fmt(s?.cur?.returns_pct, 1)}%`}
              sub={`الكمية: ${fmt(s?.cur?.total_returns)} · الشهر الماضي: ${fmt(s?.prev?.returns_pct, 1)}%`}
              deviation={s?.cur?.returns_pct != null && s?.prev?.returns_pct != null
                ? +(s.cur.returns_pct - s.prev.returns_pct).toFixed(1)
                : null}
              invertDev
            />
          </div>

          {/* ── KPI Row 3: Collections ───────────────────── */}
          <div className="sm-section-title">التحصيل</div>
          <div className="sm-kpi-row">
            <KpiCard
              icon="💰"
              accent="green"
              label="إجمالي التحصيل الشهري"
              value={fmtCurrency(col?.total_paid)}
              sub={`الشهر الماضي: ${fmtCurrency(col?.prev_total_paid)}`}
              deviation={col?.deviation_pct}
            />
            <KpiCard
              icon="📆"
              accent="green"
              label="متوسط التحصيل اليومي"
              value={fmtCurrency(col?.daily_avg)}
              sub={`أيام العمل: ${data.meta.working_days_cur} · عمليات: ${fmt(col?.tx_count)}`}
            />
            <KpiCard
              icon="🏦"
              accent="purple"
              label="إجمالي الديون القائمة"
              value={fmtCurrency(debt?.grand_balance)}
              sub={`تشمل جميع الفترات`}
            />
          </div>

          {/* ── Tabs ─────────────────────────────────────── */}
          <div className="sm-tabs sm-no-print">
            {[
              ['overview',  'نظرة عامة'],
              ['regions',   'المناطق'],
              ['reps',      'المناديب'],
              ['debt',      'المديونية'],
            ].map(([k, l]) => (
              <button
                key={k}
                className={`sm-tab${activeTab === k ? ' sm-tab--active' : ''}`}
                onClick={() => setActiveTab(k)}
              >
                {l}
              </button>
            ))}
          </div>

          {/* ══════════════════════════════════════════════
              TAB: Overview — mini charts side by side
          ══════════════════════════════════════════════ */}
          {activeTab === 'overview' && (
            <div className="sm-overview-grid">
              {/* Sales by region */}
              <div className="sm-chart-card">
                <div className="sm-chart-card__title">المبيعات حسب المنطقة</div>
                {data.regions.length === 0
                  ? <div className="sm-empty">لا توجد بيانات</div>
                  : <BarChart
                      rows={data.regions}
                      valueKey="total_qty"
                      labelKey="branch_name"
                      colorClass="sm-bar--primary"
                      maxBars={10}
                    />
                }
              </div>

              {/* Sales by rep (top 10) */}
              <div className="sm-chart-card">
                <div className="sm-chart-card__title">المبيعات حسب المندوب (أعلى 10)</div>
                {data.reps.length === 0
                  ? <div className="sm-empty">لا توجد بيانات</div>
                  : <BarChart
                      rows={data.reps}
                      valueKey="total_qty"
                      labelKey="salesrep_name"
                      colorClass="sm-bar--accent"
                      maxBars={10}
                    />
                }
              </div>

              {/* Debt by region */}
              <div className="sm-chart-card">
                <div className="sm-chart-card__title">المديونية حسب المنطقة</div>
                {debt?.by_region?.length === 0
                  ? <div className="sm-empty">لا توجد بيانات</div>
                  : <BarChart
                      rows={debt?.by_region || []}
                      valueKey="total_balance"
                      labelKey="region_name"
                      colorClass="sm-bar--danger"
                      maxBars={10}
                    />
                }
              </div>

              {/* Returns by region */}
              <div className="sm-chart-card">
                <div className="sm-chart-card__title">المرتجعات حسب المنطقة</div>
                {data.regions.length === 0
                  ? <div className="sm-empty">لا توجد بيانات</div>
                  : <BarChart
                      rows={data.regions}
                      valueKey="total_returns"
                      labelKey="branch_name"
                      colorClass="sm-bar--warning"
                      maxBars={10}
                    />
                }
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Regions
          ══════════════════════════════════════════════ */}
          {activeTab === 'regions' && (
            <div className="sm-tab-content">
              <div className="sm-chart-card sm-chart-card--wide">
                <div className="sm-chart-card__title">أداء المناطق — {monthName} {year}</div>
                <BarChart
                  rows={data.regions}
                  valueKey="total_qty"
                  labelKey="branch_name"
                  colorClass="sm-bar--primary"
                  maxBars={15}
                />
              </div>

              <div className="sm-table-wrap">
                <table className="sm-table">
                  <thead>
                    <tr>
                      <th>المنطقة</th>
                      <th>إجمالي الكمية</th>
                      <th>الشهر الماضي</th>
                      <th>الانحراف</th>
                      <th>العملاء النشطون</th>
                      <th>المرتجعات</th>
                      <th>نسبة المرتجعات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.regions.map((r, i) => {
                      const dev = r.prev_qty > 0
                        ? +((r.total_qty - r.prev_qty) / r.prev_qty * 100).toFixed(1)
                        : null;
                      const retPct = r.total_qty > 0
                        ? (r.total_returns / r.total_qty * 100).toFixed(1)
                        : 0;
                      return (
                        <tr key={i}>
                          <td className="sm-td-name">{r.branch_name}</td>
                          <td className="sm-td-num">{fmt(r.total_qty)}</td>
                          <td className="sm-td-num sm-td-muted">{fmt(r.prev_qty)}</td>
                          <td className="sm-td-num"><DevBadge pct={dev} /></td>
                          <td className="sm-td-num">{fmt(r.active_customers)}</td>
                          <td className="sm-td-num">{r.total_returns > 0 ? fmt(r.total_returns) : <span className="sm-dash">—</span>}</td>
                          <td className="sm-td-num">{retPct > 0 ? `${retPct}%` : <span className="sm-dash">—</span>}</td>
                        </tr>
                      );
                    })}
                    {data.regions.length === 0 && (
                      <tr><td colSpan={7} className="sm-empty">لا توجد بيانات</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Reps
          ══════════════════════════════════════════════ */}
          {activeTab === 'reps' && (
            <div className="sm-tab-content">
              <div className="sm-chart-card sm-chart-card--wide">
                <div className="sm-chart-card__title">أداء المناديب — {monthName} {year} (أعلى 15)</div>
                <BarChart
                  rows={[...data.reps].sort((a,b) => b.total_qty - a.total_qty).slice(0, 15)}
                  valueKey="total_qty"
                  labelKey="salesrep_name"
                  colorClass="sm-bar--accent"
                  maxBars={15}
                />
              </div>

              <div className="sm-table-wrap">
                <table className="sm-table">
                  <colgroup>
                    <col style={{width:'30px'}}/>
                    <col style={{width:'150px'}}/>
                    <col style={{width:'90px'}}/>
                    <col />
                    <col />
                    <col />
                    <col />
                    <col />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>المندوب</th>
                      <th>المنطقة</th>
                      <Th col="total_qty"        sortCol={repSortCol} sortDir={repSortDir} onSort={handleRepSort}>الكمية</Th>
                      <Th col="prev_qty"         sortCol={repSortCol} sortDir={repSortDir} onSort={handleRepSort}>الشهر الماضي</Th>
                      <th>الانحراف</th>
                      <Th col="active_customers" sortCol={repSortCol} sortDir={repSortDir} onSort={handleRepSort}>العملاء</Th>
                      <Th col="total_returns"    sortCol={repSortCol} sortDir={repSortDir} onSort={handleRepSort}>المرتجعات</Th>
                      <th>نسبة المرتجعات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedReps.map((r, i) => {
                      const rank = [...data.reps]
                        .sort((a,b) => b[repSortCol] - a[repSortCol])
                        .findIndex(x => x.salesrep_name === r.salesrep_name) + 1;
                      const dev = r.prev_qty > 0
                        ? +((r.total_qty - r.prev_qty) / r.prev_qty * 100).toFixed(1)
                        : null;
                      const retPct = r.total_qty > 0
                        ? (r.total_returns / r.total_qty * 100).toFixed(1)
                        : 0;
                      return (
                        <tr key={r.salesrep_name}>
                          <td className="sm-td-rank">{rank}</td>
                          <td className="sm-td-name">{r.salesrep_name}</td>
                          <td className="sm-td-muted sm-td-branch">{r.branch_name}</td>
                          <td className="sm-td-num sm-td-bold">{fmt(r.total_qty)}</td>
                          <td className="sm-td-num sm-td-muted">{fmt(r.prev_qty)}</td>
                          <td className="sm-td-num"><DevBadge pct={dev} /></td>
                          <td className="sm-td-num">{fmt(r.active_customers)}</td>
                          <td className="sm-td-num">{r.total_returns > 0 ? fmt(r.total_returns) : <span className="sm-dash">—</span>}</td>
                          <td className="sm-td-num">{retPct > 0 ? <span className="sm-ret-badge">{retPct}%</span> : <span className="sm-dash">—</span>}</td>
                        </tr>
                      );
                    })}
                    {sortedReps.length === 0 && (
                      <tr><td colSpan={9} className="sm-empty">لا توجد بيانات</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Debt
          ══════════════════════════════════════════════ */}
          {activeTab === 'debt' && (
            <div className="sm-tab-content">
              {/* Summary card */}
              <div className="sm-debt-summary">
                <div className="sm-debt-summary__total">
                  <span className="sm-debt-summary__label">إجمالي الديون القائمة</span>
                  <span className="sm-debt-summary__value">{fmtCurrency(debt?.grand_balance)}</span>
                </div>
              </div>

              <div className="sm-debt-grid">
                {/* By region */}
                <div>
                  <div className="sm-chart-card">
                    <div className="sm-chart-card__title">المديونية حسب المنطقة</div>
                    <BarChart
                      rows={debt?.by_region || []}
                      valueKey="total_balance"
                      labelKey="region_name"
                      colorClass="sm-bar--danger"
                      maxBars={10}
                    />
                  </div>
                  <div className="sm-table-wrap" style={{ marginTop: 12 }}>
                    <table className="sm-table">
                      <thead>
                        <tr>
                          <th>المنطقة</th>
                          <th>رصيد الديون</th>
                          <th>نسبة من الإجمالي</th>
                          <th>إجمالي الفواتير</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(debt?.by_region || []).map((r, i) => (
                          <tr key={i}>
                            <td className="sm-td-name">{r.region_name}</td>
                            <td className="sm-td-num sm-td-red">{fmtCurrency(r.total_balance)}</td>
                            <td className="sm-td-num">
                              <div className="sm-debt-pct-wrap">
                                <div className="sm-debt-pct-bar" style={{ width: `${r.pct_of_total}%` }} />
                                <span>{r.pct_of_total}%</span>
                              </div>
                            </td>
                            <td className="sm-td-num sm-td-muted">{fmtCurrency(r.total_invoiced)}</td>
                          </tr>
                        ))}
                        {(debt?.by_region || []).length === 0 && (
                          <tr><td colSpan={4} className="sm-empty">لا توجد بيانات</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* By rep */}
                <div>
                  <div className="sm-chart-card">
                    <div className="sm-chart-card__title">أعلى المناديب ديوناً (أعلى 10)</div>
                    <BarChart
                      rows={(debt?.by_rep || []).slice(0, 10)}
                      valueKey="total_balance"
                      labelKey="salesrep_name"
                      colorClass="sm-bar--danger"
                      maxBars={10}
                    />
                  </div>
                  <div className="sm-table-wrap" style={{ marginTop: 12 }}>
                    <table className="sm-table">
                      <colgroup>
                        <col style={{ width: '30px' }} />
                        <col />
                        <col />
                        <col />
                        <col />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>المندوب</th>
                          <Th col="total_balance"  sortCol={debtRepSortCol} sortDir={debtRepSortDir} onSort={handleDebtRepSort}>رصيد الديون</Th>
                          <Th col="pct_of_total"   sortCol={debtRepSortCol} sortDir={debtRepSortDir} onSort={handleDebtRepSort}>النسبة %</Th>
                          <Th col="total_invoiced" sortCol={debtRepSortCol} sortDir={debtRepSortDir} onSort={handleDebtRepSort}>إجمالي الفواتير</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedDebtReps.map((r, i) => {
                          const rank = [...(debt?.by_rep||[])].sort((a,b) => b.total_balance - a.total_balance).findIndex(x => x.salesrep_name === r.salesrep_name) + 1;
                          return (
                            <tr key={r.salesrep_name + i}>
                              <td className="sm-td-rank">{rank}</td>
                              <td className="sm-td-name">{r.salesrep_name}</td>
                              <td className="sm-td-num sm-td-red">{fmtCurrency(r.total_balance)}</td>
                              <td className="sm-td-num">
                                <div className="sm-debt-pct-wrap">
                                  <div className="sm-debt-pct-bar" style={{ width: `${r.pct_of_total}%` }} />
                                  <span>{r.pct_of_total}%</span>
                                </div>
                              </td>
                              <td className="sm-td-num sm-td-muted">{fmtCurrency(r.total_invoiced)}</td>
                            </tr>
                          );
                        })}
                        {sortedDebtReps.length === 0 && (
                          <tr><td colSpan={5} className="sm-empty">لا توجد بيانات</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
