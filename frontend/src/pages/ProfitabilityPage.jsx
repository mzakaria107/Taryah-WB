import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  TrendingUp, RefreshCw, ChevronDown, ChevronLeft,
  AlertCircle, Clock, DollarSign, BarChart2, Percent, Package,
} from 'lucide-react';
import client from '../api/client';
import './ProfitabilityPage.css';

/* ── Number formatters ─────────────────────────────────────── */
function fmtNum(v, decimals = 2) {
  if (v === null || v === undefined) return '—';
  return Number(v).toLocaleString('en-SA', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
function fmtQty(v) {
  if (v === null || v === undefined) return '—';
  return Number(v).toLocaleString('en-SA', { maximumFractionDigits: 0 });
}
function fmtPct(v) {
  if (v === null || v === undefined) return '—';
  return Number(v).toFixed(2) + '%';
}
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ar-SA', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/* ── GP% color class ──────────────────────────────────────── */
function gpClass(pct) {
  if (pct === null || pct === undefined) return '';
  if (pct >= 20)  return 'prf-gp-high';
  if (pct >= 10)  return 'prf-gp-mid';
  if (pct >= 0)   return 'prf-gp-low';
  return 'prf-gp-neg';
}

/* ── Summary Card ─────────────────────────────────────────── */
function KpiCard({ label, value, icon, cls }) {
  return (
    <div className={`prf-kpi ${cls || ''}`}>
      <div className="prf-kpi-icon">{icon}</div>
      <div>
        <div className="prf-kpi-val">{value}</div>
        <div className="prf-kpi-lbl">{label}</div>
      </div>
    </div>
  );
}

/* ── Data Row ─────────────────────────────────────────────── */
function DataRow({ row, isGroup, isExpanded, onToggle, depth = 0 }) {
  const gp = row.grossProfitPct;

  return (
    <tr
      className={`prf-row ${isGroup ? 'prf-group-row' : 'prf-item-row'} ${isExpanded ? 'prf-expanded' : ''}`}
      onClick={isGroup ? onToggle : undefined}
      style={isGroup ? { cursor: 'pointer' } : {}}
    >
      {/* ITEM */}
      <td className="prf-td-item" style={{ paddingRight: `${14 + depth * 20}px` }}>
        {isGroup && (
          <span className="prf-expand-btn">
            {isExpanded ? <ChevronDown size={14}/> : <ChevronLeft size={14}/>}
          </span>
        )}
        <span className={isGroup ? 'prf-group-label' : 'prf-item-label'}>
          {row.item || '—'}
        </span>
      </td>
      {/* DESCRIPTION */}
      <td className="prf-td-desc">{row.description || (isGroup ? '' : '—')}</td>
      {/* QTY */}
      <td className="prf-td-num">{fmtQty(row.qty)}</td>
      {/* TOTAL COST */}
      <td className="prf-td-num">{fmtNum(row.totalCost)}</td>
      {/* TOTAL REVENUE */}
      <td className="prf-td-num prf-revenue">{fmtNum(row.totalRevenue)}</td>
      {/* % OF TOTAL */}
      <td className="prf-td-num">{fmtPct(row.pctRevenue)}</td>
      {/* AVG COST */}
      <td className="prf-td-num">{fmtNum(row.avgCost)}</td>
      {/* AVG PRICE */}
      <td className="prf-td-num">{fmtNum(row.avgPrice)}</td>
      {/* GROSS PROFIT */}
      <td className={`prf-td-num prf-profit ${gpClass(gp)}`}>{fmtNum(row.grossProfit)}</td>
      {/* GROSS PROFIT % */}
      <td className={`prf-td-num prf-pct-cell ${gpClass(gp)}`}>{fmtPct(gp)}</td>
    </tr>
  );
}

/* ══════════════════════════════════════════════════════════════
   PAGE
   ══════════════════════════════════════════════════════════════ */
export default function ProfitabilityPage() {
  const [expanded, setExpanded] = useState({});

  const toggleGroup = (type) =>
    setExpanded(prev => ({ ...prev, [type]: !prev[type] }));

  const expandAll  = (groups) => {
    const m = {};
    groups.forEach(g => { m[g.type] = true; });
    setExpanded(m);
  };
  const collapseAll = () => setExpanded({});

  /* ── Fetch ── */
  const [forceRefresh, setForceRefresh] = useState(false);

  const {
    data, isLoading, isError, error, isFetching, refetch,
  } = useQuery({
    queryKey: ['profitability', forceRefresh],
    queryFn:  () => client.get(`/profitability${forceRefresh ? '?refresh=1' : ''}`).then(r => r.data),
    staleTime: 14 * 60 * 1000,
    retry: 1,
  });

  const handleRefresh = () => {
    setForceRefresh(true);
    setTimeout(() => setForceRefresh(false), 500);
  };

  const groups = data?.groups ?? [];
  const total  = data?.total  ?? null;

  /* ── KPI summary from total row or computed ── */
  const kpi = useMemo(() => {
    const src = total || (groups.length ? {
      totalRevenue: groups.reduce((s, g) => s + (g.summary?.totalRevenue || 0), 0),
      totalCost:    groups.reduce((s, g) => s + (g.summary?.totalCost    || 0), 0),
      grossProfit:  groups.reduce((s, g) => s + (g.summary?.grossProfit  || 0), 0),
      qty:          groups.reduce((s, g) => s + (g.summary?.qty          || 0), 0),
    } : {});

    const rev  = src.totalRevenue || 0;
    const cost = src.totalCost    || 0;
    const gp   = src.grossProfit  ?? (rev - cost);
    const margin = rev > 0 ? (gp / rev) * 100 : null;
    return {
      revenue: rev,
      cost,
      grossProfit: gp,
      margin,
      qty: src.qty || 0,
    };
  }, [total, groups]);

  /* ── Loading state ── */
  if (isLoading) {
    return (
      <div className="prf-page">
        <div className="prf-header">
          <div>
            <h1 className="prf-title"><TrendingUp size={20}/> الربحية</h1>
            <p className="prf-subtitle">تقرير ربحية المنتجات من NetSuite</p>
          </div>
        </div>
        <div className="prf-loading">
          <RefreshCw size={24} className="prf-spin"/>
          <span>جاري جلب البيانات من NetSuite…</span>
        </div>
      </div>
    );
  }

  /* ── Error state ── */
  if (isError && !data) {
    return (
      <div className="prf-page">
        <div className="prf-header">
          <h1 className="prf-title"><TrendingUp size={20}/> الربحية</h1>
        </div>
        <div className="prf-error">
          <AlertCircle size={20}/>
          <span>{error?.response?.data?.error || 'تعذّر جلب البيانات من NetSuite'}</span>
          <button className="prf-refresh-btn" onClick={() => refetch()}>
            <RefreshCw size={14}/> إعادة المحاولة
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="prf-page">

      {/* ── Header ── */}
      <div className="prf-header">
        <div>
          <h1 className="prf-title"><TrendingUp size={20}/> الربحية</h1>
          <p className="prf-subtitle">تقرير ربحية المنتجات من NetSuite</p>
        </div>
        <div className="prf-header-actions">
          {data?.fetchedAt && (
            <span className="prf-fetch-time">
              <Clock size={12}/>
              {data.stale ? 'بيانات مؤقتة — ' : (data.fromCache ? 'مخزّن — ' : 'محدّث — ')}
              {fmtTime(data.fetchedAt)}
            </span>
          )}
          <button
            className={`prf-refresh-btn${isFetching ? ' prf-fetching' : ''}`}
            onClick={handleRefresh}
            disabled={isFetching}
          >
            <RefreshCw size={14} className={isFetching ? 'prf-spin' : ''}/>
            {isFetching ? 'جاري التحديث…' : 'تحديث البيانات'}
          </button>
        </div>
      </div>

      {/* ── KPI Cards ── */}
      <div className="prf-kpi-row">
        <KpiCard
          label="إجمالي الإيرادات"
          value={`ر.س ${fmtNum(kpi.revenue)}`}
          icon={<DollarSign size={18}/>}
          cls="prf-kpi-revenue"
        />
        <KpiCard
          label="إجمالي التكلفة"
          value={`ر.س ${fmtNum(kpi.cost)}`}
          icon={<BarChart2 size={18}/>}
          cls="prf-kpi-cost"
        />
        <KpiCard
          label="إجمالي الربح الإجمالي"
          value={`ر.س ${fmtNum(kpi.grossProfit)}`}
          icon={<TrendingUp size={18}/>}
          cls="prf-kpi-profit"
        />
        <KpiCard
          label="هامش الربح الإجمالي"
          value={fmtPct(kpi.margin)}
          icon={<Percent size={18}/>}
          cls={`prf-kpi-margin ${gpClass(kpi.margin)}`}
        />
        <KpiCard
          label="إجمالي الكمية"
          value={fmtQty(kpi.qty)}
          icon={<Package size={18}/>}
          cls="prf-kpi-qty"
        />
      </div>

      {/* ── Table card ── */}
      <div className="prf-card">
        {/* Expand/collapse controls */}
        {groups.length > 0 && (
          <div className="prf-table-controls">
            <button className="prf-ctrl-btn" onClick={() => expandAll(groups)}>توسيع الكل</button>
            <button className="prf-ctrl-btn" onClick={collapseAll}>طي الكل</button>
          </div>
        )}

        <div className="prf-table-wrap">
          <table className="prf-table">
            <thead>
              <tr>
                <th className="prf-th-item">الصنف</th>
                <th className="prf-th-desc">الوصف</th>
                <th className="prf-th-num">الكمية المباعة</th>
                <th className="prf-th-num">إجمالي التكلفة</th>
                <th className="prf-th-num">إجمالي الإيرادات</th>
                <th className="prf-th-num">% من الإيرادات</th>
                <th className="prf-th-num">متوسط التكلفة</th>
                <th className="prf-th-num">متوسط السعر</th>
                <th className="prf-th-num">الربح الإجمالي</th>
                <th className="prf-th-num">% الربح الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 && (
                <tr>
                  <td colSpan={10} className="prf-empty">
                    لا توجد بيانات — اضغط "تحديث" لجلب البيانات من NetSuite
                  </td>
                </tr>
              )}

              {groups.map(g => {
                const isExp = !!expanded[g.type];
                return (
                  <React.Fragment key={g.type}>
                    {/* Group header row */}
                    {g.summary && (
                      <DataRow
                        row={g.summary}
                        isGroup
                        isExpanded={isExp}
                        onToggle={() => toggleGroup(g.type)}
                      />
                    )}
                    {/* Item rows */}
                    {isExp && g.items.map((item, idx) => (
                      <DataRow
                        key={idx}
                        row={item}
                        isGroup={false}
                        depth={1}
                      />
                    ))}
                  </React.Fragment>
                );
              })}

              {/* Grand total row — always shown when there is data */}
              {groups.length > 0 && (
                <tr className="prf-total-row">
                  <td className="prf-td-item"><strong>الإجمالي الكلي</strong></td>
                  <td className="prf-td-desc"></td>
                  <td className="prf-td-num"><strong>{fmtQty(kpi.qty)}</strong></td>
                  <td className="prf-td-num"><strong>{fmtNum(kpi.cost)}</strong></td>
                  <td className="prf-td-num prf-revenue"><strong>{fmtNum(kpi.revenue)}</strong></td>
                  <td className="prf-td-num"><strong>{total ? fmtPct(total.pctRevenue) : '—'}</strong></td>
                  <td className="prf-td-num"><strong>{total ? fmtNum(total.avgCost) : '—'}</strong></td>
                  <td className="prf-td-num"><strong>{total ? fmtNum(total.avgPrice) : '—'}</strong></td>
                  <td className={`prf-td-num prf-profit ${gpClass(kpi.margin)}`}>
                    <strong>{fmtNum(kpi.grossProfit)}</strong>
                  </td>
                  <td className={`prf-td-num prf-pct-cell ${gpClass(kpi.margin)}`}>
                    <strong>{fmtPct(kpi.margin)}</strong>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div className="prf-legend">
          <span className="prf-legend-item"><span className="prf-dot prf-gp-high"></span> هامش ≥ 20%</span>
          <span className="prf-legend-item"><span className="prf-dot prf-gp-mid"></span> هامش 10–20%</span>
          <span className="prf-legend-item"><span className="prf-dot prf-gp-low"></span> هامش 0–10%</span>
          <span className="prf-legend-item"><span className="prf-dot prf-gp-neg"></span> هامش سالب</span>
        </div>
      </div>
    </div>
  );
}
