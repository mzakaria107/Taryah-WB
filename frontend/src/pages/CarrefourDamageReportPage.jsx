import React, { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './CarrefourDamageReportPage.css';

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
// Postgres DATE columns come back over JSON as a full ISO timestamp
// ("2026-08-29T21:00:00.000Z") — every report_date/latest_date display
// needs this, not just expiry_date.
function fmtDate(d) {
  return d ? String(d).slice(0, 10) : '—';
}

/* ── "الأسعار Survey" report: one cross-branch matrix ─────────────────
   Each cell aggregates every branch's MOST RECENT entry (within the
   selected range) for that item×brand. If every branch that reported it
   agrees, shown as one settled value ("اعتماد أحدهم" per the request);
   if branches disagree, the cell shows EVERY distinct value with which
   branch(es) said it instead of silently picking one
   ("في حالة كتابة قيمتين مختلفتين يتم توضيح ذلك"). */
function PriceSurveyReportMatrix({ dateFrom, dateTo, branchFilter, reportPath }) {
  const { data, isLoading } = useQuery({
    queryKey: ['cfr-price-survey-report', dateFrom, dateTo, branchFilter],
    queryFn: () => client.get(reportPath, {
      params: { date_from: dateFrom, date_to: dateTo, ...(branchFilter ? { branch_id: branchFilter } : {}) },
    }).then(r => r.data),
  });

  const items = data?.items || [];
  const brands = data?.brands || [];
  const ownBrand = brands.find(b => b.is_own_brand);

  // `${item_id}:${brand_id}` -> [{branch_id, branch_name, price, report_date}, …]
  const cellsByKey = useMemo(() => {
    const m = new Map();
    (data?.entries || []).forEach(e => {
      const key = `${e.item_id}:${e.brand_id}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(e);
    });
    return m;
  }, [data]);

  const groupedItems = useMemo(() => {
    const groups = [];
    let cur = null;
    items.forEach(it => {
      const cat = it.category || '';
      if (!cur || cur.category !== cat) { cur = { category: cat, rows: [] }; groups.push(cur); }
      cur.rows.push(it);
    });
    return groups;
  }, [items]);

  if (isLoading) return <div className="cfr-card cfr-empty">جاري تحميل البيانات…</div>;
  if (!items.length || !brands.length) {
    return <div className="cfr-card cfr-empty">لا توجد أصناف أو براندات مضافة بعد لمسح الأسعار.</div>;
  }

  return (
    <div className="cfr-card">
      <div className="cfr-table-wrap">
        <table className="cfr-table cfr-price-table">
          <thead>
            <tr>
              <th className="cfr-price-item-col">الصنف</th>
              {brands.map(b => (
                <th key={b.id} className={b.is_own_brand ? 'cfr-price-own-col' : ''}>{b.name}</th>
              ))}
              <th>Average</th>
            </tr>
          </thead>
          <tbody>
            {groupedItems.map(group => (
              <React.Fragment key={group.category}>
                {group.category && (
                  <tr className="cfr-price-cat-row"><td colSpan={brands.length + 2}><span className="cfr-price-cat-label">{group.category}</span></td></tr>
                )}
                {group.rows.map(it => {
                  // Per brand: settle to one value if every reporting branch
                  // agrees; otherwise flag the conflict with every distinct
                  // value + who said it.
                  const cellInfo = brands.map(b => {
                    const cell = cellsByKey.get(`${it.id}:${b.id}`) || [];
                    const distinct = new Map(); // price string -> [branch_name, …]
                    cell.forEach(c => {
                      const p = String(c.price);
                      if (!distinct.has(p)) distinct.set(p, []);
                      distinct.get(p).push(c.branch_name);
                    });
                    const values = [...distinct.entries()]; // [[priceStr, [branches]], …]
                    const conflict = values.length > 1;
                    const settled = values.length === 1 ? Number(values[0][0]) : null;
                    return { brand: b, values, conflict, settled };
                  });

                  const competitorSettled = cellInfo.filter(c => !c.brand.is_own_brand && c.settled != null).map(c => c.settled);
                  const avg = competitorSettled.length ? competitorSettled.reduce((s, v) => s + v, 0) / competitorSettled.length : null;
                  const allSettled = cellInfo.filter(c => c.settled != null).map(c => c.settled);
                  const minVal = allSettled.length ? Math.min(...allSettled) : null;
                  const ownSettled = cellInfo.find(c => c.brand.is_own_brand)?.settled ?? null;
                  const ownDevPct = avg != null && avg > 0 && ownSettled != null ? ((ownSettled - avg) / avg) * 100 : null;

                  return (
                    <tr key={it.id}>
                      <td className="cfr-price-item-col">{it.item_name}</td>
                      {cellInfo.map(({ brand, values, conflict, settled }) => {
                        const isMin = settled != null && minVal != null && settled === minVal;
                        return (
                          <td
                            key={brand.id}
                            className={`cfr-price-cell${conflict ? ' cfr-price-cell--conflict' : ''}${isMin ? ' cfr-price-cell--min' : ''}${brand.is_own_brand ? ' cfr-price-own-col' : ''}`}
                          >
                            {values.length === 0 && '—'}
                            {!conflict && values.length === 1 && Number(values[0][0]).toFixed(2)}
                            {conflict && (
                              <div className="cfr-price-conflict" title={values.map(([p, bs]) => `${Number(p).toFixed(2)}: ${bs.join('، ')}`).join(' | ')}>
                                ⚠️ {values.map(([p]) => Number(p).toFixed(2)).join(' / ')}
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td className="cfr-price-avg-col">
                        {avg != null ? avg.toFixed(2) : '—'}
                        {ownDevPct != null && (
                          <div className={`cfr-price-dev ${ownDevPct <= 0 ? 'cfr-price-dev--good' : 'cfr-price-dev--bad'}`}>
                            {ownDevPct <= 0 ? '▼' : '▲'} {Math.abs(ownDevPct).toFixed(1)}%
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cfr-hint">
        الخلايا بعلامة ⚠️ تعني أن أكثر من فرع سجّل سعراً مختلفاً لنفس الصنف/البراند — مرّر المؤشر فوقها لمعرفة كل فرع وسعره.
        الخلية الخضراء = أقل سعر مستقَر عليه بين البراندات لهذا الصنف.
        {ownBrand && ` "Average" = متوسط أسعار المنافسين (بدون ${ownBrand.name}) من القيم غير المتعارضة فقط.`}
      </p>
    </div>
  );
}

/* Same two tabs as CarrefourDamageEntryPage — see makeReportHandler in
   carrefourDamage.js for why these are one implementation over two tables. */
const REPORT_TABS = {
  damage: {
    key: 'damage',
    label: 'مرتجعات كارفور',
    exportLabel: 'مرتجعات',
    reportPath: '/carrefour-damage/report',
    quantityLabel: 'الكمية المرتجعة',
    pageTitle: 'تقرير مرتجعات فروع كارفور',
    pageSubtitle: 'التقرير الديناميكي لمرتجعات كارفور اليومية المُدخلة من المروجين.',
  },
  stock: {
    key: 'stock',
    label: 'جرد الأرصدة',
    exportLabel: 'أرصدة',
    reportPath: '/carrefour-damage/stock-report',
    quantityLabel: 'الرصيد',
    pageTitle: 'تقرير أرصدة فروع كارفور',
    pageSubtitle: 'التقرير الديناميكي لجرد الأرصدة اليومي المُدخل من المروجين.',
  },
  orders: {
    key: 'orders',
    label: 'الطلبيات المستلمة',
    exportLabel: 'طلبيات',
    reportPath: '/carrefour-damage/order-report',
    quantityLabel: 'الكمية المستلمة',
    pageTitle: 'تقرير الطلبيات المستلمة فروع كارفور',
    pageSubtitle: 'التقرير الديناميكي للطلبيات المستلمة اليومية المُدخلة من المروجين.',
  },
  // Different shape from the three flat-list tabs above (a cross-branch
  // matrix, not a rows-of-quantities report) — rendered by its own
  // <PriceSurveyReportMatrix>, sharing only the date/branch filters and
  // page chrome. No item-level filter (its own catalog, not
  // carrefour_damage_items) and no Excel export yet.
  priceSurvey: {
    key: 'priceSurvey',
    label: 'الأسعار Survey',
    reportPath: '/carrefour-damage/price-survey/report',
    pageTitle: 'تقرير مسح أسعار المنافسين — كارفور',
    pageSubtitle: 'عرض موحّد لكل فروع مسح الأسعار — سعر كل صنف عند كل براند، وأي فرق بين الفروع يُوضَّح بدل تجاهله.',
    isMatrix: true,
  },
  // Was a card always rendered below every report tab for an admin,
  // regardless of which one was open — moved into its own tab (admin-only,
  // filtered out of the tab bar for anyone else) so it only shows up when
  // actually wanted, instead of cluttering every report view.
  settings: {
    key: 'settings',
    label: '⚙️ الإعدادات',
    pageTitle: 'إعدادات مرتجعات كارفور',
    pageSubtitle: 'الفروع، أصناف الجرد، ربط المروجين، وبراندات/أصناف مسح الأسعار.',
    isSettings: true,
    adminOnly: true,
  },
};

/**
 * CarrefourDamageReportPage — the dynamic مرتجعات كارفور roll-up for management,
 * plus (admin-only) the settings panel for branches, the damage-item
 * catalog, and branch↔promoter assignment. Mirrors the established
 * "report page carries its own admin settings card" pattern from
 * DiscountShopsPage / HypermarketsPage.
 */
export default function CarrefourDamageReportPage() {
  const { user } = useAuth();
  const isAdmin = ADMIN_ROLES.includes(user?.role);

  const [tab, setTab] = useState('damage');
  const mode = REPORT_TABS[tab];

  const [dateFrom, setDateFrom] = useState(daysAgoISO(6));
  const [dateTo, setDateTo] = useState(todayISO());
  const [branchFilter, setBranchFilter] = useState('');
  const [itemFilter, setItemFilter] = useState('');

  const { data: filters } = useQuery({
    queryKey: ['cfr-filters'],
    queryFn: () => client.get('/carrefour-damage/filters').then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const params = {
    date_from: dateFrom, date_to: dateTo,
    ...(branchFilter ? { branch_id: branchFilter } : {}),
    ...(itemFilter ? { item_id: itemFilter } : {}),
  };

  const { data, isLoading } = useQuery({
    queryKey: ['cfr-report', tab, params],
    queryFn: () => client.get(mode.reportPath, { params }).then(r => r.data),
    enabled: !mode.isMatrix && !mode.isSettings,
  });

  const rows = data?.rows || [];
  const totals = data?.totals || {};

  const byBranch = useMemo(() => {
    const m = new Map();
    rows.forEach(r => {
      const e = m.get(r.branch_id) || { branch_name: r.branch_name, total_qty: 0, dates: new Set() };
      e.total_qty += Number(r.quantity) || 0;
      e.dates.add(r.report_date);
      m.set(r.branch_id, e);
    });
    return [...m.values()].map(e => ({ ...e, report_count: e.dates.size }))
      .sort((a, b) => b.total_qty - a.total_qty);
  }, [rows]);

  const byItem = useMemo(() => {
    const m = new Map();
    rows.forEach(r => {
      if (!r.item_id) return;
      const e = m.get(r.item_id) || { item_name: r.item_name, total_qty: 0 };
      e.total_qty += Number(r.quantity) || 0;
      m.set(r.item_id, e);
    });
    return [...m.values()].sort((a, b) => b.total_qty - a.total_qty);
  }, [rows]);

  // One row per REPORT (not per item) — grouped by report_id, items filtered
  // to only those with a recorded (>0) quantity, so the log isn't 25 rows of
  // mostly-zero catalog noise per save. Clicking a row expands its items.
  const reportsList = useMemo(() => {
    const m = new Map();
    rows.forEach(r => {
      if (!r.report_id) return;
      const g = m.get(r.report_id) || {
        report_id: r.report_id,
        report_no: r.report_no,
        report_date: r.report_date,
        branch_name: r.branch_name,
        submitted_by_name: r.submitted_by_name,
        report_notes: r.report_notes,
        items: [],
        total_qty: 0,
      };
      if (r.item_id && Number(r.quantity) > 0) {
        g.items.push({ item_name: r.item_name, quantity: r.quantity, expiry_date: r.expiry_date, notes: r.notes });
        g.total_qty += Number(r.quantity) || 0;
      }
      m.set(r.report_id, g);
    });
    return [...m.values()].sort((a, b) => (a.report_date < b.report_date ? 1 : a.report_date > b.report_date ? -1 : 0));
  }, [rows]);

  const [expandedReportId, setExpandedReportId] = useState(null);

  // KPI summary — derived entirely from byBranch/totals so it always agrees
  // with the tables below, never a second independent computation.
  const kpis = useMemo(() => {
    const activeDays = new Set(rows.map(r => r.report_date)).size;
    const totalQty = Number(totals.total_qty) || 0;
    const branchesReported = byBranch.length;
    const top = byBranch[0] || null;
    const bottom = branchesReported ? byBranch[branchesReported - 1] : null;
    return {
      avgPerDay: activeDays ? totalQty / activeDays : 0,
      avgPerBranch: branchesReported ? totalQty / branchesReported : 0,
      complianceRate: totals.branches_total ? (totals.branches_reported / totals.branches_total) * 100 : 0,
      top, bottom,
    };
  }, [rows, byBranch, totals]);

  const rangeInvalid = dateTo < dateFrom;

  const albumParams = { report_type: tab, date_from: dateFrom, date_to: dateTo, ...(branchFilter ? { branch_id: branchFilter } : {}) };
  const { data: albumPhotos = [] } = useQuery({
    queryKey: ['cfr-album', tab, albumParams],
    queryFn: () => client.get('/carrefour-damage/album', { params: albumParams }).then(r => r.data),
    enabled: !rangeInvalid,
  });
  const albumGroups = useMemo(() => {
    const m = new Map();
    albumPhotos.forEach(p => {
      const key = `${p.branch_name}__${p.report_date}`;
      const g = m.get(key) || { branch_name: p.branch_name, report_date: p.report_date, photos: [] };
      g.photos.push(p);
      m.set(key, g);
    });
    return [...m.values()].sort((a, b) => (b.report_date > a.report_date ? 1 : -1));
  }, [albumPhotos]);

  // Excel export — respects exactly the filters currently applied to this
  // tab (date range + branch + item), same data already shown on screen
  // (reportsList / byBranch / byItem), so the file can never disagree with
  // what the user was looking at when they clicked the button.
  const handleExport = () => {
    const branchLabel = branchFilter
      ? (filters?.branches || []).find(b => String(b.id) === String(branchFilter))?.branch_name
      : 'كل الفروع';

    const wb = XLSX.utils.book_new();

    const summaryHeader = ['رقم التقرير', 'التاريخ', 'الفرع', 'المستخدم', 'عدد الأصناف المسجَّلة', `إجمالي ${mode.quantityLabel}`];
    const summaryRows = reportsList.map(rep => [
      rep.report_no ?? '', fmtDate(rep.report_date), rep.branch_name,
      rep.submitted_by_name || '', rep.items.length, Number(rep.total_qty) || 0,
    ]);
    const wsSummary = XLSX.utils.aoa_to_sheet([
      [`تصدير ${mode.label} — الفرع: ${branchLabel} — من ${dateFrom} إلى ${dateTo}`],
      [],
      summaryHeader,
      ...summaryRows,
    ]);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'سجل التقارير');

    const detailHeader = ['رقم التقرير', 'التاريخ', 'الفرع', 'الصنف', mode.quantityLabel, 'تاريخ الانتهاء', 'ملاحظات'];
    const detailRows = [];
    reportsList.forEach(rep => {
      rep.items.forEach(it => {
        detailRows.push([
          rep.report_no ?? '', fmtDate(rep.report_date), rep.branch_name,
          it.item_name, Number(it.quantity) || 0,
          it.expiry_date ? fmtDate(it.expiry_date) : '', it.notes || '',
        ]);
      });
    });
    const wsDetail = XLSX.utils.aoa_to_sheet([detailHeader, ...detailRows]);
    XLSX.utils.book_append_sheet(wb, wsDetail, 'تفاصيل الأصناف');

    const branchSuffix = branchFilter ? `_${(branchLabel || '').replace(/[^\p{L}\p{N}]+/gu, '-')}` : '';
    XLSX.writeFile(wb, `كارفور_${mode.exportLabel}${branchSuffix}_${dateFrom}_${dateTo}.xlsx`);
  };

  return (
    <div className="cfr-page">
      <div className="cfr-header">
        <h1>{mode.pageTitle}</h1>
        <p className="cfr-subtitle">{mode.pageSubtitle}</p>
      </div>

      <div className="cfr-tabs">
        {Object.values(REPORT_TABS).filter(t => !t.adminOnly || isAdmin).map(t => (
          <button
            key={t.key}
            className={`cfr-tab ${tab === t.key ? 'cfr-tab--active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!mode.isSettings && (
        <div className="cfr-card cfr-filters">
          <div className="cfr-field">
            <label>من تاريخ</label>
            <input type="date" className="cfr-input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div className="cfr-field">
            <label>إلى تاريخ</label>
            <input type="date" className="cfr-input" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
          <div className="cfr-field">
            <label>الفرع</label>
            <select className="cfr-input" value={branchFilter} onChange={e => setBranchFilter(e.target.value)}>
              <option value="">كل الفروع</option>
              {(filters?.branches || []).map(b => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
            </select>
          </div>
          {!mode.isMatrix && (
            <div className="cfr-field">
              <label>الصنف</label>
              <select className="cfr-input" value={itemFilter} onChange={e => setItemFilter(e.target.value)}>
                <option value="">كل الأصناف</option>
                {(filters?.items || []).map(it => <option key={it.id} value={it.id}>{it.item_name}</option>)}
              </select>
            </div>
          )}
          {!mode.isMatrix && (
            <div className="cfr-field cfr-export-field">
              <label>&nbsp;</label>
              <button className="cfr-btn cfr-btn--export" onClick={handleExport} disabled={rangeInvalid || reportsList.length === 0}>
                📥 تصدير Excel
              </button>
            </div>
          )}
        </div>
      )}

      {mode.isSettings && isAdmin && <CarrefourDamageSettingsPanel />}

      {!mode.isSettings && rangeInvalid && <div className="cfr-error">نطاق التاريخ غير صحيح — «إلى» قبل «من».</div>}

      {!mode.isSettings && !rangeInvalid && mode.isMatrix && (
        <PriceSurveyReportMatrix dateFrom={dateFrom} dateTo={dateTo} branchFilter={branchFilter} reportPath={mode.reportPath} />
      )}

      {!mode.isSettings && !rangeInvalid && !mode.isMatrix && (
        <>
          <div className="cfr-tiles">
            <div className="cfr-tile">
              <div className="cfr-tile__label">إجمالي {mode.quantityLabel}</div>
              <div className="cfr-tile__value">{fmt(totals.total_qty)}</div>
            </div>
            <div className="cfr-tile">
              <div className="cfr-tile__label">عدد التقارير المُدخلة</div>
              <div className="cfr-tile__value">{fmt(totals.total_reports)}</div>
            </div>
            <div className="cfr-tile">
              <div className="cfr-tile__label">الفروع التي أدخلت تقارير</div>
              <div className="cfr-tile__value">{fmt(totals.branches_reported)} / {fmt(totals.branches_total)}</div>
            </div>
          </div>

          {!isLoading && byBranch.length > 0 && (
            <div className="cfr-card">
              <div className="cfr-card__title">📊 ملخص مؤشرات الأداء</div>
              <div className="cfr-kpi-row">
                <div className="cfr-kpi">
                  <div className="cfr-kpi__label">متوسط {mode.quantityLabel} / يوم</div>
                  <div className="cfr-kpi__value">{fmt(kpis.avgPerDay)}</div>
                </div>
                <div className="cfr-kpi">
                  <div className="cfr-kpi__label">متوسط {mode.quantityLabel} / فرع</div>
                  <div className="cfr-kpi__value">{fmt(kpis.avgPerBranch)}</div>
                </div>
                <div className="cfr-kpi">
                  <div className="cfr-kpi__label">نسبة التزام الفروع بالإدخال</div>
                  <div className="cfr-kpi__value">{fmt(kpis.complianceRate)}%</div>
                </div>
                <div className="cfr-kpi">
                  <div className="cfr-kpi__label">أعلى فرع</div>
                  <div className="cfr-kpi__value cfr-kpi__value--sm">{kpis.top?.branch_name || '—'}</div>
                  <div className="cfr-kpi__sub">{kpis.top ? fmt(kpis.top.total_qty) : ''}</div>
                </div>
                <div className="cfr-kpi">
                  <div className="cfr-kpi__label">أقل فرع نشط</div>
                  <div className="cfr-kpi__value cfr-kpi__value--sm">{kpis.bottom?.branch_name || '—'}</div>
                  <div className="cfr-kpi__sub">{kpis.bottom ? fmt(kpis.bottom.total_qty) : ''}</div>
                </div>
              </div>

              <div className="cfr-branch-chart">
                <div className="cfr-branch-chart__title">مقارنة {mode.quantityLabel} بين كل الفروع</div>
                {byBranch.map(b => {
                  const pct = kpis.top?.total_qty ? Math.max(2, (b.total_qty / kpis.top.total_qty) * 100) : 0;
                  return (
                    <div key={b.branch_name} className="cfr-branch-bar-row">
                      <span className="cfr-branch-bar-label">{b.branch_name}</span>
                      <div className="cfr-branch-bar-track">
                        <div className="cfr-branch-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="cfr-branch-bar-value">{fmt(b.total_qty)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {data?.missing_latest_date?.length > 0 && (
            <div className="cfr-card cfr-alert">
              <strong>⚠ لم يتم إدخال جرد بتاريخ {fmtDate(data.latest_date)}</strong> للفروع التالية:
              <div className="cfr-alert__list">
                {data.missing_latest_date.map(b => <span key={b.id} className="cfr-chip">{b.branch_name}</span>)}
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="cfr-card cfr-empty">جاري التحميل…</div>
          ) : rows.length === 0 ? (
            <div className="cfr-card cfr-empty">لا توجد بيانات في هذه الفترة.</div>
          ) : (
            <div className="cfr-grid">
              <div className="cfr-card">
                <div className="cfr-card__title">الإجمالي حسب الفرع</div>
                <div className="cfr-table-wrap">
                  <table className="cfr-table">
                    <thead><tr><th>الفرع</th><th>{mode.quantityLabel}</th><th>عدد الأيام المُدخلة</th></tr></thead>
                    <tbody>
                      {byBranch.map(b => (
                        <tr key={b.branch_name}><td>{b.branch_name}</td><td>{fmt(b.total_qty)}</td><td>{b.report_count}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="cfr-card">
                <div className="cfr-card__title">الإجمالي حسب الصنف</div>
                <div className="cfr-table-wrap">
                  <table className="cfr-table">
                    <thead><tr><th>الصنف</th><th>{mode.quantityLabel}</th></tr></thead>
                    <tbody>
                      {byItem.map(it => (
                        <tr key={it.item_name}><td>{it.item_name}</td><td>{fmt(it.total_qty)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {albumGroups.length > 0 && (
            <div className="cfr-card">
              <div className="cfr-card__title">📷 ألبوم الصور المرفقة</div>
              <div className="cfr-album">
                {albumGroups.map(g => (
                  <div key={`${g.branch_name}__${g.report_date}`} className="cfr-album-group">
                    <div className="cfr-album-group__title">{g.branch_name} — {fmtDate(g.report_date)}</div>
                    <div className="cfr-album-group__grid">
                      {g.photos.map(p => (
                        <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer" className="cfr-album-thumb">
                          <img src={p.url} alt={p.original_filename || 'صورة'} />
                        </a>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!isLoading && reportsList.length > 0 && (
            <div className="cfr-card">
              <div className="cfr-card__title">سجل التقارير</div>
              <p className="cfr-hint">اضغط على أي تقرير لعرض الأصناف المسجَّلة له فقط (المُدخل قيمة لها).</p>
              <div className="cfr-table-wrap">
                <table className="cfr-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>رقم التقرير</th>
                      <th>التاريخ</th>
                      <th>الفرع</th>
                      <th>المستخدم</th>
                      <th>عدد الأصناف المسجَّلة</th>
                      <th>إجمالي {mode.quantityLabel}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportsList.map(rep => {
                      const isOpen = expandedReportId === rep.report_id;
                      return (
                        <React.Fragment key={rep.report_id}>
                          <tr className="cfr-report-row" onClick={() => setExpandedReportId(isOpen ? null : rep.report_id)}>
                            <td className="cfr-report-toggle">{isOpen ? '▼' : '◀'}</td>
                            <td>#{rep.report_no ?? '—'}</td>
                            <td>{fmtDate(rep.report_date)}</td>
                            <td>{rep.branch_name}</td>
                            <td>{rep.submitted_by_name || '—'}</td>
                            <td>{rep.items.length}</td>
                            <td>{fmt(rep.total_qty)}</td>
                          </tr>
                          {isOpen && (
                            <tr className="cfr-report-detail-row">
                              <td colSpan={7}>
                                {rep.report_notes && (
                                  <div className="cfr-report-detail-notes">ملاحظات عامة: {rep.report_notes}</div>
                                )}
                                {rep.items.length === 0 ? (
                                  <div className="cfr-empty">لا توجد أصناف مُدخلة بقيمة في هذا التقرير.</div>
                                ) : (
                                  <table className="cfr-table cfr-table--nested">
                                    <thead><tr><th>الصنف</th><th>{mode.quantityLabel}</th><th>تاريخ الانتهاء</th><th>ملاحظات</th></tr></thead>
                                    <tbody>
                                      {rep.items.map((it, i) => (
                                        <tr key={i}>
                                          <td>{it.item_name}</td>
                                          <td>{fmt(it.quantity)}</td>
                                          <td>{it.expiry_date ? fmtDate(it.expiry_date) : '—'}</td>
                                          <td>{it.notes || '—'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
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
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Admin settings panel — branches, item catalog, rep assignment
════════════════════════════════════════════════════════════ */
function CarrefourDamageSettingsPanel() {
  const qc = useQueryClient();
  const [newBranchName, setNewBranchName] = useState('');
  const [newBranchCode, setNewBranchCode] = useState('');
  const [newItemName, setNewItemName] = useState('');
  const [assignPick, setAssignPick] = useState({}); // { branchId: userId }
  const [newBrandName, setNewBrandName] = useState('');
  const [newSurveyItemName, setNewSurveyItemName] = useState('');
  const [newSurveyItemCategory, setNewSurveyItemCategory] = useState('');
  const [error, setError] = useState('');

  const { data: branches = [], refetch: refetchBranches } = useQuery({
    queryKey: ['cfr-admin-branches'],
    queryFn: () => client.get('/carrefour-damage/branches').then(r => r.data),
  });
  const { data: items = [], refetch: refetchItems } = useQuery({
    queryKey: ['cfr-admin-items'],
    queryFn: () => client.get('/carrefour-damage/items').then(r => r.data),
  });
  const { data: reps = [] } = useQuery({
    queryKey: ['cfr-admin-reps'],
    queryFn: () => client.get('/carrefour-damage/reps').then(r => r.data),
  });
  // "الأسعار Survey" catalogs — a brand is a matrix COLUMN, a survey item is
  // a matrix ROW; distinct from the توالف branches/items above.
  const { data: priceBrands = [], refetch: refetchPriceBrands } = useQuery({
    queryKey: ['cfr-admin-price-brands'],
    queryFn: () => client.get('/carrefour-damage/price-survey/brands').then(r => r.data),
  });
  const { data: priceItems = [], refetch: refetchPriceItems } = useQuery({
    queryKey: ['cfr-admin-price-items'],
    queryFn: () => client.get('/carrefour-damage/price-survey/items').then(r => r.data),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['cfr-filters'] });
    qc.invalidateQueries({ queryKey: ['cfe-my-branches'] });
  };

  const runAction = async (fn) => {
    setError('');
    try { await fn(); } catch (err) { setError(err?.response?.data?.error || 'حدث خطأ'); }
  };

  const addBranch = () => runAction(async () => {
    if (!newBranchName.trim()) return;
    await client.post('/carrefour-damage/branches', { branch_name: newBranchName.trim(), branch_code: newBranchCode.trim() || null });
    setNewBranchName(''); setNewBranchCode('');
    await refetchBranches(); invalidateAll();
  });

  const toggleBranchActive = (b) => runAction(async () => {
    await client.put(`/carrefour-damage/branches/${b.id}`, { is_active: !b.is_active });
    await refetchBranches(); invalidateAll();
  });

  const deleteBranch = (b) => runAction(async () => {
    if (!window.confirm(`حذف الفرع "${b.branch_name}"؟`)) return;
    await client.delete(`/carrefour-damage/branches/${b.id}`);
    await refetchBranches(); invalidateAll();
  });

  const assignRep = (branchId) => runAction(async () => {
    const userId = assignPick[branchId];
    if (!userId) return;
    await client.post(`/carrefour-damage/branches/${branchId}/assign`, { user_id: userId });
    await refetchBranches();
  });

  const unassignRep = (branchId, userId) => runAction(async () => {
    await client.delete(`/carrefour-damage/branches/${branchId}/assign/${userId}`);
    await refetchBranches();
  });

  const addItem = () => runAction(async () => {
    if (!newItemName.trim()) return;
    await client.post('/carrefour-damage/items', { item_name: newItemName.trim() });
    setNewItemName('');
    await refetchItems(); invalidateAll();
  });

  const toggleItemActive = (it) => runAction(async () => {
    await client.put(`/carrefour-damage/items/${it.id}`, { is_active: !it.is_active });
    await refetchItems(); invalidateAll();
  });

  const deleteItem = (it) => runAction(async () => {
    if (!window.confirm(`حذف الصنف "${it.item_name}"؟`)) return;
    await client.delete(`/carrefour-damage/items/${it.id}`);
    await refetchItems(); invalidateAll();
  });

  // "الأسعار Survey" catalogs — brands (columns) and survey items (rows).
  const addBrand = () => runAction(async () => {
    if (!newBrandName.trim()) return;
    await client.post('/carrefour-damage/price-survey/brands', { name: newBrandName.trim() });
    setNewBrandName('');
    await refetchPriceBrands();
  });
  const toggleBrandActive = (b) => runAction(async () => {
    await client.put(`/carrefour-damage/price-survey/brands/${b.id}`, { is_active: !b.is_active });
    await refetchPriceBrands();
  });
  const toggleBrandOwn = (b) => runAction(async () => {
    await client.put(`/carrefour-damage/price-survey/brands/${b.id}`, { is_own_brand: !b.is_own_brand });
    await refetchPriceBrands();
  });
  const deleteBrand = (b) => runAction(async () => {
    if (!window.confirm(`حذف البراند "${b.name}"؟`)) return;
    await client.delete(`/carrefour-damage/price-survey/brands/${b.id}`);
    await refetchPriceBrands();
  });

  const addSurveyItem = () => runAction(async () => {
    if (!newSurveyItemName.trim()) return;
    await client.post('/carrefour-damage/price-survey/items', {
      item_name: newSurveyItemName.trim(), category: newSurveyItemCategory.trim() || null,
    });
    setNewSurveyItemName(''); setNewSurveyItemCategory('');
    await refetchPriceItems();
  });
  const toggleSurveyItemActive = (it) => runAction(async () => {
    await client.put(`/carrefour-damage/price-survey/items/${it.id}`, { is_active: !it.is_active });
    await refetchPriceItems();
  });
  const deleteSurveyItem = (it) => runAction(async () => {
    if (!window.confirm(`حذف الصنف "${it.item_name}"؟`)) return;
    await client.delete(`/carrefour-damage/price-survey/items/${it.id}`);
    await refetchPriceItems();
  });

  return (
    <div className="cfr-settings">
      <h2 className="cfr-settings__title">⚙️ إعدادات مرتجعات كارفور (للمدير)</h2>
      {error && <div className="cfr-error">{error}</div>}

      <div className="cfr-grid">
        {/* ── Branches ── */}
        <div className="cfr-card">
          <div className="cfr-card__title">الفروع</div>
          <div className="cfr-add-row">
            <input className="cfr-input" placeholder="اسم الفرع" value={newBranchName} onChange={e => setNewBranchName(e.target.value)} />
            <input className="cfr-input cfr-input--sm" placeholder="كود (اختياري)" value={newBranchCode} onChange={e => setNewBranchCode(e.target.value)} />
            <button className="cfr-btn" onClick={addBranch} disabled={!newBranchName.trim()}>➕ إضافة</button>
          </div>
          <div className="cfr-table-wrap">
            <table className="cfr-table cfr-table--settings">
              <thead><tr><th>الفرع</th><th>المروجون</th><th>ربط مروج</th><th></th></tr></thead>
              <tbody>
                {branches.map(b => (
                  <tr key={b.id} className={!b.is_active ? 'cfr-row-inactive' : ''}>
                    <td>{b.branch_name}{b.branch_code ? ` (${b.branch_code})` : ''}{!b.is_active && ' — معطّل'}</td>
                    <td>
                      {(b.reps || []).map(r => (
                        <span key={r.user_id} className="cfr-chip cfr-chip--removable">
                          {r.name}
                          <button onClick={() => unassignRep(b.id, r.user_id)} title="إلغاء الربط">✕</button>
                        </span>
                      ))}
                      {(!b.reps || b.reps.length === 0) && <span className="cfr-muted">لا يوجد</span>}
                    </td>
                    <td>
                      <div className="cfr-assign-row">
                        <select className="cfr-input cfr-input--sm" value={assignPick[b.id] || ''}
                                onChange={e => setAssignPick(p => ({ ...p, [b.id]: e.target.value }))}>
                          <option value="">— اختر مروج —</option>
                          {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                        <button className="cfr-btn cfr-btn--sm" onClick={() => assignRep(b.id)} disabled={!assignPick[b.id]}>ربط</button>
                      </div>
                    </td>
                    <td>
                      <button className="cfr-btn cfr-btn--sm" onClick={() => toggleBranchActive(b)}>{b.is_active ? 'تعطيل' : 'تفعيل'}</button>
                      <button className="cfr-btn cfr-btn--sm cfr-btn--danger" onClick={() => deleteBranch(b)}>حذف</button>
                    </td>
                  </tr>
                ))}
                {branches.length === 0 && <tr><td colSpan={4} className="cfr-empty">لا توجد فروع بعد</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="cfr-hint">المروجون يُضافون كمستخدمين من صفحة «المستخدمون» بدور «مروج كارفور»، ثم يُربطون بالفرع هنا.</p>
        </div>

        {/* ── Item catalog ── */}
        <div className="cfr-card">
          <div className="cfr-card__title">أصناف الجرد</div>
          <div className="cfr-add-row">
            <input className="cfr-input" placeholder="اسم الصنف" value={newItemName} onChange={e => setNewItemName(e.target.value)} />
            <button className="cfr-btn" onClick={addItem} disabled={!newItemName.trim()}>➕ إضافة</button>
          </div>
          <div className="cfr-table-wrap">
            <table className="cfr-table cfr-table--settings">
              <thead><tr><th>الصنف</th><th></th></tr></thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.id} className={!it.is_active ? 'cfr-row-inactive' : ''}>
                    <td>{it.item_name}{!it.is_active && ' — معطّل'}</td>
                    <td>
                      <button className="cfr-btn cfr-btn--sm" onClick={() => toggleItemActive(it)}>{it.is_active ? 'تعطيل' : 'تفعيل'}</button>
                      <button className="cfr-btn cfr-btn--sm cfr-btn--danger" onClick={() => deleteItem(it)}>حذف</button>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && <tr><td colSpan={2} className="cfr-empty">لا توجد أصناف بعد</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── الأسعار Survey: brand catalog (matrix columns) ── */}
        <div className="cfr-card">
          <div className="cfr-card__title">براندات مسح الأسعار</div>
          <div className="cfr-add-row">
            <input className="cfr-input" placeholder="اسم البراند" value={newBrandName} onChange={e => setNewBrandName(e.target.value)} />
            <button className="cfr-btn" onClick={addBrand} disabled={!newBrandName.trim()}>➕ إضافة</button>
          </div>
          <div className="cfr-table-wrap">
            <table className="cfr-table cfr-table--settings">
              <thead><tr><th>البراند</th><th>براندنا</th><th></th></tr></thead>
              <tbody>
                {priceBrands.map(b => (
                  <tr key={b.id} className={!b.is_active ? 'cfr-row-inactive' : ''}>
                    <td>{b.name}{!b.is_active && ' — معطّل'}</td>
                    <td>
                      <button className="cfr-btn cfr-btn--sm" onClick={() => toggleBrandOwn(b)}>
                        {b.is_own_brand ? '✅ نعم' : 'تعيين'}
                      </button>
                    </td>
                    <td>
                      <button className="cfr-btn cfr-btn--sm" onClick={() => toggleBrandActive(b)}>{b.is_active ? 'تعطيل' : 'تفعيل'}</button>
                      <button className="cfr-btn cfr-btn--sm cfr-btn--danger" onClick={() => deleteBrand(b)}>حذف</button>
                    </td>
                  </tr>
                ))}
                {priceBrands.length === 0 && <tr><td colSpan={3} className="cfr-empty">لا توجد براندات بعد</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="cfr-hint">"براندنا" يحدد عمود "طريه" — عمود Average في مسح الأسعار يقارَن به مقابل متوسط باقي البراندات.</p>
        </div>

        {/* ── الأسعار Survey: item catalog (matrix rows) ── */}
        <div className="cfr-card">
          <div className="cfr-card__title">أصناف مسح الأسعار</div>
          <div className="cfr-add-row">
            <input className="cfr-input" placeholder="اسم الصنف" value={newSurveyItemName} onChange={e => setNewSurveyItemName(e.target.value)} />
            <input className="cfr-input cfr-input--sm" placeholder="التصنيف (اختياري)" value={newSurveyItemCategory} onChange={e => setNewSurveyItemCategory(e.target.value)} />
            <button className="cfr-btn" onClick={addSurveyItem} disabled={!newSurveyItemName.trim()}>➕ إضافة</button>
          </div>
          <div className="cfr-table-wrap">
            <table className="cfr-table cfr-table--settings">
              <thead><tr><th>الصنف</th><th>التصنيف</th><th></th></tr></thead>
              <tbody>
                {priceItems.map(it => (
                  <tr key={it.id} className={!it.is_active ? 'cfr-row-inactive' : ''}>
                    <td>{it.item_name}{!it.is_active && ' — معطّل'}</td>
                    <td>{it.category || '—'}</td>
                    <td>
                      <button className="cfr-btn cfr-btn--sm" onClick={() => toggleSurveyItemActive(it)}>{it.is_active ? 'تعطيل' : 'تفعيل'}</button>
                      <button className="cfr-btn cfr-btn--sm cfr-btn--danger" onClick={() => deleteSurveyItem(it)}>حذف</button>
                    </td>
                  </tr>
                ))}
                {priceItems.length === 0 && <tr><td colSpan={3} className="cfr-empty">لا توجد أصناف بعد</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="cfr-hint">التصنيف يظهر كعنوان فاصل بين الأصناف داخل جدول مسح الأسعار (مثال: الدجاج الكامل، المقطعات).</p>
        </div>
      </div>
    </div>
  );
}
