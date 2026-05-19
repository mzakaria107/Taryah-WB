import React, { useState } from 'react';
import { GripVertical, Pencil, RotateCcw, ChevronsUpDown } from 'lucide-react';
import MonthlyBalanceChart    from './MonthlyBalanceChart';
import CombinedStatusKPICard from './CombinedStatusKPICard';
import YearStrip              from './YearStrip';
import useStatusRowSettings, { SIZE_WEIGHTS, HEIGHT_OPTS, SR_FONT_STEPS } from '../../hooks/useStatusRowSettings';
import './StatusRow.css';

/* ── Width labels ── */
const WIDTH_OPTS = [
  { val: 'compact', label: 'ضيق'  },
  { val: 'normal',  label: 'عادي' },
  { val: 'large',   label: 'واسع' },
  { val: 'wide',    label: 'عريض' },
];

/* ── Draggable panel wrapper ── */
function DraggablePanel({
  id, editMode, size, onSizeChange,
  isDragging, isDragOver,
  onDragStart, onDragOver, onDrop, onDragEnd,
  children,
}) {
  const weight = SIZE_WEIGHTS[size] || 1;

  return (
    <div
      className={[
        'sr-panel',
        editMode   ? 'sr-panel-edit'      : '',
        isDragging ? 'sr-panel-dragging'  : '',
        isDragOver ? 'sr-panel-drag-over' : '',
      ].filter(Boolean).join(' ')}
      style={{ flex: `${weight} 1 0`, minWidth: 0 }}
      draggable={editMode}
      onDragStart={() => onDragStart(id)}
      onDragOver={e  => { e.preventDefault(); onDragOver(id); }}
      onDrop={()     => onDrop(id)}
      onDragEnd={onDragEnd}
    >
      {editMode && (
        <div className="sr-edit-bar">
          <span className="sr-drag-handle" title="اسحب لإعادة الترتيب">
            <GripVertical size={15} />
          </span>
          <div className="sr-width-btns">
            {WIDTH_OPTS.map(o => (
              <button
                key={o.val}
                className={`sr-w-btn${size === o.val ? ' active' : ''}`}
                onMouseDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); onSizeChange(id, o.val); }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={`sr-panel-inner${editMode ? ' sr-panel-inner-edit' : ''}`}>
        {children}
      </div>
    </div>
  );
}

/* ── Main component ── */
export default function StatusRow({
  kpis, kpisLoading,
  statusByRegion, statusLoading,
  monthlySummary, monthlyLoading,
  monthlySummaryPrev, monthlyLoadingPrev,
  years, activeYears, availableYears, onYearSelect,
}) {
  const {
    order, editMode, rowHeight, fontScale, canEdit,
    toggleEditMode, setPanelSize, panelSizeOf,
    setRowHeight, fontUp, fontDown, canFontUp, canFontDown,
    reorderPanels, reset,
  } = useStatusRowSettings();

  const [draggedId,  setDraggedId]  = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const activeEditMode = editMode && canEdit;

  const handleDragStart = (id) => { if (canEdit) setDraggedId(id); };
  const handleDragOver  = (id) => { if (id !== draggedId) setDragOverId(id); };
  const handleDrop      = (id) => {
    if (draggedId && id !== draggedId) reorderPanels(draggedId, id);
    setDraggedId(null); setDragOverId(null);
  };
  const handleDragEnd = () => { setDraggedId(null); setDragOverId(null); };

  const PANELS = {
    invoice_chart:      <MonthlyBalanceChart data={monthlySummary}     loading={monthlyLoading}     />,
    invoice_chart_prev: <MonthlyBalanceChart data={monthlySummaryPrev} loading={monthlyLoadingPrev} />,
    combined_card: (
      <CombinedStatusKPICard
        unpaidData={statusByRegion?.unpaid}
        partialData={statusByRegion?.partial}
        loading={statusLoading}
      />
    ),
    year_strip: (
      <YearStrip
        data={years} loading={false}
        activeYears={activeYears} availableYears={availableYears}
        onSelect={onYearSelect} vertical
      />
    ),
  };

  /* ── Non-admin: render panels only, no settings bar ── */
  if (!canEdit) {
    return (
      <div className="sr-section">
        <div
          className="sr-row"
          style={{ height: rowHeight, '--sr-h': rowHeight, '--sr-font-scale': fontScale }}
        >
          {order.map(id => (
            <div key={id} className="sr-panel" style={{ flex: `${SIZE_WEIGHTS[panelSizeOf(id)] || 1} 1 0`, minWidth: 0 }}>
              <div className="sr-panel-inner">{PANELS[id]}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  /* ── Super-admin: full controls ── */
  return (
    <div className="sr-section">
      {/* Settings bar */}
      <div className="sr-settings-bar">
        <span className="sr-settings-lbl">
          <Pencil size={11} /> تخصيص البوكسات
        </span>

        {/* Edit toggle */}
        <button
          className={`sr-edit-toggle${activeEditMode ? ' active' : ''}`}
          onClick={toggleEditMode}
        >
          {activeEditMode ? 'إنهاء التخصيص ✓' : 'تخصيص'}
        </button>

        {activeEditMode && (
          <button className="sr-reset-btn" onClick={reset} title="إعادة الضبط">
            <RotateCcw size={11} /> إعادة ضبط
          </button>
        )}

        {/* ── Font scale ── */}
        <div className="sr-settings-group">
          <span className="sr-settings-sublbl">الخط</span>
          <div className="sr-font-btns">
            <button className="sr-font-btn" onClick={fontDown} disabled={!canFontDown} title="تصغير">
              A<sup>−</sup>
            </button>
            <span className="sr-font-pct">{Math.round(fontScale * 100)}%</span>
            <button className="sr-font-btn" onClick={fontUp} disabled={!canFontUp} title="تكبير">
              A<sup>+</sup>
            </button>
          </div>
        </div>

        <div className="sr-settings-vsep" />

        {/* ── Height controls ── */}
        <div className="sr-height-group">
          <span className="sr-settings-sublbl" style={{ gap: 3 }}>
            <ChevronsUpDown size={11} /> الطول
          </span>
          <div className="sr-height-btns">
            {HEIGHT_OPTS.map(o => (
              <button
                key={o.val}
                className={`sr-h-btn${rowHeight === o.val ? ' active' : ''}`}
                onClick={() => setRowHeight(o.val)}
                title={`${o.val}px`}
              >
                <span className="sr-h-icon" style={{ '--h-frac': o.val / 740 }}>
                  <span /><span /><span />
                </span>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {activeEditMode && (
          <span className="sr-hint">
            <GripVertical size={11} /> اسحب لإعادة الترتيب — اختر العرض لكل بوكس
          </span>
        )}
      </div>

      {/* Panels row */}
      <div
        className={`sr-row${activeEditMode ? ' sr-row-edit' : ''}`}
        style={{ height: rowHeight, '--sr-h': rowHeight, '--sr-font-scale': fontScale }}
      >
        {order.map(id => (
          <DraggablePanel
            key={id} id={id}
            editMode={activeEditMode}
            size={panelSizeOf(id)}
            onSizeChange={setPanelSize}
            isDragging={draggedId  === id}
            isDragOver={dragOverId === id}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          >
            {PANELS[id]}
          </DraggablePanel>
        ))}
      </div>
    </div>
  );
}
