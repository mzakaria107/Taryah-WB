import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Printer, CalendarRange, FileSpreadsheet, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import * as XLSX from 'xlsx';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { usePermissions } from '../context/PermissionsContext';
import AgingInvoiceModal from '../components/AgingInvoiceModal';
import './AgingPage.css';
import './AgingByPeriodPage.css';

const fmt = n => (n == null || n === 0) ? '—' : Number(n).toLocaleString('en-SA', { maximumFractionDigits: 0 });

// Same colour bands as the aging page's age badge.
function AgeBadge({ days }) {
  if (days == null) return <span className="age-cell--zero">—</span>;
  const cls = days <= 15 ? 'age-avg--b1' : days <= 30 ? 'age-avg--b2' : days <= 60 ? 'age-avg--b3'
    : days <= 90 ? 'age-avg--b4' : days <= 120 ? 'age-avg--b5' : 'age-avg--b6';
  return <span className={`age-avg-badge ${cls}`}>{days} يوم</span>;
}

const TEXT_COLS = ['customer_name', 'customer_id', 'region_name'];
const ROW_COLS  = [...TEXT_COLS, 'total', 'oldest_age_days', 'newest_age_days', 'bad_debt'];

function SortIcon({ col, sortBy, sortDir }) {
  if (sortBy !== col) return <ChevronsUpDown size={12} style={{ opacity: 0.4 }} />;
  return sortDir === 'desc' ? <ChevronDown size={12} /> : <ChevronUp size={12} />;
}

const BAD_DEBT_FILTERS = [
  ['',        'كل العملاء'],
  ['only',    'المديونية المعدومة فقط'],
  ['exclude', 'استبعاد المعدومة'],
];

