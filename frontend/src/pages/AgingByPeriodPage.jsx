import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer, CalendarRange, FileSpreadsheet, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import * as XLSX from 'xlsx';
import api from '../api/client';
import './AgingPage.css';
import './AgingByPeriodPage.css';

const fmt = n => (n == null || n === 0) ? '—' : Number(n).toLocaleString('en-SA', { maximumFractionDigits: 0 });

function SortIcon({ col, sortBy, sortDir }) {
  if (sortBy !== col) return <ChevronsUpDown size={12} style={{ opacity: 0.4 }} />;
  return sortDir === 'desc' ? <ChevronDown size={12} /> : <ChevronUp size={12} />;
}

export default function AgingByPeriodPage() {
  const [regionId,         setRegionId]         = useState('');
  const [routeId,          setRouteId]          = useState('');
  const [salesRep,         setSalesRep]         = useState('');
  const [search,           setSearch]           = useState('');
  const [excludeDirect,    setExcludeDirect]    = useState(true);
  const [excludeCarrefour, setExcludeCarrefour] = useState(false);
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

  const periods   = data?.periods || [];
  const totals    = data?.totals || {};
  const yearCols  = periods.filter(p => p.kind === 'year');
  const curYear   = data?.current_year;
  const curYearTotal = periods
    .filter(p => p.kind === 'month')
    .reduce((s, p) => s + Number(totals[p.key] || 0), 0);

  const rows = useMemo(() => {
    const list = [...(data?.customers || [])];
    const val = c => sortBy === 'customer_name' ? c.customer_name
      : sortBy === 'total' ? c.total : (c.by_period[sortBy] || 0);
    list.sort((a, b) => {
      const va = val(a), vb = val(b);
      const cmp = typeof va === 'string' ? va.localeCompare(vb, 'ar') : va - vb;
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return list;
  }, [data, sortBy, sortDir]);

  const onSort = col => {
    if (sortBy === col) setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortBy(col); setSortDir('desc'); }
  };

  const exclusionNote = [
    excludeDirect && 'مديونية المندوب مستبعدة',
    excludeCarrefour && 'مديونية كارفور مستبعدة',
  ].filter(Boolean).join(' · ');

  const handleExport = () => {
    const header = ['العميل', 'كود العميل', ...periods.map(p => p.label), 'إجمالي الدين'];
    const body = rows.map(c => [
      c.customer_name, c.customer_id,
      ...periods.map(p => Number(c.by_period[p.key] || 0)),
      c.total,
    ]);
    const foot = ['الإجمالي', '', ...periods.map(p => Number(totals[p.key] || 0)), Number(totals.total || 0)];
    const ws = XLSX.utils.aoa_to_sheet([header, ...body, foot]);
    ws['!cols'] = [{ wch: 32 }, { wch: 12 }, ...periods.map(() => ({ wch: 13 })), { wch: 14 }];
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

  const isDirty = regionId || routeId || salesRep || search || !excludeDirect || excludeCarrefour;
  const reset = () => {
    setRegionId(''); setRouteId(''); setSalesRep(''); setSearch('');
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
                </tr>
              </thead>
              <tbody>
                {rows.map(c => (
                  <tr key={c.customer_id}>
                    <td>
                      <Link className="age-customer-link" to={`/customers/${encodeURIComponent(c.customer_id)}`}>
                        {c.customer_name}
                      </Link>
                    </td>
                    {periods.map(p => {
                      const v = Number(c.by_period[p.key] || 0);
                      return (
                        <td key={p.key} className={`abp-td--${p.kind}${v === 0 ? ' age-cell--zero' : v < 0 ? ' abp-td--neg' : ''}`}>
                          {fmt(v)}
                        </td>
                      );
                    })}
                    <td style={{ fontWeight: 700 }}>{fmt(c.total)}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={periods.length + 2} className="age-loading">لا توجد مديونيات مطابقة</td></tr>
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td>الإجمالي ({rows.length} عميل)</td>
                    {periods.map(p => <td key={p.key}>{fmt(totals[p.key])}</td>)}
                    <td style={{ fontWeight: 800 }}>{fmt(totals.total)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
    </div>
  );
}
