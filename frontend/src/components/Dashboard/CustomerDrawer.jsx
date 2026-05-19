import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X, Download, User, FileText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import NotesCell from './NotesCell';
import client from '../../api/client';
import './CustomerDrawer.css';

/* ── Helpers ────────────────────────────────────── */
const fmt = (n) =>
  n === null || n === undefined
    ? '—'
    : Number(n).toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtInt = (n) => Math.round(Number(n || 0)).toLocaleString('en-SA');

function RateBar({ rate }) {
  const r = Math.min(100, Math.max(0, parseFloat(rate) || 0));
  const color = r >= 90 ? 'var(--color-brand-green)' : r >= 60 ? 'var(--color-warning)' : 'var(--color-danger)';
  return (
    <div className="d-rate-cell">
      <div className="d-bar">
        <div className="d-bar-fill" style={{ width: `${r}%`, background: color }} />
      </div>
      <span style={{ fontSize: 11, fontFamily: 'var(--font-en)', color, fontWeight: 600, minWidth: 38, textAlign: 'left' }}>
        {r.toFixed(1)}%
      </span>
    </div>
  );
}

const STATUS_LABEL = { paid: 'مسددة', partial: 'جزئي', unpaid: 'غير مسددة' };
const STATUS_CLS   = { paid: 'paid',  partial: 'partial', unpaid: 'unpaid' };