export default function AgingByPeriodPage() {
  const { user }  = useAuth();
  const { perms } = usePermissions();
  const canEditBadDebt = !!user && (['super_admin', 'it_admin'].includes(user.role)
    || (perms?.aging_by_period?.[user.role] ?? 0) >= 2);
  const queryClient = useQueryClient();
  const [badDebtFilter,    setBadDebtFilter]    = useState('');
  const [regionId,         setRegionId]         = useState('');
  const [routeId,          setRouteId]          = useState('');
  const [salesRep,         setSalesRep]         = useState('');
  const [search,           setSearch]           = useState('');
  const [excludeDirect,    setExcludeDirect]    = useState(true);
  const [excludeCarrefour, setExcludeCarrefour] = useState(false);
  const [modalCustomer,    setModalCustomer]    = useState(null);
  const [sortBy,  setSortBy]  = useState('total');
  const [sortDir, setSortDir] = useState('desc');

  const { data: meta } = useQuery({
    queryKey: ['meta'],
    queryFn: () => api.get('/invoices/meta').then(r => r.data),
    staleTime: 300_000,
  });

  const params = useMemo(() => {
    const p = {};
    if (regionId)         p.region_id         = regionId;
    if (routeId)          p.route_id          = routeId;
    if (salesRep)         p.sales_rep_name    = salesRep;
    if (search)           p.search            = search;
    if (excludeDirect)    p.customer_type     = 'route';
    if (excludeCarrefour) p.exclude_carrefour = '1';
    return p;
  }, [regionId, routeId, salesRep, search, excludeDirect, excludeCarrefour]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['aging-by-period', params],
    queryFn: () => api.get('/aging/by-period', { params }).then(r => r.data),
    keepPreviousData: true,
    staleTime: 120_000,
  });

  // Flag/un-flag a customer's debt as uncollectable; patch every cached by-period result in place.
  const badDebtMutation = useMutation({
    mutationFn: ({ customerId, badDebt }) =>
      api.put(`/aging/bad-debt/${encodeURIComponent(customerId)}`, { bad_debt: badDebt }).then(r => r.data),
    onSuccess: res => {
      queryClient.setQueriesData({ queryKey: ['aging-by-period'] }, old => old && ({
        ...old,
        customers: old.customers.map(c => c.customer_id === res.customer_id
          ? { ...c, bad_debt: res.bad_debt, bad_debt_marked_at: res.bad_debt_marked_at }
          : c),
      }));
    },
    onError: err => alert(err.response?.data?.error || 'تعذّر حفظ حالة المديونية'),
  });

  const periods   = data?.periods || [];
  const yearCols  = periods.filter(p => p.kind === 'year');
  const curYear   = data?.current_year;
  const rows = useMemo(() => {
    let list = data?.customers || [];
    if (badDebtFilter === 'only')    list = list.filter(c => c.bad_debt);
    if (badDebtFilter === 'exclude') list = list.filter(c => !c.bad_debt);
    list = [...list];
    const isText = TEXT_COLS.includes(sortBy);
    const val = c => ROW_COLS.includes(sortBy) ? c[sortBy] : (c.by_period[sortBy] || 0);
    list.sort((a, b) => {
      const va = val(a), vb = val(b);
      const cmp = isText
        ? String(va ?? '').localeCompare(String(vb ?? ''), 'ar', { numeric: true })
        : (va ?? -1) - (vb ?? -1);
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return list;
  }, [data, sortBy, sortDir, badDebtFilter]);

  // Footer/KPIs summed from the visible rows so they follow the bad-debt filter.
  const totals = useMemo(() => {
    const t = { total: 0 };
    for (const c of rows) {
      t.total += Number(c.total || 0);
      for (const [k, v] of Object.entries(c.by_period)) t[k] = (t[k] || 0) + Number(v || 0);
    }
    return t;
  }, [rows]);
  const badDebtCount = useMemo(() => (data?.customers || []).filter(c => c.bad_debt).length, [data]);

  const curYearTotal = periods
    .filter(p => p.kind === 'month')
    .reduce((s, p) => s + Number(totals[p.key] || 0), 0);

  const onSort = col => {
    if (sortBy === col) setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortBy(col); setSortDir('desc'); }
  };

  const exclusionNote = [
    excludeDirect && 'مديونية المندوب مستبعدة',
    excludeCarrefour && 'مديونية كارفور مستبعدة',
    badDebtFilter === 'only' && 'المديونية المعدومة فقط',
    badDebtFilter === 'exclude' && 'المديونية المعدومة مستبعدة',
  ].filter(Boolean).join(' · ');

  const handleExport = () => {
    const header = ['العميل', 'رقم العميل', 'المنطقة', ...periods.map(p => p.label), 'إجمالي الدين', 'عمر أقدم دين (يوم)', 'عمر أقرب دين (يوم)', 'مديونية معدومة'];
    const body = rows.map(c => [
      c.customer_name, c.customer_id, c.region_name || '',
      ...periods.map(p => Number(c.by_period[p.key] || 0)),
      c.total, c.oldest_age_days ?? '', c.newest_age_days ?? '', c.bad_debt ? 'نعم' : '',
    ]);
    const foot = ['الإجمالي', '', '', ...periods.map(p => Number(totals[p.key] || 0)), Number(totals.total || 0), '', '', ''];
    const ws = XLSX.utils.aoa_to_sheet([header, ...body, foot]);
    ws['!cols'] = [{ wch: 32 }, { wch: 12 }, { wch: 14 }, ...periods.map(() => ({ wch: 13 })), { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'المديونية حسب الفترة');
    XLSX.writeFile(wb, `المديونية_حسب_الفترة_${new Date().toLocaleDateString('en-CA')}.xlsx`);
  };

  const handlePrint = () => {
    const prev = document.title;
    document.title = 'أعمار المديونية حسب الفترة';
    window.print();
    window.onafterprint = () => { document.title = prev; };
  };

  const isDirty = regionId || routeId || salesRep || search || !excludeDirect || excludeCarrefour || badDebtFilter;
  const reset = () => {
    setRegionId(''); setRouteId(''); setSalesRep(''); setSearch(''); setBadDebtFilter('');
    setExcludeDirect(true); setExcludeCarrefour(false);
  };

  return (
    <div className="age-page">
      <div className="age-print-header">
        <div className="age-print-title">أعمار المديونية حسب الفترة</div>
        <div className="age-print-meta">
          {new Date().toLocaleDateString('ar-SA-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric' })}
          {exclusionNote && <span> · {exclusionNote}</span>}
        </div>
      </div>

      <div className="age-header age-no-print">
        <CalendarRange size={24} color="#dc2626" />
        <h1 className="age-title">أعمار المديونية حسب الفترة</h1>
        <button className="age-export-btn" onClick={handleExport} disabled={!rows.length} title="تصدير إلى Excel">
          <FileSpreadsheet size={16} /> تصدير Excel
        </button>
        <button className="age-print-btn" onClick={handlePrint}>
          <Printer size={16} /> طباعة / PDF
        </button>
      </div>

      <div className="age-filters age-no-print">
        <button
          className={`age-exclude-direct-btn${excludeDirect ? ' age-exclude-direct-btn--on' : ''}`}
          onClick={() => setExcludeDirect(v => !v)}
        >
          <span className={`age-exclude-dot${excludeDirect ? ' age-exclude-dot--on' : ''}`} />
          {excludeDirect ? '✕ مديونية المندوب مستبعدة' : '⊕ عرض مديونية المندوب'}
        </button>
        <button
          className={`age-exclude-direct-btn age-exclude-carrefour-btn${excludeCarrefour ? ' age-exclude-direct-btn--on' : ''}`}
          onClick={() => setExcludeCarrefour(v => !v)}
        >
          <span className={`age-exclude-dot${excludeCarrefour ? ' age-exclude-dot--on' : ''}`} />
          {excludeCarrefour ? '✕ مديونية كارفور مستبعدة' : '⊕ استبعاد مديونية كارفور'}
        </button>
        <div className="age-filter-group">
          <span className="age-filter-label">بحث عن عميل</span>
          <input className="age-filter-input" placeholder="اسم العميل..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="age-filter-group">
          <span className="age-filter-label">المنطقة</span>
          <select className="age-filter-select" value={regionId} onChange={e => setRegionId(e.target.value)}>
            <option value="">كل المناطق</option>
            {(data?.regions || []).map(r => (
              <option key={r.region_id} value={r.region_id}>{r.region_name || `منطقة ${r.region_id}`}</option>
            ))}
          </select>
        </div>
        <div className="age-filter-group">
          <span className="age-filter-label">رقم الخط</span>
          <select className="age-filter-select" value={routeId} onChange={e => setRouteId(e.target.value)}>
            <option value="">كل الخطوط</option>
            {(meta?.routes || []).map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="age-filter-group">
          <span className="age-filter-label">المندوب</span>
          <select className="age-filter-select" value={salesRep} onChange={e => setSalesRep(e.target.value)}>
            <option value="">كل المندوبين</option>
            {(meta?.reps || []).map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="age-filter-group">
          <span className="age-filter-label">المديونية المعدومة{badDebtCount ? ` (${badDebtCount})` : ''}</span>
          <select className="age-filter-select" value={badDebtFilter} onChange={e => setBadDebtFilter(e.target.value)}>
            {BAD_DEBT_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {isDirty && <button className="age-filter-reset" onClick={reset}>إعادة تعيين</button>}
      </div>

      {isLoading && <div className="age-loading">جاري تحميل بيانات المديونيات…</div>}
      {isError   && <div className="age-loading">حدث خطأ في تحميل البيانات</div>}

      {!isLoading && !isError && data && (
        <>
          <div className="age-kpis">
            <div className="age-kpi-card age-kpi-card--total">
              <span className="age-kpi-label">إجمالي المديونية</span>
              <span className="age-kpi-value">{fmt(totals.total)}</span>
              <span className="age-kpi-pct" style={{ color: 'rgba(255,255,255,0.75)' }}>{rows.length} عميل</span>
            </div>
            {yearCols.map(p => (
              <div key={p.key} className="age-kpi-card abp-kpi--year">
                <span className="age-kpi-label">{p.label}</span>
                <span className="age-kpi-value">{fmt(totals[p.key])}</span>
              </div>
            ))}
            <div className="age-kpi-card abp-kpi--current">
              <span className="age-kpi-label">دين {curYear}</span>
              <span className="age-kpi-value">{fmt(curYearTotal)}</span>
            </div>
          </div>

          <div className="age-table-wrap">
            <table className="age-table abp-table">
              <thead>
                <tr>
                  <th onClick={() => onSort('customer_name')} className={sortBy === 'customer_name' ? 'age-th--sorted' : ''}>
                    <SortIcon col="customer_name" sortBy={sortBy} sortDir={sortDir} /> العميل
                  </th>
                  {[['customer_id', 'رقم العميل'], ['region_name', 'المنطقة']].map(([k, l]) => (
                    <th key={k} onClick={() => onSort(k)} className={sortBy === k ? 'age-th--sorted' : ''}>
                      <SortIcon col={k} sortBy={sortBy} sortDir={sortDir} /> {l}
                    </th>
                  ))}
                  {periods.map(p => (
                    <th
                      key={p.key}
                      onClick={() => onSort(p.key)}
                      className={`abp-th--${p.kind}${sortBy === p.key ? ' age-th--sorted' : ''}`}
                    >
                      <SortIcon col={p.key} sortBy={sortBy} sortDir={sortDir} /> {p.label}
                    </th>
                  ))}
                  <th onClick={() => onSort('total')} className={sortBy === 'total' ? 'age-th--sorted' : ''}>
                    <SortIcon col="total" sortBy={sortBy} sortDir={sortDir} /> إجمالي الدين
                  </th>
                  {[['oldest_age_days', 'عمر أقدم دين'], ['newest_age_days', 'عمر أقرب دين']].map(([k, l]) => (
                    <th key={k} onClick={() => onSort(k)} className={sortBy === k ? 'age-th--sorted' : ''}>
                      <SortIcon col={k} sortBy={sortBy} sortDir={sortDir} /> {l}
                    </th>
                  ))}
                  <th onClick={() => onSort('bad_debt')} className={sortBy === 'bad_debt' ? 'age-th--sorted' : ''}>
                    <SortIcon col="bad_debt" sortBy={sortBy} sortDir={sortDir} /> مديونية معدومة
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(c => (
                  <tr key={c.customer_id} className={c.bad_debt ? 'abp-row--bad-debt' : ''}>
                    <td>
                      <button
                        className="age-customer-link"
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                        onClick={() => setModalCustomer({ id: c.customer_id, name: c.customer_name })}
                      >
                        {c.customer_name}
                      </button>
                    </td>
                    <td className="abp-td--code">{c.customer_id}</td>
                    <td className="abp-td--region">{c.region_name || '—'}</td>
                    {periods.map(p => {
                      const v = Number(c.by_period[p.key] || 0);
                      return (
                        <td key={p.key} className={`abp-td--${p.kind}${v === 0 ? ' age-cell--zero' : v < 0 ? ' abp-td--neg' : ''}`}>
                          {fmt(v)}
                        </td>
                      );
                    })}
                    <td style={{ fontWeight: 700 }}>{fmt(c.total)}</td>
                    <td><AgeBadge days={c.oldest_age_days} /></td>
                    <td><AgeBadge days={c.newest_age_days} /></td>
                    <td className="abp-td--bad-debt">
                      <button
                        className={`abp-bad-debt-btn${c.bad_debt ? ' abp-bad-debt-btn--on' : ''}`}
                        disabled={!canEditBadDebt || badDebtMutation.isPending}
                        title={c.bad_debt
                          ? `معدومة منذ ${c.bad_debt_marked_at ? new Date(c.bad_debt_marked_at).toLocaleDateString('ar-SA-u-nu-latn') : '—'}${canEditBadDebt ? ' — اضغط للإلغاء' : ''}`
                          : (canEditBadDebt ? 'اضغط لتحديدها كمديونية معدومة' : 'غير معدومة')}
                        onClick={() => badDebtMutation.mutate({ customerId: c.customer_id, badDebt: !c.bad_debt })}
                      >
                        {c.bad_debt
                          ? '✓ معدومة'
                          : (canEditBadDebt ? 'تنشيط' : '—')}
                      </button>
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={periods.length + 8} className="age-loading">لا توجد مديونيات مطابقة</td></tr>
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td>الإجمالي ({rows.length} عميل)</td>
                    <td />
                    <td />
                    {periods.map(p => <td key={p.key}>{fmt(totals[p.key])}</td>)}
                    <td style={{ fontWeight: 800 }}>{fmt(totals.total)}</td>
                    <td />
                    <td />
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}

      {modalCustomer && (
        <AgingInvoiceModal customer={modalCustomer} onClose={() => setModalCustomer(null)} />
      )}
    </div>
  );
}
