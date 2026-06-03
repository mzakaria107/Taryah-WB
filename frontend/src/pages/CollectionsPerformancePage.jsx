import React, { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Printer, TrendingDown, X } from 'lucide-react';
import api from '../api/client';
import './CollectionsPerformancePage.css';

/* ── helpers ─────────────────────────────────────────────────── */
const fmt = (n) =>
  n == null
    ? '—'
    : Number(n).toLocaleString('ar-SA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  return d.toLocaleDateString('ar-SA-u-nu-latn', {
    weekday: 'short',
    year:    'numeric',
    month:   'short',
    day:     'numeric',
  });
};

const fmtDateShort = (iso) => {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  return d.toLocaleDateString('ar-SA-u-nu-latn', { month: 'short', day: 'numeric' });
};

const daysBetween = (from, to) => {
  if (!from || !to) return 0;
  const a = new Date(from + 'T12:00:00');
  const b = new Date(to   + 'T12:00:00');
  return Math.round((b - a) / 86400000) + 1;
};

const YEAR_OPTIONS = [2024, 2025, 2026];
const MONTH_NAMES  = [
  '', 'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

function heatClass(value, max) {
  if (!value || !max) return '';
  const pct = value / max;
  if (pct >= 0.75) return 'cp-heat-1';
  if (pct >= 0.5)  return 'cp-heat-2';
  if (pct >= 0.25) return 'cp-heat-3';
  return 'cp-heat-4';
}

/* ── Fetch ───────────────────────────────────────────────────── */
async function fetchPerformance(params) {
  const { data } = await api.get('/collections/performance', { params });
  return data;
}

/* ═══════════════════════════════════════════════════════════════
   Main Page
═══════════════════════════════════════════════════════════════ */
export default function CollectionsPerformancePage() {
  const now   = new Date();
  const [year,      setYear]      = useState(now.getFullYear());
  const [month,     setMonth]     = useState(now.getMonth() + 1);
  const [regionId,  setRegionId]  = useState('');
  const [dateFrom,  setDateFrom]  = useState('');
  const [dateTo,    setDateTo]    = useState('');
  const [activeTab, setActiveTab] = useState('daily'); // 'daily' | 'regions'

  /* ── Handle date-from: auto-sync year/month ─────────────────── */
  const handleDateFrom = useCallback((val) => {
    setDateFrom(val);
    if (val) {
      const d = new Date(val + 'T12:00:00');
      setYear(d.getFullYear());
      setMonth(d.getMonth() + 1);
    }
  }, []);

  const hasDateRange = dateFrom && dateTo;
  const days         = daysBetween(dateFrom, dateTo);

  /* ── Query params ───────────────────────────────────────────── */
  const queryParams = useMemo(() => {
    const p = { year, month };
    if (regionId) p.region_id = regionId;
    if (hasDateRange) { p.date_from = dateFrom; p.date_to = dateTo; }
    return p;
  }, [year, month, regionId, dateFrom, dateTo, hasDateRange]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['collections-performance', queryParams],
    queryFn:  () => fetchPerformance(queryParams),
    keepPreviousData: true,
    staleTime: 60_000,
  });

  /* ── Pivot: build dates × regions matrix ─────────────────────── */
  const { dates, regions, pivotMap, colMax } = useMemo(() => {
    if (!data?.daily?.length) return { dates: [], regions: [], pivotMap: {}, colMax: {} };

    const allDates   = [...new Set(data.daily.map(r => r.tran_date))].sort();
    const regionsArr = data.regions || [];

    // pivotMap[date][regionId] = total_paid
    const pivotMap = {};
    for (const d of allDates) pivotMap[d] = {};
    for (const row of data.daily) {
      pivotMap[row.tran_date][row.region_id] = parseFloat(row.total_paid || 0);
    }

    // max per region column (for heat map)
    const colMax = {};
    for (const reg of regionsArr) {
      const vals = allDates.map(d => pivotMap[d]?.[reg.id] || 0);
      colMax[reg.id] = Math.max(...vals, 0);
    }

    return { dates: allDates, regions: regionsArr, pivotMap, colMax };
  }, [data]);

  /* ── Region column totals ───────────────────────────────────── */
  const regionTotals = useMemo(() => {
    if (!data?.region_totals) return [];
    const total = data.region_totals.reduce((s, r) => s + parseFloat(r.total_paid || 0), 0);
    return data.region_totals.map(r => ({
      ...r,
      pct: total > 0 ? (parseFloat(r.total_paid || 0) / total) * 100 : 0,
    }));
  }, [data]);

  const grandTotal = useMemo(
    () => regionTotals.reduce((s, r) => s + parseFloat(r.total_paid || 0), 0),
    [regionTotals]
  );

  /* ── Print ──────────────────────────────────────────────────── */
  const handlePrint = () => {
    const label = hasDateRange
      ? `${dateFrom} – ${dateTo}`
      : `${MONTH_NAMES[month]} ${year}`;
    const prev  = document.title;
    document.title = `أداء التحصيل — ${label}`;
    window.print();
    window.onafterprint = () => { document.title = prev; };
  };

  /* ── Reset ──────────────────────────────────────────────────── */
  const handleReset = () => {
    setRegionId('');
    setDateFrom('');
    setDateTo('');
  };
  const isDirty = regionId || dateFrom || dateTo;

  /* ── Derived period label ───────────────────────────────────── */
  const periodLabel = hasDateRange
    ? `${fmtDate(dateFrom)} — ${fmtDate(dateTo)}`
    : `${MONTH_NAMES[month]} ${year}`;

  /* ─────────────────────────────────────────────────────────────
     Render
  ───────────────────────────────────────────────────────────── */
  return (
    <div className="cp-page">
      {/* Print header (hidden on screen) */}
      <div className="cp-print-header">
        <div className="cp-print-title">أداء التحصيل اليومي للمناطق</div>
        <div className="cp-print-meta">{periodLabel}</div>
      </div>

      {/* Page header */}
      <div className="cp-header cp-no-print">
        <TrendingDown size={24} color="var(--color-primary, #0ea5e9)" />
        <h1 className="cp-title">أداء التحصيل</h1>
        <button className="cp-print-btn" onClick={handlePrint}>
          <Printer size={16} /> طباعة / PDF
        </button>
      </div>

      {/* Filters */}
      <div className="cp-filters cp-no-print">
        {/* Year */}
        <div className="cp-filter-group">
          <span className="cp-filter-label">السنة</span>
          <select
            className="cp-filter-select"
            value={year}
            onChange={e => setYear(Number(e.target.value))}
          >
            {YEAR_OPTIONS.map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>

        {/* Month */}
        <div className="cp-filter-group">
          <span className="cp-filter-label">الشهر</span>
          <select
            className="cp-filter-select"
            value={month}
            onChange={e => setMonth(Number(e.target.value))}
          >
            {MONTH_NAMES.slice(1).map((name, i) => (
              <option key={i + 1} value={i + 1}>{name}</option>
            ))}
          </select>
        </div>

        {/* Region */}
        <div className="cp-filter-group">
          <span className="cp-filter-label">المنطقة</span>
          <select
            className="cp-filter-select"
            value={regionId}
            onChange={e => setRegionId(e.target.value)}
          >
            <option value="">كل المناطق</option>
            {(data?.regions || []).map(r => (
              <option key={r.id} value={r.id}>{r.name_ar}</option>
            ))}
          </select>
        </div>

        <div className="cp-filter-divider" />

        {/* Date from */}
        <div className="cp-filter-group">
          <span className="cp-filter-label">من تاريخ</span>
          <input
            type="date"
            className="cp-filter-input"
            value={dateFrom}
            onChange={e => handleDateFrom(e.target.value)}
          />
        </div>

        {/* Date to */}
        <div className="cp-filter-group">
          <span className="cp-filter-label">إلى تاريخ</span>
          <input
            type="date"
            className="cp-filter-input"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={e => setDateTo(e.target.value)}
          />
        </div>

        {/* Active date-range badge */}
        {hasDateRange && (
          <div className="cp-date-badge">
            <span>{fmtDateShort(dateFrom)} — {fmtDateShort(dateTo)}</span>
            <span className="cp-date-badge-days">{days} يوم</span>
            <span
              className="cp-date-badge-clear"
              title="إلغاء الفترة"
              onClick={() => { setDateFrom(''); setDateTo(''); }}
            >
              ✕
            </span>
          </div>
        )}

        {/* Reset */}
        {isDirty && (
          <button className="cp-filter-reset" onClick={handleReset}>
            إعادة تعيين
          </button>
        )}
      </div>

      {/* ── Loading / Error ─────────────────────────────────────── */}
      {isLoading && <div className="cp-loading">جاري تحميل بيانات التحصيل…</div>}
      {isError   && <div className="cp-loading">حدث خطأ في تحميل البيانات</div>}

      {!isLoading && !isError && data && (
        <>
          {/* ── KPI cards ────────────────────────────────────────── */}
          <div className="cp-kpis">
            <div className="cp-kpi-card cp-kpi-card--primary">
              <span className="cp-kpi-label">إجمالي التحصيل</span>
              <span className="cp-kpi-value">{fmt(data.kpis.total_paid)}</span>
              <span className="cp-kpi-sub" style={{ color: 'rgba(255,255,255,0.75)' }}>
                {data.kpis.active_days} يوم نشط
              </span>
            </div>

            <div className="cp-kpi-card cp-kpi-card--cash">
              <span className="cp-kpi-label">نقدي</span>
              <span className="cp-kpi-value">{fmt(data.kpis.cash)}</span>
              <span className="cp-kpi-sub">
                {data.kpis.total_paid > 0
                  ? ((data.kpis.cash / data.kpis.total_paid) * 100).toFixed(1) + '%'
                  : '—'}
              </span>
            </div>

            <div className="cp-kpi-card cp-kpi-card--cheque">
              <span className="cp-kpi-label">شيكات</span>
              <span className="cp-kpi-value">{fmt(data.kpis.cheque)}</span>
              <span className="cp-kpi-sub">
                {data.kpis.total_paid > 0
                  ? ((data.kpis.cheque / data.kpis.total_paid) * 100).toFixed(1) + '%'
                  : '—'}
              </span>
            </div>

            <div className="cp-kpi-card cp-kpi-card--bank">
              <span className="cp-kpi-label">تحويل بنكي</span>
              <span className="cp-kpi-value">{fmt(data.kpis.bank_tran)}</span>
              <span className="cp-kpi-sub">
                {data.kpis.total_paid > 0
                  ? ((data.kpis.bank_tran / data.kpis.total_paid) * 100).toFixed(1) + '%'
                  : '—'}
              </span>
            </div>

            <div className="cp-kpi-card cp-kpi-card--pos">
              <span className="cp-kpi-label">POS / بطاقة</span>
              <span className="cp-kpi-value">{fmt(data.kpis.pos)}</span>
              <span className="cp-kpi-sub">
                {data.kpis.total_paid > 0
                  ? ((data.kpis.pos / data.kpis.total_paid) * 100).toFixed(1) + '%'
                  : '—'}
              </span>
            </div>

            <div className="cp-kpi-card">
              <span className="cp-kpi-label">عدد المعاملات</span>
              <span className="cp-kpi-value">{fmt(data.kpis.tx_count)}</span>
              <span className="cp-kpi-sub">{periodLabel}</span>
            </div>

            <div className="cp-kpi-card">
              <span className="cp-kpi-label">عدد العملاء</span>
              <span className="cp-kpi-value">{fmt(data.kpis.customer_count)}</span>
              <span className="cp-kpi-sub">عميل نشط</span>
            </div>
          </div>

          {/* ── Tabs ──────────────────────────────────────────────── */}
          <div className="cp-tabs cp-no-print">
            <button
              className={`cp-tab${activeTab === 'daily' ? ' cp-tab--active' : ''}`}
              onClick={() => setActiveTab('daily')}
            >
              التفاصيل اليومية
            </button>
            <button
              className={`cp-tab${activeTab === 'regions' ? ' cp-tab--active' : ''}`}
              onClick={() => setActiveTab('regions')}
            >
              ملخص المناطق
            </button>
          </div>

          {/* ── Tab: Daily pivot table ────────────────────────────── */}
          {(activeTab === 'daily' || true /* print both */) && (
            <div className={activeTab !== 'daily' ? 'cp-no-print' : ''} style={{ display: activeTab === 'daily' ? 'block' : 'none' }}>
              {dates.length === 0 ? (
                <div className="cp-empty">لا توجد بيانات تحصيل في هذه الفترة</div>
              ) : (
                <div className="cp-pivot-wrap">
                  <PivotTable
                    dates={dates}
                    regions={regions}
                    pivotMap={pivotMap}
                    colMax={colMax}
                    regionId={regionId ? parseInt(regionId) : null}
                    daily={data.daily}
                  />
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Region summary ───────────────────────────────── */}
          {(activeTab === 'regions' || true /* print both */) && (
            <div
              className={activeTab !== 'regions' ? 'cp-no-print' : ''}
              style={{ display: activeTab === 'regions' ? 'block' : 'none', marginTop: 16 }}
            >
              {regionTotals.length === 0 ? (
                <div className="cp-empty">لا توجد بيانات</div>
              ) : (
                <div className="cp-region-table-wrap">
                  <RegionSummaryTable
                    regionTotals={regionTotals}
                    grandTotal={grandTotal}
                    kpis={data.kpis}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PivotTable — dates × regions
═══════════════════════════════════════════════════════════════ */
function PivotTable({ dates, regions, pivotMap, colMax, regionId, daily }) {
  // If a single region is selected, show payment-type breakdown instead
  if (regionId) {
    return <SingleRegionTable dates={dates} daily={daily} regionId={regionId} />;
  }

  // Column totals per date
  const dateTotals = {};
  for (const d of dates) {
    dateTotals[d] = regions.reduce((s, r) => s + (pivotMap[d]?.[r.id] || 0), 0);
  }
  const rowMax = Math.max(...Object.values(dateTotals), 0);

  // Grand column totals
  const grandCol = {};
  for (const r of regions) {
    grandCol[r.id] = dates.reduce((s, d) => s + (pivotMap[d]?.[r.id] || 0), 0);
  }
  const grandRow = Object.values(grandCol).reduce((s, v) => s + v, 0);

  const fmt2 = (n) =>
    n ? Number(n).toLocaleString('ar-SA', { maximumFractionDigits: 0 }) : '';

  return (
    <table className="cp-pivot-table">
      <thead>
        <tr>
          <th>التاريخ</th>
          {regions.map(r => (
            <th key={r.id}>{r.name_ar}</th>
          ))}
          <th>الإجمالي</th>
        </tr>
      </thead>
      <tbody>
        {dates.map(d => {
          const rowTotal = dateTotals[d];
          return (
            <tr key={d}>
              <td>{fmtDateShort(d)}</td>
              {regions.map(r => {
                const val = pivotMap[d]?.[r.id] || 0;
                return (
                  <td
                    key={r.id}
                    className={val === 0 ? 'cp-pivot-cell--zero' : heatClass(val, colMax[r.id])}
                  >
                    {fmt2(val)}
                  </td>
                );
              })}
              <td className={heatClass(rowTotal, rowMax)} style={{ fontWeight: 600 }}>
                {fmt2(rowTotal)}
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr className="cp-pivot-total">
          <td>الإجمالي</td>
          {regions.map(r => (
            <td key={r.id}>{fmt2(grandCol[r.id])}</td>
          ))}
          <td>{fmt2(grandRow)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SingleRegionTable — when one region is selected
   Shows daily breakdown: total, cash, cheque, bank, pos, customers
═══════════════════════════════════════════════════════════════ */
function SingleRegionTable({ dates, daily, regionId }) {
  const byDate = {};
  for (const row of daily) {
    if (row.region_id === regionId) byDate[row.tran_date] = row;
  }

  const totals = daily
    .filter(r => r.region_id === regionId)
    .reduce(
      (acc, r) => ({
        total_paid:     acc.total_paid     + parseFloat(r.total_paid     || 0),
        cash:           acc.cash           + parseFloat(r.cash           || 0),
        cheque:         acc.cheque         + parseFloat(r.cheque         || 0),
        bank_tran:      acc.bank_tran      + parseFloat(r.bank_tran      || 0),
        pos:            acc.pos            + parseFloat(r.pos            || 0),
        tx_count:       acc.tx_count       + parseInt(r.tx_count         || 0),
        customer_count: acc.customer_count + parseInt(r.customer_count   || 0),
      }),
      { total_paid: 0, cash: 0, cheque: 0, bank_tran: 0, pos: 0, tx_count: 0, customer_count: 0 }
    );

  const fmt2 = (n) =>
    n ? Number(n).toLocaleString('ar-SA', { maximumFractionDigits: 0 }) : '';

  const maxPaid = Math.max(...dates.map(d => parseFloat(byDate[d]?.total_paid || 0)), 0);

  return (
    <table className="cp-pivot-table">
      <thead>
        <tr>
          <th>التاريخ</th>
          <th>الإجمالي</th>
          <th>نقدي</th>
          <th>شيكات</th>
          <th>تحويل بنكي</th>
          <th>POS</th>
          <th>معاملات</th>
          <th>عملاء</th>
        </tr>
      </thead>
      <tbody>
        {dates.map(d => {
          const r = byDate[d];
          if (!r) return (
            <tr key={d}>
              <td>{fmtDateShort(d)}</td>
              {[...Array(7)].map((_, i) => (
                <td key={i} className="cp-pivot-cell--zero">—</td>
              ))}
            </tr>
          );
          const paid = parseFloat(r.total_paid || 0);
          return (
            <tr key={d}>
              <td>{fmtDateShort(d)}</td>
              <td className={heatClass(paid, maxPaid)} style={{ fontWeight: 600 }}>
                {fmt2(paid)}
              </td>
              <td>{fmt2(r.cash)}</td>
              <td>{fmt2(r.cheque)}</td>
              <td>{fmt2(r.bank_tran)}</td>
              <td>{fmt2(r.pos)}</td>
              <td>{fmt2(r.tx_count)}</td>
              <td>{fmt2(r.customer_count)}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr className="cp-pivot-total">
          <td>الإجمالي</td>
          <td>{fmt2(totals.total_paid)}</td>
          <td>{fmt2(totals.cash)}</td>
          <td>{fmt2(totals.cheque)}</td>
          <td>{fmt2(totals.bank_tran)}</td>
          <td>{fmt2(totals.pos)}</td>
          <td>{fmt2(totals.tx_count)}</td>
          <td>{fmt2(totals.customer_count)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/* ═══════════════════════════════════════════════════════════════
   RegionSummaryTable
═══════════════════════════════════════════════════════════════ */
function RegionSummaryTable({ regionTotals, grandTotal, kpis }) {
  const fmt2 = (n) =>
    n == null
      ? '—'
      : Number(n).toLocaleString('ar-SA', { maximumFractionDigits: 0 });

  return (
    <table className="cp-region-table">
      <thead>
        <tr>
          <th>#</th>
          <th>المنطقة</th>
          <th>إجمالي التحصيل</th>
          <th>النسبة</th>
          <th>نقدي</th>
          <th>شيكات</th>
          <th>تحويل بنكي</th>
          <th>POS</th>
          <th>معاملات</th>
          <th>عملاء</th>
        </tr>
      </thead>
      <tbody>
        {regionTotals.map((r, i) => (
          <tr key={r.region_id}>
            <td>{i + 1}</td>
            <td style={{ fontWeight: 700 }}>{r.region_name}</td>
            <td style={{ fontWeight: 700 }}>{fmt2(r.total_paid)}</td>
            <td>
              <div className="cp-pct-bar">
                <div className="cp-pct-track">
                  <div
                    className="cp-pct-fill"
                    style={{ width: `${Math.min(r.pct, 100).toFixed(1)}%` }}
                  />
                </div>
                <span className="cp-pct-text">{r.pct.toFixed(1)}%</span>
              </div>
            </td>
            <td>{fmt2(r.cash)}</td>
            <td>{fmt2(r.cheque)}</td>
            <td>{fmt2(r.bank_tran)}</td>
            <td>{fmt2(r.pos)}</td>
            <td>{fmt2(r.tx_count)}</td>
            <td>{fmt2(r.customer_count)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="cp-total-row">
          <td colSpan={2}>الإجمالي</td>
          <td>{fmt2(grandTotal)}</td>
          <td>100%</td>
          <td>{fmt2(kpis?.cash)}</td>
          <td>{fmt2(kpis?.cheque)}</td>
          <td>{fmt2(kpis?.bank_tran)}</td>
          <td>{fmt2(kpis?.pos)}</td>
          <td>{fmt2(kpis?.tx_count)}</td>
          <td>{fmt2(kpis?.customer_count)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
