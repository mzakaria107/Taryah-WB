import React, { useState, useRef } from 'react';
import { Users, TrendingUp, TrendingDown, UserPlus, FileText, GripVertical, Eye, EyeOff } from 'lucide-react';
import './SalesActivityKPI.css';

const MONTH_AR = {
  1:'يناير', 2:'فبراير', 3:'مارس', 4:'أبريل', 5:'مايو', 6:'يونيو',
  7:'يوليو', 8:'أغسطس', 9:'سبتمبر', 10:'أكتوبر', 11:'نوفمبر', 12:'ديسمبر',
};

const SIZES = ['sm', 'md', 'lg'];

function fmt(n) {
  return (n || 0).toLocaleString('en-SA');
}

/* ── Edit bar rendered at top of each card in edit mode ── */
function SakEditBar({ cardId, size, visible, onSize, onToggle }) {
  return (
    <div className="sak-edit-bar" onClick={e => e.stopPropagation()}>
      <span className="sak-drag-handle" title="اسحب لإعادة الترتيب">
        <GripVertical size={14} />
      </span>
      <span className="sak-ebar-sep" />
      <div className="sak-ebar-group">
        {SIZES.map(sz => (
          <button
            key={sz}
            className={`sak-sz-btn${size === sz ? ' active' : ''}`}
            onClick={() => onSize(cardId, sz)}
            title={sz === 'sm' ? 'صغير' : sz === 'md' ? 'متوسط' : 'كبير'}
          >
            {sz === 'sm' ? 'S' : sz === 'md' ? 'M' : 'L'}
          </button>
        ))}
      </div>
      <span className="sak-ebar-sep" />
      <button
        className={`sak-sz-btn sak-vis-btn${!visible ? ' hidden-btn' : ''}`}
        onClick={() => onToggle(cardId)}
        title={visible ? 'إخفاء' : 'إظهار'}
      >
        {visible ? <Eye size={11} /> : <EyeOff size={11} />}
        <span>{visible ? 'إخفاء' : 'إظهار'}</span>
      </button>
    </div>
  );
}

/* ── Placeholder shown for hidden cards in edit mode ── */
function SakHiddenPlaceholder({ label, onShow }) {
  return (
    <div className="sak-hidden-placeholder" onClick={onShow} title="انقر لإظهار البطاقة">
      <EyeOff size={13} />
      <span>{label}</span>
    </div>
  );
}

