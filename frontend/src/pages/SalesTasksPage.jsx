import React, { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X, Paperclip, MessageSquare, ChevronDown, Pencil, Trash2, CheckCircle, PlayCircle, Download, Printer } from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './SalesTasksPage.css';

/* ── Constants ─────────────────────────────────────── */
const PRIORITY_LABEL = { low:'منخفضة', medium:'متوسطة', high:'عالية', urgent:'عاجلة 🔴' };
const PRIORITY_OPTS  = [
  { v:'low', l:'منخفضة' }, { v:'medium', l:'متوسطة' },
  { v:'high', l:'عالية' }, { v:'urgent', l:'عاجلة' },
];
const STATUS_LABEL = {
  pending:'قيد الانتظار', acknowledged:'تم الاستلام',
  in_progress:'جارٍ التنفيذ', completed:'مكتملة', cancelled:'ملغاة',
};
const ADMIN_ROLES = ['super_admin', 'it_admin'];

function isAdmin(user) { return ADMIN_ROLES.includes(user?.role); }

function formatDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleDateString('ar-SA', { year:'numeric', month:'short', day:'numeric' });
}
function formatDateTime(d) {
  if (!d) return null;
  return new Date(d).toLocaleString('ar-SA', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}
function dueClass(dateStr, status) {
  if (!dateStr || ['completed','cancelled'].includes(status)) return '';
  const diff = new Date(dateStr) - new Date();
  if (diff < 0)              return 'stp-due-over';
  if (diff < 2 * 86400000)   return 'stp-due-soon';
  return 'stp-due-ok';
}
function fileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024*1024)  return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}
function fileIcon(mime) {
  if (!mime) return '📎';
  if (mime.startsWith('image/'))       return '🖼️';
  if (mime.includes('pdf'))            return '📄';
  if (mime.includes('sheet') || mime.includes('excel')) return '📊';
  if (mime.includes('word'))           return '📝';
  return '📎';
}

/* ── API ────────────────────────────────────────────── */
const api = {
  getRegions:     () => client.get('/sales-tasks/regions').then(r => r.data.regions),
  getSupervisors: (p) => client.get('/sales-tasks/supervisors', { params: p }).then(r => r.data.supervisors),
  getAssignees:   ()  => client.get('/sales-tasks/assignees').then(r => r.data.assignees),
  getTasks:       (p) => client.get('/sales-tasks/tasks', { params: p }).then(r => r.data.tasks),
  getTask:        (id) => client.get(`/sales-tasks/tasks/${id}`).then(r => r.data),
  createSup:      (d) => client.post('/sales-tasks/supervisors', d).then(r => r.data),
  updateSup:      (id, d) => client.put(`/sales-tasks/supervisors/${id}`, d).then(r => r.data),
  deleteSup:      (id) => client.delete(`/sales-tasks/supervisors/${id}`),
  createTask:     (fd) => client.post('/sales-tasks/tasks', fd, { headers:{'Content-Type':'multipart/form-data'} }).then(r => r.data),
  acknowledge:    (id, d) => client.put(`/sales-tasks/tasks/${id}/acknowledge`, d).then(r => r.data),
  start:          (id) => client.put(`/sales-tasks/tasks/${id}/start`).then(r => r.data),
  complete:       (id, fd) => client.put(`/sales-tasks/tasks/${id}/complete`, fd, { headers:{'Content-Type':'multipart/form-data'} }).then(r => r.data),
  cancel:         (id) => client.put(`/sales-tasks/tasks/${id}/cancel`).then(r => r.data),
  deleteTask:     (id) => client.delete(`/sales-tasks/tasks/${id}`),
  addNote:        (id, d) => client.post(`/sales-tasks/tasks/${id}/notes`, d).then(r => r.data),
  uploadFiles:    (id, fd) => client.post(`/sales-tasks/tasks/${id}/files`, fd, { headers:{'Content-Type':'multipart/form-data'} }).then(r => r.data),
};