function StatusBadge({ status }) {
  return (
    <span className={`badge ${STATUS_CLS[status] || ''}`} style={{ fontSize: 11 }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function rowClass(inv) {
  if (inv.status === 'paid') return '';
  const bal  = parseFloat(inv.balance || 0);
  const orig = parseFloat(inv.original_amount || 1);
  if (bal > 0 && orig > 0 && bal / orig >= 0.8) return 'row-danger';
  if (inv.status === 'partial') return 'row-warning';
  return '';
}

/* ── Export helpers ─────────────────────────────── */
function exportCSV(rows, customer) {
  const headers = ['رقم الفاتورة', 'التاريخ', 'المفوتر', 'المحصل', 'المتبقي', '% التحصيل', 'الحالة'];
  const lines = [
    headers.join(','),
    ...rows.map((r) => [
      r.invoice_number, r.invoice_date ? String(r.invoice_date).split('T')[0] : '',
      r.original_amount, r.paid_amount, r.balance, r.collection_rate, STATUS_LABEL[r.status] || r.status,
    ].join(',')),
  ];
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${customer?.customer_id || 'customer'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ── Main component ─────────────────────────────── */
export default function CustomerDrawer({ customerId, dashboardParams, onClose }) {
  const [tab,          setTab]          = useState('detail');
  const [statusFilter, setStatusFilter] = useState('');
  const bodyRef = useRef(null);

  // Fetch customer detail — pass same filters as dashboard
  const { data, isLoading, isError } = useQuery({
    queryKey: ['customer', customerId, dashboardParams],
    queryFn: () =>
      client.get(`/invoices/customer/${encodeURIComponent(customerId)}`, { params: dashboardParams })
        .then((r) => r.data),
    enabled: !!customerId,
    staleTime: 30_000,
  });

  // Close on Escape
  useEffect(() => {
    const handler = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Prevent body scroll when open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const { customer, summary, invoices = [] } = data || {};

  // Filter invoices by status
  const filtered = useMemo(() => {
    if (!statusFilter) return invoices;
    if (statusFilter === 'due') return invoices.filter((i) => i.status === 'partial' || i.status === 'unpaid');
    return invoices.filter((i) => i.status === statusFilter);
  }, [invoices, statusFilter]);

  return (
    /* Full-page — no overlay, just the page itself */
    <div className="drawer" role="dialog" aria-modal="true">

      {/* Top bar */}
      <div className="drawer-topbar">
        <div className="drawer-topbar-info">
          <button className="drawer-close-btn" onClick={onClose} aria-label="رجوع">
            <X size={15} /> رجوع
          </button>
          <span className="drawer-topbar-title">
            {customer?.customer_name || customerId}
          </span>
          {customer?.customer_name_en && (
            <span className="drawer-topbar-meta">{customer.customer_name_en}</span>
          )}
        </div>
        <div className="drawer-topbar-actions">
          {customer?.route_id && (
            <span className="drawer-route-chip">Route Code · {customer.route_id}</span>
          )}
        </div>
      </div>

        {/* Tabs */}
        <div className="drawer-tabs">
          <button
            className={`drawer-tab${tab === 'detail' ? ' active' : ''}`}
            onClick={() => setTab('detail')}
          >
            <span className="drawer-tab-icon">📋</span>
            تفاصيل العميل
          </button>
          <button
            className={`drawer-tab${tab === 'summary' ? ' active' : ''}`}
            onClick={() => setTab('summary')}
          >
            <span className="drawer-tab-icon">📊</span>
            الإجمالي التراكمي
          </button>
        </div>

        {/* Body */}
        <div className="drawer-body" ref={bodyRef}>

          {isLoading && (
            <div className="drawer-loading">
              <div className="spinner" style={{ width: 28, height: 28 }} />
              جاري تحميل بيانات العميل…
            </div>
          )}

          {isError && (
            <div className="drawer-empty">
              <span style={{ fontSize: 36 }}>⚠️</span>
              <div style={{ marginTop: 8, color: 'var(--color-danger)' }}>تعذّر تحميل البيانات</div>
            </div>
          )}

          {data && tab === 'detail' && (
            <>
              {/* Customer info card */}
              <div className="cust-info-card">
                <div className="cust-name">
                  {customer.customer_name}
                  {customer.customer_name_en && customer.customer_name_en !== customer.customer_name && (
                    <span className="cust-name-en">{customer.customer_name_en}</span>
                  )}
                </div>
                <div className="cust-meta-row">
                  <div className="cust-meta-item">
                    <span className="cust-meta-lbl">كود العميل</span>
                    <span className="cust-meta-val">{customer.customer_id}</span>
                  </div>
                  <div className="cust-meta-item">
                    <span className="cust-meta-lbl">المنطقة</span>
                    <span className="cust-meta-val">{customer.region_name_ar || '—'}</span>
                  </div>
                  <div className="cust-meta-item">
                    <span className="cust-meta-lbl">المندوب</span>
                    <span className="cust-meta-val">{customer.sales_rep_name || '—'}</span>
                  </div>
                  <div className="cust-meta-item">
                    <span className="cust-meta-lbl">الخط</span>
                    <span className="cust-meta-val">{customer.route_id || '—'}</span>
                  </div>
                </div>
              </div>

              {/* Summary stats bar */}
              <div className="cust-stats-bar">
                <div className="cust-stat">
                  <span className="cust-stat-lbl">عدد الفواتير</span>
                  <span className="cust-stat-val">{fmtInt(summary.invoice_count)}</span>
                </div>
                <div className="cust-stat">
                  <span className="cust-stat-lbl">المفوتر</span>
                  <span className="cust-stat-val">{fmtInt(summary.total_amount)}</span>
                </div>
                <div className="cust-stat">
                  <span className="cust-stat-lbl">المحصل</span>
                  <span className="cust-stat-val green">{fmtInt(summary.total_paid)}</span>
                </div>
                <div className="cust-stat">
                  <span className="cust-stat-lbl">المتبقي</span>
                  <span className={`cust-stat-val${summary.total_balance > 0 ? ' red' : ''}`}>
                    {summary.total_balance > 0 ? fmtInt(summary.total_balance) : '—'}
                  </span>
                </div>
                <div className="cust-stat">
                  <span className="cust-stat-lbl">نسبة التحصيل</span>
                  <span className={`cust-stat-val${Number(summary.collection_rate) >= 90 ? ' green' : Number(summary.collection_rate) >= 60 ? ' orange' : ' red'}`}>
                    {Number(summary.collection_rate).toFixed(1)}%
                  </span>
                </div>
                <div className="cust-stat">
                  <span className="cust-stat-lbl">مسددة</span>
                  <span className="cust-stat-val green">{fmtInt(summary.paid_count)}</span>
                </div>
                <div className="cust-stat">
                  <span className="cust-stat-lbl">جزئي</span>
                  <span className={`cust-stat-val${summary.partial_count > 0 ? ' orange' : ''}`}>
                    {fmtInt(summary.partial_count)}
                  </span>
                </div>
                <div className="cust-stat">
                  <span className="cust-stat-lbl">غير مسددة</span>
                  <span className={`cust-stat-val${summary.unpaid_count > 0 ? ' red' : ''}`}>
                    {fmtInt(summary.unpaid_count)}
                  </span>
                </div>
              </div>

              {/* Toolbar */}
              <div className="drawer-toolbar">
                <span className="drawer-toolbar-title">
                  <span>📄</span>
                  فواتير العميل ({filtered.length.toLocaleString('en-SA')})
                </span>
                <div className="drawer-toolbar-right">
                  <select
                    className="drawer-status-select"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="">جميع الحالات</option>
                    <option value="due">غير مسددة بالكامل</option>
                    <option value="paid">مسددة</option>
                    <option value="partial">جزئي</option>
                    <option value="unpaid">غير مسدد</option>
                  </select>
                  <button className="drawer-export-btn" onClick={() => exportCSV(filtered, customer)}>
                    <Download size={12} /> CSV
                  </button>
                  <span className="drawer-summary-chip">
                    {filtered.length} فاتورة · إجمالي:{' '}
                    {fmtInt(filtered.reduce((s, r) => s + parseFloat(r.original_amount || 0), 0))}
                  </span>
                </div>
              </div>

              {/* Invoices table */}
              <div className="drawer-table-wrap">
                {filtered.length === 0 ? (
                  <div className="drawer-empty">لا توجد فواتير مطابقة</div>
                ) : (
                  <table className="drawer-table">
                    <thead>
                      <tr>
                        <th>التاريخ</th>
                        <th>رقم الفاتورة</th>
                        <th>المفوتر</th>
                        <th>المحصل</th>
                        <th>المتبقي</th>
                        <th>% التحصيل</th>
                        <th>الحالة</th>
                        <th>ملاحظات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((inv) => (
                        <tr key={inv.id} className={rowClass(inv)}>
                          <td className="num" style={{ whiteSpace: 'nowrap', fontSize: 11 }}>
                            {inv.invoice_date ? String(inv.invoice_date).split('T')[0] : '—'}
                          </td>
                          <td className="num" style={{ fontSize: 11 }}>{inv.invoice_number}</td>
                          <td className="num amt">{fmt(inv.original_amount)}</td>
                          <td className="num amt paid">{fmt(inv.paid_amount)}</td>
                          <td className={`num amt${parseFloat(inv.balance) > 0 ? ' bal' : ''}`}>
                            {parseFloat(inv.balance) > 0 ? fmt(inv.balance) : '—'}
                          </td>
                          <td><RateBar rate={inv.collection_rate} /></td>
                          <td><StatusBadge status={inv.status} /></td>
                          <td
                            className="notes-col"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <NotesCell invoiceId={inv.id} initialText={inv.note_text || ''} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}

          {/* Summary tab — aggregated by year */}
          {data && tab === 'summary' && (
            <CumulativeSummary invoices={invoices} summary={summary} customer={customer} />
          )}
        </div>
    </div>
  );
}

/* ── Cumulative summary tab ─────────────────────── */
function CumulativeSummary({ invoices, summary, customer }) {
  // Group by year
  const byYear = useMemo(() => {
    const map = {};
    invoices.forEach((inv) => {
      const y = inv.year || 'غير محدد';
      if (!map[y]) map[y] = { year: y, invoices: [], total: 0, paid: 0, balance: 0 };
      map[y].invoices.push(inv);
      map[y].total   += parseFloat(inv.original_amount || 0);
      map[y].paid    += parseFloat(inv.paid_amount || 0);
      map[y].balance += parseFloat(inv.balance || 0);
    });
    return Object.values(map).sort((a, b) => Number(b.year) - Number(a.year));
  }, [invoices]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Overall summary card */}
      <div className="cust-info-card">
        <div className="cust-name">{customer?.customer_name} — ملخص إجمالي</div>
        <div className="cust-stats-bar" style={{ margin: 0 }}>
          <div className="cust-stat">
            <span className="cust-stat-lbl">الفواتير</span>
            <span className="cust-stat-val">{fmtInt(summary.invoice_count)}</span>
          </div>
          <div className="cust-stat">
            <span className="cust-stat-lbl">المفوتر</span>
            <span className="cust-stat-val">{fmtInt(summary.total_amount)}</span>
          </div>
          <div className="cust-stat">
            <span className="cust-stat-lbl">المحصل</span>
            <span className="cust-stat-val green">{fmtInt(summary.total_paid)}</span>
          </div>
          <div className="cust-stat">
            <span className="cust-stat-lbl">المتبقي</span>
            <span className={`cust-stat-val${summary.total_balance > 0 ? ' red' : ''}`}>
              {summary.total_balance > 0 ? fmtInt(summary.total_balance) : '—'}
            </span>
          </div>
          <div className="cust-stat">
            <span className="cust-stat-lbl">التحصيل</span>
            <span className={`cust-stat-val${Number(summary.collection_rate) >= 90 ? ' green' : ' orange'}`}>
              {Number(summary.collection_rate).toFixed(1)}%
            </span>
          </div>
          <div className="cust-stat">
            <span className="cust-stat-lbl">مسددة</span>
            <span className="cust-stat-val green">{fmtInt(summary.paid_count)}</span>
          </div>
          <div className="cust-stat">
            <span className="cust-stat-lbl">جزئي</span>
            <span className={`cust-stat-val${summary.partial_count > 0 ? ' orange' : ''}`}>
              {fmtInt(summary.partial_count)}
            </span>
          </div>
          <div className="cust-stat">
            <span className="cust-stat-lbl">غير مسدد</span>
            <span className={`cust-stat-val${summary.unpaid_count > 0 ? ' red' : ''}`}>
              {fmtInt(summary.unpaid_count)}
            </span>
          </div>
        </div>
      </div>

      {/* Per-year breakdown */}
      {byYear.map((yd) => {
        const rate = yd.total > 0 ? (yd.paid / yd.total) * 100 : 0;
        const YEAR_COLORS = { 2024: '#c62828', 2025: '#2e7d32', 2026: '#e65100' };
        const yColor = YEAR_COLORS[yd.year] || 'var(--color-text-muted)';
        return (
          <div key={yd.year} className="drawer-table-wrap">
            <div style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--color-border)',
              display: 'flex', alignItems: 'center', gap: 12,
              background: '#fff',
            }}>
              <span style={{ fontWeight: 800, fontSize: 15, color: yColor }}>{yd.year}</span>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                {yd.invoices.length} فاتورة
              </span>
              <div style={{ flex: 1, maxWidth: 160 }}>
                <div className="d-bar" style={{ height: 6 }}>
                  <div className="d-bar-fill" style={{ width: `${rate}%`, background: yColor }} />
                </div>
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: yColor, fontFamily: 'var(--font-en)' }}>
                {rate.toFixed(1)}%
              </span>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)', marginRight: 'auto', fontFamily: 'var(--font-en)' }}>
                إجمالي: {fmtInt(yd.total)} · محصل: {fmtInt(yd.paid)} · متبقي: {yd.balance > 0 ? fmtInt(yd.balance) : '—'}
              </span>
            </div>

            <table className="drawer-table">
              <thead>
                <tr>
                  <th>التاريخ</th>
                  <th>رقم الفاتورة</th>
                  <th>المفوتر</th>
                  <th>المحصل</th>
                  <th>المتبقي</th>
                  <th>% التحصيل</th>
                  <th>الحالة</th>
                </tr>
              </thead>
              <tbody>
                {yd.invoices.map((inv) => (
                  <tr key={inv.id} className={rowClass(inv)}>
                    <td className="num" style={{ fontSize: 11 }}>
                      {inv.invoice_date ? String(inv.invoice_date).split('T')[0] : '—'}
                    </td>
                    <td className="num" style={{ fontSize: 11 }}>{inv.invoice_number}</td>
                    <td className="num amt">{fmt(inv.original_amount)}</td>
                    <td className="num amt paid">{fmt(inv.paid_amount)}</td>
                    <td className={`num amt${parseFloat(inv.balance) > 0 ? ' bal' : ''}`}>
                      {parseFloat(inv.balance) > 0 ? fmt(inv.balance) : '—'}
                    </td>
                    <td><RateBar rate={inv.collection_rate} /></td>
                    <td><StatusBadge status={inv.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
