import React, { useState, useMemo, useEffect } from 'react';
import {
  FileText, CheckCircle, AlertCircle, TrendingUp, Users, Hash,
  ArrowUp, ArrowDown, Settings2, RotateCcw, GripVertical, Pencil,
  EyeOff, Eye, Columns2,
} from 'lucide-react';
import useCountUp     from '../../hooks/useCountUp';
import useKPISettings, { CARD_IDS } from '../../hooks/useKPISettings';
import Skeleton       from '../UI/Skeleton';
import './KPICards.css';

/* ── Formatters ──────────────────────────────────── */
const fmtSAR = (n) =>
  Number(n).toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtSARShort = (n) =>
  Number(n).toLocaleString('en-SA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtInt = (n) => Math.round(n).toLocaleString('en-SA');

/* ── Balance snapshot (localStorage) ────────────── */
const SNAP_KEY  = 'kpi_balance_snapshot';
const todayStr  = () => new Date().toISOString().split('T')[0];

function readBalanceSnap() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY)) || null; } catch { return null; }
}
function saveBalanceSnap(balance) {
  if (!balance || balance <= 0) return;
  try {
    const today   = todayStr();
    const existing = readBalanceSnap();
    let snap;
    if (!existing || existing.date !== today) {
      // New day → existing balance becomes "yesterday"
      snap = { date: today, balance, prevBalance: existing?.balance ?? null };
    } else {
      // Same day → update current but keep prevBalance
      snap = { ...existing, balance };
    }
    localStorage.setItem(SNAP_KEY, JSON.stringify(snap));
  } catch {}
}

/* ── Progress ring ───────────────────────────────── */
function ProgressRing({ value = 0, color = 'var(--color-brand-green)', sz = 56 }) {
  const r = (sz / 2) - 7;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ '--ring-color': color, width: sz, height: sz }}>
      <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
        <circle className="ring-bg" cx={sz/2} cy={sz/2} r={r} strokeWidth="5" fill="none" />
        <circle className="ring-fg" cx={sz/2} cy={sz/2} r={r}
          strokeWidth="5" fill="none" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c - (value/100)*c} />
      </svg>
      <div className="ring-val">{Math.round(value)}%</div>
    </div>
  );
}

/* ── Card edit overlay ───────────────────────────── */
const SZ_OPTS = [
  { val: null,      label: '—'      },
  { val: 'compact', label: 'صغير'   },
  { val: 'normal',  label: 'عادي'   },
  { val: 'large',   label: 'كبير'   },
];

function CardEditBar({ id, cardSize, cardSpan, isVisible, onSize, onSpan, onVisible }) {
  return (
    <div className="kpi-edit-bar" onMouseDown={e => e.stopPropagation()}>
      {/* Drag handle */}
      <span className="kpi-drag-handle" title="اسحب لإعادة الترتيب">
        <GripVertical size={13} />
      </span>

      {/* Separator */}
      <div className="kpi-ebar-sep" />

      {/* Size */}
      <div className="kpi-ebar-group">
        <span className="kpi-ebar-lbl">الحجم</span>
        {SZ_OPTS.map(o => (
          <button
            key={String(o.val)}
            className={`kpi-card-sz-btn${cardSize === o.val ? ' active' : ''}`}
            onClick={e => { e.stopPropagation(); onSize(id, o.val); }}
          >
            {o.label}
          </button>
        ))}
      </div>

      {/* Separator */}
      <div className="kpi-ebar-sep" />

      {/* Span */}
      <div className="kpi-ebar-group">
        <span className="kpi-ebar-lbl">العرض</span>
        <button
          className={`kpi-card-sz-btn${cardSpan === 1 ? ' active' : ''}`}
          onClick={e => { e.stopPropagation(); if (cardSpan !== 1) onSpan(id); }}
          title="عرض عادي (عمود واحد)"
        >
          ▣
        </button>
        <button
          className={`kpi-card-sz-btn${cardSpan === 2 ? ' active' : ''}`}
          onClick={e => { e.stopPropagation(); if (cardSpan !== 2) onSpan(id); }}
          title="عرض مزدوج (عمودان)"
        >
          ▣▣
        </button>
      </div>

      {/* Separator */}
      <div className="kpi-ebar-sep" />

      {/* Visibility */}
      <button
        className={`kpi-card-sz-btn kpi-vis-btn${!isVisible ? ' hidden-btn' : ''}`}
        onClick={e => { e.stopPropagation(); onVisible(id); }}
        title={isVisible ? 'إخفاء الكرت' : 'إظهار الكرت'}
      >
        {isVisible ? <EyeOff size={11} /> : <Eye size={11} />}
        {isVisible ? 'إخفاء' : 'إظهار'}
      </button>
    </div>
  );
}

