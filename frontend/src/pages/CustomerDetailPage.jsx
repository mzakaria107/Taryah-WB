import React, { useState, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Download, FileText, BarChart2, MessageSquare, User, Trash2, CreditCard, ChevronDown, ChevronUp, GitMerge, Upload, CheckCircle, AlertCircle, RefreshCw, Paperclip, Calendar } from 'lucide-react';
import NotesCell from '../components/Dashboard/NotesCell';
import { useNotes } from '../hooks/useNotes';
import { useAuth } from '../context/AuthContext';
import client from '../api/client';
import './CustomerDetailPage.css';

/* ── Helpers ──────────────────────────────────── */
const fmt = (n) =>
  n == null ? '—'
  : Number(n).toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtInt  = (n) => Math.round(Number(n || 0)).toLocaleString('en-SA');
const fmtDate = (d) => d ? String(d).split('T')[0] : '—';

const MONTH_AR = ['','يناير','فبراير','مارس','أبريل','مايو','يونيو',
                  'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const ALL_MONTHS = [1,2,3,4,5,6,7,8,9,10,11,12];

/* ── Rate bar ─────────────────────────────────── */
function RateBar({ rate }) {
  const r = Math.min(100, Math.max(0, parseFloat(rate) || 0));
  const color = r >= 90 ? 'var(--color-brand-green)'
              : r >= 60 ? 'var(--color-warning)'
              :            'var(--color-danger)';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8, minWidth:110 }}>
      <div style={{ flex:1, height:6, background:'var(--color-border)', borderRadius:999, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${r}%`, background:color, borderRadius:999, transition:'width 400ms' }} />
      </div>
      <span style={{ fontSize:11, fontFamily:'var(--font-en)', color, fontWeight:700, minWidth:40 }}>
        {r.toFixed(1)}%
      </span>
    </div>
  );
}

/* ── Status badge ─────────────────────────────── */
const STATUS_MAP = { paid:['مسددة','paid'], partial:['جزئي','partial'], unpaid:['غير مسددة','unpaid'] };
function StatusBadge({ status }) {
  const [label, cls] = STATUS_MAP[status] || ['—',''];
  return <span className={`badge ${cls}`}>{label}</span>;
}

/* ── Row highlight ────────────────────────────── */
function rowClass(inv) {
  if (inv.status === 'paid') return '';
  const bal  = parseFloat(inv.balance || 0);
  const orig = parseFloat(inv.original_amount || 1);
  if (bal > 0 && orig > 0 && bal / orig >= 0.8) return 'row-danger';
  if (inv.status === 'partial') return 'row-warning';
  return '';
}

/* ── CSV Export ───────────────────────────────── */
function exportCSV(rows, customer) {
  const hdr = ['رقم الفاتورة','التاريخ','السنة','المفوتر','المحصل','المتبقي','%التحصيل','الحالة','ملاحظات'];
  const body = rows.map(r => [
    r.invoice_number, fmtDate(r.invoice_date), r.year,
    r.original_amount, r.paid_amount, r.balance, r.collection_rate,
    STATUS_MAP[r.status]?.[0] || r.status,
    `"${(r.note_text || '').replace(/"/g, '""')}"`,
  ].join(','));
  const blob = new Blob(['﻿' + [hdr.join(','), ...body].join('\n')],
                        { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = `${customer?.customer_id || 'customer'}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ═══════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════ */
export default function CustomerDetailPage() {
  const { customerId } = useParams();
  const navigate       = useNavigate();
  const location       = useLocation();
  const queryClient    = useQueryClient();

  // Inherit dashboard params passed via navigate state
  const inherited = location.state?.dashboardParams || {};

  const [tab,           setTab]          = useState('detail');
  const [statusFilter,  setStatusFilter] = useState('');
  const [activeYears,   setActiveYears]  = useState(null);   // null = all
  const [activeMonths,  setActiveMonths] = useState(null);   // null = all

  /* ── Build query params ─────────────────────── */
  const params = useMemo(() => {
    const p = { ...inherited };
    if (activeYears  && activeYears.size  > 0) p.years  = [...activeYears].sort().join(',');
    else delete p.years;
    if (activeMonths && activeMonths.size > 0) p.months = [...activeMonths].sort((a,b)=>a-b).join(',');
    else delete p.months;
    return p;
  }, [inherited, activeYears, activeMonths]);

  /* ── Fetch ──────────────────────────────────── */
  const { data, isLoading, isError } = useQuery({
    queryKey: ['customer-detail', customerId, params],
    queryFn: () =>
      client.get(`/invoices/customer/${encodeURIComponent(customerId)}`, { params })
            .then(r => r.data),
    enabled: !!customerId,
    staleTime: 30_000,
  });

  const { customer, summary, invoices = [] } = data || {};

  /* ── Invalidate queries after note save ── */
  const onNoteSaved = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['customer-detail', customerId] });
    queryClient.invalidateQueries({ queryKey: ['notes-history', customerId] });
    queryClient.invalidateQueries({ queryKey: ['notes-report'] });
    queryClient.invalidateQueries({ queryKey: ['customers-summary'] });
  }, [queryClient, customerId]);

  /* ── Available years from data ──────────────── */
  const availableYears = useMemo(
    () => [...new Set(invoices.map(i => i.year).filter(Boolean))].sort((a,b) => a - b),
    [invoices]
  );

  /* ── Filter invoices ────────────────────────── */
  const filtered = useMemo(() => {
    let rows = invoices;
    if (statusFilter === 'due') rows = rows.filter(r => r.status === 'partial' || r.status === 'unpaid');
    else if (statusFilter)      rows = rows.filter(r => r.status === statusFilter);

    if (activeYears  && activeYears.size > 0)
      rows = rows.filter(r => activeYears.has(r.year));
    if (activeMonths && activeMonths.size > 0)
      rows = rows.filter(r => activeMonths.has(new Date(r.invoice_date).getMonth() + 1));

    return rows;
  }, [invoices, statusFilter, activeYears, activeMonths]);

  /* ── Filtered summary ───────────────────────── */
  const filteredSummary = useMemo(() => {
    const total   = filtered.reduce((s,r) => s + parseFloat(r.original_amount||0), 0);
    const paid    = filtered.reduce((s,r) => s + parseFloat(r.paid_amount||0), 0);
    const balance = filtered.reduce((s,r) => s + parseFloat(r.balance||0), 0);
    return {
      invoice_count:   filtered.length,
      total_amount:    total,
      total_paid:      paid,
      total_balance:   balance,
      collection_rate: total > 0 ? (paid / total) * 100 : 0,
      paid_count:    filtered.filter(r => r.status === 'paid').length,
      partial_count: filtered.filter(r => r.status === 'partial').length,
      unpaid_count:  filtered.filter(r => r.status === 'unpaid').length,
    };
  }, [filtered]);

  /* ── Year chip toggle ───────────────────────── */
  const toggleYear = (y) => {
    setActiveYears(prev => {
      const base = prev ? new Set(prev) : new Set(availableYears);
      if (base.has(y)) base.delete(y); else base.add(y);
      return base.size === availableYears.length ? null : base;
    });
  };

  /* ── Month chip toggle ──────────────────────── */
  const toggleMonth = (m) => {
    setActiveMonths(prev => {
      const base = prev ? new Set(prev) : new Set(ALL_MONTHS);
      if (base.has(m)) base.delete(m); else base.add(m);
      return base.size === 12 ? null : base;
    });
  };

  const isYearActive  = (y) => !activeYears  || activeYears.has(y);
  const isMonthActive = (m) => !activeMonths || activeMonths.has(m);

  /* ── Render ─────────────────────────────────── */
  // Guard: no customerId means page was reached incorrectly (e.g. stale cache)
  if (!customerId) return <Navigate to="/" replace />;

  if (isLoading) return (
    <div className="cd-loading">
      <div className="spinner" style={{ width:36, height:36 }} />
      <span>جاري تحميل بيانات العميل…</span>
    </div>
  );

  if (isError || (!isLoading && data === undefined)) return (
    <div className="cd-error">
      <span style={{ fontSize:40 }}>⚠️</span>
      <p>تعذّر تحميل بيانات العميل</p>
      <button className="cd-back-btn" onClick={() => navigate(-1)}>رجوع</button>
    </div>
  );

  const cr = Number(filteredSummary.collection_rate);
  const crColor = cr >= 90 ? 'var(--color-brand-green)' : cr >= 60 ? 'var(--color-warning)' : 'var(--color-danger)';

  return (
    <div className="cd-page">

      {/* ── Breadcrumb / back ── */}
      <div className="cd-breadcrumb">
        <button className="cd-back-btn" onClick={() => navigate(-1)}>
          <ArrowRight size={15} />
          رجوع
        </button>
        <span className="cd-crumb-sep">›</span>
        <span className="cd-crumb-item">العملاء</span>
        <span className="cd-crumb-sep">›</span>
        <span className="cd-crumb-item active">{customer?.customer_name || customerId}</span>
      </div>

      {/* ── Customer header card ── */}
      <div className="cd-header-card">
        <div className="cd-header-top">
          <div className="cd-customer-name">
            <span className="cd-name-ar">{customer?.customer_name}</span>
            {customer?.customer_name_en && (
              <span className="cd-name-en">{customer.customer_name_en}</span>
            )}
            {customer?.customer_type === 'direct' && (
              <span className="cd-direct-badge">مبيعات مباشرة</span>
            )}
          </div>
        </div>
        <div className="cd-meta-row">
          <div className="cd-meta-item">
            <span className="cd-meta-lbl">كود العميل</span>
            <span className="cd-meta-val">{customer?.customer_id || '—'}</span>
          </div>
          <div className="cd-meta-item">
            <span className="cd-meta-lbl">المنطقة</span>
            <span className="cd-meta-val">{customer?.region_name_ar || '—'}</span>
          </div>
          <div className="cd-meta-item">
            <span className="cd-meta-lbl">المندوب</span>
            <span className="cd-meta-val">{customer?.sales_rep_name || '—'}</span>
          </div>
          <div className="cd-meta-item">
            <span className="cd-meta-lbl">كود المسار</span>
            <span className="cd-meta-val">{customer?.route_id || '—'}</span>
          </div>
        </div>
      </div>

      {/* ── KPI bar ── */}
      <div className="cd-kpi-bar">
        <div className="cd-kpi">
          <span className="cd-kpi-lbl">الفواتير</span>
          <span className="cd-kpi-val">{fmtInt(filteredSummary.invoice_count)}</span>
        </div>
        <div className="cd-kpi">
          <span className="cd-kpi-lbl">الإجمالي المفوتر</span>
          <span className="cd-kpi-val">{fmtInt(filteredSummary.total_amount)}</span>
        </div>
        <div className="cd-kpi">
          <span className="cd-kpi-lbl">المحصل</span>
          <span className="cd-kpi-val" style={{ color:'var(--color-brand-green)' }}>
            {fmtInt(filteredSummary.total_paid)}
          </span>
        </div>
        <div className="cd-kpi">
          <span className="cd-kpi-lbl">المتبقي</span>
          <span className="cd-kpi-val" style={{ color: filteredSummary.total_balance > 0 ? 'var(--color-danger)' : 'inherit' }}>
            {filteredSummary.total_balance > 0 ? fmtInt(filteredSummary.total_balance) : '—'}
          </span>
        </div>
        <div className="cd-kpi cd-kpi--rate">
          <span className="cd-kpi-lbl">نسبة التحصيل</span>
          <span className="cd-kpi-val" style={{ color: crColor }}>{cr.toFixed(1)}%</span>
          <div className="cd-kpi-bar-wrap">
            <div style={{ height:4, background:'var(--color-border)', borderRadius:999, overflow:'hidden' }}>
              <div style={{ height:'100%', width:`${Math.min(100,cr)}%`, background:crColor, borderRadius:999, transition:'width 600ms' }} />
            </div>
          </div>
        </div>
        <div className="cd-kpi">
          <span className="cd-kpi-lbl">مسددة</span>
          <span className="cd-kpi-val" style={{ color:'var(--color-brand-green)' }}>
            {fmtInt(filteredSummary.paid_count)}
          </span>
        </div>
        <div className="cd-kpi">
          <span className="cd-kpi-lbl">جزئي</span>
          <span className="cd-kpi-val" style={{ color: filteredSummary.partial_count > 0 ? 'var(--color-warning)' : 'inherit' }}>
            {fmtInt(filteredSummary.partial_count)}
          </span>
        </div>
        <div className="cd-kpi">
          <span className="cd-kpi-lbl">غير مسددة</span>
          <span className="cd-kpi-val" style={{ color: filteredSummary.unpaid_count > 0 ? 'var(--color-danger)' : 'inherit' }}>
            {fmtInt(filteredSummary.unpaid_count)}
          </span>
        </div>

        {/* ── Reconciliation status card ── */}
        <div className={`cd-kpi cd-kpi--recon ${(customer?.reconciliation_count || 0) > 0 ? 'cd-recon--ok' : 'cd-recon--missing'}`}>
          <span className="cd-kpi-lbl">المطابقة</span>
          <div className="cd-recon-status">
            <span className="cd-recon-dot" />
            <span className="cd-recon-label">
              {(customer?.reconciliation_count || 0) > 0 ? 'مطابق' : 'غير مطابق'}
            </span>
          </div>
          {(customer?.reconciliation_count || 0) > 0 && (
            <span className="cd-recon-count">{customer.reconciliation_count} ملف</span>
          )}
        </div>
      </div>

      {/* ── Period filter chips ── */}
      <div className="cd-period-card">
        {availableYears.length > 0 && (
          <div className="cd-chips-row">
            <span className="cd-chips-lbl">السنة:</span>
            <button
              className={`chip${!activeYears ? ' chip--active' : ''}`}
              onClick={() => setActiveYears(null)}
            >الكل</button>
            {availableYears.map(y => (
              <button
                key={y}
                className={`chip${isYearActive(y) ? ' chip--active' : ''}`}
                onClick={() => toggleYear(y)}
              >{y}</button>
            ))}
          </div>
        )}
        <div className="cd-chips-row">
          <span className="cd-chips-lbl">الشهر:</span>
          <button
            className={`chip${!activeMonths ? ' chip--active' : ''}`}
            onClick={() => setActiveMonths(null)}
          >الكل</button>
          {ALL_MONTHS.map(m => (
            <button
              key={m}
              className={`chip chip--sm${isMonthActive(m) ? ' chip--active' : ''}`}
              onClick={() => toggleMonth(m)}
            >{m} - {MONTH_AR[m]}</button>
          ))}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="cd-tabs">
        <button
          className={`cd-tab${tab === 'detail' ? ' active' : ''}`}
          onClick={() => setTab('detail')}
        >
          <FileText size={14} /> تفاصيل الفواتير
        </button>
        <button
          className={`cd-tab${tab === 'summary' ? ' active' : ''}`}
          onClick={() => setTab('summary')}
        >
          <BarChart2 size={14} /> الإجمالي التراكمي
        </button>
        <button
          className={`cd-tab${tab === 'payments' ? ' active' : ''}`}
          onClick={() => setTab('payments')}
        >
          <CreditCard size={14} /> حركات السداد
        </button>
        <button
          className={`cd-tab${tab === 'history' ? ' active' : ''}`}
          onClick={() => setTab('history')}
        >
          <MessageSquare size={14} /> سجل الملاحظات
        </button>
        <button
          className={`cd-tab${tab === 'reconciliation' ? ' active' : ''}`}
          onClick={() => setTab('reconciliation')}
        >
          <GitMerge size={14} /> مطابقة العميل
        </button>
      </div>

      {/* ════ TAB: DETAIL ════ */}
      {tab === 'detail' && (
        <div className="cd-table-card">
          {/* toolbar */}
          <div className="cd-table-toolbar">
            <span className="cd-table-title">
              فواتير العميل
              <span className="cd-count-badge">{filtered.length}</span>
            </span>
            <div className="cd-toolbar-right">
              <select
                className="cd-select"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
              >
                <option value="">جميع الحالات</option>
                <option value="due">غير مسددة بالكامل</option>
                <option value="paid">مسددة</option>
                <option value="partial">جزئي</option>
                <option value="unpaid">غير مسدد</option>
              </select>
              <button className="cd-export-btn" onClick={() => exportCSV(filtered, customer)}>
                <Download size={13} /> CSV
              </button>
              <span className="cd-sum-chip">
                إجمالي: {fmtInt(filtered.reduce((s,r) => s + parseFloat(r.original_amount||0),0))}
              </span>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="cd-empty">📭 لا توجد فواتير مطابقة</div>
          ) : (
            <div className="cd-table-wrap">
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>التاريخ</th>
                    <th>رقم الفاتورة</th>
                    <th>السنة</th>
                    <th>المفوتر</th>
                    <th>المحصل</th>
                    <th>المتبقي</th>
                    <th>% التحصيل</th>
                    <th>الحالة</th>
                    <th>ملاحظات</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(inv => (
                    <tr key={inv.id} className={rowClass(inv)}>
                      <td className="num">{fmtDate(inv.invoice_date)}</td>
                      <td className="num">{inv.invoice_number}</td>
                      <td className="num center">{inv.year}</td>
                      <td className="num amt">{fmt(inv.original_amount)}</td>
                      <td className="num amt green">{fmt(inv.paid_amount)}</td>
                      <td className={`num amt${parseFloat(inv.balance)>0?' red':''}`}>
                        {parseFloat(inv.balance) > 0 ? fmt(inv.balance) : '—'}
                      </td>
                      <td><RateBar rate={inv.collection_rate} /></td>
                      <td><StatusBadge status={inv.status} /></td>
                      <td className="notes-td" onClick={e => e.stopPropagation()}>
                        <NotesCell invoiceId={inv.id} initialText={inv.note_text || ''} onSaved={onNoteSaved} onDeleted={onNoteSaved} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ════ TAB: SUMMARY ════ */}
      {tab === 'summary' && (
        <YearSummaryTab invoices={invoices} summary={summary} customer={customer} />
      )}

      {/* ════ TAB: PAYMENTS ════ */}
      {tab === 'payments' && (
        <PaymentsTab customerId={customerId} />
      )}

      {/* ════ TAB: NOTES HISTORY ════ */}
      {tab === 'history' && (
        <NotesHistoryTab customerId={customerId} />
      )}

      {/* ════ TAB: RECONCILIATION ════ */}
      {tab === 'reconciliation' && (
        <ReconciliationTab customerId={customerId} />
      )}
    </div>
  );
}

/* ── Year Summary Tab ─────────────────────────── */
function YearSummaryTab({ invoices, summary, customer }) {
  const byYear = useMemo(() => {
    const map = {};
    invoices.forEach(inv => {
      const y = inv.year || 'غير محدد';
      if (!map[y]) map[y] = { year: y, rows: [], total: 0, paid: 0, balance: 0,
                               paid_c: 0, partial_c: 0, unpaid_c: 0 };
      map[y].rows.push(inv);
      map[y].total   += parseFloat(inv.original_amount || 0);
      map[y].paid    += parseFloat(inv.paid_amount     || 0);
      map[y].balance += parseFloat(inv.balance         || 0);
      if (inv.status === 'paid')    map[y].paid_c++;
      if (inv.status === 'partial') map[y].partial_c++;
      if (inv.status === 'unpaid')  map[y].unpaid_c++;
    });
    return Object.values(map).sort((a,b) => Number(b.year) - Number(a.year));
  }, [invoices]);

  const YEAR_COLORS = { 2024:'#c62828', 2025:'#2e7d32', 2026:'#e65100' };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

      {/* Overall summary */}
      <div className="cd-kpi-bar" style={{ background:'#fff', borderRadius:'var(--radius-lg)',
        border:'1px solid var(--color-border)', boxShadow:'var(--shadow-card)' }}>
        {[
          { l:'الفواتير',    v: fmtInt(summary?.invoice_count),  c: '' },
          { l:'الإجمالي',   v: fmtInt(summary?.total_amount),   c: '' },
          { l:'المحصل',     v: fmtInt(summary?.total_paid),     c: 'green' },
          { l:'المتبقي',    v: summary?.total_balance > 0 ? fmtInt(summary.total_balance) : '—', c: summary?.total_balance > 0 ? 'red' : '' },
          { l:'التحصيل',   v: `${Number(summary?.collection_rate||0).toFixed(1)}%`, c: Number(summary?.collection_rate||0)>=90?'green':Number(summary?.collection_rate||0)>=60?'orange':'red' },
          { l:'مسددة',     v: fmtInt(summary?.paid_count),     c: 'green' },
          { l:'جزئي',      v: fmtInt(summary?.partial_count),  c: summary?.partial_count > 0 ? 'orange' : '' },
          { l:'غير مسددة', v: fmtInt(summary?.unpaid_count),   c: summary?.unpaid_count  > 0 ? 'red'    : '' },
        ].map(({ l, v, c }) => (
          <div key={l} className="cd-kpi">
            <span className="cd-kpi-lbl">{l}</span>
            <span className={`cd-kpi-val${c ? ' ' + c : ''}`}>{v}</span>
          </div>
        ))}
      </div>

      {/* Per-year */}
      {byYear.map(yd => {
        const rate  = yd.total > 0 ? (yd.paid / yd.total) * 100 : 0;
        const yc    = YEAR_COLORS[yd.year] || 'var(--color-text-muted)';
        return (
          <div key={yd.year} className="cd-table-card">
            <div className="cd-year-header" style={{ borderRightColor: yc }}>
              <span className="cd-year-num" style={{ color: yc }}>{yd.year}</span>
              <span className="cd-year-count">{yd.rows.length} فاتورة</span>
              <div style={{ flex:1, maxWidth:200 }}>
                <div style={{ height:6, background:'var(--color-border)', borderRadius:999, overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${Math.min(100,rate)}%`, background:yc, borderRadius:999 }} />
                </div>
              </div>
              <span style={{ fontSize:13, fontWeight:700, color:yc, fontFamily:'var(--font-en)' }}>
                {rate.toFixed(1)}%
              </span>
              <div className="cd-year-stats">
                <span>إجمالي: <strong>{fmtInt(yd.total)}</strong></span>
                <span>محصل: <strong style={{color:'var(--color-brand-green)'}}>{fmtInt(yd.paid)}</strong></span>
                {yd.balance > 0 && <span>متبقي: <strong style={{color:'var(--color-danger)'}}>{fmtInt(yd.balance)}</strong></span>}
                <span className={`badge paid`} style={{fontSize:10}}>✓{yd.paid_c}</span>
                {yd.partial_c > 0 && <span className="badge partial" style={{fontSize:10}}>◑{yd.partial_c}</span>}
                {yd.unpaid_c  > 0 && <span className="badge unpaid"  style={{fontSize:10}}>✗{yd.unpaid_c}</span>}
              </div>
            </div>

            <div className="cd-table-wrap">
              <table className="cd-table">
                <thead>
                  <tr>
                    <th>التاريخ</th><th>رقم الفاتورة</th><th>المفوتر</th>
                    <th>المحصل</th><th>المتبقي</th><th>% التحصيل</th><th>الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {yd.rows.map(inv => (
                    <tr key={inv.id} className={rowClass(inv)}>
                      <td className="num">{fmtDate(inv.invoice_date)}</td>
                      <td className="num">{inv.invoice_number}</td>
                      <td className="num amt">{fmt(inv.original_amount)}</td>
                      <td className="num amt green">{fmt(inv.paid_amount)}</td>
                      <td className={`num amt${parseFloat(inv.balance)>0?' red':''}`}>
                        {parseFloat(inv.balance)>0 ? fmt(inv.balance) : '—'}
                      </td>
                      <td><RateBar rate={inv.collection_rate} /></td>
                      <td><StatusBadge status={inv.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ════════════════════════════════════════════════
   PAYMENTS TAB
   ════════════════════════════════════════════════ */
const PAY_TYPE_AR = { cash:'نقداً', cheque:'شيك', bank_tran:'تحويل بنكي', pos:'POS' };
const PAY_TYPE_COLOR = {
  cash:     'var(--color-brand-green)',
  cheque:   '#1976d2',
  bank_tran:'var(--color-warning)',
  pos:      '#7b1fa2',
};

function PayTypeChip({ type, amount }) {
  if (!amount || parseFloat(amount) === 0) return null;
  return (
    <span style={{
      display:'inline-flex', alignItems:'center', gap:3,
      padding:'2px 8px', borderRadius:999, fontSize:11, fontWeight:700,
      background: PAY_TYPE_COLOR[type] + '18',
      color: PAY_TYPE_COLOR[type],
      border: `1px solid ${PAY_TYPE_COLOR[type]}40`,
      fontFamily:'var(--font-en)',
    }}>
      {PAY_TYPE_AR[type]} {fmt(amount)}
    </span>
  );
}

function PaymentsTab({ customerId }) {
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(new Set());

  const { data, isLoading, isError } = useQuery({
    queryKey: ['customer-payments', customerId, showAll],
    queryFn: () =>
      client.get(`/payments/customer/${encodeURIComponent(customerId)}`, {
        params: { status: showAll ? 'all' : 'due' },
      }).then(r => r.data),
    staleTime: 60_000,
  });

  const { summary, invoices = [], all_payments = [] } = data || {};

  const toggleExpand = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  if (isLoading) return (
    <div style={{ display:'flex', justifyContent:'center', padding:60, color:'var(--color-text-muted)', gap:10 }}>
      <div className="spinner" style={{ width:28, height:28 }} />
      <span>جاري تحميل حركات السداد…</span>
    </div>
  );

  if (isError) return (
    <div className="cd-table-card" style={{ padding:40, textAlign:'center', color:'var(--color-danger)' }}>
      تعذّر تحميل البيانات — تأكد من رفع ملف السدادات أولاً
    </div>
  );

  const grandTotal = parseFloat(summary?.total_paid || 0);
  const txCount    = parseInt(summary?.transaction_count || 0);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

      {/* ── Summary card ── */}
      <div style={{
        display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))', gap:10,
        background:'#fff', borderRadius:'var(--radius-lg)', border:'1px solid var(--color-border)',
        boxShadow:'var(--shadow-card)', padding:'16px 20px',
      }}>
        {[
          { lbl:'إجمالي السدادات', val: fmt(summary?.total_paid), color:'var(--color-brand-green)', big:true },
          { lbl:'المعاملات', val: fmtInt(txCount), color:'' },
          { lbl:'نقداً', val: fmt(summary?.total_cash), color: PAY_TYPE_COLOR.cash },
          { lbl:'شيكات', val: fmt(summary?.total_cheque), color: PAY_TYPE_COLOR.cheque },
          { lbl:'تحويل بنكي', val: fmt(summary?.total_bank_tran), color: PAY_TYPE_COLOR.bank_tran },
          { lbl:'POS', val: fmt(summary?.total_pos), color: PAY_TYPE_COLOR.pos },
          { lbl:'أول سداد', val: summary?.first_date ? String(summary.first_date).split('T')[0] : '—', mono:true },
          { lbl:'آخر سداد',  val: summary?.last_date  ? String(summary.last_date ).split('T')[0] : '—', mono:true },
        ].map(({ lbl, val, color, big, mono }) => (
          <div key={lbl} style={{ display:'flex', flexDirection:'column', gap:3 }}>
            <span style={{ fontSize:11, color:'var(--color-text-muted)', fontWeight:600 }}>{lbl}</span>
            <span style={{
              fontSize: big ? 18 : 14,
              fontWeight: big ? 800 : 700,
              color: color || 'var(--color-text-primary)',
              fontFamily: mono || !lbl.includes('آ') ? 'var(--font-en)' : undefined,
            }}>{val}</span>
          </div>
        ))}
      </div>

      {/* ── Invoices + payments ── */}
      <div className="cd-table-card">
        <div className="cd-table-toolbar">
          <span className="cd-table-title">
            <CreditCard size={15} />
            {showAll ? 'جميع الفواتير مع حركات السداد' : 'الفواتير غير المسددة كليًا مع السدادات'}
            <span className="cd-count-badge">{invoices.length}</span>
          </span>
          <div className="cd-toolbar-right">
            <button
              className="cd-export-btn"
              onClick={() => setShowAll(v => !v)}
              style={{ minWidth:120 }}
            >
              {showAll ? 'إخفاء المسددة' : 'عرض الكل'}
            </button>
          </div>
        </div>

        {invoices.length === 0 ? (
          <div className="cd-empty">
            {txCount === 0
              ? '💳 لا توجد حركات سداد لهذا العميل — تأكد من رفع ملف السدادات'
              : '✅ جميع الفواتير مسددة بالكامل'}
          </div>
        ) : (
          <div className="cd-table-wrap">
            <table className="cd-table">
              <thead>
                <tr>
                  <th style={{ width:32 }}></th>
                  <th>رقم الفاتورة</th>
                  <th>التاريخ</th>
                  <th>المفوتر</th>
                  <th>المحصل</th>
                  <th>المتبقي</th>
                  <th>الحالة</th>
                  <th>سدادات مسجّلة</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map(inv => {
                  const isOpen   = expanded.has(inv.id);
                  const payTotal = inv.payments.reduce((s,p) => s + parseFloat(p.total_paid||0), 0);

                  return (
                    <React.Fragment key={inv.id}>
                      {/* ── Invoice row ── */}
                      <tr
                        className={rowClass(inv)}
                        style={{ cursor: inv.payments.length ? 'pointer' : 'default' }}
                        onClick={() => inv.payments.length && toggleExpand(inv.id)}
                      >
                        <td style={{ textAlign:'center', padding:'6px 4px' }}>
                          {inv.payments.length > 0
                            ? (isOpen
                                ? <ChevronUp size={13} style={{ color:'var(--color-text-muted)' }} />
                                : <ChevronDown size={13} style={{ color:'var(--color-text-muted)' }} />)
                            : <span style={{ color:'var(--color-border)', fontSize:10 }}>—</span>
                          }
                        </td>
                        <td className="num">{inv.invoice_number}</td>
                        <td className="num">{fmtDate(inv.invoice_date)}</td>
                        <td className="num amt">{fmt(inv.original_amount)}</td>
                        <td className="num amt green">{fmt(inv.paid_amount)}</td>
                        <td className={`num amt${parseFloat(inv.balance)>0?' red':''}`}>
                          {parseFloat(inv.balance)>0 ? fmt(inv.balance) : '—'}
                        </td>
                        <td><StatusBadge status={inv.status} /></td>
                        <td>
                          {inv.payments.length > 0 ? (
                            <span style={{ display:'flex', alignItems:'center', gap:6 }}>
                              <span style={{
                                fontSize:11, fontWeight:700, fontFamily:'var(--font-en)',
                                color:'var(--color-brand-green)',
                              }}>
                                {fmtInt(payTotal)}
                              </span>
                              <span style={{ fontSize:10, color:'var(--color-text-muted)' }}>
                                ({inv.payments.length} دفعة)
                              </span>
                            </span>
                          ) : (
                            <span style={{ fontSize:11, color:'var(--color-text-muted)' }}>لا يوجد</span>
                          )}
                        </td>
                      </tr>

                      {/* ── Expanded payment rows ── */}
                      {isOpen && inv.payments.map(p => (
                        <tr key={p.id} style={{
                          background:'#f8fbff',
                          borderBottom:'1px solid var(--color-border)',
                        }}>
                          <td />
                          <td colSpan={2}>
                            <span style={{
                              display:'inline-flex', alignItems:'center', gap:6,
                              fontSize:11, fontFamily:'var(--font-en)', color:'var(--color-text-secondary)',
                            }}>
                              <CreditCard size={11} style={{ color:PAY_TYPE_COLOR.bank_tran }} />
                              {String(p.tran_date||'').split('T')[0] || '—'}
                              <span style={{ color:'var(--color-text-muted)', fontSize:10 }}>
                                #{p.document_number}
                              </span>
                            </span>
                          </td>
                          <td />
                          <td className="num amt" style={{ color:'var(--color-brand-green)' }}>
                            {fmt(p.total_paid)}
                          </td>
                          <td />
                          <td />
                          <td>
                            <span style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                              <PayTypeChip type="cash"     amount={p.cash}     />
                              <PayTypeChip type="cheque"   amount={p.cheque}   />
                              <PayTypeChip type="bank_tran" amount={p.bank_tran} />
                              <PayTypeChip type="pos"      amount={p.pos}      />
                            </span>
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── All payments list ── */}
      {all_payments.length > 0 && (
        <div className="cd-table-card">
          <div className="cd-table-toolbar">
            <span className="cd-table-title">
              كل حركات السداد
              <span className="cd-count-badge">{all_payments.length}</span>
            </span>
          </div>
          <div className="cd-table-wrap">
            <table className="cd-table">
              <thead>
                <tr>
                  <th>التاريخ</th>
                  <th>رقم الفاتورة</th>
                  <th>رقم المرجع</th>
                  <th>نقداً</th>
                  <th>شيك</th>
                  <th>تحويل بنكي</th>
                  <th>POS</th>
                  <th>الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {all_payments.map((p, i) => (
                  <tr key={i}>
                    <td className="num" style={{ fontSize:12 }}>
                      {String(p.tran_date||'').split('T')[0] || '—'}
                    </td>
                    <td className="num" style={{ fontSize:12 }}>{p.invoice_number || '—'}</td>
                    <td className="num" style={{ fontSize:11, color:'var(--color-text-muted)' }}>
                      {p.document_number}
                    </td>
                    <td className="num amt">
                      {parseFloat(p.cash)>0 ? <span style={{ color:PAY_TYPE_COLOR.cash, fontWeight:700 }}>{fmt(p.cash)}</span> : '—'}
                    </td>
                    <td className="num amt">
                      {parseFloat(p.cheque)>0 ? <span style={{ color:PAY_TYPE_COLOR.cheque, fontWeight:700 }}>{fmt(p.cheque)}</span> : '—'}
                    </td>
                    <td className="num amt">
                      {parseFloat(p.bank_tran)>0 ? <span style={{ color:PAY_TYPE_COLOR.bank_tran, fontWeight:700 }}>{fmt(p.bank_tran)}</span> : '—'}
                    </td>
                    <td className="num amt">
                      {parseFloat(p.pos)>0 ? <span style={{ color:PAY_TYPE_COLOR.pos, fontWeight:700 }}>{fmt(p.pos)}</span> : '—'}
                    </td>
                    <td className="num amt green" style={{ fontWeight:800 }}>{fmt(p.total_paid)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop:'2px solid var(--color-border)', background:'var(--color-bg-alt)' }}>
                  <td colSpan={3} style={{ padding:'8px 12px', fontWeight:700, fontSize:12 }}>الإجمالي</td>
                  <td className="num amt" style={{ color:PAY_TYPE_COLOR.cash, fontWeight:800 }}>
                    {fmt(all_payments.reduce((s,p)=>s+parseFloat(p.cash||0),0))}
                  </td>
                  <td className="num amt" style={{ color:PAY_TYPE_COLOR.cheque, fontWeight:800 }}>
                    {fmt(all_payments.reduce((s,p)=>s+parseFloat(p.cheque||0),0))}
                  </td>
                  <td className="num amt" style={{ color:PAY_TYPE_COLOR.bank_tran, fontWeight:800 }}>
                    {fmt(all_payments.reduce((s,p)=>s+parseFloat(p.bank_tran||0),0))}
                  </td>
                  <td className="num amt" style={{ color:PAY_TYPE_COLOR.pos, fontWeight:800 }}>
                    {fmt(all_payments.reduce((s,p)=>s+parseFloat(p.pos||0),0))}
                  </td>
                  <td className="num amt green" style={{ fontWeight:900, fontSize:14 }}>
                    {fmt(all_payments.reduce((s,p)=>s+parseFloat(p.total_paid||0),0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════
   RECONCILIATION TAB
   ════════════════════════════════════════════════ */
function ReconciliationTab({ customerId }) {
  const { user }     = useAuth();
  const qc           = useQueryClient();
  const fileRef      = useRef(null);
  const isAdmin      = user?.role === 'super_admin' || user?.role === 'it_admin';

  const [phase,    setPhase]    = useState('idle');   // idle | uploading | success | error
  const [errMsg,   setErrMsg]   = useState('');
  const [pct,      setPct]      = useState(0);
  const [notes,    setNotes]    = useState('');
  const [delId,    setDelId]    = useState(null);

  const { data: files = [], isLoading } = useQuery({
    queryKey:  ['reconciliations', customerId],
    queryFn:   () => client.get(`/reconciliations/${customerId}`).then(r => r.data),
    staleTime: 30_000,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['reconciliations', customerId] });
    qc.invalidateQueries({ queryKey: ['customer-detail', customerId] });
  };

  const doUpload = async (file) => {
    if (!file) return;
    setPhase('uploading'); setPct(0); setErrMsg('');
    const form = new FormData();
    form.append('file', file);
    if (notes.trim()) form.append('notes', notes.trim());
    try {
      await client.post(`/reconciliations/upload/${customerId}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => e.total && setPct(Math.round((e.loaded / e.total) * 100)),
      });
      setPhase('success');
      setNotes('');
      refresh();
      // also refresh customer list badge
      qc.invalidateQueries({ queryKey: ['customers-summary'] });
    } catch (err) {
      setErrMsg(err.response?.data?.error || err.message || 'فشل الرفع');
      setPhase('error');
    }
  };

  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await doUpload(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleDelete = async (id) => {
    if (delId !== id) { setDelId(id); return; }
    setDelId(null);
    try {
      await client.delete(`/reconciliations/${id}`);
      refresh();
      qc.invalidateQueries({ queryKey: ['customers-summary'] });
    } catch (err) {
      alert(err.response?.data?.error || 'فشل الحذف');
    }
  };

  const fmtSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024)        return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const fmtDT = (dt) => {
    if (!dt) return '—';
    return new Date(dt).toLocaleString('ar-SA', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const getFileIcon = (mime, name) => {
    if (mime?.includes('pdf') || name?.endsWith('.pdf')) return '📄';
    if (mime?.includes('image') || /\.(jpg|jpeg|png|gif|webp)$/i.test(name)) return '🖼️';
    if (/\.(xlsx|xls|csv)$/i.test(name)) return '📊';
    if (/\.(docx|doc)$/i.test(name)) return '📝';
    return '📎';
  };

  return (
    <div className="cd-table-card">
      {/* Header + upload */}
      <div className="cd-table-toolbar">
        <span className="cd-table-title">
          <GitMerge size={15} />
          مطابقة العميل
          {files.length > 0 && <span className="cd-count-badge">{files.length}</span>}
        </span>
      </div>

      {/* Upload area */}
      <div className="recon-upload-area">
        {phase === 'idle' || phase === 'success' ? (
          <>
            <div className="recon-upload-hint">
              ارفع ملف مطابقة للعميل (PDF, Excel, صورة، إلخ — حتى 50 ميجابايت)
            </div>
            <div className="recon-upload-row">
              <input
                className="recon-notes-input"
                placeholder="ملاحظة اختيارية…"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
              <label className="recon-pick-btn">
                <Paperclip size={14} />
                اختر ملف
                <input ref={fileRef} type="file" accept="*/*" onChange={handleChange} hidden />
              </label>
            </div>
            {phase === 'success' && (
              <div className="recon-success-msg">
                <CheckCircle size={14} /> تم رفع الملف بنجاح
                <button className="recon-again-btn" onClick={() => setPhase('idle')}>رفع آخر</button>
              </div>
            )}
          </>
        ) : phase === 'uploading' ? (
          <div className="recon-progress">
            <div className="spinner" style={{ width: 18, height: 18, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
                {pct}% — جاري رفع الملف…
              </div>
            </div>
          </div>
        ) : (
          <div className="recon-error-msg">
            <AlertCircle size={14} />
            <span>{errMsg}</span>
            <button className="recon-again-btn" onClick={() => setPhase('idle')}>
              <RefreshCw size={12} /> إعادة المحاولة
            </button>
          </div>
        )}
      </div>

      {/* Files list */}
      {isLoading ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)' }}>
          جاري التحميل…
        </div>
      ) : files.length === 0 ? (
        <div className="recon-empty">
          <GitMerge size={32} strokeWidth={1.2} />
          <span>لم يتم رفع أي ملف مطابقة لهذا العميل بعد</span>
        </div>
      ) : (
        <div className="recon-file-list">
          {files.map(f => (
            <div key={f.id} className="recon-file-row">
              <span className="recon-file-icon">{getFileIcon(f.mime_type, f.file_name)}</span>

              <div className="recon-file-info">
                <span className="recon-file-name">{f.file_name}</span>
                {f.notes && (
                  <span className="recon-file-notes">{f.notes}</span>
                )}
              </div>

              <div className="recon-file-meta">
                <span className="recon-file-size">{fmtSize(f.file_size)}</span>
                <span className="recon-file-date">
                  <Calendar size={11} /> {fmtDT(f.uploaded_at)}
                </span>
                <span className="recon-file-user">
                  <User size={11} /> {f.uploader_name || '—'}
                </span>
              </div>

              <div className="recon-file-actions">
                <a
                  className="recon-dl-btn"
                  href={`/api/reconciliations/download/${f.id}`}
                  target="_blank"
                  rel="noreferrer"
                  title="تنزيل"
                >
                  <Download size={14} />
                </a>
                {isAdmin && (
                  delId === f.id ? (
                    <span className="recon-del-confirm">
                      <button className="notes-del-btn confirm" onClick={() => handleDelete(f.id)}>نعم</button>
                      <button className="notes-del-btn cancel"  onClick={() => setDelId(null)}>لا</button>
                    </span>
                  ) : (
                    <button className="notes-del-btn" onClick={() => handleDelete(f.id)} title="حذف">
                      <Trash2 size={13} />
                    </button>
                  )
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Notes History Tab ────────────────────────── */
const TYPE_LABEL_H = { customer: 'عميل', invoice: 'فاتورة' };
const TYPE_CLS_H   = { customer: 'nh-badge-customer', invoice: 'nh-badge-invoice' };

function fmtDT(dt) {
  if (!dt) return '—';
  const d = new Date(dt);
  return d.toLocaleDateString('ar-SA', { year:'numeric', month:'2-digit', day:'2-digit' })
    + ' ' + d.toLocaleTimeString('ar-SA', { hour:'2-digit', minute:'2-digit' });
}

function NotesHistoryTab({ customerId }) {
  const { user }                 = useAuth();
  const { deleteHistoryEntry }   = useNotes();
  const isAdmin                  = user?.role === 'super_admin';
  const [localRows, setLocalRows] = useState(null);
  const [delConfirm, setDelConfirm] = useState(null); // historyId pending confirm

  const { data: fetchedRows = [], isLoading } = useQuery({
    queryKey: ['notes-history', customerId],
    queryFn:  () => client.get(`/notes/history/${customerId}`).then(r => r.data),
    staleTime: 30_000,
  });

  const rows = localRows ?? fetchedRows;

  const handleDelete = async (id) => {
    if (delConfirm !== id) { setDelConfirm(id); return; }
    setDelConfirm(null);
    const ok = await deleteHistoryEntry(id);
    if (ok) setLocalRows(rows.filter(r => r.id !== id));
  };

  if (isLoading) return (
    <div style={{ display:'flex', justifyContent:'center', padding:40, color:'var(--color-text-muted)' }}>
      جاري التحميل…
    </div>
  );

  if (!rows.length) return (
    <div className="cd-table-card" style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:180, gap:10, color:'var(--color-text-muted)' }}>
      <MessageSquare size={36} strokeWidth={1.2} />
      <span style={{ fontSize:14, fontWeight:600 }}>لا توجد ملاحظات مسجّلة لهذا العميل بعد</span>
    </div>
  );

  return (
    <div className="cd-table-card">
      <div className="cd-table-toolbar">
        <span className="cd-table-title">
          <MessageSquare size={15} />
          سجل الملاحظات
          <span className="cd-count-badge">{rows.length}</span>
        </span>
      </div>
      <div className="cd-table-wrap">
        <table className="cd-table nh-table">
          <thead>
            <tr>
              <th>التاريخ والوقت</th>
              <th>المستخدم</th>
              <th>النوع</th>
              <th>رقم الفاتورة</th>
              <th>الملاحظة</th>
              {isAdmin && <th style={{ width:90 }}></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td className="num" style={{ whiteSpace:'nowrap', fontSize:12, color:'var(--color-text-secondary)' }}>
                  {fmtDT(r.created_at)}
                </td>
                <td>
                  <span style={{ display:'inline-flex', alignItems:'center', gap:4,
                    background:'var(--color-bg-page,#f4f6fa)', border:'1px solid var(--color-border)',
                    borderRadius:999, padding:'2px 8px', fontSize:12, color:'var(--color-text-secondary)' }}>
                    <User size={10} />{r.user_name || '—'}
                  </span>
                </td>
                <td>
                  <span className={`nh-badge ${TYPE_CLS_H[r.note_type] || ''}`}>
                    {r.note_type === 'customer' ? <User size={10}/> : <FileText size={10}/>}
                    {TYPE_LABEL_H[r.note_type] || r.note_type}
                  </span>
                </td>
                <td className="num" style={{ fontSize:12, color:'var(--color-text-secondary)' }}>
                  {r.invoice_number || '—'}
                </td>
                <td style={{ whiteSpace:'pre-wrap', wordBreak:'break-word', maxWidth:340 }}>
                  {r.note_text || '—'}
                </td>
                {isAdmin && (
                  <td style={{ textAlign:'center' }}>
                    {delConfirm === r.id ? (
                      <span style={{ display:'flex', alignItems:'center', gap:4, justifyContent:'center' }}>
                        <button className="notes-del-btn confirm" onClick={() => handleDelete(r.id)}>نعم</button>
                        <button className="notes-del-btn cancel"  onClick={() => setDelConfirm(null)}>لا</button>
                      </span>
                    ) : (
                      <button className="notes-del-btn" onClick={() => handleDelete(r.id)} title="حذف السجل">
                        <Trash2 size={12} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
