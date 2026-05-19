import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import './SalesPieCharts.css';

const MONTH_AR = {
  1:'يناير', 2:'فبراير', 3:'مارس', 4:'أبريل', 5:'مايو', 6:'يونيو',
  7:'يوليو', 8:'أغسطس', 9:'سبتمبر', 10:'أكتوبر', 11:'نوفمبر', 12:'ديسمبر',
};

/* colour palette */
const PALETTE = [
  '#3b82f6','#22c55e','#f59e0b','#a855f7','#14b8a6',
  '#ef4444','#f97316','#06b6d4','#84cc16','#ec4899',
  '#6366f1','#0ea5e9','#10b981','#d946ef','#eab308',
];

/* ── Build SVG donut slices ── */
function buildSlices(data, total) {
  if (!total) return [];
  const r = 70, cx = 90, cy = 90, stroke = 28;
  const circ = 2 * Math.PI * r;
  const slices = [];
  let offset = 0;

  for (let i = 0; i < data.length; i++) {
    const pct  = data[i].value / total;
    const dash = pct * circ;
    slices.push({
      ...data[i],
      dash,
      gap:    circ - dash,
      offset: offset * circ,
      color:  PALETTE[i % PALETTE.length],
      pct:    Math.round(pct * 100),
    });
    offset += pct;
  }
  return slices;
}

const SIZES = ['sm', 'md', 'lg'];

