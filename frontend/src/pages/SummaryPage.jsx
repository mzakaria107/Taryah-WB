import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import * as XLSX from 'xlsx';
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
  return Number(n).toLocaleString('en-SA', { maximumFractionDigits: decimals });
}
function fmtCurrency(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-SA', { maximumFractionDigits: 0 }) + ' ر.س';
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
function BarChart({ rows, valueKey, labelKey, colorClass = 'sm-bar--primary', maxBars = 12, onLabelClick }) {
  const capped = rows.slice(0, maxBars);
  const max    = Math.max(...capped.map(r => Number(r[valueKey]) || 0), 1);
  return (
    <div className="sm-barchart">
      {capped.map((r, i) => {
        const val = Number(r[valueKey]) || 0;
        const pct = (val / max * 100).toFixed(1);
        return (
          <div key={i} className="sm-barchart__row">
            <span
              className={`sm-barchart__label${onLabelClick ? ' sm-barchart__label--link' : ''}`}
              title={r[labelKey]}
              onClick={onLabelClick ? () => onLabelClick(r) : undefined}
            >
              {r[labelKey]}
            </span>
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
  const navigate = useNavigate();
  /* ── Filter state ─────────────────────────────────────── */
  const [year,         setYear]         = useState(currentYear);
  const [month,        setMonth]        = useState(currentMonth);
  const [branchName,   setBranchName]   = useState('');
  const [repName,      setRepName]      = useState('');
  const [customerType, setCustomerType] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [filterFrom,   setFilterFrom]   = useState('');
  const [filterTo,     setFilterTo]     = useState('');
  const [activeTab,  setActiveTab]  = useState('overview'); // overview | regions | reps | debt
  const [excludeCarrefour, setExcludeCarrefour] = useState(false);
  const [excludeZeroReps, setExcludeZeroReps] = useState(false);

  /* ── Rep sort ─────────────────────────────────────────── */
  const [repSortCol, setRepSortCol] = useState('total_qty');
  const [repSortDir, setRepSortDir] = useState('desc');
  const handleRepSort = useCallback(col => {
    setRepSortCol(c => {
      if (c === col) { setRepSortDir(d => d === 'desc' ? 'asc' : 'desc'); return col; }
      setRepSortDir('desc'); return col;
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
  if (branchName)   params.set('branch_name',    branchName);
  if (repName)      params.set('salesrep_name',  repName);
  if (customerType) params.set('cust_category',  customerType);
  if (categoryName) params.set('item_category_en', categoryName);
  if (filterFrom)   params.set('date_from',       filterFrom);
  if (filterTo)     params.set('date_to',         filterTo);
  if (excludeCarrefour) params.set('exclude_carrefour', '1');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['summary', year, month, branchName, repName, customerType, categoryName, filterFrom, filterTo, excludeCarrefour],
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
    const rows = excludeZeroReps
      ? data.debt.by_rep.filter(r => Number(r.total_balance) !== 0)
      : data.debt.by_rep;
    return [...rows].sort((a, b) => Number(b.total_balance) - Number(a.total_balance));
  }, [data, excludeZeroReps]);

  /* ── Debt export/print (summary + per-rep invoice detail) ── */
  const [debtExportBusy, setDebtExportBusy] = useState(null); // null | 'excel' | 'print'
  const [printingDebtDetail, setPrintingDebtDetail] = useState(false);
  const [debtDetailPrintData, setDebtDetailPrintData] = useState(null);

  async function fetchDebtInvoices() {
    const res = await client.get(`/summary/debt/invoices?${params}`);
    return res.data?.rows || [];
  }

  async function handleExportDebtExcel() {
    setDebtExportBusy('excel');
    try {
      const invoices = await fetchDebtInvoices();
      const repNamesInView = new Set(sortedDebtReps.map(r => r.salesrep_name));
      const filteredInvoices = invoices.filter(inv => repNamesInView.has(inv.salesrep_name));

      const summaryAoa = [
        ['#', 'المندوب', 'رصيد الديون', 'النسبة %', 'إجمالي الفواتير'],
        ...sortedDebtReps.map((r, i) => [i + 1, r.salesrep_name, Number(r.total_balance), r.pct_of_total, Number(r.total_invoiced)]),
        [],
        ['', `الإجمالي (${sortedDebtReps.length} مندوب)`,
          sortedDebtReps.reduce((s, r) => s + Number(r.total_balance || 0), 0), '',
          sortedDebtReps.reduce((s, r) => s + Number(r.total_invoiced || 0), 0)],
      ];
      const wsSummary = XLSX.utils.aoa_to_sheet(summaryAoa);

      const detailAoa = [
        ['المندوب', 'العميل', 'كود العميل', 'رقم الفاتورة', 'تاريخ الفاتورة', 'قيمة الفاتورة', 'المدفوع', 'الرصيد', 'الحالة'],
        ...filteredInvoices.map(inv => [
          inv.salesrep_name, inv.customer_name, inv.customer_id, inv.invoice_number,
          inv.invoice_date || '', Number(inv.original_amount), Number(inv.paid_amount), Number(inv.balance), inv.status,
        ]),
      ];
      const wsDetail = XLSX.utils.aoa_to_sheet(detailAoa);

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, wsSummary, 'ملخص المناديب');
      XLSX.utils.book_append_sheet(wb, wsDetail, 'تفاصيل الفواتير');
      XLSX.writeFile(wb, `مديونية_المناديب_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      window.alert('حدث خطأ أثناء تصدير ملف الإكسيل');
    } finally {
      setDebtExportBusy(null);
    }
  }

  async function handlePrintDebtDetail() {
    setDebtExportBusy('print');
    try {
      const invoices = await fetchDebtInvoices();
      const repNamesInView = new Set(sortedDebtReps.map(r => r.salesrep_name));
      const filteredInvoices = invoices.filter(inv => repNamesInView.has(inv.salesrep_name));
      setDebtDetailPrintData({ invoices: filteredInvoices });
      setPrintingDebtDetail(true);
    } catch (e) {
      window.alert('حدث خطأ أثناء تجهيز التقرير للطباعة');
      setDebtExportBusy(null);
    }
  }

  useEffect(() => {
    if (!printingDebtDetail || !debtDetailPrintData) return;
    document.body.classList.add('sm-printing-debt-detail');
    const prevTitle = document.title;
    document.title = `مديونية المناديب - ${monthName} ${year}`;
    window.print();
    window.onafterprint = () => {
      document.body.classList.remove('sm-printing-debt-detail');
      document.title = prevTitle;
      setPrintingDebtDetail(false);
      setDebtDetailPrintData(null);
      setDebtExportBusy(null);
      window.onafterprint = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printingDebtDetail, debtDetailPrintData]);

  const debtDetailByRep = useMemo(() => {
    if (!debtDetailPrintData) return [];
    const map = new Map();
    for (const inv of debtDetailPrintData.invoices) {
      const key = inv.salesrep_name || 'غير محدد';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(inv);
    }
    return sortedDebtReps.map(r => ({ rep: r, invoices: map.get(r.salesrep_name) || [] }));
  }, [debtDetailPrintData, sortedDebtReps]);

  /* ── Handle branch change ─────────────────────────────── */
  function handleBranchChange(v) {
    setBranchName(v);
    setRepName('');  // reset rep when branch changes
  }

  /* ── Handle date-from: also sync year/month dropdowns ─── */
  function handleFilterFrom(val) {
    setFilterFrom(val);
    if (val) {
      const d = new Date(val);
      if (!isNaN(d)) {
        setYear(d.getFullYear());
        setMonth(d.getMonth() + 1);
      }
    }
  }

  /* ── Reset filters ─────────────────────────────────────── */
  function resetFilters() {
    setBranchName('');
    setRepName('');
    setCustomerType('');
    setCategoryName('');
    setFilterFrom('');
    setFilterTo('');
  }

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
  const asp  = data?.asp;

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
        <div className="sm-filter-group">
          <label>النوع</label>
          <select value={customerType} onChange={e => setCustomerType(e.target.value)}>
            <option value="">الكل</option>
            {(filters?.customerCategories || []).map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="sm-filter-group">
          <label>فئة الأصناف</label>
          <select value={categoryName} onChange={e => setCategoryName(e.target.value)}>
            <option value="">جميع الفئات</option>
            {(filters?.categories || []).map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        {/* ── Date range inputs ─────────────────────────── */}
        <div className="sm-filter-divider" />
        <div className="sm-filter-group">
          <label>من تاريخ</label>
          <input
            type="date"
            value={filterFrom}
            onChange={e => handleFilterFrom(e.target.value)}
            className="sm-filter-date"
          />
        </div>
        <div className="sm-filter-group">
          <label>إلى تاريخ</label>
          <input
            type="date"
            value={filterTo}
            min={filterFrom || undefined}
            onChange={e => setFilterTo(e.target.value)}
            className="sm-filter-date"
          />
        </div>

        {(branchName || repName || customerType || categoryName || filterFrom || filterTo) && (
          <button className="sm-btn sm-btn--ghost sm-no-print" onClick={resetFilters}>✕ إعادة تعيين</button>
        )}
      </div>

      {/* ── Active date-range badge ───────────────────────── */}
      {(filterFrom || filterTo) && (
        <div className="sm-date-range-badge sm-no-print">
          <span>📅 فلتر التاريخ:</span>
          <span className="sm-date-range-from">
            {filterFrom ? new Date(filterFrom + 'T00:00:00').toLocaleDateString('ar-SA-u-nu-latn', { day: '2-digit', month: 'long', year: 'numeric' }) : '…'}
          </span>
          <span className="sm-date-range-sep">←</span>
          <span className="sm-date-range-to">
            {filterTo ? new Date(filterTo + 'T00:00:00').toLocaleDateString('ar-SA-u-nu-latn', { day: '2-digit', month: 'long', year: 'numeric' }) : '…'}
          </span>
          {filterFrom && filterTo && (() => {
            const days = Math.round((new Date(filterTo) - new Date(filterFrom)) / 86400000) + 1;
            return <span className="sm-date-range-days">({days} يوم)</span>;
          })()}
          <button className="sm-date-range-clear" onClick={() => { setFilterFrom(''); setFilterTo(''); }}>✕</button>
        </div>
      )}

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
            {(filterFrom || filterTo) ? (
              <>
                <span className="sm-period-cur sm-period-cur--range">
                  {filterFrom
                    ? new Date(filterFrom + 'T00:00:00').toLocaleDateString('ar-SA-u-nu-latn', { day: '2-digit', month: 'long' })
                    : '…'}
                  {' — '}
                  {filterTo
                    ? new Date(filterTo + 'T00:00:00').toLocaleDateString('ar-SA-u-nu-latn', { day: '2-digit', month: 'long', year: 'numeric' })
                    : '…'}
                </span>
                <span className="sm-period-vs">التحصيل في هذه الفترة</span>
                <span className="sm-period-wd">· مقارنة بالشهر: {prevMonthName}</span>
              </>
            ) : (
              <>
                <span className="sm-period-cur">{monthName} {year}</span>
                <span className="sm-period-vs">مقارنةً بـ</span>
                <span className="sm-period-prev">{prevMonthName} {month === 1 ? year - 1 : year}</span>
                <span className="sm-period-wd">· أيام العمل: {data.meta.working_days_cur}</span>
              </>
            )}
          </div>

          {/* ── KPI Row 1: Customers ─────────────────────── */}
          <div className="sm-section-title">العملاء</div>
          <div className="sm-kpi-row">
            <KpiCard
              icon="🟢"
              accent="green"
              label="العملاء المتعاملون"
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
              sub={`كانوا نشطين في ${prevMonthName} وغابوا هذا الشهر`}
            />
            <KpiCard
              icon="🆕"
              accent="blue"
              label="العملاء الجدد"
              value={fmt(data.new_customers)}
              sub={`أول ظهور لهم في ${monthName} ${year}`}
            />
            <KpiCard
              icon="⚪"
              accent="muted"
              label="غير المتعاملين (كمية ≤ 0)"
              value={fmt(s?.cur?.inactive_customers)}
              sub="لديهم فواتير لكن صافي الكمية صفر أو سالب"
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

          {/* ── KPI Row 4: ASP ─────────────────────────────
              متوسط السعر العام، ومتوسط السعر بعد استبعاد المقطعات ودجاج
              المجمد — نفس نطاق فلاتر الصفحة (منطقة/مندوب/فئة عميل). */}
          <div className="sm-section-title">متوسط السعر</div>
          <div className="sm-kpi-row">
            <KpiCard
              icon="💵"
              accent="blue"
              label="متوسط السعر العام للمناطق"
              value={asp?.cur?.asp != null ? `${fmt(asp.cur.asp, 2)} ر.س` : '—'}
              sub={`الشهر الماضي: ${asp?.prev?.asp != null ? `${fmt(asp.prev.asp, 2)} ر.س` : '—'}`}
              deviation={asp?.deviation_pct}
            />
            <KpiCard
              icon="🐔"
              accent="blue"
              label="متوسط السعر بدون مقطعات وبدون دجاج مجمد"
              value={asp?.cur?.asp_ex_parts_frozen != null ? `${fmt(asp.cur.asp_ex_parts_frozen, 2)} ر.س` : '—'}
              sub={`الشهر الماضي: ${asp?.prev?.asp_ex_parts_frozen != null ? `${fmt(asp.prev.asp_ex_parts_frozen, 2)} ر.س` : '—'}`}
              deviation={asp?.deviation_pct_ex}
            />
          </div>

          {/* ── Detailed per-region ASP card ───────────────
              Each region's own overall ASP and its "بدون مقطعات وبدون
              دجاج مجمد" reading side by side, so a region dragging the
              company average down (or up) is visible at a glance instead
              of hiding inside the two blended KPI cards above. */}
          <div className="sm-table-wrap">
            <table className="sm-table">
              <thead>
                <tr>
                  <th>المنطقة</th>
                  <th>متوسط السعر العام</th>
                  <th>الشهر الماضي</th>
                  <th>الانحراف</th>
                  <th>بدون مقطعات وبدون مجمد</th>
                  <th>الشهر الماضي</th>
                  <th>الانحراف</th>
                </tr>
              </thead>
              <tbody>
                {[...(data.regions || [])]
                  .sort((a, b) => (b.asp ?? -1) - (a.asp ?? -1))
                  .map((r, i) => {
                    const dev = r.prev_asp > 0 && r.asp != null
                      ? +((r.asp - r.prev_asp) / r.prev_asp * 100).toFixed(1) : null;
                    const devEx = r.prev_asp_ex_parts_frozen > 0 && r.asp_ex_parts_frozen != null
                      ? +((r.asp_ex_parts_frozen - r.prev_asp_ex_parts_frozen) / r.prev_asp_ex_parts_frozen * 100).toFixed(1)
                      : null;
                    return (
                      <tr key={i}>
                        <td className="sm-td-name">{r.branch_name}</td>
                        <td className="sm-td-num">{r.asp != null ? `${fmt(r.asp, 2)} ر.س` : <span className="sm-dash">—</span>}</td>
                        <td className="sm-td-num sm-td-muted">{r.prev_asp != null ? `${fmt(r.prev_asp, 2)} ر.س` : <span className="sm-dash">—</span>}</td>
                        <td className="sm-td-num"><DevBadge pct={dev} /></td>
                        <td className="sm-td-num">{r.asp_ex_parts_frozen != null ? `${fmt(r.asp_ex_parts_frozen, 2)} ر.س` : <span className="sm-dash">—</span>}</td>
                        <td className="sm-td-num sm-td-muted">{r.prev_asp_ex_parts_frozen != null ? `${fmt(r.prev_asp_ex_parts_frozen, 2)} ر.س` : <span className="sm-dash">—</span>}</td>
                        <td className="sm-td-num"><DevBadge pct={devEx} /></td>
                      </tr>
                    );
                  })}
                {(data.regions || []).length === 0 && (
                  <tr><td colSpan={7} className="sm-empty">لا توجد بيانات</td></tr>
                )}
              </tbody>
            </table>
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
                      <Th col="daily_avg_qty"    sortCol={repSortCol} sortDir={repSortDir} onSort={handleRepSort}>متوسط مبيعات يومي</Th>
                      <Th col="prev_qty"         sortCol={repSortCol} sortDir={repSortDir} onSort={handleRepSort}>الشهر الماضي</Th>
                      <th>الانحراف</th>
                      <Th col="active_customers" sortCol={repSortCol} sortDir={repSortDir} onSort={handleRepSort}>العملاء</Th>
                      <Th col="total_visits"     sortCol={repSortCol} sortDir={repSortDir} onSort={handleRepSort}>إجمالي الزيارات</Th>
                      <Th col="avg_visits"       sortCol={repSortCol} sortDir={repSortDir} onSort={handleRepSort}>متوسط الزيارات</Th>
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
                          <td className="sm-td-num sm-td-muted">{fmt(r.daily_avg_qty, 1)}</td>
                          <td className="sm-td-num sm-td-muted">{fmt(r.prev_qty)}</td>
                          <td className="sm-td-num"><DevBadge pct={dev} /></td>
                          <td className="sm-td-num">{fmt(r.active_customers)}</td>
                          <td className="sm-td-num">{fmt(r.total_visits)}</td>
                          <td className="sm-td-num sm-td-muted">{fmt(r.avg_visits, 1)}</td>
                          <td className="sm-td-num">{r.total_returns > 0 ? fmt(r.total_returns) : <span className="sm-dash">—</span>}</td>
                          <td className="sm-td-num">{retPct > 0 ? <span className="sm-ret-badge">{retPct}%</span> : <span className="sm-dash">—</span>}</td>
                        </tr>
                      );
                    })}
                    {sortedReps.length === 0 && (
                      <tr><td colSpan={12} className="sm-empty">لا توجد بيانات</td></tr>
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
                  <span className="sm-debt-summary__label">
                    إجمالي الديون القائمة
                    {(filterFrom || filterTo) && (
                      <span className="sm-debt-summary__period">
                        {' '}(فواتير {filterFrom ? new Date(filterFrom + 'T00:00:00').toLocaleDateString('ar-SA-u-nu-latn', { day: '2-digit', month: 'short' }) : '…'}
                        {' '}← {filterTo ? new Date(filterTo + 'T00:00:00').toLocaleDateString('ar-SA-u-nu-latn', { day: '2-digit', month: 'short', year: 'numeric' }) : '…'})
                      </span>
                    )}
                  </span>
                  <span className="sm-debt-summary__value">{fmtCurrency(debt?.grand_balance)}</span>
                </div>
                <button
                  type="button"
                  className={`sm-carrefour-toggle${excludeCarrefour ? ' sm-carrefour-toggle--active' : ''}`}
                  onClick={() => setExcludeCarrefour(v => !v)}
                  title={excludeCarrefour ? 'إظهار مديونية كارفور ضمن الإجمالي' : 'إخفاء مديونية كارفور من الإجمالي'}
                >
                  {excludeCarrefour ? '✅ مديونية كارفور مستبعدة' : '🚫 استبعاد مديونية كارفور'}
                </button>
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
                      {(debt?.by_region || []).length > 0 && (
                        <tfoot>
                          <tr className="sm-tf-row">
                            <td className="sm-td-name">الإجمالي</td>
                            <td className="sm-td-num sm-td-red">
                              {fmtCurrency((debt?.by_region || []).reduce((s, r) => s + Number(r.total_balance || 0), 0))}
                            </td>
                            <td className="sm-td-num">100%</td>
                            <td className="sm-td-num sm-td-muted">
                              {fmtCurrency((debt?.by_region || []).reduce((s, r) => s + Number(r.total_invoiced || 0), 0))}
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>

                {/* By rep */}
                <div>
                  <div className="sm-chart-card">
                    <div className="sm-chart-card__title sm-chart-card__title--row">
                      <span>أعلى المناديب ديوناً (أعلى 10)</span>
                      <div className="sm-chart-card__title-actions">
                        <button
                          type="button"
                          className={`sm-carrefour-toggle${excludeZeroReps ? ' sm-carrefour-toggle--active' : ''}`}
                          onClick={() => setExcludeZeroReps(v => !v)}
                          title={excludeZeroReps ? 'إظهار المناديب بقيم صفرية' : 'إخفاء المناديب بقيم صفرية من القائمة'}
                        >
                          {excludeZeroReps ? '✅ المناديب الصفرية مستبعدة' : '🚫 استبعاد المناديب بقيم صفرية'}
                        </button>
                        <button
                          type="button"
                          className="sm-carrefour-toggle"
                          onClick={handleExportDebtExcel}
                          disabled={!!debtExportBusy}
                          title="تصدير ملخص المناديب وتفاصيل فواتير كل مندوب في ملف إكسيل واحد"
                        >
                          {debtExportBusy === 'excel' ? '⏳ جاري التصدير...' : '📥 تصدير Excel'}
                        </button>
                        <button
                          type="button"
                          className="sm-carrefour-toggle"
                          onClick={handlePrintDebtDetail}
                          disabled={!!debtExportBusy}
                          title="طباعة ملخص المناديب مع تفاصيل فواتير كل مندوب"
                        >
                          {debtExportBusy === 'print' ? '⏳ جاري التجهيز...' : '🖨️ طباعة بالتفاصيل'}
                        </button>
                      </div>
                    </div>
                    <BarChart
                      rows={sortedDebtReps.slice(0, 10)}
                      valueKey="total_balance"
                      labelKey="salesrep_name"
                      colorClass="sm-bar--danger"
                      maxBars={10}
                      onLabelClick={r => navigate(`/rep-debt/${encodeURIComponent(r.salesrep_name)}`)}
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
                        <col style={{ width: '60px' }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>المندوب</th>
                          <th>رصيد الديون <span className="sm-sort sm-sort--active"> ▼</span></th>
                          <th>النسبة %</th>
                          <th>إجمالي الفواتير</th>
                          <th>التفاصيل</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedDebtReps.map((r, i) => {
                          const rank = [...(debt?.by_rep||[])].sort((a,b) => b.total_balance - a.total_balance).findIndex(x => x.salesrep_name === r.salesrep_name) + 1;
                          return (
                            <tr key={r.salesrep_name + i}>
                              <td className="sm-td-rank">{rank}</td>
                              <td
                                className="sm-td-name sm-td-name--link"
                                onClick={() => navigate(`/rep-debt/${encodeURIComponent(r.salesrep_name)}`)}
                                title="عرض تفاصيل مديونية المندوب"
                              >
                                {r.salesrep_name}
                              </td>
                              <td className="sm-td-num sm-td-red">{fmtCurrency(r.total_balance)}</td>
                              <td className="sm-td-num">
                                <div className="sm-debt-pct-wrap">
                                  <div className="sm-debt-pct-bar" style={{ width: `${r.pct_of_total}%` }} />
                                  <span>{r.pct_of_total}%</span>
                                </div>
                              </td>
                              <td className="sm-td-num sm-td-muted">{fmtCurrency(r.total_invoiced)}</td>
                              <td className="sm-td-num">
                                <button
                                  type="button"
                                  className="sm-detail-btn"
                                  onClick={() => navigate(`/rep-debt/${encodeURIComponent(r.salesrep_name)}`)}
                                  title="عرض تفاصيل مديونية المندوب"
                                >
                                  <ExternalLink size={13} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {sortedDebtReps.length === 0 && (
                          <tr><td colSpan={6} className="sm-empty">لا توجد بيانات</td></tr>
                        )}
                      </tbody>
                      {sortedDebtReps.length > 0 && (
                        <tfoot>
                          <tr className="sm-tf-row">
                            <td></td>
                            <td className="sm-td-name">الإجمالي ({sortedDebtReps.length} مندوب)</td>
                            <td className="sm-td-num sm-td-red">
                              {fmtCurrency(sortedDebtReps.reduce((s, r) => s + Number(r.total_balance || 0), 0))}
                            </td>
                            <td className="sm-td-num">
                              {(+sortedDebtReps.reduce((s, r) => s + Number(r.pct_of_total || 0), 0).toFixed(1))}%
                            </td>
                            <td className="sm-td-num sm-td-muted">
                              {fmtCurrency(sortedDebtReps.reduce((s, r) => s + Number(r.total_invoiced || 0), 0))}
                            </td>
                            <td></td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Debt detail print-only block (summary + per-rep invoices) ── */}
      {debtDetailPrintData && (
        <div className="sm-debt-detail-print-only">
          <div className="sm-print-title">تقرير مديونية المناديب — التفاصيل الكاملة</div>
          <div className="sm-print-sub">
            {monthName} {year}
            {branchName ? ` · المنطقة: ${branchName}` : ''}
            {excludeCarrefour ? ' · مديونية كارفور مستبعدة' : ''}
            {excludeZeroReps ? ' · المناديب الصفرية مستبعدة' : ''}
          </div>

          <table className="sm-table" style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>#</th><th>المندوب</th><th>رصيد الديون</th><th>النسبة %</th><th>إجمالي الفواتير</th>
              </tr>
            </thead>
            <tbody>
              {sortedDebtReps.map((r, i) => (
                <tr key={r.salesrep_name + i}>
                  <td>{i + 1}</td>
                  <td>{r.salesrep_name}</td>
                  <td>{fmtCurrency(r.total_balance)}</td>
                  <td>{r.pct_of_total}%</td>
                  <td>{fmtCurrency(r.total_invoiced)}</td>
                </tr>
              ))}
            </tbody>
            {sortedDebtReps.length > 0 && (
              <tfoot>
                <tr className="sm-tf-row">
                  <td></td>
                  <td>الإجمالي ({sortedDebtReps.length} مندوب)</td>
                  <td>{fmtCurrency(sortedDebtReps.reduce((s, r) => s + Number(r.total_balance || 0), 0))}</td>
                  <td>{(+sortedDebtReps.reduce((s, r) => s + Number(r.pct_of_total || 0), 0).toFixed(1))}%</td>
                  <td>{fmtCurrency(sortedDebtReps.reduce((s, r) => s + Number(r.total_invoiced || 0), 0))}</td>
                </tr>
              </tfoot>
            )}
          </table>

          {debtDetailByRep.map(({ rep, invoices }) => (
            <div key={rep.salesrep_name} className="sm-debt-detail-rep-block">
              <div className="sm-debt-detail-rep-title">
                {rep.salesrep_name} — {fmtCurrency(rep.total_balance)}
              </div>
              <table className="sm-table">
                <thead>
                  <tr>
                    <th>العميل</th><th>رقم الفاتورة</th><th>التاريخ</th>
                    <th>قيمة الفاتورة</th><th>المدفوع</th><th>الرصيد</th><th>الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv, i) => (
                    <tr key={inv.invoice_number + i}>
                      <td>{inv.customer_name}</td>
                      <td>{inv.invoice_number}</td>
                      <td>{inv.invoice_date}</td>
                      <td>{fmtCurrency(inv.original_amount)}</td>
                      <td>{fmtCurrency(inv.paid_amount)}</td>
                      <td>{fmtCurrency(inv.balance)}</td>
                      <td>{inv.status}</td>
                    </tr>
                  ))}
                  {invoices.length === 0 && (
                    <tr><td colSpan={7} className="sm-empty">لا توجد فواتير</td></tr>
                  )}
                </tbody>
                {invoices.length > 0 && (
                  <tfoot>
                    <tr className="sm-tf-row">
                      <td>الإجمالي ({invoices.length} فاتورة)</td>
                      <td></td>
                      <td></td>
                      <td>{fmtCurrency(invoices.reduce((s, inv) => s + Number(inv.original_amount || 0), 0))}</td>
                      <td>{fmtCurrency(invoices.reduce((s, inv) => s + Number(inv.paid_amount || 0), 0))}</td>
                      <td>{fmtCurrency(invoices.reduce((s, inv) => s + Number(inv.balance || 0), 0))}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
