import React, { useEffect, useRef, useState } from 'react';
import './InvoiceStatusChart.css';

/* ── Donut math ───────────────────────────────────── */
const R    = 52;
const CX   = 64;
const CY   = 64;
const CIRC = 2 * Math.PI * R; // 326.73

function DonutChart({ paid, partial, unpaid, animated }) {
  const total = paid + partial + unpaid;
  if (total === 0) return (
    <svg viewBox="0 0 128 128" className="donut-svg">
      <circle cx={CX} cy={CY} r={R} fill="none"
        stroke="var(--color-border)" strokeWidth="16"/>
      <text x={CX} y={CY+5} textAnchor="middle"
        fontSize="13" fill="var(--color-text-muted)" fontFamily="inherit">
        لا بيانات
      </text>
    </svg>
  );

  const paidLen = animated ? (paid    / total) * CIRC : 0;
  const partLen = animated ? (partial / total) * CIRC : 0;
  const unpLen  = animated ? (unpaid  / total) * CIRC : 0;

  // offsets: each segment starts after the previous ones
  // SVG strokes start at 3 o'clock → rotate -90deg to start at 12 o'clock
  const paidOffset = CIRC;                   // start at 12
  const partOffset = CIRC - paidLen;        // after paid
  const unpOffset  = CIRC - paidLen - partLen; // after partial

  return (
    <svg viewBox="0 0 128 128" className="donut-svg">
      {/* Background ring */}
      <circle cx={CX} cy={CY} r={R} fill="none"
        stroke="var(--color-border)" strokeWidth="16"/>

      {/* Paid — green */}
      {paidLen > 0 && (
        <circle cx={CX} cy={CY} r={R} fill="none"
          stroke="#2e7d32" strokeWidth="16"
          strokeLinecap="butt"
          strokeDasharray={`${paidLen} ${CIRC - paidLen}`}
          strokeDashoffset={paidOffset}
          transform={`rotate(-90 ${CX} ${CY})`}
          className="donut-seg"
        />
      )}

      {/* Partial — orange */}
      {partLen > 0 && (
        <circle cx={CX} cy={CY} r={R} fill="none"
          stroke="#e65100" strokeWidth="16"
          strokeLinecap="butt"
          strokeDasharray={`${partLen} ${CIRC - partLen}`}
          strokeDashoffset={partOffset}
          transform={`rotate(-90 ${CX} ${CY})`}
          className="donut-seg"
        />
      )}

      {/* Unpaid — red */}
      {unpLen > 0 && (
        <circle cx={CX} cy={CY} r={R} fill="none"
          stroke="#c62828" strokeWidth="16"
          strokeLinecap="butt"
          strokeDasharray={`${unpLen} ${CIRC - unpLen}`}
          strokeDashoffset={unpOffset}
          transform={`rotate(-90 ${CX} ${CY})`}
          className="donut-seg"
        />
      )}

      {/* Center text */}
      <text x={CX} y={CY - 7} textAnchor="middle"
        fontSize="18" fontWeight="700" fill="var(--color-text-primary)"
        fontFamily="'Inter',sans-serif">
        {total.toLocaleString('en-SA')}
      </text>
      <text x={CX} y={CY + 11} textAnchor="middle"
        fontSize="10" fill="var(--color-text-muted)"
        fontFamily="inherit">
        فاتورة
      </text>
    </svg>
  );
}

/* ── Stat row ─────────────────────────────────────── */
function StatRow({ label, count, pct, color, bg, delay }) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setW(pct), 120 + delay);
    return () => clearTimeout(t);
  }, [pct, delay]);

  return (
    <div className="sc-stat-row">
      <div className="sc-stat-label">
        <span className="sc-dot" style={{ background: color }}/>
        <span className="sc-stat-name">{label}</span>
      </div>
      <div className="sc-bar-wrap">
        <div className="sc-bar-track">
          <div className="sc-bar-fill"
            style={{ width: `${w}%`, background: color, '--bg': bg }}/>
        </div>
        <span className="sc-stat-count" style={{ color }}>
          {count.toLocaleString('en-SA')}
        </span>
        <span className="sc-stat-pct">
          {pct.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

/* ── Main component ───────────────────────────────── */
export default function InvoiceStatusChart({ data, loading }) {
  const [animated, setAnimated] = useState(false);
  const ref = useRef(null);

  const paid    = Number(data?.paid_count    ?? 0);
  const partial = Number(data?.partial_count ?? 0);
  const unpaid  = Number(data?.unpaid_count  ?? 0);
  const total   = paid + partial + unpaid;

  const paidPct    = total > 0 ? (paid    / total) * 100 : 0;
  const partialPct = total > 0 ? (partial / total) * 100 : 0;
  const unpaidPct  = total > 0 ? (unpaid  / total) * 100 : 0;

  // Trigger animation when data arrives
  useEffect(() => {
    if (!loading && total > 0) {
      setAnimated(false);
      const t = setTimeout(() => setAnimated(true), 80);
      return () => clearTimeout(t);
    }
  }, [loading, total]);

  return (
    <div className="sc-card" ref={ref}>
      {/* Header */}
      <div className="sc-header">
        <div className="sc-title-wrap">
          <span className="sc-title">حالة الفواتير</span>
          <span className="sc-subtitle">توزيع الحالات على إجمالي الفواتير</span>
        </div>
        {!loading && total > 0 && (
          <div className="sc-total-chip">
            {total.toLocaleString('en-SA')} فاتورة
          </div>
        )}
      </div>

      {loading ? (
        <div className="sc-loading">
          <div className="sc-donut-skel"/>
          <div className="sc-rows-skel">
            {[1,2,3].map(i => <div key={i} className="sc-row-skel"/>)}
          </div>
        </div>
      ) : (
        <div className="sc-body">
          {/* Donut */}
          <div className="sc-donut-wrap">
            <DonutChart paid={paid} partial={partial} unpaid={unpaid} animated={animated}/>
          </div>

          {/* Stats */}
          <div className="sc-stats">
            <StatRow
              label="مسددة" count={paid} pct={paidPct}
              color="#2e7d32" bg="rgba(46,125,50,0.08)" delay={0}
            />
            <StatRow
              label="جزئي" count={partial} pct={partialPct}
              color="#e65100" bg="rgba(230,81,0,0.08)" delay={80}
            />
            <StatRow
              label="غير مسددة" count={unpaid} pct={unpaidPct}
              color="#c62828" bg="rgba(198,40,40,0.08)" delay={160}
            />

            {/* Divider + totals */}
            <div className="sc-totals">
              <div className="sc-total-item">
                <span className="sc-total-lbl">إجمالي الفواتير</span>
                <span className="sc-total-val">{total.toLocaleString('en-SA')}</span>
              </div>
              <div className="sc-total-item">
                <span className="sc-total-lbl">بحاجة تحصيل</span>
                <span className="sc-total-val" style={{color:'#c62828'}}>
                  {(partial + unpaid).toLocaleString('en-SA')}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
