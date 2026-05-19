import React, { useState } from 'react';
import { Check, X, Trash2 } from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../context/AuthContext';

/**
 * Invoice-level note cell.
 * - Shows current saved note.
 * - When user edits, ✓ / × buttons appear — save only on ✓ click.
 * - Delete button (super_admin only) with confirmation step.
 */
export default function NotesCell({ invoiceId, initialText = '', onSaved, onDeleted }) {
  const { user }  = useAuth();
  const isAdmin   = user?.role === 'super_admin';

  const [savedText,   setSavedText]   = useState(initialText);
  const [text,        setText]        = useState(initialText);
  const [status,      setStatus]      = useState(null);   // 'saving'|'saved'|'error'|'deleting'|'del-err'
  const [confirmDel,  setConfirmDel]  = useState(false);

  const hasPending = text !== savedText;

  /* ── Save on ✓ ── */
  const handleSave = async () => {
    setStatus('saving');
    try {
      await client.put(`/notes/${invoiceId}`, { note_text: text });
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
    setStatus('deleting');
    try {
      await client.delete(`/notes/invoice/${invoiceId}`);
      setSavedText('');
      setText('');
      setStatus(null);
      onSaved?.();
      onDeleted?.();
    } catch {
      setStatus('del-err');
    }
  };

  return (
    <div className={`notes-wrap${savedText ? ' has-text' : ''}`} onClick={e => e.stopPropagation()}>
      <textarea
        value={text}
        onChange={e => { setText(e.target.value); setStatus(null); }}
        rows={2}
        placeholder="أضف ملاحظة…"
        aria-label="ملاحظة الفاتورة"
      />

      {/* Action row */}
      <div className="notes-actions">

        {/* Confirm / Cancel pending */}
        {hasPending && (
          <>
            <button
              className="notes-action-btn save"
              onClick={handleSave}
              disabled={status === 'saving'}
              title="حفظ الملاحظة"
            >
              <Check size={11} />
              {status === 'saving' ? 'جاري…' : 'حفظ'}
            </button>
            <button
              className="notes-action-btn cancel"
              onClick={handleCancel}
              title="إلغاء"
            >
              <X size={11} />
            </button>
          </>
        )}

        {/* Status feedback */}
        {!hasPending && status === 'saved'   && <span className="notes-status ok">✓ محفوظ</span>}
        {!hasPending && status === 'error'   && <span className="notes-status err">خطأ في الحفظ</span>}
        {!hasPending && status === 'del-err' && <span className="notes-status err">خطأ في الحذف</span>}

        {/* Delete (admin, only when saved note exists, no pending) */}
        {isAdmin && savedText && !hasPending && (
          confirmDel ? (
            <>
              <span className="notes-status err" style={{ marginLeft:0 }}>حذف؟</span>
              <button className="notes-action-btn danger" onClick={handleDelete}>نعم</button>
              <button className="notes-action-btn cancel" onClick={() => setConfirmDel(false)}>لا</button>
            </>
          ) : (
            <button
              className="notes-action-btn delete"
              onClick={handleDelete}
              title="حذف الملاحظة"
            >
              <Trash2 size={11} />
            </button>
          )
        )}
      </div>
    </div>
  );
}
