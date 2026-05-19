import React, { useState, useMemo } from 'react';
import NotesCell from './NotesCell';

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function RateBar({ rate }) {
  const r = Math.min(100, Math.max(0, parseFloat(rate) || 0));
  const color = r >= 90 ? '#16a34a' : r >= 60 ? '#d97706' : '#dc2626';
  return (
    <div className="flex items-center gap-1.5">
      <div className="rate-bar-bg">
        <div className="rate-bar-fill" style={{ width: `${r}%`, background: color }} />
      </div>
      <span className="text-xs ltr-num font-medium" style={{ color }}>{r.toFixed(1)}%</span>
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    paid:    ['مدفوع',     'badge-paid'],
    partial: ['جزئي',      'badge-partial'],
    unpaid:  ['غير مدفوع', 'badge-unpaid'],
  };
  const [label, cls] = map[status] || ['—', ''];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function SortIcon({ col, sortBy, dir }) {
  if (sortBy !== col) return <span className="opacity-30 text-xs">↕</span>;
  return <span className="text-blue-300 text-xs">{dir === 'ASC' ? '↑' : '↓'}</span>;
}

const COLS = [
  { key: 'customer_name',   label: 'اسم العميل',     sortable: true,  width: 'min-w-[200px]' },
  { key: 'customer_id',     label: 'كود العميل',      sortable: false, width: 'min-w-[90px]'  },
  { key: 'region_name_ar',  label: 'المنطقة',          sortable: false, width: 'min-w-[80px]'  },
  { key: 'route_id',        label: 'كود المسار',       sortable: true,  width: 'min-w-[80px]'  },
  { key: 'invoice_number',  label: 'رقم الفاتورة',    sortable: false, width: 'min-w-[120px]' },
  { key: 'invoice_date',    label: 'تاريخ المعاملة',   sortable: true,  width: 'min-w-[110px]' },
  { key: 'year',            label: 'السنة',            sortable: true,  width: 'min-w-[60px]'  },
  { key: 'original_amount', label: 'إجمالي الفاتورة', sortable: true,  width: 'min-w-[120px]' },
  { key: 'paid_amount',     label: 'المدفوع',          sortable: true,  width: 'min-w-[110px]' },
  { key: 'balance',         label: 'الرصيد',           sortable: true,  width: 'min-w-[110px]' },
  { key: 'collection_rate', label: 'نسبة التحصيل',    sortable: true,  width: 'min-w-[130px]' },
  { key: 'status',          label: 'الحالة',           sortable: true,  width: 'min-w-[90px]'  },
  { key: 'notes',           label: 'ملاحظات',          sortable: false, width: 'min-w-[180px]' },
];

function rowBg(inv) {
  if (inv.status === 'paid') return '';
  const balance  = parseFloat(inv.balance || 0);
  const original = parseFloat(inv.original_amount || 1);
  if (balance > 0 && original > 0 && balance / original >= 0.8) return 'bg-red-50';
  if (inv.status === 'partial') return 'bg-amber-50';
  return '';
}

export default function InvoiceTable({ data = [], loading }) {
  const [sortBy, setSortBy] = useState('invoice_date');
  const [dir, setDir]       = useState('DESC');

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

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-2 text-gray-400">
        <div className="w-8 h-8 border-4 border-gray-200 border-t-blue-500 rounded-full animate-spin" />
        <span className="text-sm">جاري تحميل البيانات...</span>
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-2 text-gray-400">
        <span className="text-4xl">📭</span>
        <span className="text-sm">لا توجد بيانات مطابقة للفلاتر المحددة</span>
      </div>
    );
  }

  return (
    <div className="table-container rounded-xl shadow-sm border border-gray-100">
      <table>
        <thead>
          <tr>
            {COLS.map((c) => (
              <th
                key={c.key}
                onClick={c.sortable ? () => handleSort(c.key) : undefined}
                className={`px-3 py-3 text-right text-xs font-semibold whitespace-nowrap select-none ${c.width} ${
                  c.sortable ? 'cursor-pointer hover:bg-gray-700' : ''
                }`}
              >
                <span className="flex items-center gap-1 justify-end">
                  {c.label}
                  {c.sortable && <SortIcon col={c.key} sortBy={sortBy} dir={dir} />}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((inv) => (
            <tr
              key={inv.id}
              className={`border-b border-gray-100 hover:bg-blue-50/60 transition-colors ${rowBg(inv)}`}
            >
              {/* Customer Name — Arabic primary, English secondary */}
              <td className="px-3 py-2 min-w-[200px]">
                <div className="font-medium text-gray-800 text-sm leading-tight">{inv.customer_name}</div>
                {inv.customer_name_en && inv.customer_name_en !== inv.customer_name && (
                  <div className="text-[11px] text-gray-400 ltr-num mt-0.5">{inv.customer_name_en}</div>
                )}
              </td>

              <td className="px-3 py-2 text-xs text-gray-500 ltr-num">{inv.customer_id}</td>
              <td className="px-3 py-2 text-sm text-gray-600 whitespace-nowrap">{inv.region_name_ar || '—'}</td>
              <td className="px-3 py-2 text-sm text-gray-600 ltr-num">{inv.route_id || '—'}</td>
              <td className="px-3 py-2 text-sm text-gray-600 ltr-num whitespace-nowrap">{inv.invoice_number}</td>
              <td className="px-3 py-2 text-sm text-gray-500 ltr-num whitespace-nowrap">
                {inv.invoice_date ? String(inv.invoice_date).split('T')[0] : '—'}
              </td>
              <td className="px-3 py-2 text-sm ltr-num text-center font-medium">{inv.year || '—'}</td>
              <td className="px-3 py-2 text-sm ltr-num text-left">{fmt(inv.original_amount)}</td>
              <td className="px-3 py-2 text-sm ltr-num text-left text-green-700 font-medium">{fmt(inv.paid_amount)}</td>
              <td className={`px-3 py-2 text-sm ltr-num text-left font-bold ${
                parseFloat(inv.balance) > 0 ? 'text-red-600' : 'text-gray-400'
              }`}>
                {fmt(inv.balance)}
              </td>
              <td className="px-3 py-2"><RateBar rate={inv.collection_rate} /></td>
              <td className="px-3 py-2"><StatusBadge status={inv.status} /></td>
              <td className="px-3 py-2">
                <NotesCell invoiceId={inv.id} initialText={inv.note_text || ''} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
