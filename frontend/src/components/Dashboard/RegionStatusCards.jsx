import React from 'react';
import useRegionCardSettings, { SIZE_OPTS } from '../../hooks/useRegionCardSettings';
import './RegionBalanceCards.css';
import './RegionStatusCards.css';

/* ── Year accent colours (same palette as YearStrip / RegionBalanceCards) ── */
const YEAR_COLORS = {
  2024: { line: 'var(--color-brand-red)',   bg: 'rgba(198,40,40,0.08)'  },
  2025: { line: 'var(--color-brand-green)', bg: 'rgba(46,125,50,0.08)'  },
  2026: { line: 'var(--color-brand-gold)',  bg: 'rgba(245,197,24,0.10)' },
};
function yearColor(y) {
  return YEAR_COLORS[y] ?? { line: 'var(--color-text-secondary)', bg: 'var(--color-bg-alt)' };
}

/* ── Skeleton ── */
function SkeletonCard() {
  return (
    <div className="rbc-card rbc-skeleton rsc-card" aria-hidden>
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

/* ── Main component ── */
export default function RegionStatusCards({ statusByRegion, loading }) {
  const {
    cardSize, fontScale, canFontUp, canFontDown,
  } = useRegionCardSettings();    // reuse same settings as balance cards

  const cardWidth = SIZE_OPTS.find(o => o.val === cardSize)?.width ?? 152;
  const stripVars = { '--rbc-card-w': `${cardWidth}px`, '--rbc-f-scale': fontScale };

  /* Prefer the enriched `regions` array from the new backend shape;
     fall back to merging unpaid+partial arrays (old shape safety net)    */
  let regions = statusByRegion?.regions ?? [];

  if (!regions.length) {
    // Legacy fallback: merge from unpaid.regions + partial.regions
    const regionMap = new Map();
    (statusByRegion?.unpaid?.regions ?? []).forEach(r => {
      regionMap.set(r.name, {
        name: r.name, unpaid: r.count, partial: 0,
        years: (r.years ?? []).map(y => ({ year: y.year, unpaid: y.count, partial: 0, total: y.count })),
      });
    });
    (statusByRegion?.partial?.regions ?? []).forEach(r => {
      if (regionMap.has(r.name)) {
        const reg = regionMap.get(r.name);
        reg.partial = r.count;
        (r.years ?? []).forEach(y => {
          const yr = reg.years.find(a => a.year === y.year);
          if (yr) { yr.partial = y.count; yr.total = yr.unpaid + y.count; }
          else    reg.years.push({ year: y.year, unpaid: 0, partial: y.count, total: y.count });
        });
      } else {
        regionMap.set(r.name, {
          name: r.name, unpaid: 0, partial: r.count,
          years: (r.years ?? []).map(y => ({ year: y.year, unpaid: 0, partial: y.count, total: y.count })),
        });
      }
    });
    regions = [...regionMap.values()].map(r => ({ ...r, total: r.unpaid + r.partial }));
  }

  // Ensure each region has a `total` on year entries
  regions = regions.map(r => ({
    ...r,
    total: r.total ?? (r.unpaid + r.partial),
    years: (r.years ?? []).map(y => ({
      ...y,
      total: y.total ?? (y.unpaid + y.partial),
    })).sort((a, b) => a.year - b.year),
  })).sort((a, b) => b.total - a.total);

  const grandTotal = regions.reduce((s, r) => s + r.total, 0);

  const sectionLabel = '📋 الفواتير غير المسددة كليًا أو جزئيًا — حسب المنطقة والسنة';

  if (loading) {
    return (
      <div className="rbc-section rsc-section">
        <div className="rsc-header-row">
          <span className="rsc-section-lbl">{sectionLabel}</span>
        </div>
        <div className="rbc-strip" style={stripVars}>
          {[0, 1, 2, 3].map(i => <SkeletonCard key={i} />)}
        </div>
      </div>
    );
  }

  if (!regions.length) return null;

  return (
    <div className="rbc-section rsc-section">
      {/* Section label */}
      <div className="rsc-header-row">
        <span className="rsc-section-lbl">{sectionLabel}</span>
        <span className="rsc-grand-total">
          إجمالي:&nbsp;
          <strong>{grandTotal.toLocaleString('en-SA')}</strong>
          &nbsp;فاتورة
          &nbsp;·&nbsp;
          <span style={{ color: '#c62828' }}>✗ {(statusByRegion?.unpaid?.total ?? 0).toLocaleString('en-SA')} غير مسددة</span>
          &nbsp;·&nbsp;
          <span style={{ color: '#e65100' }}>◑ {(statusByRegion?.partial?.total ?? 0).toLocaleString('en-SA')} جزئي</span>
        </span>
      </div>

      <div className="rbc-strip" style={stripVars} role="list" aria-label="فواتير المناطق حسب السنة">
        {regions.map((region, idx) => {
          const pctOfAll = grandTotal > 0 ? (region.total / grandTotal * 100) : 0;

          // Max year-total within this region (for bar scaling)
          const maxYearTotal = region.years.length > 0
            ? Math.max(...region.years.map(y => y.total), 1)
            : 1;

          const unpaidOfTotal  = region.total > 0 ? (region.unpaid  / region.total * 100) : 0;
          const partialOfTotal = region.total > 0 ? (region.partial / region.total * 100) : 0;

          return (
            <div
              key={region.name}
              className={`rbc-card rbc-card-${cardSize} rsc-card`}
              role="listitem"
              style={{ animationDelay: `${idx * 45}ms` }}
            >
              {/* Header */}
              <div className="rbc-head">
                <span className="rbc-name">{region.name}</span>
                <span className="rbc-rate rsc-rate-pct">{pctOfAll.toFixed(1)}%</span>
              </div>

              {/* Total count */}
              <div className="rbc-total-bal rsc-total-count">
                {region.total.toLocaleString('en-SA')}
                <span className="rbc-total-lbl"> فاتورة</span>
              </div>

              {/* Divider */}
              <div className="rbc-divider" />

              {/* Year rows */}
              <div className="rbc-rows">
                {region.years.map(y => {
                  const c   = yearColor(y.year);
                  const pct = Math.min(100, (y.total / maxYearTotal) * 100);
                  return (
                    <div key={y.year} className="rbc-row">
                      <span className="rbc-yr" style={{ color: c.line }}>{y.year}</span>
                      <div className="rbc-bar-track">
                        <div
                          className="rbc-bar-fill"
                          style={{ width: `${pct}%`, background: c.line }}
                        />
                      </div>
                      <span className="rbc-bal rsc-yr-val" title={`✗ ${y.unpaid} · ◑ ${y.partial}`}>
                        {y.total.toLocaleString('en-SA')}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Dual-colour footer bar (unpaid red / partial orange) */}
              <div className="rbc-foot-bar rsc-foot-dual">
                <div className="rsc-foot-unpaid"  style={{ width: `${unpaidOfTotal}%`  }} />
                <div className="rsc-foot-partial" style={{ width: `${partialOfTotal}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
