import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  TrendingUp, RefreshCw, ChevronDown, ChevronLeft,
  AlertCircle, Clock, DollarSign, BarChart2, Percent, Package,
  CalendarDays, TrendingDown, Activity, Minus,
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

/* ── Trend Sparkline (SVG line chart) ─────────────────────── */
function TrendSparkline({ data, labels, color, hov, onHov, formatVal }) {
  const W = 300, H = 58;
  const pad = { t: 16, b: 6, l: 8, r: 8 };
  const iW = W - pad.l - pad.r;
  const iH = H - pad.t - pad.b;
  const n   = data.length;
  if (n === 0) return null;

  const vals  = data.filter(v => isFinite(v));
  const maxV  = Math.max(...vals, 0.001);
  const minV  = Math.min(...vals, 0);
  const range = maxV - minV || maxV || 1;

  const px = i  => pad.l + (n <= 1 ? iW / 2 : (i / (n - 1)) * iW);
  const py = v  => pad.t + iH - ((v - minV) / range) * iH;
  const pts = data.map((v, i) => ({ x: px(i), y: py(v), v, i }));

  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const last  = pts[pts.length - 1];
  const areaD = n >= 2
    ? `${pathD} L${last.x.toFixed(1)},${H} L${pad.l},${H} Z`
    : '';

  const gradId = `spk_${color.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%" height={H}
      preserveAspectRatio="none"
      className="prf-spark-svg"
      onMouseLeave={() => onHov(null)}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.22"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>

      {areaD && <path d={areaD} fill={`url(#${gradId})`}/>}
      {n >= 2 && (
        <path d={pathD} stroke={color} strokeWidth="1.6" fill="none"
          strokeLinejoin="round" strokeLinecap="round"
          vectorEffect="non-scaling-stroke"/>
      )}

      {/* Hover vertical guide */}
      {hov !== null && (
        <line x1={pts[hov].x} y1={pad.t - 2} x2={pts[hov].x} y2={H}
          stroke={color} strokeWidth="1" strokeDasharray="3,2"
          opacity="0.45" vectorEffect="non-scaling-stroke"/>
      )}

      {/* Value label above hovered / latest point */}
      {pts.map((p) => {
        const isLatest = p.i === n - 1;
        const isHov    = hov === p.i;
        if (!isLatest && !isHov) return null;
        const lx  = Math.max(16, Math.min(W - 16, p.x));
        // Latest label: fixed near top so it never overlaps hovered labels
        // Hovered label: floats just above its dot
        const ly  = isLatest
          ? Math.max(8, pad.t - 3)
          : Math.max(pad.t + 4, p.y - 7);
        const txt = formatVal ? formatVal(p.v) : fmtNum(p.v);
        const fs  = isLatest ? 8 : 7.5;
        return (
          <text key={`lbl-${p.i}`}
            x={lx} y={ly}
            textAnchor="middle"
            fontSize={fs} fill={color} fontWeight="700"
            vectorEffect="non-scaling-stroke"
            style={{ fontFamily: 'var(--font-en)', pointerEvents: 'none' }}
          >
            {txt}
          </text>
        );
      })}

      {/* Dots */}
      {pts.map((p) => {
        const isLatest = p.i === n - 1;
        const isHov    = hov === p.i;
        return (
          <circle key={p.i}
            cx={p.x} cy={p.y}
            r={isLatest ? 3.5 : isHov ? 3 : 2}
            fill={isLatest || isHov ? color : '#fff'}
            stroke={color} strokeWidth="1.5"
            opacity={isLatest || isHov ? 1 : 0.55}
            vectorEffect="non-scaling-stroke"
            onMouseEnter={() => onHov(p.i)}
            style={{ cursor: 'crosshair', pointerEvents: 'all' }}
          />
        );
      })}
    </svg>
  );
}

