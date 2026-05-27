import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  RefreshCw, AlertCircle, BarChart2, UserCheck,
  FileSpreadsheet, Printer,
} from 'lucide-react';
import client from '../api/client';
import './CoveragePage.css';

/* ── Working-days helpers ────────────────────────────────────── */
function calcWorkingDays(year, month) {
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const endDay = isCurrentMonth ? today.getDate() : new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= endDay; d++) {
    if (new Date(year, month - 1, d).getDay() !== 5) count++;
  }
  return Math.max(count, 1);
}

/* Build 7-day week arrays for a month (same logic as CoverageMatrix) */
function buildWeeks(year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const weeks = [];
  for (let start = 1; start <= daysInMonth; start += 7) {
    const end = Math.min(start + 6, daysInMonth);
    const days = [];
    for (let d = start; d <= end; d++) days.push(d);
    weeks.push(days);
  }
  return weeks;
}

/* Working days inside a week's day array, up to todayDay (null = full week) */
function workDaysInWeek(weekDays, year, month, todayDay) {
  let count = 0;
  for (const d of weekDays) {
    if (todayDay !== null && d > todayDay) break;
    if (new Date(year, month - 1, d).getDay() !== 5) count++;
  }
  return count;
}

/**
 * Active working days for a rep:
 * Sum of working days only in weeks where the rep had ≥1 visit.
 * Weeks with 0 visits are excluded from the denominator.
 */
function calcActiveWorkDays(repWeeks, year, month) {
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
  const todayDay = isCurrentMonth ? today.getDate() : null;
  const weeks = buildWeeks(year, month);
  let active = 0;
  repWeeks.forEach((wk, wi) => {
    if (wi >= weeks.length) return;
    if (wk.visits > 0) {
      active += workDaysInWeek(weeks[wi], year, month, todayDay);
    }
  });
  return Math.max(active, 1);
}

