import React, { useState } from 'react';
import './CategoryKPI.css';

const PALETTE = [
  '#3b82f6','#22c55e','#f59e0b','#a855f7','#14b8a6',
  '#ef4444','#f97316','#06b6d4','#84cc16','#ec4899',
  '#6366f1','#0ea5e9','#10b981','#d946ef','#eab308',
];

const MONTH_AR = {
  1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
  7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
};

/* ── Build SVG donut slices ── */
function buildSlices(categories, total) {
  if (!total) return [];
  const r = 70, circ = 2 * Math.PI * r;
  let offset = 0;
  return categories.map((cat, i) => {
    const pct  = cat.count / total;
    const dash = pct * circ;
    const slice = {
      ...cat,
      dash,
      gap:    circ - dash,
      offset: offset * circ,
      color:  PALETTE[i % PALETTE.length],
      pct:    Math.round(pct * 100),
    };
    offset += pct;
    return slice;
  });
}

/* ── Single donut card ── */
function DonutCard({ title, slices, total }) {
  const [hovered, setHovered] = useState(null);
  const cx = 90, cy = 90, r = 70;

  return (
    <div className="ckpi-card spc-chart-wrap">
      <div className="spc-chart-title">{title}</div>

      {!total || !slices.length ? (
        <div className="spc-empty">لا توجد بيانات</div>
      ) : (
        <div className="spc-inner">
          {/* SVG Donut */}
          <div className="spc-svg-wrap">
            <svg viewBox="0 0 180 180" className="spc-svg">
              <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f3f4f6" strokeWidth="28" />
              {slices.map((s, i) => (
                <circle
                  key={i}
                  cx={cx} cy={cy} r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={hovered === i ? 32 : 28}
                  strokeDasharray={`${s.dash} ${s.gap}`}
                  strokeDashoffset={-s.offset}
                  style={{
                    transform: 'rotate(-90deg)',
                    transformOrigin: `${cx}px ${cy}px`,
                    transition: 'stroke-width 0.15s',
                    cursor: 'pointer',
                    opacity: hovered != null && hovered !== i ? 0.5 : 1,
                  }}
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}
                />
              ))}
              <text x={cx} y={cy - 8} textAnchor="middle" className="spc-center-val">
                {hovered != null ? slices[hovered].count : total}
              </text>
              <text x={cx} y={cy + 12} textAnchor="middle" className="spc-center-sub">
                {hovered != null ? `${slices[hovered].pct}%` : 'إجمالي'}
              </text>
            </svg>

            {hovered != null && (
              <div className="spc-tooltip">
                <span className="spc-tt-dot"  style={{ background: slices[hovered].color }} />
                <span className="spc-tt-name">{slices[hovered].category}</span>
                <span className="spc-tt-val" >{slices[hovered].count}</span>
                <span className="spc-tt-pct" >({slices[hovered].pct}%)</span>
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="spc-legend">
            {slices.map((s, i) => (
              <div
                key={i}
                className={`spc-leg-row${hovered === i ? ' spc-leg-active' : ''}`}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              >
                <span className="spc-leg-dot"  style={{ background: s.color }} />
                <span className="spc-leg-name">{s.category}</span>
                <span className="spc-leg-val" >{s.count}</span>
                <span className="spc-leg-pct" >{s.pct}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Skeleton ── */
function CKSkeleton() {
  return (
    <div className="ckpi-row">
      {[0, 1].map(k => (
        <div key={k} className="spc-chart-wrap spc-skel">
          <div className="spc-sk spc-sk-title" />
          <div className="spc-inner">
            <div className="spc-svg-wrap"><div className="spc-sk-donut" /></div>
            <div className="spc-legend">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="spc-leg-row">
                  <div className="spc-sk spc-sk-dot"   />
                  <div className="spc-sk spc-sk-lname" />
                  <div className="spc-sk spc-sk-lval"  />
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Main export ── */
export default function CategoryKPI({ data, loading, fetching }) {
  if (loading && !data) return <CKSkeleton />;

  const cur  = data?.current;
  const prev = data?.prev;

  if (!cur?.total && !prev?.total) return null;

  const curSlices  = buildSlices(cur?.categories  || [], cur?.total  || 0);
  const prevSlices = buildSlices(prev?.categories || [], prev?.total || 0);

  const curLabel  = cur?.month  ? MONTH_AR[cur.month]  : '—';
  const prevLabel = prev?.month ? MONTH_AR[prev.month] : '—';

  return (
    <div className={`ckpi-row${fetching ? ' ckpi-fetching' : ''}`}>
      <DonutCard
        title={`🏷️ نوع العميل — ${curLabel}`}
        slices={curSlices}
        total={cur?.total || 0}
      />
      <DonutCard
        title={`🏷️ نوع العميل — ${prevLabel}`}
        slices={prevSlices}
        total={prev?.total || 0}
      />
    </div>
  );
}
