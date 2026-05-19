import React, { useEffect, useState } from 'react';
import './StatusKPICard.css';

/* ── Animated count ───────────────────────────────── */
function useCountUp(target, duration = 700) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!target) { setVal(0); return; }
    let start = null;
    const step = (ts) => {
      if (!start) start = ts;
      const prog = Math.min((ts - start) / duration, 1);
      setVal(Math.round(prog * target));
      if (prog < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [target, duration]);
  return val;
}

/* ── Region row ──────────────────────────────────── */
function RegionRow({ name, count, pct, color, maxPct, delay }) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setW(maxPct > 0 ? (pct / maxPct) * 100 : 0), 150 + delay);
    return () => clearTimeout(t);
  }, [pct, maxPct, delay]);

  return (
    <div className="skpi-region-row">
      <div className="skpi-region-top">
        <span className="skpi-region-name">{name}</span>
        <div className="skpi-region-nums">
          <span className="skpi-region-count" style={{ color }}>{count.toLocaleString('en-SA')}</span>
          <span className="skpi-region-pct">{pct.toFixed(1)}%</span>
        </div>
      </div>
      <div className="skpi-bar-track">
        <div className="skpi-bar-fill"
          style={{ width: `${w}%`, background: color }}/>
      </div>
    </div>
  );
}

/* ── Skeleton ─────────────────────────────────────── */
function SkeletonCard({ color }) {
  return (
    <div className="skpi-card" style={{ '--skpi-color': color }}>
      <div className="skpi-header">
        <div className="skpi-skel skpi-skel-title"/>
        <div className="skpi-skel skpi-skel-chip"/>
      </div>
      <div className="skpi-total-skel">
        <div className="skpi-skel" style={{ width: 80, height: 36 }}/>
        <div className="skpi-skel" style={{ width: 50, height: 16, marginTop: 6 }}/>
      </div>
      {[100, 75, 55, 40].map((w, i) => (
        <div key={i} className="skpi-skel-row" style={{ animationDelay: `${i * 80}ms` }}>
          <div className="skpi-skel" style={{ width: '40%', height: 11 }}/>
          <div className="skpi-skel" style={{ width: `${w}%`, height: 6, marginTop: 4 }}/>
        </div>
      ))}
    </div>
  );
}

/* ── Main card ─────────────────────────────────────── */
export default function StatusKPICard({ type, data, loading }) {
  const isUnpaid = type === 'unpaid';
  const color    = isUnpaid ? '#c62828' : '#e65100';
  const colorBg  = isUnpaid ? 'rgba(198,40,40,0.08)' : 'rgba(230,81,0,0.08)';
  const label    = isUnpaid ? 'غير مسددة' : 'جزئي';
  const icon     = isUnpaid ? '✗' : '◑';

  const total   = data?.total ?? 0;
  const regions = data?.regions ?? [];
  const maxPct  = regions.length > 0 ? Math.max(...regions.map(r => r.pct)) : 100;

  const animTotal = useCountUp(total);

  if (loading) return <SkeletonCard color={color} />;

  return (
    <div className="skpi-card" style={{ '--skpi-color': color, '--skpi-bg': colorBg }}>

      {/* Header */}
      <div className="skpi-header">
        <div className="skpi-header-left">
          <span className="skpi-icon" style={{ background: colorBg, color }}>{icon}</span>
          <div>
            <div className="skpi-title">فواتير {label}</div>
            <div className="skpi-subtitle">حسب المنطقة</div>
          </div>
        </div>
      </div>

      {/* Total */}
      <div className="skpi-total-wrap">
        <span className="skpi-total-num" style={{ color }}>
          {animTotal.toLocaleString('en-SA')}
        </span>
        <span className="skpi-total-label">فاتورة {label}</span>
      </div>

      {/* Regions list */}
      {total === 0 ? (
        <div className="skpi-empty">لا توجد فواتير {label}</div>
      ) : (
        <div className="skpi-regions">
          {regions.map((r, i) => (
            <RegionRow
              key={r.name}
              name={r.name}
              count={r.count}
              pct={r.pct}
              color={color}
              maxPct={maxPct}
              delay={i * 60}
            />
          ))}
        </div>
      )}
    </div>
  );
}
