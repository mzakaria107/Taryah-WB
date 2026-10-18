import React from 'react';
import './DebtNotes.css';

/* One-line note + "name · dd/mm/yy HH:MM" — click opens DebtNoteModal. Shared by the
   debt-by-period table and the rep-debt customers table (same debt_notes data). */
const fmtStamp = iso => iso
  ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—';
const fmtStampShort = iso => iso
  ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '')
  : '—';

export default function DebtNoteCell({ note, updatedAt, updatedBy, canEdit, onOpen, addLabel = 'ملاحظة' }) {
  return (
    <button
      type="button"
      className={`abp-note-cell${note ? '' : ' abp-note-cell--empty'}`}
      title={note ? `${note}\n— ${updatedBy || '—'} · ${fmtStamp(updatedAt)}` : (canEdit ? `إضافة ${addLabel}` : 'لا توجد ملاحظة')}
      onClick={onOpen}
    >
      {note
        ? <><span className="abp-note-cell-text">{note}</span><span className="abp-note-cell-meta">{updatedBy || '—'} · {fmtStampShort(updatedAt)}</span></>
        : (canEdit ? `＋ ${addLabel}` : '—')}
    </button>
  );
}
