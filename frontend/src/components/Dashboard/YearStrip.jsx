import React from 'react';
import Skeleton from '../UI/Skeleton';
import './YearStrip.css';

const fmtInt = (n) => Math.round(Number(n)).toLocaleString('en-SA');

const COLOR_MAP = {
  2024: { line: 'var(--color-brand-red)',   bg: 'var(--color-brand-red-light)' },
  2025: { line: 'var(--color-brand-green)', bg: 'var(--color-brand-green-pale)' },
  2026: { line: 'var(--color-brand-gold)',  bg: 'var(--color-brand-gold-light)' },
};

function getColor(year) {
  return COLOR_MAP[year] ?? { line: 'var(--color-text-secondary)', bg: 'var(--color-bg-alt)' };
}

export default function YearStrip({ data = [], loading, activeYear, activeYears, onSelect, vertical = false }) {
  const stripClass = `year-strip${vertical ? ' vertical' : ''}`;

  if (loading) {
    return (
      <div className={stripClass}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="year-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Skeleton width={80} height={22} />
            <Skeleton width="100%" height={12} />
            <Skeleton width="100%" height={12} />
            <Skeleton width="100%" height={4} radius={999} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={stripClass} role="list" aria-label="بيانات السنوات">
      {data.map((d, idx) => {
        const year    = Number(d.year);
        const c       = getColor(year);
        const original= Number(d.total_amount  ?? 0);
        const paid    = Number(d.total_paid    ?? 0);
        const balance = Number(d.total_balance ?? 0);
        const rate    = original > 0 ? (paid / original) * 100 : 0;
        const invoices= Number(d.invoice_count ?? 0);
        // Support both legacy single activeYear and new Set-based activeYears
        const isActive = activeYears
          ? activeYears.has(year)
          : (activeYear === year);

        return (
          <div
            key={year}
            role="listitem"
            className={`year-card${isActive ? ' active' : ''}`}
            style={{
              '--year-color': c.line,
              '--year-bg': c.bg,
              animationDelay: `${idx * 60}ms`,
            }}
            onClick={() => onSelect(year)}
            aria-pressed={isActive}
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onSelect(year)}
          >
            <div className="year-card-head">
              <div className="year-num">{year}</div>
              <div className="year-badge">{invoices.toLocaleString('en-SA')} فاتورة</div>
            </div>

            <div className="year-grid">
              <div className="year-stat">
                <div className="lbl">الإجمالي</div>
                <div className="val">{fmtInt(original)}</div>
              </div>
              <div className="year-stat">
                <div className="lbl">المسدد</div>
                <div className="val">{fmtInt(paid)}</div>
              </div>
              <div className="year-stat bal">
                <div className="lbl">الرصيد</div>
                <div className="val">{fmtInt(balance)}</div>
              </div>
              <div className="year-stat rate">
                <div className="lbl">المعدل</div>
                <div className="val">{rate.toFixed(1)}%</div>
              </div>
            </div>

            <div className="bar">
              <div
                className="bar-fill"
                style={{
                  '--bar-color': c.line,
                  width: `${rate}%`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