/* ── Trend Card ───────────────────────────────────────────── */
function TrendCard({ title, value, subValue, trendPct, sparkData, sparkLabels, color, icon, formatVal }) {
  const [hov, setHov] = useState(null);
  const dir = trendPct > 1 ? 'up' : trendPct < -1 ? 'down' : 'flat';

  // Value and subtitle change on hover
  const displayVal = hov !== null
    ? (formatVal ? formatVal(sparkData[hov]) : `ر.س ${fmtNum(sparkData[hov])}`)
    : value;
  const displaySub = hov !== null && sparkLabels?.[hov] ? sparkLabels[hov] : subValue;

  return (
    <div className="prf-trend-card" onMouseLeave={() => setHov(null)}>
      {/* Header: icon + value + badge */}
      <div className="prf-trend-header">
        <div className="prf-trend-icon-wrap" style={{ background: color + '20', color }}>
          {icon}
        </div>
        <div className="prf-trend-main">
          <div className="prf-trend-val">{displayVal}</div>
          <div className="prf-trend-sub">{displaySub}</div>
          <div className="prf-trend-lbl">{title}</div>
        </div>
        <span className={`prf-trend-badge prf-trend-${dir}`}>
          {dir === 'up'   ? <TrendingUp   size={10}/> :
           dir === 'down' ? <TrendingDown size={10}/> :
                            <Minus        size={10}/>}
          {' '}{Math.abs(trendPct).toFixed(1)}%
          {' '}{dir === 'up' ? 'ارتفاع' : dir === 'down' ? 'انخفاض' : 'مستقر'}
        </span>
      </div>

      {/* Line sparkline */}
      <TrendSparkline
        data={sparkData}
        labels={sparkLabels}
        color={color}
        hov={hov}
        onHov={setHov}
        formatVal={formatVal}
      />
    </div>
  );
}

/* ── Arabic month name ────────────────────────────────────── */
const AR_MONTHS = [
  'يناير','فبراير','مارس','أبريل','مايو','يونيو',
  'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر',
];

