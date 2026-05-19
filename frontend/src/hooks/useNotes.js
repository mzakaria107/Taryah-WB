import { useState, useCallback, useRef } from 'react';
import client from '../api/client';

export function useNotes() {
  const [saving, setSaving] = useState({});
  const timers = useRef({});

  /* ── Save (debounced) ── */
  const saveNote = useCallback((invoiceId, text) => {
    if (timers.current[invoiceId]) clearTimeout(timers.current[invoiceId]);

    timers.current[invoiceId] = setTimeout(async () => {
      setSaving((s) => ({ ...s, [invoiceId]: 'saving' }));
      try {
        await client.put(`/notes/${invoiceId}`, { note_text: text });
        setSaving((s) => ({ ...s, [invoiceId]: 'saved' }));
        setTimeout(() => setSaving((s) => ({ ...s, [invoiceId]: null })), 2000);
      } catch {
        setSaving((s) => ({ ...s, [invoiceId]: 'error' }));
      }
    }, 800);
  }, []);

  /* ── Delete invoice note (super_admin only) ── */
  const deleteInvoiceNote = useCallback(async (invoiceId) => {
    setSaving((s) => ({ ...s, [invoiceId]: 'saving' }));
    try {
      await client.delete(`/notes/invoice/${invoiceId}`);
      setSaving((s) => ({ ...s, [invoiceId]: null }));
      return true;
    } catch {
      setSaving((s) => ({ ...s, [invoiceId]: 'del-err' }));
      return false;
    }
  }, []);

  /* ── Delete history entry (super_admin only) ── */
  const deleteHistoryEntry = useCallback(async (historyId) => {
    try {
      await client.delete(`/notes/history/${historyId}`);
      return true;
    } catch {
      return false;
    }
  }, []);

  return { saving, saveNote, deleteInvoiceNote, deleteHistoryEntry };
}
