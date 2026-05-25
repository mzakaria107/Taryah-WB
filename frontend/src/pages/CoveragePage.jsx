import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Users, MapPin, TrendingUp, ShoppingCart,
  Star, Award, RefreshCw, AlertCircle,
} from 'lucide-react';
import client from '../api/client';
import './CoveragePage.css';

const MONTH_NAMES = {
  1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
  7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
};

const fmt  = n => Math.round(n ?? 0).toLocaleString('en-SA');
const fmtF = n => (n ?? 0).toLocaleString('en-SA', { maximumFractionDigits: 1 });

/* ── Day helpers ─────────────────────────────────────────────── */
function getDayOfWeek(year, month, day) {
  return new Date(year, month - 1, day).getDay(); // 0=Sun…5=Fri…6=Sat
}
function isWorkingDay(dow) { return dow !== 5; } // Friday = off

function getDayStatus(day, saleDaySet, year, month, todayDay) {
  const dow = getDayOfWeek(year, month, day);
  if (!isWorkingDay(dow)) return 'off';
  if (todayDay !== null && day > todayDay) return 'future';
  if (saleDaySet.has(day)) return 'sold';
  return 'missed';
}

function getWeekStats(weekDays, saleDaySet, year, month, todayDay) {
  let sold = 0, pastWorking = 0;
  weekDays.forEach(d => {
    const dow = getDayOfWeek(year, month, d);
    if (!isWorkingDay(dow)) return;
    if (todayDay !== null && d > todayDay) return;
    pastWorking++;
    if (saleDaySet.has(d)) sold++;
  });
  return { sold, pastWorking };
}

/* ── Week summary cell ───────────────────────────────────────── */
function WeekSumCell({ sold, pastWorking, hasDayData }) {
  if (!hasDayData || pastWorking === 0) {
    return <td className="cov-td cov-td--no-data">—</td>;
  }
  const cls = sold === 0 ? 'cov-week-sum-0'
            : sold === 1 ? 'cov-week-sum-1'
            : sold >= 3  ? 'cov-week-sum-3'
            :               'cov-week-sum-2';
  const icon = sold === 0 ? '✕' : sold >= 3 ? '✓' : sold >= 2 ? '◉' : '△';
  return (
    <td className="cov-td cov-td--week-sum">
      <span className={cls} style={{ padding: '2px 5px', borderRadius: 4, display: 'inline-block' }}>
        {icon} {sold}/{pastWorking}
      </span>
    </td>
  );
}

/* ── Day cell ────────────────────────────────────────────────── */
function DayCell({ day, status, isToday }) {
  const base = 'cov-td cov-td--day';
  const statusCls = {
    sold:   'cov-td--sold',
    missed: 'cov-td--missed',
    off:    'cov-td--off',
    future: 'cov-td--future',
  }[status] || 'cov-td--no-data';
  const icon = status === 'sold' ? '✓' : status === 'missed' ? '✕' : status === 'off' ? 'ع' : '·';
  return (
    <td className={`${base} ${statusCls}${isToday ? ' cov-td--today' : ''}`} title={`يوم ${day}`}>
      {icon}
    </td>
  );
}

/* ── Rank badge ──────────────────────────────────────────────── */
function RankBadge({ rank, total }) {
  if (!rank) return <span style={{ color: '#94a3b8' }}>—</span>;
  const cls = rank === 1 ? 'cov-rank-badge cov-rank-badge--1'
            : rank <= 3  ? 'cov-rank-badge cov-rank-badge--top'
            :               'cov-rank-badge cov-rank-badge--mid';
  return <span className={cls}>#{rank} <span style={{ fontWeight: 400 }}>/ {total}</span></span>;
}

