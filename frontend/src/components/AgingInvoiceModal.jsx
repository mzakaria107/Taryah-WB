import React, { useEffect } from 'react';
import ReactDOM from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClockArrowUp, X, ExternalLink } from 'lucide-react';
import api from '../api/client';
import '../pages/AgingPage.css';

// Shared by AgingPage and AgingByPeriodPage — styles live in AgingPage.css (age-* classes).
const fmtDate = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('ar-SA-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

function ageBadgeClass(days) {
  if (days <= 15)  return 'age-badge--b1';
  if (days <= 30)  return 'age-badge--b2';
  if (days <= 60)  return 'age-badge--b3';
  if (days <= 90)  return 'age-badge--b4';
  if (days <= 120) return 'age-badge--b5';
  return 'age-badge--b6';
}

async function fetchInvoices(customerId) {
  const { data } = await api.get(`/aging/invoices/${customerId}`);
  return data;
}

/* ═══════════════════════════════════════════════════════════════
   InvoiceModal — invoice-level detail for one customer
═══════════════════════════════════════════════════════════════ */
export default function AgingInvoiceModal({ customer, onClose }) {
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