export default function SalesActivityKPI({
  data,
  loading,
  fetching,
  cardCfg,
  editMode,
  cardIds,
  onToggleCard,
  onSizeCard,
  onReorderCards,
}) {
  /* ── Drag state — must be before any early return ── */
  const dragIdx  = useRef(null);
  const dragOver = useRef(null);
  const [dragState, setDragState] = useState({ dragging: null, over: null });

  const cfg = (id) => cardCfg ? cardCfg(id) : { visible: true, size: 'md' };

  /* ── First load: show skeleton ── */
  if (loading && !data) {
    return (
      <div className="sak-strip">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="sak-card sak-skel-card">
            <div className="sak-sk sak-sk-title" />
            <div className="sak-sk sak-sk-value" />
            <div className="sak-sk sak-sk-sub" />
          </div>
        ))}
      </div>
    );
  }

  if (!data) return null;

  const {
    maxMonth, prevMonth,
    totalInvoices, totalCustomers,
    activeCurrentMonth, stoppedCurrentMonth, newCurrentMonth,
    invoicesByMonth = {},
  } = data;

  const curLabel  = maxMonth  ? MONTH_AR[maxMonth]  : '—';
  const prevLabel = prevMonth ? MONTH_AR[prevMonth]  : null;

  const months = Object.keys(invoicesByMonth).map(Number).sort((a, b) => a - b);
  const lastTwo = months.slice(-2);
  const invSubParts = lastTwo.map(m => `${MONTH_AR[m] || m}: ${fmt(invoicesByMonth[m])}`);
  const invSub = invSubParts.join(' | ');

  const stoppedPct = prevMonth && activeCurrentMonth + stoppedCurrentMonth > 0
    ? Math.round(stoppedCurrentMonth / (activeCurrentMonth + stoppedCurrentMonth) * 100)
    : null;

  const baseCards = [
    {
      key: 'total-invoices',
      icon: <FileText size={18} />,
      color: 'blue',
      label: 'إجمالي الفواتير',
      value: fmt(totalInvoices),
      sub: invSub || '—',
    },
    {
      key: 'new',
      icon: <UserPlus size={18} />,
      color: 'green',
      label: `عملاء جدد في ${curLabel}`,
      value: fmt(newCurrentMonth),
      sub: prevLabel ? `لم يشتروا في يناير ← ${prevLabel}` : 'أول شهر في البيانات',
      subIcon: '🆕',
    },
    {
      key: 'stopped',
      icon: <TrendingDown size={18} />,
      color: 'red',
      label: `متوقف في ${curLabel}`,
      value: fmt(stoppedCurrentMonth),
      sub: prevLabel ? `اشتروا ${prevLabel} ولم يشتروا ${curLabel}` : '—',
      subIcon: '⚠️',
      badge: stoppedPct != null ? `${stoppedPct}%` : null,
    },
    {
      key: 'active',
      icon: <TrendingUp size={18} />,
      color: 'teal',
      label: `نشط في ${curLabel}`,
      value: fmt(activeCurrentMonth),
      sub: `عملاء اشتروا في ${curLabel}`,
      subIcon: '✅',
    },
    {
      key: 'total-customers',
      icon: <Users size={18} />,
      color: 'purple',
      label: 'إجمالي العملاء',
      value: fmt(totalCustomers),
      sub: 'حسب الفلاتر المختارة',
    },
  ];

  /* Sort cards by layout order when cardIds provided */
  let cards = baseCards;
  if (cardIds && cardIds.length > 0) {
    const order = {};
    cardIds.forEach((id, idx) => { order[id] = idx; });
    cards = [...baseCards].sort((a, b) => {
      const ia = order[a.key] ?? 999;
      const ib = order[b.key] ?? 999;
      return ia - ib;
    });
  }

  /* In normal mode, filter to visible only */
  const displayCards = editMode ? cards : cards.filter(c => cfg(c.key).visible !== false);

  /* ── Drag handlers ── */
  function handleDragStart(e, idx) {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
    setDragState({ dragging: idx, over: null });
  }

  function handleDragEnd() {
    if (dragIdx.current !== null && dragOver.current !== null && dragIdx.current !== dragOver.current) {
      onReorderCards && onReorderCards(dragIdx.current, dragOver.current);
    }
    dragIdx.current = null;
    dragOver.current = null;
    setDragState({ dragging: null, over: null });
  }

  function handleDragOver(e, idx) {
    e.preventDefault();
    if (dragOver.current === idx) return;
    dragOver.current = idx;
    setDragState(s => ({ ...s, over: idx }));
  }

  function handleDrop(e, idx) {
    e.preventDefault();
  }

  return (
    <div className={`sak-strip${fetching ? ' sak-refetching' : ''}`}>
      {/* thin progress bar at top while refetching */}
      {fetching && <div className="sak-progress-bar" />}

      {displayCards.map((c, idx) => {
        const { visible, size: sz = 'md' } = cfg(c.key);
        const isHidden = visible === false;
        const isDragging = dragState.dragging === idx;
        const isDragOver = dragState.over === idx;

        let cardClass = `sak-card sak-card-${c.color} sak-card-sz-${sz}`;
        if (editMode) cardClass += ' sak-edit-mode';
        if (isHidden && editMode) cardClass += ' sak-card-edit-hidden';
        if (isDragging) cardClass += ' sak-dragging';
        if (isDragOver && !isDragging) cardClass += ' sak-drag-over';

        return (
          <div
            key={c.key}
            className={cardClass}
            draggable={editMode}
            onDragStart={editMode ? (e) => handleDragStart(e, idx) : undefined}
            onDragEnd={editMode ? handleDragEnd : undefined}
            onDragOver={editMode ? (e) => handleDragOver(e, idx) : undefined}
            onDrop={editMode ? (e) => handleDrop(e, idx) : undefined}
          >
            {/* Edit bar in edit mode */}
            {editMode && (
              <SakEditBar
                cardId={c.key}
                size={sz}
                visible={!isHidden}
                onSize={onSizeCard || (() => {})}
                onToggle={onToggleCard || (() => {})}
              />
            )}

            {/* Hidden placeholder in edit mode */}
            {isHidden && editMode ? (
              <SakHiddenPlaceholder
                label={c.label}
                onShow={() => onToggleCard && onToggleCard(c.key)}
              />
            ) : (
              <>
                <div className="sak-card-header">
                  <span className={`sak-icon sak-icon-${c.color}`}>{c.icon}</span>
                  <span className="sak-label">{c.label}</span>
                  {c.badge && <span className="sak-pct-badge">{c.badge}</span>}
                </div>
                <div className="sak-value">{c.value}</div>
                {c.sub && (
                  <div className="sak-sub">
                    {c.subIcon && <span>{c.subIcon}</span>}
                    {c.sub}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
