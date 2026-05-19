import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Pencil, Trash2, Search, RefreshCw, Plus, Upload, FileText, CheckCircle, AlertCircle, ChevronDown, ArrowUp, ArrowDown, ArrowUpDown, Printer } from 'lucide-react';
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
const FRIDGE_EDIT_ROLES = ['super_admin', 'it_admin'];
function isAdmin(user) { return FRIDGE_EDIT_ROLES.includes(user?.role); }

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ar-SA', { year: 'numeric', month: 'short', day: 'numeric' });
}
function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('ar-SA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  regions:     ()  => client.get('/sales-tasks/regions').then(r => r.data.regions),
  salesReport: (p) => client.get('/fridges/sales-report', { params: p }).then(r => r.data),
  importXlsx: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return client.post('/fridges/import', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data);
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

  const lookup = useCallback(async (overrideCode) => {
    const c = (overrideCode ?? code).trim();
    if (!c) return;
    setLoading(true);
    setWarn('');
    try {
      const data = await api.lookup(c);
      onFill(data);
    } catch {
      setWarn('لم يُعثر على العميل — يمكنك إدخال البيانات يدوياً');
    } finally {
      setLoading(false);
    }
  }, [code, onFill]);

  return { code, setCode, loading, warn, setWarn, lookup };
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
   FRIDGE DETAIL MODAL
   ══════════════════════════════════════════════════════════ */
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
  const [repairNotes, setRepairNotes] = useState('');
  const [repairBusy, setRepairBusy]   = useState(false);
  const [repairErr, setRepairErr]     = useState('');

  /* reassign form */
  const [newCode, setNewCode]         = useState('');
  const [newName, setNewName]         = useState('');
  const [reassignNotes, setReassignNotes] = useState('');
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
      await api.transfer(fridgeId, { transfer_type: 'repair', notes: repairNotes });
      invalidate();
      setPanel(null);
      setRepairNotes('');
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
      });
      invalidate();
      setPanel(null);
      setNewCode(''); setNewName(''); setReassignNotes('');
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
            <StatusBadge status={fridge.status} />
            <button className="frg-modal-close" onClick={onClose} title="إغلاق">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ── Modal Body ── */}
        <div className="frg-modal-body">

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

              {/* ── Action Buttons ── */}
              <div className="frg-detail-actions">
                <button className="frg-btn frg-btn-ghost frg-btn-sm" onClick={() => setPanel('edit')}>
                  <Pencil size={13} /> تعديل
                </button>
                <button
                  className="frg-btn frg-btn-sm"
                  style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}
                  onClick={() => { setPanel('repair'); setRepairErr(''); setRepairNotes(''); }}
                >
                  🔧 سحب للإصلاح
                </button>
                <button
                  className="frg-btn frg-btn-sm"
                  style={{ background: '#ede9fe', color: '#5b21b6', border: '1px solid #c4b5fd' }}
                  onClick={() => { setPanel('reassign'); setReassignErr(''); setLookupWarn(''); setNewCode(''); setNewName(''); setReassignNotes(''); }}
                >
                  🔄 نقل لعميل جديد
                </button>
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
                    <label className="frg-label">ملاحظات الإصلاح</label>
                    <textarea
                      className="frg-textarea"
                      value={repairNotes}
                      onChange={e => setRepairNotes(e.target.value)}
                      placeholder="سبب السحب للإصلاح..."
                      rows={3}
                    />
                  </div>
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
                          </div>
                          <div className="frg-history-meta">
                            {h.from_customer_name && h.to_customer_name && (
                              <span>{h.from_customer_name} ← {h.to_customer_name}</span>
                            )}
                            {h.from_customer_name && !h.to_customer_name && (
                              <span>من: {h.from_customer_name}</span>
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

  return (
    <div>
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
          <button className="frg-btn frg-btn-primary" style={{ marginRight: 'auto' }} onClick={onAddClick}>
            <Plus size={14} /> إضافة ثلاجة
          </button>
        )}
      </div>

      {/* ── Table ── */}
      {isLoading ? (
        <div className="frg-loading">جارٍ التحميل…</div>
      ) : filtered.length === 0 ? (
        <div className="frg-empty">
          <div className="frg-empty-icon">🧊</div>
          <div className="frg-empty-text">لا توجد ثلاجات مطابقة</div>
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
                <th>تاريخ العقد</th>
                <th>الثلاجات/عميل</th>
                <th className="frg-no-print">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(f => {
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
                    <td>{formatDate(f.contract_date)}</td>
                    <td>
                      {cnt > 1
                        ? <span className="frg-multi-badge">{cnt} ثلاجات</span>
                        : <span style={{ color: '#9ca3af', fontSize: 12 }}>1</span>
                      }
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
      'عدد الثلاجات','أرقام الثلاجات',
      'إجمالي الكميات','عدد الفواتير',
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
        r.total_qty,
        r.invoice_count,
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
            <div className="frg-kpi-num">{kpiTotal.toLocaleString('ar-SA')}</div>
            <div className="frg-kpi-lbl">إجمالي الثلاجات</div>
          </div>
        </div>
        <div className="frg-kpi-card frg-kpi-active">
          <div className="frg-kpi-icon">✅</div>
          <div className="frg-kpi-body">
            <div className="frg-kpi-num">{kpiActive.toLocaleString('ar-SA')}</div>
            <div className="frg-kpi-lbl">نشطة</div>
          </div>
        </div>
        <div className="frg-kpi-card frg-kpi-inactive">
          <div className="frg-kpi-icon">⛔</div>
          <div className="frg-kpi-body">
            <div className="frg-kpi-num">{kpiInactive.toLocaleString('ar-SA')}</div>
            <div className="frg-kpi-lbl">غير نشطة</div>
          </div>
        </div>
        <div className="frg-kpi-card frg-kpi-warehouse">
          <div className="frg-kpi-icon">📦</div>
          <div className="frg-kpi-body">
            <div className="frg-kpi-num">{kpiWarehouse.toLocaleString('ar-SA')}</div>
            <div className="frg-kpi-lbl">بالمستودع</div>
          </div>
        </div>
        <div className="frg-kpi-card frg-kpi-maintenance">
          <div className="frg-kpi-icon">🔧</div>
          <div className="frg-kpi-body">
            <div className="frg-kpi-num">{kpiMaintenance.toLocaleString('ar-SA')}</div>
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
            return (
              <div key={reg.region_name} className="frg-rc">
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
            <span className="frg-sr-pill-num">{(summary.total_qty ?? 0).toLocaleString('ar-SA')}</span>
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
              <span className="frg-tbar-val">{overallTgt.toLocaleString('ar-SA')} وحدة</span>
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
                <th onClick={() => toggleSort('invoice_count')} className={`frg-th-sort frg-th-num${sortCol==='invoice_count'?' frg-th-sort-active':''}`}>
                  فواتير <SortIcon col="invoice_count" />
                </th>
                <th onClick={() => toggleSort('total_qty')} className={`frg-th-sort frg-th-num${sortCol==='total_qty'?' frg-th-sort-active':''}`}>
                  الكمية <SortIcon col="total_qty" />
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
                    <td className="frg-td-num">{r.invoice_count > 0 ? r.invoice_count.toLocaleString('ar-SA') : '—'}</td>
                    <td className="frg-td-num frg-td-qty">
                      {active ? r.total_qty.toLocaleString('ar-SA') : '—'}
                    </td>
                    {hasTarget && (<>
                      <td className="frg-td-num frg-td-target">
                        {r.target > 0
                          ? r.target.toLocaleString('ar-SA')
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
    document.title = `متابعة الثلاجات — ${TAB_LABELS[tab]} — ${new Date().toLocaleDateString('ar-SA', { year:'numeric', month:'long', day:'numeric' })}`;
    window.print();
    window.onafterprint = () => { document.title = prev; window.onafterprint = null; };
  }, [tab]);

  const printDate = new Date().toLocaleDateString('ar-SA', { year:'numeric', month:'long', day:'numeric', weekday:'long' });

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
