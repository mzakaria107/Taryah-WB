import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import './Dashboard.css';
import KPICards             from '../components/Dashboard/KPICards';
import RegionBalanceCards   from '../components/Dashboard/RegionBalanceCards';
import RegionStatusCards    from '../components/Dashboard/RegionStatusCards';
import RegionMonthMatrix    from '../components/Dashboard/RegionMonthMatrix';
import Filters, { EMPTY_FILTERS } from '../components/Dashboard/Filters';
import CustomerSummaryTable from '../components/Dashboard/CustomerSummaryTable';
import StatusRow            from '../components/Dashboard/StatusRow';
import { useAuth }          from '../context/AuthContext';
import client               from '../api/client';

/* ── Last-uploads bar ───────────────────────────── */
const REPORTS = [
  { key: 'customer_balance', label: 'أرصدة العملاء',       icon: '📄' },
  { key: 'payments',         label: 'المدفوعات',            icon: '💳' },
  { key: 'sales_activity',   label: 'تقرير العملاء المتعاملة', icon: '📊' },
];

function fmtTs(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toLocaleString('ar-SA', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function ageColor(ts) {
  if (!ts) return '#9ca3af';
  const h = (Date.now() - new Date(ts)) / 3_600_000;
  if (h < 6)  return '#10b981'; // green — fresh
  if (h < 24) return '#f59e0b'; // amber — same day
  return '#ef4444';              // red   — stale
}

function LastUploadsBar({ data }) {
  if (!data) return null;
  return (
    <div style={{
      display: 'flex', gap: 12, flexWrap: 'wrap',
      background: '#f8fafc', border: '1px solid #e2e8f0',
      borderRadius: 12, padding: '10px 16px',
      marginBottom: 20, alignItems: 'center',
    }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginLeft: 4, flexShrink: 0 }}>
        🕐 آخر تحديث للبيانات:
      </span>
      {REPORTS.map(r => {
        const ts  = data[r.key];
        const fmt = fmtTs(ts);
        const col = ageColor(ts);
        return (
          <div key={r.key} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: '#fff', border: `1px solid ${col}33`,
            borderRadius: 8, padding: '5px 12px', fontSize: 12,
          }}>
            <span>{r.icon}</span>
            <span style={{ color: '#374151', fontWeight: 600 }}>{r.label}:</span>
            <span style={{ color: col, fontWeight: 700, fontFamily: 'var(--font-en)' }}>
              {fmt ?? 'لم يُحدَّث بعد'}
            </span>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: col, flexShrink: 0,
            }} />
          </div>
        );
      })}
    </div>
  );
}

/* ── Build API params from filter state ─────────── */
function buildParams(filters) {
  const p = {};
  if (filters.region_id)      p.region_id      = filters.region_id;
  if (filters.status)         p.status         = filters.status;
  if (filters.route_id)       p.route_id       = filters.route_id;
  if (filters.search)         p.search         = filters.search;
  if (filters.sales_rep_name) p.sales_rep_name = filters.sales_rep_name;
  if (filters.activeYears && filters.activeYears.size > 0)
    p.years = [...filters.activeYears].sort().join(',');
  if (filters.activeMonths && filters.activeMonths.size > 0)
    p.months = [...filters.activeMonths].sort((a, b) => a - b).join(',');
  if (filters.includeDirect === false) p.customer_type = 'route';
  return p;
}

