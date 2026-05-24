import React, { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, ChevronDown, ChevronLeft, Printer, TrendingUp, Users, MapPin, Package, RotateCcw, Award } from 'lucide-react';
import client from '../api/client';
import './SalesReportPage.css';

/* ── API ─────────────────────────────────────────────────────── */
const fetchReport  = () => client.get('/sales-report').then(r => r.data);
const refreshReport = () => client.get('/sales-report/refresh').then(r => r.data);

/* ── Formatters ─────────────────────────────────────────────── */
const fmt  = (n) => (n ?? 0).toLocaleString('en-SA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtC = (n) => (n ?? 0).toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  return (
    <tr className={`srp-item-row${isReturn ? ' srp-return' : ''}`}>
      <td className="srp-td srp-td-item">
        <span className="srp-item-dot" style={{ background: typeColor(item.itemType) }} />
        {item.itemName}
      </td>
      <td className="srp-td srp-td-type">
        <span className="srp-type-badge" style={{ background: typeColor(item.itemType) + '22', color: typeColor(item.itemType) }}>
          {item.itemType || '—'}
        </span>
      </td>
      <td className="srp-td srp-td-num">{isReturn ? '↩' : ''}{fmt(Math.abs(item.qty))}</td>
      <td className="srp-td srp-td-num srp-td-total">
        {isReturn ? <span className="srp-neg">−{fmtC(Math.abs(item.total))}</span>
                  : fmtC(item.total)}
      </td>
      <td className="srp-td srp-td-num srp-td-avg">
        {item.qty !== 0 ? fmtC(Math.abs(item.avgPrice ?? (item.total / item.qty))) : '—'}
      </td>
    </tr>
  );
}

/* ── Sales Rep block ─────────────────────────────────────────── */
function RepBlock({ rep, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const isNeg = rep.total < 0;
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
        <td className="srp-td srp-td-num srp-rep-num">{fmt(Math.abs(rep.qty))}</td>
        <td className="srp-td srp-td-num srp-rep-num srp-td-total">
          {isNeg
            ? <span className="srp-neg">−{fmtC(Math.abs(rep.total))}</span>
            : fmtC(rep.total)}
        </td>
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
  const [open, setOpen] = useState(rank === 0); // first region open by default

  const isNeg = region.total < 0;

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
          <span className="srp-region-meta">
            {region.repsCount} مندوب
          </span>
        </td>
        <td className="srp-td srp-td-num srp-region-num">{fmt(Math.abs(region.qty))}</td>
        <td className="srp-td srp-td-num srp-region-num srp-td-total">
          {isNeg
            ? <span className="srp-neg">−{fmtC(Math.abs(region.total))}</span>
            : fmtC(region.total)}
        </td>
        <td className="srp-td srp-td-num srp-td-avg srp-region-num">
          {region.qty !== 0 ? fmtC(Math.abs(region.avgPrice ?? 0)) : '—'}
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
  const [refreshing, setRefreshing] = useState(false);
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

  const kpi     = data?.kpi     || {};
  const regions = data?.regions || [];

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
                <td className="srp-td" colSpan={2}><strong>الإجمالي الكلي</strong></td>
                <td className="srp-td srp-td-num"><strong>{fmt(kpi.totalQty)}</strong></td>
                <td className="srp-td srp-td-num srp-td-total"><strong>{fmtC(kpi.totalRevenue)} ر.س</strong></td>
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
