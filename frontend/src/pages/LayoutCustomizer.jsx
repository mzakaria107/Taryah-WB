import React from 'react';
import { Pencil, RotateCcw } from 'lucide-react';
import './LayoutCustomizer.css';

export default function LayoutCustomizer({ editMode, toggleEditMode, reset, hiddenCount }) {
  return (
    <div className="lc-toolbar">
      <button
        className={`lc-toggle${editMode ? ' lc-toggle-active' : ''}`}
        onClick={toggleEditMode}
        title="تخصيص التخطيط — ترتيب، حجم، إخفاء"
      >
        <Pencil size={14} />
        <span>{editMode ? 'إنهاء التخصيص ✓' : 'تخصيص'}</span>
        {!editMode && hiddenCount > 0 && (
          <span className="lc-hidden-badge">{hiddenCount}</span>
        )}
      </button>
      <button className="lc-reset-btn" onClick={reset} title="إعادة الضبط الكامل">
        <RotateCcw size={13} />
      </button>
    </div>
  );
}
