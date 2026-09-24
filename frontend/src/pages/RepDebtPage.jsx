import React, { useCallback, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import { ArrowRight, Printer, FileSpreadsheet, FileText, AlertCircle, Layers, Ban, EyeOff } from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './RepDebtPage.css';

/* ── Formatters ──────────────────────────────────── */
const fmt = (n) =>
  n == null ? '—'
  : Number(n).toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt  = (n) => Math.round(Number(n || 0)).toLocaleString('en-SA');
const fmtDate = (d) => d ? String(d).split('T')[0] : '—';

const STATUS_MAP = { paid: ['مسددة', 'paid'], partial: ['جزئي', 'partial'], unpaid: ['غير مسددة', 'unpaid'] };
function StatusBadge({ status }) {
  const [label, cls] = STATUS_MAP[status] || ['—', ''];
  return <span className={`rd-badge rd-badge--${cls}`}>{label}</span>;
}

const isCarrefour = (name) => /كارفور|carrefour/i.test(String(name || ''));

function rowClass(inv) {
  const bal  = parseFloat(inv.balance || 0);
  const orig = parseFloat(inv.original_amount || 1);
  if (bal > 0 && orig > 0 && bal / orig >= 0.8) return 'rd-row-danger';
  if (inv.status === 'partial') return 'rd-row-warning';
  return '';
}

/* ── Sortable columns ──────────────────────────────── */
const INV_COLUMNS = [
  { key: 'invoice_number',  label: 'رقم الفاتورة',   type: 'string' },
  { key: 'customer_name',   label: 'العميل',         type: 'string' },
  { key: 'region_name_ar',  label: 'المنطقة',        type: 'string' },
  { key: 'invoice_date',    label: 'التاريخ',        type: 'date'   },
  { key: 'original_amount', label: 'المبلغ الأصلي',  type: 'number' },
  { key: 'paid_amount',     label: 'المدفوع',        type: 'number' },
  { key: 'balance',         label: 'المتبقي',        type: 'number' },
  { key: 'status',          label: 'الحالة',         type: 'string' },
];
function sortValue(row, col) {
  const { key, type } = col;
  if (type === 'date')   return row[key] ? new Date(row[key]).getTime() : 0;
  if (type === 'number') return parseFloat(row[key] || 0);
  return String(row[key] || '');
}

const CUST_COLUMNS = [
  { key: 'customer_name',  label: 'العميل',           type: 'string' },
  { key: 'region_name_ar', label: 'المنطقة',          type: 'string' },
  { key: 'invoice_count',  label: 'عدد الفواتير',      type: 'number' },
  { key: 'total_amount',   label: 'المبلغ الأصلي',     type: 'number' },
  { key: 'total_paid',     label: 'المدفوع',           type: 'number' },
  { key: 'total_balance',  label: 'صافي المديونية',    type: 'number' },
];

/* ═══════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════ */
export default function RepDebtPage() {
  const { repName } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const decodedName = decodeURIComponent(repName || '');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rep-debt', decodedName],
    queryFn: () => client.get(`/invoices/rep/${encodeURIComponent(decodedName)}`).then(r => r.data),
    staleTime: 60_000,
  });

  const { data: lastUploads } = useQuery({
    queryKey: ['last-uploads'],
    queryFn: () => client.get('/last-uploads').then(r => r.data),
    staleTime: 60_000,
  });
  const lastUpdateStr = lastUploads?.customer_balance
    ? new Date(lastUploads.customer_balance).toLocaleString('ar-SA-u-nu-latn', {
        year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : null;

  const printDate = new Date().toLocaleString('ar-SA-u-nu-latn', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const handlePrint = useCallback(() => {
    const prev = document.title;
    document.title = `مديونية المندوب — ${decodedName} — ${new Date().toLocaleDateString('ar-SA-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric' })}`;
    window.print();
    window.onafterprint = () => { document.title = prev; window.onafterprint = null; };
  }, [decodedName]);

  const [activeTab, setActiveTab] = useState('invoices'); // invoices | customers

  // ── Exclusion filters (apply to table, print, and Excel export alike) ──
  const [excludeCarrefour, setExcludeCarrefour] = useState(false);
  const [excludeZero, setExcludeZero] = useState(false);

  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('desc');
  const handleSort = useCallback((key) => {
    setSortCol(c => {
      if (c === key) { setSortDir(d => d === 'desc' ? 'asc' : 'desc'); return key; }
      setSortDir('desc');
      return key;
    });
  }, []);

  const [custSortCol, setCustSortCol] = useState('total_balance');
  const [custSortDir, setCustSortDir] = useState('desc');
  const handleCustSort = useCallback((key) => {
    setCustSortCol(c => {
      if (c === key) { setCustSortDir(d => d === 'desc' ? 'asc' : 'desc'); return key; }
      setCustSortDir('desc');
      return key;
    });
  }, []);

  const summary  = data?.summary  || {};
  const rawInvoices = data?.invoices || [];

  // Apply exclusion filters (كارفور / صفري) before sorting so they affect
  // the on-screen table, print, and Excel export consistently.
  const invoices = useMemo(() => {
    let rows = rawInvoices;
    if (excludeCarrefour) rows = rows.filter(inv => !isCarrefour(inv.customer_name));
    if (excludeZero) rows = rows.filter(inv => Number(inv.balance || 0) !== 0);
    return rows;
  }, [rawInvoices, excludeCarrefour, excludeZero]);

  const sortedInvoices = useMemo(() => {
    if (!sortCol) return invoices;
    const col = INV_COLUMNS.find(c => c.key === sortCol);
    if (!col) return invoices;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...invoices].sort((a, b) => {
      const av = sortValue(a, col);
      const bv = sortValue(b, col);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), 'ar') * dir;
    });
  }, [invoices, sortCol, sortDir]);

  // True net debt per customer — from the backend's unconditional
  // SUM(balance) grouped by customer (same rule as summary.total_balance),
  // NOT aggregated client-side from the outstanding-only `invoices` list,
  // so these rows always foot exactly to the summary/footer total
  // (unless an exclusion filter is active, in which case the footer is
  // recomputed from the filtered rows — see filteredCustSummary below).
  const rawCustomerRows = data?.customers_net || [];
  const customerRows = useMemo(() => {
    let rows = rawCustomerRows;
    if (excludeCarrefour) rows = rows.filter(c => !isCarrefour(c.customer_name));
    if (excludeZero) rows = rows.filter(c => Number(c.total_balance || 0) !== 0);
    return rows;
  }, [rawCustomerRows, excludeCarrefour, excludeZero]);

  const sortedCustomers = useMemo(() => {
    if (!custSortCol) return customerRows;
    const col = CUST_COLUMNS.find(c => c.key === custSortCol);
    if (!col) return customerRows;
    const dir = custSortDir === 'asc' ? 1 : -1;
    return [...customerRows].sort((a, b) => {
      const av = sortValue(a, col);
      const bv = sortValue(b, col);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), 'ar') * dir;
    });
  }, [customerRows, custSortCol, custSortDir]);

  // Footer/summary totals: use the server-computed unconditional summary
  // when no filter is active (so it always matches the backend's rule
  // exactly); recompute from the filtered rows when a filter is on, so
  // the printed/exported total always matches what's actually shown.
  const filtersActive = excludeCarrefour || excludeZero;
  const custSummary = useMemo(() => {
    if (!filtersActive) return summary;
    return {
      total_amount:  sortedCustomers.reduce((s, c) => s + Number(c.total_amount  || 0), 0),
      total_paid:    sortedCustomers.reduce((s, c) => s + Number(c.total_paid    || 0), 0),
      total_balance: sortedCustomers.reduce((s, c) => s + Number(c.total_balance || 0), 0),
    };
  }, [filtersActive, summary, sortedCustomers]);
  const invSummary = useMemo(() => {
    if (!filtersActive) return summary;
    return {
      total_amount:  sortedInvoices.reduce((s, inv) => s + Number(inv.original_amount || 0), 0),
      total_paid:    sortedInvoices.reduce((s, inv) => s + Number(inv.paid_amount     || 0), 0),
      total_balance: sortedInvoices.reduce((s, inv) => s + Number(inv.balance         || 0), 0),
    };
  }, [filtersActive, summary, sortedInvoices]);

  const routeInfo = useMemo(() => {
    if (!invoices.length) return null;
    const sortRoutes = (routes) => [...routes].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

    const byRegion = new Map();
    const allRoutes = new Set();
    invoices.forEach(inv => {
      const region = inv.region_name_ar || 'غير محدد';
      if (!byRegion.has(region)) byRegion.set(region, new Set());
      if (inv.route_id != null && inv.route_id !== '') {
        byRegion.get(region).add(String(inv.route_id));
        allRoutes.add(String(inv.route_id));
      }
    });

    return {
      routeIds: sortRoutes(allRoutes),
      multiRegion: byRegion.size > 1,
      byRegion: [...byRegion.entries()].map(([region, routes]) => ({
        region,
        routes: sortRoutes(routes),
      })),
    };
  }, [invoices]);

  const handleExportExcel = useCallback(() => {
    const dateSuffix = new Date().toISOString().slice(0, 10);
    let header, rows, sheetName, fileTag;

    if (activeTab === 'customers') {
      header = ['العميل', 'المنطقة', 'عدد الفواتير', 'المبلغ الأصلي', 'المدفوع', 'صافي المديونية'];
      rows = sortedCustomers.map(c => [
        c.customer_name,
        c.region_name_ar || '—',
        c.invoice_count,
        Number(c.total_amount || 0),
        Number(c.total_paid || 0),
        Number(c.total_balance || 0),
      ]);
      rows.push([
        `الإجمالي (${sortedCustomers.length} عميل)`, '', sortedCustomers.reduce((s, c) => s + c.invoice_count, 0),
        Number(custSummary.total_amount || 0),
        Number(custSummary.total_paid || 0),
        Number(custSummary.total_balance || 0),
      ]);
      sheetName = 'صافي مديونية العملاء';
      fileTag = 'صافي_مديونية_العملاء';
    } else {
      header = ['رقم الفاتورة', 'العميل', 'المنطقة', 'التاريخ', 'المبلغ الأصلي', 'المدفوع', 'المتبقي', 'الحالة'];
      rows = sortedInvoices.map(inv => [
        inv.invoice_number,
        inv.customer_name,
        inv.region_name_ar || '—',
        fmtDate(inv.invoice_date),
        Number(inv.original_amount || 0),
        Number(inv.paid_amount || 0),
        Number(inv.balance || 0),
        (STATUS_MAP[inv.status]?.[0]) || inv.status || '—',
      ]);
      rows.push([
        `الإجمالي (${sortedInvoices.length} فاتورة)`, '', '', '',
        Number(invSummary.total_amount || 0),
        Number(invSummary.total_paid || 0),
        Number(invSummary.total_balance || 0),
        '',
      ]);
      sheetName = 'مديونية المندوب';
      fileTag = 'مديونية_المندوب';
    }

    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws['!cols'] = header.map((_, i) => ({ wch: i === 1 ? 26 : 16 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, `${fileTag}_${decodedName}_${dateSuffix}.xlsx`);
  }, [activeTab, sortedInvoices, sortedCustomers, custSummary, invSummary, decodedName]);

  return (
    <div className="rd-page">

      {/* ── Print-only header (hidden on screen) ── */}
      <div className="rd-print-header">
        <img src="/Logo.png" alt="طرية" className="rd-print-logo" />
        <div className="rd-print-titles">
          <div className="rd-print-title">مديونية المندوب — {decodedName}</div>
          <div className="rd-print-date">تاريخ الطباعة: {printDate}</div>
          {lastUpdateStr && (
            <div className="rd-print-update">آخر تحديث لرفع أرصدة بيانات العملاء والمديونية: {lastUpdateStr}</div>
          )}
        </div>
        {routeInfo && routeInfo.routeIds.length > 0 && (
          <div className="rd-print-routes">
            <div className="rd-print-routes-label">
              {routeInfo.multiRegion ? 'مناطق وخطوط السير' : 'خط السير'}
            </div>
            {routeInfo.multiRegion ? (
              routeInfo.byRegion.map(r => (
                <div key={r.region} className="rd-print-routes-row">
                  <strong>{r.region}</strong>: {r.routes.length ? r.routes.join('، ') : '—'}
                </div>
              ))
            ) : (
              <div className="rd-print-routes-row">{routeInfo.routeIds.join('، ')}</div>
            )}
          </div>
        )}
      </div>

      {/* ── Screen header ── */}
      <div className="rd-header rd-no-print">
        <button className="rd-back-btn" onClick={() => navigate(-1)}>
          <ArrowRight size={15} /> رجوع
        </button>
        <div className="rd-header-titles">
          <h1 className="rd-title">مديونية المندوب</h1>
          <p className="rd-subtitle">{decodedName}</p>
          {lastUpdateStr && (
            <p className="rd-update-note">آخر تحديث لرفع أرصدة بيانات العملاء والمديونية: {lastUpdateStr}</p>
          )}
        </div>
        {routeInfo && routeInfo.routeIds.length > 0 && (
          <div className="rd-header-routes">
            <div className="rd-header-routes-label">
              {routeInfo.multiRegion ? 'مناطق وخطوط السير' : 'خط السير'}
            </div>
            {routeInfo.multiRegion ? (
              routeInfo.byRegion.map(r => (
                <div key={r.region} className="rd-header-routes-row">
                  <strong>{r.region}</strong>: {r.routes.length ? r.routes.join('، ') : '—'}
                </div>
              ))
            ) : (
              <div className="rd-header-routes-row">{routeInfo.routeIds.join('، ')}</div>
            )}
          </div>
        )}
        <button className="rd-excel-btn" onClick={handleExportExcel}>
          <FileSpreadsheet size={14} /> تصدير Excel
        </button>
        <button className="rd-print-btn" onClick={handlePrint}>
          <Printer size={14} /> PDF / طباعة
        </button>
      </div>

      {isLoading ? (
        <div className="rd-loading">جارٍ التحميل…</div>
      ) : isError ? (
        <div className="rd-error">تعذّر تحميل بيانات المندوب</div>
      ) : (
        <>
          {/* ── KPI cards ── */}
          <div className="rd-kpis">
            <div className="rd-kpi rd-kpi--danger">
              <div className="rd-kpi-icon"><AlertCircle size={20} /></div>
              <div className="rd-kpi-body">
                <div className="rd-kpi-val">
                  {fmt((activeTab === 'customers' ? custSummary : invSummary).total_balance)} <span className="rd-kpi-unit">ر.س</span>
                </div>
                <div className="rd-kpi-lbl">صافي المديونية{filtersActive ? ' (بعد الاستبعاد)' : ' الإجمالية'}</div>
              </div>
            </div>
            <div className="rd-kpi">
              <div className="rd-kpi-icon"><FileText size={20} /></div>
              <div className="rd-kpi-body">
                <div className="rd-kpi-val">{fmtInt(filtersActive ? sortedInvoices.length : summary.invoice_count)}</div>
                <div className="rd-kpi-lbl">إجمالي الفواتير غير المسددة بالكامل</div>
              </div>
            </div>
            <div className="rd-kpi">
              <div className="rd-kpi-icon"><Layers size={20} /></div>
              <div className="rd-kpi-body">
                <div className="rd-kpi-val">{fmtInt(summary.unpaid_count)}</div>
                <div className="rd-kpi-lbl">فواتير غير مسددة</div>
              </div>
            </div>
            <div className="rd-kpi">
              <div className="rd-kpi-icon"><Layers size={20} /></div>
              <div className="rd-kpi-body">
                <div className="rd-kpi-val">{fmtInt(summary.partial_count)}</div>
                <div className="rd-kpi-lbl">فواتير مسددة جزئياً</div>
              </div>
            </div>
          </div>

          {/* ── Tabs ── */}
          <div className="rd-tabs rd-no-print">
            <button
              className={`rd-tab${activeTab === 'invoices' ? ' rd-tab--active' : ''}`}
              onClick={() => setActiveTab('invoices')}
            >
              الفواتير
            </button>
            <button
              className={`rd-tab${activeTab === 'customers' ? ' rd-tab--active' : ''}`}
              onClick={() => setActiveTab('customers')}
            >
              صافي مديونية العملاء
            </button>
          </div>

          {/* ── Exclusion filters (affect table + print + Excel export) ── */}
          <div className="rd-filters rd-no-print">
            <button
              className={`rd-filter-btn${excludeCarrefour ? ' rd-filter-btn--active' : ''}`}
              onClick={() => setExcludeCarrefour(v => !v)}
              title="استبعاد عميل كارفور من الطباعة والتصدير والعرض"
            >
              <Ban size={13} /> استبعاد كارفور
            </button>
            <button
              className={`rd-filter-btn${excludeZero ? ' rd-filter-btn--active' : ''}`}
              onClick={() => setExcludeZero(v => !v)}
              title="استبعاد الصفوف بصافي مديونية = 0"
            >
              <EyeOff size={13} /> استبعاد القيم صفر
            </button>
          </div>

          {activeTab === 'invoices' ? (
            /* ── Invoice table ── */
            <div className="rd-table-wrap">
              <table className="rd-table">
                <thead>
                  <tr>
                    {INV_COLUMNS.map(col => (
                      <th
                        key={col.key}
                        className={`rd-th${sortCol === col.key ? ' rd-th--sorted' : ''}`}
                        onClick={() => handleSort(col.key)}
                      >
                        {col.label}
                        <span className="rd-sort">
                          {sortCol === col.key ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ' ⇅'}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedInvoices.length === 0 ? (
                    <tr><td colSpan={8} className="rd-empty">لا توجد فواتير غير مسددة لهذا المندوب</td></tr>
                  ) : (
                    sortedInvoices.map(inv => (
                      <tr key={inv.id} className={rowClass(inv)}>
                        <td className="rd-td-num">{inv.invoice_number}</td>
                        <td className="rd-td-name">{inv.customer_name}</td>
                        <td>{inv.region_name_ar || '—'}</td>
                        <td className="rd-td-num">{fmtDate(inv.invoice_date)}</td>
                        <td className="rd-td-num">{fmt(inv.original_amount)}</td>
                        <td className="rd-td-num">{fmt(inv.paid_amount)}</td>
                        <td className="rd-td-num rd-td-balance">{fmt(inv.balance)}</td>
                        <td><StatusBadge status={inv.status} /></td>
                      </tr>
                    ))
                  )}
                </tbody>
                {invoices.length > 0 && (
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="rd-tf-lbl">الإجمالي ({invoices.length} فاتورة)</td>
                      <td className="rd-td-num">{fmt(invSummary.total_amount)}</td>
                      <td className="rd-td-num">{fmt(invSummary.total_paid)}</td>
                      <td className="rd-td-num rd-td-balance">{fmt(invSummary.total_balance)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          ) : (
            /* ── Per-customer net debt table ── */
            <div className="rd-table-wrap">
              <table className="rd-table">
                <thead>
                  <tr>
                    {CUST_COLUMNS.map(col => (
                      <th
                        key={col.key}
                        className={`rd-th${custSortCol === col.key ? ' rd-th--sorted' : ''}`}
                        onClick={() => handleCustSort(col.key)}
                      >
                        {col.label}
                        <span className="rd-sort">
                          {custSortCol === col.key ? (custSortDir === 'desc' ? ' ▼' : ' ▲') : ' ⇅'}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedCustomers.length === 0 ? (
                    <tr><td colSpan={6} className="rd-empty">لا توجد فواتير غير مسددة لهذا المندوب</td></tr>
                  ) : (
                    sortedCustomers.map(c => (
                      <tr key={c.customer_id || c.customer_name}>
                        <td className="rd-td-name">{c.customer_name}</td>
                        <td>{c.region_name_ar || '—'}</td>
                        <td className="rd-td-num">{fmtInt(c.invoice_count)}</td>
                        <td className="rd-td-num">{fmt(c.total_amount)}</td>
                        <td className="rd-td-num">{fmt(c.total_paid)}</td>
                        <td className="rd-td-num rd-td-balance">{fmt(c.total_balance)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
                {customerRows.length > 0 && (
                  <tfoot>
                    <tr>
                      <td colSpan={2} className="rd-tf-lbl">الإجمالي ({customerRows.length} عميل)</td>
                      <td className="rd-td-num">{fmtInt(invoices.length)}</td>
                      <td className="rd-td-num">{fmt(custSummary.total_amount)}</td>
                      <td className="rd-td-num">{fmt(custSummary.total_paid)}</td>
                      <td className="rd-td-num rd-td-balance">{fmt(custSummary.total_balance)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}

          {/* ── Print-only footer note + signature ── */}
          <div className="rd-print-footer">
            <p className="rd-print-note">
              رصيد المندوب بتاريخ الطباعة هو <strong>{fmt((activeTab === 'customers' ? custSummary : invSummary).total_balance)} ر.س</strong>
              {filtersActive && <> (بعد استبعاد {[excludeCarrefour && 'كارفور', excludeZero && 'القيم الصفرية'].filter(Boolean).join(' و')})</>}
            </p>
            <p className="rd-print-meta">
              تمت الطباعة بواسطة: <strong>{user?.name || '—'}</strong> — تاريخ الطباعة: <strong>{printDate}</strong>
            </p>
            <div className="rd-print-signatures">
              <div className="rd-print-signature">
                <span className="rd-print-signature-label">الاعتماد من المندوب</span>
                <div className="rd-print-signature-box"></div>
              </div>
              <div className="rd-print-signature">
                <span className="rd-print-signature-label">التوقيع بالاعتماد من الحسابات</span>
                <div className="rd-print-signature-box"></div>
              </div>
              <div className="rd-print-signature">
                <span className="rd-print-signature-label">الاعتماد من المدير المالي</span>
                <div className="rd-print-signature-box"></div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