/* ── Hidden card placeholder ─────────────────────── */
function HiddenCardPlaceholder({ id, label, onVisible }) {
  return (
    <div className="kpi-hidden-placeholder" onClick={() => onVisible(id)} title="انقر لإظهار الكرت">
      <Eye size={13} />
      <span>{label}</span>
    </div>
  );
}

/* ── Single KPI card ─────────────────────────────── */
function KPICard({
  id, cardDef, globalSize, fontScale,
  editMode, cardSize, cardSpan, isVisible,
  onCardSize, onCardSpan, onCardVisible,
  isDragging, isDragOver,
  onDragStart, onDragOver, onDrop, onDragEnd,
}) {
  const { icon, label, value, unit, trend, trendUp,
          foot, ring, pulse, delay, valueColor, iconBg, iconColor,
          deltaChip, glow } = cardDef;

  const animated = useCountUp(Number(value) || 0, 900);
  const display  = unit === 'SAR' ? fmtSAR(animated) : fmtInt(animated);

  const effSize = cardSize || globalSize;
  const ringSz  = effSize === 'compact' ? 44 : effSize === 'large' ? 68 : 56;
  const iconSz  = effSize === 'compact' ? 16 : effSize === 'large' ? 24 : 20;

  /* Hidden card in view mode — skip rendering */
  if (!isVisible && !editMode) return null;

  /* Hidden card in edit mode — show placeholder */
  if (!isVisible && editMode) {
    return (
      <div
        className={`kpi-card kpi-size-${effSize} kpi-edit-mode kpi-card-hidden`}
        style={{ '--icon-bg': iconBg, '--icon-color': iconColor,
                 gridColumn: cardSpan === 2 ? 'span 2' : undefined }}
        draggable={editMode}
        onDragStart={() => onDragStart(id)}
        onDragOver={e  => { e.preventDefault(); onDragOver(id); }}
        onDrop={()     => onDrop(id)}
        onDragEnd={onDragEnd}
      >
        <CardEditBar
          id={id} cardSize={cardSize} cardSpan={cardSpan} isVisible={false}
          onSize={onCardSize} onSpan={onCardSpan} onVisible={onCardVisible}
        />
        <HiddenCardPlaceholder id={id} label={label} onVisible={onCardVisible} />
      </div>
    );
  }

  return (
    <div
      className={[
        'kpi-card',
        `kpi-size-${effSize}`,
        `anim-delay-${delay}`,
        editMode    ? 'kpi-edit-mode'  : '',
        isDragging  ? 'kpi-dragging'   : '',
        isDragOver  ? 'kpi-drag-over'  : '',
        glow        ? 'kpi-glow-danger': '',
      ].filter(Boolean).join(' ')}
      style={{
        '--icon-bg': iconBg, '--icon-color': iconColor,
        gridColumn: cardSpan === 2 ? 'span 2' : undefined,
      }}
      draggable={editMode}
      onDragStart={() => onDragStart(id)}
      onDragOver={e  => { e.preventDefault(); onDragOver(id); }}
      onDrop={()     => onDrop(id)}
      onDragEnd={onDragEnd}
    >
      {/* Edit overlay */}
      {editMode && (
        <CardEditBar
          id={id} cardSize={cardSize} cardSpan={cardSpan} isVisible={true}
          onSize={onCardSize} onSpan={onCardSpan} onVisible={onCardVisible}
        />
      )}

      {/* Card body */}
      <div className="kpi-head">
        <div className={`kpi-icon${pulse ? ' pulse' : ''}`}>
          {React.cloneElement(icon, { size: iconSz })}
        </div>
        {ring != null ? (
          <ProgressRing value={ring} color={iconColor} sz={ringSz} />
        ) : deltaChip != null ? (
          <span className={`kpi-delta ${deltaChip.isUp ? 'kpi-delta-up' : 'kpi-delta-down'}`}>
            {deltaChip.isUp ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
            {deltaChip.pct}%
          </span>
        ) : trend != null ? (
          <span className={`kpi-trend ${trendUp ? 'up' : 'down'}`}>
            {trendUp ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
            {trend}%
          </span>
        ) : null}
      </div>

      <div className="kpi-value"
        style={{
          ...(valueColor ? { '--value-color': valueColor } : {}),
          fontSize: `calc(var(--kpi-val-base) * ${fontScale})`,
        }}>
        {unit === 'SAR' && <span className="unit">SAR</span>}
        {display}
      </div>

      <div className="kpi-label" style={{ fontSize: `calc(var(--kpi-lbl-base) * ${fontScale})` }}>
        {label}
      </div>

      {foot && (
        <div className="kpi-foot" style={{ fontSize: `calc(11px * ${fontScale})` }}>
          {foot.bar != null && (
            <div className="bar">
              <div className="bar-fill" style={{ '--bar-color': iconColor, width: foot.bar + '%' }} />
            </div>
          )}
          <span>{foot.text}</span>
          {foot.prev && (
            <span className="kpi-foot-prev">{foot.prev}</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Skeleton ────────────────────────────────────── */
function KPICardsSkeleton() {
  return (
    <div className="kpi-section">
      <div className="kpi-grid">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="kpi-card kpi-size-normal" style={{ gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Skeleton width={40} height={40} radius="var(--radius-md)" />
              <Skeleton width={60} height={22} radius={999} />
            </div>
            <Skeleton width="60%" height={28} />
            <Skeleton width="45%" height={13} />
            <Skeleton width="100%" height={4} radius={999} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Global settings toolbar ─────────────────────── */
const SIZE_PRESETS = [
  { key: 'compact', label: 'صغير' },
  { key: 'normal',  label: 'عادي' },
  { key: 'large',   label: 'كبير' },
];

function KPISettingsBar({
  size, fontScale, canFontUp, canFontDown,
  editMode, setSize, fontUp, fontDown, toggleEditMode, reset,
  hiddenCount, canEdit,
}) {
  /* Non-admins: hide the entire bar */
  if (!canEdit) return null;

  return (
    <div className="kpi-settings-bar">
      {/* Size presets */}
      <div className="kpi-settings-group">
        <span className="kpi-settings-lbl">
          <Settings2 size={12} /> حجم عام
        </span>
        <div className="kpi-size-btns">
          {SIZE_PRESETS.map(o => (
            <button key={o.key}
              className={`kpi-sz-btn${size === o.key ? ' active' : ''}`}
              onClick={() => setSize(o.key)}>{o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="kpi-settings-sep" />

      {/* Font scale */}
      <div className="kpi-settings-group">
        <span className="kpi-settings-lbl">الخط</span>
        <div className="kpi-font-btns">
          <button className="kpi-font-btn" onClick={fontDown} disabled={!canFontDown} title="تصغير">
            A<sup>−</sup>
          </button>
          <span className="kpi-font-pct">{Math.round(fontScale * 100)}%</span>
          <button className="kpi-font-btn" onClick={fontUp} disabled={!canFontUp} title="تكبير">
            A<sup>+</sup>
          </button>
        </div>
      </div>

      <div className="kpi-settings-sep" />

      {/* Customize toggle */}
      <button
        className={`kpi-edit-toggle${editMode ? ' active' : ''}`}
        onClick={toggleEditMode}
        title="تخصيص الكروت — ترتيب، حجم، عرض، إخفاء"
      >
        <Pencil size={11} />
        {editMode ? 'إنهاء التخصيص' : 'تخصيص'}
        {!editMode && hiddenCount > 0 && (
          <span className="kpi-hidden-badge">{hiddenCount}</span>
        )}
      </button>

      {/* Reset */}
      <button className="kpi-reset-btn" onClick={reset} title="إعادة الضبط">
        <RotateCcw size={12} />
      </button>
    </div>
  );
}

/* ── Exported component ──────────────────────────── */
export default function KPICards({ data, loading }) {
  const {
    size, fontScale, cardOrder, editMode, canEdit,
    setSize, fontUp, fontDown, canFontUp, canFontDown,
    toggleEditMode, reorderCards,
    setCardSize, cardSizeOf,
    toggleCardSpan, cardSpanOf,
    toggleCardVisible, isCardVisible,
    reset,
  } = useKPISettings();

  const [draggedId,  setDraggedId]  = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  /* editMode active only for super_admin */
  const activeEditMode = editMode && canEdit;

  const handleDragStart = (id) => { if (canEdit) setDraggedId(id); };
  const handleDragOver  = (id) => { if (id !== draggedId) setDragOverId(id); };
  const handleDrop      = (id) => {
    if (draggedId && id !== draggedId) reorderCards(draggedId, id);
    setDraggedId(null); setDragOverId(null);
  };
  const handleDragEnd = () => { setDraggedId(null); setDragOverId(null); };

  /* ── Card values — computed BEFORE any early return (hooks compliance) ── */
  const totalAmount  = Number(data?.total_amount    ?? 0);
  const totalPaid    = Number(data?.total_paid      ?? 0);
  const totalBalance = Number(data?.total_balance   ?? 0);
  const rate         = Number(data?.collection_rate ?? 0);
  const customers    = Number(data?.customer_count  ?? 0);
  const invoices     = Number(data?.invoice_count   ?? 0);
  const rateColor    =
    rate >= 90 ? 'var(--color-brand-green)' :
    rate >= 60 ? 'var(--color-warning)'     :
                 'var(--color-brand-red)';
  const paidPct    = totalAmount > 0 ? (totalPaid    / totalAmount) * 100 : 0;
  const balancePct = totalAmount > 0 ? (totalBalance / totalAmount) * 100 : 0;

  /* ── Balance vs yesterday snapshot ── */
  const { prevBalance, deltaChip } = useMemo(() => {
    const snap = readBalanceSnap();
    if (!snap || !totalBalance) return { prevBalance: null, deltaChip: null };

    const today = todayStr();
    const prev  = snap.date === today ? (snap.prevBalance ?? null) : (snap.balance ?? null);
    if (!prev || prev <= 0) return { prevBalance: prev, deltaChip: null };

    const changePct = ((totalBalance - prev) / prev) * 100;
    return {
      prevBalance: prev,
      deltaChip: { pct: Math.abs(changePct).toFixed(1), isUp: totalBalance > prev },
    };
  }, [totalBalance]);

  /* Save snapshot whenever totalBalance changes */
  useEffect(() => { saveBalanceSnap(totalBalance); }, [totalBalance]);

  /* ── Early return AFTER all hooks ── */
  if (loading) return <KPICardsSkeleton />;

  const CARD_DEFS = {
    invoices_total: { icon: <FileText size={20} />,   label: 'إجمالي الفواتير',  value: totalAmount,  unit: 'SAR', trend: 4.8, trendUp: true,  delay: 1, iconBg: 'var(--color-info-bg)',          iconColor: 'var(--color-info)',            foot: { bar: 100,       text: `${invoices.toLocaleString('en-SA')} فاتورة` } },
    paid_total:     { icon: <CheckCircle size={20} />, label: 'إجمالي المسدد',    value: totalPaid,    unit: 'SAR', trend: 7.2, trendUp: true,  delay: 2, iconBg: 'var(--color-success-bg)',       iconColor: 'var(--color-success)',         valueColor: 'var(--color-brand-green)', foot: { bar: paidPct,    text: `${paidPct.toFixed(1)}% مسدد` } },
    balance:        { icon: <AlertCircle size={20} />, label: 'الرصيد المستحق',   value: totalBalance, unit: 'SAR', deltaChip,  delay: 3, iconBg: 'var(--color-danger-bg)', iconColor: 'var(--color-danger)', pulse: true, valueColor: 'var(--color-brand-red)', glow: deltaChip?.isUp === true,
                      foot: { bar: balancePct, text: `${balancePct.toFixed(1)}% متبقي`, prev: prevBalance != null ? `أمس: SAR ${fmtSARShort(prevBalance)}` : null } },
    rate:           { icon: <TrendingUp size={20} />,  label: 'معدل التحصيل',     value: rate,         unit: '',    ring: rate,                  delay: 4, iconBg: 'var(--color-brand-green-pale)', iconColor: rateColor,                      foot: { text: 'نسبة التحصيل الكلية' } },
    customers:      { icon: <Users size={20} />,       label: 'عدد العملاء',      value: customers,    unit: '',    trend: 3,   trendUp: true,  delay: 5, iconBg: 'var(--color-brand-gold-light)', iconColor: '#B8860B',                      foot: { text: `${customers.toLocaleString('en-SA')} عميل` } },
    invoice_count:  { icon: <Hash size={20} />,        label: 'عدد الفواتير',     value: invoices,     unit: '',    trend: 9,   trendUp: true,  delay: 6, iconBg: 'var(--color-bg-alt)',           iconColor: 'var(--color-text-secondary)', foot: { text: `${invoices.toLocaleString('en-SA')} فاتورة` } },
  };

  const hiddenCount = CARD_IDS.filter(id => !isCardVisible(id)).length;

  return (
    <div className="kpi-section">
      <KPISettingsBar
        size={size} fontScale={fontScale} canFontUp={canFontUp} canFontDown={canFontDown}
        editMode={editMode} setSize={setSize} fontUp={fontUp} fontDown={fontDown}
        toggleEditMode={toggleEditMode} reset={reset} hiddenCount={hiddenCount}
        canEdit={canEdit}
      />

      <div className={`kpi-grid${activeEditMode ? ' kpi-grid-edit' : ''}`}>
        {cardOrder.map(id => (
          <KPICard
            key={id}
            id={id}
            cardDef={CARD_DEFS[id]}
            globalSize={size}
            fontScale={fontScale}
            editMode={activeEditMode}
            cardSize={cardSizeOf(id)}
            cardSpan={cardSpanOf(id)}
            isVisible={isCardVisible(id)}
            onCardSize={setCardSize}
            onCardSpan={toggleCardSpan}
            onCardVisible={toggleCardVisible}
            isDragging={draggedId  === id}
            isDragOver={dragOverId === id}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          />
        ))}
      </div>

      {editMode && (
        <p className="kpi-edit-hint">
          <GripVertical size={11} />
          اسحب لإعادة الترتيب — الحجم والعرض لكل كرت مستقل — الكروت المخفية تظهر كإطار شفاف
        </p>
      )}
    </div>
  );
}
