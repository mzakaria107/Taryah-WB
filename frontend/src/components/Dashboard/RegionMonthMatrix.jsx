import React, { useState, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ChevronLeft } from 'lucide-react';
import client from '../../api/client';
import RegionMonthDrawer from './RegionMonthDrawer';
import './RegionMonthMatrix.css';

const MONTH_AR = [
  'يناير','فبراير','مارس','أبريل','مايو','يونيو',
  'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر',
];

function fmtBal(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(1) + 'K';
  return Math.round(v).toLocaleString('en-SA');
}

/* ── Heat-map colouring ── */
function cellStyle(balance, maxBalance) {
  if (!balance || balance <= 0 || !maxBalance) return {};
  const ratio   = Math.min(balance / maxBalance, 1);
  const opacity = 0.07 + ratio * 0.62;
  return {
    background: `rgba(198,40,40,${opacity.toFixed(2)})`,
    color:      ratio > 0.55 ? '#fff' : ratio > 0.28 ? '#7f0000' : 'var(--color-text-primary)',
  };
}

/* ── Skeleton ── */
function SkeletonMatrix() {
  return (
    <div className="rmm-section">
      <div className="rmm-header-bar">
        <div className="rmm-sk rmm-sk-title" />
      </div>
      <div className="rmm-wrapper">
        <table className="rmm-table">
          <thead>
            <tr>
              <th className="rmm-th-region rmm-sticky-col"><div className="rmm-sk" style={{ width: 60 }} /></th>
              {Array.from({ length: 6 }, (_, i) => (
                <th key={i} className="rmm-th-month"><div className="rmm-sk" style={{ width: 40, margin: 'auto' }} /></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 4 }, (_, r) => (
              <tr key={r}>
                <td className="rmm-td-region rmm-sticky-col"><div className="rmm-sk" style={{ width: '80%' }} /></td>
                {Array.from({ length: 6 }, (_, c) => (
                  <td key={c} className="rmm-td-cell" style={{ background: '#f5f5f5' }}>
                    <div className="rmm-sk" style={{ width: 42, height: 12 }} />
                    <div className="rmm-sk" style={{ width: 24, height: 10, marginTop: 4 }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function RegionMonthMatrix({ defaultYear, matrixParams, availableYears = [] }) {
  const [year,         setYear]         = useState(defaultYear);
  const [selectedCell, setSelectedCell] = useState(null);
  const [drawerTop,    setDrawerTop]    = useState(0);
  const sectionRef = useRef(null);

  /* Sync when parent's defaultYear changes (e.g. user selects different year) */
  React.useEffect(() => { setYear(defaultYear); }, [defaultYear]);

  const queryParams = useMemo(
    () => ({ ...matrixParams, years: String(year) }),
    [matrixParams, year]
  );

  const { data, isLoading } = useQuery({
    queryKey:       ['region-month-matrix', queryParams],
    queryFn:        () => client.get('/invoices/region-month-matrix', { params: queryParams }).then(r => r.data),
    staleTime:      30_000,
    placeholderData: prev => prev,
  });

  /* ── ALL computations/hooks BEFORE any conditional return ── */
  const months   = data?.months   ?? [];
  const regions  = data?.regions  ?? [];
  const colTotals = data?.colTotals ?? {};

  const maxBalance = useMemo(() => {
    if (!regions.length || !months.length) return 1;
    return Math.max(
      ...regions.flatMap(r => months.map(m => r.months[m]?.balance || 0)),
      1
    );
  }, [regions, months]);

  const grandBalance = useMemo(
    () => regions.reduce((s, r) => s + r.total.balance, 0),
    [regions]
  );
  const grandCount = useMemo(
    () => regions.reduce((s, r) => s + r.total.count, 0),
    [regions]
  );

  /* ── Early returns AFTER all hooks ── */
  if (isLoading && !data) return <SkeletonMatrix />;
  if (!regions.length)    return null;

  return (
    <div className="rmm-section" ref={sectionRef}>

      {/* ── Header bar ── */}
      <div className="rmm-header-bar">
        <span className="rmm-title">
          📊 مصفوفة المناطق والشهور — الفواتير غير المسددة
        </span>

        {/* Year picker */}
        <div className="rmm-year-picker">
          <button
            className="rmm-yr-btn"
            onClick={() => setYear(y => y - 1)}
            disabled={availableYears.length > 0 && year <= Math.min(...availableYears)}
            title={availableYears.length > 0 && year <= Math.min(...availableYears) ? 'لا توجد سنة سابقة' : 'السنة السابقة'}
          >
            <ChevronRight size={14} />
          </button>
          <span className="rmm-yr-label">{year}</span>
          <button
            className="rmm-yr-btn"
            onClick={() => setYear(y => y + 1)}
            disabled={year >= new Date().getFullYear()}
            title={year >= new Date().getFullYear() ? 'لا توجد سنة تالية' : 'السنة التالية'}
          >
            <ChevronLeft size={14} />
          </button>
        </div>

        <span className="rmm-grand">
          رصيد متبقٍ: <strong>{fmtBal(grandBalance)}</strong> ر.س
          &nbsp;·&nbsp;
          <strong>{grandCount.toLocaleString('en-SA')}</strong> فاتورة
          &nbsp;·&nbsp;
          <span className="rmm-grand-paid">✓ {regions.reduce((s,r)=>s+r.total.paid,0).toLocaleString('en-SA')} مسددة</span>
        </span>
      </div>

      {/* ── Scrollable table ── */}
      <div className="rmm-wrapper">
        <table className="rmm-table">
          <thead>
            <tr>
              <th className="rmm-th-region rmm-sticky-col">المنطقة</th>
              {months.map(m => (
                <th key={m} className="rmm-th-month">{MONTH_AR[m - 1]}</th>
              ))}
              <th className="rmm-th-total">الإجمالي</th>
            </tr>
          </thead>

          <tbody>
            {regions.map(region => (
              <tr key={region.id ?? region.name} className="rmm-tr">
                <td className="rmm-td-region rmm-sticky-col">
                  {region.name}
                </td>

                {months.map(m => {
                  const cell = region.months[m];
                  if (!cell || cell.count <= 0) {
                    return <td key={m} className="rmm-td-empty">—</td>;
                  }
                  const hasDue = cell.balance > 0;
                  return (
                    <td
                      key={m}
                      className={`rmm-td-cell${!hasDue ? ' rmm-td-cell-paid' : ''}`}
                      style={hasDue ? cellStyle(cell.balance, maxBalance) : {}}
                      onClick={() => {
                        if (sectionRef.current) {
                          setDrawerTop(sectionRef.current.getBoundingClientRect().top);
                        }
                        setSelectedCell({
                          region_id:   region.id,
                          region_name: region.name,
                          month: m,
                          year,
                        });
                      }}
                      title={`${region.name} ← ${MONTH_AR[m-1]} ${year}\n✗ ${cell.unpaid} غير مسدد  •  ◑ ${cell.partial} جزئي  •  ✓ ${cell.paid} مسدد\nرصيد: ${fmtBal(cell.balance)} ر.س`}
                    >
                      {hasDue
                        ? <span className="rmm-cell-bal">{fmtBal(cell.balance)}</span>
                        : <span className="rmm-cell-bal rmm-cell-bal-zero">0</span>
                      }
                      <span className="rmm-cell-pills">
                        {cell.unpaid  > 0 && <span className="rmm-pill rmm-pill-u">✗{cell.unpaid}</span>}
                        {cell.partial > 0 && <span className="rmm-pill rmm-pill-p">◑{cell.partial}</span>}
                        {cell.paid    > 0 && <span className="rmm-pill rmm-pill-ok">✓{cell.paid}</span>}
                      </span>
                    </td>
                  );
                })}

                {/* Row total */}
                <td className="rmm-td-row-total">
                  <span className="rmm-cell-bal">{fmtBal(region.total.balance)}</span>
                  <span className="rmm-cell-pills" style={{ justifyContent:'center' }}>
                    {region.total.unpaid  > 0 && <span className="rmm-pill rmm-pill-u">✗{region.total.unpaid}</span>}
                    {region.total.partial > 0 && <span className="rmm-pill rmm-pill-p">◑{region.total.partial}</span>}
                    {region.total.paid    > 0 && <span className="rmm-pill rmm-pill-ok">✓{region.total.paid}</span>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>

          <tfoot>
            <tr className="rmm-tf-row">
              <td className="rmm-tf-label rmm-sticky-col">الإجمالي</td>
              {months.map(m => {
                const ct = colTotals[m] || { count: 0, unpaid: 0, partial: 0, paid: 0, balance: 0 };
                return (
                  <td key={m} className="rmm-td-col-total">
                    <span className="rmm-cell-bal">{fmtBal(ct.balance)}</span>
                    <span className="rmm-cell-pills" style={{ justifyContent:'center' }}>
                      {ct.unpaid  > 0 && <span className="rmm-pill rmm-pill-u">✗{ct.unpaid}</span>}
                      {ct.partial > 0 && <span className="rmm-pill rmm-pill-p">◑{ct.partial}</span>}
                      {ct.paid    > 0 && <span className="rmm-pill rmm-pill-ok">✓{ct.paid}</span>}
                    </span>
                  </td>
                );
              })}
              <td className="rmm-td-grand-total">
                <span className="rmm-cell-bal">{fmtBal(grandBalance)}</span>
                <span className="rmm-cell-cnt">{grandCount.toLocaleString('en-SA')}</span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── Drawer ── */}
      {selectedCell && (
        <RegionMonthDrawer
          cell={selectedCell}
          customerTypeParam={matrixParams?.customer_type}
          onClose={() => setSelectedCell(null)}
          topOffset={drawerTop}
        />
      )}
    </div>
  );
}