/* ── Daily Performance Section ───────────────────────────── */
function DailyPerformanceSection({ selectedYear, selectedMonth, onMonthChange, onSaveNow, isSaving }) {
  const { data: dailyData, isLoading } = useQuery({
    queryKey: ['profitability-daily', selectedYear, selectedMonth],
    queryFn:  () => client.get(`/profitability/daily?year=${selectedYear}&month=${selectedMonth}`).then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return (
    <div className="prf-daily-card">
      <div className="prf-daily-loading"><RefreshCw size={16} className="prf-spin"/> جاري تحميل البيانات اليومية…</div>
    </div>
  );

  const {
    snapshots = [], workingDaysElapsed = 0, workingDaysWithData = 0, totalWorkingDays = 1,
    availableMonths = [], year: resYear, month: resMonth,
  } = dailyData || {};

  // Denominator = actual number of snapshot days with data
  const avgDenominator = snapshots.length || 1;

  const now = new Date();
  const isCurrentMonth = resYear === now.getFullYear() && resMonth === (now.getMonth() + 1);
  const monthLabel = `${AR_MONTHS[(resMonth || now.getMonth() + 1) - 1]} ${resYear || now.getFullYear()}`;

  // KPIs from snapshots (latest snapshot = cumulative total for the month)
  const latest = snapshots[0];
  const cumRevenue    = parseFloat(latest?.total_revenue   || 0);
  const cumCost       = parseFloat(latest?.total_cost      || 0);
  const cumGP         = parseFloat(latest?.gross_profit    || 0);
  const cumGPPct      = parseFloat(latest?.gross_profit_pct || 0);

  const dailyAvgRevenue  = avgDenominator > 0 ? cumRevenue / avgDenominator : 0;
  const projectedRevenue = dailyAvgRevenue * totalWorkingDays;
  const dailyAvgGP       = avgDenominator > 0 ? cumGP / avgDenominator : 0;
  const timePct          = totalWorkingDays > 0 ? (workingDaysElapsed / totalWorkingDays) * 100 : 0;

  // ── Trend calculations (snapshots = DESC, sparkline needs ASC) ──
  const sparkSnaps  = [...snapshots].reverse();
  const sparkLabels = sparkSnaps.map(s => {
    const d = new Date(String(s.snapshot_date).slice(0, 10) + 'T12:00:00');
    return d.toLocaleDateString('ar-SA', { day: 'numeric', month: 'short', weekday: 'short' });
  });

  // ── Trend: today vs avg of previous 3 days ────────────────────
  // snapshots[0] = today (DESC order), snapshots[1..3] = previous 3 days
  // This ensures the badge matches what the user sees:
  //   if today's value > prev-3-day avg → ارتفاع
  //   if today's value < prev-3-day avg → انخفاض

  // 1. Daily GP trend
  const todayGP      = parseFloat(snapshots[0]?.daily_gross_profit || 0);
  const prevGP       = snapshots.slice(1, 4).map(s => parseFloat(s.daily_gross_profit || 0));
  const prevAvgGP    = prevGP.length ? prevGP.reduce((a, b) => a + b, 0) / prevGP.length : 0;
  const gpDailyTrend = prevAvgGP > 0 ? ((todayGP - prevAvgGP) / prevAvgGP) * 100 : 0;
  const dailyGPSpark = sparkSnaps.map(s => parseFloat(s.daily_gross_profit || 0));

  // 2. Cumulative GP% trend (cumulative metric — compare today vs prev-3-day avg)
  const todayGPPct      = parseFloat(snapshots[0]?.gross_profit_pct || 0);
  const prevGPPct       = snapshots.slice(1, 4).map(s => parseFloat(s.gross_profit_pct || 0));
  const prevAvgGPPct    = prevGPPct.length ? prevGPPct.reduce((a, b) => a + b, 0) / prevGPPct.length : 0;
  const gpPctTrend      = prevAvgGPPct !== 0
    ? ((todayGPPct - prevAvgGPPct) / Math.abs(prevAvgGPPct)) * 100
    : 0;
  const gpPctSpark = sparkSnaps.map(s => parseFloat(s.gross_profit_pct || 0));

  // 3. Daily qty trend
  const todayQty     = parseFloat(snapshots[0]?.daily_qty || 0);
  const prevQty      = snapshots.slice(1, 4).map(s => parseFloat(s.daily_qty || 0));
  const prevAvgQty   = prevQty.length ? prevQty.reduce((a, b) => a + b, 0) / prevQty.length : 0;
  const qtyTrend     = prevAvgQty > 0 ? ((todayQty - prevAvgQty) / prevAvgQty) * 100 : 0;
  const qtySpark     = sparkSnaps.map(s => parseFloat(s.daily_qty || 0));

  return (
    <div className="prf-daily-card">
      {/* Header */}
      <div className="prf-daily-header">
        <div className="prf-daily-title">
          <Activity size={16}/>
          <span>الأداء اليومي التراكمي — {monthLabel}</span>
        </div>
        <div className="prf-daily-header-actions">
          {/* Month picker */}
          {availableMonths.length > 0 && (
            <select
              className="prf-month-select"
              value={`${selectedYear}-${selectedMonth}`}
              onChange={e => {
                const [y, m] = e.target.value.split('-');
                onMonthChange(parseInt(y), parseInt(m));
              }}
            >
              {availableMonths.map(m => (
                <option key={`${m.year}-${m.month}`} value={`${m.year}-${m.month}`}>
                  {AR_MONTHS[m.month - 1]} {m.year}
                </option>
              ))}
            </select>
          )}
          {isCurrentMonth && (
            <button className={`prf-save-btn${isSaving ? ' prf-fetching' : ''}`} onClick={onSaveNow} disabled={isSaving}>
              <RefreshCw size={13} className={isSaving ? 'prf-spin' : ''}/>
              {isSaving ? 'جاري الحفظ…' : 'حفظ الآن'}
            </button>
          )}
          <div className="prf-daily-days">
            <CalendarDays size={13}/>
            <span>{snapshots.length} يوم بيانات من {totalWorkingDays} يوم عمل</span>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="prf-progress-wrap">
        <div className="prf-progress-bar" style={{ width: `${Math.min(timePct, 100)}%` }}/>
        <span className="prf-progress-label">{timePct.toFixed(0)}% من الشهر</span>
      </div>

      {snapshots.length === 0 ? (
        <div className="prf-daily-empty">
          <TrendingDown size={18}/>
          <span>لا توجد بيانات يومية لهذا الشهر — اضغط "حفظ الآن" أو انتظر الحفظ التلقائي (11:59 م)</span>
        </div>
      ) : (
        <>
          {/* Trend indicators */}
          {snapshots.length >= 2 && (
            <div className="prf-trend-row">
              <TrendCard
                title="ترند الربح اليومي"
                value={`ر.س ${fmtNum(todayGP)}`}
                subValue={`متوسط 3 أيام سابقة: ر.س ${fmtNum(prevAvgGP)}`}
                trendPct={gpDailyTrend}
                sparkData={dailyGPSpark}
                sparkLabels={sparkLabels}
                color="#1565c0"
                icon={<DollarSign size={15}/>}
                formatVal={v => `ر.س ${fmtNum(v)}`}
              />
              <TrendCard
                title="هامش الربحية التراكمي"
                value={fmtPct(cumGPPct)}
                subValue={`متوسط 3 أيام سابقة: ${fmtPct(prevAvgGPPct)}`}
                trendPct={gpPctTrend}
                sparkData={gpPctSpark}
                sparkLabels={sparkLabels}
                color="#2e7d32"
                icon={<Percent size={15}/>}
                formatVal={v => fmtPct(v)}
              />
              <TrendCard
                title="الكميات المباعة يومياً"
                value={fmtQty(todayQty)}
                subValue={`متوسط 3 أيام سابقة: ${fmtQty(prevAvgQty)}`}
                trendPct={qtyTrend}
                sparkData={qtySpark}
                sparkLabels={sparkLabels}
                color="#6a1b9a"
                icon={<Package size={15}/>}
                formatVal={v => fmtQty(v)}
              />
            </div>
          )}

          {/* KPI row */}
          <div className="prf-daily-kpi-row">
            <div className="prf-daily-kpi">
              <div className="prf-daily-kpi-icon" style={{ background:'#e3f2fd', color:'#1565c0' }}><TrendingUp size={16}/></div>
              <div>
                <div className="prf-daily-kpi-val">ر.س {fmtNum(dailyAvgRevenue)}</div>
                <div className="prf-daily-kpi-lbl">متوسط الإيرادات اليومي</div>
              </div>
            </div>
            <div className="prf-daily-kpi">
              <div className="prf-daily-kpi-icon" style={{ background:'#e8f5e9', color:'#2e7d32' }}><BarChart2 size={16}/></div>
              <div>
                <div className="prf-daily-kpi-val">ر.س {fmtNum(projectedRevenue)}</div>
                <div className="prf-daily-kpi-lbl">{isCurrentMonth ? 'الإيرادات المتوقعة للشهر' : 'إجمالي الشهر'}</div>
              </div>
            </div>
            <div className="prf-daily-kpi">
              <div className="prf-daily-kpi-icon" style={{ background:'#f3e5f5', color:'#6a1b9a' }}><DollarSign size={16}/></div>
              <div>
                <div className="prf-daily-kpi-val">ر.س {fmtNum(dailyAvgGP)}</div>
                <div className="prf-daily-kpi-lbl">متوسط الربح الإجمالي اليومي</div>
              </div>
            </div>
            <div className="prf-daily-kpi">
              <div className={`prf-daily-kpi-icon`} style={{ background:'#fff8e1', color:'#f57f17' }}><Percent size={16}/></div>
              <div>
                <div className={`prf-daily-kpi-val ${gpClass(cumGPPct)}`}>{fmtPct(cumGPPct)}</div>
                <div className="prf-daily-kpi-lbl">هامش الربح التراكمي</div>
              </div>
            </div>
          </div>

          {/* Daily snapshots table */}
          <div className="prf-daily-table-wrap">
            <table className="prf-daily-table">
              <thead>
                <tr>
                  <th>التاريخ</th>
                  <th className="prf-daily-col-highlight">إيرادات اليوم</th>
                  <th className="prf-daily-col-highlight">ربح اليوم</th>
                  <th>إيرادات تراكمية</th>
                  <th>ربح تراكمي</th>
                  <th>هامش %</th>
                  <th>كمية اليوم</th>
                  <th>كمية تراكمية</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s, i) => {
                  const gp = parseFloat(s.gross_profit_pct);
                  const isToday = i === 0 && isCurrentMonth;
                  const dailyRev = parseFloat(s.daily_revenue);
                  const dailyGP  = parseFloat(s.daily_gross_profit);
                  return (
                    <tr key={i} className={isToday ? 'prf-daily-today' : ''}>
                      <td className="prf-daily-date">
                        {isToday && <span className="prf-today-badge">اليوم</span>}
                        {new Date(s.snapshot_date).toLocaleDateString('ar-SA', {
                          day: 'numeric', month: 'short', weekday: 'short',
                        })}
                      </td>
                      <td className={`prf-daily-num prf-daily-col-highlight prf-revenue ${dailyRev < 0 ? 'prf-gp-neg' : ''}`}>
                        {s.daily_revenue != null ? `ر.س ${fmtNum(dailyRev)}` : '—'}
                      </td>
                      <td className={`prf-daily-num prf-daily-col-highlight ${gpClass(dailyGP > 0 && dailyRev > 0 ? (dailyGP/dailyRev)*100 : 0)}`}>
                        {s.daily_gross_profit != null ? `ر.س ${fmtNum(dailyGP)}` : '—'}
                      </td>
                      <td className="prf-daily-num">{`ر.س ${fmtNum(s.total_revenue)}`}</td>
                      <td className="prf-daily-num">{`ر.س ${fmtNum(s.gross_profit)}`}</td>
                      <td className={`prf-daily-num prf-pct-cell ${gpClass(gp)}`}>{fmtPct(gp)}</td>
                      <td className="prf-daily-num">{s.daily_qty != null ? fmtQty(s.daily_qty) : '—'}</td>
                      <td className="prf-daily-num">{fmtQty(s.qty)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
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

  /* ── Fetch main report ── */
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

  /* ── Daily section state ── */
  const now = new Date();
  const [dailyYear,  setDailyYear]  = useState(now.getFullYear());
  const [dailyMonth, setDailyMonth] = useState(now.getMonth() + 1);
  const [isSaving,   setIsSaving]   = useState(false);

  const handleSaveNow = async () => {
    setIsSaving(true);
    try {
      await client.post('/profitability/snapshot');
    } catch (e) { /* ignore */ }
    setIsSaving(false);
  };

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

      {/* ── Daily Performance Section ── */}
      <DailyPerformanceSection
        selectedYear={dailyYear}
        selectedMonth={dailyMonth}
        onMonthChange={(y, m) => { setDailyYear(y); setDailyMonth(m); }}
        onSaveNow={handleSaveNow}
        isSaving={isSaving}
      />

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
                  <td className="prf-td-num"><strong>{kpi.qty > 0 ? fmtNum(kpi.cost / kpi.qty) : '—'}</strong></td>
                  <td className="prf-td-num"><strong>{kpi.qty > 0 ? fmtNum(kpi.revenue / kpi.qty) : '—'}</strong></td>
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
