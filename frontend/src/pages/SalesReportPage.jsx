import React, { useState, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, ChevronDown, ChevronLeft, Printer, TrendingUp, Users, MapPin, Package, RotateCcw, Award, EyeOff } from 'lucide-react';
import client from '../api/client';
import './SalesReportPage.css';

/* ── Warehouse region name to exclude ───────────────────────── */
const WAREHOUSE_NAME = 'مخزن دجاج حي';

/* ── API ─────────────────────────────────────────────────────── */
const fetchReport  = () => client.get('/sales-report').then(r => r.data);
const refreshReport = () => client.get('/sales-report/refresh').then(r => r.data);

/* ── Formatters ─────────────────────────────────────────────── */
const fmt  = (n) => (n ?? 0).toLocaleString('en-SA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtC = (n) => (n ?? 0).toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ── Signed cell — negative shows red with − prefix ─────────── */
function NetVal({ n, isQty = false, bold = false }) {
  const abs = Math.abs(n ?? 0);
  const str = isQty ? fmt(abs) : fmtC(abs);
  if ((n ?? 0) < 0) return <span className={`srp-neg${bold ? ' srp-bold' : ''}`}>−{str}</span>;
  if ((n ?? 0) === 0) return <span className={bold ? 'srp-bold' : ''}>—</span>;
  return <span className={bold ? 'srp-bold' : ''}>{str}</span>;
}

/* ── Item type badge color ──────────────────────────────────── */
const typeColor = (t = '') => {
  if (t.includes('مقطع'))  return '#8b5cf6';
  if (t.includes('GB'))    return '#0ea5e9';
  if (t.includes('حية'))   return '#f59e0b';
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

/* ── Item row inside a rep ───────────────────────────────────── */
function ItemRow({ item }) {
  const isReturn = item.qty < 0 || item.total < 0;
  const avg = item.qty !== 0
    ? Math.abs((item.avgPrice != null ? item.avgPrice : item.total / item.qty))
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
      <td className="srp-td srp-td-num srp-td-avg">
        {avg != null ? fmtC(avg) : '—'}
      </td>
    </tr>
  );
}

/* ── Sales Rep block ─────────────────────────────────────────── */
function RepBlock({ rep, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <tr className="srp-rep-row" onClick={() => setOpen(v => !v)}>
        <td className="srp-td srp-td-rep" colSpan={2}>
          <span className="srp-toggle-btn">
            {open ? <ChevronDown size={13}/> : <ChevronLeft size={13}/>}
          </span>
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
      {/* Region header row */}
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

      {/* Reps */}
      {open && region.reps.map((rep) => (
        <RepBlock key={rep.repName} rep={rep} defaultOpen={region.reps.length === 1} />
      ))}
    </>
  );
}

/* ── Main Page ───────────────────────────────────────────────── */
export default function SalesReportPage() {
  const [refreshing,       setRefreshing]       = useState(false);
  const [excludeWarehouse, setExcludeWarehouse] = useState(true); // ON by default

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['sales-report'],
    queryFn:  fetchReport,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await refreshReport(); await refetch(); }
    catch (_) { await refetch(); }
    finally { setRefreshing(false); }
  }, [refetch]);

  const handlePrint = useCallback(() => {
    const prev = document.title;
    document.title = `تقرير المبيعات — ${new Date().toLocaleDateString('ar-SA', { year:'numeric', month:'long', day:'numeric' })}`;
    window.print();
    window.onafterprint = () => { document.title = prev; window.onafterprint = null; };
  }, []);

  const rawKpi     = data?.kpi     || {};
  const rawRegions = data?.regions || [];

  /* ── Apply warehouse filter client-side ─────────────────────── */
  const regions = useMemo(() =>
    excludeWarehouse
      ? rawRegions.filter(r => r.regionName !== WAREHOUSE_NAME)
      : rawRegions,
  [rawRegions, excludeWarehouse]);

  /* ── Recompute KPIs from visible regions ─────────────────────── */
  const kpi = useMemo(() => {
    if (!excludeWarehouse) return rawKpi;
    // Flatten all items from visible regions
    const allItems = regions.flatMap(r => r.reps.flatMap(p => p.items));
    const posItems = allItems.filter(i => i.qty  > 0);
    const negItems = allItems.filter(i => i.total < 0);
    const totalRevenue = posItems.reduce((s,i) => s + i.total, 0);
    const totalQty     = posItems.reduce((s,i) => s + i.qty,   0);
    const totalReturns = Math.abs(negItems.reduce((s,i) => s + i.total, 0));
    const allReps      = new Set(regions.flatMap(r => r.reps.map(p => p.repName)));
    return {
      ...rawKpi,
      totalRevenue,
      totalQty,
      totalReturns,
      regionsCount: regions.length,
      repsCount:    allReps.size,
      topRegion:    regions[0]?.regionName || '—',
      topRep:       regions[0]?.reps[0]?.repName || '—',
    };
  }, [regions, rawKpi, excludeWarehouse]);

  return (
    <div className="srp-page">

      {/* Print header */}
      <div className="srp-print-header">
        <span>📊</span>
        <span>تقرير المبيعات</span>
        <span>{new Date().toLocaleDateString('ar-SA',{year:'numeric',month:'long',day:'numeric',weekday:'long'})}</span>
      </div>

      {/* Page header */}
      <div className="srp-header srp-no-print">
        <div>
          <h1 className="srp-title">📊 تقرير المبيعات</h1>
          <p className="srp-subtitle">بيانات مباشرة من NetSuite — مبيعات المناديب حسب المنطقة</p>
        </div>
        <div className="srp-header-actions">
          <button
            className={`srp-btn srp-btn--toggle srp-no-print${excludeWarehouse ? ' srp-btn--toggle-active' : ''}`}
            onClick={() => setExcludeWarehouse(v => !v)}
            title={excludeWarehouse ? 'مخزن دجاج حي مستثنى — اضغط لإظهاره' : 'اضغط لاستثناء مخزن دجاج حي'}
          >
            <EyeOff size={14} />
            {excludeWarehouse ? 'مخزن دجاج حي: مستثنى' : 'مخزن دجاج حي: مُدرج'}
          </button>
          <button className="srp-btn srp-btn--refresh srp-no-print" onClick={handleRefresh} disabled={refreshing || isLoading}>
            <RefreshCw size={14} className={refreshing ? 'srp-spin' : ''} />
            {refreshing ? 'جارٍ التحديث…' : 'تحديث'}
          </button>
          <button className="srp-btn srp-btn--print srp-no-print" onClick={handlePrint}>
            <Printer size={14} /> PDF
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="srp-error">
          ⚠️ تعذّر الاتصال بـ NetSuite — يتم عرض آخر بيانات محفوظة.
        </div>
      )}

      {/* KPI Row */}
      <div className="srp-kpi-row">
        <KpiCard
          icon={<TrendingUp size={20}/>}
          label="إجمالي المبيعات"
          value={`${fmtC(kpi.totalRevenue)} ر.س`}
          color="#1d4ed8"
          loading={isLoading}
        />
        <KpiCard
          icon={<Package size={20}/>}
          label="إجمالي الكميات"
          value={`${fmt(kpi.totalQty)} قطعة`}
          color="#059669"
          loading={isLoading}
        />
        <KpiCard
          icon={<MapPin size={20}/>}
          label="عدد المناطق"
          value={kpi.regionsCount || '—'}
          sub={kpi.topRegion ? `الأفضل: ${kpi.topRegion}` : undefined}
          color="#7c3aed"
          loading={isLoading}
        />
        <KpiCard
          icon={<Users size={20}/>}
          label="عدد المناديب"
          value={kpi.repsCount || '—'}
          sub={kpi.topRep ? `الأعلى: ${kpi.topRep}` : undefined}
          color="#0891b2"
          loading={isLoading}
        />
        <KpiCard
          icon={<RotateCcw size={20}/>}
          label="المرتجعات"
          value={`${fmtC(kpi.totalReturns)} ر.س`}
          color="#dc2626"
          loading={isLoading}
        />
        <KpiCard
          icon={<Award size={20}/>}
          label="متوسط المبيعات / مندوب"
          value={kpi.repsCount ? `${fmtC((kpi.totalRevenue||0) / kpi.repsCount)} ر.س` : '—'}
          color="#d97706"
          loading={isLoading}
        />
      </div>

      {/* Matrix Table */}
      <div className="srp-table-wrap">
        {isLoading ? (
          <div className="srp-loading">
            <RefreshCw size={24} className="srp-spin" />
            <span>جارٍ تحميل البيانات من NetSuite…</span>
          </div>
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
              {regions.map((region, i) => (
                <RegionBlock key={region.regionName} region={region} rank={i} />
              ))}
            </tbody>

            {/* Grand total footer */}
            <tfoot>
              <tr className="srp-tfoot-row">
                <td className="srp-td" colSpan={2}><strong>الإجمالي الكلي (صافي)</strong></td>
                <td className="srp-td srp-td-num">
                  <NetVal n={regions.reduce((s,r)=>s+r.qty,0)} isQty bold />
                </td>
                <td className="srp-td srp-td-num srp-td-total">
                  <NetVal n={regions.reduce((s,r)=>s+r.total,0)} bold />
                  <span className="srp-tfoot-unit"> ر.س</span>
                </td>
                <td className="srp-td srp-td-num srp-td-avg">
                  <strong>{kpi.totalQty ? fmtC(kpi.totalRevenue / kpi.totalQty) : '—'}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

    </div>
  );
}
