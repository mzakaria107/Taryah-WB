import { useCallback } from 'react';
import { useDashboardSettings } from '../context/DashboardSettingsContext';

const KEY = 'region_card_settings';

export const SIZE_OPTS = [
  { val: 'compact', label: 'صغير', width: 125 },
  { val: 'normal',  label: 'عادي', width: 152 },
  { val: 'large',   label: 'كبير', width: 190 },
  { val: 'wide',    label: 'واسع', width: 235 },
];

export const FONT_STEPS = [0.8, 0.9, 1.0, 1.1, 1.2];

export default function useRegionCardSettings() {
  const { getSetting, updateSetting, canEdit } = useDashboardSettings();
  const s = getSetting(KEY);

  const update = useCallback((patch) => {
    updateSetting(KEY, { ...s, ...patch });
  }, [s, updateSetting]);

  const cardSize  = SIZE_OPTS.some(o => o.val === s.cardSize) ? s.cardSize : 'normal';
  const fontScale = FONT_STEPS.includes(s.fontScale) ? s.fontScale : 1.0;

  const setCardSize = (v) => update({ cardSize: v });
  const fontUp      = () => {
    const i = FONT_STEPS.indexOf(fontScale);
    update({ fontScale: FONT_STEPS[Math.min(i + 1, FONT_STEPS.length - 1)] });
  };
  const fontDown    = () => {
    const i = FONT_STEPS.indexOf(fontScale);
    update({ fontScale: FONT_STEPS[Math.max(i - 1, 0)] });
  };
  const canFontUp   = fontScale < FONT_STEPS[FONT_STEPS.length - 1];
  const canFontDown = fontScale > FONT_STEPS[0];
  const reset       = () => update({ cardSize: 'normal', fontScale: 1.0 });

  return { cardSize, fontScale, canEdit, setCardSize, fontUp, fontDown, canFontUp, canFontDown, reset };
}