/* ── Export helpers ──────────────────────────────────────────── */
function downloadCSV(filename, rows) {
  // UTF-8 BOM so Excel renders Arabic correctly
  const bom  = '﻿';
  const body = rows.map(r =>
    r.map(c => (c === null || c === undefined ? '' : String(c).includes(',') ? `"${c}"` : c)).join(',')
  ).join('\r\n');
  const blob = new Blob([bom + body], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename + '.csv'; a.click();
  URL.revokeObjectURL(url);
}

function exportRankingCSV(reps, period) {
  const month = MONTH_NAMES[period.month] + ' ' + period.year;
  const wDays = period.workingDays || calcWorkingDays(period.year, period.month);
  const headers = ['#', 'المندوب', 'المنطقة', 'إجمالي العملاء',
    'أسبوع 1 %', 'أسبوع 2 %', 'أسبوع 3 %', 'أسبوع 4 %', 'أسبوع 5 %',
    'إجمالي التغطية %', 'كفاءة ≥2 زيارة %', 'إجمالي الزيارات',
    'إجمالي الكميات', 'متوسط كمية/يوم', 'متوسط زيارات/يوم'];
  const dataRows = reps.map(r => {
    const activeWD  = r.has_day_data ? calcActiveWorkDays(r.weeks, period.year, period.month) : 0;
    const avgVisits = activeWD > 0 ? (r.overall.visits / activeWD).toFixed(1) : '—';
    return [
      r.rank, r.rep_name, r.branch_name, r.total_customers,
      r.weeks[0].pct, r.weeks[1].pct, r.weeks[2].pct, r.weeks[3].pct, r.weeks[4].pct,
      r.overall.pct, r.overall.effPct, r.overall.visits,
      r.total_qty,
      Math.round(r.total_qty / wDays),
      avgVisits,
    ];
  });
  downloadCSV(`ترتيب_المناديب_${month}`, [headers, ...dataRows]);
}

function exportProfileCSV(customers, period) {
  const month = MONTH_NAMES[period.month] + ' ' + period.year;
  const prevM = MONTH_NAMES[period.prev_month];
  const headers = ['كود العميل', 'اسم العميل', `طلبيات ${prevM}`, `كمية ${prevM}`, 'إجمالي الزيارات (الشهر الحالي)'];
  const dataRows = customers.map(c => [
    c.customer_code, c.customer_name, c.prev_orders, c.prev_qty, c.sale_days ? c.sale_days.size : 0,
  ]);
  downloadCSV(`تغطية_عملاء_${month}`, [headers, ...dataRows]);
}

function triggerPrint(title) {
  const prev = document.title;
  document.title = title;
  window.print();
  window.onafterprint = () => { document.title = prev; window.onafterprint = null; };
}

const MONTH_NAMES = {
  1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
  7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
};

const fmt  = n => Math.round(n ?? 0).toLocaleString('en-SA');
const fmtF = n => (n ?? 0).toLocaleString('en-SA', { maximumFractionDigits: 1 });

/* ── Day helpers ─────────────────────────────────────────────── */
function getDayOfWeek(year, month, day) {
  return new Date(year, month - 1, day).getDay();
}
function isWorkingDay(dow) { return dow !== 5; }

function getDayStatus(day, saleDaySet, year, month, todayDay) {
  const dow = getDayOfWeek(year, month, day);
  if (saleDaySet.has(day)) return 'sold';
  if (!isWorkingDay(dow)) return 'off';
  if (todayDay !== null && day > todayDay) return 'future';
  return 'missed';
}

function getWeekStats(weekDays, saleDaySet, year, month, todayDay) {
  let sold = 0, pastWorking = 0;
  weekDays.forEach(d => {
    const dow     = getDayOfWeek(year, month, d);
    const hasSale = saleDaySet.has(d);
    const isFuture = todayDay !== null && d > todayDay;
    if (isFuture) return;
    if (!isWorkingDay(dow)) {
      if (hasSale) { sold++; pastWorking++; }
      return;
    }
    pastWorking++;
    if (hasSale) sold++;
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
      <span className={cls}>{icon} {sold}/{pastWorking}</span>
    </td>
  );
}

/* ── Day cell ────────────────────────────────────────────────── */
function DayCell({ day, status, isToday }) {
  const statusCls = {
    sold:   'cov-td--sold',
    missed: 'cov-td--missed',
    off:    'cov-td--off',
    future: 'cov-td--future',
  }[status] || 'cov-td--no-data';
  const icon = status === 'sold' ? '✓' : status === 'missed' ? '✕' : status === 'off' ? 'ع' : '·';
  return (
    <td className={`cov-td cov-td--day ${statusCls}${isToday ? ' cov-td--today' : ''}`} title={`يوم ${day}`}>
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

  const today = new Date();
  const todayDay = (today.getFullYear() === year && today.getMonth() + 1 === month)
    ? today.getDate() : null;

  const daysInMonth = new Date(year, month, 0).getDate();

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

  const customers = useMemo(() => {
    const map = new Map();
    prev_customers.forEach(c => {
      map.set(c.customer_code, {
        customer_code: c.customer_code,
        customer_name: c.customer_name,
        prev_orders:   c.invoice_count,
        prev_qty:      c.total_qty,
        curr_orders:   0, curr_qty: 0,
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
          prev_orders: 0, prev_qty: 0,
          curr_orders: c.invoice_count,
          curr_qty:    c.total_qty,
          sale_days:   new Set(),
        });
      }
    });
    day_data.forEach(d => {
      if (map.has(d.customer_code)) map.get(d.customer_code).sale_days.add(d.day);
    });
    return [...map.values()].sort((a, b) => b.prev_qty - a.prev_qty);
  }, [prev_customers, curr_customers, day_data]);

  const covStats = useMemo(() => {
    if (!has_day_data) return null;
    let covered0 = 0, covered1 = 0, covered2 = 0, covered3plus = 0;
    customers.forEach(c => {
      const v = c.sale_days.size;
      if (v === 0) covered0++;
      else if (v === 1) covered1++;
      else if (v === 2) covered2++;
      else covered3plus++;
    });
    return { covered0, covered1, covered2, covered3plus, total: customers.length };
  }, [customers, has_day_data]);

  const weeklyStats = useMemo(() => {
    if (!has_day_data || customers.length === 0) return null;
    return weeks.map(wk => {
      let totalVisits = 0, customersVisited = 0, customersEfficient = 0;
      customers.forEach(c => {
        const cnt = wk.filter(d => c.sale_days.has(d)).length;
        totalVisits += cnt;
        if (cnt > 0) customersVisited++;
        if (cnt >= 2) customersEfficient++;
      });
      const n = customers.length;
      return {
        totalVisits,
        customersVisited,
        customersEfficient,
        coveragePct:    Math.round(customersVisited   / n * 100),
        efficiencyPct:  Math.round(customersEfficient / n * 100),
      };
    });
  }, [weeks, customers, has_day_data]);

  const overallCov = useMemo(() => {
    if (!weeklyStats) return null;
    const totalVisits      = weeklyStats.reduce((s, w) => s + w.totalVisits, 0);
    const customersVisited = customers.filter(c => c.sale_days.size > 0).length;
    const activeWeeks      = weeklyStats.filter(w => w.totalVisits > 0);
    const avgEfficiencyPct = activeWeeks.length > 0
      ? Math.round(activeWeeks.reduce((s, w) => s + w.efficiencyPct, 0) / activeWeeks.length)
      : 0;
    return {
      totalVisits, customersVisited, avgEfficiencyPct,
      coveragePct: customers.length > 0 ? Math.round(customersVisited / customers.length * 100) : 0,
      total: customers.length,
    };
  }, [weeklyStats, customers]);

  const currentWeekIdx = useMemo(() => {
    if (!todayDay) return null;
    return Math.floor((todayDay - 1) / 7);
  }, [todayDay]);

  const monthLabel = `${MONTH_NAMES[month]} ${year}`;

  return (
    <div className="cov-matrix-card">
      <div className="cov-section-title">
        <span>📋 مصفوفة التغطية</span>
        <span className="cov-section-count">الشهر السابق: {MONTH_NAMES[period.prev_month]} · الحالي: {MONTH_NAMES[month]}</span>
        <div className="cov-export-btns cov-no-print">
          <button className="cov-export-btn cov-export-btn--excel"
            onClick={() => exportProfileCSV(customers, period)}
            title="تصدير بيانات العملاء Excel">
            <FileSpreadsheet size={14}/> Excel
          </button>
          <button className="cov-export-btn cov-export-btn--pdf"
            onClick={() => triggerPrint(`بروفايل ${rep.name} — ${monthLabel}`)}
            title="تصدير PDF">
            <Printer size={14}/> PDF
          </button>
        </div>
      </div>

      {!has_day_data && (
        <div className="cov-no-day-notice">
          <AlertCircle size={15}/>
          البيانات اليومية غير متوفرة لهذا الشهر — يُعرض ملخص الشهر فقط. لعرض التتبع اليومي يرجى رفع تقرير مبيعات يومي.
        </div>
      )}

      {/* ── Coverage Rate Card ── */}
      {weeklyStats && overallCov && (
        <div className="cov-rate-card">
          <div className="cov-rate-header">
            <span className="cov-rate-title">📊 نسبة التغطية الأسبوعية</span>
            <span className="cov-rate-subtitle">عدد العملاء المزارين لكل أسبوع من إجمالي {overallCov.total} عميل</span>
          </div>
          <div className="cov-rate-weeks">
            {weeklyStats.map((ws, wi) => {
              const isCurrent = wi === currentWeekIdx;
              const isFuture  = currentWeekIdx !== null && wi > currentWeekIdx;
              const pct    = ws.coveragePct;
              const effPct = ws.efficiencyPct;
              const barCls = pct >= 90 ? 'cov-rate-bar-fill--high' : pct >= 70 ? 'cov-rate-bar-fill--good' : pct >= 40 ? 'cov-rate-bar-fill--mid' : 'cov-rate-bar-fill--low';
              const pctCls = pct >= 90 ? 'cov-rate-pct--high' : pct >= 70 ? 'cov-rate-pct--good' : pct >= 40 ? 'cov-rate-pct--mid' : 'cov-rate-pct--low';
              const effCls = effPct >= 70 ? 'cov-eff-high' : effPct >= 40 ? 'cov-eff-mid' : 'cov-eff-low';
              return (
                <div key={wi} className={`cov-rate-week${isCurrent ? ' cov-rate-week--current' : ''}${isFuture ? ' cov-rate-week--future' : ''}`}>
                  <div className="cov-rate-week-label">
                    الأسبوع {wi + 1}
                    {isCurrent && <span className="cov-rate-now-badge">الآن</span>}
                  </div>
                  <div className={`cov-rate-pct ${pctCls}`}>{isFuture ? '—' : `${pct}%`}</div>
                  <div className="cov-rate-bar">
                    <div className={`cov-rate-bar-fill ${barCls}`} style={{ width: isFuture ? '0%' : `${pct}%` }}/>
                  </div>
                  <div className="cov-rate-visits">
                    {isFuture ? <span style={{ color: '#cbd5e1' }}>لم يبدأ</span> : (
                      <><strong>{ws.customersVisited}</strong><span> / {overallCov.total}</span><span className="cov-rate-vis-count"> · {ws.totalVisits} زيارة</span></>
                    )}
                  </div>
                  {/* Efficiency indicator */}
                  {!isFuture && (
                    <div className="cov-eff-row">
                      <span className="cov-eff-label">كفاءة ≥2</span>
                      <span className={`cov-eff-pct ${effCls}`}>{effPct}%</span>
                      <div className="cov-eff-bar">
                        <div className={`cov-eff-fill ${effCls}`} style={{ width: `${effPct}%` }}/>
                      </div>
                      <span className="cov-eff-count">{ws.customersEfficient} عميل</span>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="cov-rate-week cov-rate-week--total">
              <div className="cov-rate-week-label">الإجمالي</div>
              <div className={`cov-rate-pct ${overallCov.coveragePct >= 90 ? 'cov-rate-pct--high' : overallCov.coveragePct >= 70 ? 'cov-rate-pct--good' : overallCov.coveragePct >= 40 ? 'cov-rate-pct--mid' : 'cov-rate-pct--low'}`}>
                {overallCov.coveragePct}%
              </div>
              <div className="cov-rate-bar">
                <div className={`cov-rate-bar-fill ${overallCov.coveragePct >= 90 ? 'cov-rate-bar-fill--high' : overallCov.coveragePct >= 70 ? 'cov-rate-bar-fill--good' : overallCov.coveragePct >= 40 ? 'cov-rate-bar-fill--mid' : 'cov-rate-bar-fill--low'}`}
                     style={{ width: `${overallCov.coveragePct}%` }}/>
              </div>
              <div className="cov-rate-visits">
                <strong>{overallCov.customersVisited}</strong>
                <span> / {overallCov.total} عميل</span>
                <span className="cov-rate-vis-count"> · {overallCov.totalVisits} زيارة</span>
              </div>
              {/* Overall efficiency */}
              <div className="cov-eff-row">
                <span className="cov-eff-label">كفاءة ≥2</span>
                <span className={`cov-eff-pct ${overallCov.avgEfficiencyPct >= 70 ? 'cov-eff-high' : overallCov.avgEfficiencyPct >= 40 ? 'cov-eff-mid' : 'cov-eff-low'}`}>
                  {overallCov.avgEfficiencyPct}%
                </span>
                <div className="cov-eff-bar">
                  <div className={`cov-eff-fill ${overallCov.avgEfficiencyPct >= 70 ? 'cov-eff-high' : overallCov.avgEfficiencyPct >= 40 ? 'cov-eff-mid' : 'cov-eff-low'}`}
                       style={{ width: `${overallCov.avgEfficiencyPct}%` }}/>
                </div>
                <span className="cov-eff-count">متوسط</span>
              </div>
            </div>
          </div>
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
                <col className="cov-col-wsep" />
                {weeks.map((wk, wi) => (
                  <React.Fragment key={wi}>
                    <col className="cov-col-num" />
                    {wk.map(d => <col key={d} className="cov-col-day" />)}
                    {wi < weeks.length - 1 && <col className="cov-col-wsep" />}
                  </React.Fragment>
                ))}
              </colgroup>
              <thead className="cov-thead">
                <tr>
                  <th className="cov-th-fixed cov-th-fixed--name" rowSpan={2}>العميل</th>
                  <th className="cov-th-fixed" rowSpan={2}>طلبيات<br/>{MONTH_NAMES[prev_month]}</th>
                  <th className="cov-th-fixed" rowSpan={2}>كمية<br/>{MONTH_NAMES[prev_month]}</th>
                  <th className="cov-col-wsep" rowSpan={2}></th>
                  {weeks.map((wk, wi) => {
                    const isCurrent = wi === currentWeekIdx;
                    const isFuture  = currentWeekIdx !== null && wi > currentWeekIdx;
                    const weekCls = isCurrent ? 'cov-th-week cov-th-week--current' : isFuture ? 'cov-th-week cov-th-week--future' : 'cov-th-week';
                    return (
                      <React.Fragment key={wi}>
                        <th className={weekCls} colSpan={wk.length + 1} title={`${wk[0]}–${wk[wk.length - 1]} ${MONTH_NAMES[month]}`}>
                          الأسبوع {wi + 1}{isCurrent && ' ◀'}
                        </th>
                        {wi < weeks.length - 1 && <th className="cov-col-wsep" rowSpan={2}></th>}
                      </React.Fragment>
                    );
                  })}
                </tr>
                <tr>
                  {weeks.map((wk, wi) => (
                    <React.Fragment key={wi}>
                      <th className="cov-th-fixed" style={{ fontSize: '0.65rem', background: '#f0fdf4', color: '#166534' }}>أداء<br/>الأسبوع</th>
                      {wk.map(d => {
                        const dow = getDayOfWeek(year, month, d);
                        const isOff = !isWorkingDay(dow);
                        const isToday = d === todayDay;
                        const isFut = todayDay !== null && d > todayDay;
                        const cls = isToday ? 'cov-th-day cov-th-day--today' : isOff ? 'cov-th-day cov-th-day--off' : isFut ? 'cov-th-day cov-th-day--future' : 'cov-th-day';
                        return <th key={d} className={cls}>{d}</th>;
                      })}
                    </React.Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {customers.map(cust => (
                  <tr key={cust.customer_code} className={`cov-tr${cust.prev_orders === 0 ? ' cov-tr--no-prev' : ''}`}>
                    <td className="cov-td cov-td--name">
                      <span className="cov-cust-name">{cust.customer_name}</span>
                      <span className="cov-cust-code">{cust.customer_code}</span>
                    </td>
                    <td className="cov-td cov-td--num">
                      {cust.prev_orders > 0 ? <span className="cov-orders-badge">{cust.prev_orders}</span> : <span style={{ color: '#cbd5e1' }}>—</span>}
                    </td>
                    <td className="cov-td cov-td--num">
                      {cust.prev_qty > 0 ? <span className="cov-qty-badge">{fmt(cust.prev_qty)}</span> : <span style={{ color: '#cbd5e1' }}>—</span>}
                    </td>
                    <td className="cov-td cov-td--sep"></td>
                    {weeks.map((wk, wi) => {
                      const stats = getWeekStats(wk, cust.sale_days, year, month, todayDay);
                      return (
                        <React.Fragment key={wi}>
                          <WeekSumCell sold={stats.sold} pastWorking={stats.pastWorking} hasDayData={has_day_data}/>
                          {wk.map(d => {
                            const status = has_day_data ? getDayStatus(d, cust.sale_days, year, month, todayDay) : 'no-data';
                            return <DayCell key={d} day={d} status={status} isToday={d === todayDay}/>;
                          })}
                          {wi < weeks.length - 1 && <td className="cov-td cov-td--sep"></td>}
                        </React.Fragment>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="cov-legend">
            <span className="cov-legend-item"><span className="cov-legend-dot" style={{ background: '#d1fae5', border: '1px solid #86efac' }}/>تم البيع</span>
            <span className="cov-legend-item"><span className="cov-legend-dot" style={{ background: '#fee2e2', border: '1px solid #fca5a5' }}/>لم يُباع (يوم عمل فات)</span>
            <span className="cov-legend-item"><span className="cov-legend-dot" style={{ background: '#f5f3ff', border: '1px solid #c4b5fd' }}/>عطلة (جمعة)</span>
            <span className="cov-legend-item"><span className="cov-legend-dot" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}/>أيام قادمة</span>
            <span style={{ marginRight: 'auto', fontSize: '0.72rem', color: '#64748b' }}>
              الهدف: <strong>3</strong> زيارات/أسبوع · الحد الأدنى: <strong>2</strong> زيارات/أسبوع
            </span>
          </div>

          {covStats && (
            <div className="cov-footer-stats">
              <span className="cov-stat-chip">إجمالي العملاء: <strong>{covStats.total}</strong></span>
              <span className="cov-stat-chip" style={{ background: '#d1fae5' }}>≥ 3 زيارات: <strong>{covStats.covered3plus}</strong></span>
              <span className="cov-stat-chip" style={{ background: '#dcfce7' }}>2 زيارات: <strong>{covStats.covered2}</strong></span>
              <span className="cov-stat-chip" style={{ background: '#fef3c7' }}>زيارة واحدة: <strong>{covStats.covered1}</strong></span>
              <span className="cov-stat-chip" style={{ background: '#fee2e2' }}>بدون زيارة: <strong>{covStats.covered0}</strong></span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   RANKING TAB COMPONENTS
   ══════════════════════════════════════════════════════════════ */

/* ── Coverage % cell in ranking table ───────────────────────── */
function PctCell({ pct, visited, total, hasDayData }) {
  if (!hasDayData) {
    return <td className="cov-rtd cov-rtd--nodata" title="لا توجد بيانات يومية">—</td>;
  }
  const cls = pct >= 90 ? 'cov-rtd--high' : pct >= 70 ? 'cov-rtd--good' : pct >= 40 ? 'cov-rtd--mid' : 'cov-rtd--low';
  return (
    <td className={`cov-rtd ${cls}`} title={`${visited} / ${total} عميل`}>
      <div className="cov-rtd-val">{pct}%</div>
      <div className="cov-rtd-bar"><div className="cov-rtd-fill" style={{ width: `${pct}%` }}/></div>
    </td>
  );
}

/* ── Ranking matrix table ────────────────────────────────────── */
function RankingMatrix({ reps, workingDays, year, month }) {
  const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const fmtN = n => Math.round(n ?? 0).toLocaleString('en-SA');
  return (
    <div className="cov-rtable-wrap">
      <table className="cov-rtable">
        <thead>
          <tr>
            <th className="cov-rth cov-rth--rank">#</th>
            <th className="cov-rth cov-rth--name">المندوب</th>
            <th className="cov-rth">المنطقة</th>
            <th className="cov-rth cov-rth--num">العملاء</th>
            <th className="cov-rth cov-rth--week">أسبوع 1</th>
            <th className="cov-rth cov-rth--week">أسبوع 2</th>
            <th className="cov-rth cov-rth--week">أسبوع 3</th>
            <th className="cov-rth cov-rth--week">أسبوع 4</th>
            <th className="cov-rth cov-rth--week">أسبوع 5</th>
            <th className="cov-rth cov-rth--overall">الإجمالي</th>
            <th className="cov-rth cov-rth--eff" title="متوسط نسبة العملاء بـ≥2 زيارة/أسبوع">كفاءة ≥2</th>
            <th className="cov-rth cov-rth--qty" title="إجمالي صافي الكميات بالشهر الحالي">الكميات</th>
            <th className="cov-rth cov-rth--avg" title={`متوسط الكميات لكل يوم عمل (${workingDays} يوم)`}>كمية/يوم</th>
            <th className="cov-rth cov-rth--avg" title="متوسط الزيارات لكل يوم عمل (يُستثنى الأسابيع الصفرية)">زيارة/يوم</th>
          </tr>
        </thead>
        <tbody>
          {reps.map((rep, i) => {
            const avgQty = workingDays > 0 ? Math.round(rep.total_qty / workingDays) : 0;
            // Visits avg: only count working days in weeks where rep had actual visits
            const activeWD  = rep.has_day_data ? calcActiveWorkDays(rep.weeks, year, month) : 0;
            const avgVisits = activeWD > 0 ? (rep.overall.visits / activeWD).toFixed(1) : '—';
            return (
              <tr key={rep.rep_name} className={`cov-rtr${i % 2 !== 0 ? ' cov-rtr--alt' : ''}`}>
                <td className="cov-rtd cov-rtd--rank">
                  {MEDALS[rep.rank] || <span className="cov-rank-num">{rep.rank}</span>}
                </td>
                <td className="cov-rtd cov-rtd--name">{rep.rep_name}</td>
                <td className="cov-rtd cov-rtd--branch">
                  <span className="cov-branch-badge">{rep.branch_name || '—'}</span>
                </td>
                <td className="cov-rtd cov-rtd--num">{rep.total_customers}</td>
                {rep.weeks.map((wk, wi) => (
                  <PctCell key={wi} pct={wk.pct} visited={wk.visited} total={rep.total_customers} hasDayData={rep.has_day_data}/>
                ))}
                <td className={`cov-rtd cov-rtd--overall ${
                  rep.overall.pct >= 90 ? 'cov-rtd--high' : rep.overall.pct >= 70 ? 'cov-rtd--good' : rep.overall.pct >= 40 ? 'cov-rtd--mid' : 'cov-rtd--low'
                }`}>
                  <div className="cov-rtd-overall-val">{rep.has_day_data ? `${rep.overall.pct}%` : '—'}</div>
                  {rep.has_day_data && (
                    <div className="cov-rtd-overall-sub">{rep.overall.visited}/{rep.total_customers} · {rep.overall.visits} زيارة</div>
                  )}
                </td>
                {/* Efficiency */}
                {rep.has_day_data ? (
                  <td className={`cov-rtd cov-rtd--eff ${
                    rep.overall.effPct >= 70 ? 'cov-rtd--eff-high' : rep.overall.effPct >= 40 ? 'cov-rtd--eff-mid' : 'cov-rtd--eff-low'
                  }`}>
                    <div className="cov-rtd-eff-val">{rep.overall.effPct}%</div>
                    <div className="cov-rtd-bar"><div className="cov-rtd-fill" style={{ width: `${rep.overall.effPct}%` }}/></div>
                  </td>
                ) : (
                  <td className="cov-rtd cov-rtd--nodata">—</td>
                )}
                {/* Total qty */}
                <td className="cov-rtd cov-rtd--qty">
                  <div className="cov-rtd-qty-val">{fmtN(rep.total_qty)}</div>
                </td>
                {/* Avg daily qty */}
                <td className="cov-rtd cov-rtd--avg">
                  <div className="cov-rtd-avg-val">{fmtN(avgQty)}</div>
                  <div className="cov-rtd-avg-sub">/ يوم</div>
                </td>
                {/* Avg daily visits */}
                <td className="cov-rtd cov-rtd--avg">
                  {rep.has_day_data ? (
                    <>
                      <div className="cov-rtd-avg-val">{avgVisits} زيارة</div>
                      <div className="cov-rtd-avg-sub">زيارة/يوم</div>
                    </>
                  ) : <span style={{ color: '#cbd5e1' }}>—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Top / Bottom 10 chart ───────────────────────────────────── */
function RepChart({ reps }) {
  const withData = reps.filter(r => r.has_day_data && r.overall.pct > 0);
  if (withData.length < 2) return null;

  const top10    = withData.slice(0, Math.min(10, withData.length));
  const bottom10 = [...withData]
    .sort((a, b) => a.overall.pct - b.overall.pct)
    .slice(0, Math.min(10, withData.length))
    .reverse(); // show lowest at bottom

  const BarRow = ({ rep, mode }) => {
    const pct = rep.overall.pct;
    const fillCls = mode === 'top'
      ? (pct >= 90 ? 'cov-chart-fill--top1' : pct >= 70 ? 'cov-chart-fill--top2' : 'cov-chart-fill--top3')
      : (pct <= 20 ? 'cov-chart-fill--bot1' : pct <= 40 ? 'cov-chart-fill--bot2' : 'cov-chart-fill--bot3');
    return (
      <div className="cov-chart-row">
        <div className="cov-chart-label" title={rep.rep_name}>{rep.rep_name}</div>
        <div className="cov-chart-bar-track">
          <div className={`cov-chart-bar-fill ${fillCls}`} style={{ width: `${pct}%` }}/>
        </div>
        <div className="cov-chart-pct-lbl">{pct}%</div>
      </div>
    );
  };

  return (
    <div className="cov-chart-card">
      <h3 className="cov-section-title">📈 أفضل وأضعف المناديب — نسبة التغطية الإجمالية</h3>
      <div className="cov-chart-grid">
        <div className="cov-chart-half">
          <div className="cov-chart-half-title cov-chart-half-title--top">🥇 أفضل {top10.length} مناديب</div>
          <div className="cov-chart-rows">
            {top10.map(rep => <BarRow key={rep.rep_name} rep={rep} mode="top"/>)}
          </div>
        </div>
        <div className="cov-chart-divider"/>
        <div className="cov-chart-half">
          <div className="cov-chart-half-title cov-chart-half-title--bot">⚠️ أدنى {bottom10.length} مناديب</div>
          <div className="cov-chart-rows">
            {bottom10.map(rep => <BarRow key={rep.rep_name} rep={rep} mode="bot"/>)}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Ranking view ────────────────────────────────────────────── */
function RankingView({ branch, month, year }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['coverage-ranking', branch, month, year],
    queryFn:  () => client.get(`/coverage/ranking?branch=${encodeURIComponent(branch)}&month=${month}&year=${year}`).then(r => r.data),
    staleTime: 3 * 60 * 1000,
  });

  if (isLoading) return (
    <div className="cov-loading"><RefreshCw size={20} className="srp-spin"/><span>جارٍ تحميل بيانات الترتيب…</span></div>
  );
  if (isError) return (
    <div className="cov-empty"><AlertCircle size={32} style={{ color: '#f59e0b', marginBottom: 8 }}/><div>خطأ في تحميل البيانات</div></div>
  );
  if (!data) return null;

  const { reps, period } = data;
  const monthLabel  = `${MONTH_NAMES[period.month]} ${period.year}`;
  const hasDayData  = reps.some(r => r.has_day_data);
  const workingDays = calcWorkingDays(period.year, period.month);

  if (reps.length === 0) return (
    <div className="cov-empty"><span className="cov-empty-icon">📊</span>لا توجد بيانات لهذه الفترة</div>
  );

  const pct70plus  = reps.filter(r => r.has_day_data && r.overall.pct >= 70).length;
  const pct40_69   = reps.filter(r => r.has_day_data && r.overall.pct >= 40 && r.overall.pct < 70).length;
  const pctBelow40 = reps.filter(r => r.has_day_data && r.overall.pct < 40).length;
  const noData     = reps.filter(r => !r.has_day_data).length;
  const avgCov     = hasDayData
    ? Math.round(reps.filter(r => r.has_day_data).reduce((s, r) => s + r.overall.pct, 0) / reps.filter(r => r.has_day_data).length)
    : null;

  return (
    <>
      {/* Summary row */}
      <div className="cov-rank-summary">
        <span className="cov-stat-chip">إجمالي المناديب: <strong>{reps.length}</strong></span>
        {avgCov !== null && (
          <span className="cov-stat-chip" style={{ background: avgCov >= 70 ? '#dcfce7' : avgCov >= 40 ? '#fef3c7' : '#fee2e2' }}>
            متوسط التغطية: <strong>{avgCov}%</strong>
          </span>
        )}
        {pct70plus  > 0 && <span className="cov-stat-chip" style={{ background: '#dcfce7' }}>≥ 70%: <strong>{pct70plus}</strong></span>}
        {pct40_69   > 0 && <span className="cov-stat-chip" style={{ background: '#fef3c7' }}>40–69%: <strong>{pct40_69}</strong></span>}
        {pctBelow40 > 0 && <span className="cov-stat-chip" style={{ background: '#fee2e2' }}>&lt; 40%: <strong>{pctBelow40}</strong></span>}
        {noData     > 0 && <span className="cov-stat-chip" style={{ color: '#94a3b8' }}>بدون بيانات يومية: <strong>{noData}</strong></span>}
        {!hasDayData && (
          <div className="cov-no-day-notice" style={{ flex: 1 }}>
            <AlertCircle size={14}/> البيانات اليومية غير متوفرة — يُعرض الترتيب بدون نسب التغطية الأسبوعية
          </div>
        )}
      </div>

      {/* Chart */}
      {hasDayData && <RepChart reps={reps}/>}

      {/* Ranking matrix */}
      <div className="cov-rank-card">
        <div className="cov-section-title">
          <span>📋 جدول ترتيب المناديب — {monthLabel}</span>
          <span className="cov-section-count">{reps.length} مندوب</span>
          <div className="cov-export-btns cov-no-print">
            <button className="cov-export-btn cov-export-btn--excel"
              onClick={() => exportRankingCSV(reps, { ...period, workingDays })}
              title="تصدير Excel">
              <FileSpreadsheet size={14}/> Excel
            </button>
            <button className="cov-export-btn cov-export-btn--pdf"
              onClick={() => triggerPrint(`ترتيب المناديب — ${monthLabel}`)}
              title="تصدير PDF">
              <Printer size={14}/> PDF
            </button>
          </div>
        </div>
        <RankingMatrix reps={reps} workingDays={workingDays} year={period.year} month={period.month}/>
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════ */
export default function CoveragePage() {
  const now = new Date();
  const [activeTab, setActiveTab] = useState('profile');
  const [branch,    setBranch]    = useState('');
  const [repName,   setRepName]   = useState('');
  const [month,     setMonth]     = useState(now.getMonth() + 1);
  const [year,      setYear]      = useState(now.getFullYear());

  /* ── Shared filters ── */
  const { data: filters, isLoading: filtersLoading } = useQuery({
    queryKey: ['coverage-filters', year],
    queryFn:  () => client.get(`/coverage/filters?year=${year}`).then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const availableReps = useMemo(() => {
    if (!filters?.reps) return [];
    return branch ? filters.reps.filter(r => r.branch === branch) : filters.reps;
  }, [filters, branch]);

  /* ── Profile data ── */
  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ['coverage-profile', repName, month, year],
    queryFn:  () => client.get(`/coverage/profile?rep=${encodeURIComponent(repName)}&month=${month}&year=${year}`).then(r => r.data),
    enabled:  !!repName && activeTab === 'profile',
    staleTime: 3 * 60 * 1000,
  });

  const handleBranchChange = e => { setBranch(e.target.value); setRepName(''); };

  return (
    <div className="cov-page">

      {/* ── Header ── */}
      <div className="cov-header">
        <div>
          <h1 className="cov-title">👥 تغطية المناديب</h1>
          <p className="cov-subtitle">بروفايل الأداء الفردي · ترتيب وتحليل جميع المناديب</p>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="cov-tabs cov-no-print">
        <button
          className={`cov-tab${activeTab === 'profile' ? ' cov-tab--active' : ''}`}
          onClick={() => setActiveTab('profile')}
        >
          <UserCheck size={15}/> بروفايل المندوب
        </button>
        <button
          className={`cov-tab${activeTab === 'ranking' ? ' cov-tab--active' : ''}`}
          onClick={() => setActiveTab('ranking')}
        >
          <BarChart2 size={15}/> ترتيب المناديب
        </button>
      </div>

      {/* ── Filters ── */}
      <div className="cov-filters cov-no-print">
        <div className="cov-filter-group">
          <label className="cov-filter-label">📍 المنطقة / خط السير</label>
          <select className="cov-select" value={branch} onChange={handleBranchChange}>
            <option value="">الكل</option>
            {(filters?.branches || []).map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>

        {/* Rep filter — profile tab only */}
        {activeTab === 'profile' && (
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
        )}

        <div className="cov-filter-group cov-filter-group--sm">
          <label className="cov-filter-label">🗓 الشهر</label>
          <select className="cov-select" value={month} onChange={e => setMonth(Number(e.target.value))}>
            {Object.entries(MONTH_NAMES).map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}
          </select>
        </div>

        <div className="cov-filter-group cov-filter-group--sm">
          <label className="cov-filter-label">📆 السنة</label>
          <select className="cov-select" value={year} onChange={e => setYear(Number(e.target.value))}>
            {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {activeTab === 'profile' && repName && (
          <button className="cov-btn-clear" onClick={() => setRepName('')}>✕ مسح</button>
        )}
      </div>

      {/* ── Tab content ── */}
      {activeTab === 'profile' ? (
        !repName ? (
          <div className="cov-empty">
            <span className="cov-empty-icon">👤</span>
            اختر مندوباً من القائمة أعلاه لعرض بروفايل الأداء ومصفوفة التغطية
          </div>
        ) : profileLoading ? (
          <div className="cov-loading"><RefreshCw size={20} className="srp-spin"/><span>جارٍ تحميل بيانات المندوب…</span></div>
        ) : profile ? (
          <>
            <RepProfile rep={profile.rep} period={profile.period}/>
            <CoverageMatrix profile={profile}/>
          </>
        ) : (
          <div className="cov-empty">
            <AlertCircle size={32} style={{ color: '#f59e0b', marginBottom: 8 }}/>
            <div>لا توجد بيانات لهذا المندوب في الفترة المحددة</div>
          </div>
        )
      ) : (
        <RankingView branch={branch} month={month} year={year}/>
      )}

    </div>
  );
}
