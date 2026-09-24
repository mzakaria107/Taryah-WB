import React, { useState, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './QualityReturnsReportPage.css';

const ADMIN_ROLES = ['super_admin', 'it_admin'];

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmt(n) {
  return Number(n || 0).toLocaleString('en-SA', { maximumFractionDigits: 2 });
}
function fmtDate(d) {
  return d ? String(d).slice(0, 10) : '—';
}
function itemLabel(it) {
  return it?.item_name_ar || it?.item_name || it?.item_name_en || '';
}

/**
 * QualityReturnsReportPage — search/report across ALL regions for
 * مرتجعات عيوب الجودة, plus (admin-only) the settings panel for
 * region↔monitor assignment. Mirrors the established
 * "report page carries its own admin settings card + per-report expand log"
 * pattern from CarrefourDamageReportPage.jsx.
 */
export default function QualityReturnsReportPage() {
  const { user } = useAuth();
  const isAdmin = ADMIN_ROLES.includes(user?.role);

  const [dateFrom, setDateFrom] = useState(daysAgoISO(6));
  const [dateTo, setDateTo] = useState(todayISO());
  const [regionFilter, setRegionFilter] = useState('');
  const [routeFilter, setRouteFilter] = useState('');
  const [itemFilter, setItemFilter] = useState('');

  const { data: filters } = useQuery({
    queryKey: ['qrr-filters'],
    queryFn: () => client.get('/quality-returns/filters').then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const routeOptions = useMemo(() => {
    const all = filters?.routes || [];
    return regionFilter ? all.filter(r => String(r.region_id) === String(regionFilter)) : all;
  }, [filters, regionFilter]);

  const params = {
    date_from: dateFrom, date_to: dateTo,
    ...(regionFilter ? { region_id: regionFilter } : {}),
    ...(routeFilter ? { route_id: routeFilter } : {}),
    ...(itemFilter ? { item: itemFilter } : {}),
  };

  const { data, isLoading } = useQuery({
    queryKey: ['qrr-report', params],
    queryFn: () => client.get('/quality-returns/report', { params }).then(r => r.data),
  });

  const rows = data?.rows || [];
  const totals = data?.totals || {};

  const byRegion = useMemo(() => {
    const m = new Map();
    rows.forEach(r => {
      const e = m.get(r.region_id) || { region_name: r.region_name, total_qty: 0, dates: new Set() };
      e.total_qty += Number(r.quantity) || 0;
      e.dates.add(r.report_date);
      m.set(r.region_id, e);
    });
    return [...m.values()].map(e => ({ ...e, report_count: e.dates.size }))
      .sort((a, b) => b.total_qty - a.total_qty);
  }, [rows]);

  const byItem = useMemo(() => {
    const m = new Map();
    rows.forEach(r => {
      if (!r.item_name) return;
      const e = m.get(r.item_name) || { item_name: r.item_name, item_name_ar: r.item_name_ar, item_code: r.item_code, total_qty: 0 };
      e.total_qty += Number(r.quantity) || 0;
      m.set(r.item_name, e);
    });
    return [...m.values()].sort((a, b) => b.total_qty - a.total_qty);
  }, [rows]);

  const byItemTop5 = useMemo(() => byItem.slice(0, 5), [byItem]);

  // Rep-level breakdown — keyed by route_id (one route = one rep/car
  // combination in this data), sourced from the same rep_names/
  // vehicle_numbers the report table and print view already carry.
  const byRep = useMemo(() => {
    const m = new Map();
    rows.forEach(r => {
      if (!r.route_id) return;
      const e = m.get(r.route_id) || {
        route_id: r.route_id, rep_names: r.rep_names, vehicle_numbers: r.vehicle_numbers, total_qty: 0,
      };
      e.total_qty += Number(r.quantity) || 0;
      m.set(r.route_id, e);
    });
    return [...m.values()].sort((a, b) => b.total_qty - a.total_qty);
  }, [rows]);

  const reportsList = useMemo(() => {
    const m = new Map();
    rows.forEach(r => {
      if (!r.report_id) return;
      const g = m.get(r.report_id) || {
        report_id: r.report_id, report_no: r.report_no, report_date: r.report_date,
        region_id: r.region_id, region_name: r.region_name, submitted_by_name: r.submitted_by_name,
        report_notes: r.report_notes, items: [], total_qty: 0,
      };
      if (r.item_name && Number(r.quantity) > 0) {
        g.items.push({
          route_id: r.route_id, rep_names: r.rep_names, vehicle_numbers: r.vehicle_numbers,
          item_name: r.item_name, item_name_ar: r.item_name_ar, item_code: r.item_code,
          quantity: r.quantity, expiry_date: r.expiry_date, notes: r.notes,
        });
        g.total_qty += Number(r.quantity) || 0;
      }
      m.set(r.report_id, g);
    });
    return [...m.values()].sort((a, b) => (a.report_date < b.report_date ? 1 : a.report_date > b.report_date ? -1 : 0));
  }, [rows]);
  const [expandedReportId, setExpandedReportId] = useState(null);
  const [printTarget, setPrintTarget] = useState(null); // the report row being printed

  useEffect(() => {
    if (!printTarget) return;
    const prevTitle = document.title;
    document.title = `مرتجعات عيوب الجودة — ${printTarget.region_name} — ${fmtDate(printTarget.report_date)}`;
    window.print();
    window.onafterprint = () => { document.title = prevTitle; setPrintTarget(null); };
  }, [printTarget]);

  const kpis = useMemo(() => {
    const activeDays = new Set(rows.map(r => r.report_date)).size;
    const totalQty = Number(totals.total_qty) || 0;
    const regionsReported = byRegion.length;
    const top = byRegion[0] || null;
    const bottom = regionsReported ? byRegion[regionsReported - 1] : null;
    return {
      avgPerDay: activeDays ? totalQty / activeDays : 0,
      avgPerRegion: regionsReported ? totalQty / regionsReported : 0,
      complianceRate: totals.regions_total ? (totals.regions_reported / totals.regions_total) * 100 : 0,
      top, bottom,
    };
  }, [rows, byRegion, totals]);

  const rangeInvalid = dateTo < dateFrom;

  const handleExport = () => {
    const regionLabel = regionFilter
      ? (filters?.regions || []).find(r => String(r.id) === String(regionFilter))?.name_ar
      : 'كل المناطق';

    const wb = XLSX.utils.book_new();
    const summaryHeader = ['رقم التقرير', 'التاريخ', 'المنطقة', 'المستخدم', 'عدد الأصناف المسجَّلة', 'إجمالي الكمية'];
    const summaryRows = reportsList.map(rep => [
      rep.report_no ?? '', fmtDate(rep.report_date), rep.region_name,
      rep.submitted_by_name || '', rep.items.length, Number(rep.total_qty) || 0,
    ]);
    const wsSummary = XLSX.utils.aoa_to_sheet([
      [`تصدير مرتجعات عيوب الجودة — المنطقة: ${regionLabel} — من ${dateFrom} إلى ${dateTo}`],
      [], summaryHeader, ...summaryRows,
    ]);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'سجل التقارير');

    const detailHeader = ['رقم التقرير', 'التاريخ', 'المنطقة', 'خط السير', 'اسم المندوب', 'رقم السيارة', 'رقم الصنف', 'الصنف', 'الكمية', 'تاريخ الانتهاء', 'ملاحظات'];
    const detailRows = [];
    reportsList.forEach(rep => {
      rep.items.forEach(it => {
        detailRows.push([
          rep.report_no ?? '', fmtDate(rep.report_date), rep.region_name, it.route_id,
          it.rep_names || '', it.vehicle_numbers || '',
          it.item_code || '', itemLabel(it), Number(it.quantity) || 0, it.expiry_date ? fmtDate(it.expiry_date) : '', it.notes || '',
        ]);
      });
    });
    const wsDetail = XLSX.utils.aoa_to_sheet([detailHeader, ...detailRows]);
    XLSX.utils.book_append_sheet(wb, wsDetail, 'تفاصيل الأصناف');

    const regionSuffix = regionFilter ? `_${(regionLabel || '').replace(/[^\p{L}\p{N}]+/gu, '-')}` : '';
    XLSX.writeFile(wb, `مرتجعات_جودة${regionSuffix}_${dateFrom}_${dateTo}.xlsx`);
  };

  return (
    <div className="qrr-page">
      <div className="qrr-header">
        <h1>تقرير مرتجعات عيوب الجودة</h1>
        <p className="qrr-subtitle">بحث وتقرير مرتجعات عيوب الجودة اليومية لكل المناطق، بأي فترة زمنية.</p>
      </div>

      <div className="qrr-card qrr-filters">
        <div className="qrr-field">
          <label>من تاريخ</label>
          <input type="date" className="qrr-input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div className="qrr-field">
          <label>إلى تاريخ</label>
          <input type="date" className="qrr-input" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
        <div className="qrr-field">
          <label>المنطقة</label>
          <select className="qrr-input" value={regionFilter} onChange={e => { setRegionFilter(e.target.value); setRouteFilter(''); }}>
            <option value="">كل المناطق</option>
            {(filters?.regions || []).map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
          </select>
        </div>
        <div className="qrr-field">
          <label>خط السير</label>
          <select className="qrr-input" value={routeFilter} onChange={e => setRouteFilter(e.target.value)}>
            <option value="">كل الخطوط</option>
            {routeOptions.map(r => <option key={r.route_id} value={r.route_id}>خط {r.route_id}</option>)}
          </select>
        </div>
        <div className="qrr-field">
          <label>الصنف</label>
          <select className="qrr-input" value={itemFilter} onChange={e => setItemFilter(e.target.value)}>
            <option value="">كل الأصناف</option>
            {(filters?.items || []).map(it => (
              <option key={it.item_name_en} value={it.item_name_en}>
                {itemLabel(it)}{it.item_code ? ` (${it.item_code})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="qrr-field qrr-export-field">
          <label>&nbsp;</label>
          <button className="qrr-btn qrr-btn--export" onClick={handleExport} disabled={rangeInvalid || reportsList.length === 0}>
            📥 تصدير Excel
          </button>
        </div>
      </div>

      {rangeInvalid && <div className="qrr-error">نطاق التاريخ غير صحيح — «إلى» قبل «من».</div>}

      {!rangeInvalid && (
        <>
          <div className="qrr-tiles">
            <div className="qrr-tile">
              <div className="qrr-tile__label">إجمالي الكمية</div>
              <div className="qrr-tile__value">{fmt(totals.total_qty)}</div>
            </div>
            <div className="qrr-tile">
              <div className="qrr-tile__label">عدد التقارير المُدخلة</div>
              <div className="qrr-tile__value">{fmt(totals.total_reports)}</div>
            </div>
            <div className="qrr-tile">
              <div className="qrr-tile__label">المناطق التي أدخلت تقارير</div>
              <div className="qrr-tile__value">{fmt(totals.regions_reported)} / {fmt(totals.regions_total)}</div>
            </div>
            <div className="qrr-tile">
              <div className="qrr-tile__label">خطوط السير المسجَّلة</div>
              <div className="qrr-tile__value">{fmt(totals.routes_reported)} / {fmt(totals.routes_total)}</div>
            </div>
          </div>

          {!isLoading && byRegion.length > 0 && (
            <div className="qrr-card">
              <div className="qrr-card__title">📊 ملخص مؤشرات الأداء</div>
              <div className="qrr-kpi-row">
                <div className="qrr-kpi">
                  <div className="qrr-kpi__label">متوسط الكمية / يوم</div>
                  <div className="qrr-kpi__value">{fmt(kpis.avgPerDay)}</div>
                </div>
                <div className="qrr-kpi">
                  <div className="qrr-kpi__label">متوسط الكمية / منطقة</div>
                  <div className="qrr-kpi__value">{fmt(kpis.avgPerRegion)}</div>
                </div>
                <div className="qrr-kpi">
                  <div className="qrr-kpi__label">نسبة التزام المناطق بالإدخال</div>
                  <div className="qrr-kpi__value">{fmt(kpis.complianceRate)}%</div>
                </div>
                <div className="qrr-kpi">
                  <div className="qrr-kpi__label">أعلى منطقة</div>
                  <div className="qrr-kpi__value qrr-kpi__value--sm">{kpis.top?.region_name || '—'}</div>
                  <div className="qrr-kpi__sub">{kpis.top ? fmt(kpis.top.total_qty) : ''}</div>
                </div>
                <div className="qrr-kpi">
                  <div className="qrr-kpi__label">أقل منطقة نشطة</div>
                  <div className="qrr-kpi__value qrr-kpi__value--sm">{kpis.bottom?.region_name || '—'}</div>
                  <div className="qrr-kpi__sub">{kpis.bottom ? fmt(kpis.bottom.total_qty) : ''}</div>
                </div>
              </div>

              <div className="qrr-region-chart">
                <div className="qrr-region-chart__title">مقارنة الكمية بين كل المناطق</div>
                {byRegion.map(r => {
                  const pct = kpis.top?.total_qty ? Math.max(2, (r.total_qty / kpis.top.total_qty) * 100) : 0;
                  return (
                    <div key={r.region_name} className="qrr-region-bar-row">
                      <span className="qrr-region-bar-label">{r.region_name}</span>
                      <div className="qrr-region-bar-track">
                        <div className="qrr-region-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="qrr-region-bar-value">{fmt(r.total_qty)}</span>
                    </div>
                  );
                })}
              </div>

              <div className="qrr-region-chart">
                <div className="qrr-region-chart__title">مقارنة الكمية بين المناديب (خط السير ورقم السيارة)</div>
                {byRep.map(r => {
                  const top = byRep[0]?.total_qty || 0;
                  const pct = top ? Math.max(2, (r.total_qty / top) * 100) : 0;
                  return (
                    <div key={r.route_id} className="qrr-region-bar-row">
                      <span className="qrr-region-bar-label" title={`${r.rep_names || '—'} — ${r.vehicle_numbers || '—'}`}>
                        خط {r.route_id} — {r.rep_names || 'بدون مندوب'}{r.vehicle_numbers ? ` (${r.vehicle_numbers})` : ''}
                      </span>
                      <div className="qrr-region-bar-track">
                        <div className="qrr-region-bar-fill qrr-region-bar-fill--rep" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="qrr-region-bar-value">{fmt(r.total_qty)}</span>
                    </div>
                  );
                })}
              </div>

              <div className="qrr-region-chart">
                <div className="qrr-region-chart__title">أعلى 5 أصناف مرتجعات</div>
                {byItemTop5.map(it => {
                  const top = byItemTop5[0]?.total_qty || 0;
                  const pct = top ? Math.max(2, (it.total_qty / top) * 100) : 0;
                  return (
                    <div key={it.item_name} className="qrr-region-bar-row">
                      <span className="qrr-region-bar-label">{itemLabel(it)}{it.item_code ? ` (${it.item_code})` : ''}</span>
                      <div className="qrr-region-bar-track">
                        <div className="qrr-region-bar-fill qrr-region-bar-fill--item" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="qrr-region-bar-value">{fmt(it.total_qty)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {data?.missing_latest_date?.length > 0 && (
            <div className="qrr-card qrr-alert">
              <strong>⚠ لم يتم إدخال تقرير بتاريخ {fmtDate(data.latest_date)}</strong> للمناطق التالية (من ضمن المناطق المخصصة لمراقب):
              <div className="qrr-alert__list">
                {data.missing_latest_date.map(r => <span key={r.id} className="qrr-chip">{r.name_ar}</span>)}
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="qrr-card qrr-empty">جاري التحميل…</div>
          ) : rows.length === 0 ? (
            <div className="qrr-card qrr-empty">لا توجد بيانات في هذه الفترة.</div>
          ) : (
            <div className="qrr-grid">
              <div className="qrr-card">
                <div className="qrr-card__title">الإجمالي حسب المنطقة</div>
                <div className="qrr-table-wrap">
                  <table className="qrr-table">
                    <thead><tr><th>المنطقة</th><th>الكمية</th><th>عدد الأيام المُدخلة</th></tr></thead>
                    <tbody>
                      {byRegion.map(r => (
                        <tr key={r.region_name}><td>{r.region_name}</td><td>{fmt(r.total_qty)}</td><td>{r.report_count}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="qrr-card">
                <div className="qrr-card__title">الإجمالي حسب الصنف</div>
                <div className="qrr-table-wrap">
                  <table className="qrr-table">
                    <thead><tr><th>رقم الصنف</th><th>الصنف</th><th>الكمية</th></tr></thead>
                    <tbody>
                      {byItem.map(it => (
                        <tr key={it.item_name}><td>{it.item_code || '—'}</td><td>{itemLabel(it)}</td><td>{fmt(it.total_qty)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {!isLoading && reportsList.length > 0 && (
            <div className="qrr-card">
              <div className="qrr-card__title">سجل التقارير</div>
              <p className="qrr-hint">اضغط على أي تقرير لعرض الأصناف/الخطوط المسجَّلة له (المُدخل قيمة لها فقط).</p>
              <div className="qrr-table-wrap">
                <table className="qrr-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>رقم التقرير</th>
                      <th>التاريخ</th>
                      <th>المنطقة</th>
                      <th>المستخدم</th>
                      <th>عدد الأصناف المسجَّلة</th>
                      <th>إجمالي الكمية</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportsList.map(rep => {
                      const isOpen = expandedReportId === rep.report_id;
                      return (
                        <React.Fragment key={rep.report_id}>
                          <tr className="qrr-report-row" onClick={() => setExpandedReportId(isOpen ? null : rep.report_id)}>
                            <td className="qrr-report-toggle">{isOpen ? '▼' : '◀'}</td>
                            <td>#{rep.report_no ?? '—'}</td>
                            <td>{fmtDate(rep.report_date)}</td>
                            <td>{rep.region_name}</td>
                            <td>{rep.submitted_by_name || '—'}</td>
                            <td>{rep.items.length}</td>
                            <td>{fmt(rep.total_qty)}</td>
                            <td>
                              <button
                                type="button" className="qrr-btn qrr-btn--sm"
                                onClick={(e) => { e.stopPropagation(); setPrintTarget(rep); }}
                                disabled={rep.items.length === 0}
                                title={rep.items.length === 0 ? 'لا توجد كميات مسجَّلة للطباعة' : 'طباعة PDF'}
                              >
                                🖨️
                              </button>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="qrr-report-detail-row">
                              <td colSpan={8}>
                                {rep.report_notes && <div className="qrr-report-detail-notes">ملاحظات عامة: {rep.report_notes}</div>}
                                {rep.items.length === 0 ? (
                                  <div className="qrr-empty">لا توجد أصناف مُدخلة بقيمة في هذا التقرير.</div>
                                ) : (
                                  <table className="qrr-table qrr-table--nested">
                                    <thead><tr><th>خط السير</th><th>اسم المندوب</th><th>رقم السيارة</th><th>رقم الصنف</th><th>الصنف</th><th>الكمية</th><th>تاريخ الانتهاء</th></tr></thead>
                                    <tbody>
                                      {rep.items.map((it, i) => (
                                        <tr key={i}>
                                          <td>خط {it.route_id}</td>
                                          <td>{it.rep_names || '—'}</td>
                                          <td>{it.vehicle_numbers || '—'}</td>
                                          <td>{it.item_code || '—'}</td>
                                          <td>{itemLabel(it)}</td>
                                          <td>{fmt(it.quantity)}</td>
                                          <td>{it.expiry_date ? fmtDate(it.expiry_date) : '—'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                                <QualityReturnsReportPhotos regionId={rep.region_id} date={rep.report_date} />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {isAdmin && <QualityReturnsSettingsPanel />}

      {/* ── Print-only view for one saved report (hidden on screen) ── */}
      {printTarget && (
        <div className="qrr-print-only">
          <div className="qrr-print-header">
            <img src="/Logo.png" alt="طرية" className="qrr-print-logo" />
            <div className="qrr-print-title">
              <div>تقرير مرتجعات عيوب الجودة #{printTarget.report_no ?? '—'}</div>
              <div className="qrr-print-sub">{printTarget.region_name} — {fmtDate(printTarget.report_date)}</div>
            </div>
          </div>

          <div className="qrr-print-summary">
            <div><strong>ملخص كميات الجودة</strong></div>
            <div>إجمالي الكمية: {fmt(printTarget.total_qty)}</div>
            <div>عدد الأصناف المسجَّلة: {printTarget.items.length}</div>
            <div>المستخدم: {printTarget.submitted_by_name || '—'}</div>
          </div>

          <table className="qrr-print-table">
            <thead>
              <tr>
                <th>خط السير</th>
                <th>اسم المندوب</th>
                <th>رقم السيارة</th>
                <th>رقم الصنف</th>
                <th>الصنف</th>
                <th>الكمية</th>
                <th>تاريخ الانتهاء</th>
              </tr>
            </thead>
            <tbody>
              {printTarget.items.map((it, i) => (
                <tr key={i}>
                  <td>خط {it.route_id}</td>
                  <td>{it.rep_names || '—'}</td>
                  <td>{it.vehicle_numbers || '—'}</td>
                  <td>{it.item_code || '—'}</td>
                  <td>{itemLabel(it)}</td>
                  <td>{fmt(it.quantity)}</td>
                  <td>{it.expiry_date ? fmtDate(it.expiry_date) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {printTarget.report_notes && <div className="qrr-print-notes">ملاحظات: {printTarget.report_notes}</div>}
          <div className="qrr-print-footer">تاريخ التقرير: {fmtDate(printTarget.report_date)}</div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Inline photo gallery for one report's (region, date) — shown when a
   report row is expanded. Uses /report-photos (report-page permission,
   no ownership restriction), not /photos (entry-page permission).
════════════════════════════════════════════════════════════ */
function QualityReturnsReportPhotos({ regionId, date }) {
  const { data: photos = [] } = useQuery({
    queryKey: ['qrr-report-photos', regionId, date],
    queryFn: () => client.get('/quality-returns/report-photos', { params: { region_id: regionId, date } }).then(r => r.data),
    enabled: !!regionId && !!date,
  });
  if (photos.length === 0) return null;
  return (
    <div className="qrr-inline-photos">
      <div className="qrr-inline-photos__title">📷 صور مرفقة</div>
      <div className="qrr-inline-photos__grid">
        {photos.map(p => (
          <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className="qrr-album-thumb">
            <img src={p.url} alt={p.original_filename || 'صورة'} />
          </a>
        ))}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Admin settings panel — region ↔ monitor assignment
════════════════════════════════════════════════════════════ */
function QualityReturnsSettingsPanel() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false); // collapsed by default — shown on demand
  const [assignPick, setAssignPick] = useState({}); // { regionId: userId }
  const [error, setError] = useState('');

  const { data: regions = [], refetch: refetchRegions } = useQuery({
    queryKey: ['qrr-admin-regions'],
    queryFn: () => client.get('/quality-returns/regions-admin').then(r => r.data),
  });
  const { data: monitors = [] } = useQuery({
    queryKey: ['qrr-admin-monitors'],
    queryFn: () => client.get('/quality-returns/monitors').then(r => r.data),
  });

  const runAction = async (fn) => {
    setError('');
    try { await fn(); } catch (err) { setError(err?.response?.data?.error || 'حدث خطأ'); }
  };

  const assignMonitor = (regionId) => runAction(async () => {
    const userId = assignPick[regionId];
    if (!userId) return;
    await client.post(`/quality-returns/regions/${regionId}/assign`, { user_id: userId });
    await refetchRegions();
  });

  const unassignMonitor = (regionId, userId) => runAction(async () => {
    await client.delete(`/quality-returns/regions/${regionId}/assign/${userId}`);
    await refetchRegions();
  });

  return (
    <div className="qrr-settings">
      <button type="button" className="qrr-settings__title qrr-settings__toggle" onClick={() => setExpanded(s => !s)}>
        <span>⚙️ إعدادات مرتجعات عيوب الجودة (للمدير)</span>
        <span>{expanded ? '▲' : '▼'}</span>
      </button>
      {!expanded ? null : (
      <>
      {error && <div className="qrr-error">{error}</div>}

      <div className="qrr-card">
        <div className="qrr-card__title">ربط المناطق بمراقبي مرتجعات الجودة</div>
        <div className="qrr-table-wrap">
          <table className="qrr-table qrr-table--settings">
            <thead><tr><th>المنطقة</th><th>المراقبون</th><th>ربط مراقب</th></tr></thead>
            <tbody>
              {regions.map(reg => (
                <tr key={reg.id}>
                  <td>{reg.name_ar}</td>
                  <td>
                    {(reg.monitors || []).map(m => (
                      <span key={m.user_id} className="qrr-chip qrr-chip--removable">
                        {m.name}
                        <button onClick={() => unassignMonitor(reg.id, m.user_id)} title="إلغاء الربط">✕</button>
                      </span>
                    ))}
                    {(!reg.monitors || reg.monitors.length === 0) && <span className="qrr-muted">لا يوجد</span>}
                  </td>
                  <td>
                    <div className="qrr-assign-row">
                      <select className="qrr-input qrr-input--sm" value={assignPick[reg.id] || ''}
                              onChange={e => setAssignPick(p => ({ ...p, [reg.id]: e.target.value }))}>
                        <option value="">— اختر مراقب —</option>
                        {monitors.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                      <button className="qrr-btn qrr-btn--sm" onClick={() => assignMonitor(reg.id)} disabled={!assignPick[reg.id]}>ربط</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="qrr-hint">المراقبون يُضافون كمستخدمين من صفحة «المستخدمون» بدور «مراقب مرتجعات جودة»، ثم يُربطون بالمنطقة هنا. رقم سيارة كل مندوب يُدخل ويُعدَّل من صفحة «إدارة المناديب».</p>
      </div>

      <QualityReturnsMandatoryCategoriesPanel />
      <QualityReturnsItemInfoPanel />
      </>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Admin settings panel — which item categories are MANDATORY for every
   user's entry grid (on top of, never instead of, each user's own optional
   extras — see quality_returns_mandatory_categories in migration 100).
════════════════════════════════════════════════════════════ */
function QualityReturnsMandatoryCategoriesPanel() {
  const qc = useQueryClient();
  const [busyCat, setBusyCat] = useState(null);
  const [error, setError] = useState('');

  const { data: categories = [], refetch } = useQuery({
    queryKey: ['qrr-mandatory-categories'],
    queryFn: () => client.get('/quality-returns/mandatory-categories').then(r => r.data),
  });

  const mandatory = categories.filter(c => c.is_mandatory);
  const optional = categories.filter(c => !c.is_mandatory);

  const toggle = async (category, isMandatory) => {
    setError('');
    setBusyCat(category);
    try {
      await client.put('/quality-returns/mandatory-categories', { item_category: category, is_mandatory: isMandatory });
      await refetch();
      qc.invalidateQueries({ queryKey: ['qre-category-prefs'] });
    } catch (err) {
      setError(err?.response?.data?.error || 'حدث خطأ أثناء التعديل');
    } finally {
      setBusyCat(null);
    }
  };

  return (
    <div className="qrr-card">
      <div className="qrr-card__title">فئات الأصناف الإجبارية لكل المستخدمين</div>
      <p className="qrr-hint">الفئات الإجبارية تظهر في شاشة الإدخال لكل المستخدمين ولا يمكنهم إخفاؤها — أي مستخدم يقدر يضيف فئات إضافية اختيارية لنفسه فوق دي.</p>
      {error && <div className="qrr-error">{error}</div>}
      <div className="qrr-mandatory-cats__section">
        <div className="qrr-mandatory-cats__label">فئات إجبارية</div>
        <div className="qrr-mandatory-cats__chips">
          {mandatory.length === 0 && <span className="qrr-muted">لا توجد فئات إجبارية بعد</span>}
          {mandatory.map(c => (
            <span key={c.item_category} className="qrr-chip qrr-chip--removable qrr-chip--mandatory">
              🔒 {c.item_category}
              <button disabled={busyCat === c.item_category} onClick={() => toggle(c.item_category, false)} title="إلغاء الإلزام">✕</button>
            </span>
          ))}
        </div>
      </div>
      <div className="qrr-mandatory-cats__section">
        <div className="qrr-mandatory-cats__label">فئات أخرى (اختيارية حاليًا)</div>
        <div className="qrr-mandatory-cats__chips">
          {optional.length === 0 && <span className="qrr-muted">كل الفئات إجبارية بالفعل</span>}
          {optional.map(c => (
            <span key={c.item_category} className="qrr-chip qrr-chip--removable">
              {c.item_category}
              <button disabled={busyCat === c.item_category} onClick={() => toggle(c.item_category, true)} title="جعلها إجبارية">➕</button>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Admin settings panel — Arabic name + item code overlay
   (sales_activity has neither; this is a pure display overlay, keyed on
   the same English item name the entry grid and reports already use)
════════════════════════════════════════════════════════════ */
function QualityReturnsItemInfoPanel() {
  const qc = useQueryClient();
  const [edits, setEdits] = useState({}); // { item_name_en: { item_name_ar, item_code } }
  const [savingItem, setSavingItem] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const { data: items = [], refetch } = useQuery({
    queryKey: ['qrr-admin-items'],
    queryFn: () => client.get('/quality-returns/items').then(r => r.data),
  });

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(it =>
      (it.item_name_en || '').toLowerCase().includes(q) ||
      (it.item_name_ar || '').toLowerCase().includes(q) ||
      (it.item_code || '').toLowerCase().includes(q)
    );
  }, [items, search]);

  const fieldValue = (it, field) => edits[it.item_name_en]?.[field] ?? it[field] ?? '';
  const setField = (itemNameEn, field, val) => {
    setEdits(prev => ({ ...prev, [itemNameEn]: { ...prev[itemNameEn], [field]: val } }));
  };

  const saveItem = async (it) => {
    setError('');
    setSavingItem(it.item_name_en);
    try {
      await client.put('/quality-returns/item-info', {
        item_name_en: it.item_name_en,
        item_name_ar: fieldValue(it, 'item_name_ar'),
        item_code: fieldValue(it, 'item_code'),
      });
      await refetch();
      qc.invalidateQueries({ queryKey: ['qre-entry'] });
      qc.invalidateQueries({ queryKey: ['qrr-filters'] });
      setEdits(prev => { const n = { ...prev }; delete n[it.item_name_en]; return n; });
    } catch (err) {
      setError(err?.response?.data?.error || 'حدث خطأ أثناء الحفظ');
    } finally {
      setSavingItem(null);
    }
  };

  return (
    <div className="qrr-card">
      <div className="qrr-card__title">الاسم العربي ورقم الصنف</div>
      <p className="qrr-hint">قائمة الأصناف تُستمد تلقائيًا من بيانات المبيعات — هذه الشاشة فقط لإضافة/تعديل الاسم العربي ورقم الصنف الظاهرين في شاشة الإدخال والتقارير.</p>
      {error && <div className="qrr-error">{error}</div>}
      <input type="text" className="qrr-input" style={{ marginBottom: 10, width: '100%', maxWidth: 320 }}
             placeholder="بحث…" value={search} onChange={e => setSearch(e.target.value)} />
      <div className="qrr-table-wrap">
        <table className="qrr-table qrr-table--settings">
          <thead><tr><th>الفئة</th><th>الاسم الإنجليزي</th><th>الاسم العربي</th><th>رقم الصنف</th><th></th></tr></thead>
          <tbody>
            {filtered.map(it => (
              <tr key={it.item_name_en}>
                <td>{it.item_category || '—'}</td>
                <td>{it.item_name_en}</td>
                <td>
                  <input type="text" className="qrr-input qrr-input--sm"
                         value={fieldValue(it, 'item_name_ar')}
                         onChange={e => setField(it.item_name_en, 'item_name_ar', e.target.value)} />
                </td>
                <td>
                  <input type="text" className="qrr-input qrr-input--sm" style={{ width: 90 }}
                         value={fieldValue(it, 'item_code')}
                         onChange={e => setField(it.item_name_en, 'item_code', e.target.value)} />
                </td>
                <td>
                  <button className="qrr-btn qrr-btn--sm" onClick={() => saveItem(it)} disabled={savingItem === it.item_name_en}>
                    {savingItem === it.item_name_en ? '…' : '💾 حفظ'}
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={5} className="qrr-empty">لا توجد أصناف مطابقة</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
