import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { MessageSquareText, Trash2, X } from 'lucide-react';
import api from '../api/client';
import '../pages/AgingPage.css';
import './DebtNotes.css';

/* Debt note editor + full history for one customer (debt-by-period / rep-debt pages).
   Saving writes the current note and appends a history row server-side.
   kind: 'debt' (ملاحظات المديونية) or 'owner' (العميل صاحب الدين الفعلي) — separate notes + histories. */
const KIND_TEXT = {
  debt:  { title: 'ملاحظات المديونية', placeholder: 'اكتب ملاحظة عن المديونية (موعد سداد، تواصل، إجراء…)', empty: 'لا توجد ملاحظة' },
  owner: { title: 'العميل صاحب الدين الفعلي', placeholder: 'بيانات العميل الفعلي صاحب المديونية (الاسم، الجوال، السجل التجاري، العنوان…)', empty: 'لا توجد بيانات' },
};
const fmtStamp = iso => iso
  ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—';

export default function DebtNoteModal({ customer, kind = 'debt', canEdit, isAdmin, onClose, onSaved }) {
  const txt = KIND_TEXT[kind] || KIND_TEXT.debt;
  const kindParams = kind === 'owner' ? { params: { kind } } : undefined;
  const [text, setText] = useState(customer.note || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['debt-note-history', kind, customer.customer_id],
    queryFn: () => api.get(`/aging/debt-notes/${encodeURIComponent(customer.customer_id)}/history`, kindParams).then(r => r.data.history),
  });

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Admin-only: remove one history entry. The server rolls the current note back to the newest
  // remaining entry, so the textarea follows it too.
  const [deletingId, setDeletingId] = useState(null);
  const removeEntry = async h => {
    if (!window.confirm(`حذف هذا السجل نهائياً؟\n\n«${h.note_text || '(تم مسح الملاحظة)'}»\n— ${h.saved_by_name || '—'} · ${fmtStamp(h.saved_at)}`)) return;
    setDeletingId(h.id); setError(null);
    try {
      const { data: res } = await api.delete(`/aging/debt-notes/history/${h.id}`, kindParams);
      onSaved(res);
      setText(res.note || '');
      refetch();
    } catch (e) {
      setError(e.response?.data?.error || 'تعذّر حذف السجل');
    } finally { setDeletingId(null); }
  };

  const dirty = text.trim() !== (customer.note || '').trim();
  const save = async () => {
    setSaving(true); setError(null);
    try {
      const { data: res } = await api.put(`/aging/debt-notes/${encodeURIComponent(customer.customer_id)}`, { note: text }, kindParams);
      onSaved(res);
      refetch();
    } catch (e) {
      setError(e.response?.data?.error || 'تعذّر حفظ الملاحظة');
    } finally { setSaving(false); }
  };

  return ReactDOM.createPortal(
    <div className="age-modal-overlay" onClick={onClose}>
      <div className="age-modal abp-note-modal" onClick={e => e.stopPropagation()}>
        <div className="age-modal-header">
          <MessageSquareText size={18} color="#b45309" />
          <div className="age-modal-customer">
            <div className="age-modal-customer-name">{txt.title} — {customer.customer_name}</div>
            <div className="abp-note-sub">رقم العميل {customer.customer_id}</div>
          </div>
          <button className="age-modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="age-modal-body">
          {canEdit ? (
            <>
              <textarea
                className="abp-note-textarea"
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder={txt.placeholder}
                maxLength={2000}
                rows={4}
                autoFocus
              />
              <div className="abp-note-actions">
                <button className="abp-note-save" disabled={!dirty || saving} onClick={save}>
                  {saving ? 'جاري الحفظ…' : 'حفظ الملاحظة'}
                </button>
                {error && <span className="abp-note-error">{error}</span>}
                <span className="abp-note-count">{text.length} / 2000</span>
              </div>
            </>
          ) : (
            <div className="abp-note-readonly">{customer.note || txt.empty}</div>
          )}

          <div className="abp-note-history-title">سجل الملاحظات</div>
          {isLoading ? <div className="abp-note-empty">جاري التحميل…</div>
            : !data?.length ? <div className="abp-note-empty">لا يوجد سجل بعد</div>
            : (
              <ul className="abp-note-history">
                {data.map(h => (
                  <li key={h.id}>
                    <div className="abp-note-meta">
                      <span><b>{h.saved_by_name || '—'}</b> · {fmtStamp(h.saved_at)}</span>
                      {isAdmin && (
                        <button type="button" className="abp-note-del" title="حذف هذا السجل (للأدمن فقط)"
                          disabled={deletingId === h.id} onClick={() => removeEntry(h)}>
                          <Trash2 size={13} /> {deletingId === h.id ? 'جاري الحذف…' : 'حذف'}
                        </button>
                      )}
                    </div>
                    <div className={`abp-note-text${h.note_text ? '' : ' abp-note-text--cleared'}`}>{h.note_text || '(تم مسح الملاحظة)'}</div>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </div>,
    document.body
  );
}
