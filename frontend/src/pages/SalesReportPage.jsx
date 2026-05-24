import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, ChevronDown, ChevronLeft, Printer,
  TrendingUp, Users, MapPin, Package, RotateCcw, Award,
  EyeOff, BarChart2, CalendarDays, Calendar,
  SlidersHorizontal, Check, X,
} from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './SalesReportPage.css';

const ADMIN_ROLES        = ['super_admin', 'it_admin'];
const FULL_VIEW_ROLES    = ['super_admin', 'it_admin', 'sales_manager', 'top_management'];
const TYPE_FILTER_KEY    = 'sales_report_item_types';
const REGION_FILTER_KEY  = 'sales_report_regions';

/* ── Constants ───────────────────────────────────────────────── */
const WAREHOUSE_NAME = 'مخزن دجاج حي';

const MONTH_NAMES = {
  1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
  7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
};

/* ── API helpers ─────────────────────────────────────────────── */
const api = {
  today:          () => client.get('/sales-report').then(r => r.data),
  todayRefresh:   () => client.get('/sales-report/refresh').then(r => r.data),
  monthly:        () => client.get('/sales-report/monthly').then(r => r.data),
  monthlyRefresh: () => client.get('/sales-report/monthly/refresh').then(r => r.data),
};

/* ── Formatters ─────────────────────────────────────────────── */
const fmt  = n => (n ?? 0).toLocaleString('en-SA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtC = n => (n ?? 0).toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ── Signed cell ─────────────────────────────────────────────── */
function NetVal({ n, isQty = false, bold = false }) {
  const abs = Math.abs(n ?? 0);
  const str = isQty ? fmt(abs) : fmtC(abs);
  if ((n ?? 0) < 0) return <span className={`srp-neg${bold ? ' srp-bold' : ''}`}>−{str}</span>;
  if ((n ?? 0) === 0) return <span className={bold ? 'srp-bold' : ''}>—</span>;
  return <span className={bold ? 'srp-bold' : ''}>{str}</span>;
}

/* ── Type badge color ────────────────────────────────────────── */
const typeColor = (t = '') => {
  if (t.includes('مقطع')) return '#8b5cf6';
  if (t.includes('GB'))   return '#0ea5e9';
  if (t.includes('حية'))  return '#f59e0b';
  return '#10b981';
};

/* ── KPI Card ────────────────────────────────────────────────── */
function KpiCard({ icon, label, value, sub, color = '#1d4ed8', loading }) {
  return (
    <div className="srp-kpi" style={{ '--kpi-color': color }}>
      <div className="srp-kpi-icon">{icon}</div>
      <div className="srp-kpi-body">
        <div className="srp-kpi-val">
          {loading ? <span className="srp-shimmer" style={{ width: 80 }} /> : value}
        </div>
        <div className="srp-kpi-lbl">{label}</div>
        {sub && <div className="srp-kpi-sub">{sub}</div>}
      </div>
    </div>
  );
}

/* ── Item row ────────────────────────────────────────────────── */
function ItemRow({ item }) {
  const isReturn = item.qty < 0 || item.total < 0;
  const avg = item.qty !== 0
    ? Math.abs(item.avgPrice != null ? item.avgPrice : item.total / item.qty)
    : null;
  return (
    <tr className={`srp-item-row${isReturn ? ' srp-return' : ''}`}>
      <td className="srp-td srp-td-item">
        <span className="srp-item-dot" style={{ background: typeColor(item.itemType) }} />
        {isReturn && <span className="srp-return-badge">↩ مرتجع</span>}
        {item.itemName}
      </td>
      <td className="srp-td srp-td-type">
        <span className="srp-type-badge" style={{ background: typeColor(item.itemType) + '22', color: typeColor(item.itemType) }}>
          {item.itemType || '—'}
        </span>
      </td>
      <td className="srp-td srp-td-num"><NetVal n={item.qty} isQty /></td>
      <td className="srp-td srp-td-num srp-td-total"><NetVal n={item.total} /></td>
      <td className="srp-td srp-td-num srp-td-avg">{avg != null ? fmtC(avg) : '—'}</td>
    </tr>
  );
}

/* ── Rep block ───────────────────────────────────────────────── */
function RepBlock({ rep, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <tr className="srp-rep-row" onClick={() => setOpen(v => !v)}>
        <td className="srp-td srp-td-rep" colSpan={2}>
          <span className="srp-toggle-btn">{open ? <ChevronDown size={13}/> : <ChevronLeft size={13}/>}</span>
          <span className="srp-rep-avatar">{rep.repName.charAt(0)}</span>
          {rep.repName}
          <span className="srp-rep-items-count">{rep.items.length} صنف</span>
        </td>
        <td className="srp-td srp-td-num srp-rep-num"><NetVal n={rep.qty} isQty /></td>
        <td className="srp-td srp-td-num srp-rep-num srp-td-total"><NetVal n={rep.total} /></td>
        <td className="srp-td srp-td-num srp-td-avg srp-rep-num">
          {rep.qty !== 0 ? fmtC(Math.abs(rep.avgPrice ?? 0)) : '—'}
        </td>
      </tr>
      {open && rep.items.map((item, i) => <ItemRow key={i} item={item} />)}
    </>
  );
}

/* ── Region block ────────────────────────────────────────────── */
function RegionBlock({ region, rank }) {
  const [open, setOpen] = useState(rank === 0);
  return (
    <>
      <tr className="srp-region-row" onClick={() => setOpen(v => !v)}>
        <td className="srp-td srp-region-name" colSpan={2}>
          <span className="srp-toggle-btn srp-toggle-btn--region">
            {open ? <ChevronDown size={15}/> : <ChevronLeft size={15}/>}
          </span>
          {rank === 0 && <span className="srp-crown">🏆</span>}
          📍 {region.regionName}
          <span className="srp-region-meta">{region.repsCount} مندوب</span>
        </td>
        <td className="srp-td srp-td-num srp-region-num"><NetVal n={region.qty} isQty bold /></td>
        <td className="srp-td srp-td-num srp-region-num srp-td-total"><NetVal n={region.total} bold /></td>
        <td className="srp-td srp-td-num srp-td-avg srp-region-num">
          {region.qty !== 0 ? <strong>{fmtC(Math.abs(region.avgPrice ?? 0))}</strong> : '—'}
        </td>
      </tr>
      {open && region.reps.map(rep => (
        <RepBlock key={rep.repName} rep={rep} defaultOpen={region.reps.length === 1} />
      ))}
    </>
  );
}

/* ── Performance Section ─────────────────────────────────────── */
function PerfSection({ regions }) {
  const [open, setOpen] = useState(true);

  const enriched = useMemo(() => regions.map(region => {
    const allItems   = region.reps.flatMap(r => r.items);
    const grossQty   = allItems.filter(i => i.qty   > 0).reduce((s,i) => s + i.qty,   0);
    const grossSales = allItems.filter(i => i.total > 0).reduce((s,i) => s + i.total, 0);
    const returnsAmt = Math.abs(allItems.filter(i => i.total < 0).reduce((s,i) => s + i.total, 0));
    const reps = region.reps.map(rep => {
      const pos = rep.items.filter(i => i.total > 0);
      const neg = rep.items.filter(i => i.total < 0);
      return {
        ...rep,
        grossSales:  pos.reduce((s,i) => s + i.total, 0),
        grossQty:    pos.reduce((s,i) => s + i.qty,   0),
        returns:     Math.abs(neg.reduce((s,i) => s + i.total, 0)),
        returnsQty:  Math.abs(neg.reduce((s,i) => s + i.qty,   0)),
      };
    });
    return { ...region, grossQty, grossSales, returns: returnsAmt, reps };
  }), [regions]);

  const bestByQty   = useMemo(() => [...enriched].sort((a,b) => b.grossQty   - a.grossQty  )[0], [enriched]);
  const bestByPrice = useMemo(() => [...enriched].filter(r => r.avgPrice > 0).sort((a,b) => b.avgPrice - a.avgPrice)[0], [enriched]);
  const maxRepGross = useMemo(() => Math.max(...enriched.flatMap(r => r.reps).map(r => r.grossSales), 1), [enriched]);

  if (!regions.length) return null;

  return (
    <div className="srp-perf-wrap">
      <div className="srp-perf-hdr" onClick={() => setOpen(v => !v)}>
        <span className="srp-perf-hdr-title"><BarChart2 size={16}/> مؤشر أداء المناديب بالمناطق</span>
        <span className="srp-perf-hdr-toggle">{open ? <ChevronDown size={15}/> : <ChevronLeft size={15}/>}</span>
      </div>

      {open && (
        <>
          <div className="srp-perf-highlights">
            {bestByQty && (
              <div className="srp-perf-hl srp-perf-hl--qty">
                <span className="srp-perf-hl-icon">🏆</span>
                <div>
                  <div className="srp-perf-hl-lbl">أفضل منطقة — الكمية</div>
                  <div className="srp-perf-hl-name">{bestByQty.regionName}</div>
                  <div className="srp-perf-hl-sub">{fmt(bestByQty.grossQty)} قطعة مُباعة</div>
                </div>
              </div>
            )}
            {bestByPrice && (
              <div className="srp-perf-hl srp-perf-hl--price">
                <span className="srp-perf-hl-icon">💰</span>
                <div>
                  <div className="srp-perf-hl-lbl">أفضل منطقة — متوسط السعر</div>
                  <div className="srp-perf-hl-name">{bestByPrice.regionName}</div>
                  <div className="srp-perf-hl-sub">{fmtC(bestByPrice.avgPrice)} ر.س / وحدة</div>
                </div>
              </div>
            )}
          </div>

          <div className="srp-perf-table-wrap">
            <table className="srp-perf-table">
              <thead>
                <tr className="srp-perf-thead">
                  <th className="srp-pth srp-pth-name">المندوب</th>
                  <th className="srp-pth srp-pth-num">المبيعات</th>
                  <th className="srp-pth srp-pth-num srp-pth-ret">المرتجعات</th>
                  <th className="srp-pth srp-pth-num srp-pth-net">الصافي</th>
                  <th className="srp-pth srp-pth-num">الكمية</th>
                  <th className="srp-pth srp-pth-num srp-pth-avg">متوسط السعر</th>
                  <th className="srp-pth srp-pth-bar">الأداء النسبي</th>
                </tr>
              </thead>
              <tbody>
                {enriched.map(region => (
                  <React.Fragment key={region.regionName}>
                    <tr className="srp-perf-region-sep">
                      <td colSpan={7}>
                        <span className="srp-perf-region-label">📍 {region.regionName}</span>
                        <span className="srp-perf-region-stat">{fmt(region.grossQty)} قطعة · {fmtC(region.grossSales)} ر.س</span>
                        {region.regionName === bestByQty?.regionName  && <span className="srp-perf-badge srp-perf-badge--qty">🏆 أعلى كمية</span>}
                        {region.regionName === bestByPrice?.regionName && <span className="srp-perf-badge srp-perf-badge--price">💰 أعلى سعر</span>}
                      </td>
                    </tr>
                    {region.reps.map(rep => {
                      const barPct   = Math.min(100, maxRepGross > 0 ? (rep.grossSales / maxRepGross) * 100 : 0);
                      const isNegRep = rep.total < 0;
                      return (
                        <tr key={`${region.regionName}-${rep.repName}`} className={`srp-perf-rep${isNegRep ? ' srp-perf-rep--neg' : ''}`}>
                          <td className="srp-ptd srp-ptd-name">
                            <span className="srp-perf-avatar">{rep.repName.charAt(0)}</span>
                            {rep.repName}
                          </td>
                          <td className="srp-ptd srp-ptd-num">{fmtC(rep.grossSales)}</td>
                          <td className="srp-ptd srp-ptd-num srp-ptd-ret">
                            {rep.returns > 0 ? <span className="srp-neg">−{fmtC(rep.returns)}</span> : <span className="srp-muted">—</span>}
                          </td>
                          <td className="srp-ptd srp-ptd-num srp-ptd-net"><NetVal n={rep.total} /></td>
                          <td className="srp-ptd srp-ptd-num"><NetVal n={rep.qty} isQty /></td>
                          <td className="srp-ptd srp-ptd-num srp-ptd-avg">
                            {rep.qty !== 0 ? fmtC(Math.abs(rep.avgPrice ?? 0)) : '—'}
                          </td>
                          <td className="srp-ptd srp-ptd-bar">
                            <div className="srp-perf-bar-row">
                              <div className="srp-perf-bar-track">
                                <div className="srp-perf-bar-fill" style={{
                                  width: `${barPct}%`,
                                  background: isNegRep ? '#dc2626' : barPct > 66 ? '#059669' : barPct > 33 ? '#d97706' : '#3b82f6',
                                }}/>
                              </div>
                              <span className="srp-perf-bar-pct">{barPct.toFixed(0)}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Sales Content (shared between tabs) ─────────────────────── */
function SalesContent({ period }) {
  const isMonthly  = period === 'monthly';
  const fetchFn    = isMonthly ? api.monthly        : api.today;
  const refreshFn  = isMonthly ? api.monthlyRefresh : api.todayRefresh;
  const queryKey   = isMonthly ? 'sales-report-monthly' : 'sales-report-today';

  const { user }     = useAuth();
  const isAdmin      = user && ADMIN_ROLES.includes(user.role);
  const isFullView   = user && FULL_VIEW_ROLES.includes(user.role);
  const queryClient  = useQueryClient();

  const [refreshing,       setRefreshing]       = useState(false);
  const [excludeWarehouse, setExcludeWarehouse] = useState(true);
  const [filterRegion,     setFilterRegion]     = useState('');
  const [filterMonth,      setFilterMonth]      = useState('');
  const [filterYear,       setFilterYear]       = useState('');

  /* ── Type filter (server-persisted, shared across all users) ── */
  const { data: savedTypes = [] } = useQuery({
    queryKey: ['sales-item-type-filter'],
    queryFn:  () => client.get(`/settings/${TYPE_FILTER_KEY}`)
                    .then(r => Array.isArray(r.data?.value) ? r.data.value : []),
    staleTime: Infinity,
  });

  const [typeFilterOpen, setTypeFilterOpen] = useState(false);
  const [draftTypes,     setDraftTypes]     = useState([]);
  const [typeSaving,     setTypeSaving]     = useState(false);
  const typeFilterRef = useRef(null);

  // Close panel on outside click
  useEffect(() => {
    if (!typeFilterOpen) return;
    function handleClick(e) {
      if (typeFilterRef.current && !typeFilterRef.current.contains(e.target)) {
        setTypeFilterOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [typeFilterOpen]);

  function openTypePanel() {
    setDraftTypes([...savedTypes]);
    setTypeFilterOpen(true);
  }

  function toggleDraftType(t) {
    setDraftTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  }

  async function saveTypeFilter() {
    setTypeSaving(true);
    try {
      await client.put(`/settings/${TYPE_FILTER_KEY}`, { value: draftTypes });
      queryClient.setQueryData(['sales-item-type-filter'], draftTypes);
    } finally {
      setTypeSaving(false);
      setTypeFilterOpen(false);
    }
  }

  async function resetTypeFilter() {
    setTypeSaving(true);
    try {
      await client.put(`/settings/${TYPE_FILTER_KEY}`, { value: [] });
      queryClient.setQueryData(['sales-item-type-filter'], []);
    } finally {
      setTypeSaving(false);
      setTypeFilterOpen(false);
    }
  }

  /* ── Region filter (server-persisted, admin-only) ───────────── */
  const { data: savedRegions = [] } = useQuery({
    queryKey: ['sales-region-filter'],
    queryFn:  () => client.get(`/settings/${REGION_FILTER_KEY}`)
                    .then(r => Array.isArray(r.data?.value) ? r.data.value : []),
    staleTime: Infinity,
  });

  const [regionFilterOpen, setRegionFilterOpen] = useState(false);
  const [draftRegions,     setDraftRegions]     = useState([]);
  const [regionSaving,     setRegionSaving]     = useState(false);
  const regionFilterRef = useRef(null);

  useEffect(() => {
    if (!regionFilterOpen) return;
    function handleClick(e) {
      if (regionFilterRef.current && !regionFilterRef.current.contains(e.target)) {
        setRegionFilterOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [regionFilterOpen]);

  function openRegionPanel() {
    setDraftRegions([...savedRegions]);
    setRegionFilterOpen(true);
  }

  function toggleDraftRegion(r) {
    setDraftRegions(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r]);
  }

  async function saveRegionFilter() {
    setRegionSaving(true);
    try {
      await client.put(`/settings/${REGION_FILTER_KEY}`, { value: draftRegions });
      queryClient.setQueryData(['sales-region-filter'], draftRegions);
    } finally {
      setRegionSaving(false);
      setRegionFilterOpen(false);
    }
  }

  async function resetRegionFilter() {
    setRegionSaving(true);
    try {
      await client.put(`/settings/${REGION_FILTER_KEY}`, { value: [] });
      queryClient.setQueryData(['sales-region-filter'], []);
    } finally {
      setRegionSaving(false);
      setRegionFilterOpen(false);
    }
  }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [queryKey],
    queryFn:  fetchFn,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await refreshFn(); await refetch(); }
    catch (_) { await refetch(); }
    finally { setRefreshing(false); }
  }, [refetch, refreshFn]);

  const handlePrint = useCallback(() => {
    const label = isMonthly ? 'الشهرية' : 'اليوم';
    const prev  = document.title;
    document.title = `تقرير المبيعات ${label} — ${new Date().toLocaleDateString('ar-SA', { year:'numeric', month:'long', day:'numeric' })}`;
    window.print();
    window.onafterprint = () => { document.title = prev; window.onafterprint = null; };
  }, [isMonthly]);

  const rawKpi     = data?.kpi     || {};
  const rawRegions = data?.regions || [];

  /* ── Step 1: warehouse filter ───────────────────────────────── */
  // Non-full-view users (supervisor/region_manager): always exclude warehouse
  // Full-view users (admin/manager): respect the toggle
  const shouldExcludeWarehouse = !isFullView || excludeWarehouse;
  const warehouseFiltered = useMemo(() =>
    shouldExcludeWarehouse
      ? rawRegions.filter(r => !r.regionName.includes('مخزن'))
      : rawRegions,
  [rawRegions, shouldExcludeWarehouse]);

  /* ── All available regions (for admin panel) ────────────────── */
  const allRegions = useMemo(() =>
    warehouseFiltered.map(r => r.regionName).sort(),
  [warehouseFiltered]);

  /* ── All available item types (for admin panel) ─────────────── */
  const allTypes = useMemo(() => {
    const set = new Set();
    warehouseFiltered.forEach(r => r.reps.forEach(rep =>
      rep.items.forEach(item => { if (item.itemType) set.add(item.itemType); })
    ));
    return [...set].sort();
  }, [warehouseFiltered]);

  /* ── Step 2: available filter options (from warehouse-filtered) */
  const filterOptions = useMemo(() => {
    const regionSet = new Set();
    const monthSet  = new Set();
    const yearSet   = new Set();
    warehouseFiltered.forEach(region => {
      regionSet.add(region.regionName);
      region.reps.forEach(rep => rep.items.forEach(item => {
        if (item.date) {
          const parts = item.date.split('/');
          if (parts.length === 3) {
            monthSet.add(Number(parts[1]));
            yearSet.add(Number(parts[2]));
          }
        }
      }));
    });
    return {
      regions: [...regionSet].sort(),
      months:  [...monthSet].sort((a,b) => a - b),
      years:   [...yearSet].sort((a,b) => a - b),
    };
  }, [warehouseFiltered]);

  const hasDateData    = filterOptions.months.length > 0;
  const hasActiveFilter = filterRegion || filterMonth || filterYear;

  /* ── Step 3: apply region + date filters ────────────────────── */
  const regions = useMemo(() => {
    let result = warehouseFiltered;

    // Saved-regions filter (server-persisted, admin-only — empty = show all)
    if (savedRegions.length > 0) {
      result = result.filter(r => savedRegions.includes(r.regionName));
    }

    // Per-session region dropdown filter
    if (filterRegion) result = result.filter(r => r.regionName === filterRegion);

    // Month / Year filter — rebuild aggregates per rep/region
    if (filterMonth || filterYear) {
      const m = filterMonth ? Number(filterMonth) : null;
      const y = filterYear  ? Number(filterYear)  : null;

      result = result.map(region => {
        const filteredReps = region.reps.map(rep => {
          const filteredItems = rep.items.filter(item => {
            if (!item.date) return true;
            const parts = item.date.split('/');
            if (parts.length !== 3) return true;
            const im = Number(parts[1]), iy = Number(parts[2]);
            if (m && im !== m) return false;
            if (y && iy !== y) return false;
            return true;
          });
          if (!filteredItems.length) return null;
          const rQty   = filteredItems.reduce((s,i) => s + i.qty,   0);
          const rTotal = filteredItems.reduce((s,i) => s + i.total, 0);
          return { ...rep, items: filteredItems, qty: rQty, total: rTotal,
            avgPrice: rQty !== 0 ? rTotal / Math.abs(rQty) : 0 };
        }).filter(Boolean);

        if (!filteredReps.length) return null;
        const rgQty   = filteredReps.reduce((s,r) => s + r.qty,   0);
        const rgTotal = filteredReps.reduce((s,r) => s + r.total, 0);
        return { ...region, reps: filteredReps, qty: rgQty, total: rgTotal,
          avgPrice: rgQty !== 0 ? rgTotal / Math.abs(rgQty) : 0,
          repsCount: filteredReps.length };
      }).filter(Boolean);
    }

    // Type filter — applied globally for all users (savedTypes empty = show all)
    if (savedTypes.length > 0) {
      result = result.map(region => {
        const filteredReps = region.reps.map(rep => {
          const filteredItems = rep.items.filter(item =>
            savedTypes.includes(item.itemType)
          );
          if (!filteredItems.length) return null;
          const rQty   = filteredItems.reduce((s,i) => s + i.qty,   0);
          const rTotal = filteredItems.reduce((s,i) => s + i.total, 0);
          return { ...rep, items: filteredItems, qty: rQty, total: rTotal,
            avgPrice: rQty !== 0 ? rTotal / Math.abs(rQty) : 0 };
        }).filter(Boolean);
        if (!filteredReps.length) return null;
        const rgQty   = filteredReps.reduce((s,r) => s + r.qty,   0);
        const rgTotal = filteredReps.reduce((s,r) => s + r.total, 0);
        return { ...region, reps: filteredReps, qty: rgQty, total: rgTotal,
          avgPrice: rgQty !== 0 ? rgTotal / Math.abs(rgQty) : 0,
          repsCount: filteredReps.length };
      }).filter(Boolean);
    }

    return result;
  }, [warehouseFiltered, savedRegions, filterRegion, filterMonth, filterYear, savedTypes]);

  /* ── Step 4: KPIs always reflect visible filtered regions ────── */
  const kpi = useMemo(() => {
    const allItems = regions.flatMap(r => r.reps.flatMap(p => p.items));
    const negItems = allItems.filter(i => i.total < 0);
    return {
      ...rawKpi,
      totalRevenue: allItems.reduce((s,i) => s + i.total, 0),
      totalQty:     allItems.reduce((s,i) => s + i.qty,   0),
      totalReturns: Math.abs(negItems.reduce((s,i) => s + i.total, 0)),
      regionsCount: regions.length,
      repsCount:    new Set(regions.flatMap(r => r.reps.map(p => p.repName))).size,
      topRegion:    regions[0]?.regionName || '—',
      topRep:       regions[0]?.reps[0]?.repName || '—',
    };
  }, [regions, rawKpi]);

  return (
    <div className="srp-tab-content">

      {/* Toolbar */}
      <div className="srp-toolbar srp-no-print">
        {/* Warehouse toggle — only for admin/manager roles with full regional view */}
        {isFullView && (
          <button
            className={`srp-btn srp-btn--toggle${excludeWarehouse ? ' srp-btn--toggle-active' : ''}`}
            onClick={() => setExcludeWarehouse(v => !v)}
            title={excludeWarehouse ? 'مخزن دجاج حي مستثنى' : 'اضغط لاستثناء مخزن دجاج حي'}
          >
            <EyeOff size={14}/>
            {excludeWarehouse ? 'مخزن دجاج حي: مستثنى' : 'مخزن دجاج حي: مُدرج'}
          </button>
        )}

        {/* Region filter button — admin sees edit panel, others see passive badge */}
        <div className="srp-type-filter-wrap" ref={regionFilterRef}>
          {isAdmin ? (
            <button
              className={`srp-btn srp-btn--region${savedRegions.length ? ' srp-btn--region-active' : ''}`}
              onClick={openRegionPanel}
            >
              <MapPin size={14}/>
              فلتر المناطق
              {savedRegions.length > 0 && (
                <span className="srp-type-badge-count">{savedRegions.length}</span>
              )}
            </button>
          ) : (
            savedRegions.length > 0 && (
              <span className="srp-type-passive-badge srp-type-passive-badge--region">
                <MapPin size={12}/> {savedRegions.length} منطقة مفعّلة
              </span>
            )
          )}

          {/* Multi-select panel (admin only) */}
          {regionFilterOpen && isAdmin && (
            <div className="srp-type-panel">
              <div className="srp-type-panel-hdr">
                <MapPin size={14}/>
                <span>اختر المناطق المعروضة</span>
                <button className="srp-type-panel-close" onClick={() => setRegionFilterOpen(false)}>
                  <X size={14}/>
                </button>
              </div>
              <p className="srp-type-panel-hint">يُطبَّق على جميع المستخدمين · فارغ = الكل</p>

              <div className="srp-type-list">
                <label className="srp-type-item srp-type-item--all">
                  <input
                    type="checkbox"
                    checked={draftRegions.length === 0}
                    onChange={() => setDraftRegions([])}
                    className="srp-type-checkbox"
                  />
                  <span className="srp-type-label">الكل (بدون فلتر)</span>
                </label>
                <div className="srp-type-divider"/>
                {allRegions.map(reg => (
                  <label key={reg} className="srp-type-item">
                    <input
                      type="checkbox"
                      checked={draftRegions.includes(reg)}
                      onChange={() => toggleDraftRegion(reg)}
                      className="srp-type-checkbox"
                    />
                    <span className="srp-type-dot" style={{ background: '#7c3aed' }}/>
                    <span className="srp-type-label">📍 {reg}</span>
                  </label>
                ))}
              </div>

              <div className="srp-type-panel-footer">
                <button className="srp-type-save" onClick={saveRegionFilter} disabled={regionSaving}>
                  <Check size={13}/> {regionSaving ? 'جارٍ الحفظ…' : 'حفظ للجميع'}
                </button>
                <button className="srp-type-reset" onClick={resetRegionFilter} disabled={regionSaving}>
                  إظهار الكل
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Type filter button — admin sees edit panel, others see passive badge */}
        <div className="srp-type-filter-wrap" ref={typeFilterRef}>
          {isAdmin ? (
            <button
              className={`srp-btn srp-btn--type${savedTypes.length ? ' srp-btn--type-active' : ''}`}
              onClick={openTypePanel}
            >
              <SlidersHorizontal size={14}/>
              فلتر النوع
              {savedTypes.length > 0 && (
                <span className="srp-type-badge-count">{savedTypes.length}</span>
              )}
            </button>
          ) : (
            savedTypes.length > 0 && (
              <span className="srp-type-passive-badge">
                <SlidersHorizontal size={12}/> {savedTypes.length} نوع مفعّل
              </span>
            )
          )}

          {/* Multi-select panel (admin only) */}
          {typeFilterOpen && isAdmin && (
            <div className="srp-type-panel">
              <div className="srp-type-panel-hdr">
                <SlidersHorizontal size={14}/>
                <span>اختر الأنواع المعروضة</span>
                <button className="srp-type-panel-close" onClick={() => setTypeFilterOpen(false)}>
                  <X size={14}/>
                </button>
              </div>
              <p className="srp-type-panel-hint">يُطبَّق على جميع المستخدمين · فارغ = الكل</p>

              <div className="srp-type-list">
                {/* Select All / Clear All */}
                <label className="srp-type-item srp-type-item--all">
                  <input
                    type="checkbox"
                    checked={draftTypes.length === 0}
                    onChange={() => setDraftTypes([])}
                    className="srp-type-checkbox"
                  />
                  <span className="srp-type-label">الكل (بدون فلتر)</span>
                </label>
                <div className="srp-type-divider"/>
                {allTypes.map(t => (
                  <label key={t} className="srp-type-item">
                    <input
                      type="checkbox"
                      checked={draftTypes.includes(t)}
                      onChange={() => toggleDraftType(t)}
                      className="srp-type-checkbox"
                    />
                    <span className="srp-type-dot" style={{ background: typeColor(t) }}/>
                    <span className="srp-type-label">{t || '—'}</span>
                  </label>
                ))}
              </div>

              <div className="srp-type-panel-footer">
                <button className="srp-type-save" onClick={saveTypeFilter} disabled={typeSaving}>
                  <Check size={13}/> {typeSaving ? 'جارٍ الحفظ…' : 'حفظ للجميع'}
                </button>
                <button className="srp-type-reset" onClick={resetTypeFilter} disabled={typeSaving}>
                  إظهار الكل
                </button>
              </div>
            </div>
          )}
        </div>

        <button className="srp-btn srp-btn--refresh" onClick={handleRefresh} disabled={refreshing || isLoading}>
          <RefreshCw size={14} className={refreshing ? 'srp-spin' : ''}/>
          {refreshing ? 'جارٍ التحديث…' : 'تحديث'}
        </button>
        <button className="srp-btn srp-btn--print" onClick={handlePrint}>
          <Printer size={14}/> PDF
        </button>
      </div>

      {/* Error */}
      {error && <div className="srp-error">⚠️ تعذّر الاتصال بـ NetSuite — يتم عرض آخر بيانات محفوظة.</div>}

      {/* Date range badge — monthly only */}
      {isMonthly && rawKpi.dateRange && (
        <div className="srp-date-range srp-no-print">
          📅 نطاق البيانات: <strong>{rawKpi.dateRange.from}</strong> — <strong>{rawKpi.dateRange.to}</strong>
        </div>
      )}

      {/* Filters */}
      {!isLoading && (filterOptions.regions.length > 1 || hasDateData) && (
        <div className="srp-filters srp-no-print">
          {/* Region */}
          {filterOptions.regions.length > 1 && (
            <div className="srp-filter-group">
              <label className="srp-filter-label">📍 المنطقة</label>
              <select className="srp-filter-select" value={filterRegion} onChange={e => setFilterRegion(e.target.value)}>
                <option value="">الكل</option>
                {filterOptions.regions.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          )}

          {/* Month — only if date data exists */}
          {hasDateData && (
            <div className="srp-filter-group">
              <label className="srp-filter-label">🗓 الشهر</label>
              <select className="srp-filter-select" value={filterMonth} onChange={e => setFilterMonth(e.target.value)}>
                <option value="">الكل</option>
                {filterOptions.months.map(m => (
                  <option key={m} value={m}>{MONTH_NAMES[m] || m}</option>
                ))}
              </select>
            </div>
          )}

          {/* Year — only if date data exists */}
          {hasDateData && filterOptions.years.length > 1 && (
            <div className="srp-filter-group">
              <label className="srp-filter-label">📆 السنة</label>
              <select className="srp-filter-select" value={filterYear} onChange={e => setFilterYear(e.target.value)}>
                <option value="">الكل</option>
                {filterOptions.years.map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
          )}

          {/* Reset */}
          {hasActiveFilter && (
            <button className="srp-filter-reset" onClick={() => { setFilterRegion(''); setFilterMonth(''); setFilterYear(''); }}>
              ✕ إعادة تعيين
            </button>
          )}

          {/* Active count */}
          {hasActiveFilter && (
            <span className="srp-filter-count">
              {regions.length} منطقة · {regions.reduce((s,r) => s + r.repsCount, 0)} مندوب
            </span>
          )}
        </div>
      )}

      {/* KPIs */}
      <div className="srp-kpi-row">
        <KpiCard icon={<TrendingUp size={20}/>} label="إجمالي المبيعات (صافي)"
          value={isLoading ? undefined : (kpi.totalRevenue ?? 0) < 0
            ? <span className="srp-neg">{fmtC(Math.abs(kpi.totalRevenue))} ر.س −</span>
            : `${fmtC(kpi.totalRevenue ?? 0)} ر.س`}
          color="#1d4ed8" loading={isLoading} />
        <KpiCard icon={<Package size={20}/>} label="إجمالي الكميات (صافي)"
          value={isLoading ? undefined : (kpi.totalQty ?? 0) < 0
            ? <span className="srp-neg">{fmt(Math.abs(kpi.totalQty))} قطعة −</span>
            : `${fmt(kpi.totalQty ?? 0)} قطعة`}
          color="#059669" loading={isLoading} />
        <KpiCard icon={<MapPin size={20}/>} label="عدد المناطق"
          value={kpi.regionsCount || '—'} sub={kpi.topRegion ? `الأفضل: ${kpi.topRegion}` : undefined}
          color="#7c3aed" loading={isLoading} />
        <KpiCard icon={<Users size={20}/>} label="عدد المناديب"
          value={kpi.repsCount || '—'} sub={kpi.topRep ? `الأعلى: ${kpi.topRep}` : undefined}
          color="#0891b2" loading={isLoading} />
        <KpiCard icon={<RotateCcw size={20}/>} label="المرتجعات"
          value={`${fmtC(kpi.totalReturns)} ر.س`} color="#dc2626" loading={isLoading} />
        <KpiCard icon={<Award size={20}/>} label="متوسط المبيعات / مندوب"
          value={kpi.repsCount ? `${fmtC((kpi.totalRevenue||0) / kpi.repsCount)} ر.س` : '—'}
          color="#d97706" loading={isLoading} />
      </div>

      {/* Matrix Table */}
      <div className="srp-table-wrap">
        {isLoading ? (
          <div className="srp-loading"><RefreshCw size={24} className="srp-spin"/><span>جارٍ تحميل البيانات من NetSuite…</span></div>
        ) : regions.length === 0 ? (
          <div className="srp-empty">لا توجد بيانات متاحة</div>
        ) : (
          <table className="srp-table">
            <thead>
              <tr className="srp-thead-row">
                <th className="srp-th srp-th-name">المنطقة / المندوب / الصنف</th>
                <th className="srp-th srp-th-type">النوع</th>
                <th className="srp-th srp-th-num">الكمية</th>
                <th className="srp-th srp-th-num srp-th-total">الإجمالي (ر.س)</th>
                <th className="srp-th srp-th-num srp-th-avg">متوسط السعر</th>
              </tr>
            </thead>
            <tbody>
              {regions.map((region, i) => <RegionBlock key={region.regionName} region={region} rank={i} />)}
            </tbody>
            <tfoot>
              <tr className="srp-tfoot-row">
                <td className="srp-td" colSpan={2}><strong>الإجمالي الكلي (صافي)</strong></td>
                <td className="srp-td srp-td-num"><NetVal n={regions.reduce((s,r)=>s+r.qty,0)} isQty bold /></td>
                <td className="srp-td srp-td-num srp-td-total">
                  <NetVal n={regions.reduce((s,r)=>s+r.total,0)} bold />
                  <span className="srp-tfoot-unit"> ر.س</span>
                </td>
                <td className="srp-td srp-td-num srp-td-avg">
                  <strong>{kpi.totalQty ? fmtC(kpi.totalRevenue / Math.abs(kpi.totalQty)) : '—'}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Performance Section */}
      {!isLoading && regions.length > 0 && <PerfSection regions={regions} />}

    </div>
  );
}

/* ── Main Page ───────────────────────────────────────────────── */
export default function SalesReportPage() {
  const [activeTab, setActiveTab] = useState('today');

  return (
    <div className="srp-page">

      {/* Print header */}
      <div className="srp-print-header">
        <span>📊</span>
        <span>تقرير المبيعات — {activeTab === 'monthly' ? 'الشهرية' : 'اليوم'}</span>
        <span>{new Date().toLocaleDateString('ar-SA',{year:'numeric',month:'long',day:'numeric',weekday:'long'})}</span>
      </div>

      {/* Page header */}
      <div className="srp-header srp-no-print">
        <div>
          <h1 className="srp-title">📊 تقرير المبيعات</h1>
          <p className="srp-subtitle">بيانات مباشرة من NetSuite — مبيعات المناديب حسب المنطقة</p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="srp-tabs srp-no-print">
        <button
          className={`srp-tab${activeTab === 'today' ? ' srp-tab--active' : ''}`}
          onClick={() => setActiveTab('today')}
        >
          <CalendarDays size={15}/>
          المبيعات اليوم
        </button>
        <button
          className={`srp-tab${activeTab === 'monthly' ? ' srp-tab--active' : ''}`}
          onClick={() => setActiveTab('monthly')}
        >
          <Calendar size={15}/>
          المبيعات الشهرية
        </button>
      </div>

      {/* Tab content — key forces remount on tab switch to reset state */}
      {activeTab === 'today'   && <SalesContent key="today"   period="today"   />}
      {activeTab === 'monthly' && <SalesContent key="monthly" period="monthly" />}

    </div>
  );
}
