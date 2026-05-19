import React, { useState, useEffect, useRef } from 'react';
import { Check, X, Trash2 } from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../context/AuthContext';

/**
 * Customer-level note cell (dashboard summary table).
 * - Saves ONLY on ✓ click — no auto-save.
 * - Always shows the latest note from note_history (fetched by server).
 * - Syncs with new server data only when there are no pending local edits.
 * - Delete button for super_admin with confirmation.
 */
export default function CustomerNoteCell({ customerId, initialText = '', onSaved }) {
  const { user }  = useAuth();
  const isAdmin   = user?.role === 'super_admin';

  const [savedText,  setSavedText]  = useState(initialText);
  const [text,       setText]       = useState(initialText);

  // When the server refetches (after save/invalidation) and passes a new initialText,
  // sync the local state only if the user has no unsaved pending edit.
  const prevInitial = useRef(initialText);
  useEffect(() => {
    if (initialText !== prevInitial.current) {
      prevInitial.current = initialText;
      // Only update if user hasn't started editing
      setText(prev  => prev === savedText ? initialText : prev);
      setSavedText(initialText);
    }
  }, [initialText]); // eslint-disable-line react-hooks/exhaustive-deps
  const [status,     setStatus]     = useState(null);  // 'saving'|'saved'|'error'|'del-err'
  const [confirmDel, setConfirmDel] = useState(false);

  const hasPending = text !== savedText;

  /* ── Save on ✓ ── */
  const handleSave = async () => {
    setStatus('saving');
    try {
      await client.put(`/notes/customer/${encodeURIComponent(customerId)}`, { note_text: text });
      setSavedText(text);
      setStatus('saved');
      onSaved?.();
      setTimeout(() => setStatus(null), 2000);
    } catch {
      setStatus('error');
    }
  };

  /* ── Cancel × ── */
  const handleCancel = () => {
    setText(savedText);
    setStatus(null);
  };

  /* ── Delete (super_admin) ── */
  const handleDelete = async () => {
    if (!confirmDel) { setConfirmDel(true); return; }
    setConfirmDel(false);
    try {
      await client.delete(`/notes/customer/${encodeURIComponent(customerId)}`);
      setSavedText('');
      setText('');
      setStatus(null);
      onSaved?.();
    } catch {
      setStatus('del-err');
    }
  };

  return (
    <div
      className={`notes-wrap${savedText ? ' has-text' : ''}`}
      onClick={e => e.stopPropagation()}
    >
      <textarea
        value={text}
        onChange={e => { setText(e.target.value); setStatus(null); }}
        rows={2}
        placeholder="ملاحظة العميل…"
        aria-label="ملاحظة العميل"
      />

      <div className="notes-actions">

        {/* Confirm / Cancel */}
        {hasPending && (
          <>
            <button
              className="notes-action-btn save"
              onClick={handleSave}
              disabled={status === 'saving'}
              title="حفظ"
            >
              <Check size={11} />
              {status === 'saving' ? 'جاري…' : 'حفظ'}
            </button>
            <button className="notes-action-btn cancel" onClick={handleCancel} title="إلغاء">
              <X size={11} />
            </button>
          </>
        )}

        {/* Feedback */}
        {!hasPending && status === 'saved'   && <span className="notes-status ok">✓ محفوظ</span>}
        {!hasPending && status === 'error'   && <span className="notes-status err">خطأ</span>}
        {!hasPending && status === 'del-err' && <span className="notes-status err">خطأ في الحذف</span>}

        {/* Delete admin */}
        {isAdmin && savedText && !hasPending && (
          confirmDel ? (
            <>
              <span className="notes-status err">حذف؟</span>
              <button className="notes-action-btn danger" onClick={handleDelete}>نعم</button>
              <button className="notes-action-btn cancel" onClick={() => setConfirmDel(false)}>لا</button>
            </>
          ) : (
            <button className="notes-action-btn delete" onClick={handleDelete} title="حذف">
              <Trash2 size={11} />
            </button>
          )
        )}
      </div>
    </div>
  );
}
