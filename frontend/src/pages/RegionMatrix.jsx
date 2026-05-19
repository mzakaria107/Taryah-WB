import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import './RegionMatrix.css';

const MONTH_AR = {
  1:'يناير', 2:'فبراير', 3:'مارس', 4:'أبريل', 5:'مايو', 6:'يونيو',
  7:'يوليو', 8:'أغسطس', 9:'سبتمبر', 10:'أكتوبر', 11:'نوفمبر', 12:'ديسمبر',
};

function DeltaCell({ delta, pct }) {
  if (delta === 0) return (
    <div className="rm-delta rm-delta-zero">
      <Minus size={13} />
      <span>0</span>
    </div>
  );
  const up = delta > 0;
  return (
    <div className={`rm-delta ${up ? 'rm-delta-up' : 'rm-delta-down'}`}>
      {up
        ? <TrendingUp  size={14} className="rm-arrow-icon" />
        : <TrendingDown size={14} className="rm-arrow-icon" />
      }
      <span className="rm-delta-val">{up ? '+' : ''}{delta}</span>
      <span className="rm-delta-pct">
        {up ? '+' : ''}{pct}%
      </span>
    </div>
  );
}

/* ── Skeleton ── */
function MatrixSkeleton() {
  return (
    <div className="rm-wrap rm-skel">
      <div className="rm-sk rm-sk-title" />
      <table className="rm-table">
        <thead><tr>{[...Array(7)].map((_, i) => <th key={i}><div className="rm-sk rm-sk-th" /></th>)}</tr></thead>
        <tbody>
          {[...Array(5)].map((_, r) => (
            <tr key={r}>{[...Array(7)].map((_, c) => <td key={c}><div className="rm-sk rm-sk-td" /></td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RegionMatrix({ data, loading }) {
  if (loading && !data) return <MatrixSkeleton />;
  if (!data || !data.regions || !data.regions.length) return null;

  const { regions, maxMonth, prevMonth } = data;

  // Compute totals
  const totals = regions.reduce(
    (acc, r) => ({
      prevCount:      acc.prevCount      + (r.prevCount      || 0),
      currentCount:   acc.currentCount   + (r.currentCount   || 0),
      trulyNewCount:  acc.trulyNewCount  + (r.trulyNewCount  || 0),
      returningCount: acc.returningCount + (r.returningCount || 0),
    }),
    { prevCount: 0, currentCount: 0, trulyNewCount: 0, returningCount: 0 }
  );
  totals.delta = totals.currentCount - totals.prevCount;
  totals.pct   = totals.prevCount > 0
    ? Math.round(Math.abs(totals.delta) / totals.prevCount * 100)
    : 0;

  const curLabel  = maxMonth  ? MONTH_AR[maxMonth]  : '—';
  const prevLabel = prevMonth ? MONTH_AR[prevMonth] : '—';

  const rows = regions.map(r => ({
    ...r,
    delta: r.currentCount - r.prevCount,
    pct:   r.prevCount > 0
      ? Math.round(Math.abs(r.currentCount - r.prevCount) / r.prevCount * 100)
      : (r.currentCount > 0 ? 100 : 0),
    trulyNewCount:  r.trulyNewCount  || 0,
    returningCount: r.returningCount || 0,
  }));

  return (
    <div className="rm-wrap">
      <div className="rm-title">📊 مقارنة المناطق — {prevLabel} → {curLabel}</div>
      <div className="rm-scroll">
        <table className="rm-table">
          <thead>
            <tr>
              <th className="rm-th-region">المنطقة</th>
              <th className="rm-th-num" title={`إجمالي العملاء في ${prevLabel}`}>
                <div className="rm-th-inner">
                  <span className="rm-th-dot rm-dot-prev" />
                  {prevLabel}
                </div>
              </th>
              <th className="rm-th-num" title={`إجمالي العملاء في ${curLabel}`}>
                <div className="rm-th-inner">
                  <span className="rm-th-dot rm-dot-cur" />
                  {curLabel}
                </div>
              </th>
              <th className="rm-th-delta">الفارق</th>
              <th className="rm-th-new" title="عملاء جدد لم يتعاملوا من قبل نهائياً">
                <div className="rm-th-inner rm-th-inner-new">
                  🆕 <span>جدد</span>
                </div>
              </th>
              <th className="rm-th-returning" title="عملاء جدد هذا الشهر لكن لديهم فواتير من سنوات سابقة">
                <div className="rm-th-inner rm-th-inner-ret">
                  🔄 <span>عائدون</span>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.region} className="rm-tr">
                <td className="rm-td-region">{r.region}</td>
                <td className="rm-td-num rm-td-prev">{r.prevCount || '—'}</td>
                <td className="rm-td-num rm-td-cur">{r.currentCount || '—'}</td>
                <td className="rm-td-delta">
                  <DeltaCell delta={r.delta} pct={r.pct} />
                </td>
                <td className="rm-td-new">
                  {r.trulyNewCount > 0
                    ? <span className="rm-new-pill">{r.trulyNewCount}</span>
                    : <span className="rm-zero">—</span>
                  }
                </td>
                <td className="rm-td-returning">
                  {r.returningCount > 0
                    ? <span className="rm-ret-pill">{r.returningCount}</span>
                    : <span className="rm-zero">—</span>
                  }
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="rm-tf">
              <td className="rm-tf-label">الإجمالي</td>
              <td className="rm-td-num rm-tf-num">{totals.prevCount}</td>
              <td className="rm-td-num rm-tf-num">{totals.currentCount}</td>
              <td className="rm-td-delta">
                <DeltaCell delta={totals.delta} pct={totals.pct} />
              </td>
              <td className="rm-td-new">
                <span className="rm-new-pill rm-new-pill-total">{totals.trulyNewCount}</span>
              </td>
              <td className="rm-td-returning">
                <span className="rm-ret-pill rm-ret-pill-total">{totals.returningCount}</span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
