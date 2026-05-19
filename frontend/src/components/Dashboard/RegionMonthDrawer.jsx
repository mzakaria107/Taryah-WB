import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { X, ExternalLink } from 'lucide-react';
import client from '../../api/client';
import './RegionMonthDrawer.css';

const MONTH_AR = [
  'يناير','فبراير','مارس','أبريل','مايو','يونيو',
  'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر',
];

function fmtBal(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(1) + 'K';
  return Math.round(v).toLocaleString('en-SA');
}

/* ── Skeleton rows ── */
function SkeletonRows() {
  return Array.from({ length: 6 }, (_, i) => (
    <tr key={i} className="rmd-sk-row">
      {[60, 30, 20, 20, 40].map((w, j) => (
        <td key={j}><div className="rmd-sk" style={{ width: `${w}%` }} /></td>
      ))}
    </tr>
  ));
}

export default function RegionMonthDrawer({ cell, customerTypeParam, onClose }) {
  const navigate = useNavigate();
  const { region_id, region_name, month, year } = cell;

  const { data, isLoading } = useQuery({
    queryKey: ['region-month-customers', region_id, month, year, customerTypeParam],
    queryFn: () => client.get('/invoices/region-month-customers', {
      params: {
        region_id, month, year,
        ...(customerTypeParam ? { customer_type: customerTypeParam } : {}),
      },
    }).then(r => r.data),
    staleTime: 30_000,
  });

  const customers = data?.customers ?? [];

  return (
    <>
      {/* Full-page backdrop — dims the rest of the page */}
      <div className="rmd-backdrop" onClick={onClose} />

      {/* Drawer panel — anchored to matrix section top via position:absolute */}
      <div className="rmd-drawer" onClick={e => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="rmd-header">
          <div className="rmd-header-text">
            <span className="rmd-region">{region_name}</span>
            <span className="rmd-period">{MONTH_AR[month - 1]} {year}</span>
          </div>
          <button className="rmd-close" onClick={onClose} title="إغلاق">
            <X size={17} />
          </button>
        </div>

        {/* ── KPI chips ── */}
        <div className="rmd-kpis">
          <div className="rmd-kpi">
            <span className="rmd-kpi-val">{isLoading ? '—' : (data?.customerCount ?? 0).toLocaleString('en-SA')}</span>
            <span className="rmd-kpi-lbl">عميل</span>
          </div>
          <div className="rmd-kpi">
            <span className="rmd-kpi-val">{isLoading ? '—' : (data?.invoiceCount ?? 0).toLocaleString('en-SA')}</span>
            <span className="rmd-kpi-lbl">فاتورة</span>
          </div>
          <div className="rmd-kpi rmd-kpi-unpaid">
            <span className="rmd-kpi-val">{isLoading ? '—' : (data?.unpaidCount ?? 0).toLocaleString('en-SA')}</span>
            <span className="rmd-kpi-lbl">✗ غير مسدد</span>
          </div>
          <div className="rmd-kpi rmd-kpi-partial">
            <span className="rmd-kpi-val">{isLoading ? '—' : (data?.partialCount ?? 0).toLocaleString('en-SA')}</span>
            <span className="rmd-kpi-lbl">◑ جزئي</span>
          </div>
          <div className="rmd-kpi rmd-kpi-balance">
            <span className="rmd-kpi-val">{isLoading ? '—' : fmtBal(data?.totalBalance ?? 0)}</span>
            <span className="rmd-kpi-lbl">ر.س رصيد</span>
          </div>
        </div>

        {/* ── Table ── */}
        <div className="rmd-table-wrap">
          <table className="rmd-table">
            <thead>
              <tr>
                <th>العميل</th>
                <th>الخط</th>
                <th>✗</th>
                <th>◑</th>
                <th>الرصيد</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <SkeletonRows />
              ) : customers.length === 0 ? (
                <tr><td colSpan={6} className="rmd-empty">لا توجد بيانات</td></tr>
              ) : (
                customers.map(c => (
                  <tr
                    key={c.customer_id}
                    className="rmd-cust-row"
                    onClick={() => navigate(`/customers/${c.customer_id}`)}
                    title="انقر لعرض تفاصيل العميل"
                  >
                    <td>
                      <span className="rmd-cust-name">{c.customer_name}</span>
                      {c.sales_rep_name && (
                        <span className="rmd-cust-rep">{c.sales_rep_name}</span>
                      )}
                    </td>
                    <td>
                      <span className="rmd-route">{c.route_id || '—'}</span>
                    </td>
                    <td>
                      {Number(c.unpaid_count) > 0 && (
                        <span className="rmd-badge rmd-badge-unpaid">
                          {Number(c.unpaid_count)}
                        </span>
                      )}
                    </td>
                    <td>
                      {Number(c.partial_count) > 0 && (
                        <span className="rmd-badge rmd-badge-partial">
                          {Number(c.partial_count)}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="rmd-bal">{fmtBal(c.total_balance)}</span>
                    </td>
                    <td>
                      <ExternalLink size={13} className="rmd-link-icon" />
                    </td>
                  </tr>
                ))
              )}
            </tbody>

            {/* Footer totals */}
            {!isLoading && customers.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={2} className="rmd-tf-lbl">
                    المجموع ({customers.length} عميل)
                  </td>
                  <td><span className="rmd-badge rmd-badge-unpaid">{data?.unpaidCount ?? 0}</span></td>
                  <td><span className="rmd-badge rmd-badge-partial">{data?.partialCount ?? 0}</span></td>
                  <td><span className="rmd-bal rmd-bal-total">{fmtBal(data?.totalBalance ?? 0)}</span></td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

      </div>
    </>
  );
}