/* Authenticated file download — <a href> doesn't send JWT, so we use fetch + Blob */
async function downloadFile(storedName, originalName) {
  try {
    const token = localStorage.getItem('token');
    const res   = await fetch(`/api/sales-tasks/files/${storedName}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('فشل التنزيل');
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = originalName || storedName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    alert('تعذّر تنزيل الملف');
  }
}

/* ═══════════════════════════════════════════════════════
   SUPERVISOR FORM MODAL
   ═══════════════════════════════════════════════════════ */
function SupervisorModal({ editing, regions, onClose, onSaved }) {
  const [form, setForm] = useState({
    name:      editing?.name      || '',
    region_id: editing?.region_id || '',
    email:     editing?.email     || '',
    phone:     editing?.phone     || '',
    is_active: editing?.is_active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) { setErr('الاسم مطلوب'); return; }
    setSaving(true); setErr('');
    try {
      if (editing) {
        await api.updateSup(editing.id, form);
      } else {
        await api.createSup(form);
      }
      onSaved();
    } catch (e) {
      setErr(e.response?.data?.error || 'حدث خطأ');
    } finally { setSaving(false); }
  };

  return createPortal(
    <div className="stp-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="stp-modal" style={{ maxWidth: 480 }}>
        <div className="stp-modal-header">
          <span className="stp-modal-title">{editing ? 'تعديل مشرف' : 'إضافة مشرف جديد'}</span>
          <button className="stp-modal-close" onClick={onClose}><X size={16}/></button>
        </div>
        <div className="stp-modal-body">
          {err && <div style={{ color:'#dc2626', fontSize:12, marginBottom:10 }}>{err}</div>}
          <div className="stp-form-row">
            <div className="stp-form-group">
              <label className="stp-label">الاسم <span className="stp-req">*</span></label>
              <input className="stp-input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="اسم المشرف" />
            </div>
            <div className="stp-form-group">
              <label className="stp-label">المنطقة</label>
              <select className="stp-select" value={form.region_id} onChange={e => set('region_id', e.target.value)}>
                <option value="">— اختر المنطقة —</option>
                {regions.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
              </select>
            </div>
          </div>
          <div className="stp-form-row">
            <div className="stp-form-group">
              <label className="stp-label">البريد الإلكتروني</label>
              <input className="stp-input" type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="email@example.com" dir="ltr"/>
            </div>
            <div className="stp-form-group">
              <label className="stp-label">رقم الجوال</label>
              <input className="stp-input" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="05xxxxxxxx" dir="ltr"/>
            </div>
          </div>
          {editing && (
            <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13 }}>
              <input type="checkbox" checked={form.is_active} onChange={e => set('is_active', e.target.checked)} />
              نشط
            </label>
          )}
        </div>
        <div className="stp-modal-footer">
          <button className="stp-btn stp-btn-ghost" onClick={onClose}>إلغاء</button>
          <button className="stp-btn stp-btn-primary" onClick={save} disabled={saving}>
            {saving ? 'جارٍ الحفظ…' : 'حفظ'}
          </button>
        </div>
      </div>
    </div>
  , document.body);
}

/* ═══════════════════════════════════════════════════════
   CREATE TASK MODAL
   ═══════════════════════════════════════════════════════ */
function CreateTaskModal({ regions, assignees = [], userRegionId, onClose, onCreated }) {
  const { user } = useAuth();
  const admin = isAdmin(user);

  const [form, setForm] = useState({
    title: '', description: '', region_id: admin ? '' : String(userRegionId || ''),
    assignee_combined_id: '', due_date: '', priority: 'medium',
    assigner_email: '', assignee_email: '', cc_emails: '',
  });
  const [files, setFiles]   = useState([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');
  const fileRef = useRef();
  const dropRef = useRef();

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  // Filter assignees by selected region
  const filteredAssignees = form.region_id
    ? assignees.filter(a => Number(a.region_id) === Number(form.region_id))
    : assignees;

  // Group by region for display
  const groupedAssignees = filteredAssignees.reduce((acc, a) => {
    const key = a.region_name_ar || 'غير محددة';
    if (!acc[key]) acc[key] = [];
    acc[key].push(a);
    return acc;
  }, {});

  // When assignee selected: auto-fill email + auto-set region (if admin)
  const onAssigneeChange = (combinedId) => {
    const assignee = assignees.find(a => a.combined_id === combinedId);
    set('assignee_combined_id', combinedId);
    if (assignee?.email)     set('assignee_email', assignee.email);
    if (admin && assignee?.region_id) set('region_id', String(assignee.region_id));
  };

  // When region changes, reset assignee if it doesn't belong to new region
  const onRegionChange = (regionId) => {
    set('region_id', regionId);
    const current = assignees.find(a => a.combined_id === form.assignee_combined_id);
    if (current && regionId && Number(current.region_id) !== Number(regionId)) {
      set('assignee_combined_id', '');
      set('assignee_email', '');
    }
  };

  const addFiles = (fl) => setFiles(p => [...p, ...Array.from(fl)]);
  const rmFile   = (i)  => setFiles(p => p.filter((_, idx) => idx !== i));

  const onDrop = e => {
    e.preventDefault();
    dropRef.current?.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  };

  const save = async () => {
    if (!form.title.trim())             { setErr('عنوان المهمة مطلوب'); return; }
    if (!form.assignee_combined_id)     { setErr('يجب اختيار المُعيَّن له'); return; }
    setSaving(true); setErr('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => { if (v) fd.append(k, v); });
      files.forEach(f => fd.append('files', f));
      await api.createTask(fd);
      onCreated();
    } catch (e) {
      setErr(e.response?.data?.error || 'حدث خطأ');
    } finally { setSaving(false); }
  };

  return createPortal(
    <div className="stp-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="stp-modal">
        <div className="stp-modal-header">
          <span className="stp-modal-title">➕ إنشاء مهمة جديدة</span>
          <button className="stp-modal-close" onClick={onClose}><X size={16}/></button>
        </div>
        <div className="stp-modal-body">
          {err && <div style={{ color:'#dc2626', fontSize:12, marginBottom:10 }}>{err}</div>}

          {/* Title + Priority */}
          <div className="stp-form-row">
            <div className="stp-form-group" style={{ gridColumn:'1/-1' }}>
              <label className="stp-label">عنوان المهمة <span className="stp-req">*</span></label>
              <input className="stp-input" value={form.title} onChange={e => set('title', e.target.value)} placeholder="اكتب عنوان المهمة" />
            </div>
          </div>

          <div className="stp-form-row">
            <div className="stp-form-group">
              <label className="stp-label">الأولوية</label>
              <select className="stp-select" value={form.priority} onChange={e => set('priority', e.target.value)}>
                {PRIORITY_OPTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
              </select>
            </div>
            <div className="stp-form-group">
              <label className="stp-label">الموعد النهائي</label>
              <input className="stp-input" type="date" value={form.due_date} onChange={e => set('due_date', e.target.value)} />
            </div>
          </div>

          {/* Region + Assignee */}
          <div className="stp-form-row">
            <div className="stp-form-group">
              <label className="stp-label">المنطقة <span className="stp-req">*</span></label>
              {admin ? (
                <select className="stp-select" value={form.region_id} onChange={e => onRegionChange(e.target.value)}>
                  <option value="">— اختر المنطقة —</option>
                  {regions.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
                </select>
              ) : (
                <input className="stp-input" readOnly value={regions.find(r => String(r.id) === String(userRegionId))?.name_ar || '—'} />
              )}
            </div>
            <div className="stp-form-group">
              <label className="stp-label">المُعيَّن له <span className="stp-req">*</span></label>
              <select className="stp-select" value={form.assignee_combined_id} onChange={e => onAssigneeChange(e.target.value)}>
                <option value="">— اختر مشرف أو مستخدم —</option>
                {Object.entries(groupedAssignees).map(([regionLabel, list]) => (
                  <optgroup key={regionLabel} label={`📍 ${regionLabel}`}>
                    {list.map(a => (
                      <option key={a.combined_id} value={a.combined_id}>
                        {a.type === 'user' ? '👤 ' : '🧑‍💼 '}{a.name}
                        {a.email ? ` — ${a.email}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>

          {/* Description */}
          <div className="stp-form-row full">
            <div className="stp-form-group">
              <label className="stp-label">تفاصيل المهمة</label>
              <textarea className="stp-textarea" value={form.description} onChange={e => set('description', e.target.value)} placeholder="اكتب تفاصيل المهمة..." />
            </div>
          </div>

          {/* Emails */}
          <div className="stp-form-row">
            <div className="stp-form-group">
              <label className="stp-label">بريد المُعيِّن (أنت)</label>
              <input className="stp-input" type="email" dir="ltr" value={form.assigner_email} onChange={e => set('assigner_email', e.target.value)} placeholder="your@email.com" />
            </div>
            <div className="stp-form-group">
              <label className="stp-label">بريد المُعيَّن له (المشرف)</label>
              <input className="stp-input" type="email" dir="ltr" value={form.assignee_email} onChange={e => set('assignee_email', e.target.value)} placeholder="supervisor@email.com" />
            </div>
          </div>
          <div className="stp-form-row full">
            <div className="stp-form-group">
              <label className="stp-label">نسخة (CC)</label>
              <input className="stp-input" dir="ltr" value={form.cc_emails} onChange={e => set('cc_emails', e.target.value)} placeholder="email1@x.com, email2@x.com" />
              <div className="stp-cc-hint">يمكن إضافة أكثر من بريد مفصولة بفاصلة</div>
            </div>
          </div>

          {/* Files */}
          <div className="stp-form-row full">
            <div className="stp-form-group">
              <label className="stp-label">مرفقات (اختياري)</label>
              <div
                ref={dropRef} className="stp-dropzone"
                onDragOver={e => { e.preventDefault(); dropRef.current?.classList.add('drag-over'); }}
                onDragLeave={() => dropRef.current?.classList.remove('drag-over')}
                onDrop={onDrop}
                onClick={() => fileRef.current?.click()}
              >
                <div className="stp-dropzone-lbl">
                  <span>📎 </span>
                  <strong>اضغط أو اسحب ملفاتك هنا</strong>
                </div>
                <input ref={fileRef} type="file" multiple style={{ display:'none' }} onChange={e => addFiles(e.target.files)} />
              </div>
              {files.length > 0 && (
                <div className="stp-file-list">
                  {files.map((f, i) => (
                    <div key={i} className="stp-file-item">
                      <span>{fileIcon(f.type)} {f.name}</span>
                      <button className="stp-file-rm" onClick={() => rmFile(i)}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="stp-modal-footer">
          <button className="stp-btn stp-btn-ghost" onClick={onClose}>إلغاء</button>
          <button className="stp-btn stp-btn-primary" onClick={save} disabled={saving}>
            {saving ? 'جارٍ الإنشاء…' : '✅ إنشاء المهمة'}
          </button>
        </div>
      </div>
    </div>
  , document.body);
}

/* ═══════════════════════════════════════════════════════
   TASK DETAIL MODAL
   ═══════════════════════════════════════════════════════ */
function TaskDetailModal({ taskId, onClose, onChanged }) {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const qc = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['task-detail', taskId],
    queryFn:  () => api.getTask(taskId),
    staleTime: 0,
  });

  const [ackNote, setAckNote]     = useState('');
  const [complNote, setComplNote] = useState('');
  const [newNote, setNewNote]     = useState('');
  const [step, setStep]           = useState(null); // 'ack' | 'complete' | null
  const [complFiles, setComplFiles] = useState([]);
  const [noteFiles,  setNoteFiles]  = useState([]);
  const [busy, setBusy]           = useState(false);
  const complFileRef = useRef();
  const noteFileRef  = useRef();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['tasks'] });
    refetch();
    onChanged?.();
  };

  const doAck = async () => {
    setBusy(true);
    try { await api.acknowledge(taskId, { note: ackNote }); invalidate(); setStep(null); }
    catch (e) { alert(e.response?.data?.error || 'خطأ'); }
    finally { setBusy(false); }
  };

  const doStart = async () => {
    setBusy(true);
    try { await api.start(taskId); invalidate(); }
    catch (e) { alert(e.response?.data?.error || 'خطأ'); }
    finally { setBusy(false); }
  };

  const doComplete = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      if (complNote) fd.append('note', complNote);
      complFiles.forEach(f => fd.append('files', f));
      await api.complete(taskId, fd);
      invalidate(); setStep(null);
    } catch (e) { alert(e.response?.data?.error || 'خطأ'); }
    finally { setBusy(false); }
  };

  const doCancel = async () => {
    if (!confirm('هل تريد إلغاء هذه المهمة؟')) return;
    setBusy(true);
    try { await api.cancel(taskId); invalidate(); }
    catch (e) { alert(e.response?.data?.error || 'خطأ'); }
    finally { setBusy(false); }
  };

  const addNote = async () => {
    if (!newNote.trim()) return;
    setBusy(true);
    try {
      await api.addNote(taskId, { note_text: newNote });
      // upload any note files
      if (noteFiles.length) {
        const fd = new FormData();
        fd.append('stage', 'note');
        noteFiles.forEach(f => fd.append('files', f));
        await api.uploadFiles(taskId, fd);
        setNoteFiles([]);
      }
      setNewNote(''); invalidate();
    } catch (e) { alert(e.response?.data?.error || 'خطأ'); }
    finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (!confirm('هل تريد حذف هذه المهمة نهائياً؟')) return;
    setBusy(true);
    try { await api.deleteTask(taskId); qc.invalidateQueries({ queryKey:['tasks'] }); onClose(); }
    catch (e) { alert(e.response?.data?.error || 'خطأ'); }
    finally { setBusy(false); }
  };

  if (isLoading) return createPortal(
    <div className="stp-overlay"><div className="stp-modal" style={{ padding:40, textAlign:'center' }}>جارٍ التحميل…</div></div>
  , document.body);
  if (!data) return null;

  const { task, notes, files: taskFiles } = data;
  const regionName = task.region_name_ar || task.region_name_en || '—';

  /* Timeline steps */
  const tl = [
    { key:'created',      label:'تم إنشاء المهمة', time: task.created_at,      done: true,  icon:'📋' },
    { key:'acknowledged', label:'تم استلام المهمة', time: task.acknowledged_at, done: !!task.acknowledged_at, icon:'👀', note: task.acknowledgement_note },
    { key:'in_progress',  label:'بدأ التنفيذ',      time: task.started_at,      done: !!task.started_at,    icon:'⚙️' },
    { key:'completed',    label:'تم الإنجاز',        time: task.completed_at,    done: !!task.completed_at,  icon:'✅', note: task.completion_note },
  ];
  if (task.status === 'cancelled') {
    tl.push({ key:'cancelled', label:'تم الإلغاء', time: task.updated_at, done: true, icon:'❌' });
  }

  return createPortal(
    <div className="stp-overlay-fs">
      <div className="stp-modal-fs">

        {/* ── Header ── */}
        <div className="stp-modal-header">
          <div style={{ display:'flex', alignItems:'center', gap:10, flex:1, minWidth:0 }}>
            <span className={`stp-badge stp-badge-${task.status}`}>{STATUS_LABEL[task.status]}</span>
            <span className={`stp-priority stp-priority-${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>
            <span className="stp-modal-title"
              style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize:17 }}>
              {task.title}
            </span>
          </div>
          <div style={{ display:'flex', gap:8, alignItems:'center', flexShrink:0 }}>
            {admin && (
              <button className="stp-btn stp-btn-danger stp-btn-sm" onClick={doDelete} disabled={busy}>
                <Trash2 size={12}/> حذف
              </button>
            )}
            <button className="stp-modal-close" onClick={onClose} title="إغلاق"><X size={18}/></button>
          </div>
        </div>

        {/* ── Body: two-column layout ── */}
        <div className="stp-modal-body">
          <div className="stp-detail-fs-grid">

            {/* ══ RIGHT SIDE — Info + Timeline + Actions ══ */}
            <div className="stp-detail-fs-side">

              {/* Info strip */}
              <div className="stp-detail-info" style={{ marginBottom:16 }}>
                <div className="stp-info-item"><span className="stp-info-label">المنطقة</span><span className="stp-info-val">📍 {regionName}</span></div>
                <div className="stp-info-item"><span className="stp-info-label">المشرف</span><span className="stp-info-val">👤 {task.supervisor_name || '—'}</span></div>
                <div className="stp-info-item"><span className="stp-info-label">المُعيِّن</span><span className="stp-info-val">{task.assigner_name || '—'}</span></div>
                <div className="stp-info-item">
                  <span className="stp-info-label">الموعد النهائي</span>
                  <span className={`stp-info-val stp-due ${dueClass(task.due_date, task.status)}`}>
                    {formatDate(task.due_date) || '—'}
                  </span>
                </div>
              </div>

              {/* Description */}
              {task.description && (
                <div style={{ background:'#f8fafc', borderRadius:8, padding:'10px 14px', fontSize:13,
                  color:'#374151', marginBottom:16, border:'1px solid #e2e8f0', lineHeight:1.6 }}>
                  {task.description}
                </div>
              )}

              {/* Action buttons */}
              {!['completed','cancelled'].includes(task.status) && (
                <div className="stp-actions" style={{ flexWrap:'wrap' }}>
                  {task.status === 'pending' && (
                    <button className="stp-btn stp-btn-primary" onClick={() => setStep('ack')} disabled={busy}>
                      <CheckCircle size={14}/> تأكيد الاستلام
                    </button>
                  )}
                  {['pending','acknowledged'].includes(task.status) && (
                    <button className="stp-btn" style={{ background:'#e0f2fe', color:'#0369a1' }} onClick={doStart} disabled={busy}>
                      <PlayCircle size={14}/> بدء التنفيذ
                    </button>
                  )}
                  {task.status !== 'cancelled' && (
                    <button className="stp-btn stp-btn-primary" style={{ background:'#059669' }} onClick={() => setStep('complete')} disabled={busy}>
                      ✅ إنهاء المهمة
                    </button>
                  )}
                  {admin && (
                    <button className="stp-btn stp-btn-ghost" onClick={doCancel} disabled={busy}>
                      إلغاء المهمة
                    </button>
                  )}
                </div>
              )}

              {/* Acknowledge panel */}
              {step === 'ack' && (
                <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:10, padding:14, marginBottom:14 }}>
                  <div className="stp-section-title" style={{ color:'#1d4ed8' }}>👀 تأكيد استلام المهمة</div>
                  <textarea className="stp-textarea" style={{ marginBottom:10 }} value={ackNote}
                    onChange={e => setAckNote(e.target.value)} placeholder="ملاحظة الاستلام (اختياري)..." />
                  <div style={{ display:'flex', gap:8 }}>
                    <button className="stp-btn stp-btn-primary" onClick={doAck} disabled={busy}>{busy ? '…' : 'تأكيد'}</button>
                    <button className="stp-btn stp-btn-ghost" onClick={() => setStep(null)}>إلغاء</button>
                  </div>
                </div>
              )}

              {/* Complete panel */}
              {step === 'complete' && (
                <div style={{ background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:10, padding:14, marginBottom:14 }}>
                  <div className="stp-section-title" style={{ color:'#166534' }}>✅ تقرير الإنجاز</div>
                  <textarea className="stp-textarea" style={{ marginBottom:10 }} value={complNote}
                    onChange={e => setComplNote(e.target.value)} placeholder="اكتب تقرير الإنجاز..." />
                  <div style={{ marginBottom:10 }}>
                    <button className="stp-btn stp-btn-ghost stp-btn-sm" onClick={() => complFileRef.current?.click()}>
                      <Paperclip size={12}/> إرفاق ملفات الإنجاز
                    </button>
                    <input ref={complFileRef} type="file" multiple style={{ display:'none' }}
                      onChange={e => setComplFiles(p => [...p, ...e.target.files])} />
                    {complFiles.map((f, i) => (
                      <div key={i} className="stp-file-item" style={{ marginTop:4 }}>
                        {f.name} <button className="stp-file-rm" onClick={() => setComplFiles(p => p.filter((_,j)=>j!==i))}>✕</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display:'flex', gap:8 }}>
                    <button className="stp-btn stp-btn-primary" style={{ background:'#059669' }} onClick={doComplete} disabled={busy}>
                      {busy ? '…' : 'تأكيد الإنجاز'}
                    </button>
                    <button className="stp-btn stp-btn-ghost" onClick={() => setStep(null)}>إلغاء</button>
                  </div>
                </div>
              )}

              {/* Timeline — grows to fill remaining space */}
              <div style={{ flex:1, display:'flex', flexDirection:'column', minHeight:0 }}>
                <div className="stp-section-title" style={{ marginTop:8 }}>📅 سجل المهمة</div>
                <div className="stp-timeline" style={{ flex:1, overflowY:'auto' }}>
                  {tl.map((t, i) => (
                    <div key={t.key} className="stp-tl-item">
                      <div className="stp-tl-dot-wrap">
                        <div className={`stp-tl-dot ${t.done ? 'stp-tl-dot-done' : 'stp-tl-dot-pending'}`}>{t.icon}</div>
                        {i < tl.length - 1 && <div className="stp-tl-line" />}
                      </div>
                      <div className="stp-tl-content">
                        <div className="stp-tl-title" style={{ color: t.done ? '#111827' : '#9ca3af' }}>{t.label}</div>
                        {t.time && <div className="stp-tl-time">{formatDateTime(t.time)}</div>}
                        {t.note && <div className="stp-tl-note">{t.note}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ══ LEFT SIDE — Notes + Files ══ */}
            <div className="stp-detail-fs-main">

              {/* Files */}
              <div className="stp-section-title">
                📎 المرفقات ({taskFiles?.length || 0})
                <button className="stp-btn stp-btn-ghost stp-btn-sm" style={{ marginRight:10 }}
                  onClick={() => noteFileRef.current?.click()}>
                  <Paperclip size={12}/> إرفاق ملف
                </button>
                <input ref={noteFileRef} type="file" multiple style={{ display:'none' }}
                  onChange={e => setNoteFiles(p => [...p, ...e.target.files])} />
              </div>

              {noteFiles.length > 0 && (
                <div style={{ marginBottom:10 }}>
                  {noteFiles.map((f, i) => (
                    <div key={i} className="stp-file-item">
                      {f.name}
                      <button className="stp-file-rm" onClick={() => setNoteFiles(p => p.filter((_,j)=>j!==i))}>✕</button>
                    </div>
                  ))}
                  <button className="stp-btn stp-btn-primary stp-btn-sm" style={{ marginTop:6 }}
                    onClick={addNote} disabled={busy}>رفع الملفات</button>
                </div>
              )}

              {taskFiles?.length > 0 ? (
                <div className="stp-files-list" style={{ marginBottom:20 }}>
                  {taskFiles.map(f => (
                    <div key={f.id} className="stp-file-row">
                      <span className="stp-file-icon">{fileIcon(f.mime_type)}</span>
                      <div className="stp-file-info">
                        <div className="stp-file-name">{f.original_name}</div>
                        <div className="stp-file-size">{fileSize(f.file_size)} — {formatDateTime(f.uploaded_at)}</div>
                      </div>
                      <span className={`stp-file-stage stp-file-stage-${f.upload_stage}`}>
                        {f.upload_stage === 'assignment' ? 'تعيين' : f.upload_stage === 'completion' ? 'إنجاز' : 'ملاحظة'}
                      </span>
                      <button className="stp-btn stp-btn-ghost stp-btn-sm"
                        onClick={() => downloadFile(f.stored_name, f.original_name)} title="تنزيل">
                        <Download size={12}/>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize:13, color:'#9ca3af', marginBottom:20 }}>لا توجد مرفقات</div>
              )}

              {/* Notes — grows to fill remaining height */}
              <div style={{ flex:1, display:'flex', flexDirection:'column', minHeight:0 }}>
                <div className="stp-section-title">💬 الملاحظات ({notes?.length || 0})</div>

                <div className="stp-note-form" style={{ marginBottom:14 }}>
                  <input className="stp-input" value={newNote} onChange={e => setNewNote(e.target.value)}
                    placeholder="أضف ملاحظة…" onKeyDown={e => e.key==='Enter' && !e.shiftKey && addNote()} />
                  <button className="stp-btn stp-btn-primary stp-btn-sm" onClick={addNote}
                    disabled={busy || !newNote.trim()}>إرسال</button>
                </div>

                {notes?.length > 0 ? (
                  <div className="stp-notes-list" style={{ flex:1, overflowY:'auto' }}>
                    {[...notes].reverse().map(n => (
                      <div key={n.id} className="stp-note-item">
                        <div>{n.note_text}</div>
                        <div className="stp-note-meta">{n.added_by_name} — {formatDateTime(n.added_at)}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:13, color:'#9ca3af', background:'#f8fafc', borderRadius:8, border:'1px dashed #e2e8f0' }}>
                    لا توجد ملاحظات حتى الآن
                  </div>
                )}
              </div>
            </div>

          </div>{/* end grid */}
        </div>{/* end body */}

      </div>{/* end modal-fs */}
    </div>
  , document.body);

}

/* ═══════════════════════════════════════════════════════
   SUPERVISORS TAB
   ═══════════════════════════════════════════════════════ */
function SupervisorsTab({ regions }) {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const qc = useQueryClient();
  const [modal, setModal] = useState(null); // null | 'create' | supervisor-object

  const { data = [] } = useQuery({
    queryKey: ['supervisors'],
    queryFn:  () => api.getSupervisors(),
  });

  const del = async (id) => {
    if (!confirm('حذف هذا المشرف؟')) return;
    await api.deleteSup(id);
    qc.invalidateQueries({ queryKey: ['supervisors'] });
  };

  return (
    <div>
      {admin && (
        <div style={{ marginBottom:16 }}>
          <button className="stp-btn stp-btn-primary" onClick={() => setModal('create')}>
            <Plus size={14}/> إضافة مشرف
          </button>
        </div>
      )}

      {data.length === 0 ? (
        <div className="stp-empty"><div className="stp-empty-icon">👤</div><div className="stp-empty-text">لا يوجد مشرفون مضافون حتى الآن</div></div>
      ) : (
        <div className="stp-sup-grid">
          {data.map(s => (
            <div key={s.id} className={`stp-sup-card${!s.is_active ? ' stp-sup-inactive' : ''}`}>
              <div className="stp-sup-name">{s.name} {!s.is_active && <span style={{ fontSize:10, color:'#ef4444' }}>غير نشط</span>}</div>
              <div className="stp-sup-region">📍 {s.region_name_ar || '—'}</div>
              {s.email && <div className="stp-sup-email">✉️ {s.email}</div>}
              {s.phone && <div style={{ fontSize:12, color:'#64748b' }}>📞 {s.phone}</div>}
              {admin && (
                <div className="stp-sup-actions">
                  <button className="stp-btn stp-btn-ghost stp-btn-sm" onClick={() => setModal(s)}>
                    <Pencil size={12}/> تعديل
                  </button>
                  <button className="stp-btn stp-btn-danger stp-btn-sm" onClick={() => del(s.id)}>
                    <Trash2 size={12}/> حذف
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {modal && (
        <SupervisorModal
          editing={modal === 'create' ? null : modal}
          regions={regions}
          onClose={() => setModal(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey:['supervisors'] }); setModal(null); }}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   TASKS TAB
   ═══════════════════════════════════════════════════════ */
function TasksTab({ regions, supervisors }) {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const qc = useQueryClient();

  const [statusFilter, setStatusFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [search, setSearch]             = useState('');
  const [showCreate, setShowCreate]     = useState(false);
  const [detailId, setDetailId]         = useState(null);

  const params = {};
  if (statusFilter) params.status    = statusFilter;
  if (regionFilter) params.region_id = regionFilter;

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['tasks', params],
    queryFn:  () => api.getTasks(params),
    refetchInterval: 60000, // refresh every minute
  });

  const filtered = search
    ? tasks.filter(t =>
        t.title.includes(search) ||
        t.supervisor_name?.includes(search) ||
        t.region_name_ar?.includes(search)
      )
    : tasks;

  // Stats
  const stats = {
    pending:    tasks.filter(t => t.status === 'pending').length,
    in_progress:tasks.filter(t => ['acknowledged','in_progress'].includes(t.status)).length,
    completed:  tasks.filter(t => t.status === 'completed').length,
    overdue:    tasks.filter(t => !['completed','cancelled'].includes(t.status) && t.due_date && new Date(t.due_date) < new Date()).length,
  };

  return (
    <div>
      {/* Stats */}
      <div className="stp-stats">
        <div className="stp-stat stp-stat-pending">
          <div><div className="stp-stat-num">{stats.pending}</div><div className="stp-stat-lbl">قيد الانتظار</div></div>
        </div>
        <div className="stp-stat stp-stat-progress">
          <div><div className="stp-stat-num">{stats.in_progress}</div><div className="stp-stat-lbl">جارٍ التنفيذ</div></div>
        </div>
        <div className="stp-stat stp-stat-done">
          <div><div className="stp-stat-num">{stats.completed}</div><div className="stp-stat-lbl">مكتملة</div></div>
        </div>
        {stats.overdue > 0 && (
          <div className="stp-stat stp-stat-over">
            <div><div className="stp-stat-num">{stats.overdue}</div><div className="stp-stat-lbl">⚠️ متأخرة</div></div>
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="stp-toolbar">
        <input className="stp-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 بحث…" />
        <select className="stp-filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">جميع الحالات</option>
          {Object.entries(STATUS_LABEL).map(([v,l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {admin && (
          <select className="stp-filter-select" value={regionFilter} onChange={e => setRegionFilter(e.target.value)}>
            <option value="">جميع المناطق</option>
            {regions.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
          </select>
        )}
        <button className="stp-btn stp-btn-primary" style={{ marginRight:'auto' }} onClick={() => setShowCreate(true)}>
          <Plus size={14}/> مهمة جديدة
        </button>
      </div>

      {/* Cards */}
      {isLoading ? (
        <div className="stp-loading">جارٍ التحميل…</div>
      ) : filtered.length === 0 ? (
        <div className="stp-empty">
          <div className="stp-empty-icon">📋</div>
          <div className="stp-empty-text">لا توجد مهام مطابقة</div>
        </div>
      ) : (
        <div className="stp-cards">
          {filtered.map(t => {
            const dc = dueClass(t.due_date, t.status);
            const overdue = dc === 'stp-due-over';
            return (
              <div key={t.id} className={`stp-card${overdue ? ' overdue' : ''}`} onClick={() => setDetailId(t.id)}>
                <div className="stp-card-top">
                  <div className="stp-card-left">
                    <div className="stp-card-title">{t.title}</div>
                    <div className="stp-card-meta">
                      <span className="stp-card-meta-item">📍 {t.region_name_ar || '—'}</span>
                      <span className="stp-card-meta-item">👤 {t.supervisor_name || '—'}</span>
                      <span className="stp-card-meta-item">🗓️ أُنشئت {formatDate(t.created_at)}</span>
                    </div>
                  </div>
                  <div className="stp-card-right">
                    <span className={`stp-badge stp-badge-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                    <span className={`stp-priority stp-priority-${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>
                  </div>
                </div>
                <div className="stp-card-bottom">
                  <div className="stp-card-counts">
                    {t.notes_count > 0 && <span className="stp-card-count"><MessageSquare size={11}/> {t.notes_count}</span>}
                    {t.files_count > 0 && <span className="stp-card-count"><Paperclip size={11}/> {t.files_count}</span>}
                  </div>
                  {t.due_date && (
                    <span className={`stp-due ${dc}`}>
                      ⏰ {overdue ? 'تأخر: ' : 'ينتهي: '}{formatDate(t.due_date)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {showCreate && (
        <CreateTaskModal
          regions={regions}
          assignees={assignees}
          userRegionId={user?.region_id}
          onClose={() => setShowCreate(false)}
          onCreated={() => { qc.invalidateQueries({ queryKey:['tasks'] }); setShowCreate(false); }}
        />
      )}
      {detailId && (
        <TaskDetailModal
          taskId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => qc.invalidateQueries({ queryKey:['tasks'] })}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════ */
export default function SalesTasksPage() {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const [tab, setTab] = useState('tasks');

  const { data: regions   = [] } = useQuery({ queryKey:['task-regions'],  queryFn: api.getRegions });
  const { data: supervisors = [] } = useQuery({ queryKey:['supervisors'], queryFn: () => api.getSupervisors() });
  const { data: assignees = [] } = useQuery({ queryKey:['task-assignees'], queryFn: api.getAssignees, staleTime: 60_000 });

  const smtpConfigured = !!(import.meta.env.VITE_SMTP_CONFIGURED);

  const handlePrint = useCallback(() => {
    const prev = document.title;
    document.title = `مهام فريق المبيعات — ${new Date().toLocaleDateString('ar-SA', { year:'numeric', month:'long', day:'numeric' })}`;
    window.print();
    window.onafterprint = () => { document.title = prev; window.onafterprint = null; };
  }, []);

  return (
    <div className="stp-page">
      <div className="stp-print-header">
        <span>📋</span>
        <span className="stp-print-title">مهام فريق المبيعات</span>
        <span className="stp-print-date">{new Date().toLocaleDateString('ar-SA',{year:'numeric',month:'long',day:'numeric',weekday:'long'})}</span>
      </div>
      <div className="stp-header">
        <div className="stp-title">
          📋 مهام فريق المبيعات
          {!admin && user?.region_id && (
            <span>{regions.find(r => r.id === user.region_id)?.name_ar}</span>
          )}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div className="stp-tabs">
            <button className={`stp-tab${tab==='tasks' ? ' active' : ''}`} onClick={() => setTab('tasks')}>المهام</button>
            <button className={`stp-tab${tab==='supervisors' ? ' active' : ''}`} onClick={() => setTab('supervisors')}>المشرفون</button>
          </div>
          <button className="stp-pdf-btn stp-no-print" onClick={handlePrint} title="تصدير PDF / طباعة">
            <Printer size={14} /> PDF
          </button>
        </div>
      </div>

      {tab === 'tasks' && <TasksTab regions={regions} supervisors={supervisors} />}
      {tab === 'supervisors' && <SupervisorsTab regions={regions} />}
    </div>
  );
}
