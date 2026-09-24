import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Pencil, Trash2, Search, RefreshCw, Plus, Upload, FileText, CheckCircle, AlertCircle, ChevronDown, ArrowUp, ArrowDown, ArrowUpDown, Printer, Paperclip, Download, Trash } from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './FridgesPage.css';

/* ── Constants ────────────────────────────────────────────── */
const STATUS_OPTS = [
  { v: 'active',                l: 'فعالة',                color: '#10b981' },
  { v: 'inactive',              l: 'غير فعالة',             color: '#6b7280' },
  { v: 'out_of_service',        l: 'خارج الخدمة',           color: '#f59e0b' },
  { v: 'damaged',               l: 'تالفة',                 color: '#ef4444' },
  { v: 'warehouse_maintenance', l: 'بالمستودع للصيانة',     color: '#8b5cf6' },
  { v: 'warehouse_new',         l: 'بالمستودع جديدة',       color: '#3b82f6' },
  { v: 'warehouse_used',        l: 'بالمستودع مستعملة',    color: '#64748b' },
];

const STATUS_MAP = Object.fromEntries(STATUS_OPTS.map(s => [s.v, s]));

/* Roles allowed to create / edit / delete fridges */
const FRIDGE_EDIT_ROLES = ['super_admin', 'it_admin', 'fridge_admin'];
function isAdmin(user) { return FRIDGE_EDIT_ROLES.includes(user?.role); }
/* Who may WRITE a fridge note — mirrors NOTE_ROLES in fridges.js. Notes are
   field intelligence, so supervisors and region managers can write them even
   though they cannot move or delete the asset. */
const NOTE_ROLES = [...FRIDGE_EDIT_ROLES, 'supervisor', 'region_manager'];
function canWriteNote(user) { return NOTE_ROLES.includes(user?.role); }

/* Who may RAISE a transfer request — mirrors REQUEST_ROLES in fridges.js.
   Approval stays with FRIDGE_EDIT_ROLES. */
