import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUp, ArrowDown, Download } from 'lucide-react';
import NotesCell from './NotesCell';
import './InvoiceTable.css';

/* ── Formatters ──────────────────────────────────── */
const fmt = (n) => {
  if (n === null || n === undefined) return '—';
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

/* ── Status badge ────────────────────────────────── */
function StatusBadge({ status }) {
  const map = {
    paid:    ['مدفوع',     'paid'],
    partial: ['جزئي',      'partial'],
    unpaid:  ['غير مدفوع', 'unpaid'],
  };
  const [label, cls] = map[status] || ['—', ''];
  return <span className={`badge ${cls}`}>{label}</span>;
}

/* ── Sort header ─────────────────────────────────── */
function Th({ label, k, sortBy, dir, onSort, className = '' }) {
  const active = sortBy === k;
  return (
    <th
      className={`sortable${active ? ' sorted' : ''} ${className}`}
      onClick={() => onSort(k)}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        {active
          ? (dir === 'ASC' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)
          : <span style={{ opacity: 0.3, fontSize: 10 }}>↕</span>
        }
      </span>
    </th>
  );
}

/* ── Row background ──────────────────────────────── */
function rowClass(inv) {
  if (inv.status === 'paid') return '';
  const bal  = parseFloat(inv.balance || 0);
  const orig = parseFloat(inv.original_amount || 1);
  if (bal > 0 && orig > 0 && bal / orig >= 0.8) return 'row-danger';
  if (inv.status === 'partial') return 'row-warning';
  return '';
}

/* ── Column definitions ──────────────────────────── */
const COLS = [
  { key: 'customer_name',   label: 'اسم العميل',      sortable: true  },
  { key: 'customer_id',     label: 'كود العميل',       sortable: false },
  { key: 'region_name_ar',  label: 'المنطقة',           sortable: false },
  { key: 'route_id',        label: 'كود المسار',        sortable: true  },
  { key: 'invoice_number',  label: 'رقم الفاتورة',     sortable: false },
  { key: 'invoice_date',    label: 'تاريخ المعاملة',    sortable: true  },
  { key: 'year',            label: 'السنة',             sortable: true  },
  { key: 'original_amount', label: 'إجمالي الفاتورة',  sortable: true  },
  { key: 'paid_amount',     label: 'المدفوع',           sortable: true  },
  { key: 'balance',         label: 'الرصيد',            sortable: true  },
  { key: 'collection_rate', label: 'نسبة التحصيل',     sortable: true  },
  { key: 'status',          label: 'الحالة',            sortable: true  },
  { key: 'notes',           label: 'ملاحظات',           sortable: false },
];

/* ── Main component ──────────────────────────────── */
export default function InvoiceTable({ data = [], loading, total = 0, onRowClick, dashboardParams }) {
  const [sortBy, setSortBy] = useState('invoice_date');
  const [dir,    setDir]    = useState('DESC');
  const navigate            = useNavigate();

  const handleSort = (col) => {
    if (sortBy === col) setDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
    else { setSortBy(col); setDir('DESC'); }
  };

  const sorted = useMemo(() => {
    return [...data].sort((a, b) => {
      let va = a[sortBy] ?? '';
      let vb = b[sortBy] ?? '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return dir === 'ASC' ? -1 : 1;
      if (va > vb) return dir === 'ASC' ? 1 : -1;
      return 0;
    });
  }, [data, sortBy, dir]);

  /* Loading state */
  if (loading) {
    return (
      <div className="table-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 200, gap: 12 }}>
        <div className="spinner" style={{ width: 32, height: 32 }} />
        <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>جاري تحميل البيانات…</span>
      </div>
    );
  }

  /* Empty state */
  if (!data.length) {
    return (
      <div className="table-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 200, gap: 8 }}>
        <span style={{ fontSize: 40 }}>📭</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-secondary)' }}>لا توجد بيانات مطابقة للفلاتر المحددة</span>
      </div>
    );
  }

  return (
    <div className="table-card">
      {/* Toolbar */}
      <div className="table-toolbar">
        <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          عرض <strong style={{ color: 'var(--color-text-primary)' }}>{data.length.toLocaleString('en-SA')}</strong> فاتورة
          {total > data.length && (
            <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}> (من أصل {total.toLocaleString('en-SA')})</span>
          )}
        </span>
        <div className="toolbar-actions">
          <button className="chip-btn">
            <Download size={13} /> CSV
          </button>
          <button className="chip-btn gold">
            <Download size={13} /> تصدير Excel
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="table-wrap">
        <table className="invoice-table">
          <thead>
            <tr>
              {COLS.map((c) =>
                c.sortable ? (
                  <Th key={c.key} label={c.label} k={c.key} sortBy={sortBy} dir={dir} onSort={handleSort} />
                ) : (
                  <th key={c.key}>{c.label}</th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {sorted.map((inv) => (
              <tr
                key={inv.id}
                className={rowClass(inv)}
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  if (onRowClick) { onRowClick(inv.customer_id); return; }
                  navigate(`/customers/${encodeURIComponent(inv.customer_id)}`,
                    { state: { dashboardParams } });
                }}
              >
                {/* Customer name — Arabic primary, English secondary */}
                <td style={{ minWidth: 200 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.3 }}>{inv.customer_name}</div>
                  {inv.customer_name_en && inv.customer_name_en !== inv.customer_name && (
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'var(--font-en)' }}>
                      {inv.customer_name_en}
                    </div>
                  )}
                </td>

                <td className="num" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  {inv.customer_id}
                </td>

                <td style={{ whiteSpace: 'nowrap' }}>{inv.region_name_ar || '—'}</td>

                <td className="num" style={{ fontSize: 12 }}>{inv.route_id || '—'}</td>

                <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{inv.invoice_number}</td>

                <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {inv.invoice_date ? String(inv.invoice_date).split('T')[0] : '—'}
                </td>

                <td className="num" style={{ textAlign: 'center', fontWeight: 600 }}>{inv.year || '—'}</td>

                <td className="amount num">{fmt(inv.original_amount)}</td>

                <td className="amount paid num">{fmt(inv.paid_amount)}</td>

                <td className={`amount num${parseFloat(inv.balance) > 0 ? ' balance' : ''}`}>
                  {fmt(inv.balance)}
                </td>

                <td><RateBar rate={inv.collection_rate} /></td>

                <td><StatusBadge status={inv.status} /></td>

                <td className="notes-td" onClick={(e) => { e.stopPropagation(); }}>
                  <NotesCell invoiceId={inv.id} initialText={inv.note_text || ''} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Cap hint */}
      {total > data.length && (
        <div style={{
          padding: '10px 18px', borderTop: '1px solid var(--color-border)',
          fontSize: 12, color: 'var(--color-text-muted)', background: 'var(--color-warning-bg)',
          textAlign: 'center',
        }}>
          يتم عرض أول {data.length.toLocaleString('en-SA')} نتيجة من {total.toLocaleString('en-SA')} — استخدم الفلاتر لتضييق النتائج
        </div>
      )}
    </div>
  );
}