export default function Dashboard() {
  const { user } = useAuth();
  const [filters,  setFilters]  = useState(() => {
    // Restore includeDirect from sessionStorage so it persists within the session
    const saved = sessionStorage.getItem('includeDirect');
    return {
      ...EMPTY_FILTERS,
      includeDirect: saved === null ? true : saved === 'true',
    };
  });
  const [sortBy,   setSortBy]   = useState('total_balance');
  const [sortDir,  setSortDir]  = useState('DESC');

  // Persist includeDirect for the whole browser session
  useEffect(() => {
    sessionStorage.setItem('includeDirect', String(filters.includeDirect));
  }, [filters.includeDirect]);

  const handleSort = (col) => {
    if (col === sortBy) {
      setSortDir(d => d === 'DESC' ? 'ASC' : 'DESC');
    } else {
      setSortBy(col);
      setSortDir('DESC');
    }
  };

  const params = useMemo(() => buildParams(filters), [filters]);

  /* Year-strip / meta scope */
  const yearStripParams = useMemo(() => {
    const p = {};
    if (filters.region_id)              p.region_id     = filters.region_id;
    if (filters.includeDirect === false) p.customer_type = 'route';
    return p;
  }, [filters.region_id, filters.includeDirect]);

  const metaParams = useMemo(() => ({ ...yearStripParams }), [yearStripParams]);

  /* ── Queries ──────────────────────────────────── */
  const { data: meta } = useQuery({
    queryKey: ['meta', metaParams],
    queryFn:  () => client.get('/invoices/meta', { params: metaParams }).then(r => r.data),
    staleTime: 120_000,
  });

  const { data: kpis, isLoading: kpisLoading } = useQuery({
    queryKey: ['kpis', params],
    queryFn:  () => client.get('/invoices/kpi', { params }).then(r => r.data),
    staleTime: 30_000,
  });

  const { data: years = [] } = useQuery({
    queryKey: ['years', yearStripParams],
    queryFn:  () => client.get('/invoices/years', { params: yearStripParams }).then(r => r.data),
    staleTime: 60_000,
  });

  /* Status by region — for the two KPI cards */
  const { data: statusByRegion, isLoading: statusLoading } = useQuery({
    queryKey: ['status-by-region', params],
    queryFn:  () => client.get('/invoices/status-by-region', { params }).then(r => r.data),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  /* Balance by region (for the region cards next to year strip) */
  const { data: regionBalance = [], isLoading: regionLoading } = useQuery({
    queryKey: ['balance-by-region', params],
    queryFn:  () => client.get('/invoices/balance-by-region', { params }).then(r => r.data),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  /* Monthly summary — year determined from active filter or most-recent data year */
  const monthlySummaryYear = useMemo(() => {
    if (filters.activeYears?.size === 1) return [...filters.activeYears][0];
    if (years.length > 0) return Math.max(...years.map(y => y.year));
    return new Date().getFullYear();
  }, [filters.activeYears, years]);

  const monthlyParams = useMemo(() => {
    const p = {};
    if (params.region_id)    p.region_id    = params.region_id;
    if (params.customer_type) p.customer_type = params.customer_type;
    p.year = monthlySummaryYear;
    return p;
  }, [params.region_id, params.customer_type, monthlySummaryYear]);

  const { data: monthlySummary, isLoading: monthlyLoading } = useQuery({
    queryKey: ['monthly-summary', monthlyParams],
    queryFn:  () => client.get('/invoices/monthly-summary', { params: monthlyParams }).then(r => r.data),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  /* Monthly summary for previous year (always currentYear - 1) */
  const monthlyParamsPrev = useMemo(() => {
    const p = {};
    if (params.region_id)     p.region_id     = params.region_id;
    if (params.customer_type) p.customer_type = params.customer_type;
    p.year = monthlySummaryYear - 1;
    return p;
  }, [params.region_id, params.customer_type, monthlySummaryYear]);

  const { data: monthlySummaryPrev, isLoading: monthlyLoadingPrev } = useQuery({
    queryKey: ['monthly-summary', monthlyParamsPrev],
    queryFn:  () => client.get('/invoices/monthly-summary', { params: monthlyParamsPrev }).then(r => r.data),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  /* Customer summary */
  const { data: custData, isLoading: custLoading } = useQuery({
    queryKey: ['customers-summary', params, sortBy, sortDir],
    queryFn:  () => client.get('/invoices/customers', {
      params: { ...params, limit: 500, sort_by: sortBy, sort_dir: sortDir },
    }).then(r => r.data),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const customers   = custData?.data  ?? [];
  const custTotal   = custData?.total ?? 0;
  const metaRegions = meta?.regions   ?? [];
  const metaReps    = meta?.reps      ?? [];
  const metaRoutes  = meta?.routes    ?? [];

  const availableYears = useMemo(
    () => years.map(y => y.year).sort((a, b) => a - b),
    [years]
  );

  const handleYearSelect = useCallback((year) => {
    setFilters(prev => {
      const base = prev.activeYears ? new Set(prev.activeYears) : new Set(availableYears);
      if (base.has(year)) base.delete(year); else base.add(year);
      const next = base.size === availableYears.length ? null : base;
      return { ...prev, activeYears: next };
    });
  }, [availableYears]);

  const customerParams = useMemo(() => {
    const p = { ...params };
    delete p.search;
    delete p.status;
    delete p.route_id;
    delete p.sales_rep_name;
    return p;
  }, [params]);

  const handlePrint = useCallback(() => {
    const prev = document.title;
    document.title = `لوحة التحكم — ${new Date().toLocaleDateString('ar-SA', { year:'numeric', month:'long', day:'numeric' })}`;
    window.print();
    window.onafterprint = () => { document.title = prev; window.onafterprint = null; };
  }, []);

  /* Last-upload timestamps */
  const { data: lastUploads } = useQuery({
    queryKey: ['last-uploads'],
    queryFn:  () => client.get('/last-uploads').then(r => r.data),
    staleTime: 60_000,
    refetchInterval: 300_000, // refresh every 5 min
  });

  return (
    <div className="db-page">
      {/* Print header */}
      <div className="db-print-header">
        <span className="db-print-logo">📊</span>
        <span className="db-print-title">لوحة التحكم — Dashboard</span>
        <span className="db-print-date">{new Date().toLocaleDateString('ar-SA',{year:'numeric',month:'long',day:'numeric',weekday:'long'})}</span>
      </div>

      {/* PDF button */}
      <button className="db-pdf-btn db-no-print" onClick={handlePrint} title="تصدير PDF / طباعة">
        <Printer size={14} /> PDF
      </button>

      {/* Last upload timestamps bar */}
      <LastUploadsBar data={lastUploads} />

      {/* KPI Cards */}
      <KPICards data={kpis} loading={kpisLoading} />

      {/* Status row: Monthly chart + Unpaid KPI + Partial KPI + Year strip */}
      <StatusRow
        kpis={kpis}
        kpisLoading={kpisLoading}
        statusByRegion={statusByRegion}
        statusLoading={statusLoading}
        monthlySummary={monthlySummary}
        monthlyLoading={monthlyLoading}
        monthlySummaryPrev={monthlySummaryPrev}
        monthlyLoadingPrev={monthlyLoadingPrev}
        years={years}
        activeYears={filters.activeYears}
        availableYears={availableYears}
        onYearSelect={handleYearSelect}
      />

      {/* Region balance cards */}
      <div style={{ marginBottom: 24 }}>
        <RegionBalanceCards data={regionBalance} loading={regionLoading} />
      </div>

      {/* Region status cards — unpaid + partial invoice counts */}
      <RegionStatusCards statusByRegion={statusByRegion} loading={statusLoading} />

      {/* Region × Month heat-map matrix */}
      <RegionMonthMatrix
        defaultYear={monthlySummaryYear}
        matrixParams={customerParams}
        availableYears={availableYears}
      />

      {/* Filters */}
      <Filters
        filters={filters}
        onChange={setFilters}
        regions={metaRegions}
        user={user}
        availableYears={availableYears}
        directStats={null}
        metaReps={metaReps}
        metaRoutes={metaRoutes}
      />

      {/* Result info + active filter badges */}
      {!custLoading && (
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12, paddingRight:2, flexWrap:'wrap' }}>
          <span style={{ fontSize:13, color:'var(--color-text-secondary)' }}>
            عرض{' '}
            <strong style={{ color:'var(--color-text-primary)' }}>
              {customers.length.toLocaleString('en-SA')}
            </strong>{' '}
            عميل
            {custTotal > customers.length && (
              <span style={{ color:'var(--color-text-muted)', fontSize:11 }}>
                {' '}(من أصل {custTotal.toLocaleString('en-SA')})
              </span>
            )}
          </span>

          {filters.includeDirect === false && (
            <span style={{ fontSize:11, padding:'2px 10px', borderRadius:999,
              background:'var(--color-danger-bg)', color:'var(--color-danger)',
              border:'1px solid rgba(198,40,40,0.2)', fontWeight:600 }}>
              المبيعات المباشرة مستبعدة
            </span>
          )}
          {filters.region_id && (
            <span style={{ fontSize:11, padding:'2px 10px', borderRadius:999,
              background:'var(--color-brand-green-pale)', color:'var(--color-brand-green)',
              border:'1px solid rgba(46,125,50,0.2)', fontWeight:600,
              display:'flex', alignItems:'center', gap:4 }}>
              المنطقة: {metaRegions.find(r => String(r.id) === String(filters.region_id))?.name_ar || filters.region_id}
              <button onClick={() => setFilters(f => ({ ...f, region_id:'' }))}
                style={{ background:'none', border:0, cursor:'pointer', color:'inherit', padding:0, fontSize:12 }}>✕</button>
            </span>
          )}
          {filters.sales_rep_name && (
            <span style={{ fontSize:11, padding:'2px 10px', borderRadius:999,
              background:'var(--color-brand-green-pale)', color:'var(--color-brand-green)',
              border:'1px solid rgba(46,125,50,0.2)', fontWeight:600,
              display:'flex', alignItems:'center', gap:4 }}>
              المندوب: {filters.sales_rep_name}
              <button onClick={() => setFilters(f => ({ ...f, sales_rep_name:'' }))}
                style={{ background:'none', border:0, cursor:'pointer', color:'inherit', padding:0, fontSize:12 }}>✕</button>
            </span>
          )}
          {filters.route_id && (
            <span style={{ fontSize:11, padding:'2px 10px', borderRadius:999,
              background:'var(--color-brand-green-pale)', color:'var(--color-brand-green)',
              border:'1px solid rgba(46,125,50,0.2)', fontWeight:600,
              display:'flex', alignItems:'center', gap:4, fontFamily:'var(--font-en)' }}>
              خط: {filters.route_id}
              <button onClick={() => setFilters(f => ({ ...f, route_id:'' }))}
                style={{ background:'none', border:0, cursor:'pointer', color:'inherit', padding:0, fontSize:12 }}>✕</button>
            </span>
          )}
        </div>
      )}

      {/* Customer summary table */}
      <CustomerSummaryTable
        data={customers}
        loading={custLoading}
        total={custTotal}
        dashboardParams={customerParams}
        exportParams={params}
        sortBy={sortBy}
        sortDir={sortDir}
        onSort={handleSort}
      />
    </div>
  );
}
