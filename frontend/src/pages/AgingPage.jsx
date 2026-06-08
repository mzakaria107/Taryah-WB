import React, { useState, useMemo, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer, ClockArrowUp, X, ExternalLink, ChevronUp, ChevronDown, ChevronsUpDown, FileSpreadsheet } from 'lucide-react';
import * as XLSX from 'xlsx';
import api from '../api/client';
import './AgingPage.css';

/* ── Helpers ─────────────────────────────────────────────────── */
const fmt = n =>
  n == null ? '—' : Number(n).toLocaleString('ar-SA', { maximumFractionDigits: 0 });
const fmtDate = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('ar-SA-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

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

/* ═══════════════════════════════════════════════════════════════
   Main Page
═══════════════════════════════════════════════════════════════ */
export default function AgingPage() {
  /* ── Filters ─────────────────────────────────────────────────── */
  const [regionId,  setRegionId]  = useState('');
  const [routeId,   setRouteId]   = useState('');
  const [search,    setSearch]    = useState('');
  const [custType,  setCustType]  = useState('');
  const [sortBy,    setSortBy]    = useState('total_balance');
  const [sortDir,   setSortDir]   = useState('DESC');
  const [activeTab, setActiveTab] = useState('customers'); // 'customers' | 'regions'

  /* ── Modal state ─────────────────────────────────────────────── */
  const [modalCustomer, setModalCustomer] = useState(null); // {id, name}

  /* ── Query ───────────────────────────────────────────────────── */
  const qParams = useMemo(() => {
    const p = { sort_by: sortBy, sort_dir: sortDir, limit: 1000 };
    if (regionId)  p.region_id    = regionId;
    if (routeId)   p.route_id     = routeId;
    if (search)    p.search       = search;
    if (custType)  p.customer_type = custType;
    return p;
  }, [regionId, routeId, search, custType, sortBy, sortDir]);

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

  /* ── Reset ───────────────────────────────────────────────────── */
  const isDirty = regionId || routeId || search || custType;
  const handleReset = () => { setRegionId(''); setRouteId(''); setSearch(''); setCustType(''); };

  /* ── Print ───────────────────────────────────────────────────── */
  const handlePrint = () => {
    const prev = document.title;
    document.title = 'أعمار المديونيات';
    window.print();
    window.onafterprint = () => { document.title = prev; };
  };

  /* ── Excel export ────────────────────────────────────────────── */
  const handleExport = () => {
    if (!data) return;
    const wb = XLSX.utils.book_new();

    /* ── Sheet 1: Customers matrix ── */
    const custHeader = [
      'العميل',
      '1-15 يوم', '16-30 يوم', '31-60 يوم',
      '61-90 يوم', '91-120 يوم', 'أكثر من 120',
      'نسبة التحصيل %', 'نسبة المتبقي %',
      'إجمالي الدين', 'التغير اليومي',
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
      '', '', parseFloat(k.total_balance || 0), '',
    ]);
    const ws1 = XLSX.utils.aoa_to_sheet([custHeader, ...custRows]);
    // Column widths
    ws1['!cols'] = [
      { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 12 }, { wch: 13 }, { wch: 14 },
      { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 13 },
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
        </div>
      </div>

      {/* Page header */}
      <div className="age-header age-no-print">
        <ClockArrowUp size={24} color="#dc2626" />
        <h1 className="age-title">أعمار المديونيات</h1>
        <button
          className="age-export-btn"
          onClick={handleExport}
          disabled={!data}
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
          <span className="age-filter-label">نوع العميل</span>
          <select className="age-filter-select" value={custType} onChange={e => setCustType(e.target.value)}>
            <option value="">الكل</option>
            <option value="route">مسارات</option>
            <option value="direct">مباشر</option>
          </select>
        </div>
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

          {/* ── Tabs ─────────────────────────────────────────────── */}
          <div className="age-tabs age-no-print">
            <button className={`age-tab${activeTab === 'customers' ? ' age-tab--active' : ''}`} onClick={() => setActiveTab('customers')}>
              العملاء ({fmt(data.total)})
            </button>
            <button className={`age-tab${activeTab === 'regions' ? ' age-tab--active' : ''}`} onClick={() => setActiveTab('regions')}>
              ملخص المناطق
            </button>
          </div>

          {/* ── Customer matrix table ─────────────────────────────── */}
          <div style={{ display: activeTab === 'customers' ? 'block' : 'none' }}>
            {!data.customers?.length ? (
              <div className="age-empty">لا توجد مديونيات</div>
            ) : (
              <div className="age-table-wrap">
                <CustomerTable
                  customers={data.customers}
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
        </>
      )}

      {/* ── Invoice Detail Modal ──────────────────────────────────── */}
      {modalCustomer && (
        <InvoiceModal customer={modalCustomer} onClose={() => setModalCustomer(null)} />
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
  const fmtN = n => n ? Number(n).toLocaleString('ar-SA', { maximumFractionDigits: 0 }) : '';

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

/* ═══════════════════════════════════════════════════════════════
   RegionTable
═══════════════════════════════════════════════════════════════ */
function RegionTable({ regions, total }) {
  const fmtN = n => n ? Number(n).toLocaleString('ar-SA', { maximumFractionDigits: 0 }) : '—';
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

  const fmtN = n => n != null ? Number(n).toLocaleString('ar-SA', { maximumFractionDigits: 0 }) : '—';
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
