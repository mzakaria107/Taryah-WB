import { useState, useEffect } from 'react';

export const SIZES = [
  { key: 'sm', label: 'S', title: 'صغير' },
  { key: 'md', label: 'M', title: 'متوسط' },
  { key: 'lg', label: 'L', title: 'كبير'  },
];

export const DEFAULT_SECTIONS = [
  {
    id: 'kpi', label: 'مؤشرات الأداء', icon: '📊', visible: true,
    cards: [
      { id: 'total-invoices',   label: 'إجمالي الفواتير',      icon: '📄', visible: true, size: 'md' },
      { id: 'new',              label: 'عملاء جدد',             icon: '🆕', visible: true, size: 'md' },
      { id: 'stopped',          label: 'المتوقفون',             icon: '⛔', visible: true, size: 'md' },
      { id: 'active',           label: 'النشطون',               icon: '✅', visible: true, size: 'md' },
      { id: 'total-customers',  label: 'إجمالي العملاء',        icon: '👥', visible: true, size: 'md' },
    ],
  },
  {
    id: 'charts', label: 'الرسوم والمصفوفة', icon: '🥧', visible: true,
    cards: [
      { id: 'matrix',      label: 'مصفوفة المناطق',       icon: '📋', visible: true, size: 'md' },
      { id: 'pie-new',     label: 'دائري: العملاء الجدد',  icon: '🥧', visible: true, size: 'md' },
      { id: 'pie-stopped', label: 'دائري: المتوقفون',      icon: '🥧', visible: true, size: 'md' },
    ],
  },
  {
    id: 'table', label: 'جدول العملاء', icon: '📋', visible: true,
    cards: [
      { id: 'table-main', label: 'الجدول الرئيسي', icon: '📋', visible: true, size: 'md' },
    ],
  },
];

const STORAGE_KEY = 'sap-layout-v2';

function mergeSaved(saved) {
  if (!Array.isArray(saved)) return DEFAULT_SECTIONS;
  return DEFAULT_SECTIONS.map((def, si) => {
    const s = saved[si];
    if (!s) return def;
    return {
      ...def,
      visible: s.visible ?? def.visible,
      cards: def.cards.map((c, ci) => {
        const sc = s.cards?.[ci];
        if (!sc || sc.id !== c.id) return c;
        return { ...c, visible: sc.visible ?? c.visible, size: sc.size ?? c.size };
      }),
    };
  });
}

export function usePageLayout() {
  const [sections, setSections] = useState(() => {
    try { return mergeSaved(JSON.parse(localStorage.getItem(STORAGE_KEY))); }
    catch { return DEFAULT_SECTIONS; }
  });

  const [editMode, setEditMode] = useState(false);
  const toggleEditMode = () => setEditMode(e => !e);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sections));
  }, [sections]);

  /* ── Section-level ops ── */
  const toggleSection = (sid) =>
    setSections(s => s.map(sec => sec.id === sid ? { ...sec, visible: !sec.visible } : sec));

  const reorderSections = (from, to) =>
    setSections(s => { const n = [...s]; const [x] = n.splice(from, 1); n.splice(to, 0, x); return n; });

  /* ── Card-level ops ── */
  const toggleCard = (sid, cid) =>
    setSections(s => s.map(sec =>
      sec.id !== sid ? sec : {
        ...sec,
        cards: sec.cards.map(c => c.id === cid ? { ...c, visible: !c.visible } : c),
      }
    ));

  const setCardSize = (sid, cid, size) =>
    setSections(s => s.map(sec =>
      sec.id !== sid ? sec : {
        ...sec,
        cards: sec.cards.map(c => c.id === cid ? { ...c, size } : c),
      }
    ));

  const reorderCards = (sid, from, to) =>
    setSections(s => s.map(sec => {
      if (sec.id !== sid) return sec;
      const cards = [...sec.cards];
      const [x] = cards.splice(from, 1);
      cards.splice(to, 0, x);
      return { ...sec, cards };
    }));

  const reset = () => setSections(DEFAULT_SECTIONS);

  /* ── Helper: get card config by section + card id ── */
  const cardCfg = (sid, cid) =>
    sections.find(s => s.id === sid)?.cards.find(c => c.id === cid)
    ?? { visible: true, size: 'md' };

  return {
    sections,
    toggleSection, reorderSections,
    toggleCard, setCardSize, reorderCards,
    reset, cardCfg,
    editMode, toggleEditMode,
  };
}