/* ── Single donut ── */
function DonutChart({ title, slices, total, centerLabel, emptyMsg, editMode, visible, onToggle, onSize, size, cardId, shortLabel }) {
  const [hovered, setHovered] = useState(null);

  const sz = size || 'md';

  /* Edit bar shown in edit mode */
  function EditBar() {
    return (
      <div className="spc-edit-bar" onClick={e => e.stopPropagation()}>
        <span className="spc-ebar-label">{shortLabel || title}</span>
        <div className="spc-ebar-sizes">
          {SIZES.map(s => (
            <button
              key={s}
              className={`spc-edit-sz-btn${sz === s ? ' active' : ''}`}
              onClick={() => onSize && onSize(cardId, s)}
              title={s === 'sm' ? 'صغير' : s === 'md' ? 'متوسط' : 'كبير'}
            >
              {s === 'sm' ? 'S' : s === 'md' ? 'M' : 'L'}
            </button>
          ))}
        </div>
        <button
          className={`spc-edit-vis-btn${!visible ? ' spc-edit-vis-hidden' : ''}`}
          onClick={() => onToggle && onToggle(cardId)}
          title={visible ? 'إخفاء' : 'إظهار'}
        >
          {visible ? <Eye size={11} /> : <EyeOff size={11} />}
          <span>{visible ? 'إخفاء' : 'إظهار'}</span>
        </button>
      </div>
    );
  }

  /* Hidden placeholder in edit mode */
  if (editMode && !visible) {
    return (
      <div className="spc-chart-wrap spc-chart-hidden-wrap">
        <EditBar />
        <div
          className="spc-hidden-placeholder"
          onClick={() => onToggle && onToggle(cardId)}
          title="انقر لإظهار الرسم"
        >
          <EyeOff size={14} />
          <span>{shortLabel || title}</span>
        </div>
      </div>
    );
  }

  if (!total || !slices.length) {
    return (
      <div className={`spc-chart-wrap spc-chart-sz-${sz}`}>
        {editMode && <EditBar />}
        <div className="spc-chart-title">{title}</div>
        <div className="spc-empty">{emptyMsg || 'لا توجد بيانات'}</div>
      </div>
    );
  }

  const r = 70, cx = 90, cy = 90;

  return (
    <div className={`spc-chart-wrap spc-chart-sz-${sz}`}>
      {editMode && <EditBar />}
      <div className="spc-chart-title">{title}</div>
      <div className="spc-inner">
        {/* SVG Donut */}
        <div className="spc-svg-wrap">
          <svg viewBox="0 0 180 180" className="spc-svg">
            {/* background ring */}
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f3f4f6" strokeWidth="28" />
            {slices.map((s, i) => (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={r}
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
                  opacity: hovered != null && hovered !== i ? 0.55 : 1,
                }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
            {/* Center label */}
            <text x={cx} y={cy - 8} textAnchor="middle" className="spc-center-val">
              {hovered != null ? slices[hovered].value : total}
            </text>
            <text x={cx} y={cy + 12} textAnchor="middle" className="spc-center-sub">
              {hovered != null ? `${slices[hovered].pct}%` : centerLabel}
            </text>
          </svg>

          {/* Tooltip on hover */}
          {hovered != null && (
            <div className="spc-tooltip">
              <span className="spc-tt-dot" style={{ background: slices[hovered].color }} />
              <span className="spc-tt-name">{slices[hovered].label}</span>
              <span className="spc-tt-val">{slices[hovered].value}</span>
              <span className="spc-tt-pct">({slices[hovered].pct}%)</span>
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
              <span className="spc-leg-dot" style={{ background: s.color }} />
              <span className="spc-leg-name">{s.label}</span>
              <span className="spc-leg-val">{s.value}</span>
              <span className="spc-leg-pct">{s.pct}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Skeleton ── */
function PieSkeleton() {
  return (
    <div className="spc-chart-wrap spc-skel">
      <div className="spc-sk spc-sk-title" />
      <div className="spc-inner">
        <div className="spc-svg-wrap">
          <div className="spc-sk-donut" />
        </div>
        <div className="spc-legend">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="spc-leg-row">
              <div className="spc-sk spc-sk-dot" />
              <div className="spc-sk spc-sk-lname" />
              <div className="spc-sk spc-sk-lval" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Main export ── */
export default function SalesPieCharts({ data, loading, fetching, cardCfg, editMode, onToggleCard, onSizeCard }) {
  /* cardCfg: (cardId) => { visible: bool, size: 'sm'|'md'|'lg' } */
  const cfgNew     = cardCfg ? cardCfg('pie-new')     : { visible: true, size: 'md' };
  const cfgStopped = cardCfg ? cardCfg('pie-stopped') : { visible: true, size: 'md' };

  const showNew     = cfgNew.visible     !== false;
  const showStopped = cfgStopped.visible !== false;

  /* First load only — show skeleton for visible charts */
  if (loading && !data) {
    return (
      <div className="spc-row">
        {(editMode || showNew)     && <PieSkeleton />}
        {(editMode || showStopped) && <PieSkeleton />}
      </div>
    );
  }

  /* In normal mode, hide entirely if both hidden and no data */
  if (!editMode && !showNew && !showStopped) return null;
  if (!data || !data.regions || !data.regions.length) {
    if (!editMode) return null;
  }

  const regions   = data?.regions    || [];
  const maxMonth  = data?.maxMonth;
  const prevMonth = data?.prevMonth;

  /* --- Pie 1: New customers per region --- */
  const newData = regions
    .filter(r => r.newCount > 0)
    .map(r => ({ label: r.region, value: r.newCount }));
  const totalNew = newData.reduce((s, r) => s + r.value, 0);
  const newSlices = buildSlices(newData, totalNew);

  /* --- Pie 2: Stopped customers per region --- */
  const stoppedData = regions
    .filter(r => r.stoppedCount > 0)
    .map(r => ({ label: r.region, value: r.stoppedCount, prevCount: r.prevCount }));
  const totalStopped = stoppedData.reduce((s, r) => s + r.value, 0);
  const stoppedSlices = buildSlices(stoppedData, totalStopped);

  const curLabel  = maxMonth  ? MONTH_AR[maxMonth]  : '—';
  const prevLabel = prevMonth ? MONTH_AR[prevMonth] : '—';

  return (
    <div className={`spc-row${fetching ? ' spc-refetching' : ''}`}>
      {(editMode || showNew) && (
        <DonutChart
          title={`🆕 العملاء الجدد في ${curLabel} — حسب المنطقة`}
          shortLabel="دائري: العملاء الجدد"
          slices={newSlices}
          total={totalNew}
          centerLabel="إجمالي"
          emptyMsg={`لا يوجد عملاء جدد في ${curLabel}`}
          editMode={editMode}
          visible={showNew}
          onToggle={onToggleCard}
          onSize={onSizeCard}
          size={cfgNew.size}
          cardId="pie-new"
        />
      )}
      {(editMode || showStopped) && (
        <DonutChart
          title={`⚠️ المتوقفون في ${curLabel} مقارنةً بـ ${prevLabel} — حسب المنطقة`}
          shortLabel="دائري: المتوقفون"
          slices={stoppedSlices}
          total={totalStopped}
          centerLabel="إجمالي"
          emptyMsg={`لا يوجد متوقفون (أو لا يوجد شهر سابق)`}
          editMode={editMode}
          visible={showStopped}
          onToggle={onToggleCard}
          onSize={onSizeCard}
          size={cfgStopped.size}
          cardId="pie-stopped"
        />
      )}
    </div>
  );
}
