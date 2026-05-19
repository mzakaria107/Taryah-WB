import React, { useEffect, useState } from 'react';
import './CombinedStatusKPICard.css';

/* ── Animated count ───────────────────────────── */
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

const COLOR_UNPAID  = '#c62828';
const COLOR_PARTIAL = '#e65100';
const BG_UNPAID     = 'rgba(198,40,40,0.09)';
const BG_PARTIAL    = 'rgba(230,81,0,0.09)';

/* ── Region row ───────────────────────────────── */
function RegionRow({ name, unpaidCount, partialCount, totalCount, grandTotal, delay }) {
  const pct = grandTotal > 0 ? (totalCount / grandTotal) * 100 : 0;
  const [w, setW] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setW(pct), 160 + delay);
    return () => clearTimeout(t);
  }, [pct, delay]);

  return (
    <div className="ckpi-region-row">
      <div className="ckpi-region-top">
        <span className="ckpi-region-name">{name}</span>
        <div className="ckpi-region-nums">
          {unpaidCount > 0 && (
            <span className="ckpi-badge" style={{ color: COLOR_UNPAID, background: BG_UNPAID }}>
              ✗ {unpaidCount.toLocaleString('en-SA')}
            </span>
          )}
          {partialCount > 0 && (
            <span className="ckpi-badge" style={{ color: COLOR_PARTIAL, background: BG_PARTIAL }}>
              ◑ {partialCount.toLocaleString('en-SA')}
            </span>
          )}
        </div>
      </div>
      <div className="ckpi-bar-track">
        <div
          className="ckpi-bar-unpaid"
          style={{
            width: grandTotal > 0 ? `${(unpaidCount / grandTotal) * 100}%` : '0%',
            transition: `width ${500 + delay}ms cubic-bezier(.4,0,.2,1)`,
          }}
        />
        <div
          className="ckpi-bar-partial"
          style={{
            width: grandTotal > 0 ? `${(partialCount / grandTotal) * 100}%` : '0%',
            transition: `width ${500 + delay + 80}ms cubic-bezier(.4,0,.2,1)`,
          }}
        />
      </div>
    </div>
  );
}

/* ── Skeleton ─────────────────────────────────── */
function Skeleton() {
  return (
    <div className="ckpi-card">
      <div className="ckpi-header">
        <div className="ckpi-skel" style={{ width: 130, height: 14 }} />
      </div>
      <div className="ckpi-totals-row">
        {[1, 2, 3].map(i => (
          <div key={i} className="ckpi-skel" style={{ flex: 1, height: 52, borderRadius: 10 }} />
        ))}
      </div>
      {[100, 80, 65, 55, 45, 35].map((w, i) => (
        <div key={i} className="ckpi-skel-row" style={{ animationDelay: `${i * 60}ms` }}>
          <div className="ckpi-skel" style={{ width: '38%', height: 11 }} />
          <div className="ckpi-skel" style={{ width: `${w}%`, height: 5, marginTop: 5 }} />
        </div>
      ))}
    </div>
  );
}

/* ── Main component ───────────────────────────── */
export default function CombinedStatusKPICard({ unpaidData, partialData, loading }) {
  const unpaidTotal  = unpaidData?.total  ?? 0;
  const partialTotal = partialData?.total ?? 0;
  const grandTotal   = unpaidTotal + partialTotal;

  const animGrand   = useCountUp(grandTotal);
  const animUnpaid  = useCountUp(unpaidTotal);
  const animPartial = useCountUp(partialTotal);

  // Merge regions from both
  const regionMap = new Map();
  (unpaidData?.regions ?? []).forEach(r => {
    regionMap.set(r.name, { name: r.name, unpaid: r.count, partial: 0 });
  });
  (partialData?.regions ?? []).forEach(r => {
    if (regionMap.has(r.name)) {
      regionMap.get(r.name).partial = r.count;
    } else {
      regionMap.set(r.name, { name: r.name, unpaid: 0, partial: r.count });
    }
  });
  const regions = Array.from(regionMap.values())
    .map(r => ({ ...r, total: r.unpaid + r.partial }))
    .sort((a, b) => b.total - a.total);

  if (loading) return <Skeleton />;

  return (
    <div className="ckpi-card">

      {/* Header */}
      <div className="ckpi-header">
        <span className="ckpi-title">فواتير غير مسددة</span>
        <span className="ckpi-subtitle">حسب المنطقة</span>
      </div>

      {/* Three totals */}
      <div className="ckpi-totals-row">

        {/* Grand total */}
        <div className="ckpi-total-chip ckpi-total-grand">
          <span className="ckpi-total-num" style={{ color: '#333' }}>
            {animGrand.toLocaleString('en-SA')}
          </span>
          <span className="ckpi-total-lbl">الإجمالي</span>
        </div>

        {/* Unpaid */}
        <div className="ckpi-total-chip" style={{ '--ckpi-chip-color': COLOR_UNPAID, '--ckpi-chip-bg': BG_UNPAID }}>
          <div className="ckpi-chip-icon">✗</div>
          <span className="ckpi-total-num" style={{ color: COLOR_UNPAID }}>
            {animUnpaid.toLocaleString('en-SA')}
          </span>
          <span className="ckpi-total-lbl">غير مسددة</span>
        </div>

        {/* Partial */}
        <div className="ckpi-total-chip" style={{ '--ckpi-chip-color': COLOR_PARTIAL, '--ckpi-chip-bg': BG_PARTIAL }}>
          <div className="ckpi-chip-icon">◑</div>
          <span className="ckpi-total-num" style={{ color: COLOR_PARTIAL }}>
            {animPartial.toLocaleString('en-SA')}
          </span>
          <span className="ckpi-total-lbl">جزئي</span>
        </div>

      </div>

      {/* Regions */}
      {grandTotal === 0 ? (
        <div className="ckpi-empty">لا توجد فواتير غير مسددة</div>
      ) : (
        <div className="ckpi-regions">
          {regions.map((r, i) => (
            <RegionRow
              key={r.name}
              name={r.name}
              unpaidCount={r.unpaid}
              partialCount={r.partial}
              totalCount={r.total}
              grandTotal={grandTotal}
              delay={i * 55}
            />
          ))}
        </div>
      )}
    </div>
  );
}