const TRANSFER_REQUEST_ROLES = ['supervisor', 'region_manager', 'sales_manager', 'super_admin', 'it_admin'];
function canRequestTransfer(user) { return TRANSFER_REQUEST_ROLES.includes(user?.role); }

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ar-SA-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' });
}
function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('ar-SA-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ── API ──────────────────────────────────────────────────── */
const api = {
  list:        (p) => client.get('/fridges', { params: p }).then(r => r.data.fridges),
  stats:       ()  => client.get('/fridges/stats').then(r => r.data),
  lookup:   (code) => client.get('/fridges/customer-lookup', { params: { code } }).then(r => r.data),
  create:      (d) => client.post('/fridges', d).then(r => r.data),
  update:  (id, d) => client.put(`/fridges/${id}`, d).then(r => r.data),
  detail:     (id) => client.get(`/fridges/${id}`).then(r => r.data),
  delete:     (id) => client.delete(`/fridges/${id}`),
  transfer:(id, d) => client.post(`/fridges/${id}/transfer`, d).then(r => r.data),
  refreshCustomerData: () => client.post('/fridges/refresh-customer-data').then(r => r.data),
  regions:     ()  => client.get('/users/regions').then(r => r.data),
  salesReport: (p) => client.get('/fridges/sales-report', { params: p }).then(r => r.data),
  importXlsx: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return client.post('/fridges/import', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data);
  },
  /* transfer requests — raised by a supervisor/region manager, applied only
     after a fridge admin approves */
  transferRequests: (status='pending') => client.get('/fridges/transfer-requests', { params: { status } }).then(r => r.data),
  transferRequest:  (reqId) => client.get(`/fridges/transfer-requests/${reqId}`).then(r => r.data),
  createTransferRequest: (id, d) => client.post(`/fridges/${id}/transfer-requests`, d).then(r => r.data),
  approveTransferRequest: (reqId, note) => client.post(`/fridges/transfer-requests/${reqId}/approve`, { note }).then(r => r.data),
  rejectTransferRequest:  (reqId, note) => client.post(`/fridges/transfer-requests/${reqId}/reject`, { note }).then(r => r.data),
  /* notes — one current note per fridge + an append-only trail */
  noteHistory: (id)       => client.get(`/fridges/${id}/notes`).then(r => r.data.history),
  saveNote:    (id, text) => client.put(`/fridges/${id}/note`, { note_text: text }).then(r => r.data),
  /* contract files */
  contracts:       (id)         => client.get(`/fridges/${id}/contracts`).then(r => r.data.contracts),
  uploadContracts: (id, files)  => {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    return client.post(`/fridges/${id}/contracts`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data);
  },
  deleteContract:  (id, fileId) => client.delete(`/fridges/${id}/contracts/${fileId}`).then(r => r.data),
  downloadContract: async (id, fileId, originalName) => {
    const res = await client.get(`/fridges/${id}/contracts/${fileId}/download`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = originalName || 'contract';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};

/* ── Helpers ─────────────────────────────────────────────── */
function StatusBadge({ status }) {
  const s = STATUS_MAP[status];
  if (!s) return <span className="frg-status-badge" style={{ background: '#f3f4f6', color: '#6b7280' }}>{status || '—'}</span>;
  return (
    <span
      className="frg-status-badge"
      style={{ background: s.color + '22', color: s.color, border: `1px solid ${s.color}44` }}
    >
      {s.l}
    </span>
  );
}

/* ══════════════════════════════════════════════════════════
   CUSTOM FILTER SELECT  (avoids zoom + RTL native issues)
   ══════════════════════════════════════════════════════════ */
function FilterSelect({ value, onChange, options, placeholder }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selected = options.find(o => String(o.value) === String(value));

  return (
    <div ref={wrapRef} className={`frg-fsel${open ? ' frg-fsel-open' : ''}`}>
      <button
        type="button"
        className="frg-fsel-trigger"
        onClick={() => setOpen(v => !v)}
      >
        <span className="frg-fsel-label">{selected ? selected.label : placeholder}</span>
        <ChevronDown size={14} className="frg-fsel-arrow" />
      </button>
      {open && (
        <div className="frg-fsel-menu">
          <div
            className={`frg-fsel-option${!value ? ' frg-fsel-selected' : ''}`}
            onMouseDown={e => { e.preventDefault(); onChange(''); setOpen(false); }}
          >
            {placeholder}
          </div>
          {options.map(o => (
            <div
              key={o.value}
              className={`frg-fsel-option${String(o.value) === String(value) ? ' frg-fsel-selected' : ''}`}
              onMouseDown={e => { e.preventDefault(); onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   CUSTOMER LOOKUP HOOK
   ══════════════════════════════════════════════════════════ */
function useCustomerLookup(onFill) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [warn, setWarn] = useState('');
  const [info, setInfo] = useState('');

  const lookup = useCallback(async (overrideCode) => {
    const c = (overrideCode ?? code).trim();
    if (!c) return;
    setLoading(true);
    setWarn('');
    try {
      const data = await api.lookup(c);
      /* The endpoint answers 200 with {found:false} for an unknown code — without
         this the button appeared to work and quietly filled nothing. */
      if (!data || data.found === false) {
        setInfo('');
        setWarn('لم يُعثر على العميل — يمكنك إدخال البيانات يدوياً');
        return;
      }
      onFill(data);
      const fromList = Object.entries(data.sources || {})
        .filter(([, src]) => src === 'customer_list').map(([f]) => f);
      setInfo(data.in_customer_list
        ? `تم الاستحضار من ملف العملاء المرفوع (${fromList.length} حقل)`
        : 'العميل غير موجود في ملف العملاء المرفوع — تم الاستحضار من الفواتير');
    } catch {
      setInfo('');
      setWarn('لم يُعثر على العميل — يمكنك إدخال البيانات يدوياً');
    } finally {
      setLoading(false);
    }
  }, [code, onFill]);

  return { code, setCode, loading, warn, setWarn, info, setInfo, lookup };
}

/* ══════════════════════════════════════════════════════════
   ADD / EDIT FRIDGE FORM
   ══════════════════════════════════════════════════════════ */
const EMPTY_FORM = {
  asset_number:    '',
  customer_code:   '',
  customer_name:   '',
  region_id:       '',
  route_code:      '',
  salesrep_name:   '',
  contract_number: '',
  contract_date:   '',
  status:          'active',
  notes:           '',
};

function AddFridgeForm({ regions, onSaved, editData, editId, onCancel }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(editData || EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [success, setSuccess] = useState(false);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const fillFromLookup = useCallback((data) => {
    setForm(p => ({
      ...p,
      customer_name:  data.customer_name  || p.customer_name,
      region_id:      data.region_id      != null ? String(data.region_id) : p.region_id,
      route_code:     data.route_code     != null ? String(data.route_code) : p.route_code,
      salesrep_name:  data.salesrep_name  || p.salesrep_name,
    }));
  }, []);

  const lk = useCustomerLookup(fillFromLookup);

  const handleCodeChange = (v) => {
    set('customer_code', v);
    lk.setCode(v);
    lk.setWarn('');
    lk.setInfo('');
  };

  const save = async () => {
    if (!form.asset_number.trim()) { setErr('رقم الثلاجة / الأصل مطلوب'); return; }
    setSaving(true); setErr('');
    try {
      const payload = { ...form };
      if (editId) {
        await api.update(editId, payload);
      } else {
        await api.create(payload);
      }
      qc.invalidateQueries({ queryKey: ['fridges'] });
      qc.invalidateQueries({ queryKey: ['fridge-stats'] });
      if (editId && onSaved) {
        onSaved();
      } else {
        setSuccess(true);
        setForm(EMPTY_FORM);
        lk.setCode('');
        lk.setWarn('');
        setTimeout(() => setSuccess(false), 3000);
      }
    } catch (e) {
      setErr(e.response?.data?.error || 'حدث خطأ أثناء الحفظ');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="frg-form">
      <div className="frg-form-title">{editId ? '✏️ تعديل بيانات الثلاجة' : '🧊 إضافة ثلاجة جديدة'}</div>

      {err && <div className="frg-alert frg-alert-error">{err}</div>}
      {success && <div className="frg-alert frg-alert-success">✅ تم حفظ الثلاجة بنجاح!</div>}

      <div className="frg-form-grid">
        {/* رقم الثلاجة */}
        <div className="frg-form-group">
          <label className="frg-label">رقم الثلاجة / رقم الأصل <span className="frg-req">*</span></label>
          <input
            className="frg-input"
            value={form.asset_number}
            onChange={e => set('asset_number', e.target.value)}
            placeholder="مثال: FRG-0001"
            dir="ltr"
          />
        </div>

        {/* رقم العميل مع استحضار */}
        <div className="frg-form-group">
          <label className="frg-label">رقم العميل</label>
          <div className="frg-lookup-row">
            <input
              className="frg-input"
              value={form.customer_code}
              onChange={e => handleCodeChange(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && lk.lookup(form.customer_code)}
              placeholder="أدخل رقم العميل"
              dir="ltr"
            />
            <button
              className="frg-btn frg-btn-primary frg-btn-sm"
              onClick={() => lk.lookup(form.customer_code)}
              disabled={lk.loading || !form.customer_code.trim()}
              title="استحضار بيانات العميل"
            >
              {lk.loading ? <RefreshCw size={13} className="frg-spin" /> : <Search size={13} />}
              {lk.loading ? 'جارٍ البحث...' : 'استحضار'}
            </button>
          </div>
          {lk.warn && <div className="frg-lookup-warn">⚠️ {lk.warn}</div>}
          {lk.info && <div className="frg-lookup-info">✓ {lk.info}</div>}
        </div>

        {/* اسم العميل */}
        <div className="frg-form-group">
          <label className="frg-label">اسم العميل</label>
          <input
            className="frg-input"
            value={form.customer_name}
            onChange={e => set('customer_name', e.target.value)}
            placeholder="اسم العميل"
          />
        </div>

        {/* المنطقة */}
        <div className="frg-form-group">
          <label className="frg-label">المنطقة</label>
          <select
            className="frg-select"
            value={form.region_id}
            onChange={e => set('region_id', e.target.value)}
          >
            <option value="">— اختر المنطقة —</option>
            {regions.map(r => (
              <option key={r.id} value={r.id}>{r.name_ar}</option>
            ))}
          </select>
        </div>

        {/* رقم الخط */}
        <div className="frg-form-group">
          <label className="frg-label">رقم الخط</label>
          <input
            className="frg-input"
            type="number"
            value={form.route_code}
            onChange={e => set('route_code', e.target.value)}
            placeholder="رقم الخط"
            dir="ltr"
          />
        </div>

        {/* اسم المندوب */}
        <div className="frg-form-group">
          <label className="frg-label">اسم المندوب</label>
          <input
            className="frg-input"
            value={form.salesrep_name}
            onChange={e => set('salesrep_name', e.target.value)}
            placeholder="اسم المندوب"
          />
        </div>

        {/* رقم العقد */}
        <div className="frg-form-group">
          <label className="frg-label">رقم العقد</label>
          <input
            className="frg-input"
            value={form.contract_number}
            onChange={e => set('contract_number', e.target.value)}
            placeholder="رقم العقد"
            dir="ltr"
          />
        </div>

        {/* تاريخ العقد */}
        <div className="frg-form-group">
          <label className="frg-label">تاريخ العقد</label>
          <input
            className="frg-input"
            type="date"
            value={form.contract_date}
            onChange={e => set('contract_date', e.target.value)}
          />
        </div>

        {/* الحالة */}
        <div className="frg-form-group">
          <label className="frg-label">الحالة</label>
          <select
            className="frg-select"
            value={form.status}
            onChange={e => set('status', e.target.value)}
          >
            {STATUS_OPTS.map(s => (
              <option key={s.v} value={s.v}>{s.l}</option>
            ))}
          </select>
        </div>
      </div>

      {/* الملاحظات */}
      <div className="frg-form-group" style={{ marginTop: 4 }}>
        <label className="frg-label">ملاحظات</label>
        <textarea
          className="frg-textarea"
          value={form.notes}
          onChange={e => set('notes', e.target.value)}
          placeholder="أي ملاحظات إضافية..."
          rows={3}
        />
      </div>

      <div className="frg-form-actions">
        {onCancel && (
          <button className="frg-btn frg-btn-ghost" onClick={onCancel}>إلغاء</button>
        )}
        <button className="frg-btn frg-btn-primary" onClick={save} disabled={saving}>
          {saving ? 'جارٍ الحفظ…' : '💾 حفظ الثلاجة'}
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   CONTRACT FILES SECTION
   ══════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════
   Fridge note cell — the notes column in the list.

   Saves only on the ✓ button, never on blur or keystroke: these notes are
   read by other people, and an accidental half-typed autosave is worse than
   no note. The latest note stays visible in the cell; every save is appended
   to an immutable trail reachable from the 🕘 button.
══════════════════════════════════════════════════════════════ */
function FridgeNoteCell({ fridge, canEdit, onSaved }) {
  const [text, setText]       = useState(fridge.note_text || '');
  const [saved, setSaved]     = useState(fridge.note_text || '');
  const [status, setStatus]   = useState(null);   // 'saving' | 'saved' | 'error'
  const [showLog, setShowLog] = useState(false);
  const [log, setLog]         = useState(null);   // null = not loaded yet
  const [logBusy, setLogBusy] = useState(false);
  const [meta, setMeta] = useState({
    at: fridge.note_updated_at, by: fridge.note_updated_by_name, count: fridge.note_count || 0,
  });

  /* Adopt server data on refetch, but never clobber an unsaved edit. */
  const prevIncoming = useRef(fridge.note_text || '');
  useEffect(() => {
    const incoming = fridge.note_text || '';
    if (incoming !== prevIncoming.current) {
      prevIncoming.current = incoming;
      setText(t => (t === saved ? incoming : t));
      setSaved(incoming);
      setMeta({ at: fridge.note_updated_at, by: fridge.note_updated_by_name, count: fridge.note_count || 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fridge.note_text, fridge.note_updated_at, fridge.note_updated_by_name, fridge.note_count]);

  const dirty = text !== saved;

  const save = async () => {
    setStatus('saving');
    try {
      const res = await api.saveNote(fridge.id, text);
      setSaved(text);
      prevIncoming.current = text;
      setMeta({ at: res.note?.updated_at, by: res.note?.updated_by_name, count: res.note_count });
      setLog(null);                    // trail changed — reload on next open
      setStatus('saved');
      setTimeout(() => setStatus(null), 2000);
      onSaved?.();
    } catch (e) {
      setStatus('error');
    }
  };

  const openLog = async () => {
    const next = !showLog;
    setShowLog(next);
    if (next && log === null) {
      setLogBusy(true);
      try { setLog(await api.noteHistory(fridge.id)); }
      catch { setLog([]); }
      finally { setLogBusy(false); }
    }
  };

  return (
    <div className="frg-note-cell" onClick={e => e.stopPropagation()}>
      <textarea
        className={`frg-note-input${saved ? ' frg-note-input--has' : ''}`}
        value={text}
        onChange={e => { setText(e.target.value); setStatus(null); }}
        placeholder={canEdit ? 'ملاحظة…' : 'لا توجد ملاحظة'}
        rows={2}
        disabled={!canEdit}
      />
      <div className="frg-note-actions">
        {canEdit && dirty && (
          <>
            <button className="frg-note-btn frg-note-btn--save" onClick={save} disabled={status === 'saving'}>
              {status === 'saving' ? '…' : '✓ حفظ'}
            </button>
            <button className="frg-note-btn" onClick={() => { setText(saved); setStatus(null); }}>✕</button>
          </>
        )}
        {!dirty && status === 'saved' && <span className="frg-note-ok">✓ محفوظ</span>}
        {status === 'error' && <span className="frg-note-err">خطأ في الحفظ</span>}
        {meta.count > 0 && (
          <button className="frg-note-btn frg-note-btn--log" onClick={openLog}
                  title="سجل الملاحظات">
            🕘 {meta.count}
          </button>
        )}
      </div>

      {!dirty && meta.at && (
        <div className="frg-note-meta">
          آخر تحديث: {formatDateTime(meta.at)}{meta.by ? ` — ${meta.by}` : ''}
        </div>
      )}

      {showLog && (
        <div className="frg-note-log">
          <div className="frg-note-log__head">
            <span>سجل الملاحظات ({meta.count})</span>
            <button className="frg-note-btn" onClick={() => setShowLog(false)}>✕</button>
          </div>
          {logBusy && <div className="frg-note-log__empty">جارٍ التحميل…</div>}
          {!logBusy && log && log.length === 0 && (
            <div className="frg-note-log__empty">لا يوجد سجل</div>
          )}
          {!logBusy && log && log.map(h => (
            <div key={h.id} className="frg-note-log__item">
              <div className="frg-note-log__text">
                {h.note_text ? h.note_text : <em className="frg-note-log__cleared">— تم مسح الملاحظة —</em>}
              </div>
              <div className="frg-note-log__meta">
                {formatDateTime(h.saved_at)}{h.saved_by_name ? ` — ${h.saved_by_name}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ContractFilesSection({ fridgeId, contracts: initialContracts, admin, onChanged }) {
  const qc = useQueryClient();
  const fileInputRef = useRef(null);
  const dropRef      = useRef(null);

  const [contracts, setContracts] = useState(initialContracts);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState('');
  const [dragging,  setDragging]  = useState(false);

  // Sync when parent re-fetches
  useEffect(() => { setContracts(initialContracts); }, [initialContracts]);

  const doUpload = async (files) => {
    if (!files?.length) return;
    setUploading(true); setUploadErr('');
    try {
      const res = await api.uploadContracts(fridgeId, Array.from(files));
      setContracts(prev => [...res.contracts, ...prev]);
      onChanged?.();
      qc.invalidateQueries({ queryKey: ['fridges'] });
    } catch (e) {
      setUploadErr(e.response?.data?.error || 'فشل رفع الملفات');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const doDelete = async (fileId, name) => {
    if (!window.confirm(`حذف الملف "${name}"؟`)) return;
    try {
      await api.deleteContract(fridgeId, fileId);
      setContracts(prev => prev.filter(c => c.id !== fileId));
      onChanged?.();
      qc.invalidateQueries({ queryKey: ['fridges'] });
    } catch (e) {
      alert(e.response?.data?.error || 'فشل الحذف');
    }
  };

  /* drag & drop handlers */
  const onDragOver  = (e) => { e.preventDefault(); setDragging(true);  };
  const onDragLeave = ()  => setDragging(false);
  const onDrop      = (e) => { e.preventDefault(); setDragging(false); doUpload(e.dataTransfer.files); };

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024)       return `${bytes} B`;
    if (bytes < 1024*1024)  return `${(bytes/1024).toFixed(1)} KB`;
    return `${(bytes/1024/1024).toFixed(1)} MB`;
  }

  return (
    <div className="frg-contracts-section">
      {/* Header */}
      <div className="frg-contracts-header">
        <span className="frg-contracts-title">
          <Paperclip size={14} />
          ملفات العقد
          {contracts.length > 0
            ? <span className="frg-contracts-count frg-contracts-count--yes">{contracts.length} ملف</span>
            : <span className="frg-contracts-count frg-contracts-count--no">لا يوجد ملف</span>
          }
        </span>
        {admin && (
          <>
            <button
              className="frg-btn frg-btn-sm frg-btn-primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading
                ? <><RefreshCw size={12} className="frg-spin" /> جارٍ الرفع…</>
                : <><Upload size={12} /> رفع ملف</>
              }
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.xls,.xlsx"
              style={{ display: 'none' }}
              onChange={e => doUpload(e.target.files)}
            />
          </>
        )}
      </div>

      {uploadErr && <div className="frg-alert frg-alert-error" style={{ margin: '6px 0' }}>{uploadErr}</div>}

      {/* Drop zone (shown when no files or always) */}
      {admin && (
        <div
          ref={dropRef}
          className={`frg-drop-zone${dragging ? ' frg-drop-zone--active' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={16} />
          <span>اسحب الملفات هنا أو انقر للاختيار</span>
          <span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>PDF · Word · صورة · Excel — حتى 50 MB لكل ملف</span>
        </div>
      )}

      {/* File list */}
      {contracts.length > 0 && (
        <ul className="frg-contract-list">
          {contracts.map(c => (
            <li key={c.id} className="frg-contract-item">
              <FileText size={15} className="frg-contract-icon" />
              <span className="frg-contract-name" title={c.original_name}>{c.original_name}</span>
              <span className="frg-contract-size">{fmtSize(c.file_size)}</span>
              <button
                className="frg-btn frg-btn-ghost frg-btn-xs"
                title="تنزيل"
                onClick={() => api.downloadContract(fridgeId, c.id, c.original_name)}
              >
                <Download size={12} />
              </button>
              {admin && (
                <button
                  className="frg-btn frg-btn-danger frg-btn-xs"
                  title="حذف الملف"
                  onClick={() => doDelete(c.id, c.original_name)}
                >
                  <Trash size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   FRIDGE DETAIL MODAL
   ══════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════
   طلب نقل ثلاجة — raised by a supervisor / region manager, applied only
   after a fridge admin (or system admin) approves.

   Deliberately separate from the direct "نقل لعميل جديد" action: that one
   moves the fridge immediately and is limited to fridge admins. This one
   records an intent, prints as a signed sheet, and changes nothing until
   somebody with the authority approves it.
══════════════════════════════════════════════════════════════ */
function TransferRequestForm({ fridge, onDone, onCancel }) {
  const [code, setCode]   = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState('');
  const [target, setTarget] = useState(null);   // looked-up new customer
  const [looking, setLooking] = useState(false);

  const lookup = async () => {
    if (!code.trim()) return;
    setLooking(true); setErr('');
    try {
      const d = await api.lookup(code.trim());
      if (!d || d.found === false) { setTarget(null); setErr('لم يُعثر على العميل'); }
      else setTarget(d);
    } catch { setErr('تعذّر استحضار بيانات العميل'); }
    finally { setLooking(false); }
  };

  const submit = async () => {
    if (!code.trim()) { setErr('رقم العميل الجديد مطلوب'); return; }
    setBusy(true); setErr('');
    try {
      const res = await api.createTransferRequest(fridge.id, {
        to_customer_code: code.trim(), reason,
      });
      onDone?.(res.request);
    } catch (e) {
      setErr(e.response?.data?.error || 'تعذّر إنشاء الطلب');
    } finally { setBusy(false); }
  };

  return (
    <div className="frg-transfer-form frg-transfer-request">
      <div className="frg-transfer-title">📝 طلب نقل الثلاجة لعميل آخر</div>
      <div className="frg-req-hint">
        الطلب يُرفع لمسؤولي الثلاجات كطلب مبدئي — لا تُنقل الثلاجة إلا بعد الموافقة.
      </div>
      {err && <div className="frg-alert frg-alert-error">{err}</div>}

      <div className="frg-form-group">
        <label className="frg-label">رقم العميل الجديد <span className="frg-req">*</span></label>
        <div className="frg-lookup-row">
          <input className="frg-input" value={code} dir="ltr" placeholder="رقم العميل"
                 onChange={e => { setCode(e.target.value); setTarget(null); setErr(''); }}
                 onKeyDown={e => e.key === 'Enter' && lookup()} />
          <button className="frg-btn frg-btn-primary frg-btn-sm" onClick={lookup}
                  disabled={looking || !code.trim()}>
            {looking ? '…' : 'استحضار'}
          </button>
        </div>
      </div>

      {target && (
        <div className="frg-req-preview">
          <div className="frg-req-preview__row">
            <span>العميل الحالي</span>
            <strong><bdi>{fridge.customer_name || fridge.customer_code || '—'}</bdi></strong>
          </div>
          <div className="frg-req-preview__row">
            <span>خط السير الحالي / المندوب</span>
            <strong><bdi>{fridge.route_code || '—'} · {fridge.salesrep_name || '—'}</bdi></strong>
          </div>
          <div className="frg-req-preview__arrow">↓</div>
          <div className="frg-req-preview__row">
            <span>العميل الجديد</span>
            <strong><bdi>{target.customer_name || code}</bdi></strong>
          </div>
          <div className="frg-req-preview__row">
            <span>خط السير الجديد / المندوب</span>
            <strong><bdi>{target.route_code || '—'} · {target.salesrep_name || '—'}</bdi></strong>
          </div>
        </div>
      )}

      <div className="frg-form-group">
        <label className="frg-label">سبب النقل</label>
        <textarea className="frg-textarea" rows={2} value={reason}
                  placeholder="سبب الطلب…" onChange={e => setReason(e.target.value)} />
      </div>

      <div className="frg-transfer-actions">
        <button className="frg-btn frg-btn-ghost frg-btn-sm" onClick={onCancel}>إلغاء</button>
        <button className="frg-btn frg-btn-primary frg-btn-sm" onClick={submit} disabled={busy}>
          {busy ? 'جارٍ الإرسال…' : '📤 رفع الطلب للاعتماد'}
        </button>
      </div>
    </div>
  );
}

/* Printable request sheet — its own window so the page's own print rules
   (and every dashboard chrome element) stay out of it. */
function printRequestSheet(rq) {
  const line = (k, v) => `<tr><th>${k}</th><td>${v ?? '—'}</td></tr>`;
  const statusAr = { pending: 'مبدئي — بانتظار الاعتماد', approved: 'معتمد', rejected: 'مرفوض', cancelled: 'ملغى' };
  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
    <title>طلب نقل ثلاجة ${rq.asset_number || ''}</title>
    <style>
      body { font-family: "Segoe UI", Tahoma, sans-serif; padding: 28px; color: #1f2937; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      .sub { color: #6b7280; font-size: 12px; margin-bottom: 18px; }
      .badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px;
               font-weight:700; background:#fef3c7; color:#92400e; border:1px solid #fcd34d; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
      th, td { border: 1px solid #e5e7eb; padding: 7px 10px; font-size: 13px; text-align: right; }
      th { background: #f8fafc; width: 210px; font-weight: 700; color: #374151; }
      h2 { font-size: 14px; margin: 16px 0 6px; padding-bottom: 4px; border-bottom: 2px solid #e5e7eb; }
      .sign { margin-top: 34px; display: flex; gap: 40px; }
      .sign div { flex: 1; border-top: 1px solid #9ca3af; padding-top: 6px; font-size: 12px; color: #4b5563; }
      @media print { body { padding: 0; } }
    </style></head><body>
    <h1>طلب نقل ثلاجة</h1>
    <div class="sub">رقم الطلب: ${rq.id} · التاريخ: ${new Date(rq.requested_at).toLocaleString('ar-SA-u-nu-latn')}
      · <span class="badge">${statusAr[rq.status] || rq.status}</span></div>

    <h2>بيانات الثلاجة</h2>
    <table>
      ${line('رقم الثلاجة / الأصل', rq.asset_number)}
      ${line('رقم العقد', rq.contract_number)}
      ${line('حالة الثلاجة', rq.fridge_status)}
    </table>

    <h2>العميل الحالي</h2>
    <table>
      ${line('رقم العميل', rq.from_customer_code)}
      ${line('اسم العميل', rq.from_customer_name)}
      ${line('خط السير', [rq.from_route_code, rq.from_route_name].filter(Boolean).join(' — '))}
      ${line('المندوب المسؤول', rq.from_salesman_name)}
      ${line('المنطقة', rq.from_region_name)}
    </table>

    <h2>العميل الجديد (المطلوب النقل إليه)</h2>
    <table>
      ${line('رقم العميل', rq.to_customer_code)}
      ${line('اسم العميل', rq.to_customer_name)}
      ${line('خط السير', [rq.to_route_code, rq.to_route_name].filter(Boolean).join(' — '))}
      ${line('المندوب المسؤول', rq.to_salesman_name)}
      ${line('المنطقة', rq.to_region_name)}
    </table>

    <h2>مقدّم الطلب</h2>
    <table>
      ${line('الاسم', rq.requested_by_name)}
      ${line('الصفة', rq.requested_by_role)}
      ${line('سبب النقل', rq.reason)}
      ${rq.decided_by_name ? line('القرار', `${statusAr[rq.status]} — ${rq.decided_by_name}`) : ''}
      ${rq.decision_note ? line('ملاحظة القرار', rq.decision_note) : ''}
    </table>

    <div class="sign">
      <div>توقيع مقدّم الطلب</div>
      <div>توقيع مسؤول الثلاجات</div>
      <div>الاعتماد النهائي</div>
    </div>
    <script>window.onload = () => window.print();</script>
  </body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('يرجى السماح بالنوافذ المنبثقة لطباعة الطلب'); return; }
  w.document.write(html);
  w.document.close();
}

/* Pending-requests banner for fridge admins — the "إشعار" side of the flow. */
function PendingRequestsBanner() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const { data } = useQuery({
    queryKey: ['fridge-transfer-requests', 'pending'],
    queryFn:  () => api.transferRequests('pending'),
    staleTime: 30_000,
  });

  const requests = data?.requests || [];
  const canApprove = !!data?.can_approve;
  if (!requests.length) return null;

  const decide = async (id, approve) => {
    const note = approve ? '' : (window.prompt('سبب الرفض (اختياري)') ?? '');
    if (!approve && note === null) return;
    setBusyId(id);
    try {
      if (approve) await api.approveTransferRequest(id, note);
      else         await api.rejectTransferRequest(id, note);
      qc.invalidateQueries({ queryKey: ['fridge-transfer-requests'] });
      qc.invalidateQueries({ queryKey: ['fridges'] });
      qc.invalidateQueries({ queryKey: ['fridge-stats'] });
    } catch (e) {
      alert(e.response?.data?.error || 'تعذّر تنفيذ القرار');
    } finally { setBusyId(null); }
  };

  return (
    <div className="frg-req-banner">
      <span className="frg-req-banner__icon">📝</span>
      <div className="frg-req-banner__body">
        <div className="frg-req-banner__title">
          {requests.length} طلب نقل ثلاجة بانتظار الاعتماد
        </div>
        <div className="frg-req-banner__sub">
          {canApprove
            ? 'الثلاجة لا تُنقل إلا بعد اعتمادك للطلب.'
            : 'الطلبات معروضة للاطلاع — الاعتماد من صلاحية مسؤولي الثلاجات.'}
        </div>
      </div>
      <button className="frg-btn frg-btn-sm frg-btn-ghost" onClick={() => setOpen(v => !v)}>
        {open ? 'إخفاء' : 'عرض الطلبات'}
      </button>

      {open && (
        <div className="frg-req-list">
          {requests.map(r => (
            <div key={r.id} className="frg-req-item">
              <div className="frg-req-item__main">
                <strong dir="ltr">{r.asset_number}</strong>
                <span className="frg-req-item__move">
                  <bdi>{r.from_customer_name || r.from_customer_code || '—'}</bdi>
                  {' '}(خط {r.from_route_code || '—'} · {r.from_salesman_name || '—'})
                  {' ← '}
                  <bdi>{r.to_customer_name || r.to_customer_code}</bdi>
                  {' '}(خط {r.to_route_code || '—'} · {r.to_salesman_name || '—'})
                </span>
                <span className="frg-req-item__meta">
                  مقدّم الطلب: {r.requested_by_name || '—'} · {formatDateTime(r.requested_at)}
                  {r.reason ? ` · ${r.reason}` : ''}
                </span>
              </div>
              <div className="frg-req-item__actions">
                <button className="frg-btn frg-btn-sm frg-btn-ghost"
                        onClick={() => printRequestSheet(r)}>🖨 طباعة</button>
                {canApprove && (
                  <>
                    <button className="frg-btn frg-btn-sm frg-btn-primary"
                            disabled={busyId === r.id}
                            onClick={() => decide(r.id, true)}>✅ اعتماد</button>
                    <button className="frg-btn frg-btn-sm frg-btn-danger"
                            disabled={busyId === r.id}
                            onClick={() => decide(r.id, false)}>✕ رفض</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FridgeDetailModal({ fridgeId, regions, onClose, onChanged }) {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const qc = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['fridge-detail', fridgeId],
    queryFn:  () => api.detail(fridgeId),
    staleTime: 0,
  });

  /* panel mode: null | 'edit' | 'repair' | 'reassign' */
  const [panel, setPanel] = useState(null);

  /* repair form */
  const [repairNotes, setRepairNotes]         = useState('');
  const [repairFromRegionId, setRepairFromRegionId] = useState(''); // منطقة السحب
  const [repairToRegionId, setRepairToRegionId]     = useState(''); // منطقة التسليم
  const [repairStatus, setRepairStatus]       = useState('warehouse_maintenance');
  const [repairEditStatus, setRepairEditStatus] = useState(false); // toggles the status select
  const [repairBusy, setRepairBusy]           = useState(false);
  const [repairErr, setRepairErr]             = useState('');

  /* reassign form */
  const [newCode, setNewCode]         = useState('');
  const [newName, setNewName]         = useState('');
  const [reassignNotes, setReassignNotes] = useState('');
  /* "بانتظار توقيع العقد" — set when the fridge changes hands but the new
     signed contract is not available yet. It stays on the fridge as an alert
     until a contract file is uploaded, which clears it server-side. */
  const [pendingContract, setPendingContract] = useState(true);
  const [lookingUp, setLookingUp]     = useState(false);
  const [lookupWarn, setLookupWarn]   = useState('');
  const [reassignBusy, setReassignBusy] = useState(false);
  const [reassignErr, setReassignErr]  = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['fridges'] });
    qc.invalidateQueries({ queryKey: ['fridge-stats'] });
    qc.invalidateQueries({ queryKey: ['fridge-detail', fridgeId] });
    refetch();
    onChanged?.();
  };

  /* ── Repair ── */
  const doRepair = async () => {
    setRepairBusy(true); setRepairErr('');
    try {
      await api.transfer(fridgeId, {
        transfer_type: 'repair',
        notes: repairNotes,
        from_region_id: repairFromRegionId || null,
        to_region_id:   repairToRegionId   || null,
        status:         repairStatus,
      });
      invalidate();
      setPanel(null);
      setRepairNotes('');
      setRepairFromRegionId('');
      setRepairToRegionId('');
      setRepairStatus('warehouse_maintenance');
    } catch (e) {
      setRepairErr(e.response?.data?.error || 'حدث خطأ');
    } finally { setRepairBusy(false); }
  };

  /* ── Reassign lookup ── */
  const lookupNewCustomer = async () => {
    if (!newCode.trim()) return;
    setLookingUp(true); setLookupWarn('');
    try {
      const d = await api.lookup(newCode.trim());
      setNewName(d.customer_name || '');
    } catch {
      setLookupWarn('لم يُعثر على العميل — يمكنك إدخال البيانات يدوياً');
    } finally { setLookingUp(false); }
  };

  /* ── Reassign submit ── */
  const doReassign = async () => {
    if (!newCode.trim()) { setReassignErr('رقم العميل الجديد مطلوب'); return; }
    setReassignBusy(true); setReassignErr('');
    try {
      await api.transfer(fridgeId, {
        transfer_type: 'reassign',
        to_customer_code: newCode.trim(),
        to_customer_name: newName.trim(),
        notes: reassignNotes,
        pending_contract: pendingContract,
      });
      invalidate();
      setPanel(null);
      setNewCode(''); setNewName(''); setReassignNotes(''); setPendingContract(true);
    } catch (e) {
      setReassignErr(e.response?.data?.error || 'حدث خطأ');
    } finally { setReassignBusy(false); }
  };

  /* ── Delete ── */
  const doDelete = async () => {
    if (!window.confirm('هل تريد حذف هذه الثلاجة نهائياً؟')) return;
    try {
      await api.delete(fridgeId);
      qc.invalidateQueries({ queryKey: ['fridges'] });
      qc.invalidateQueries({ queryKey: ['fridge-stats'] });
      onClose();
    } catch (e) {
      alert(e.response?.data?.error || 'حدث خطأ أثناء الحذف');
    }
  };

  /* ── Edit saved ── */
  const handleEditSaved = () => {
    invalidate();
    setPanel(null);
  };

  if (isLoading) return createPortal(
    <div className="frg-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="frg-modal" style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>
        جارٍ التحميل…
      </div>
    </div>,
    document.body
  );

  if (!data) return null;
  const { fridge, history = [] } = data;

  const region = regions.find(r => String(r.id) === String(fridge.region_id));

  return createPortal(
    <div className="frg-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="frg-modal">

        {/* ── Modal Header ── */}
        <div className="frg-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>🧊</span>
            <div>
              <div className="frg-modal-title">{fridge.asset_number}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{fridge.customer_name || '—'}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {fridge.pending_contract && (
              <span className="frg-pending-badge" title="نُقلت لعميل جديد دون عقد موقّع">⏳ بانتظار العقد</span>
            )}
            <StatusBadge status={fridge.status} />
            <button className="frg-modal-close" onClick={onClose} title="إغلاق">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ── Modal Body ── */}
        <div className="frg-modal-body">

          {/* Awaiting-contract alert — stays until a contract file is uploaded,
              which clears the flag server-side inside the same transaction. */}
          {fridge.pending_contract && (
            <div className="frg-pending-alert">
              <span className="frg-pending-alert__icon">⏳</span>
              <div>
                <div className="frg-pending-alert__title">بانتظار توقيع العقد</div>
                <div className="frg-pending-alert__sub">
                  نُقلت الثلاجة إلى <bdi>{fridge.customer_name || fridge.customer_code || 'عميل جديد'}</bdi> دون
                  رفع عقد جديد موقّع
                  {fridge.pending_contract_since && <> — منذ {formatDateTime(fridge.pending_contract_since)}</>}.
                  ارفع ملف العقد من قسم «ملفات العقد» أدناه ليُلغى هذا التنبيه تلقائياً.
                </div>
              </div>
            </div>
          )}

          {/* ── Inline Edit Form ── */}
          {panel === 'edit' && (
            <AddFridgeForm
              regions={regions}
              editId={fridgeId}
              editData={{
                asset_number:    fridge.asset_number    || '',
                customer_code:   fridge.customer_code   || '',
                customer_name:   fridge.customer_name   || '',
                region_id:       fridge.region_id != null ? String(fridge.region_id) : '',
                route_code:      fridge.route_code != null ? String(fridge.route_code) : '',
                salesrep_name:   fridge.salesrep_name   || '',
                contract_number: fridge.contract_number || '',
                contract_date:   fridge.contract_date   ? fridge.contract_date.split('T')[0] : '',
                status:          fridge.status          || 'active',
                notes:           fridge.notes           || '',
              }}
              onSaved={handleEditSaved}
              onCancel={() => setPanel(null)}
            />
          )}

          {/* ── Detail View ── */}
          {panel !== 'edit' && (
            <>
              {/* Info grid */}
              <div className="frg-detail-grid">
                <div className="frg-info-item">
                  <span className="frg-info-label">رقم الثلاجة / الأصل</span>
                  <span className="frg-info-val" dir="ltr">{fridge.asset_number || '—'}</span>
                </div>
                <div className="frg-info-item">
                  <span className="frg-info-label">رقم العميل</span>
                  <span className="frg-info-val" dir="ltr">{fridge.customer_code || '—'}</span>
                </div>
                <div className="frg-info-item">
                  <span className="frg-info-label">اسم العميل</span>
                  <span className="frg-info-val">{fridge.customer_name || '—'}</span>
                </div>
                <div className="frg-info-item">
                  <span className="frg-info-label">المنطقة</span>
                  <span className="frg-info-val">{region?.name_ar || fridge.region_name || '—'}</span>
                </div>
                <div className="frg-info-item">
                  <span className="frg-info-label">رقم الخط</span>
                  <span className="frg-info-val" dir="ltr">{fridge.route_code ?? '—'}</span>
                </div>
                <div className="frg-info-item">
                  <span className="frg-info-label">اسم المندوب</span>
                  <span className="frg-info-val">{fridge.salesrep_name || '—'}</span>
                </div>
                <div className="frg-info-item">
                  <span className="frg-info-label">رقم العقد</span>
                  <span className="frg-info-val" dir="ltr">{fridge.contract_number || '—'}</span>
                </div>
                <div className="frg-info-item">
                  <span className="frg-info-label">تاريخ العقد</span>
                  <span className="frg-info-val">{formatDate(fridge.contract_date)}</span>
                </div>
                <div className="frg-info-item">
                  <span className="frg-info-label">تاريخ الإضافة</span>
                  <span className="frg-info-val">{formatDate(fridge.created_at)}</span>
                </div>
                <div className="frg-info-item">
                  <span className="frg-info-label">آخر تعديل</span>
                  <span className="frg-info-val">{formatDate(fridge.updated_at)}</span>
                </div>
                {fridge.notes && (
                  <div className="frg-info-item" style={{ gridColumn: '1 / -1' }}>
                    <span className="frg-info-label">ملاحظات</span>
                    <span className="frg-info-val">{fridge.notes}</span>
                  </div>
                )}
              </div>

              {/* ── Contract Files Section ── */}
              <ContractFilesSection
                fridgeId={fridgeId}
                contracts={data.contracts || []}
                admin={admin}
                onChanged={invalidate}
              />

              {/* ── Action Buttons ── */}
              <div className="frg-detail-actions">
                <button className="frg-btn frg-btn-ghost frg-btn-sm" onClick={() => setPanel('edit')}>
                  <Pencil size={13} /> تعديل
                </button>
                <button
                  className="frg-btn frg-btn-sm"
                  style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}
                  onClick={() => {
                    setPanel('repair'); setRepairErr(''); setRepairNotes('');
                    const curRegion = fridge.region_id != null ? String(fridge.region_id) : '';
                    setRepairFromRegionId(curRegion);
                    setRepairToRegionId(curRegion);
                    setRepairStatus('warehouse_maintenance');
                    setRepairEditStatus(false);
                  }}
                >
                  🔧 سحب للإصلاح
                </button>
                {admin && (
                  <button
                    className="frg-btn frg-btn-sm"
                    style={{ background: '#ede9fe', color: '#5b21b6', border: '1px solid #c4b5fd' }}
                    onClick={() => { setPanel('reassign'); setReassignErr(''); setLookupWarn(''); setNewCode(''); setNewName(''); setReassignNotes(''); }}
                  >
                    🔄 نقل لعميل جديد
                  </button>
                )}
                {/* Supervisors / region managers cannot move a fridge themselves —
                    they raise a request that a fridge admin has to approve. */}
                {canRequestTransfer(user) && (
                  <button
                    className="frg-btn frg-btn-sm frg-btn-request"
                    onClick={() => setPanel('request')}
                  >
                    📝 طلب نقل لعميل آخر
                  </button>
                )}
                {admin && (
                  <button className="frg-btn frg-btn-danger frg-btn-sm" onClick={doDelete}>
                    <Trash2 size={13} /> حذف
                  </button>
                )}
              </div>

              {/* ── Repair Form ── */}
              {panel === 'repair' && (
                <div className="frg-transfer-form frg-transfer-repair">
                  <div className="frg-transfer-title">🔧 سحب الثلاجة للإصلاح</div>
                  {repairErr && <div className="frg-alert frg-alert-error">{repairErr}</div>}
                  <div className="frg-form-group">
                    <label className="frg-label">منطقة السحب</label>
                    <select
                      className="frg-select"
                      value={repairFromRegionId}
                      onChange={e => setRepairFromRegionId(e.target.value)}
                    >
                      <option value="">— بدون تحديد —</option>
                      {regions.map(r => (
                        <option key={r.id} value={r.id}>{r.name_ar}</option>
                      ))}
                    </select>
                  </div>
                  <div className="frg-form-group">
                    <label className="frg-label">منطقة التسليم</label>
                    <select
                      className="frg-select"
                      value={repairToRegionId}
                      onChange={e => setRepairToRegionId(e.target.value)}
                    >
                      <option value="">— بدون تحديد —</option>
                      {regions.map(r => (
                        <option key={r.id} value={r.id}>{r.name_ar}</option>
                      ))}
                    </select>
                  </div>
                  <div className="frg-form-group">
                    <label className="frg-label">ملاحظات الإصلاح</label>
                    <textarea
                      className="frg-textarea"
                      value={repairNotes}
                      onChange={e => setRepairNotes(e.target.value)}
                      placeholder="سبب السحب للإصلاح..."
                      rows={3}
                    />
                  </div>
                  {!repairEditStatus ? (
                    <button
                      type="button"
                      className="frg-link-btn"
                      onClick={() => setRepairEditStatus(true)}
                    >
                      ✏️ تعديل حالة الثلاجة
                    </button>
                  ) : (
                    <div className="frg-form-group">
                      <label className="frg-label">حالة الثلاجة</label>
                      <select
                        className="frg-select"
                        value={repairStatus}
                        onChange={e => setRepairStatus(e.target.value)}
                      >
                        {STATUS_OPTS.map(s => (
                          <option key={s.v} value={s.v}>{s.l}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="frg-transfer-actions">
                    <button className="frg-btn frg-btn-ghost frg-btn-sm" onClick={() => setPanel(null)}>إلغاء</button>
                    <button
                      className="frg-btn frg-btn-sm"
                      style={{ background: '#f59e0b', color: '#fff' }}
                      onClick={doRepair}
                      disabled={repairBusy}
                    >
                      {repairBusy ? 'جارٍ الحفظ…' : '✅ تأكيد السحب'}
                    </button>
                  </div>
                </div>
              )}

              {/* ── Reassign Form ── */}
              {panel === 'request' && (
                <TransferRequestForm
                  fridge={fridge}
                  onCancel={() => setPanel(null)}
                  onDone={(rq) => {
                    setPanel(null);
                    invalidate();
                    qc.invalidateQueries({ queryKey: ['fridge-transfer-requests'] });
                    /* Print immediately — the sheet IS the deliverable of raising
                       a request, and the data is freshest right now. */
                    printRequestSheet({ ...rq, fridge_status: fridge.status,
                                        contract_number: fridge.contract_number });
                  }}
                />
              )}

              {panel === 'reassign' && (
                <div className="frg-transfer-form frg-transfer-reassign">
                  <div className="frg-transfer-title">🔄 نقل الثلاجة لعميل جديد</div>
                  {reassignErr && <div className="frg-alert frg-alert-error">{reassignErr}</div>}
                  <div className="frg-form-group">
                    <label className="frg-label">رقم العميل الجديد <span className="frg-req">*</span></label>
                    <div className="frg-lookup-row">
                      <input
                        className="frg-input"
                        value={newCode}
                        onChange={e => { setNewCode(e.target.value); setLookupWarn(''); }}
                        onKeyDown={e => e.key === 'Enter' && lookupNewCustomer()}
                        placeholder="رقم العميل"
                        dir="ltr"
                      />
                      <button
                        className="frg-btn frg-btn-primary frg-btn-sm"
                        onClick={lookupNewCustomer}
                        disabled={lookingUp || !newCode.trim()}
                      >
                        {lookingUp ? <RefreshCw size={12} className="frg-spin" /> : <Search size={12} />}
                        {lookingUp ? 'بحث...' : 'استحضار'}
                      </button>
                    </div>
                    {lookupWarn && <div className="frg-lookup-warn">⚠️ {lookupWarn}</div>}
                  </div>
                  <div className="frg-form-group">
                    <label className="frg-label">اسم العميل الجديد</label>
                    <input
                      className="frg-input"
                      value={newName}
                      onChange={e => setNewName(e.target.value)}
                      placeholder="اسم العميل"
                    />
                  </div>
                  <div className="frg-form-group">
                    <label className="frg-label">ملاحظات النقل</label>
                    <textarea
                      className="frg-textarea"
                      value={reassignNotes}
                      onChange={e => setReassignNotes(e.target.value)}
                      placeholder="سبب أو ملاحظات النقل..."
                      rows={2}
                    />
                  </div>
                  {/* Awaiting-contract flag. A fridge moving to a new customer
                      needs a contract signed by THAT customer — the files
                      already on the fridge belong to the previous one — so this
                      is on by default and turned off only when the new signed
                      contract has already been attached above. */}
                  <label className={`frg-pending-toggle${pendingContract ? ' frg-pending-toggle--on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={pendingContract}
                      onChange={e => setPendingContract(e.target.checked)}
                    />
                    <span className="frg-pending-toggle__body">
                      <span className="frg-pending-toggle__title">⏳ بانتظار توقيع العقد</span>
                      <span className="frg-pending-toggle__sub">
                        فعّله إذا لم يُرفَع عقد جديد موقّع من العميل الجديد أثناء النقل. سيظل تنبيه
                        على الثلاجة حتى يتم رفع العقد، ويُلغى التنبيه تلقائياً بمجرد رفعه.
                      </span>
                    </span>
                  </label>

                  <div className="frg-transfer-actions">
                    <button className="frg-btn frg-btn-ghost frg-btn-sm" onClick={() => setPanel(null)}>إلغاء</button>
                    <button
                      className="frg-btn frg-btn-primary frg-btn-sm"
                      onClick={doReassign}
                      disabled={reassignBusy}
                    >
                      {reassignBusy ? 'جارٍ الحفظ…' : '✅ تأكيد النقل'}
                    </button>
                  </div>
                </div>
              )}

              {/* ── Transfer History ── */}
              <div style={{ marginTop: 24 }}>
                <div className="frg-section-title">📜 سجل التنقلات ({history.length})</div>
                {history.length === 0 ? (
                  <div className="frg-empty-small">لا توجد تنقلات مسجّلة</div>
                ) : (
                  <div className="frg-history-list">
                    {history.map((h, i) => (
                      <div key={h.id || i} className="frg-history-item">
                        <div className="frg-history-dot" />
                        <div className="frg-history-content">
                          <div className="frg-history-type">
                            {h.transfer_type === 'repair'   && '🔧 سحب للإصلاح'}
                            {h.transfer_type === 'reassign' && '🔄 نقل لعميل جديد'}
                            {h.transfer_type === 'return'   && '↩️ إعادة'}
                            {!['repair','reassign','return'].includes(h.transfer_type) && h.transfer_type}
                            {h.pending_contract && (
                              <span className="frg-pending-chip" title="تم النقل دون عقد جديد موقّع">⏳ بلا عقد</span>
                            )}
                          </div>
                          <div className="frg-history-meta">
                            {h.from_customer_name && h.to_customer_name && (
                              <span>{h.from_customer_name} ← {h.to_customer_name}</span>
                            )}
                            {h.from_customer_name && !h.to_customer_name && (
                              <span>من: {h.from_customer_name}</span>
                            )}
                            {h.transfer_type === 'repair' && h.to_region_name && h.from_region_id !== h.to_region_id && (
                              <span>
                                {h.from_customer_name || h.to_customer_name ? ' — ' : ''}
                                المنطقة: {h.from_region_name || '—'} ← {h.to_region_name}
                              </span>
                            )}
                          </div>
                          {h.notes && <div className="frg-history-notes">{h.notes}</div>}
                          <div className="frg-history-date">{formatDateTime(h.transferred_at || h.created_at)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ══════════════════════════════════════════════════════════
   FRIDGES LIST
   ══════════════════════════════════════════════════════════ */
function FridgesList({ regions, onAddClick }) {
  const { user } = useAuth();
  const admin = isAdmin(user);

  const [statusFilter, setStatusFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [search, setSearch]             = useState('');
  const [detailId, setDetailId]         = useState(null);

  const qc = useQueryClient();

  const [refreshing, setRefreshing] = useState(false);
  const doRefreshCustomerData = async () => {
    if (!window.confirm(
      'تحديث خط السير واسم المندوب لكل الثلاجات من العميل المرتبط بكل ثلاجة حالياً؟'
    )) return;
    setRefreshing(true);
    try {
      const d = await api.refreshCustomerData();
      qc.invalidateQueries({ queryKey: ['fridges'] });
      qc.invalidateQueries({ queryKey: ['fridge-stats'] });
      alert(
        `تم تحديث ${d.updated} ثلاجة من أصل ${d.total_with_customer} مرتبطة بعميل — ` +
        'تم جلب خط السير واسم المندوب المرتبطين بالعميل حالياً.'
      );
    } catch (e) {
      alert(e.response?.data?.error || 'تعذّر تحديث البيانات');
    } finally {
      setRefreshing(false);
    }
  };

  const params = {};
  if (statusFilter) params.status    = statusFilter;
  if (regionFilter) params.region_id = regionFilter;

  const { data: fridges = [], isLoading } = useQuery({
    queryKey: ['fridges', params],
    queryFn:  () => api.list(params),
    staleTime: 30000,
  });

  const { data: stats } = useQuery({
    queryKey: ['fridge-stats'],
    queryFn:  api.stats,
    staleTime: 30000,
  });

  /* client-side text search */
  const filtered = search
    ? fridges.filter(f =>
        (f.asset_number    || '').toLowerCase().includes(search.toLowerCase()) ||
        (f.customer_name   || '').includes(search) ||
        (f.customer_code   || '').includes(search) ||
        (f.salesrep_name   || '').includes(search) ||
        (f.region_name     || '').includes(search)
      )
    : fridges;

  /* count per customer to show multi-fridge badge */
  const customerCounts = {};
  fridges.forEach(f => {
    if (f.customer_code) {
      customerCounts[f.customer_code] = (customerCounts[f.customer_code] || 0) + 1;
    }
  });

  /* Fridges handed to a new customer with no signed contract yet. Surfaced as
     a standing banner (not a toast) because it is a state to be cleared, not
     an event that happened once. */
  const pendingContracts = stats?.pending_contracts || [];
  const [showPendingOnly, setShowPendingOnly] = useState(false);
  const visible = showPendingOnly ? filtered.filter(f => f.pending_contract) : filtered;

  return (
    <div>
      {/* ── Transfer requests awaiting approval ── */}
      <PendingRequestsBanner />

      {/* ── Awaiting-contract notification ── */}
      {pendingContracts.length > 0 && (
        <div className="frg-pending-banner">
          <span className="frg-pending-banner__icon">⏳</span>
          <div className="frg-pending-banner__body">
            <div className="frg-pending-banner__title">
              {pendingContracts.length} ثلاجة بانتظار توقيع العقد
            </div>
            <div className="frg-pending-banner__sub">
              نُقلت لعملاء جدد دون رفع عقد موقّع. الأقدم:{' '}
              {pendingContracts.slice(0, 3).map((f, i) => (
                <span key={f.id}>
                  {i > 0 ? ' · ' : ''}
                  <bdi>{f.asset_number}</bdi> — <bdi>{f.customer_name || f.customer_code || '—'}</bdi>
                  {f.days_waiting != null && <> ({f.days_waiting} يوم)</>}
                </span>
              ))}
              {pendingContracts.length > 3 && <> … و{pendingContracts.length - 3} أخرى</>}
            </div>
          </div>
          <button
            className={`frg-btn frg-btn-sm ${showPendingOnly ? 'frg-btn-primary' : 'frg-btn-ghost'}`}
            onClick={() => setShowPendingOnly(v => !v)}
          >
            {showPendingOnly ? 'عرض الكل' : 'عرض المعلّقة فقط'}
          </button>
        </div>
      )}

      {/* ── Stats strip ── */}
      {stats && (
        <div className="frg-stats-strip">
          <div className="frg-stat-pill" style={{ background: '#f1f5f9', color: '#374151' }}>
            <span className="frg-stat-count">{stats.total ?? fridges.length}</span>
            <span className="frg-stat-label">إجمالي الثلاجات</span>
          </div>
          {STATUS_OPTS.map(s => {
            const cnt = stats[s.v] ?? (fridges.filter(f => f.status === s.v).length);
            if (!cnt) return null;
            return (
              <div
                key={s.v}
                className="frg-stat-pill"
                style={{ background: s.color + '18', border: `1px solid ${s.color}44`, color: s.color }}
              >
                <span className="frg-stat-count">{cnt}</span>
                <span className="frg-stat-label">{s.l}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="frg-toolbar">
        <input
          className="frg-input frg-search-input"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔍 بحث بالرقم أو الاسم أو المندوب..."
        />
        <FilterSelect
          value={statusFilter}
          onChange={setStatusFilter}
          placeholder="جميع الحالات"
          options={STATUS_OPTS.map(s => ({ value: s.v, label: s.l }))}
        />
        <FilterSelect
          value={regionFilter}
          onChange={setRegionFilter}
          placeholder="جميع المناطق"
          options={regions.map(r => ({ value: String(r.id), label: r.name_ar || r.name_en }))}
        />
        {admin && (
          <button
            className="frg-btn frg-btn-ghost"
            onClick={doRefreshCustomerData}
            disabled={refreshing}
            title="جلب خط السير واسم المندوب المرتبطين حالياً بعميل كل ثلاجة"
          >
            <RefreshCw size={14} /> {refreshing ? 'جارٍ التحديث…' : 'تحديث بيانات الثلاجات'}
          </button>
        )}
        {admin && (
          <button className="frg-btn frg-btn-primary" style={{ marginRight: 'auto' }} onClick={onAddClick}>
            <Plus size={14} /> إضافة ثلاجة
          </button>
        )}
      </div>

      {/* ── Table ── */}
      {isLoading ? (
        <div className="frg-loading">جارٍ التحميل…</div>
      ) : visible.length === 0 ? (
        <div className="frg-empty">
          <div className="frg-empty-icon">🧊</div>
          <div className="frg-empty-text">
            {showPendingOnly ? 'لا توجد ثلاجات بانتظار العقد ضمن الفلاتر الحالية' : 'لا توجد ثلاجات مطابقة'}
          </div>
        </div>
      ) : (
        <div className="frg-table-wrap">
          <table className="frg-table">
            <thead>
              <tr>
                <th>رقم الثلاجة</th>
                <th>العميل</th>
                <th>المنطقة</th>
                <th>الخط</th>
                <th>الحالة</th>
                <th>رقم العقد</th>
                <th>تاريخ العقد</th>
                <th title="ملفات العقد المرفوعة">ملف العقد</th>
                <th>الثلاجات/عميل</th>
                <th className="frg-note-col">ملاحظات</th>
                <th className="frg-no-print">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(f => {
                const cnt = f.customer_code ? (customerCounts[f.customer_code] || 1) : 1;
                const region = regions.find(r => String(r.id) === String(f.region_id));
                return (
                  <tr
                    key={f.id}
                    onClick={() => setDetailId(f.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <span className="frg-asset-num" dir="ltr">{f.asset_number}</span>
                      {f.pending_contract && (
                        <span className="frg-pending-chip" title="نُقلت لعميل جديد دون عقد موقّع">⏳ بانتظار العقد</span>
                      )}
                    </td>
                    <td>
                      <div className="frg-customer-cell">
                        <span>{f.customer_name || '—'}</span>
                        {f.customer_code && (
                          <span className="frg-customer-code" dir="ltr">{f.customer_code}</span>
                        )}
                      </div>
                    </td>
                    <td>{region?.name_ar || f.region_name || '—'}</td>
                    <td dir="ltr">{f.route_code ?? '—'}</td>
                    <td><StatusBadge status={f.status} /></td>
                    <td dir="ltr">{f.contract_number || '—'}</td>
                    <td>{formatDate(f.contract_date)}</td>
                    <td>
                      {f.contract_count > 0
                        ? <span className="frg-contract-badge frg-contract-badge--yes" title={`${f.contract_count} ملف مرفوع`}>
                            <Paperclip size={11} /> {f.contract_count}
                          </span>
                        : <span className="frg-contract-badge frg-contract-badge--no" title="لا يوجد ملف عقد">
                            لا يوجد
                          </span>
                      }
                    </td>
                    <td>
                      {cnt > 1
                        ? <span className="frg-multi-badge">{cnt} ثلاجات</span>
                        : <span style={{ color: '#9ca3af', fontSize: 12 }}>1</span>
                      }
                    </td>
                    <td className="frg-note-col">
                      <FridgeNoteCell
                        fridge={f}
                        canEdit={canWriteNote(user)}
                        onSaved={() => qc.invalidateQueries({ queryKey: ['fridges'] })}
                      />
                    </td>
                    <td className="frg-no-print" onClick={e => e.stopPropagation()}>
                      <button
                        className="frg-btn frg-btn-ghost frg-btn-sm"
                        onClick={() => setDetailId(f.id)}
                        title="عرض التفاصيل"
                      >
                        عرض
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {detailId && (
        <FridgeDetailModal
          fridgeId={detailId}
          regions={regions}
          onClose={() => setDetailId(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: ['fridges'] })}
        />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   MONTH NAME → ARABIC
   ══════════════════════════════════════════════════════════ */
const MONTH_AR = {
  January:'يناير', February:'فبراير', March:'مارس', April:'أبريل',
  May:'مايو', June:'يونيو', July:'يوليو', August:'أغسطس',
  September:'سبتمبر', October:'أكتوبر', November:'نوفمبر', December:'ديسمبر',
};

/* ── Target / Risk helpers ───────────────────────────────── */
const DAILY_TARGET = 40;

function getWorkingDaysMTD(year, month) {
  if (!year || !month) return 0;
  const today = new Date();
  const y = parseInt(year), m = parseInt(month);
  const isCurrentMonth = y === today.getFullYear() && m === today.getMonth() + 1;
  const endDay = isCurrentMonth
    ? today.getDate()
    : new Date(y, m, 0).getDate();          // last day of past month
  let count = 0;
  for (let d = 1; d <= endDay; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow !== 5) count++;                  // skip Fri(5) only
  }
  return count;
}

const RISK_LEVELS = [
  { min: 100, label: 'محقق',      color: '#16a34a', bg: '#dcfce7', icon: '✅', urgent: false },
  { min: 80,  label: 'جيد',       color: '#22c55e', bg: '#f0fdf4', icon: '🟢', urgent: false },
  { min: 60,  label: 'متابعة',    color: '#ca8a04', bg: '#fefce8', icon: '⚠️', urgent: false },
  { min: 40,  label: 'خطر',       color: '#f97316', bg: '#fff7ed', icon: '🔶', urgent: true  },
  { min: 1,   label: 'خطر عالي',  color: '#ef4444', bg: '#fee2e2', icon: '🔴', urgent: true  },
  { min: 0,   label: 'حرج',       color: '#991b1b', bg: '#fef2f2', icon: '🚨', urgent: true  },
];

function getRiskLevel(pct) {
  for (const r of RISK_LEVELS) {
    if (pct >= r.min) return r;
  }
  return RISK_LEVELS[RISK_LEVELS.length - 1];
}

/* ══════════════════════════════════════════════════════════
   SALES REPORT TAB
   ══════════════════════════════════════════════════════════ */
function SalesReportTab({ regions }) {
  const [yearFilter,   setYearFilter]   = useState('');
  const [monthFilter,  setMonthFilter]  = useState('');
  const [dayFilter,    setDayFilter]    = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [tradingFilter,setTradingFilter]= useState('');
  const [riskFilter,   setRiskFilter]   = useState('');
  const [search,       setSearch]       = useState('');
  const [sortCol,      setSortCol]      = useState('total_qty');
  const [sortDir,      setSortDir]      = useState('desc');

  const params = {};
  if (yearFilter)    params.year      = yearFilter;
  if (monthFilter)   params.month     = monthFilter;
  if (dayFilter)     params.day       = dayFilter;
  if (regionFilter)  params.region_id = regionFilter;
  if (tradingFilter) params.trading   = tradingFilter;
  if (search.trim()) params.search    = search.trim();

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['fridge-sales-report', params],
    queryFn:  () => api.salesReport(params),
    staleTime: 60000,
    keepPreviousData: true,
  });

  const { data: stats } = useQuery({
    queryKey: ['fridge-stats'],
    queryFn:  api.stats,
    staleTime: 60000,
  });

  const rows    = data?.rows    || [];
  const summary = data?.summary || {};
  const years   = data?.years   || [];
  const months  = data?.months  || [];
  const days    = data?.days    || [];

  /* ── Fridge KPIs from stats ── */
  const byStatus = stats?.by_status || [];
  const kpiCount = (statuses) =>
    byStatus
      .filter(s => statuses.includes(s.status))
      .reduce((sum, s) => sum + parseInt(s.cnt || 0), 0);

  const kpiActive      = kpiCount(['active']);
  const kpiInactive    = kpiCount(['inactive']);
  const kpiWarehouse   = kpiCount(['warehouse_new', 'warehouse_used', 'warehouse_maintenance']);
  const kpiMaintenance = kpiCount(['out_of_service', 'damaged']);
  const kpiTotal       = (stats?.total) || 0;

  /* ── Per-region breakdown ── */
  const byRegionStatus = stats?.by_region_status || [];
  const rCount = (byStatus, statuses) =>
    statuses.reduce((s, k) => s + (byStatus[k] || 0), 0);

  /* ── Target / Achievement ── */
  const workingDays  = getWorkingDaysMTD(yearFilter, monthFilter);
  const hasTarget    = !!(yearFilter && monthFilter && workingDays > 0);

  const enrichedRows = rows.map(r => {
    // Only active fridges contribute to the daily target
    const activeFridges = r.active_fridge_count ?? 0;
    const target      = (hasTarget && activeFridges > 0) ? DAILY_TARGET * workingDays * activeFridges : 0;
    const achieve_pct = target > 0 ? Math.round((r.total_qty / target) * 100) : 0;
    return { ...r, target, achieve_pct };
  });

  const overallTgt   = hasTarget ? enrichedRows.reduce((s, r) => s + r.target,     0) : 0;
  const overallQty   = enrichedRows.reduce((s, r) => s + r.total_qty, 0);
  const overallAch   = overallTgt > 0 ? Math.round(overallQty / overallTgt * 100) : 0;
  const urgentCount  = hasTarget ? enrichedRows.filter(r => getRiskLevel(r.achieve_pct).urgent).length : 0;

  /* ── Risk filter (client-side) ── */
  const riskFiltered = (hasTarget && riskFilter)
    ? enrichedRows.filter(r => {
        const risk = getRiskLevel(r.achieve_pct);
        if (riskFilter === 'urgent')   return risk.urgent;
        if (riskFilter === 'safe')     return ['محقق','جيد'].includes(risk.label);
        if (riskFilter === 'atrisk')   return !['محقق','جيد'].includes(risk.label);
        return risk.label === riskFilter;
      })
    : enrichedRows;

  /* ── Sort ── */
  const sorted = [...riskFiltered].sort((a, b) => {
    const av = a[sortCol] ?? 0;
    const bv = b[sortCol] ?? 0;
    if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const SortIcon = ({ col }) => {
    if (sortCol !== col) return <ArrowUpDown size={12} className="frg-sort-icon frg-sort-none" />;
    return sortDir === 'asc'
      ? <ArrowUp   size={12} className="frg-sort-icon frg-sort-active" />
      : <ArrowDown size={12} className="frg-sort-icon frg-sort-active" />;
  };

  /* ── Export CSV ── */
  const exportCSV = () => {
    const header = [
      'رقم العميل','اسم العميل','المنطقة','المندوب',
      'عدد الثلاجات','أرقام الثلاجات','رقم العقد',
      'إجمالي الكميات','عدد الفواتير','صافي المرتجعات',
      ...(hasTarget ? ['الهدف MTD','التحقيق %','الإنذار'] : []),
      'آخر نشاط','الحالة',
    ];
    const csvRows = sorted.map(r => {
      const risk = hasTarget ? getRiskLevel(r.achieve_pct) : null;
      return [
        r.customer_code,
        r.customer_name   || '',
        r.region_name     || '',
        r.salesrep_name   || '',
        r.fridge_count,
        `"${r.asset_numbers || ''}"`,
        `"${r.contract_numbers || ''}"`,
        r.total_qty,
        r.invoice_count,
        r.total_bad_return_qty || 0,
        ...(hasTarget ? [r.target, `${r.achieve_pct}%`, risk.label] : []),
        r.last_active_ym
          ? `${r.last_year}/${String(r.last_active_ym).slice(-2)}${r.last_day ? `/${r.last_day}` : ''}`
          : '—',
        r.total_qty > 0 ? 'متعاملة' : 'غير متعاملة',
      ];
    });
    const bom = '﻿';
    const csv = bom + [header, ...csvRows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url;
    a.download = `تقرير_مبيعات_الثلاجات_${yearFilter || 'كل_السنوات'}${monthFilter ? `_${monthFilter}` : ''}${dayFilter ? `_يوم${dayFilter}` : ''}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="frg-sr-wrap">

      {/* ── Fridge Status KPIs ── */}
      <div className="frg-kpi-strip">
        <div className="frg-kpi-card frg-kpi-total">
          <div className="frg-kpi-icon">🧊</div>
          <div className="frg-kpi-body">
            <div className="frg-kpi-num">{kpiTotal.toLocaleString('ar-SA-u-nu-latn')}</div>
            <div className="frg-kpi-lbl">إجمالي الثلاجات</div>
          </div>
        </div>
        <div className="frg-kpi-card frg-kpi-active">
          <div className="frg-kpi-icon">✅</div>
          <div className="frg-kpi-body">
            <div className="frg-kpi-num">{kpiActive.toLocaleString('ar-SA-u-nu-latn')}</div>
            <div className="frg-kpi-lbl">نشطة</div>
          </div>
        </div>
        <div className="frg-kpi-card frg-kpi-inactive">
          <div className="frg-kpi-icon">⛔</div>
          <div className="frg-kpi-body">
            <div className="frg-kpi-num">{kpiInactive.toLocaleString('ar-SA-u-nu-latn')}</div>
            <div className="frg-kpi-lbl">غير نشطة</div>
          </div>
        </div>
        <div className="frg-kpi-card frg-kpi-warehouse">
          <div className="frg-kpi-icon">📦</div>
          <div className="frg-kpi-body">
            <div className="frg-kpi-num">{kpiWarehouse.toLocaleString('ar-SA-u-nu-latn')}</div>
            <div className="frg-kpi-lbl">بالمستودع</div>
          </div>
        </div>
        <div className="frg-kpi-card frg-kpi-maintenance">
          <div className="frg-kpi-icon">🔧</div>
          <div className="frg-kpi-body">
            <div className="frg-kpi-num">{kpiMaintenance.toLocaleString('ar-SA-u-nu-latn')}</div>
            <div className="frg-kpi-lbl">صيانة / خارج الخدمة</div>
          </div>
        </div>
      </div>

      {/* ── Per-region cards ── */}
      {byRegionStatus.length > 0 && (
        <div className="frg-region-grid">
          {byRegionStatus.map(reg => {
            const active      = rCount(reg.by_status, ['active']);
            const inactive    = rCount(reg.by_status, ['inactive']);
            const warehouse   = rCount(reg.by_status, ['warehouse_new','warehouse_used','warehouse_maintenance']);
            const maintenance = rCount(reg.by_status, ['out_of_service','damaged']);
            const pct = reg.total > 0 ? Math.round((active / reg.total) * 100) : 0;
            const isActive = String(regionFilter) === String(reg.region_id);
            return (
              <div
                key={reg.region_name}
                className={`frg-rc${isActive ? ' frg-rc--active' : ''}`}
                role="button"
                tabIndex={0}
                title={isActive ? 'اضغط لإلغاء تصفية المنطقة' : `اضغط لعرض ${reg.region_name} فقط`}
                onClick={() => setRegionFilter(isActive ? '' : String(reg.region_id))}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRegionFilter(isActive ? '' : String(reg.region_id)); } }}
              >
                <div className="frg-rc-header">
                  <span className="frg-rc-name">{reg.region_name}</span>
                  <span className="frg-rc-total">{reg.total} ثلاجة</span>
                </div>
                <div className="frg-rc-bar">
                  <div className="frg-rc-bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="frg-rc-rows">
                  <div className="frg-rc-row frg-rc-active">
                    <span className="frg-rc-dot" />
                    <span className="frg-rc-rlbl">نشطة</span>
                    <span className="frg-rc-rnum">{active}</span>
                  </div>
                  <div className="frg-rc-row frg-rc-inactive">
                    <span className="frg-rc-dot" />
                    <span className="frg-rc-rlbl">غير نشطة</span>
                    <span className="frg-rc-rnum">{inactive}</span>
                  </div>
                  <div className="frg-rc-row frg-rc-warehouse">
                    <span className="frg-rc-dot" />
                    <span className="frg-rc-rlbl">بالمستودع</span>
                    <span className="frg-rc-rnum">{warehouse}</span>
                  </div>
                  <div className="frg-rc-row frg-rc-maint">
                    <span className="frg-rc-dot" />
                    <span className="frg-rc-rlbl">صيانة</span>
                    <span className="frg-rc-rnum">{maintenance}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Filter bar ── */}
      <div className="frg-sr-filters">

        {/* Year */}
        <FilterSelect
          value={yearFilter}
          onChange={v => { setYearFilter(v); setMonthFilter(''); }}
          placeholder="كل السنوات"
          options={years.map(y => ({ value: String(y), label: String(y) }))}
        />

        {/* Month — only active when year is selected */}
        <FilterSelect
          value={monthFilter}
          onChange={v => { setMonthFilter(v); setDayFilter(''); }}
          placeholder="كل الأشهر"
          options={
            yearFilter
              ? months.map(m => ({ value: String(m.month_num), label: MONTH_AR[m.month_name] || m.month_name }))
              : []
          }
        />

        {/* Day — only active when year+month selected AND days exist */}
        {yearFilter && monthFilter && days.length > 0 && (
          <FilterSelect
            value={dayFilter}
            onChange={setDayFilter}
            placeholder="كل الأيام"
            options={days.map(d => ({ value: String(d), label: `يوم ${d}` }))}
          />
        )}

        {/* Region */}
        <FilterSelect
          value={regionFilter}
          onChange={setRegionFilter}
          placeholder="جميع المناطق"
          options={regions.map(r => ({ value: String(r.id), label: r.name_ar || r.name_en }))}
        />

        {/* Trading status */}
        <FilterSelect
          value={tradingFilter}
          onChange={setTradingFilter}
          placeholder="جميع العملاء"
          options={[
            { value: 'active',   label: '✅ متعاملة' },
            { value: 'inactive', label: '⛔ غير متعاملة' },
          ]}
        />

        {/* Risk filter — only when target is active */}
        {hasTarget && (
          <FilterSelect
            value={riskFilter}
            onChange={setRiskFilter}
            placeholder="كل الإنذارات"
            options={[
              { value: 'urgent',  label: '🚨 تحتاج أكشن فوري' },
              { value: 'safe',    label: '✅ محقق وجيد'         },
              ...RISK_LEVELS.map(r => ({ value: r.label, label: `${r.icon} ${r.label}` })),
            ]}
          />
        )}

        {/* Search */}
        <input
          className="frg-input frg-sr-search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔍 بحث بالاسم أو الكود..."
        />

        {/* Export */}
        <button className="frg-btn frg-btn-ghost frg-btn-sm frg-sr-export" onClick={exportCSV} disabled={!rows.length}>
          <Upload size={13} /> تصدير CSV
        </button>

        {isFetching && <RefreshCw size={14} className="frg-spin" style={{ color: '#3b82f6', marginRight: 4 }} />}
      </div>

      {/* ── Summary strip ── */}
      {data && (
        <div className="frg-sr-summary">
          <div className="frg-sr-pill" style={{ background: '#f1f5f9', color: '#374151' }}>
            <span className="frg-sr-pill-num">{summary.total_customers ?? 0}</span>
            <span className="frg-sr-pill-lbl">إجمالي العملاء</span>
          </div>
          <div className="frg-sr-pill" style={{ background: '#d1fae5', color: '#065f46', border: '1px solid #6ee7b7' }}>
            <span className="frg-sr-pill-num">{summary.active_customers ?? 0}</span>
            <span className="frg-sr-pill-lbl">✅ متعاملة</span>
          </div>
          <div className="frg-sr-pill" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5' }}>
            <span className="frg-sr-pill-num">{summary.inactive_customers ?? 0}</span>
            <span className="frg-sr-pill-lbl">⛔ غير متعاملة</span>
          </div>
          <div className="frg-sr-pill" style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
            <span className="frg-sr-pill-num">{(summary.total_qty ?? 0).toLocaleString('ar-SA-u-nu-latn')}</span>
            <span className="frg-sr-pill-lbl">إجمالي الكميات</span>
          </div>
        </div>
      )}

      {/* ── Target Info Bar ── */}
      {hasTarget && (
        <div className="frg-target-bar">
          <div className="frg-tbar-item">
            <span className="frg-tbar-icon">📅</span>
            <div className="frg-tbar-body">
              <span className="frg-tbar-lbl">أيام العمل MTD</span>
              <span className="frg-tbar-val">{workingDays} يوم</span>
            </div>
          </div>
          <div className="frg-tbar-item">
            <span className="frg-tbar-icon">🎯</span>
            <div className="frg-tbar-body">
              <span className="frg-tbar-lbl">الهدف الكلي</span>
              <span className="frg-tbar-val">{overallTgt.toLocaleString('ar-SA-u-nu-latn')} وحدة</span>
            </div>
          </div>
          <div className="frg-tbar-item" style={{ color: getRiskLevel(overallAch).color }}>
            <span className="frg-tbar-icon">📊</span>
            <div className="frg-tbar-body">
              <span className="frg-tbar-lbl">نسبة التحقيق الكلية</span>
              <span className="frg-tbar-val frg-tbar-pct">{overallAch}%</span>
            </div>
          </div>
          <div className="frg-tbar-item">
            <span className="frg-tbar-icon">⚙️</span>
            <div className="frg-tbar-body">
              <span className="frg-tbar-lbl">الهدف اليومي / ثلاجة</span>
              <span className="frg-tbar-val">{DAILY_TARGET} وحدة</span>
            </div>
          </div>
          {urgentCount > 0 && (
            <div className="frg-tbar-item frg-tbar-urgent">
              <span className="frg-tbar-icon">🚨</span>
              <div className="frg-tbar-body">
                <span className="frg-tbar-lbl">تحتاج أكشن فوري</span>
                <span className="frg-tbar-val">{urgentCount} عميل</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Table ── */}
      {isLoading ? (
        <div className="frg-loading">جارٍ التحميل…</div>
      ) : sorted.length === 0 ? (
        <div className="frg-empty">
          <div className="frg-empty-icon">📊</div>
          <div className="frg-empty-text">لا توجد بيانات مطابقة</div>
        </div>
      ) : (
        <div className="frg-table-wrap">
          <table className="frg-table frg-sr-table">
            <thead>
              <tr>
                <th>#</th>
                <th onClick={() => toggleSort('customer_code')} className={`frg-th-sort${sortCol==='customer_code'?' frg-th-sort-active':''}`}>
                  رقم العميل <SortIcon col="customer_code" />
                </th>
                <th onClick={() => toggleSort('customer_name')} className={`frg-th-sort${sortCol==='customer_name'?' frg-th-sort-active':''}`}>
                  اسم العميل <SortIcon col="customer_name" />
                </th>
                <th onClick={() => toggleSort('region_name')} className={`frg-th-sort${sortCol==='region_name'?' frg-th-sort-active':''}`}>
                  المنطقة <SortIcon col="region_name" />
                </th>
                <th onClick={() => toggleSort('salesrep_name')} className={`frg-th-sort${sortCol==='salesrep_name'?' frg-th-sort-active':''}`}>
                  المندوب <SortIcon col="salesrep_name" />
                </th>
                <th onClick={() => toggleSort('fridge_count')} className={`frg-th-sort frg-th-num${sortCol==='fridge_count'?' frg-th-sort-active':''}`}>
                  ثلاجات <SortIcon col="fridge_count" />
                </th>
                <th>أرقام الثلاجات</th>
                <th>رقم العقد</th>
                <th onClick={() => toggleSort('invoice_count')} className={`frg-th-sort frg-th-num${sortCol==='invoice_count'?' frg-th-sort-active':''}`}>
                  فواتير <SortIcon col="invoice_count" />
                </th>
                <th onClick={() => toggleSort('total_qty')} className={`frg-th-sort frg-th-num${sortCol==='total_qty'?' frg-th-sort-active':''}`}>
                  الكمية <SortIcon col="total_qty" />
                </th>
                <th onClick={() => toggleSort('total_bad_return_qty')} className={`frg-th-sort frg-th-num${sortCol==='total_bad_return_qty'?' frg-th-sort-active':''}`}>
                  المرتجعات <SortIcon col="total_bad_return_qty" />
                </th>
                {hasTarget && (<>
                  <th onClick={() => toggleSort('target')} className={`frg-th-sort frg-th-num${sortCol==='target'?' frg-th-sort-active':''}`}>
                    الهدف <SortIcon col="target" />
                  </th>
                  <th onClick={() => toggleSort('achieve_pct')} className={`frg-th-sort frg-th-num${sortCol==='achieve_pct'?' frg-th-sort-active':''}`}>
                    التحقيق % <SortIcon col="achieve_pct" />
                  </th>
                  <th>الإنذار</th>
                </>)}
                <th onClick={() => toggleSort('last_active_ym')} className={`frg-th-sort${sortCol==='last_active_ym'?' frg-th-sort-active':''}`}>
                  آخر نشاط <SortIcon col="last_active_ym" />
                </th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, idx) => {
                const active = r.total_qty > 0;   // ≤ 0 (incl. negative returns) = inactive
                const risk   = hasTarget ? getRiskLevel(r.achieve_pct) : null;
                const lastActivity = r.last_active_ym
                  ? [
                      r.last_day ? `${r.last_day}` : null,
                      MONTH_AR[r.last_month_name] || r.last_month_name || '',
                      r.last_year || '',
                    ].filter(Boolean).join(' ')
                  : '—';
                return (
                  <tr key={r.customer_code} className={active ? '' : 'frg-sr-row-inactive'}>
                    <td className="frg-sr-idx">{idx + 1}</td>
                    <td dir="ltr" className="frg-asset-num">{r.customer_code}</td>
                    <td>
                      <div className="frg-customer-cell">
                        <span>{r.customer_name || '—'}</span>
                      </div>
                    </td>
                    <td>{r.region_name || '—'}</td>
                    <td>{r.salesrep_name || '—'}</td>
                    <td className="frg-td-num">
                      {r.fridge_count > 1
                        ? <span className="frg-multi-badge">{r.fridge_count}</span>
                        : <span>{r.fridge_count}</span>
                      }
                    </td>
                    <td className="frg-td-assets" dir="ltr" title={r.asset_numbers || ''}>
                      {r.asset_numbers || '—'}
                    </td>
                    <td className="frg-td-assets" dir="ltr" title={r.contract_numbers || ''}>
                      {r.contract_numbers || '—'}
                    </td>
                    <td className="frg-td-num">{r.invoice_count > 0 ? r.invoice_count.toLocaleString('ar-SA-u-nu-latn') : '—'}</td>
                    <td className="frg-td-num frg-td-qty">
                      {active ? r.total_qty.toLocaleString('ar-SA-u-nu-latn') : '—'}
                    </td>
                    <td className="frg-td-num frg-td-return">
                      {r.total_bad_return_qty > 0
                        ? <span className="frg-return-badge">{r.total_bad_return_qty.toLocaleString('ar-SA-u-nu-latn')}</span>
                        : <span className="frg-td-dash">—</span>
                      }
                    </td>
                    {hasTarget && (<>
                      <td className="frg-td-num frg-td-target">
                        {r.target > 0
                          ? r.target.toLocaleString('ar-SA-u-nu-latn')
                          : <span className="frg-no-target">بدون هدف</span>}
                      </td>
                      <td className="frg-td-achieve">
                        {r.target > 0 ? (
                          <div className="frg-achieve">
                            <div className="frg-achieve-bar">
                              <div
                                className="frg-achieve-fill"
                                style={{ width: `${Math.min(r.achieve_pct, 100)}%`, background: risk.color }}
                              />
                            </div>
                            <span className="frg-achieve-pct" style={{ color: risk.color }}>
                              {r.achieve_pct}%
                            </span>
                          </div>
                        ) : <span className="frg-no-target">—</span>}
                      </td>
                      <td>
                        {r.target > 0 ? (
                          <span
                            className="frg-risk-badge"
                            style={{ background: risk.bg, color: risk.color, border: `1px solid ${risk.color}44` }}
                            title={risk.urgent ? 'يحتاج أكشن فوري' : 'ضمن النطاق الآمن'}
                          >
                            {risk.icon} {risk.label}
                          </span>
                        ) : <span className="frg-no-target">بدون هدف</span>}
                      </td>
                    </>)}
                    <td className="frg-td-last">{lastActivity}</td>
                    <td>
                      {active
                        ? <span className="frg-trading-badge frg-trading-active">✅ متعاملة</span>
                        : <span className="frg-trading-badge frg-trading-inactive">⛔ غير متعاملة</span>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   IMPORT FROM EXCEL TAB
   ══════════════════════════════════════════════════════════ */
function ImportFridgesTab() {
  const qc       = useQueryClient();
  const fileRef  = useRef(null);
  const [file,   setFile]   = useState(null);
  const [busy,   setBusy]   = useState(false);
  const [result, setResult] = useState(null);   // import result from server
  const [err,    setErr]    = useState('');

  const handleFileChange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setResult(null);
    setErr('');
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    setFile(f);
    setResult(null);
    setErr('');
  };

  const doImport = async () => {
    if (!file) return;
    setBusy(true);
    setErr('');
    setResult(null);
    try {
      const res = await api.importXlsx(file);
      setResult(res);
      if (res.inserted > 0) {
        qc.invalidateQueries({ queryKey: ['fridges'] });
        qc.invalidateQueries({ queryKey: ['fridge-stats'] });
      }
    } catch (e) {
      setErr(e.response?.data?.error || 'حدث خطأ أثناء الاستيراد');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFile(null);
    setResult(null);
    setErr('');
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="frg-import-wrap">
      {/* ── Instructions ── */}
      <div className="frg-import-instructions">
        <div className="frg-import-instructions-title">📋 تعليمات الاستيراد</div>
        <ul className="frg-import-instructions-list">
          <li>يجب أن يكون الملف بصيغة <strong>Excel (.xlsx / .xls)</strong></li>
          <li>الصف الأول يجب أن يحتوي على <strong>أسماء الأعمدة</strong></li>
          <li>
            الأعمدة المدعومة (يمكن استخدام الأسماء بالعربية أو الإنجليزية):
            <div className="frg-col-chips">
              {[
                ['رقم الثلاجة','asset_number','*مطلوب'],
                ['رقم العميل','customer_code','اختياري'],
                ['اسم العميل','customer_name','اختياري'],
                ['المنطقة','region_name','اختياري'],
                ['رقم الخط','route_code','اختياري'],
                ['اسم المندوب','salesrep_name','اختياري'],
                ['رقم العقد','contract_number','اختياري'],
                ['تاريخ العقد','contract_date','اختياري'],
                ['الحالة','status','اختياري'],
                ['ملاحظات','notes','اختياري'],
              ].map(([ar, en, req]) => (
                <span key={en} className={`frg-col-chip ${req === '*مطلوب' ? 'required' : ''}`}>
                  {ar} <small>({en})</small>
                  {req === '*مطلوب' && <span className="frg-req"> *</span>}
                </span>
              ))}
            </div>
          </li>
          <li>إذا كان <strong>رقم العميل</strong> موجوداً في النظام، سيتم استكمال باقي بياناته تلقائياً</li>
          <li>الثلاجات المكررة (نفس رقم الثلاجة) ستُتجاهل تلقائياً</li>
        </ul>
      </div>

      {/* ── Drop zone ── */}
      {!result && (
        <div
          className={`frg-dropzone ${file ? 'has-file' : ''}`}
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => !file && fileRef.current?.click()}
        >
          {file ? (
            <div className="frg-dropzone-file">
              <FileText size={32} color="#10b981" />
              <div className="frg-dropzone-filename">{file.name}</div>
              <div className="frg-dropzone-filesize">
                {(file.size / 1024).toFixed(1)} KB
              </div>
              <button className="frg-btn frg-btn-ghost frg-btn-sm" onClick={e => { e.stopPropagation(); reset(); }}>
                <X size={12} /> إلغاء
              </button>
            </div>
          ) : (
            <div className="frg-dropzone-idle">
              <Upload size={36} className="frg-dropzone-icon" />
              <div className="frg-dropzone-text">اسحب ملف Excel هنا</div>
              <div className="frg-dropzone-subtext">أو انقر للاختيار من الجهاز</div>
              <div className="frg-dropzone-hint">.xlsx , .xls</div>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
        </div>
      )}

      {/* ── Error ── */}
      {err && <div className="frg-alert frg-alert-error">{err}</div>}

      {/* ── Action ── */}
      {file && !result && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 16 }}>
          <button className="frg-btn frg-btn-ghost" onClick={reset} disabled={busy}>إلغاء</button>
          <button className="frg-btn frg-btn-primary" onClick={doImport} disabled={busy} style={{ minWidth: 160 }}>
            {busy
              ? <><RefreshCw size={14} className="frg-spin" /> جارٍ الاستيراد…</>
              : <><Upload size={14} /> بدء الاستيراد</>
            }
          </button>
        </div>
      )}

      {/* ── Results ── */}
      {result && (
        <div className="frg-import-result">
          <div className="frg-import-result-title">📊 نتيجة الاستيراد</div>

          {/* Summary pills */}
          <div className="frg-import-summary">
            <div className="frg-import-pill total">
              <span className="frg-import-pill-num">{result.total}</span>
              <span className="frg-import-pill-lbl">إجمالي الصفوف</span>
            </div>
            <div className="frg-import-pill success">
              <CheckCircle size={16} />
              <span className="frg-import-pill-num">{result.inserted}</span>
              <span className="frg-import-pill-lbl">تمّت إضافتها</span>
            </div>
            <div className="frg-import-pill skip">
              <span className="frg-import-pill-num">{result.skipped}</span>
              <span className="frg-import-pill-lbl">مكررة / تجاهل</span>
            </div>
            {result.errors > 0 && (
              <div className="frg-import-pill error">
                <AlertCircle size={16} />
                <span className="frg-import-pill-num">{result.errors}</span>
                <span className="frg-import-pill-lbl">أخطاء</span>
              </div>
            )}
          </div>

          {/* Skipped list */}
          {result.skipped_list?.length > 0 && (
            <details className="frg-import-details">
              <summary>
                ⏭ الثلاجات المتجاهلة (مكررة) — {result.skipped_list.length}
              </summary>
              <div className="frg-import-list">
                {result.skipped_list.map((s, i) => (
                  <div key={i} className="frg-import-list-item skip-item">
                    <span dir="ltr">{s.asset_number}</span>
                    <span className="frg-import-list-reason">{s.reason}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Error list */}
          {result.error_list?.length > 0 && (
            <details className="frg-import-details" open>
              <summary>
                ❌ الأخطاء — {result.error_list.length}
              </summary>
              <div className="frg-import-list">
                {result.error_list.map((e, i) => (
                  <div key={i} className="frg-import-list-item error-item">
                    <span>صف {e.row}</span>
                    <span className="frg-import-list-reason">{e.error}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
            <button className="frg-btn frg-btn-primary" onClick={reset}>
              ↩ استيراد ملف آخر
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════ */
const TAB_LABELS = {
  list:   'قائمة الثلاجات',
  report: 'تقرير المبيعات',
  add:    'إضافة ثلاجة',
  import: 'استيراد Excel',
};

export default function FridgesPage() {
  const { user }   = useAuth();
  const admin      = isAdmin(user);
  const [tab, setTab] = useState('list'); // 'list' | 'report' | 'add' | 'import'

  const { data: regions = [] } = useQuery({
    queryKey: ['fridge-regions'],
    queryFn:  api.regions,
  });

  const handlePrint = useCallback(() => {
    const prev = document.title;
    document.title = `متابعة الثلاجات — ${TAB_LABELS[tab]} — ${new Date().toLocaleDateString('ar-SA-u-nu-latn', { year:'numeric', month:'long', day:'numeric' })}`;
    window.print();
    window.onafterprint = () => { document.title = prev; window.onafterprint = null; };
  }, [tab]);

  const printDate = new Date().toLocaleDateString('ar-SA-u-nu-latn', { year:'numeric', month:'long', day:'numeric', weekday:'long' });

  return (
    <div className="frg-page">

      {/* ── Print-only header (hidden on screen) ── */}
      <div className="frg-print-header">
        <div className="frg-print-logo">🧊</div>
        <div className="frg-print-title">متابعة الثلاجات — {TAB_LABELS[tab]}</div>
        <div className="frg-print-date">تاريخ التصدير: {printDate}</div>
      </div>

      <div className="frg-header">
        <h1 className="frg-title">🧊 متابعة الثلاجات</h1>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div className="frg-tabs">
            <button
              className={`frg-tab${tab === 'list' ? ' active' : ''}`}
              onClick={() => setTab('list')}
            >
              🧊 قائمة الثلاجات
            </button>
            <button
              className={`frg-tab${tab === 'report' ? ' active' : ''}`}
              onClick={() => setTab('report')}
            >
              📊 تقرير المبيعات
            </button>
            {admin && (
              <button
                className={`frg-tab${tab === 'add' ? ' active' : ''}`}
                onClick={() => setTab('add')}
              >
                + إضافة ثلاجة
              </button>
            )}
            {admin && (
              <button
                className={`frg-tab${tab === 'import' ? ' active' : ''}`}
                onClick={() => setTab('import')}
              >
                <Upload size={13} style={{ marginLeft: 4 }} />
                استيراد Excel
              </button>
            )}
          </div>
          <button className="frg-btn frg-btn-ghost frg-btn-sm frg-no-print" onClick={handlePrint} title="تصدير PDF / طباعة">
            <Printer size={14} /> PDF
          </button>
        </div>
      </div>

      {tab === 'list' && (
        <FridgesList
          regions={regions}
          onAddClick={() => setTab('add')}
        />
      )}
      {tab === 'report' && (
        <SalesReportTab regions={regions} />
      )}
      {tab === 'add' && (
        <AddFridgeForm
          regions={regions}
          onSaved={() => setTab('list')}
          onCancel={() => setTab('list')}
        />
      )}
      {tab === 'import' && (
        <ImportFridgesTab />
      )}
    </div>
  );
}
