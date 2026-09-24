import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ArrowDown, Download, GitMerge } from 'lucide-react';
import CustomerNoteCell from './CustomerNoteCell';
import { useLanguage } from '../../context/LanguageContext';
import './CustomerSummaryTable.css';

/* ── Formatters ──────────────────────────────────── */
const fmt = (n) => {
  if (n === null || n === undefined || n === '') return '—';
  return Number(n).toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/* ── Rate bar ────────────────────────────────────── */
function RateBar({ rate }) {
  const r = Math.min(100, Math.max(0, parseFloat(rate) || 0));
  const color = r >= 90 ? 'var(--color-brand-green)' : r >= 60 ? 'var(--color-warning)' : 'var(--color-brand-red)';
  return (
    <div className="rate-cell">
      <div className="bar">
        <div className="bar-fill" style={{ '--bar-color': color, width: `${r}%` }} />
      </div>
      <span className="rate-val" style={{ '--rate-color': color }}>{r.toFixed(1)}%</span>
    </div>
  );
}

/* ── Status breakdown ────────────────────────────── */
function StatusBreakdown({ paid, partial, unpaid }) {
  const { lang } = useLanguage();
  const en = lang === 'en';
  return (
    <div className="status-breakdown">
      {Number(unpaid)  > 0 && <span className="sb sb--unpaid">{unpaid} {en ? 'unpaid' : 'غير مسدد'}</span>}
      {Number(partial) > 0 && <span className="sb sb--partial">{partial} {en ? 'partial' : 'جزئي'}</span>}
      {Number(paid)    > 0 && <span className="sb sb--paid">{paid} {en ? 'paid' : 'مسدد'}</span>}
    </div>
  );
}

/* ── Sort header — fires server-side re-fetch ────── */
function Th({ label, k, sortBy, dir, onSort }) {
  const active = sortBy === k;
  return (
    <th
      className={`sortable${active ? ' sorted' : ''}`}
      onClick={() => onSort(k)}
    >
      <span style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
        {label}
        {active
          ? (dir === 'ASC' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)
          : <span style={{ opacity:0.3, fontSize:10 }}>↕</span>
        }
      </span>
    </th>
  );
}

/* ── Row colouring ───────────────────────────────── */
function rowClass(row) {
  const bal  = parseFloat(row.total_balance || 0);
  const orig = parseFloat(row.total_amount  || 1);
  if (bal <= 0) return '';
  if (orig > 0 && bal / orig >= 0.8) return 'row-danger';
  return 'row-warning';
}

/* ── Column definitions ──────────────────────────── */
/* `w` feeds the <colgroup>; the table is table-layout:fixed so these are the
   real column widths (they scale up proportionally on a wider screen). */
const COLS = [
  { key: 'customer_name',   label: 'اسم العميل',         labelEn: 'Customer Name',   w: 200 },
  { key: 'customer_id',     label: 'كود العميل',          labelEn: 'Customer Code',   w:  86 },
  { key: 'region_name_ar',  label: 'المنطقة',  labelEn: 'Region',  noSort: true,      w:  78 },
  { key: 'route_id',        label: 'خط السير',            labelEn: 'Route',           w:  64 },
  { key: 'sales_rep_name',  label: 'المندوب',             labelEn: 'Rep',             w: 132 },
  { key: 'invoice_count',   label: 'عدد الفواتير',        labelEn: 'Invoice Count',   w:  66 },
  { key: 'total_amount',    label: 'إجمالي المعاملات',    labelEn: 'Total Amount',    w: 104 },
  { key: 'total_paid',      label: 'إجمالي المدفوع',      labelEn: 'Total Paid',      w: 104 },
  { key: 'total_balance',   label: 'إجمالي الرصيد',       labelEn: 'Total Balance',   w: 104 },
  { key: 'collection_rate', label: 'نسبة التحصيل',        labelEn: 'Collection Rate', w: 112 },
  { key: 'unpaid_count',    label: 'تفاصيل الحالة',       labelEn: 'Status Detail',   w: 100 },
  { key: 'customer_note',        label: 'ملاحظات',  labelEn: 'Notes',       noSort: true, w: 132 },
  { key: 'reconciliation_count', label: 'مطابقة',   labelEn: 'Reconciliation', noSort: true, w:  66 },
];

/* ── Export helper (fetch → blob → anchor) ───────── */
async function triggerDownload(url, filename, en) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`${en ? 'Error' : 'خطأ'} ${res.status}${txt ? ': ' + txt.slice(0, 120) : ''}`);
    }
    const blob   = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href       = objUrl;
    a.download   = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objUrl);
  } catch (err) {
    console.error('Download failed:', err);
    alert((en ? 'Download failed: ' : 'فشل التحميل: ') + err.message);
  }
}