/* ── Rep KPI cards ───────────────────────────────────────────── */
function RepProfile({ rep, period }) {
  const k = rep.kpi;
  const monthLabel = `${MONTH_NAMES[period.month]} ${period.year}`;
  const avgPerCust = k.customer_count ? k.total_qty / k.customer_count : 0;

  return (
    <div className="cov-profile">
      <div className="cov-profile-top">
        <div className="cov-avatar">{rep.name.charAt(0)}</div>
        <div>
          <div className="cov-rep-name">{rep.name}</div>
          <div className="cov-rep-branch">📍 {rep.branch || 'غير محدد'}</div>
        </div>
        <div className="cov-rep-period">📅 {monthLabel}</div>
      </div>

      <div className="cov-kpi-row">
        <div className="cov-kpi" style={{ '--cov-kpi-color': '#1d4ed8' }}>
          <div className="cov-kpi-val">{fmt(k.total_qty)}</div>
          <div className="cov-kpi-lbl">إجمالي الكميات</div>
        </div>
        <div className="cov-kpi" style={{ '--cov-kpi-color': '#0891b2' }}>
          <div className="cov-kpi-val">{fmt(k.invoice_count)}</div>
          <div className="cov-kpi-lbl">عدد الطلبيات</div>
        </div>
        <div className="cov-kpi" style={{ '--cov-kpi-color': '#059669' }}>
          <div className="cov-kpi-val">{fmt(k.customer_count)}</div>
          <div className="cov-kpi-lbl">عملاء نشطون</div>
        </div>
        <div className="cov-kpi" style={{ '--cov-kpi-color': '#7c3aed' }}>
          <div className="cov-kpi-val">{fmtF(avgPerCust)}</div>
          <div className="cov-kpi-lbl">متوسط كمية / عميل</div>
        </div>
        <div className="cov-kpi" style={{ '--cov-kpi-color': '#d97706' }}>
          <div className="cov-kpi-val">
            <RankBadge rank={k.global_rank} total={k.total_reps_global} />
          </div>
          <div className="cov-kpi-lbl">ترتيب عام (كل المناطق)</div>
        </div>
        <div className="cov-kpi" style={{ '--cov-kpi-color': '#db2777' }}>
          <div className="cov-kpi-val">
            <RankBadge rank={k.branch_rank} total={k.total_reps_branch} />
          </div>
          <div className="cov-kpi-lbl">ترتيب على مستوى المنطقة</div>
        </div>
      </div>
    </div>
  );
}

