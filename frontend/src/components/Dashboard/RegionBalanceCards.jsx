import React from 'react';
import { Settings2, RotateCcw } from 'lucide-react';
import useRegionCardSettings, { SIZE_OPTS, FONT_STEPS } from '../../hooks/useRegionCardSettings';
import './RegionBalanceCards.css';

/* ── Year accent colours (same palette as YearStrip) ── */
const YEAR_COLORS = {
  2024: { line: 'var(--color-brand-red)',    bg: 'rgba(198,40,40,0.08)'  },
  2025: { line: 'var(--color-brand-green)',  bg: 'rgba(46,125,50,0.08)'  },
  2026: { line: 'var(--color-brand-gold)',   bg: 'rgba(245,197,24,0.10)' },
};
function yearColor(y) {
  return YEAR_COLORS[y] ?? { line: 'var(--color-text-secondary)', bg: 'var(--color-bg-alt)' };
}

/* ── Compact number formatter ── */
function fmtBal(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(1)     + 'K';
  return Math.round(v).toLocaleString('en-SA');
}

/* ── Skeleton placeholder ── */
function SkeletonCard() {
  return (
    <div className="rbc-card rbc-skeleton" aria-hidden>
      <div className="rbc-sk rbc-sk-title" />
      <div className="rbc-sk rbc-sk-sub"   />
      {[0, 1, 2].map(i => (
        <div key={i} className="rbc-row rbc-sk-row">
          <div className="rbc-sk rbc-sk-yr"  />
          <div className="rbc-sk rbc-sk-bar" />
          <div className="rbc-sk rbc-sk-num" />
        </div>
      ))}
    </div>
  );
}

/* ── Settings bar ── */
function RBCSettingsBar({ canEdit, cardSize, fontScale, canFontUp, canFontDown, setCardSize, fontUp, fontDown, reset }) {
  if (!canEdit) return null;
  return (
    <div className="rbc-settings-bar">
      {/* Label */}
      <span className="rbc-settings-lbl">
        <Settings2 size={11} /> تخصيص الكروت
      </span>

      {/* Size presets */}
      <div className="rbc-settings-group">
        <span className="rbc-settings-sublbl">الحجم</span>
        <div className="rbc-size-btns">
          {SIZE_OPTS.map(o => (
            <button
              key={o.val}
              className={`rbc-sz-btn${cardSize === o.val ? ' active' : ''}`}
              onClick={() => setCardSize(o.val)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rbc-settings-sep" />

      {/* Font scale */}
      <div className="rbc-settings-group">
        <span className="rbc-settings-sublbl">الخط</span>
        <div className="rbc-font-btns">
          <button
            className="rbc-font-btn"
            onClick={fontDown}
            disabled={!canFontDown}
            title="تصغير الخط"
          >
            A<sup>−</sup>
          </button>
          <span className="rbc-font-pct">{Math.round(fontScale * 100)}%</span>
          <button
            className="rbc-font-btn"
            onClick={fontUp}
            disabled={!canFontUp}
            title="تكبير الخط"
          >
            A<sup>+</sup>
          </button>
        </div>
      </div>

      {/* Reset */}
      <button className="rbc-reset-btn" onClick={reset} title="إعادة الضبط">
        <RotateCcw size={11} />
      </button>
    </div>
  );
}

/* ── Main component ── */
export default function RegionBalanceCards({ data = [], loading }) {
  const {
    cardSize, fontScale, canEdit,
    setCardSize, fontUp, fontDown, canFontUp, canFontDown, reset,
  } = useRegionCardSettings();

  const cardWidth = SIZE_OPTS.find(o => o.val === cardSize)?.width ?? 230;

  /* CSS vars injected on the strip container */
  const stripVars = {
    '--rbc-card-w':  `${cardWidth}px`,
    '--rbc-f-scale': fontScale,
  };

  if (loading) {
    return (
      <div className="rbc-section">
        <RBCSettingsBar
          canEdit={canEdit}
          cardSize={cardSize} fontScale={fontScale}
          canFontUp={canFontUp} canFontDown={canFontDown}
          setCardSize={setCardSize} fontUp={fontUp} fontDown={fontDown} reset={reset}
        />
        <div className="rbc-strip" style={stripVars} role="list" aria-label="أرصدة المناطق">
          {[0, 1, 2].map(i => <SkeletonCard key={i} />)}
        </div>
      </div>
    );
  }

  if (!data.length) return null;

  return (
    <div className="rbc-section">
      <RBCSettingsBar
        cardSize={cardSize} fontScale={fontScale}
        canFontUp={canFontUp} canFontDown={canFontDown}
        setCardSize={setCardSize} fontUp={fontUp} fontDown={fontDown} reset={reset}
      />

      <div className="rbc-strip" style={stripVars} role="list" aria-label="أرصدة المناطق">
        {data.map((region, idx) => {
          const maxBal = Math.max(...region.years.map(y => y.balance), 1);
          const rate   = region.total_amount > 0
            ? (region.total_paid / region.total_amount * 100)
            : 0;

          return (
            <div
              key={region.region_name}
              className={`rbc-card rbc-card-${cardSize}`}
              role="listitem"
              style={{ animationDelay: `${idx * 50}ms` }}
            >
              {/* Header */}
              <div className="rbc-head">
                <span className="rbc-name">{region.region_name}</span>
                <span className="rbc-rate">{rate.toFixed(1)}%</span>
              </div>

              {/* Total balance */}
              <div className="rbc-total-bal">
                {fmtBal(region.total_balance)}
                <span className="rbc-total-lbl"> رصيد</span>
              </div>

              {/* Divider */}
              <div className="rbc-divider" />

              {/* Year rows */}
              <div className="rbc-rows">
                {region.years.map(y => {
                  const c   = yearColor(y.year);
                  const pct = maxBal > 0 ? Math.min(100, (y.balance / maxBal) * 100) : 0;
                  return (
                    <div key={y.year} className="rbc-row">
                      <span className="rbc-yr" style={{ color: c.line }}>{y.year}</span>
                      <div className="rbc-bar-track">
                        <div
                          className="rbc-bar-fill"
                          style={{ width: `${pct}%`, background: c.line }}
                        />
                      </div>
                      <span className="rbc-bal">{fmtBal(y.balance)}</span>
                    </div>
                  );
                })}
              </div>

              {/* Footer rate bar */}
              <div className="rbc-foot-bar">
                <div
                  className="rbc-foot-fill"
                  style={{ width: `${Math.min(100, rate)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
