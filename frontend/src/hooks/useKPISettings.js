import { useState, useCallback } from 'react';
import { useDashboardSettings } from '../context/DashboardSettingsContext';

const KEY = 'kpi_settings';

export const CARD_IDS = [
  'invoices_total', 'paid_total', 'balance',
  'rate', 'customers', 'invoice_count',
];

const FONT_STEPS  = [0.75, 0.85, 1.0, 1.15, 1.3];
const SIZE_VALUES = ['compact', 'normal', 'large'];

export default function useKPISettings() {
  const { getSetting, updateSetting, canEdit } = useDashboardSettings();
  const s = getSetting(KEY);

  /* editMode is local-only (per session) */
  const [editMode, setEditMode] = useState(false);

  const update = useCallback((patch) => {
    updateSetting(KEY, { ...s, ...patch });
  }, [s, updateSetting]);

  /* ── Global ── */
  const setSize  = (size)  => update({ size });
  const fontUp   = ()      => {
    const i = FONT_STEPS.indexOf(s.fontScale);
    update({ fontScale: FONT_STEPS[Math.min(i + 1, FONT_STEPS.length - 1)] });
  };
  const fontDown = ()      => {
    const i = FONT_STEPS.indexOf(s.fontScale);
    update({ fontScale: FONT_STEPS[Math.max(i - 1, 0)] });
  };
  const canFontUp   = s.fontScale < FONT_STEPS[FONT_STEPS.length - 1];
  const canFontDown = s.fontScale > FONT_STEPS[0];

  /* ── Edit mode (local) ── */
  const toggleEditMode = () => setEditMode(p => !p);

  /* ── Card order ── */
  const reorderCards = (fromId, toId) => {
    if (fromId === toId) return;
    const o  = [...(s.cardOrder ?? CARD_IDS)];
    const fi = o.indexOf(fromId);
    const ti = o.indexOf(toId);
    if (fi < 0 || ti < 0) return;
    o.splice(fi, 1);
    o.splice(ti, 0, fromId);
    update({ cardOrder: o });
  };

  /* ── Per-card size ── */
  const setCardSize = (id, size) =>
    update({ cardSizes: { ...(s.cardSizes ?? {}), [id]: size ?? null } });
  const cardSizeOf  = (id) => (s.cardSizes ?? {})[id] ?? null;

  /* ── Per-card span ── */
  const toggleCardSpan = (id) => {
    const spans = s.cardSpans ?? {};
    update({ cardSpans: { ...spans, [id]: spans[id] === 2 ? 1 : 2 } });
  };
  const cardSpanOf = (id) => (s.cardSpans ?? {})[id] ?? 1;

  /* ── Per-card visibility ── */
  const toggleCardVisible = (id) => {
    const hidden = s.cardHidden ?? {};
    update({ cardHidden: { ...hidden, [id]: !hidden[id] } });
  };
  const isCardVisible = (id) => !(s.cardHidden ?? {})[id];

  /* ── Reset ── */
  const reset = () => update({
    size: 'normal', fontScale: 1.0,
    cardOrder: [...CARD_IDS], cardSizes: {}, cardSpans: {}, cardHidden: {},
  });

  return {
    size:      s.size      ?? 'normal',
    fontScale: s.fontScale ?? 1.0,
    cardOrder: s.cardOrder ?? [...CARD_IDS],
    editMode,
    canEdit,
    setSize, fontUp, fontDown, canFontUp, canFontDown, fontSteps: FONT_STEPS,
    toggleEditMode,
    reorderCards,
    setCardSize, cardSizeOf,
    toggleCardSpan, cardSpanOf,
    toggleCardVisible, isCardVisible,
    reset,
  };
}