/* ── Main component ──────────────────────────────── */
/* sortBy / sortDir / onSort come from Dashboard — server-side sort */
export default function CustomerSummaryTable({
  data = [], loading, total = 0, dashboardParams,
  sortBy, sortDir, onSort, exportParams = {},
}) {
  const navigate     = useNavigate();
  const queryClient  = useQueryClient();
  const { lang }      = useLanguage();
  const en            = lang === 'en';

  const onNoteSaved = () => {
    queryClient.invalidateQueries({ queryKey: ['customers-summary'] });
    queryClient.invalidateQueries({ queryKey: ['notes-report'] });
  };

  /* Build export URL with same filters */
  const buildExportUrl = (fmt) => {
    const base  = `/api/export/${fmt}`;
    const token = localStorage.getItem('token') || '';
    const qs    = new URLSearchParams({ ...exportParams, token }).toString();
    return `${base}?${qs}`;
  };

  /* Loading */
  if (loading) {
    return (
      <div className="cs-table-card" style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:200, gap:12 }}>
        <div className="spinner" style={{ width:32, height:32 }} />
        <span style={{ fontSize:13, color:'var(--color-text-muted)' }}>{en ? 'Loading customer data…' : 'جاري تحميل بيانات العملاء…'}</span>
      </div>
    );
  }

  /* Empty */
  if (!data.length) {
    return (
      <div className="cs-table-card" style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:200, gap:8 }}>
        <span style={{ fontSize:40 }}>📭</span>
        <span style={{ fontSize:14, fontWeight:600, color:'var(--color-text-secondary)' }}>{en ? 'No data matches the selected filters' : 'لا توجد بيانات مطابقة للفلاتر المحددة'}</span>
      </div>
    );
  }

  return (
    <div className="cs-table-card">
      {/* Toolbar */}
      <div className="cs-toolbar">
        <span style={{ fontSize:13, color:'var(--color-text-secondary)' }}>
          <strong style={{ color:'var(--color-text-primary)' }}>{data.length.toLocaleString('en-SA')}</strong> {en ? 'customers' : 'عميل'}
          {total > data.length && (
            <span style={{ color:'var(--color-text-muted)', fontSize:11 }}> {en ? `(of ${total.toLocaleString('en-SA')})` : `(من أصل ${total.toLocaleString('en-SA')})`}</span>
          )}
        </span>
        <div className="cs-toolbar-actions">
          <button className="chip-btn"
            onClick={() => triggerDownload(buildExportUrl('csv'), `${en ? 'report' : 'تقرير'}_${new Date().toISOString().slice(0,10)}.csv`, en)}>
            <Download size={13} /> CSV
          </button>
          <button className="chip-btn gold"
            onClick={() => triggerDownload(buildExportUrl('excel'), `${en ? 'balances_report' : 'تقرير_الارصدة'}_${new Date().toISOString().slice(0,10)}.xlsx`, en)}>
            <Download size={13} /> {en ? 'Export Excel' : 'تصدير Excel'}
          </button>
        </div>
      </div>

      {/* Table — data arrives pre-sorted from server */}
      <div className="cs-table-wrap">
        <table className="cs-table">
          {/* one <col> per COLS entry — built from the same array as the
              headers so the two can never desync */}
          <colgroup>
            {COLS.map(c => <col key={c.key} style={{ width: c.w }} />)}
          </colgroup>
          <thead>
            <tr>
              {COLS.map(c =>
                c.noSort ? (
                  <th key={c.key}>{en ? c.labelEn : c.label}</th>
                ) : (
                  <Th key={c.key} label={en ? c.labelEn : c.label} k={c.key}
                      sortBy={sortBy} dir={sortDir} onSort={onSort} />
                )
              )}
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr
                key={row.customer_id}
                className={rowClass(row)}
                style={{ cursor:'pointer' }}
                onClick={() =>
                  navigate(`/customers/${encodeURIComponent(row.customer_id)}`,
                    { state: { dashboardParams } })
                }
              >
                {/* Customer name */}
                <td className="cs-c-name">
                  <div style={{ fontWeight:600, fontSize:12.5, lineHeight:1.3 }}>{row.customer_name}</div>
                  {row.customer_name_en && row.customer_name_en !== row.customer_name && (
                    <div style={{ fontSize:11, color:'var(--color-text-muted)', fontFamily:'var(--font-en)' }}>
                      {row.customer_name_en}
                    </div>
                  )}
                </td>

                <td className="num" style={{ fontSize:12, color:'var(--color-text-muted)' }}>
                  {row.customer_id}
                </td>

                <td className="cs-c-region">{row.region_name_ar || '—'}</td>

                <td className="num" style={{ fontSize:12 }}>{row.route_id || '—'}</td>

                <td className="cs-c-rep" style={{ fontSize:11.5 }}>{row.sales_rep_name || '—'}</td>

                <td className="num" style={{ textAlign:'center', fontWeight:700, color:'var(--color-text-primary)' }}>
                  {Number(row.invoice_count).toLocaleString('en-SA')}
                </td>

                <td className="amount num">{fmt(row.total_amount)}</td>

                <td className="amount paid num">{fmt(row.total_paid)}</td>

                <td className={`amount num${parseFloat(row.total_balance) > 0 ? ' balance' : ''}`}>
                  {fmt(row.total_balance)}
                </td>

                <td><RateBar rate={row.collection_rate} /></td>

                <td>
                  <StatusBreakdown
                    paid={row.paid_count}
                    partial={row.partial_count}
                    unpaid={row.unpaid_count}
                  />
                </td>

                <td className="notes-td" onClick={e => e.stopPropagation()}>
                  <CustomerNoteCell
                    customerId={row.customer_id}
                    initialText={row.customer_note || ''}
                    onSaved={onNoteSaved}
                  />
                </td>

                {/* Reconciliation badge */}
                <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                  {Number(row.reconciliation_count) > 0 ? (
                    <span className="recon-badge" title={en ? `${row.reconciliation_count} reconciliation file(s)` : `${row.reconciliation_count} ملف مطابقة`}>
                      <GitMerge size={10} />
                      {row.reconciliation_count}
                    </span>
                  ) : (
                    <span className="recon-badge recon-badge--missing" title={en ? 'No reconciliation file' : 'لا يوجد ملف مطابقة'}>
                      —
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > data.length && (
        <div style={{
          padding:'10px 18px', borderTop:'1px solid var(--color-border)',
          fontSize:12, color:'var(--color-text-muted)', background:'var(--color-warning-bg)',
          textAlign:'center',
        }}>
          {en
            ? `Showing the first ${data.length.toLocaleString('en-SA')} of ${total.toLocaleString('en-SA')} customers — use the filters to narrow the results`
            : `يتم عرض أول ${data.length.toLocaleString('en-SA')} عميل من ${total.toLocaleString('en-SA')} — استخدم الفلاتر لتضييق النتائج`}
        </div>
      )}
    </div>
  );
}