/* ── Coverage Matrix ─────────────────────────────────────────── */
function CoverageMatrix({ profile }) {
  const { rep, period, prev_customers, curr_customers, day_data, has_day_data } = profile;
  const { month, year, prev_month } = period;

  /* ── Today reference ── */
  const today = new Date();
  const todayDay = (today.getFullYear() === year && today.getMonth() + 1 === month)
    ? today.getDate() : null;

  /* ── Days in month ── */
  const daysInMonth = new Date(year, month, 0).getDate();

  /* ── Weeks (7-day chunks) ── */
  const weeks = useMemo(() => {
    const w = [];
    for (let start = 1; start <= daysInMonth; start += 7) {
      const end = Math.min(start + 6, daysInMonth);
      const days = [];
      for (let d = start; d <= end; d++) days.push(d);
      w.push(days);
    }
    return w;
  }, [daysInMonth]);

  /* ── Customer map: merge prev + curr + day data ── */
  const customers = useMemo(() => {
    const map = new Map();

    prev_customers.forEach(c => {
      map.set(c.customer_code, {
        customer_code: c.customer_code,
        customer_name: c.customer_name,
        prev_orders:   c.invoice_count,
        prev_qty:      c.total_qty,
        curr_orders:   0,
        curr_qty:      0,
        sale_days:     new Set(),
      });
    });

    curr_customers.forEach(c => {
      if (map.has(c.customer_code)) {
        const r = map.get(c.customer_code);
        r.curr_orders = c.invoice_count;
        r.curr_qty    = c.total_qty;
      } else {
        map.set(c.customer_code, {
          customer_code: c.customer_code,
          customer_name: c.customer_name,
          prev_orders:   0,
          prev_qty:      0,
          curr_orders:   c.invoice_count,
          curr_qty:      c.total_qty,
          sale_days:     new Set(),
        });
      }
    });

    day_data.forEach(d => {
      if (map.has(d.customer_code)) map.get(d.customer_code).sale_days.add(d.day);
    });

    return [...map.values()].sort((a, b) => b.prev_qty - a.prev_qty);
  }, [prev_customers, curr_customers, day_data]);

  /* ── Coverage stats ── */
  const covStats = useMemo(() => {
    if (!has_day_data) return null;
    let covered0 = 0, covered1 = 0, covered2 = 0, covered3plus = 0;
    // Count per customer for current (full) past working days so far
    customers.forEach(c => {
      // total visits in current month
      const visits = c.sale_days.size;
      if (visits === 0) covered0++;
      else if (visits === 1) covered1++;
      else if (visits === 2) covered2++;
      else covered3plus++;
    });
    return { covered0, covered1, covered2, covered3plus, total: customers.length };
  }, [customers, has_day_data]);

  /* ── Determine which week index is "current" ── */
  const currentWeekIdx = useMemo(() => {
    if (!todayDay) return null;
    return Math.floor((todayDay - 1) / 7);
  }, [todayDay]);

  return (
    <div className="cov-matrix-card">
      <h3 className="cov-section-title">
        📋 مصفوفة التغطية
        <span>
          الشهر السابق: {MONTH_NAMES[period.prev_month]} · الشهر الحالي: {MONTH_NAMES[period.month]}
        </span>
      </h3>

      {!has_day_data && (
        <div className="cov-no-day-notice">
          <AlertCircle size={15}/>
          البيانات اليومية غير متوفرة لهذا الشهر — يُعرض ملخص الشهر فقط. لعرض التتبع اليومي يرجى رفع تقرير مبيعات يومي.
        </div>
      )}

      {customers.length === 0 ? (
        <div className="cov-empty">لا يوجد عملاء لهذا المندوب في الفترة المحددة</div>
      ) : (
        <>
          <div className="cov-table-scroll">
            <table className="cov-table">
              <colgroup>
                <col className="cov-col-name" />
                <col className="cov-col-num" />
                <col className="cov-col-num" />
                {/* spacer */}
                <col className="cov-col-wsep" />
                {weeks.map((wk, wi) => (
                  <React.Fragment key={wi}>
                    {/* summary col */}
                    <col className="cov-col-num" />
                    {/* day cols */}
                    {wk.map(d => <col key={d} className="cov-col-day" />)}
                    {/* spacer between weeks */}
                    {wi < weeks.length - 1 && <col className="cov-col-wsep" />}
                  </React.Fragment>
                ))}
              </colgroup>

              <thead className="cov-thead">
                {/* Row 1: week headers */}
                <tr>
                  <th className="cov-th-fixed cov-th-fixed--name" rowSpan={2}>العميل</th>
                  <th className="cov-th-fixed" rowSpan={2}>طلبيات<br/>{MONTH_NAMES[prev_month]}</th>
                  <th className="cov-th-fixed" rowSpan={2}>كمية<br/>{MONTH_NAMES[prev_month]}</th>
                  {/* spacer */}
                  <th className="cov-col-wsep" rowSpan={2}></th>
                  {weeks.map((wk, wi) => {
                    const isCurrent = wi === currentWeekIdx;
                    const isFuture  = currentWeekIdx !== null && wi > currentWeekIdx;
                    const weekCls = isCurrent ? 'cov-th-week cov-th-week--current'
                                  : isFuture  ? 'cov-th-week cov-th-week--future'
                                  :              'cov-th-week';
                    return (
                      <React.Fragment key={wi}>
                        <th className={weekCls} colSpan={wk.length + 1}
                            title={`${wk[0]}–${wk[wk.length - 1]} ${MONTH_NAMES[month]}`}>
                          الأسبوع {wi + 1}
                          {isCurrent && ' ◀'}
                        </th>
                        {wi < weeks.length - 1 && <th className="cov-col-wsep" rowSpan={2}></th>}
                      </React.Fragment>
                    );
                  })}
                </tr>

                {/* Row 2: sub-labels per week (summary + days) */}
                <tr>
                  {weeks.map((wk, wi) => (
                    <React.Fragment key={wi}>
                      {/* summary column header */}
                      <th className="cov-th-fixed" style={{ fontSize: '0.65rem', background: '#f0fdf4', color: '#166534' }}>
                        أداء<br/>الأسبوع
                      </th>
                      {/* day number headers */}
                      {wk.map(d => {
                        const dow  = getDayOfWeek(year, month, d);
                        const isOff = !isWorkingDay(dow);
                        const isToday = d === todayDay;
                        const isFut  = todayDay !== null && d > todayDay;
                        const cls = isToday  ? 'cov-th-day cov-th-day--today'
                                  : isOff    ? 'cov-th-day cov-th-day--off'
                                  : isFut    ? 'cov-th-day cov-th-day--future'
                                  :             'cov-th-day';
                        return <th key={d} className={cls}>{d}</th>;
                      })}
                    </React.Fragment>
                  ))}
                </tr>
              </thead>

              <tbody>
                {customers.map(cust => (
                  <tr key={cust.customer_code}
                      className={`cov-tr${cust.prev_orders === 0 ? ' cov-tr--no-prev' : ''}`}>

                    {/* Customer name */}
                    <td className="cov-td cov-td--name">
                      <span className="cov-cust-name">{cust.customer_name}</span>
                      <span className="cov-cust-code">{cust.customer_code}</span>
                    </td>

                    {/* Prev month orders */}
                    <td className="cov-td cov-td--num">
                      {cust.prev_orders > 0
                        ? <span className="cov-orders-badge">{cust.prev_orders}</span>
                        : <span style={{ color: '#cbd5e1' }}>—</span>}
                    </td>

                    {/* Prev month qty */}
                    <td className="cov-td cov-td--num">
                      {cust.prev_qty > 0
                        ? <span className="cov-qty-badge">{fmt(cust.prev_qty)}</span>
                        : <span style={{ color: '#cbd5e1' }}>—</span>}
                    </td>

                    {/* Spacer */}
                    <td className="cov-td cov-td--sep"></td>

                    {/* Weeks */}
                    {weeks.map((wk, wi) => {
                      const stats = getWeekStats(wk, cust.sale_days, year, month, todayDay);
                      return (
                        <React.Fragment key={wi}>
                          {/* Week summary */}
                          <WeekSumCell
                            sold={stats.sold}
                            pastWorking={stats.pastWorking}
                            hasDayData={has_day_data}
                          />
                          {/* Day cells */}
                          {wk.map(d => {
                            const status  = has_day_data
                              ? getDayStatus(d, cust.sale_days, year, month, todayDay)
                              : 'no-data';
                            return <DayCell key={d} day={d} status={status} isToday={d === todayDay} />;
                          })}
                          {/* Spacer between weeks */}
                          {wi < weeks.length - 1 && <td className="cov-td cov-td--sep"></td>}
                        </React.Fragment>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="cov-legend">
            <span className="cov-legend-item">
              <span className="cov-legend-dot" style={{ background: '#d1fae5', border: '1px solid #86efac' }}/>
              تم البيع
            </span>
            <span className="cov-legend-item">
              <span className="cov-legend-dot" style={{ background: '#fee2e2', border: '1px solid #fca5a5' }}/>
              لم يُباع (يوم عمل فات)
            </span>
            <span className="cov-legend-item">
              <span className="cov-legend-dot" style={{ background: '#f5f3ff', border: '1px solid #c4b5fd' }}/>
              عطلة (جمعة)
            </span>
            <span className="cov-legend-item">
              <span className="cov-legend-dot" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}/>
              أيام قادمة
            </span>
            <span style={{ marginRight: 'auto', fontSize: '0.72rem', color: '#64748b' }}>
              الهدف: <strong>3</strong> زيارات/أسبوع · الحد الأدنى: <strong>2</strong> زيارات/أسبوع
            </span>
          </div>

          {/* Footer stats */}
          {covStats && (
            <div className="cov-footer-stats">
              <span className="cov-stat-chip">إجمالي العملاء: <strong>{covStats.total}</strong></span>
              <span className="cov-stat-chip" style={{ background: '#d1fae5' }}>
                ≥ 3 زيارات: <strong>{covStats.covered3plus}</strong>
              </span>
              <span className="cov-stat-chip" style={{ background: '#dcfce7' }}>
                2 زيارات: <strong>{covStats.covered2}</strong>
              </span>
              <span className="cov-stat-chip" style={{ background: '#fef3c7' }}>
                زيارة واحدة: <strong>{covStats.covered1}</strong>
              </span>
              <span className="cov-stat-chip" style={{ background: '#fee2e2' }}>
                بدون زيارة: <strong>{covStats.covered0}</strong>
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════ */
export default function CoveragePage() {
  const now   = new Date();
  const [branch,  setBranch]  = useState('');
  const [repName, setRepName] = useState('');
  const [month,   setMonth]   = useState(now.getMonth() + 1);
  const [year,    setYear]    = useState(now.getFullYear());

  /* ── Filters ── */
  const { data: filters, isLoading: filtersLoading } = useQuery({
    queryKey: ['coverage-filters', year],
    queryFn:  () => client.get(`/coverage/filters?year=${year}`).then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const availableReps = useMemo(() => {
    if (!filters?.reps) return [];
    return branch ? filters.reps.filter(r => r.branch === branch) : filters.reps;
  }, [filters, branch]);

  /* ── Profile ── */
  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ['coverage-profile', repName, month, year],
    queryFn:  () => client.get(`/coverage/profile?rep=${encodeURIComponent(repName)}&month=${month}&year=${year}`).then(r => r.data),
    enabled:  !!repName,
    staleTime: 3 * 60 * 1000,
  });

  const prevMonthName = MONTH_NAMES[month === 1 ? 12 : month - 1];

  return (
    <div className="cov-page">

      {/* ── Header ── */}
      <div className="cov-header">
        <div>
          <h1 className="cov-title">👥 تغطية المناديب</h1>
          <p className="cov-subtitle">بروفايل أداء المندوب وتتبع تغطية العملاء أسبوعياً</p>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="cov-filters">

        {/* Branch / Route */}
        <div className="cov-filter-group">
          <label className="cov-filter-label">📍 المنطقة / خط السير</label>
          <select
            className="cov-select"
            value={branch}
            onChange={e => { setBranch(e.target.value); setRepName(''); }}
          >
            <option value="">الكل</option>
            {(filters?.branches || []).map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>

        {/* Rep */}
        <div className="cov-filter-group">
          <label className="cov-filter-label">👤 المندوب</label>
          <select
            className="cov-select cov-select--rep"
            value={repName}
            onChange={e => setRepName(e.target.value)}
            disabled={filtersLoading}
          >
            <option value="">-- اختر مندوباً --</option>
            {availableReps.map(r => (
              <option key={r.name} value={r.name}>
                {r.name}{r.branch && branch === '' ? ` (${r.branch})` : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Month */}
        <div className="cov-filter-group cov-filter-group--sm">
          <label className="cov-filter-label">🗓 الشهر الحالي</label>
          <select
            className="cov-select"
            value={month}
            onChange={e => setMonth(Number(e.target.value))}
          >
            {Object.entries(MONTH_NAMES).map(([v, lbl]) => (
              <option key={v} value={v}>{lbl}</option>
            ))}
          </select>
        </div>

        {/* Year */}
        <div className="cov-filter-group cov-filter-group--sm">
          <label className="cov-filter-label">📆 السنة</label>
          <select
            className="cov-select"
            value={year}
            onChange={e => setYear(Number(e.target.value))}
          >
            {[2024, 2025, 2026, 2027].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>

        {repName && (
          <button className="cov-btn-clear cov-no-print" onClick={() => setRepName('')}>
            ✕ مسح
          </button>
        )}
      </div>

      {/* ── Content ── */}
      {!repName ? (
        <div className="cov-empty">
          <span className="cov-empty-icon">👤</span>
          اختر مندوباً من القائمة أعلاه لعرض بروفايل الأداء ومصفوفة التغطية
        </div>
      ) : profileLoading ? (
        <div className="cov-loading">
          <RefreshCw size={20} className="srp-spin" />
          <span>جارٍ تحميل بيانات المندوب…</span>
        </div>
      ) : profile ? (
        <>
          <RepProfile rep={profile.rep} period={profile.period} />
          <CoverageMatrix profile={profile} />
        </>
      ) : (
        <div className="cov-empty">
          <AlertCircle size={32} style={{ color: '#f59e0b', marginBottom: 8 }} />
          <div>لا توجد بيانات لهذا المندوب في الفترة المحددة</div>
        </div>
      )}

    </div>
  );
}
