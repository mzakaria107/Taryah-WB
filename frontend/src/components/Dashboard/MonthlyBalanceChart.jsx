import React, { useEffect, useRef } from 'react';
import './MonthlyBalanceChart.css';

/* ── Arabic month names ───────────────────────────── */
const MONTH_AR = [
  '', 'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

/* ── Compact number formatter ────────────────────── */
function fmtNum(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(1) + 'K';
  return Math.round(v).toLocaleString('en-SA');
}

/* ── Loading skeleton ────────────────────────────── */
function Skeleton() {
  return (
    <div className="mbc-card">
      <div className="mbc-header">
        <div className="mbc-skel mbc-skel-title" />
        <div className="mbc-skel mbc-skel-chip" />
      </div>
      <div className="mbc-months-section">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="mbc-skel mbc-skel-row" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
      <div className="mbc-divider" />
      <div className="mbc-regions-section">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="mbc-skel mbc-skel-row" style={{ animationDelay: `${i * 80}ms` }} />
        ))}
      </div>
    </div>
  );
}

/* ── Animated bar ────────────────────────────────── */
function AnimBar({ pct, color, delay = 0 }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const t = setTimeout(() => { el.style.width = `${pct}%`; }, delay + 50);
    return () => clearTimeout(t);
  }, [pct, delay]);
  return (
    <div className="mbc-bar-track">
      <div ref={ref} className="mbc-bar-fill" style={{ background: color, width: 0 }} />
    </div>
  );
}

/* ── Main component ──────────────────────────────── */
export default function MonthlyBalanceChart({ data, loading }) {
  const today   = new Date();
  const curMonth = today.getMonth() + 1; // 1-based

  if (loading) return <Skeleton />;
  if (!data)   return <Skeleton />;

  const { year, months = [], regions = [], total_balance, total_unpaid_count } = data;

  // Max balance for proportional bars
  const maxBalance = Math.max(...months.map(m => m.total_balance), 1);
  const maxRegionCount = Math.max(...regions.map(r => r.unpaid_count), 1);

  // Show only months that have data OR are in the past/current (for current year)
  const isCurrentYear = year === today.getFullYear();
  const visibleMonths = months.filter(m =>
    m.invoice_count > 0 || (isCurrentYear && m.month <= curMonth)
  );

  return (
    <div className="mbc-card">
      {/* ── Header ── */}
      <div className="mbc-header">
        <div className="mbc-title-wrap">
          <span className="mbc-title">الأرصدة الشهرية — {year}</span>
          <span className="mbc-subtitle">الفواتير الغير مسددة</span>
        </div>
        <div className="mbc-totals">
          <div className="mbc-total-item">
            <span className="mbc-total-val danger">{fmtNum(total_balance)}</span>
            <span className="mbc-total-lbl">إجمالي المتبقي</span>
          </div>
          <div className="mbc-total-sep" />
          <div className="mbc-total-item">
            <span className="mbc-total-val">{total_unpaid_count.toLocaleString('en-SA')}</span>
            <span className="mbc-total-lbl">فاتورة غير مسددة</span>
          </div>
        </div>
      </div>

      {/* ── Monthly bars ── */}
      <div className="mbc-months-section">
        {visibleMonths.length === 0 ? (
          <div className="mbc-empty">لا توجد بيانات للعام {year}</div>
        ) : (
          visibleMonths.map((m, idx) => {
            const pct     = maxBalance > 0 ? (m.total_balance / maxBalance) * 100 : 0;
            const isCur   = isCurrentYear && m.month === curMonth;
            const isEmpty = m.invoice_count === 0;
            return (
              <div
                key={m.month}
                className={`mbc-month-row${isCur ? ' mbc-month-current' : ''}${isEmpty ? ' mbc-month-empty' : ''}`}
              >
                <span className="mbc-month-name">{MONTH_AR[m.month]}</span>
                <AnimBar
                  pct={isEmpty ? 0 : pct}
                  color="var(--color-brand-red)"
                  delay={idx * 40}
                />
                <span className="mbc-month-bal">{isEmpty ? '—' : fmtNum(m.total_balance)}</span>
                <span className={`mbc-month-badge${isEmpty ? ' mbc-badge-zero' : ''}`}>
                  {isEmpty ? '٠' : m.unpaid_count}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* ── Divider with label ── */}
      {regions.length > 0 && (
        <>
          <div className="mbc-section-label">
            <span>حصة المناطق من الغير مسدد</span>
          </div>

          {/* ── Region breakdown ── */}
          <div className="mbc-regions-section">
            {regions.map((r, idx) => (
              <div key={r.region_name} className="mbc-region-row">
                <span className="mbc-region-name">{r.region_name}</span>
                <AnimBar
                  pct={maxRegionCount > 0 ? (r.unpaid_count / maxRegionCount) * 100 : 0}
                  color="var(--color-brand-green)"
                  delay={idx * 50}
                />
                <span className="mbc-region-count">{r.unpaid_count.toLocaleString('en-SA')}</span>
                <span className="mbc-region-pct">{r.pct_count}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
