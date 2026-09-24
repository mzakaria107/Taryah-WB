import React, { useState, useMemo, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer, ClockArrowUp, X, ExternalLink, ChevronUp, ChevronDown, ChevronsUpDown, FileSpreadsheet, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import api from '../api/client';
import './AgingPage.css';

/* ── Helpers ─────────────────────────────────────────────────── */
const fmt = n =>
  n == null ? '—' : Number(n).toLocaleString('en-SA', { maximumFractionDigits: 0 });
const fmtDate = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('ar-SA-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
// NetSuite SuiteQL returns dates as "31/3/2026" (D/M/YYYY), not ISO
const fmtNsDate = s => {
  if (!s) return '—';
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return fmtDate(s);
  return fmtDate(`${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`);
};

const BUCKETS = [
  { key: 'b_1_15',    label: '1-15 يوم',      cls: 'age-cell--b1', badge: 'age-badge--b1' },
  { key: 'b_16_30',   label: '16-30 يوم',     cls: 'age-cell--b2', badge: 'age-badge--b2' },
  { key: 'b_31_60',   label: '31-60 يوم',     cls: 'age-cell--b3', badge: 'age-badge--b3' },
  { key: 'b_61_90',   label: '61-90 يوم',     cls: 'age-cell--b4', badge: 'age-badge--b4' },
  { key: 'b_91_120',  label: '91-120 يوم',    cls: 'age-cell--b5', badge: 'age-badge--b5' },
  { key: 'b_120_plus',label: 'أكثر من 120',   cls: 'age-cell--b6', badge: 'age-badge--b6' },
];

const KPI_COLORS = ['--b1', '--b2', '--b3', '--b4', '--b5', '--b6'];

function ageBadgeClass(days) {
  if (days <= 15)  return 'age-badge--b1';
  if (days <= 30)  return 'age-badge--b2';
  if (days <= 60)  return 'age-badge--b3';
  if (days <= 90)  return 'age-badge--b4';
  if (days <= 120) return 'age-badge--b5';
  return 'age-badge--b6';
}

function ageCellClass(days) {
  if (days <= 15)  return 'age-cell--b1';
  if (days <= 30)  return 'age-cell--b2';
  if (days <= 60)  return 'age-cell--b3';
  if (days <= 90)  return 'age-cell--b4';
  if (days <= 120) return 'age-cell--b5';
  return 'age-cell--b6';
}

/* ── Fetch ───────────────────────────────────────────────────── */
async function fetchAging(params) {
  const { data } = await api.get('/aging', { params });
  return data;
}
async function fetchInvoices(customerId) {
  const { data } = await api.get(`/aging/invoices/${customerId}`);
  return data;
}
async function fetchMeta() {
  const { data } = await api.get('/invoices/meta');
  return data;
}
async function fetchCollections(params) {
  const { data } = await api.get('/aging/collections', { params });
  return data;
}
async function resetSnapshot(date_from, date_to) {
  const { data } = await api.post('/aging/collections/reset-snapshot', { date_from, date_to });
  return data;
}
async function fetchCollectionPayments(customerId, date) {
  const { data } = await api.get(`/aging/collections/payments/${customerId}`, { params: date ? { date } : {} });
  return data;
}

/* ═══════════════════════════════════════════════════════════════
   Main Page
═══════════════════════════════════════════════════════════════ */
export default function AgingPage() {
  const qc = useQueryClient();

  /* ── Filters ─────────────────────────────────────────────────── */
  const [regionId,      setRegionId]      = useState('');
  const [routeId,       setRouteId]       = useState('');
  const [salesRep,      setSalesRep]      = useState('');
  const [search,        setSearch]        = useState('');
  const [custType,      setCustType]      = useState('');
  const [excludeDirect, setExcludeDirect] = useState(true); // ON by default
  const [sortBy,       setSortBy]       = useState('total_balance');
  const [sortDir,      setSortDir]      = useState('DESC');
  const [activeTab,    setActiveTab]    = useState('customers'); // 'customers' | 'regions' | 'collections'
  const [bucketFilter, setBucketFilter] = useState(''); // '' | b_1_15 | b_16_30 | …

  /* ── Modal state ─────────────────────────────────────────────── */
  const [modalCustomer, setModalCustomer] = useState(null); // {id, name}
  const [paymentModal, setPaymentModal] = useState(null);   // {id, name, date|null}

  /* ── Old-debt collection tracker tab — own filters, independent
       of the aging-bucket filters above (a different period concept:
       here the period selects WHICH invoices count as "old debt",
       not a snapshot date). ── */
  const [colDateFrom, setColDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 90);
    return d.toLocaleDateString('en-CA');
  });
  const [colDateTo, setColDateTo] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toLocaleDateString('en-CA');
  });
  const [colRegionId, setColRegionId] = useState('');
  const [colSalesRep, setColSalesRep] = useState('');

  /* ── Meta (routes + reps lists) ─────────────────────────────── */
  const { data: meta } = useQuery({
    queryKey: ['meta'],
    queryFn:  fetchMeta,
    staleTime: 300_000,
  });

  /* Carrefour: one hypermarket group, 13 branches, ~560K of the open balance
     on long agreed terms — big enough to dominate the ageing buckets. OFF by
     default: it is real debt, and hiding it unasked would understate the book.
     ONE switch drives both the ageing tabs and the old-debt tracker, so the
     tabs can never show contradictory totals. Matching is on the Arabic name
     pattern ("كارفور الرياض بارك") plus the English column server-side —
     invoices.branch_name carries no literal "Carrefour" value. */
  const [excludeCarrefour, setExcludeCarrefour] = useState(false);

  /* ── Query ───────────────────────────────────────────────────── */
  const qParams = useMemo(() => {
    const p = { sort_by: sortBy, sort_dir: sortDir, limit: 1000 };
    if (regionId)   p.region_id      = regionId;
    if (routeId)    p.route_id       = routeId;
    if (salesRep)   p.sales_rep_name = salesRep;
    if (search)     p.search         = search;
    // excludeDirect overrides the manual custType filter
    if (excludeDirect)  p.customer_type = 'route';
    else if (custType)  p.customer_type = custType;
    if (excludeCarrefour) p.exclude_carrefour = '1';
    return p;
  }, [regionId, routeId, salesRep, search, custType, excludeDirect, excludeCarrefour, sortBy, sortDir]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['aging', qParams],
    queryFn:  () => fetchAging(qParams),
    keepPreviousData: true,
    staleTime: 120_000,
  });

  /* ── Sort handler ────────────────────────────────────────────── */
  const handleSort = useCallback(col => {
    if (sortBy === col) setSortDir(d => d === 'DESC' ? 'ASC' : 'DESC');
    else { setSortBy(col); setSortDir('DESC'); }
  }, [sortBy]);

  /* ── Computed totals for footer ──────────────────────────────── */
  const kpis = data?.kpis || {};
  const total = parseFloat(kpis.total_balance || 0);

  /* ── Bucket filter — applied on already-fetched customers ────── */
  const filteredCustomers = useMemo(() => {
    const all = data?.customers || [];
    if (!bucketFilter) return all;
    return all.filter(c => parseFloat(c[bucketFilter] || 0) > 0);
  }, [data?.customers, bucketFilter]);

  /* ── Old-debt collection tracker query ────────────────────────── */
  const colParams = useMemo(() => {
    const p = { date_from: colDateFrom, date_to: colDateTo };
    if (colRegionId) p.region_id      = colRegionId;
    if (colSalesRep) p.sales_rep_name = colSalesRep;
    if (excludeCarrefour) p.exclude_carrefour = '1';
    return p;
  }, [colDateFrom, colDateTo, colRegionId, colSalesRep, excludeCarrefour]);

  const { data: colData, isLoading: colLoading, isError: colError } = useQuery({
    queryKey: ['aging-collections', colParams],
    queryFn:  () => fetchCollections(colParams),
    enabled:  activeTab === 'collections' && !!colDateFrom && !!colDateTo,
    keepPreviousData: true,
    staleTime: 60_000,
  });

  // Customers whose frozen snapshot ("دين الفواتير") is zero — their old
  // invoices were already fully settled by the time the snapshot was
  // taken, so they add no useful signal to a collection-progress report.
  const [excludeZeroDebt, setExcludeZeroDebt] = useState(false);
  const colCustomersVisible = useMemo(() => {
    let list = colData?.customers || [];
    if (excludeCarrefour) list = list.filter(c => !(c.customer_name || '').includes('كارفور'));
    if (excludeZeroDebt)  list = list.filter(c => parseFloat(c.total_debt || 0) > 0);
    return list;
  }, [colData, excludeCarrefour, excludeZeroDebt]);

  // Pivot the flat {customer_id, pay_date, amount} payment list into a
  // sparse day axis (only days with ANY collection activity, not every
  // calendar day — with a 90-day window that could otherwise mean ~90
  // mostly-empty columns) plus a lookup map for O(1) per-cell reads.
  // Scoped to the currently-visible customer set so the Carrefour
  // toggle also affects the daily columns/totals, not just the rows.
  const colMatrix = useMemo(() => {
    if (!colData) return null;
    const visibleIds = new Set(colCustomersVisible.map(c => c.customer_id));
    const relevantPayments = colData.payments.filter(pm => visibleIds.has(pm.customer_id));
    const days = [...new Set(relevantPayments.map(pm => pm.pay_date))].sort();
    const byCustDay = {};
    const dayTotals = {};
    relevantPayments.forEach(pm => {
      byCustDay[`${pm.customer_id}-${pm.pay_date}`] = Number(pm.amount);
      dayTotals[pm.pay_date] = (dayTotals[pm.pay_date] || 0) + Number(pm.amount);
    });
    return { days, byCustDay, dayTotals };
  }, [colData, colCustomersVisible]);

  const colIsDirty = colRegionId || colSalesRep || excludeCarrefour || excludeZeroDebt;
  const handleColReset = () => { setColRegionId(''); setColSalesRep(''); setExcludeCarrefour(false); setExcludeZeroDebt(false); };

  /* ── Re-open the frozen "دين الفواتير" baseline for the period on
     screen — deletes it from old_debt_snapshots so the next fetch
     re-freezes every customer in this exact period at today's live
     balance. Confirmed first: it discards the "collected since" reference
     point for the WHOLE period, not just the filtered rows on screen. ── */
  const [snapResetting, setSnapResetting] = useState(false);
  const handleResetSnapshot = async () => {
    if (!window.confirm(
      `سيتم تحديث اللقطة الثابتة للفترة ${colDateFrom} → ${colDateTo} إلى أرصدة اليوم — ` +
      'سيُفقد مرجع "تحصّل كذا منذ اللقطة" الحالي لكل عملاء هذه الفترة (وليس فقط المعروضين بالفلتر الحالي). متابعة؟'
    )) return;
    setSnapResetting(true);
    try {
      await resetSnapshot(colDateFrom, colDateTo);
      await qc.invalidateQueries({ queryKey: ['aging-collections'] });
    } catch (err) {
      alert(err.response?.data?.error || 'تعذّر تحديث اللقطة');
    } finally {
      setSnapResetting(false);
    }
  };

  /* ── Reset ───────────────────────────────────────────────────── */
  const isDirty = regionId || routeId || salesRep || search || custType;
  const handleReset = () => { setRegionId(''); setRouteId(''); setSalesRep(''); setSearch(''); setCustType(''); };

  /* ── Print ───────────────────────────────────────────────────── */
  const handlePrint = () => {
    const prev = document.title;
    document.title = 'أعمار المديونيات';
    window.print();
    window.onafterprint = () => { document.title = prev; };
  };

  /* ── Excel export — exports whichever tab is currently active ── */
  const handleExportCollections = () => {
    if (!colCustomersVisible.length) return;
    const wb = XLSX.utils.book_new();
    const days = colMatrix?.days || [];
    const fmtDayHeader = iso => {
      const d = new Date(iso + 'T12:00:00');
      return d.toLocaleDateString('ar-SA-u-nu-latn', { month: 'short', day: 'numeric' });
    };

    const header = [
      'العميل', 'المندوب', 'المنطقة',
      'دين الفواتير (لقطة ثابتة)', 'عدد الفواتير غير المسددة',
      ...days.map(fmtDayHeader),
      'الرصيد الحالي',
    ];
    const rows = colCustomersVisible.flatMap(c => {
      const mainRow = [
        c.customer_name, c.sales_rep_name || '', c.region_name || '',
        parseFloat(c.total_debt || 0), parseInt(c.unpaid_count || 0, 10),
        ...days.map(d => colMatrix.byCustDay[`${c.customer_id}-${d}`] || 0),
        parseFloat(c.current_balance || 0),
      ];
      const isSplit = activeRepShareCount(c.rep_breakdown) > 1;
      const repRows = isSplit ? mergeRepBreakdown(c.rep_breakdown).map(rb => [
        `  └ ${c.customer_name}`, rb.sales_rep_name, c.region_name || '',
        rb.total_debt, rb.unpaid_count,
        ...days.map(() => ''),
        rb.current_balance,
      ]) : [];
      return [mainRow, ...repRows];
    });
    const totals = colCustomersVisible.reduce((acc, c) => {
      acc.total_debt      += parseFloat(c.total_debt || 0);
      acc.unpaid_count    += parseInt(c.unpaid_count || 0, 10);
      acc.current_balance += parseFloat(c.current_balance || 0);
      return acc;
    }, { total_debt: 0, unpaid_count: 0, current_balance: 0 });
    rows.push([
      'الإجمالي', '', '',
      totals.total_debt, totals.unpaid_count,
      ...days.map(d => colMatrix.dayTotals[d] || 0),
      totals.current_balance,
    ]);

    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws['!cols'] = [
      { wch: 28 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 16 },
      ...days.map(() => ({ wch: 10 })), { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'تتبع سداد المديونية القديمة');
    XLSX.writeFile(wb, `تتبع_سداد_المديونية_القديمة_${colDateFrom}_${colDateTo}.xlsx`);
  };

  const handleExport = () => {
    if (activeTab === 'collections') { handleExportCollections(); return; }
    if (!data) return;
    const wb = XLSX.utils.book_new();

    /* ── Sheet 1: Customers matrix ── */
    const custHeader = [
      'العميل',
      '1-15 يوم', '16-30 يوم', '31-60 يوم',
      '61-90 يوم', '91-120 يوم', 'أكثر من 120',
      'نسبة التحصيل %', 'نسبة المتبقي %',
      'عمر أقدم دين (يوم)', 'إجمالي الدين', 'التغير اليومي',
    ];
    const custRows = (data.customers || []).map(c => {
      const totalAmt = parseFloat(c.total_amount || 0);
      const totalBal = parseFloat(c.total_balance || 0);
      const remRate  = totalAmt > 0 ? parseFloat((totalBal / totalAmt * 100).toFixed(1)) : 0;
      return [
        c.customer_name,
        parseFloat(c.b_1_15    || 0),
        parseFloat(c.b_16_30   || 0),
        parseFloat(c.b_31_60   || 0),
        parseFloat(c.b_61_90   || 0),
        parseFloat(c.b_91_120  || 0),
        parseFloat(c.b_120_plus|| 0),
        parseFloat(c.collection_rate || 0),
        remRate,
        parseInt(c.avg_age_days || 0),
        totalBal,
        parseFloat(c.daily_change || 0),
      ];
    });
    // Footer totals row
    const k = data.kpis || {};
    custRows.push([
      'الإجمالي',
      parseFloat(k.b_1_15 || 0), parseFloat(k.b_16_30 || 0),
      parseFloat(k.b_31_60 || 0), parseFloat(k.b_61_90 || 0),
      parseFloat(k.b_91_120 || 0), parseFloat(k.b_120_plus || 0),
      '', '', '', parseFloat(k.total_balance || 0), '',
    ]);
    const ws1 = XLSX.utils.aoa_to_sheet([custHeader, ...custRows]);
    // Column widths
    ws1['!cols'] = [
      { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 12 }, { wch: 13 }, { wch: 14 },
      { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 13 },
    ];
    XLSX.utils.book_append_sheet(wb, ws1, 'العملاء');

    /* ── Sheet 2: Region summary ── */
    const regHeader = [
      'المنطقة', '1-15 يوم', '16-30 يوم', '31-60 يوم',
      '61-90 يوم', '91-120 يوم', 'أكثر من 120',
      'إجمالي الدين', '% من الإجمالي', 'عدد العملاء',
    ];
    const grandTotal = parseFloat(k.total_balance || 0);
    const regRows = (data.by_region || []).map(r => {
      const bal = parseFloat(r.total_balance || 0);
      return [
        r.region_name || `منطقة ${r.region_id}`,
        parseFloat(r.b_1_15 || 0), parseFloat(r.b_16_30 || 0),
        parseFloat(r.b_31_60 || 0), parseFloat(r.b_61_90 || 0),
        parseFloat(r.b_91_120 || 0), parseFloat(r.b_120_plus || 0),
        bal,
        grandTotal > 0 ? parseFloat((bal / grandTotal * 100).toFixed(1)) : 0,
        r.customer_count || 0,
      ];
    });
    const ws2 = XLSX.utils.aoa_to_sheet([regHeader, ...regRows]);
    ws2['!cols'] = [
      { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 12 }, { wch: 13 }, { wch: 14 },
      { wch: 14 }, { wch: 13 }, { wch: 13 },
    ];
    XLSX.utils.book_append_sheet(wb, ws2, 'المناطق');

    /* ── Sheet 3: KPI summary ── */
    const today = data.snapshot_date || new Date().toLocaleDateString('en-CA');
    const kpiRows = [
      ['تاريخ التقرير', today],
      ['مقارنة بتاريخ', data.prev_date || '—'],
      [''],
      ['إجمالي المديونية',    parseFloat(k.total_balance || 0)],
      ['عدد العملاء',         k.customer_count || 0],
      ['عدد الفواتير',        k.invoice_count  || 0],
      [''],
      ['الفئة', 'المبلغ', '% من الإجمالي'],
      ['1-15 يوم',      parseFloat(k.b_1_15    || 0), grandTotal > 0 ? +((k.b_1_15    / grandTotal * 100).toFixed(1)) : 0],
      ['16-30 يوم',     parseFloat(k.b_16_30   || 0), grandTotal > 0 ? +((k.b_16_30   / grandTotal * 100).toFixed(1)) : 0],
      ['31-60 يوم',     parseFloat(k.b_31_60   || 0), grandTotal > 0 ? +((k.b_31_60   / grandTotal * 100).toFixed(1)) : 0],
      ['61-90 يوم',     parseFloat(k.b_61_90   || 0), grandTotal > 0 ? +((k.b_61_90   / grandTotal * 100).toFixed(1)) : 0],
      ['91-120 يوم',    parseFloat(k.b_91_120  || 0), grandTotal > 0 ? +((k.b_91_120  / grandTotal * 100).toFixed(1)) : 0],
      ['أكثر من 120 يوم', parseFloat(k.b_120_plus || 0), grandTotal > 0 ? +((k.b_120_plus / grandTotal * 100).toFixed(1)) : 0],
    ];
    const ws3 = XLSX.utils.aoa_to_sheet(kpiRows);
    ws3['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'ملخص KPI');

    XLSX.writeFile(wb, `أعمار_المديونيات_${today}.xlsx`);
  };

  /* ─────────────────────────────────────────────────────────────
     Render
  ───────────────────────────────────────────────────────────── */
  return (
    <div className="age-page">
      {/* Print header */}
      <div className="age-print-header">
        <div className="age-print-title">أعمار المديونيات</div>
        <div className="age-print-meta">
          {new Date().toLocaleDateString('ar-SA-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric' })}
          {/* A printed report that silently omits 560K of debt would mislead
              whoever reads it away from the screen — state the exclusions. */}
          {excludeDirect && <span> · مديونية المندوب مستبعدة</span>}
          {excludeCarrefour && <span> · مديونية كارفور مستبعدة</span>}
        </div>
      </div>

      {/* Page header */}
      <div className="age-header age-no-print">
        <ClockArrowUp size={24} color="#dc2626" />
        <h1 className="age-title">أعمار المديونيات</h1>
        <button
          className="age-export-btn"
          onClick={handleExport}
          disabled={activeTab === 'collections' ? !colCustomersVisible.length : !data}
          title="تصدير إلى Excel"
        >
          <FileSpreadsheet size={16} /> تصدير Excel
        </button>
        <button className="age-print-btn" onClick={handlePrint}>
          <Printer size={16} /> طباعة / PDF
        </button>
      </div>

      {/* Filters */}
      <div className="age-filters age-no-print">

        {/* ── زر استبعاد المباشر — دائم الظهور ── */}
        <button
          className={`age-exclude-direct-btn${excludeDirect ? ' age-exclude-direct-btn--on' : ''}`}
          onClick={() => setExcludeDirect(v => !v)}
        >
          <span className={`age-exclude-dot${excludeDirect ? ' age-exclude-dot--on' : ''}`} />
          {excludeDirect ? '✕ مديونية المندوب مستبعدة' : '⊕ عرض مديونية المندوب'}
        </button>

        {/* ── زر استبعاد مديونية كارفور ── */}
        <button
          className={`age-exclude-direct-btn age-exclude-carrefour-btn${excludeCarrefour ? ' age-exclude-direct-btn--on' : ''}`}
          onClick={() => setExcludeCarrefour(v => !v)}
          title="كارفور مجموعة واحدة بفروع متعددة وشروط سداد طويلة متفق عليها — استبعادها يُظهر سلوك بقية العملاء"
        >
          <span className={`age-exclude-dot${excludeCarrefour ? ' age-exclude-dot--on' : ''}`} />
          {excludeCarrefour ? '✕ مديونية كارفور مستبعدة' : '⊕ استبعاد مديونية كارفور'}
        </button>

        <div className="age-filter-group">
          <span className="age-filter-label">بحث عن عميل</span>
          <input
            className="age-filter-input"
            placeholder="اسم العميل..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="age-filter-group">
          <span className="age-filter-label">المنطقة</span>
          <select className="age-filter-select" value={regionId} onChange={e => setRegionId(e.target.value)}>
            <option value="">كل المناطق</option>
            {(data?.by_region || []).map(r => (
              <option key={r.region_id} value={r.region_id}>{r.region_name || `منطقة ${r.region_id}`}</option>
            ))}
          </select>
        </div>
        <div className="age-filter-group">
          <span className="age-filter-label">رقم الخط</span>
          <select className="age-filter-select" value={routeId} onChange={e => setRouteId(e.target.value)}>
            <option value="">كل الخطوط</option>
            {(meta?.routes || []).map(r => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        <div className="age-filter-group">
          <span className="age-filter-label">المندوب</span>
          <select className="age-filter-select" value={salesRep} onChange={e => setSalesRep(e.target.value)}>
            <option value="">كل المندوبين</option>
            {(meta?.reps || []).map(r => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        {/* نوع العميل — يُخفى إذا كان الاستبعاد مفعّلاً */}
        {!excludeDirect && (
          <div className="age-filter-group">
            <span className="age-filter-label">نوع العميل</span>
            <select className="age-filter-select" value={custType} onChange={e => setCustType(e.target.value)}>
              <option value="">الكل</option>
              <option value="route">مسارات</option>
              <option value="direct">مباشر</option>
            </select>
          </div>
        )}
        {isDirty && (
          <button className="age-filter-reset" onClick={handleReset}>إعادة تعيين</button>
        )}
      </div>

      {/* Loading / Error */}
      {isLoading && <div className="age-loading">جاري تحميل بيانات المديونيات…</div>}
      {isError   && <div className="age-loading">حدث خطأ في تحميل البيانات</div>}

      {!isLoading && !isError && data && (
        <>
          {/* ── KPI cards ────────────────────────────────────────── */}
          <div className="age-kpis">
            <div className="age-kpi-card age-kpi-card--total">
              <span className="age-kpi-label">إجمالي المديونية</span>
              <span className="age-kpi-value">{fmt(kpis.total_balance)}</span>
              <span className="age-kpi-pct" style={{ color: 'rgba(255,255,255,0.75)' }}>
                {fmt(kpis.customer_count)} عميل · {fmt(kpis.invoice_count)} فاتورة
              </span>
            </div>
            {BUCKETS.map((b, i) => {
              const val = parseFloat(kpis[b.key] || 0);
              const pct = total > 0 ? (val / total * 100).toFixed(1) : '0.0';
              return (
                <div key={b.key} className={`age-kpi-card age-kpi-card${KPI_COLORS[i]}`}>
                  <span className="age-kpi-label">{b.label}</span>
                  <span className="age-kpi-value">{fmt(val)}</span>
                  <span className="age-kpi-pct">{pct}% من الإجمالي</span>
                </div>
              );
            })}
            <div className="age-kpi-card">
              <span className="age-kpi-label">آخر لقطة</span>
              <span className="age-kpi-value" style={{ fontSize: '0.95rem' }}>
                {data.snapshot_date || '—'}
              </span>
              <span className="age-kpi-pct">مقارنة بـ {data.prev_date || 'لا يوجد'}</span>
            </div>
          </div>

          {/* ── Bucket period filter ─────────────────────────────── */}
          <div className="age-bucket-filters age-no-print">
            <span className="age-bucket-label">فلتر حسب فترة الدين:</span>
            <button
              className={`age-bucket-btn${!bucketFilter ? ' age-bucket-btn--active' : ''}`}
              onClick={() => setBucketFilter('')}
            >الكل</button>
            {BUCKETS.map(b => {
              const count = (data?.customers || []).filter(c => parseFloat(c[b.key]||0) > 0).length;
              return (
                <button
                  key={b.key}
                  className={`age-bucket-btn age-bucket-btn--${b.key}${bucketFilter === b.key ? ' age-bucket-btn--active' : ''}`}
                  onClick={() => setBucketFilter(prev => prev === b.key ? '' : b.key)}
                >
                  {b.label}
                  <span className="age-bucket-count">{count}</span>
                </button>
              );
            })}
          </div>

          {/* ── Tabs ─────────────────────────────────────────────── */}
          <div className="age-tabs age-no-print">
            <button className={`age-tab${activeTab === 'customers' ? ' age-tab--active' : ''}`} onClick={() => setActiveTab('customers')}>
              العملاء ({fmt(bucketFilter ? filteredCustomers.length : data.total)})
            </button>
            <button className={`age-tab${activeTab === 'regions' ? ' age-tab--active' : ''}`} onClick={() => setActiveTab('regions')}>
              ملخص المناطق
            </button>
            <button className={`age-tab${activeTab === 'collections' ? ' age-tab--active' : ''}`} onClick={() => setActiveTab('collections')}>
              تتبع سداد المديونية القديمة
            </button>
          </div>

          {/* ── Old-debt collection tracker filters ──────────────── */}
          {activeTab === 'collections' && (
            <div className="age-filters age-no-print">
              <button
                className={`age-exclude-direct-btn${excludeCarrefour ? ' age-exclude-direct-btn--on' : ''}`}
                onClick={() => setExcludeCarrefour(v => !v)}
              >
                <span className={`age-exclude-dot${excludeCarrefour ? ' age-exclude-dot--on' : ''}`} />
                {excludeCarrefour ? '✕ عملاء كارفور مستبعدون' : '⊕ استبعاد عملاء كارفور'}
              </button>
              <button
                className={`age-exclude-direct-btn${excludeZeroDebt ? ' age-exclude-direct-btn--on' : ''}`}
                onClick={() => setExcludeZeroDebt(v => !v)}
              >
                <span className={`age-exclude-dot${excludeZeroDebt ? ' age-exclude-dot--on' : ''}`} />
                {excludeZeroDebt ? '✕ العملاء بدين صفري مستبعدون' : '⊕ استبعاد العملاء بدين صفري'}
              </button>
              <div className="age-filter-group">
                <span className="age-filter-label">من تاريخ (فاتورة)</span>
                <input
                  type="date" className="age-filter-input"
                  value={colDateFrom} onChange={e => setColDateFrom(e.target.value)}
                />
              </div>
              <div className="age-filter-group">
                <span className="age-filter-label">إلى تاريخ (فاتورة)</span>
                <input
                  type="date" className="age-filter-input"
                  value={colDateTo} onChange={e => setColDateTo(e.target.value)}
                />
              </div>
              <div className="age-filter-group">
                <span className="age-filter-label">المنطقة</span>
                <select className="age-filter-select" value={colRegionId} onChange={e => setColRegionId(e.target.value)}>
                  <option value="">كل المناطق</option>
                  {(data?.by_region || []).map(r => (
                    <option key={r.region_id} value={r.region_id}>{r.region_name || `منطقة ${r.region_id}`}</option>
                  ))}
                </select>
              </div>
              <div className="age-filter-group">
                <span className="age-filter-label">المندوب</span>
                <select className="age-filter-select" value={colSalesRep} onChange={e => setColSalesRep(e.target.value)}>
                  <option value="">كل المندوبين</option>
                  {(meta?.reps || []).map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              {colIsDirty && (
                <button className="age-filter-reset" onClick={handleColReset}>إعادة تعيين</button>
              )}
              <button
                className="age-snapshot-reset-btn"
                onClick={handleResetSnapshot}
                disabled={snapResetting || colLoading}
                title="يحدّث دين الفواتير (اللقطة الثابتة) لهذه الفترة إلى أرصدة اليوم"
              >
                <RefreshCw size={13} className={snapResetting ? 'age-spin' : ''}/>
                {snapResetting ? 'جارٍ التحديث…' : 'تحديث اللقطة الثابتة لليوم'}
              </button>
              <span className="age-col-hint">
                * الأعمدة اليومية تعرض التحصيل خلال الشهر الحالي فقط
              </span>
            </div>
          )}

          {/* ── Customer matrix table ─────────────────────────────── */}
          <div style={{ display: activeTab === 'customers' ? 'block' : 'none' }}>
            {!filteredCustomers.length ? (
              <div className="age-empty">
                {bucketFilter ? 'لا يوجد عملاء لديهم ديون في هذه الفترة' : 'لا توجد مديونيات'}
              </div>
            ) : (
              <div className="age-table-wrap">
                <CustomerTable
                  customers={filteredCustomers}
                  kpis={kpis}
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSort={handleSort}
                  onOpenModal={setModalCustomer}
                />
              </div>
            )}
          </div>

          {/* ── Region summary ────────────────────────────────────── */}
          <div style={{ display: activeTab === 'regions' ? 'block' : 'none' }}>
            {!data.by_region?.length ? (
              <div className="age-empty">لا توجد بيانات</div>
            ) : (
              <div className="age-table-wrap">
                <RegionTable regions={data.by_region} total={total} />
              </div>
            )}
          </div>

          {/* ── Old-debt collection tracker ──────────────────────── */}
          {activeTab === 'collections' && (
            <>
              {colLoading && <div className="age-loading">جاري تحميل بيانات التحصيل…</div>}
              {colError   && <div className="age-loading">حدث خطأ في تحميل البيانات</div>}
              {!colLoading && !colError && colData && (
                !colCustomersVisible.length ? (
                  <div className="age-empty">
                    {(excludeCarrefour || excludeZeroDebt) ? 'لا يوجد عملاء مطابقون بعد تطبيق الفلاتر' : 'لا توجد فواتير بتاريخ ضمن هذه الفترة'}
                  </div>
                ) : (
                  <div className="age-table-wrap">
                    <CollectionsTable
                      customers={colCustomersVisible}
                      matrix={colMatrix}
                      onOpenPayments={setPaymentModal}
                    />
                  </div>
                )
              )}
            </>
          )}
        </>
      )}

      {/* ── Invoice Detail Modal ──────────────────────────────────── */}
      {modalCustomer && (
        <InvoiceModal customer={modalCustomer} onClose={() => setModalCustomer(null)} />
      )}

      {/* ── Payment Detail Modal (collection tracker cells) ───────── */}
      {paymentModal && (
        <PaymentModal payment={paymentModal} onClose={() => setPaymentModal(null)} />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   CustomerTable
═══════════════════════════════════════════════════════════════ */
function SortIcon({ col, sortBy, sortDir }) {
  if (sortBy !== col) return <ChevronsUpDown size={12} className="age-sort-icon" />;
  return sortDir === 'DESC'
    ? <ChevronDown size={12} className="age-sort-icon" />
    : <ChevronUp   size={12} className="age-sort-icon" />;
}

function CustomerTable({ customers, kpis, sortBy, sortDir, onSort, onOpenModal }) {
  const fmtN = n => n ? Number(n).toLocaleString('en-SA', { maximumFractionDigits: 0 }) : '';

  // Footer totals
  const foot = kpis;

  return (
    <table className="age-table">
      <thead>
        <tr>
          <th onClick={() => onSort('customer_name')} className={sortBy === 'customer_name' ? 'age-th--sorted' : ''}>
            <SortIcon col="customer_name" sortBy={sortBy} sortDir={sortDir} />
            العميل
          </th>
          {BUCKETS.map(b => (
            <th key={b.key} onClick={() => onSort(b.key)} className={sortBy === b.key ? 'age-th--sorted' : ''}>
              <SortIcon col={b.key} sortBy={sortBy} sortDir={sortDir} />
              {b.label}
            </th>
          ))}
          <th onClick={() => onSort('collection_rate')} className={sortBy === 'collection_rate' ? 'age-th--sorted' : ''}>
            <SortIcon col="collection_rate" sortBy={sortBy} sortDir={sortDir} />
            نسبة التحصيل
          </th>
          <th>نسبة المتبقي</th>
          <th onClick={() => onSort('avg_age_days')} className={sortBy === 'avg_age_days' ? 'age-th--sorted' : ''}>
            <SortIcon col="avg_age_days" sortBy={sortBy} sortDir={sortDir} />
            عمر أقدم دين
          </th>
          <th onClick={() => onSort('total_balance')} className={sortBy === 'total_balance' ? 'age-th--sorted' : ''}>
            <SortIcon col="total_balance" sortBy={sortBy} sortDir={sortDir} />
            إجمالي الدين
          </th>
          <th onClick={() => onSort('daily_change')} className={sortBy === 'daily_change' ? 'age-th--sorted' : ''}>
            <SortIcon col="daily_change" sortBy={sortBy} sortDir={sortDir} />
            التغير اليومي
          </th>
          <th>تفاصيل</th>
        </tr>
      </thead>
      <tbody>
        {customers.map(c => (
          <CustomerRow key={c.customer_id} c={c} fmtN={fmtN} onOpenModal={onOpenModal} />
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>الإجمالي</td>
          {BUCKETS.map(b => (
            <td key={b.key}>{fmtN(foot[b.key])}</td>
          ))}
          <td>—</td>
          <td>—</td>
          <td>—</td>
          <td style={{ fontWeight: 800 }}>{fmtN(foot.total_balance)}</td>
          <td>—</td>
          <td />
        </tr>
      </tfoot>
    </table>
  );
}

function CustomerRow({ c, fmtN, onOpenModal }) {
  const change    = parseFloat(c.daily_change    || 0);
  const collRate  = parseFloat(c.collection_rate || 0);
  const totalAmt  = parseFloat(c.total_amount    || 0);
  const totalBal  = parseFloat(c.total_balance   || 0);
  // نسبة المتبقي = المتبقي / الأصل × 100
  const remRate   = totalAmt > 0 ? parseFloat((totalBal / totalAmt * 100).toFixed(1)) : 0;

  const changeEl = change === 0
    ? <span className="age-change age-change--flat">— بدون تغيير</span>
    : change < 0
      ? <span className="age-change age-change--down"><span className="age-change-arrow">▼</span>{fmtN(Math.abs(change))}</span>
      : <span className="age-change age-change--up"><span className="age-change-arrow">▲</span>{fmtN(change)}</span>;

  const collColor = collRate >= 75 ? '' : collRate >= 50 ? 'age-coll-fill--warn' : 'age-coll-fill--alert';
  // نسبة المتبقي: كلما ارتفعت زاد الخطر (أحمر عالي، برتقالي متوسط، أصفر منخفض)
  const remColor  = remRate >= 70 ? 'age-coll-fill--alert' : remRate >= 40 ? 'age-coll-fill--warn' : 'age-coll-fill--low';

  return (
    <tr>
      {/* Sticky customer name */}
      <td>
        <button
          className="age-customer-link"
          onClick={() => onOpenModal({ id: c.customer_id, name: c.customer_name })}
          style={{ background: 'none', border: 'none', padding: 0 }}
        >
          {c.customer_name}
        </button>
      </td>

      {/* Bucket cells */}
      {BUCKETS.map((b, i) => {
        const val = parseFloat(c[b.key] || 0);
        return (
          <td key={b.key} className={val === 0 ? 'age-cell--zero' : b.cls}>
            {val === 0 ? '—' : fmtN(val)}
          </td>
        );
      })}

      {/* Collection rate with mini bar */}
      <td>
        <div className="age-coll-bar">
          <div className="age-coll-track">
            <div
              className={`age-coll-fill ${collColor}`}
              style={{ width: `${Math.min(collRate, 100)}%` }}
            />
          </div>
          <span className="age-coll-pct">{collRate}%</span>
        </div>
      </td>

      {/* نسبة المتبقي */}
      <td>
        <div className="age-coll-bar">
          <div className="age-coll-track">
            <div
              className={`age-coll-fill ${remColor}`}
              style={{ width: `${Math.min(remRate, 100)}%` }}
            />
          </div>
          <span className="age-coll-pct">{remRate}%</span>
        </div>
      </td>

      {/* متوسط عمر الدين */}
      <td>
        <AvgAgeBadge days={parseInt(c.avg_age_days || 0)} />
      </td>

      {/* Total balance */}
      <td style={{ fontWeight: 700 }}>{fmtN(c.total_balance)}</td>

      {/* Daily change */}
      <td>{changeEl}</td>

      {/* Detail button */}
      <td>
        <button
          onClick={() => onOpenModal({ id: c.customer_id, name: c.customer_name })}
          style={{
            background: 'none', border: '1px solid var(--color-border)',
            borderRadius: 6, padding: '3px 10px', fontSize: '0.78rem',
            cursor: 'pointer', color: 'var(--color-text-muted)',
          }}
        >
          تفاصيل
        </button>
      </td>
    </tr>
  );
}

/* ─────────────────────────────────────────────────────────────
   AvgAgeBadge — colored pill showing weighted-average debt age
───────────────────────────────────────────────────────────── */
function AvgAgeBadge({ days }) {
  if (!days || days <= 0) return <span className="age-cell--zero">—</span>;
  let cls, label;
  if (days <= 15)  { cls = 'age-avg--b1'; label = 'أقل من 15 يوم'; }
  else if (days <= 30)  { cls = 'age-avg--b2'; label = '16-30 يوم'; }
  else if (days <= 60)  { cls = 'age-avg--b3'; label = '31-60 يوم'; }
  else if (days <= 90)  { cls = 'age-avg--b4'; label = '61-90 يوم'; }
  else if (days <= 120) { cls = 'age-avg--b5'; label = '91-120 يوم'; }
  else                  { cls = 'age-avg--b6'; label = 'أكثر من 120'; }
  return (
    <span className={`age-avg-badge ${cls}`} title={label}>
      {days} يوم
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════════
   RegionTable
═══════════════════════════════════════════════════════════════ */
function RegionTable({ regions, total }) {
  const fmtN = n => n ? Number(n).toLocaleString('en-SA', { maximumFractionDigits: 0 }) : '—';
  return (
    <table className="age-table">
      <thead>
        <tr>
          <th>المنطقة</th>
          {BUCKETS.map(b => <th key={b.key}>{b.label}</th>)}
          <th>إجمالي الدين</th>
          <th>النسبة</th>
          <th>عملاء</th>
        </tr>
      </thead>
      <tbody>
        {regions.map(r => {
          const bal = parseFloat(r.total_balance || 0);
          const pct = total > 0 ? (bal / total * 100).toFixed(1) : '0.0';
          return (
            <tr key={r.region_id}>
              <td style={{ fontWeight: 700 }}>{r.region_name || `منطقة ${r.region_id}`}</td>
              {BUCKETS.map(b => {
                const v = parseFloat(r[b.key] || 0);
                return <td key={b.key} className={v === 0 ? 'age-cell--zero' : b.cls}>{v === 0 ? '—' : fmtN(v)}</td>;
              })}
              <td style={{ fontWeight: 700 }}>{fmtN(bal)}</td>
              <td>{pct}%</td>
              <td>{r.customer_count}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td>الإجمالي</td>
          {BUCKETS.map(b => {
            const t = regions.reduce((s, r) => s + parseFloat(r[b.key] || 0), 0);
            return <td key={b.key}>{fmtN(t)}</td>;
          })}
          <td style={{ fontWeight: 800 }}>{fmtN(total)}</td>
          <td>100%</td>
          <td>{regions.reduce((s, r) => s + (r.customer_count || 0), 0)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/* ═══════════════════════════════════════════════════════════════
   CollectionsTable — old-debt collection tracker matrix
═══════════════════════════════════════════════════════════════ */
/* Defensive merge by rep name, shared by the on-screen sub-rows and the
   Excel export: the backend's GROUP BY (customer_id, sales_rep_name)
   already makes a duplicate rep row for the same customer structurally
   impossible, but neither display path should ever print the same
   مندوب+عميل combination twice even if that ever stopped holding — any
   accidental duplicates are summed into one line instead of shown twice. */
/* A customer counts as "split" only when more than one rep actually
   carries a non-zero share of the frozen debt. historical_rep_count from
   the backend counts every rep who EVER had an invoice for this customer,
   including ones now fully settled (0 balance) — treating that as a split
   made the parent row's total print again, verbatim, as that single real
   rep's own sub-row underneath it (plus a "0" row for the settled rep that
   adds nothing), which is exactly what read as duplicated values. */
function activeRepShareCount(breakdown) {
  return mergeRepBreakdown(breakdown).length;
}

function mergeRepBreakdown(breakdown) {
  const byRep = new Map();
  (breakdown || []).forEach(rb => {
    const existing = byRep.get(rb.sales_rep_name);
    if (existing) {
      existing.total_debt      += rb.total_debt;
      existing.current_balance += rb.current_balance;
      existing.invoice_count   += rb.invoice_count;
      existing.unpaid_count    += rb.unpaid_count;
    } else {
      byRep.set(rb.sales_rep_name, { ...rb });
    }
  });
  // A rep now holding zero debt (fully settled since their last invoice)
  // adds nothing once the row is already flagged "split" for its ACTIVE
  // reps — printing it anyway is exactly what made 17,606.87 look
  // duplicated: the parent total, one real rep's identical share, and a
  // "0" line for a rep who no longer carries any of it.
  return [...byRep.values()].filter(rb => rb.total_debt !== 0);
}

function CollectionsTable({ customers, matrix, onOpenPayments }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const toggleExpand = id => setExpanded(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const fmtN = n => n ? Number(n).toLocaleString('en-SA', { maximumFractionDigits: 0 }) : '—';
  const days = matrix?.days || [];
  const fmtDay = iso => {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('ar-SA-u-nu-latn', { month: 'short', day: 'numeric' });
  };
  const fmtSnapDate = iso => iso
    ? new Date(iso).toLocaleDateString('ar-SA-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  const totals = customers.reduce((acc, c) => {
    acc.total_debt      += parseFloat(c.total_debt || 0);
    acc.unpaid_count    += parseInt(c.unpaid_count || 0, 10);
    acc.current_balance += parseFloat(c.current_balance || 0);
    return acc;
  }, { total_debt: 0, unpaid_count: 0, current_balance: 0 });

  return (
    <table className="age-table">
      <thead>
        <tr>
          <th>العميل</th>
          <th>المندوب</th>
          <th>المنطقة</th>
          <th title="قيمة ثابتة — تُسجَّل عند أول عرض لهذه الفترة ولا تتغير بعدها">دين الفواتير (لقطة ثابتة)</th>
          <th>عدد الفواتير غير المسددة</th>
          {days.map(d => <th key={d} className="age-col-day-th">{fmtDay(d)}</th>)}
          <th>الرصيد الحالي</th>
        </tr>
      </thead>
      <tbody>
        {customers.map(c => {
          const activeCount = activeRepShareCount(c.rep_breakdown);
          const isSplit = activeCount > 1;
          const isOpen  = expanded.has(c.customer_id);
          return (
          <React.Fragment key={c.customer_id}>
          <tr>
            <td>{c.customer_name}</td>
            <td>
              {isSplit ? (
                <button
                  type="button"
                  className="age-multi-rep-toggle"
                  onClick={() => toggleExpand(c.customer_id)}
                  title="مقسَّمة بين أكثر من مندوب — اضغط لعرض حصة كل مندوب"
                >
                  {c.sales_rep_name || '—'}
                  <span className="age-multi-rep-flag">{isOpen ? '▲' : '▼'} +{activeCount - 1}</span>
                </button>
              ) : (c.sales_rep_name || '—')}
            </td>
            <td>{c.region_name || '—'}</td>
            <td title={fmtSnapDate(c.snapshot_taken_at) ? `ثابتة منذ ${fmtSnapDate(c.snapshot_taken_at)}` : undefined}>
              {fmtN(c.total_debt)}
            </td>
            <td className={parseInt(c.unpaid_count || 0, 10) === 0 ? 'age-cell--zero' : ''}>{fmtN(c.unpaid_count)}</td>
            {days.map(d => {
              const v = matrix.byCustDay[`${c.customer_id}-${d}`] || 0;
              return (
                <td
                  key={d}
                  className={v === 0 ? 'age-cell--zero' : 'age-col-day-cell age-col-day-cell--clickable'}
                  title={v !== 0 ? 'اضغط لعرض تفاصيل السدادات' : undefined}
                  onClick={v !== 0 ? () => onOpenPayments({ id: c.customer_id, name: c.customer_name, date: d }) : undefined}
                >
                  {v === 0 ? '—' : fmtN(v)}
                </td>
              );
            })}
            <td style={{ fontWeight: 700, color: parseFloat(c.current_balance || 0) > 0 ? '#dc2626' : '#15803d' }}>
              {fmtN(c.current_balance)}
              {(() => {
                const collected = parseFloat(c.total_debt || 0) - parseFloat(c.current_balance || 0);
                return collected > 0
                  ? (
                    <div
                      className="age-col-collected age-col-collected--clickable"
                      title="اضغط لعرض كل سدادات الشهر الحالي"
                      onClick={() => onOpenPayments({ id: c.customer_id, name: c.customer_name, date: null })}
                    >
                      ✓ تحصّل {fmtN(collected)} منذ اللقطة
                    </div>
                  )
                  : null;
              })()}
            </td>
          </tr>
          {isSplit && isOpen && mergeRepBreakdown(c.rep_breakdown).map((rb, i) => (
            <tr key={`${c.customer_id}-${rb.sales_rep_name}-${i}`} className="age-rep-subrow">
              <td className="age-rep-subrow__label">└ حصة هذا المندوب</td>
              <td>{rb.sales_rep_name}</td>
              <td>{c.region_name || '—'}</td>
              <td>{fmtN(rb.total_debt)}</td>
              <td className={rb.unpaid_count === 0 ? 'age-cell--zero' : ''}>{fmtN(rb.unpaid_count)}</td>
              {days.map(d => <td key={d} className="age-cell--zero">—</td>)}
              <td style={{ fontWeight: 600, color: rb.current_balance > 0 ? '#dc2626' : '#15803d' }}>
                {fmtN(rb.current_balance)}
              </td>
            </tr>
          ))}
          </React.Fragment>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td>الإجمالي</td>
          <td>—</td>
          <td>—</td>
          <td>{fmtN(totals.total_debt)}</td>
          <td>{fmtN(totals.unpaid_count)}</td>
          {days.map(d => <td key={d}>{fmtN(matrix.dayTotals[d] || 0)}</td>)}
          <td style={{ fontWeight: 800 }}>{fmtN(totals.current_balance)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PaymentModal — payment documents behind one daily collection cell
   (payment: {id, name, date|null} — null date = whole current month)
═══════════════════════════════════════════════════════════════ */
function PaymentModal({ payment, onClose }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['aging-col-payments', payment.id, payment.date],
    queryFn:  () => fetchCollectionPayments(payment.id, payment.date),
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const fmtN = n => n != null ? Number(n).toLocaleString('en-SA', { maximumFractionDigits: 0 }) : '—';
  const payments = data?.payments || [];
  const totalPaid = payments.reduce((s, p) => s + parseFloat(p.total_paid || 0), 0);

  const methodLabel = p => {
    const parts = [];
    if (parseFloat(p.cash || 0)      > 0) parts.push(`نقدي ${fmtN(p.cash)}`);
    if (parseFloat(p.cheque || 0)    > 0) parts.push(`شيك ${fmtN(p.cheque)}`);
    if (parseFloat(p.bank_tran || 0) > 0) parts.push(`تحويل ${fmtN(p.bank_tran)}`);
    if (parseFloat(p.pos || 0)       > 0) parts.push(`شبكة ${fmtN(p.pos)}`);
    return parts.length ? parts.join(' · ') : '—';
  };

  return ReactDOM.createPortal(
    <div className="age-modal-overlay" onClick={onClose}>
      <div className="age-modal" onClick={e => e.stopPropagation()}>
        <div className="age-modal-header">
          <ClockArrowUp size={18} color="#15803d" />
          <div>
            <div className="age-modal-customer-name">{payment.name}</div>
            <div className="age-modal-customer-sub">
              تفاصيل السدادات — {payment.date ? fmtDate(payment.date) : 'الشهر الحالي'}
            </div>
          </div>
          <button className="age-modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="age-modal-body">
          {isLoading && <div className="age-loading">جاري التحميل…</div>}

          {isError && (
            <div className="age-empty" style={{ color: '#dc2626' }}>
              حدث خطأ في تحميل بيانات السدادات
              <button
                onClick={() => refetch()}
                style={{ marginRight: 10, padding: '4px 12px', borderRadius: 6, border: '1px solid #dc2626', background: 'none', color: '#dc2626', cursor: 'pointer' }}
              >
                إعادة المحاولة
              </button>
            </div>
          )}

          {!isLoading && !isError && payments.length === 0 && (
            <div className="age-empty">لا توجد سدادات في هذا اليوم</div>
          )}

          {!isLoading && !isError && payments.length > 0 && (
            <>
              <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: '0.83rem', color: 'var(--color-text-muted)' }}>
                  {payments.length} مستند سداد
                </span>
                <span style={{ fontSize: '0.83rem', fontWeight: 700, color: '#15803d' }}>
                  إجمالي المسدد: {fmtN(totalPaid)} ر.س
                </span>
              </div>

              <table className="age-inv-table">
                <thead>
                  <tr>
                    <th>رقم المستند</th>
                    <th>تاريخ السداد</th>
                    <th>رقم الفاتورة المسددة</th>
                    <th>تاريخ الفاتورة</th>
                    <th>قيمة الفاتورة</th>
                    <th>طريقة الدفع</th>
                    <th>قيمة السداد</th>
                    <th>رصيد الفاتورة الحالي</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.flatMap((p, i) => {
                    // Preferred path: real applications resolved live from
                    // NetSuite (one row per settled invoice, with the exact
                    // amount applied to each).
                    if (p.applications?.length) {
                      return p.applications.map((a, j) => (
                        <tr key={`${p.document_number}-${j}`}>
                          <td style={{ fontFamily: 'monospace', direction: 'ltr', textAlign: 'right' }}>
                            {j === 0 ? p.document_number : ''}
                          </td>
                          <td>{j === 0 ? fmtDate(p.tran_date) : ''}</td>
                          <td style={{ fontFamily: 'monospace', direction: 'ltr', textAlign: 'right' }}>
                            {a.invoice_number}
                            <span className="age-ns-badge" title="مطابقة فعلية من NetSuite — الفاتورة التي طُبّق عليها هذا السداد">NetSuite ✓</span>
                          </td>
                          <td>{fmtNsDate(a.invoice_date)}</td>
                          <td>{fmtN(a.invoice_total)}</td>
                          <td style={{ fontSize: '0.78rem' }}>{j === 0 ? methodLabel(p) : ''}</td>
                          <td style={{ color: '#15803d', fontWeight: 700 }}>{fmtN(a.applied_amount)}</td>
                          <td>
                            {a.invoice_balance != null
                              ? <span style={{ color: parseFloat(a.invoice_balance) > 0 ? '#dc2626' : '#15803d', fontWeight: 600 }}>{fmtN(a.invoice_balance)}</span>
                              : <span className="age-closed-badge">فاتورة مغلقة</span>}
                          </td>
                        </tr>
                      ));
                    }
                    // Fallback: Excel reference only (NetSuite unavailable
                    // or no application links found for this document).
                    return [(
                    <tr key={p.document_number || i}>
                      <td style={{ fontFamily: 'monospace', direction: 'ltr', textAlign: 'right' }}>{p.document_number}</td>
                      <td>{fmtDate(p.tran_date)}</td>
                      <td style={{ fontFamily: 'monospace', direction: 'ltr', textAlign: 'right' }}>
                        {p.invoice_number || <span className="age-cell--zero">غير محدد</span>}
                      </td>
                      <td>
                        {p.invoice_date
                          ? fmtDate(p.invoice_date)
                          : p.closed_invoice
                            ? (
                              <span className="age-closed-badge" title="فاتورة حقيقية مسددة بالكامل ولم تعد ضمن ملف المديونيات الحالي — التاريخ مُستدل من سجل حركة المبيعات">
                                فاتورة مغلقة{p.closed_invoice_date ? ` · ${fmtDate(p.closed_invoice_date)}` : ''}
                              </span>
                            )
                            : (p.invoice_number
                              ? <span className="age-cell--zero" title="هذا المرجع منقول كما هو من ملف التحصيل في NetSuite لكنه لا يطابق أي فاتورة مسجلة بالنظام — غالباً مستند تسوية أو دفعة مقدمة وليس فاتورة مبيعات">مرجع غير مطابق لفاتورة</span>
                              : '—')}
                      </td>
                      <td>
                        {p.invoice_amount != null
                          ? fmtN(p.invoice_amount)
                          : p.closed_invoice
                            ? (p.closed_invoice_amount != null
                              ? <span title="قيمة مُستدلة من سجل حركة المبيعات">{fmtN(p.closed_invoice_amount)}</span>
                              : <span className="age-closed-badge">فاتورة مغلقة</span>)
                            : (p.invoice_number
                              ? <span className="age-cell--zero" title="هذا المرجع منقول كما هو من ملف التحصيل في NetSuite لكنه لا يطابق أي فاتورة مسجلة بالنظام — غالباً مستند تسوية أو دفعة مقدمة وليس فاتورة مبيعات">مرجع غير مطابق لفاتورة</span>
                              : '—')}
                      </td>
                      <td style={{ fontSize: '0.78rem' }}>{methodLabel(p)}</td>
                      <td style={{ color: '#15803d', fontWeight: 700 }}>{fmtN(p.total_paid)}</td>
                      <td>
                        {p.invoice_balance != null
                          ? <span style={{ color: parseFloat(p.invoice_balance) > 0 ? '#dc2626' : '#15803d', fontWeight: 600 }}>{fmtN(p.invoice_balance)}</span>
                          : '—'}
                      </td>
                    </tr>
                    )];
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={6} style={{ fontWeight: 700 }}>الإجمالي</td>
                    <td style={{ color: '#15803d', fontWeight: 700 }}>{fmtN(totalPaid)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ═══════════════════════════════════════════════════════════════
   InvoiceModal — invoice-level detail for one customer
═══════════════════════════════════════════════════════════════ */
function InvoiceModal({ customer, onClose }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['aging-invoices', customer.id],
    queryFn:  () => fetchInvoices(customer.id),
    staleTime: 60_000,
    retry: 1,
  });

  /* Close on Escape key */
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const fmtN = n => n != null ? Number(n).toLocaleString('en-SA', { maximumFractionDigits: 0 }) : '—';
  const invoices = data?.invoices || [];

  return ReactDOM.createPortal(
    <div className="age-modal-overlay" onClick={onClose}>
      <div className="age-modal" onClick={e => e.stopPropagation()}>
        <div className="age-modal-header">
          <ClockArrowUp size={18} color="#dc2626" />
          <div>
            <div className="age-modal-customer-name">{customer.name}</div>
            <div className="age-modal-customer-sub">تفاصيل الفواتير المستحقة</div>
          </div>
          <Link
            to={`/customers/${customer.id}`}
            className="age-modal-goto"
            onClick={onClose}
          >
            <ExternalLink size={14} /> ملف العميل
          </Link>
          <button className="age-modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="age-modal-body">
          {isLoading && <div className="age-loading">جاري التحميل…</div>}

          {isError && (
            <div className="age-empty" style={{ color: '#dc2626' }}>
              حدث خطأ في تحميل بيانات الفواتير
              <button
                onClick={() => refetch()}
                style={{ marginRight: 10, padding: '4px 12px', borderRadius: 6, border: '1px solid #dc2626', background: 'none', color: '#dc2626', cursor: 'pointer' }}
              >
                إعادة المحاولة
              </button>
            </div>
          )}

          {!isLoading && !isError && invoices.length === 0 && (
            <div className="age-empty">لا توجد فواتير مستحقة لهذا العميل</div>
          )}

          {!isLoading && !isError && invoices.length > 0 && (
            <>
              {/* Summary chips */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: '0.83rem', color: 'var(--color-text-muted)' }}>
                  {invoices.length} فاتورة مستحقة
                </span>
                <span style={{ fontSize: '0.83rem', fontWeight: 700 }}>
                  إجمالي الدين: {fmtN(invoices.reduce((s, i) => s + parseFloat(i.balance || 0), 0))} ر.س
                </span>
                <span style={{ fontSize: '0.83rem', color: 'var(--color-text-muted)' }}>
                  القيمة الأصلية: {fmtN(invoices.reduce((s, i) => s + parseFloat(i.original_amount || 0), 0))} ر.س
                </span>
              </div>

              {/* Invoice table */}
              <table className="age-inv-table">
                <thead>
                  <tr>
                    <th>رقم الفاتورة</th>
                    <th>تاريخ الفاتورة</th>
                    <th>العمر</th>
                    <th>قيمة الفاتورة</th>
                    <th>المسدد</th>
                    <th>نسبة السداد</th>
                    <th>المتبقي</th>
                    <th>نسبة المتبقي</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv, i) => {
                    const paidPct = parseFloat(inv.paid_pct || 0);
                    const remPct  = parseFloat(inv.remaining_pct || 0);
                    return (
                      <tr key={inv.invoice_number || i}>
                        <td style={{ fontFamily: 'monospace', direction: 'ltr', textAlign: 'right' }}>{inv.invoice_number}</td>
                        <td>{fmtDate(inv.invoice_date)}</td>
                        <td>
                          <span className={`age-badge ${ageBadgeClass(inv.age_days)}`}>
                            {inv.age_days} يوم
                          </span>
                        </td>
                        <td>{fmtN(inv.original_amount)}</td>
                        <td style={{ color: '#15803d', fontWeight: 600 }}>{fmtN(inv.paid_amount)}</td>
                        <td>
                          <div className="age-pct-bar">
                            <div className="age-pct-track">
                              <div
                                className={`age-pct-fill${paidPct < 100 ? ' age-pct-fill--partial' : ''}`}
                                style={{ width: `${Math.min(paidPct, 100)}%` }}
                              />
                            </div>
                            <span className="age-pct-text">{paidPct}%</span>
                          </div>
                        </td>
                        <td style={{ color: '#dc2626', fontWeight: 600 }}>{fmtN(inv.balance)}</td>
                        <td>
                          <span className={`age-badge ${ageBadgeClass(inv.age_days)}`}>
                            {remPct}%
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} style={{ fontWeight: 700 }}>الإجمالي</td>
                    <td style={{ fontWeight: 700 }}>
                      {fmtN(invoices.reduce((s, i) => s + parseFloat(i.original_amount || 0), 0))}
                    </td>
                    <td style={{ color: '#15803d', fontWeight: 700 }}>
                      {fmtN(invoices.reduce((s, i) => s + parseFloat(i.paid_amount || 0), 0))}
                    </td>
                    <td />
                    <td style={{ color: '#dc2626', fontWeight: 700 }}>
                      {fmtN(invoices.reduce((s, i) => s + parseFloat(i.balance || 0), 0))}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
