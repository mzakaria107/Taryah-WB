import { useState, useCallback } from 'react';
import { useDashboardSettings } from '../context/DashboardSettingsContext';

export const STATUS_IDS = ['combined_card', 'invoice_chart', 'invoice_chart_prev', 'year_strip'];

export const SIZE_WEIGHTS = {
  compact: 0.65,
  normal:  1,
  large:   1.55,
  wide:    2.4,
};

export const HEIGHT_OPTS = [
  { val: 260, label: 'XS' },
  { val: 360, label: 'S'  },
  { val: 480, label: 'M'  },
  { val: 600, label: 'L'  },
  { val: 740, label: 'XL' },
];
export const DEFAULT_HEIGHT = 480;

export const SR_FONT_STEPS = [0.8, 0.9, 1.0, 1.1, 1.2];

const KEY = 'status_row_settings';

const DEFAULT_SIZES = {
  combined_card: 'normal',
  invoice_chart: 'large', invoice_chart_prev: 'large', year_strip: 'large',
};

export default function useStatusRowSettings() {
  const { getSetting, updateSetting, canEdit } = useDashboardSettings();
  const s = getSetting(KEY);

  /* editMode is local-only */
  const [editMode, setEditMode] = useState(false);

  const update = useCallback((patch) => {
    updateSetting(KEY, { ...s, ...patch });
  }, [s, updateSetting]);

  /* Ensure order contains all STATUS_IDS */
  const order = Array.isArray(s.order) &&
    s.order.length === STATUS_IDS.length &&
    STATUS_IDS.every(id => s.order.includes(id))
      ? s.order : [...STATUS_IDS];

  const sizes     = { ...DEFAULT_SIZES, ...(s.sizes ?? {}) };
  const rowHeight = HEIGHT_OPTS.some(o => o.val === s.rowHeight) ? s.rowHeight : DEFAULT_HEIGHT;
  const fontScale = SR_FONT_STEPS.includes(s.fontScale) ? s.fontScale : 1.0;

  const toggleEditMode = () => setEditMode(p => !p);

  const setPanelSize  = (id, size) => update({ sizes: { ...sizes, [id]: size } });
  const panelSizeOf   = (id)       => sizes[id] ?? 'normal';
  const setRowHeight  = (h)        => update({ rowHeight: h });

  const fontUp   = () => {
    const i = SR_FONT_STEPS.indexOf(fontScale);
    update({ fontScale: SR_FONT_STEPS[Math.min(i + 1, SR_FONT_STEPS.length - 1)] });
  };
  const fontDown = () => {
    const i = SR_FONT_STEPS.indexOf(fontScale);
    update({ fontScale: SR_FONT_STEPS[Math.max(i - 1, 0)] });
  };
  const canFontUp   = fontScale < SR_FONT_STEPS[SR_FONT_STEPS.length - 1];
  const canFontDown = fontScale > SR_FONT_STEPS[0];

  const reorderPanels = (fromId, toId) => {
    if (fromId === toId) return;
    const o  = [...order];
    const fi = o.indexOf(fromId);
    const ti = o.indexOf(toId);
    if (fi < 0 || ti < 0) return;
    o.splice(fi, 1);
    o.splice(ti, 0, fromId);
    update({ order: o });
  };

  const reset = () => update({
    order: [...STATUS_IDS],
    sizes: { ...DEFAULT_SIZES },
    rowHeight: DEFAULT_HEIGHT,
    fontScale: 1.0,
  });

  return {
    order, sizes, rowHeight, fontScale, editMode, canEdit,
    toggleEditMode, setPanelSize, panelSizeOf,
    setRowHeight, fontUp, fontDown, canFontUp, canFontDown,
    reorderPanels, reset,
  };
}
