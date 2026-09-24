import React, { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users, UserPlus, Pencil, Trash2, ChevronDown, ChevronUp,
  Check, X, Upload, Download, Plus, Search, AlertTriangle, FileSpreadsheet, Send, CheckCircle2, Clock,
  Network, ZoomIn, ZoomOut, Printer, Minus, Eye, EyeOff, Copy,
} from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './RepManagementPage.css';

const ADMIN_ROLES = ['super_admin', 'it_admin'];

const ROLE_LABELS = {
  supervisor:     'مشرف',
  region_manager: 'مدير منطقة',
  sector_manager: 'مدير قطاع',
  sales_manager:  'مدير المبيعات',
};
const ROLES_ORDER = ['sales_manager','sector_manager','region_manager','supervisor'];

const MONTHS = [
  {v:1,l:'يناير'},{v:2,l:'فبراير'},{v:3,l:'مارس'},{v:4,l:'أبريل'},
  {v:5,l:'مايو'},{v:6,l:'يونيو'},{v:7,l:'يوليو'},{v:8,l:'أغسطس'},
  {v:9,l:'سبتمبر'},{v:10,l:'أكتوبر'},{v:11,l:'نوفمبر'},{v:12,l:'ديسمبر'},
];

const now = new Date();
const CUR_YEAR  = now.getFullYear();
const CUR_MONTH = now.getMonth() + 1;

function fmtApprovedAt(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('ar-SA-u-nu-latn', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/* ── API helpers ─────────────────────────────────────────────── */
const api = {
  reps:          () => client.get('/sales-reps').then(r => r.data),
  managers:      () => client.get('/sales-reps/managers').then(r => r.data),
  nsNames:       () => client.get('/sales-reps/netsuite-names').then(r => r.data),
  routes:        () => client.get('/sales-reps/routes').then(r => r.data),
  targets:       (y, m) => client.get(`/sales-reps/targets?year=${y}&month=${m}`).then(r => r.data),
  suggestedTargets: (y, m) => client.get(`/sales-reps/targets/suggested?year=${y}&month=${m}`).then(r => r.data),
  // Full regions list from the regions table — NOT the /invoices/kpi
  // "regions that actually have invoices" list, which silently hides a
  // brand-new region (e.g. Jeddah) until its first invoice upload,
  // making it impossible to assign reps/routes to it in the first place.
  regions:       () => client.get('/users/regions').then(r => r.data || []),
  unmatched:     () => client.get('/sales-reps/unmatched-names').then(r => r.data),
  approvalStatus: (y, m) => client.get(`/target-approvals/status?year=${y}&month=${m}`).then(r => r.data),
  sendApprovals:  (y, m, regionId) => client.post('/target-approvals/send', { year: y, month: m, region_id: regionId || undefined }).then(r => r.data),
};

const SEND_APPROVAL_ROLES = ['super_admin', 'it_admin', 'sales_manager'];

/* ── Blank forms ─────────────────────────────────────────────── */
const BLANK_REP = {
  name_ar:'', name_en:'', netsuite_name:'', region_id:'', route_id:'', vehicle_number:'',
  supervisor_id:'', region_manager_id:'', sector_manager_id:'', sales_manager_id:'',
};
const BLANK_MGR = { name_ar:'', name_en:'', role:'supervisor', region_id:'' };

/* ── Modal ───────────────────────────────────────────────────── */
function Modal({ title, onClose, children }) {
  return (
    <div className="rmp-overlay" onClick={onClose}>
      <div className="rmp-modal" onClick={e => e.stopPropagation()}>
        <div className="rmp-modal-hdr">
          <span>{title}</span>
          <button className="rmp-modal-close" onClick={onClose}><X size={16}/></button>
        </div>
        <div className="rmp-modal-body">{children}</div>
      </div>
    </div>
  );
}

/* ── Form field ──────────────────────────────────────────────── */
function Field({ label, children }) {
  return (
    <div className="rmp-field">
      <label className="rmp-field-label">{label}</label>
      {children}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   TAB: المناديب
════════════════════════════════════════════════════════════════ */
function RepsTab({ isAdmin }) {
  const qc = useQueryClient();
  const { data: reps = [],     isLoading } = useQuery({ queryKey: ['sales-reps'],     queryFn: api.reps });
  const { data: managers = [] }            = useQuery({ queryKey: ['rep-managers'],   queryFn: api.managers });
  const { data: nsNames = [] }             = useQuery({ queryKey: ['ns-names'],       queryFn: api.nsNames });
  const { data: routes = [] }              = useQuery({ queryKey: ['rep-routes'],     queryFn: api.routes });
  const { data: regionsRaw = [] }          = useQuery({ queryKey: ['regions-kpi'],    queryFn: api.regions });
  const { data: unmatchedData }            = useQuery({ queryKey: ['unmatched-reps'], queryFn: api.unmatched });
  const unmatched = unmatchedData?.unmatched || [];

  const [form, setForm]       = useState(null);   // null = closed; obj = editing
  const [search, setSearch]   = useState('');
  const [confirm, setConfirm] = useState(null);

  const regions = regionsRaw.map ? regionsRaw : [];

  const filtered = reps.filter(r =>
    !search || r.name_ar.includes(search) || (r.netsuite_name||'').includes(search)
  );

  /* -- managers grouped by role for selects -- */
  const mgrByRole = {};
  ROLES_ORDER.forEach(role => { mgrByRole[role] = managers.filter(m => m.role === role && m.is_active); });

  const saveMutation = useMutation({
    mutationFn: data => data.id
      ? client.put(`/sales-reps/${data.id}`, data)
      : client.post('/sales-reps', data),
    onSuccess: () => { qc.invalidateQueries(['sales-reps']); qc.invalidateQueries(['unmatched-reps']); setForm(null); },
  });

  const deleteMutation = useMutation({
    mutationFn: id => client.delete(`/sales-reps/${id}`),
    onSuccess: () => { qc.invalidateQueries(['sales-reps']); qc.invalidateQueries(['unmatched-reps']); setConfirm(null); },
  });

  const [autoLinkResult, setAutoLinkResult] = useState(null);
  const autoLinkMutation = useMutation({
    mutationFn: () => client.post('/sales-reps/auto-link-routes', {}).then(r => r.data),
    onSuccess: (data) => { qc.invalidateQueries(['sales-reps']); setAutoLinkResult(data); },
  });

  function handleSave() {
    const data = { ...form };
    ['region_id','route_id','supervisor_id','region_manager_id','sector_manager_id','sales_manager_id']
      .forEach(k => { data[k] = data[k] ? Number(data[k]) : null; });
    saveMutation.mutate(data);
  }

  function inputRegions() {
    // Try to extract region list from rep data when kpi endpoint doesn't return array
    const fromReps = [...new Set(reps.map(r => ({id: r.region_id, name: r.region_name}))
                                     .filter(r => r.id).map(JSON.stringify))].map(JSON.parse);
    return fromReps.length ? fromReps : [];
  }
  const regionList = Array.isArray(regionsRaw) && regionsRaw[0]?.id
    ? regionsRaw
    : inputRegions();

  return (
    <div className="rmp-tab-content">
      {unmatched.length > 0 && (
        <div className="rmp-unmatched-banner">
          <div className="rmp-unmatched-title">
            <AlertTriangle size={16}/>
            يوجد {unmatched.length} مندوب في بيانات المبيعات هذا الشهر غير مرتبطين بالنظام — عملاؤهم وكمياتهم لا تظهر في داشبورد الأداء
          </div>
          <div className="rmp-unmatched-list">
            {unmatched.map(u => (
              <div key={u.salesrep_name} className="rmp-unmatched-item">
                <span className="rmp-unmatched-name">{u.salesrep_name}</span>
                <span className="rmp-unmatched-meta">{u.customers} عميل · {Number(u.total_qty).toLocaleString('en-SA')} كمية</span>
                {isAdmin && (
                  <button className="rmp-unmatched-add"
                    onClick={() => setForm({ ...BLANK_REP, name_ar: u.salesrep_name, netsuite_name: u.salesrep_name })}>
                    <Plus size={12}/> إضافة
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="rmp-tab-toolbar">
        <div className="rmp-search-wrap">
          <Search size={14} className="rmp-search-icon"/>
          <input className="rmp-search" value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="بحث بالاسم…" />
        </div>
        {isAdmin && (
          <button className="rmp-btn" onClick={() => autoLinkMutation.mutate()} disabled={autoLinkMutation.isPending}>
            🔗 {autoLinkMutation.isPending ? 'جارٍ الربط…' : 'ربط تلقائي بخط السير'}
          </button>
        )}
        {isAdmin && (
          <button className="rmp-btn rmp-btn--add" onClick={() => setForm({ ...BLANK_REP })}>
            <UserPlus size={15}/> إضافة مندوب
          </button>
        )}
      </div>

      {autoLinkResult && (
        <div className="rmp-upload-result rmp-upload-result--ok">
          ✅ تم ربط {autoLinkResult.linked} مندوب بخط سيرهم تلقائياً (بناءً على أكثر خط تكراراً في فواتيرهم)
          <button className="rmp-upload-close" onClick={() => setAutoLinkResult(null)}><X size={12}/></button>
        </div>
      )}

      {isLoading ? (
        <div className="rmp-loading">جارٍ التحميل…</div>
      ) : (
        <div className="rmp-table-wrap">
          <table className="rmp-table">
            <thead>
              <tr>
                <th>الاسم</th>
                <th>اسم NetSuite</th>
                <th>المنطقة</th>
                <th>خط السير</th>
                <th>رقم السيارة</th>
                <th>المشرف</th>
                <th>مدير المنطقة</th>
                <th>مدير القطاع</th>
                <th>مدير المبيعات</th>
                {isAdmin && <th>إجراءات</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map(rep => (
                <tr key={rep.id}>
                  <td><strong>{rep.name_ar}</strong>{rep.name_en && <span className="rmp-muted"> · {rep.name_en}</span>}</td>
                  <td className="rmp-ns-name">{rep.netsuite_name || <span className="rmp-muted">—</span>}</td>
                  <td>{rep.region_name || <span className="rmp-muted">—</span>}</td>
                  <td>
                    {rep.route_id
                      ? rep.route_id
                      : rep.suggested_route_id
                        ? <span className="rmp-muted" title="اقتراح تلقائي غير محفوظ">{rep.suggested_route_id}؟</span>
                        : <span className="rmp-muted">—</span>}
                  </td>
                  <td>{rep.vehicle_number || <span className="rmp-muted">—</span>}</td>
                  <td>{rep.supervisor_name || <span className="rmp-muted">—</span>}</td>
                  <td>{rep.region_manager_name || <span className="rmp-muted">—</span>}</td>
                  <td>{rep.sector_manager_name || <span className="rmp-muted">—</span>}</td>
                  <td>{rep.sales_manager_name || <span className="rmp-muted">—</span>}</td>
                  {isAdmin && (
                    <td className="rmp-actions">
                      <button className="rmp-icon-btn" onClick={() => setForm({ ...rep })}>
                        <Pencil size={14}/>
                      </button>
                      <button className="rmp-icon-btn rmp-icon-btn--del" onClick={() => setConfirm(rep)}>
                        <Trash2 size={14}/>
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {!filtered.length && (
                <tr><td colSpan={isAdmin ? 9 : 8} className="rmp-empty">لا يوجد مناديب</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Add/Edit Modal */}
      {form && (
        <Modal title={form.id ? 'تعديل مندوب' : 'إضافة مندوب جديد'} onClose={() => setForm(null)}>
          <div className="rmp-form-grid">
            <Field label="الاسم بالعربية *">
              <input className="rmp-input" value={form.name_ar}
                onChange={e => setForm(f => ({...f, name_ar: e.target.value}))} />
            </Field>
            <Field label="الاسم بالإنجليزية">
              <input className="rmp-input" value={form.name_en || ''}
                onChange={e => setForm(f => ({...f, name_en: e.target.value}))} />
            </Field>
            <Field label="الاسم في NetSuite">
              <input className="rmp-input" list="ns-list" value={form.netsuite_name || ''}
                onChange={e => setForm(f => ({...f, netsuite_name: e.target.value}))}
                placeholder="الاسم الظاهر في تقارير المبيعات" />
              <datalist id="ns-list">
                {nsNames.map(n => <option key={n} value={n}/>)}
              </datalist>
            </Field>
            <Field label="المنطقة">
              <select className="rmp-input" value={form.region_id || ''}
                onChange={e => setForm(f => ({...f, region_id: e.target.value}))}>
                <option value="">— اختر —</option>
                {regionList.map(r => <option key={r.id} value={r.id}>{r.name || r.name_ar}</option>)}
              </select>
            </Field>
            <Field label="خط السير">
              <select className="rmp-input" value={form.route_id || ''}
                onChange={e => setForm(f => ({...f, route_id: e.target.value}))}>
                <option value="">— اختر —</option>
                {routes.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              {!form.route_id && form.suggested_route_id && (
                <button type="button" className="rmp-suggest-btn"
                  onClick={() => setForm(f => ({...f, route_id: String(f.suggested_route_id)}))}>
                  اقتراح: خط {form.suggested_route_id} (بناءً على الفواتير) — اضغط للتطبيق
                </button>
              )}
            </Field>
            <Field label="رقم السيارة">
              <input className="rmp-input" value={form.vehicle_number || ''}
                onChange={e => setForm(f => ({...f, vehicle_number: e.target.value}))}
                placeholder="مثال: ر و ع 6768" />
            </Field>
            {ROLES_ORDER.map(role => (
              <Field key={role} label={ROLE_LABELS[role]}>
                <select className="rmp-input" value={form[`${role}_id`] || ''}
                  onChange={e => setForm(f => ({...f, [`${role}_id`]: e.target.value}))}>
                  <option value="">— اختر —</option>
                  {(mgrByRole[role]||[]).map(m => <option key={m.id} value={m.id}>{m.name_ar}</option>)}
                </select>
              </Field>
            ))}
          </div>
          {saveMutation.isError && <p className="rmp-error-msg">{saveMutation.error?.response?.data?.error || 'خطأ في الحفظ'}</p>}
          <div className="rmp-modal-footer">
            <button className="rmp-btn rmp-btn--save" onClick={handleSave} disabled={saveMutation.isPending}>
              <Check size={14}/> {saveMutation.isPending ? 'جارٍ الحفظ…' : 'حفظ'}
            </button>
            <button className="rmp-btn rmp-btn--cancel" onClick={() => setForm(null)}>إلغاء</button>
          </div>
        </Modal>
      )}

      {/* Delete Confirm */}
      {confirm && (
        <Modal title="تأكيد الحذف" onClose={() => setConfirm(null)}>
          <p className="rmp-confirm-text">هل تريد حذف المندوب <strong>{confirm.name_ar}</strong>؟</p>
          <div className="rmp-modal-footer">
            <button className="rmp-btn rmp-btn--del-confirm" onClick={() => deleteMutation.mutate(confirm.id)}
              disabled={deleteMutation.isPending}>
              <Trash2 size={14}/> حذف
            </button>
            <button className="rmp-btn rmp-btn--cancel" onClick={() => setConfirm(null)}>إلغاء</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   TAB: المديرون
════════════════════════════════════════════════════════════════ */
function ManagersTab({ isAdmin }) {
  const qc = useQueryClient();
  const { data: managers = [], isLoading } = useQuery({ queryKey: ['rep-managers'], queryFn: api.managers });
  const [form, setForm]     = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [activeRole, setActiveRole] = useState('all');

  const displayed = activeRole === 'all' ? managers : managers.filter(m => m.role === activeRole);

  const saveMutation = useMutation({
    mutationFn: data => data.id
      ? client.put(`/sales-reps/managers/${data.id}`, data)
      : client.post('/sales-reps/managers', data),
    onSuccess: () => { qc.invalidateQueries(['rep-managers']); setForm(null); },
  });
  const deleteMutation = useMutation({
    mutationFn: id => client.delete(`/sales-reps/managers/${id}`),
    onSuccess: () => { qc.invalidateQueries(['rep-managers']); setConfirm(null); },
  });

  return (
    <div className="rmp-tab-content">
      <div className="rmp-tab-toolbar">
        <div className="rmp-role-filter">
          <button className={`rmp-role-btn${activeRole==='all'?' rmp-role-btn--active':''}`}
                  onClick={() => setActiveRole('all')}>الكل</button>
          {ROLES_ORDER.map(role => (
            <button key={role} className={`rmp-role-btn${activeRole===role?' rmp-role-btn--active':''}`}
                    onClick={() => setActiveRole(role)}>
              {ROLE_LABELS[role]}
            </button>
          ))}
        </div>
        {isAdmin && (
          <button className="rmp-btn rmp-btn--add" onClick={() => setForm({ ...BLANK_MGR })}>
            <Plus size={15}/> إضافة
          </button>
        )}
      </div>

      {isLoading ? <div className="rmp-loading">جارٍ التحميل…</div> : (
        <div className="rmp-table-wrap">
          <table className="rmp-table">
            <thead><tr><th>الاسم</th><th>الدور</th><th>المنطقة</th>{isAdmin && <th>إجراءات</th>}</tr></thead>
            <tbody>
              {displayed.map(m => (
                <tr key={m.id}>
                  <td><strong>{m.name_ar}</strong>{m.name_en && <span className="rmp-muted"> · {m.name_en}</span>}</td>
                  <td><span className={`rmp-role-badge rmp-role-badge--${m.role}`}>{ROLE_LABELS[m.role]}</span></td>
                  <td>{m.region_name || <span className="rmp-muted">—</span>}</td>
                  {isAdmin && (
                    <td className="rmp-actions">
                      <button className="rmp-icon-btn" onClick={() => setForm({...m})}><Pencil size={14}/></button>
                      <button className="rmp-icon-btn rmp-icon-btn--del" onClick={() => setConfirm(m)}><Trash2 size={14}/></button>
                    </td>
                  )}
                </tr>
              ))}
              {!displayed.length && <tr><td colSpan={isAdmin?4:3} className="rmp-empty">لا يوجد بيانات</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {form && (
        <Modal title={form.id ? 'تعديل' : 'إضافة مدير/مشرف'} onClose={() => setForm(null)}>
          <div className="rmp-form-grid">
            <Field label="الاسم بالعربية *">
              <input className="rmp-input" value={form.name_ar}
                onChange={e => setForm(f => ({...f, name_ar: e.target.value}))}/>
            </Field>
            <Field label="الاسم بالإنجليزية">
              <input className="rmp-input" value={form.name_en||''}
                onChange={e => setForm(f => ({...f, name_en: e.target.value}))}/>
            </Field>
            <Field label="الدور *">
              <select className="rmp-input" value={form.role}
                onChange={e => setForm(f => ({...f, role: e.target.value}))}>
                {ROLES_ORDER.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </Field>
          </div>
          {saveMutation.isError && <p className="rmp-error-msg">{saveMutation.error?.response?.data?.error}</p>}
          <div className="rmp-modal-footer">
            <button className="rmp-btn rmp-btn--save" onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending}>
              <Check size={14}/> {saveMutation.isPending ? 'جارٍ الحفظ…' : 'حفظ'}
            </button>
            <button className="rmp-btn rmp-btn--cancel" onClick={() => setForm(null)}>إلغاء</button>
          </div>
        </Modal>
      )}

      {confirm && (
        <Modal title="تأكيد الحذف" onClose={() => setConfirm(null)}>
          <p className="rmp-confirm-text">هل تريد حذف <strong>{confirm.name_ar}</strong>؟</p>
          <div className="rmp-modal-footer">
            <button className="rmp-btn rmp-btn--del-confirm" onClick={() => deleteMutation.mutate(confirm.id)}>
              <Trash2 size={14}/> حذف
            </button>
            <button className="rmp-btn rmp-btn--cancel" onClick={() => setConfirm(null)}>إلغاء</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   TAB: الأهداف الشهرية
════════════════════════════════════════════════════════════════ */
function TargetsTab({ isAdmin }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canSendApprovals = user && SEND_APPROVAL_ROLES.includes(user.role);
  const [year, setYear]   = useState(CUR_YEAR);
  const [month, setMonth] = useState(CUR_MONTH);
  const [saving, setSaving] = useState(false);
  const [sendingApprovals, setSendingApprovals] = useState(false);
  const [drafts, setDrafts] = useState({});  // repId → target fields
  const [uploadResult, setUploadResult] = useState(null);
  const [copyPrev, setCopyPrev]         = useState(null); // confirmation payload
  const [copyResult, setCopyResult]     = useState(null);
  const [regionFilter, setRegionFilter] = useState('');
  const fileRef = useRef();

  const { data: reps = [] }    = useQuery({ queryKey: ['sales-reps'],   queryFn: api.reps });
  const { data: targets = [] } = useQuery({
    queryKey: ['rep-targets', year, month],
    queryFn:  () => api.targets(year, month),
  });
  const { data: suggested = {} } = useQuery({
    queryKey: ['rep-targets-suggested', year, month],
    queryFn:  () => api.suggestedTargets(year, month),
  });
  const { data: approvalStatus = { regions: {} } } = useQuery({
    queryKey: ['target-approvals-status', year, month],
    queryFn:  () => api.approvalStatus(year, month),
  });

  async function handleSendApprovals() {
    setSendingApprovals(true);
    try {
      const regionId = regionFilter
        ? reps.find(r => (r.region_name || 'غير محدد') === regionFilter)?.region_id
        : null;
      await api.sendApprovals(year, month, regionId);
      qc.invalidateQueries({ queryKey: ['target-approvals-status', year, month] });
    } finally {
      setSendingApprovals(false);
    }
  }

  // Merge targets into drafts when data changes
  React.useEffect(() => {
    const map = {};
    targets.forEach(t => { map[t.rep_id] = t; });
    reps.forEach(r => {
      if (!map[r.id]) map[r.id] = { rep_id: r.id, qty_target_chilled:0, qty_target_cuts:0, qty_target_frozen:0, customer_target:0, collection_target_pct:0, credit_limit:0 };
    });
    setDrafts(map);
  }, [targets, reps]);

  function setField(repId, field, val) {
    setDrafts(d => ({ ...d, [repId]: { ...(d[repId] || {}), rep_id: repId, [field]: val } }));
  }

  /* Copy the previous month's targets into the on-screen values. It fills the
     inputs only — nothing is written until "حفظ الكل" is pressed, so the copy
     can be reviewed (or abandoned by switching month) before it becomes real. */
  const prevPeriod = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const prevLabel  = `${MONTHS.find(x => x.v === prevPeriod.m)?.l} ${prevPeriod.y}`;

  async function requestCopyPrev() {
    setCopyResult(null);
    let rows = [];
    try {
      rows = await api.targets(prevPeriod.y, prevPeriod.m);
    } catch {
      setCopyResult({ error: 'تعذّر جلب أهداف الشهر السابق' });
      return;
    }
    const src = {};
    rows.forEach(t => { src[t.rep_id] = t; });
    const scope = filteredReps;
    const withSource = scope.filter(r => src[r.id]);
    if (!withSource.length) {
      setCopyResult({ error: `لا توجد أهداف محفوظة لـ${prevLabel}` });
      return;
    }
    // Anything already typed for this month would be replaced — say how much.
    const overwrite = scope.filter(r => {
      const d = drafts[r.id] || {};
      return ['qty_target_chilled','qty_target_cuts','qty_target_frozen',
              'customer_target','collection_target_pct','credit_limit']
        .some(k => Number(d[k] || 0) !== 0);
    }).length;
    setCopyPrev({ src, scope, copied: withSource.length,
                  missing: scope.length - withSource.length, overwrite });
  }

  function applyCopyPrev() {
    if (!copyPrev) return;
    const { src, scope } = copyPrev;
    setDrafts(d => {
      const next = { ...d };
      scope.forEach(r => {
        const t = src[r.id];
        if (!t) return;
        next[r.id] = {
          ...(next[r.id] || {}), rep_id: r.id,
          qty_target_chilled:    Number(t.qty_target_chilled    || 0),
          qty_target_cuts:       Number(t.qty_target_cuts       || 0),
          qty_target_frozen:     Number(t.qty_target_frozen     || 0),
          customer_target:       Number(t.customer_target       || 0),
          collection_target_pct: Number(t.collection_target_pct || 0),
          credit_limit:          Number(t.credit_limit          || 0),
        };
      });
      return next;
    });
    setCopyResult({ copied: copyPrev.copied, missing: copyPrev.missing, from: prevLabel });
    setCopyPrev(null);
  }

  async function saveAll() {
    setSaving(true);
    const rows = Object.values(drafts).map(d => ({ ...d, year, month }));
    try {
      await client.put('/sales-reps/targets', rows);
      qc.invalidateQueries(['rep-targets', year, month]);
    } finally {
      setSaving(false);
    }
  }

  async function handleExcelUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await client.post('/sales-reps/targets/upload', fd);
      setUploadResult(r.data);
      qc.invalidateQueries(['rep-targets', year, month]);
    } catch (err) {
      setUploadResult({ error: err?.response?.data?.error || 'خطأ في الرفع' });
    }
    e.target.value = '';
  }

  async function downloadTemplate() {
    const XLSX = await import('xlsx');
    const rows = reps.map(r => ({
      'اسم المندوب':    r.name_ar,
      'السنة':           year,
      'الشهر':           month,
      'هدف الكمية - دجاج مبرد طرية': 0,
      'هدف الكمية - مقطعات طرية':    0,
      'هدف الكمية - دجاج مجمد':      0,
      'هدف العملاء':    0,
      'هدف التحصيل (%)': 0,
      'الحد الائتماني': 0,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'الأهداف');
    XLSX.writeFile(wb, `template_targets_${year}_${month}.xlsx`);
  }

  async function exportData() {
    const XLSX = await import('xlsx');
    const rows = filteredReps.map(rep => {
      const d = drafts[rep.id] || {};
      const qtyTotal = Number(d.qty_target_chilled||0) + Number(d.qty_target_cuts||0) + Number(d.qty_target_frozen||0);
      return {
        'المنطقة':          rep.region_name || 'غير محدد',
        'اسم المندوب':      rep.name_ar,
        'السنة':            year,
        'الشهر':            month,
        'هدف الكمية - دجاج مبرد طرية': d.qty_target_chilled || 0,
        'هدف الكمية - مقطعات طرية':    d.qty_target_cuts    || 0,
        'هدف الكمية - دجاج مجمد':      d.qty_target_frozen  || 0,
        'إجمالي هدف الكمية': qtyTotal,
        'هدف العملاء':      d.customer_target || 0,
        'هدف التحصيل (%)':  d.collection_target_pct || 0,
        'الحد الائتماني':   d.credit_limit || 0,
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'الأهداف');
    XLSX.writeFile(wb, `أهداف_المناديب_${year}_${month}.xlsx`);
  }

  // Distinct region names for the filter dropdown (from the full unfiltered list)
  const regionNames = [...new Set(reps.map(r => r.region_name || 'غير محدد'))].sort();

  // Group reps by region (respects the region filter)
  const filteredReps = regionFilter ? reps.filter(r => (r.region_name || 'غير محدد') === regionFilter) : reps;
  const byRegion = {};
  filteredReps.forEach(r => {
    const rn = r.region_name || 'غير محدد';
    if (!byRegion[rn]) byRegion[rn] = [];
    byRegion[rn].push(r);
  });

  const years = [CUR_YEAR - 1, CUR_YEAR, CUR_YEAR + 1];

  // Sum target fields across a list of reps (region subtotal / grand total rows)
  function sumTargets(repsList) {
    return repsList.reduce((s, rep) => {
      const d = drafts[rep.id] || {};
      s.qty_target_chilled += Number(d.qty_target_chilled || 0);
      s.qty_target_cuts    += Number(d.qty_target_cuts    || 0);
      s.qty_target_frozen  += Number(d.qty_target_frozen  || 0);
      s.customer_target    += Number(d.customer_target    || 0);
      s.credit_limit       += Number(d.credit_limit       || 0);
      s.collection_pct_sum += Number(d.collection_target_pct || 0);
      s.count += 1;
      return s;
    }, { qty_target_chilled:0, qty_target_cuts:0, qty_target_frozen:0, customer_target:0, credit_limit:0, collection_pct_sum:0, count:0 });
  }

  function TotalRow({ label, repsList, cls }) {
    const t = sumTargets(repsList);
    const qtyTotal = t.qty_target_chilled + t.qty_target_cuts + t.qty_target_frozen;
    const avgPct = t.count > 0 ? (t.collection_pct_sum / t.count) : 0;
    const maxDebt = t.credit_limit * 1.10;
    return (
      <tr className={cls}>
        <td className="rmp-rep-name">{label}</td>
        <td>{t.qty_target_chilled.toLocaleString('en-SA')}</td>
        <td>{t.qty_target_cuts.toLocaleString('en-SA')}</td>
        <td>{t.qty_target_frozen.toLocaleString('en-SA')}</td>
        <td className="rmp-td-total">{qtyTotal.toLocaleString('en-SA')}</td>
        <td>{t.customer_target.toLocaleString('en-SA')}</td>
        <td>{avgPct ? `${avgPct.toFixed(1)}%` : '—'}</td>
        <td>{t.credit_limit.toLocaleString('en-SA')}</td>
        <td className="rmp-td-hint">
          {maxDebt > 0 ? `≤ ${maxDebt.toLocaleString('en-SA',{maximumFractionDigits:0})} ر.س` : '—'}
        </td>
        <td/>
      </tr>
    );
  }

  return (
    <div className="rmp-tab-content">
      <div className="rmp-tab-toolbar rmp-tab-toolbar--targets">
        <div className="rmp-period-pick">
          <select className="rmp-input rmp-input--sm" value={month} onChange={e => setMonth(Number(e.target.value))}>
            {MONTHS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
          </select>
          <select className="rmp-input rmp-input--sm" value={year} onChange={e => setYear(Number(e.target.value))}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <select className="rmp-input rmp-input--sm" value={regionFilter} onChange={e => setRegionFilter(e.target.value)}>
            <option value="">كل المناطق</option>
            {regionNames.map(rn => <option key={rn} value={rn}>{rn}</option>)}
          </select>
        </div>
        <button className="rmp-btn rmp-btn--export" onClick={exportData}>
          <FileSpreadsheet size={14}/> تصدير Excel
        </button>
        {isAdmin && (<>
          <button className="rmp-btn rmp-btn--copy" onClick={requestCopyPrev}
                  title={`نسخ أهداف ${prevLabel} إلى ${MONTHS.find(x => x.v === month)?.l} ${year}`}>
            <Copy size={14}/> نسخ أهداف الشهر السابق
          </button>
          <button className="rmp-btn rmp-btn--dl" onClick={downloadTemplate}>
            <Download size={14}/> تحميل قالب Excel
          </button>
          <button className="rmp-btn rmp-btn--upload" onClick={() => fileRef.current.click()}>
            <Upload size={14}/> رفع Excel
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" hidden onChange={handleExcelUpload}/>
          <button className="rmp-btn rmp-btn--save" onClick={saveAll} disabled={saving}>
            <Check size={14}/> {saving ? 'جارٍ الحفظ…' : 'حفظ الكل'}
          </button>
        </>)}
        {canSendApprovals && (
          <button className="rmp-btn rmp-btn--send" onClick={handleSendApprovals} disabled={sendingApprovals}>
            <Send size={14}/> {sendingApprovals ? 'جارٍ الإرسال…' : (regionFilter ? `إرسال اعتماد ${regionFilter}` : 'إرسال للاعتماد (كل المناطق)')}
          </button>
        )}
      </div>

      {copyResult && (
        <div className={`rmp-upload-result ${copyResult.error ? 'rmp-upload-result--err' : 'rmp-upload-result--ok'}`}>
          {copyResult.error
            ? `❌ ${copyResult.error}`
            : `✅ تم نسخ أهداف ${copyResult.from} إلى ${copyResult.copied} مندوب`
              + (copyResult.missing ? ` — ${copyResult.missing} مندوب بلا أهداف في الشهر السابق تُركوا كما هم` : '')
              + ' · لم يُحفظ بعد، راجع القيم ثم اضغط «حفظ الكل»'}
          <button className="rmp-upload-close" onClick={() => setCopyResult(null)}><X size={12}/></button>
        </div>
      )}

      {copyPrev && (
        <Modal title="نسخ أهداف الشهر السابق" onClose={() => setCopyPrev(null)}>
          <p className="rmp-confirm-text">
            نسخ أهداف <strong>{prevLabel}</strong> إلى <strong>{MONTHS.find(x => x.v === month)?.l} {year}</strong>
            {regionFilter ? <> لمنطقة <strong>{regionFilter}</strong></> : ' لكل المناطق'} —
            <strong> {copyPrev.copied}</strong> مندوب.
          </p>
          {copyPrev.missing > 0 && (
            <p className="rmp-confirm-text">
              {copyPrev.missing} مندوب بلا أهداف في {prevLabel} — ستبقى قيمهم كما هي.
            </p>
          )}
          {copyPrev.overwrite > 0 && (
            <p className="rmp-confirm-text rmp-confirm-text--warn">
              ⚠ {copyPrev.overwrite} مندوب لديهم قيم مُدخلة لهذا الشهر وسيتم استبدالها.
            </p>
          )}
          <p className="rmp-confirm-text rmp-muted">
            النسخ يملأ الحقول على الشاشة فقط — لن يُحفظ حتى تضغط «حفظ الكل».
          </p>
          <div className="rmp-modal-footer">
            <button className="rmp-btn rmp-btn--save" onClick={applyCopyPrev}>
              <Check size={14}/> نسخ
            </button>
            <button className="rmp-btn rmp-btn--cancel" onClick={() => setCopyPrev(null)}>إلغاء</button>
          </div>
        </Modal>
      )}

      {uploadResult && (
        <div className={`rmp-upload-result ${uploadResult.error ? 'rmp-upload-result--err' : 'rmp-upload-result--ok'}`}>
          {uploadResult.error
            ? `❌ ${uploadResult.error}`
            : `✅ تم حفظ ${uploadResult.saved} مندوب${uploadResult.errors?.length ? ` — ${uploadResult.errors.length} خطأ` : ''}`}
          <button className="rmp-upload-close" onClick={() => setUploadResult(null)}><X size={12}/></button>
        </div>
      )}

      <div className="rmp-approval-summary">
        <div className="rmp-approval-summary-title">📋 ملخص حالة الاعتماد</div>
        <div className="rmp-table-wrap">
          <table className="rmp-table rmp-table--approval-summary">
            <thead>
              <tr>
                <th>المنطقة</th>
                <th>حالة الاعتماد</th>
                <th>المعتمدون</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(byRegion).map(([region, regionReps]) => {
                const regionId = regionReps[0]?.region_id;
                const approval = approvalStatus.regions?.[regionId];
                return (
                  <tr key={region}>
                    <td className="rmp-rep-name">📍 {region}</td>
                    <td>
                      {!approval ? (
                        <span className="rmp-approval-badge rmp-approval-badge--none"><Clock size={12}/> لم يُرسل بعد</span>
                      ) : approval.approvals?.length ? (
                        <span className="rmp-approval-badge rmp-approval-badge--sent"><CheckCircle2 size={12}/> تم الاعتماد</span>
                      ) : (
                        <span className="rmp-approval-badge rmp-approval-badge--pending">بانتظار الموافقة</span>
                      )}
                    </td>
                    <td>
                      {approval?.approvals?.length ? (
                        <div className="rmp-approval-chips">
                          {approval.approvals.map(a => (
                            <span key={a.user_id} className="rmp-approval-chip">
                              <CheckCircle2 size={11}/> {a.name}
                              <span className="rmp-approval-chip-time">{fmtApprovedAt(a.approved_at)}</span>
                            </span>
                          ))}
                        </div>
                      ) : '—'}
                    </td>
                  </tr>
                );
              })}
              {!Object.keys(byRegion).length && (
                <tr><td colSpan={3} className="rmp-empty">لا توجد بيانات</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rmp-table-wrap">
        <table className="rmp-table rmp-table--targets">
          <thead>
            <tr>
              <th rowSpan={2}>المنطقة / المندوب</th>
              <th colSpan={4} className="rmp-th-group">هدف الكمية</th>
              <th rowSpan={2}>هدف العملاء</th>
              <th rowSpan={2}>هدف التحصيل (%)</th>
              <th rowSpan={2}>الحد الائتماني (ر.س)</th>
              <th rowSpan={2} className="rmp-th-hint">الحد الأقصى للمديونية = 110%</th>
              <th rowSpan={2}>حالة التعميد</th>
            </tr>
            <tr>
              <th className="rmp-th-sub">دجاج مبرد طرية</th>
              <th className="rmp-th-sub">مقطعات طرية</th>
              <th className="rmp-th-sub">دجاج مجمد</th>
              <th className="rmp-th-sub rmp-th-total">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(byRegion).map(([region, regionReps]) => {
              const regionId = regionReps[0]?.region_id;
              const approval = approvalStatus.regions?.[regionId];
              return (
              <React.Fragment key={region}>
                <tr className="rmp-region-sep">
                  <td colSpan={9}>📍 {region}</td>
                  <td className="rmp-approval-cell">
                    {!approval ? (
                      <span className="rmp-approval-badge rmp-approval-badge--none"><Clock size={12}/> لم يُرسل بعد</span>
                    ) : (
                      <div className="rmp-approval-info">
                        <span className="rmp-approval-badge rmp-approval-badge--sent">
                          <Send size={12}/> أُرسلت بواسطة {approval.sent_by_name || '—'}
                        </span>
                        {approval.approvals?.length ? (
                          <div className="rmp-approval-chips">
                            {approval.approvals.map(a => (
                              <span key={a.user_id} className="rmp-approval-chip">
                                <CheckCircle2 size={11}/> {a.name}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="rmp-approval-badge rmp-approval-badge--pending">بانتظار الموافقة</span>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
                {regionReps.map(rep => {
                  const d = drafts[rep.id] || {};
                  const maxDebt = d.credit_limit ? (d.credit_limit * 1.10) : 0;
                  const qtyTotal = Number(d.qty_target_chilled||0) + Number(d.qty_target_cuts||0) + Number(d.qty_target_frozen||0);
                  const sug = suggested[rep.id];
                  return (
                    <tr key={rep.id} className="rmp-target-row">
                      <td className="rmp-rep-name">{rep.name_ar}</td>
                      {isAdmin ? (<>
                        <td>
                          <input type="number" min="0" className="rmp-num-input" value={d.qty_target_chilled||0}
                              onChange={e => setField(rep.id,'qty_target_chilled',Number(e.target.value))}/>
                          {sug?.qty_target_chilled_suggested != null &&
                            <div className="rmp-suggested-hint">استرشادي: {sug.qty_target_chilled_suggested.toLocaleString('en-SA')}</div>}
                        </td>
                        <td>
                          <input type="number" min="0" className="rmp-num-input" value={d.qty_target_cuts||0}
                              onChange={e => setField(rep.id,'qty_target_cuts',Number(e.target.value))}/>
                          {sug?.qty_target_cuts_suggested != null &&
                            <div className="rmp-suggested-hint">استرشادي: {sug.qty_target_cuts_suggested.toLocaleString('en-SA')}</div>}
                        </td>
                        <td>
                          <input type="number" min="0" className="rmp-num-input" value={d.qty_target_frozen||0}
                              onChange={e => setField(rep.id,'qty_target_frozen',Number(e.target.value))}/>
                          {sug?.qty_target_frozen_suggested != null &&
                            <div className="rmp-suggested-hint">استرشادي: {sug.qty_target_frozen_suggested.toLocaleString('en-SA')}</div>}
                        </td>
                        <td className="rmp-td-total">{qtyTotal.toLocaleString('en-SA')}</td>
                        <td><input type="number" min="0" className="rmp-num-input" value={d.customer_target||0}
                              onChange={e => setField(rep.id,'customer_target',Number(e.target.value))}/></td>
                        <td className="rmp-pct-cell">
                          <input type="number" min="0" max="100" className="rmp-num-input" value={d.collection_target_pct||0}
                            onChange={e => setField(rep.id,'collection_target_pct',Math.min(100,Math.max(0,Number(e.target.value))))}/>
                          <span className="rmp-pct-sign">%</span>
                        </td>
                        <td><input type="number" min="0" className="rmp-num-input" value={d.credit_limit||0}
                              onChange={e => setField(rep.id,'credit_limit',Number(e.target.value))}/></td>
                        <td className="rmp-td-hint">
                          {maxDebt > 0 ? `≤ ${maxDebt.toLocaleString('en-SA',{maximumFractionDigits:0})} ر.س` : '—'}
                        </td>
                      </>) : (<>
                        <td>{(d.qty_target_chilled||0).toLocaleString('en-SA')}</td>
                        <td>{(d.qty_target_cuts||0).toLocaleString('en-SA')}</td>
                        <td>{(d.qty_target_frozen||0).toLocaleString('en-SA')}</td>
                        <td className="rmp-td-total">{qtyTotal.toLocaleString('en-SA')}</td>
                        <td>{(d.customer_target||0).toLocaleString('en-SA')}</td>
                        <td>{(d.collection_target_pct||0)}%</td>
                        <td>{(d.credit_limit||0).toLocaleString('en-SA')}</td>
                        <td className="rmp-td-hint">
                          {maxDebt > 0 ? `≤ ${maxDebt.toLocaleString('en-SA',{maximumFractionDigits:0})} ر.س` : '—'}
                        </td>
                      </>)}
                      <td/>
                    </tr>
                  );
                })}
                <TotalRow label={`إجمالي ${region}`} repsList={regionReps} cls="rmp-region-total"/>
              </React.Fragment>
              );
            })}
            {!filteredReps.length && <tr><td colSpan={10} className="rmp-empty">لا يوجد مناديب{regionFilter ? ` في منطقة ${regionFilter}` : ' — أضف مناديب أولاً'}</td></tr>}
            {filteredReps.length > 0 && <TotalRow label="الإجمالي العام" repsList={filteredReps} cls="rmp-grand-total"/>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   TAB: الهيكل التنظيمي (org chart)

   `rep_managers` stores no parent FK — the reporting line only exists
   implicitly in each rep's row (sales_manager_id → sector_manager_id →
   region_manager_id → supervisor_id). So the tree is *derived*: every rep
   row casts a vote linking each manager in its chain to the one above it,
   and a manager's parent is the majority winner. Nulls are skipped, so a
   rep with no sector manager links its region manager straight to the
   sales manager instead of dropping out of the chart.
════════════════════════════════════════════════════════════════ */
const ORG_CHAIN = ['sales_manager_id', 'sector_manager_id', 'region_manager_id', 'supervisor_id'];

// A rep counts as properly assigned if it has a supervisor OR a region manager.
// Anything shallower (sector / sales manager only, or nothing at all) is what the
// "بلا مشرف أو مدير منطقة" toggle hides.
const ORG_DIRECT_ROLES = ['supervisor', 'region_manager'];
const ORG_DIRECT_KEYS  = ['supervisor_id', 'region_manager_id'];
const hasDirectBoss = rep => ORG_DIRECT_KEYS.some(k => rep[k] != null && rep[k] !== '');

function buildOrgModel(reps, managers) {
  const mgrById = new Map(managers.map(m => [Number(m.id), m]));

  const votes      = new Map();  // childId → Map(parentId → count)
  const repsUnder  = new Map();  // managerId → rep[]  (attached at the deepest assigned level)
  const orphanReps = [];

  const vote = (child, parent) => {
    if (!votes.has(child)) votes.set(child, new Map());
    const v = votes.get(child);
    v.set(parent, (v.get(parent) || 0) + 1);
  };

  reps.forEach(rep => {
    const chain = ORG_CHAIN
      .map(k => (rep[k] == null || rep[k] === '' ? null : Number(rep[k])))
      .filter(id => id != null && mgrById.has(id));
    for (let i = 1; i < chain.length; i++) vote(chain[i], chain[i - 1]);
    const leaf = chain[chain.length - 1];
    if (leaf == null) { orphanReps.push(rep); return; }
    if (!repsUnder.has(leaf)) repsUnder.set(leaf, []);
    repsUnder.get(leaf).push(rep);
  });

  // Majority parent; remember when a manager was seen under more than one boss.
  const parentOf  = new Map();
  const ambiguous = new Set();
  votes.forEach((v, child) => {
    let best = null, bestN = -1;
    v.forEach((n, p) => { if (n > bestN) { best = p; bestN = n; } });
    parentOf.set(child, best);
    if (v.size > 1) ambiguous.add(child);
  });

  // Safety net against dirty data producing a reporting cycle (would hang the render).
  [...parentOf.keys()].forEach(child => {
    const seen = new Set([child]);
    let cur = parentOf.get(child);
    while (cur != null) {
      if (seen.has(cur)) { parentOf.delete(child); break; }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  });

  const childrenOf = new Map();
  managers.forEach(m => childrenOf.set(Number(m.id), []));
  parentOf.forEach((parent, child) => {
    if (parent != null && childrenOf.has(parent)) childrenOf.get(parent).push(child);
  });

  const roleRank = id => {
    const idx = ROLES_ORDER.indexOf(mgrById.get(id)?.role);
    return idx === -1 ? 99 : idx;
  };
  childrenOf.forEach(list => list.sort((a, b) =>
    roleRank(a) - roleRank(b) || (mgrById.get(a)?.name_ar || '').localeCompare(mgrById.get(b)?.name_ar || '', 'ar')
  ));

  const roots = [], unlinked = [];
  managers.forEach(m => {
    const id = Number(m.id);
    if (parentOf.has(id)) return;
    if (childrenOf.get(id)?.length || repsUnder.has(id)) roots.push(id);
    else unlinked.push(m);
  });
  roots.sort((a, b) => roleRank(a) - roleRank(b) || (mgrById.get(a)?.name_ar || '').localeCompare(mgrById.get(b)?.name_ar || '', 'ar'));

  // Total reps under each node, including every descendant.
  const totalReps = new Map();
  const countReps = id => {
    if (totalReps.has(id)) return totalReps.get(id);
    totalReps.set(id, 0);   // cycle guard
    const n = (repsUnder.get(id)?.length || 0)
      + (childrenOf.get(id) || []).reduce((s, c) => s + countReps(c), 0);
    totalReps.set(id, n);
    return n;
  };
  managers.forEach(m => countReps(Number(m.id)));

  return { mgrById, childrenOf, repsUnder, roots, unlinked, orphanReps, ambiguous, totalReps };
}

function OrgNode({ id, model, totals, isRoot, collapsed, toggle, matches, searching, showNoSup }) {
  const m        = model.mgrById.get(id);
  const kids     = model.childrenOf.get(id) || [];
  const allReps  = model.repsUnder.get(id) || [];
  // Reps hang off the deepest manager assigned to them, so the ones sitting on a
  // node that is neither a supervisor nor a region manager are exactly the reps
  // with no direct boss.
  const myReps   = (showNoSup || ORG_DIRECT_ROLES.includes(m?.role)) ? allReps : [];
  const hiddenN  = allReps.length - myReps.length;
  const hasKids  = kids.length > 0 || myReps.length > 0;
  const isOpen   = searching || !collapsed.has(id);
  const isMatch  = matches.has(`m${id}`);
  if (!m) return null;

  return (
    <li className={`rmp-org-li${isRoot ? ' rmp-org-li--root' : ''}`}>
      <div className="rmp-org-card-wrap">
        <div className={`rmp-org-card rmp-org-card--${m.role}${isMatch ? ' rmp-org-card--match' : ''}`}>
          <div className="rmp-org-role">{ROLE_LABELS[m.role] || m.role}</div>
          <div className="rmp-org-name">{m.name_ar}</div>
          {m.name_en && <div className="rmp-org-name-en">{m.name_en}</div>}
          <div className="rmp-org-meta">
            {totals.get(id) > 0 && (
              <span className="rmp-org-badge" title="إجمالي المناديب تحت إشرافه">
                👤 {totals.get(id)}
              </span>
            )}
            {kids.length > 0 && (
              <span className="rmp-org-badge" title="عدد التابعين المباشرين من الإدارة">
                ⛓ {kids.length}
              </span>
            )}
            {hiddenN > 0 && (
              <span className="rmp-org-badge rmp-org-badge--hidden" title="مناديب بلا مشرف أو مدير منطقة — مخفيون حالياً">
                🚫 {hiddenN}
              </span>
            )}
            {model.ambiguous.has(id) && (
              <span className="rmp-org-badge rmp-org-badge--warn" title="مُسند لأكثر من رئيس في بيانات المناديب — يظهر تحت الأكثر تكراراً">
                <AlertTriangle size={10}/>
              </span>
            )}
          </div>
          {hasKids && !searching && (
            <button className="rmp-org-toggle" onClick={() => toggle(id)}
              title={isOpen ? 'طي' : 'توسيع'}>
              {isOpen ? <Minus size={11}/> : <Plus size={11}/>}
            </button>
          )}
        </div>
      </div>

      {isOpen && hasKids && (
        <ul className="rmp-org-ul">
          {kids.map(cid => (
            <OrgNode key={cid} id={cid} model={model} totals={totals} collapsed={collapsed}
              toggle={toggle} matches={matches} searching={searching} showNoSup={showNoSup}/>
          ))}
          {myReps.length > 0 && (
            <li className="rmp-org-li">
              <div className="rmp-org-card-wrap">
                <div className={`rmp-org-team${!ORG_DIRECT_ROLES.includes(m.role) ? ' rmp-org-team--nosup' : ''}`}>
                  <div className="rmp-org-team-hdr">
                    المناديب ({myReps.length})
                    {!ORG_DIRECT_ROLES.includes(m.role) &&
                      <span className="rmp-org-team-tag">بلا مشرف أو مدير منطقة</span>}
                  </div>
                  <div className="rmp-org-team-chips">
                    {myReps.map(r => (
                      <span key={r.id}
                        className={`rmp-org-rep${matches.has(`r${r.id}`) ? ' rmp-org-rep--match' : ''}`}>
                        <span className="rmp-org-rep-name">{r.name_ar}</span>
                        <bdi className="rmp-org-rep-sub">
                          {r.route_id ? `خط ${r.route_id}` : '—'}{r.region_name ? ` · ${r.region_name}` : ''}
                        </bdi>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function OrgChartTab() {
  const { data: reps = [],     isLoading: l1 } = useQuery({ queryKey: ['sales-reps'],   queryFn: api.reps });
  const { data: managers = [], isLoading: l2 } = useQuery({ queryKey: ['rep-managers'], queryFn: api.managers });

  const [collapsed, setCollapsed] = useState(() => new Set());
  const [zoom, setZoom]           = useState(1);
  const [search, setSearch]       = useState('');
  const [showNoSup, setShowNoSup] = useState(true);

  const model = React.useMemo(() => buildOrgModel(reps, managers), [reps, managers]);

  // Reps with neither a supervisor nor a region manager: either hanging off a
  // higher manager in the chart, or with no manager at all ("خارج الهيكل").
  const noSupCount = reps.filter(r => !hasDirectBoss(r)).length;

  // Rep totals shown on each card must follow the toggle, otherwise a card reads
  // "👤 12" while only 4 chips are visible beneath it.
  const totals = React.useMemo(() => {
    const t = new Map();
    const walk = id => {
      if (t.has(id)) return t.get(id);
      t.set(id, 0);   // cycle guard
      const role = model.mgrById.get(id)?.role;
      const own  = (showNoSup || ORG_DIRECT_ROLES.includes(role)) ? (model.repsUnder.get(id)?.length || 0) : 0;
      const n    = own + (model.childrenOf.get(id) || []).reduce((s, c) => s + walk(c), 0);
      t.set(id, n);
      return n;
    };
    model.mgrById.forEach((_, id) => walk(id));
    return t;
  }, [model, showNoSup]);

  const q = search.trim();
  const matches = React.useMemo(() => {
    const s = new Set();
    if (!q) return s;
    managers.forEach(m => {
      if ((m.name_ar || '').includes(q) || (m.name_en || '').toLowerCase().includes(q.toLowerCase())) s.add(`m${m.id}`);
    });
    reps.forEach(r => {
      if ((r.name_ar || '').includes(q) || (r.name_en || '').toLowerCase().includes(q.toLowerCase())
          || (r.netsuite_name || '').toLowerCase().includes(q.toLowerCase())) s.add(`r${r.id}`);
    });
    return s;
  }, [q, managers, reps]);

  const toggle = id => setCollapsed(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const collapseAll = () => setCollapsed(new Set(managers.map(m => Number(m.id))));
  const expandAll   = () => setCollapsed(new Set());

  function handlePrint() {
    const t = document.title;
    document.title = 'الهيكل التنظيمي لفريق المبيعات';
    window.onafterprint = () => { document.title = t; window.onafterprint = null; };
    window.print();
  }

  const roleCounts = ROLES_ORDER.map(role => ({
    role, label: ROLE_LABELS[role], n: managers.filter(m => m.role === role).length,
  }));

  if (l1 || l2) return <div className="rmp-tab-content"><div className="rmp-loading">جارٍ التحميل…</div></div>;

  return (
    <div className="rmp-tab-content">
      <div className="rmp-tab-toolbar rmp-no-print">
        <div className="rmp-search-wrap">
          <Search size={14} className="rmp-search-icon"/>
          <input className="rmp-search" value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="بحث عن مندوب أو مدير…"/>
        </div>
        <button className="rmp-btn" onClick={expandAll}>توسيع الكل</button>
        <button className="rmp-btn" onClick={collapseAll}>طي الكل</button>
        <button
          className={`rmp-btn rmp-btn--toggle${showNoSup ? ' rmp-btn--toggle-on' : ''}`}
          onClick={() => setShowNoSup(v => !v)}
          title="المناديب غير المسندين لمشرف ولا لمدير منطقة — يظهرون تحت أعلى مدير مُسند لهم أو ضمن «خارج الهيكل». المسند لأحدهما لا ينطبق عليه الشرط">
          {showNoSup ? <Eye size={14}/> : <EyeOff size={14}/>}
          {showNoSup ? 'إخفاء' : 'إظهار'} المناديب بلا مشرف أو مدير منطقة ({noSupCount})
        </button>
        <div className="rmp-org-zoom">
          <button className="rmp-icon-btn" onClick={() => setZoom(z => Math.max(0.4, +(z - 0.1).toFixed(2)))} title="تصغير">
            <ZoomOut size={14}/>
          </button>
          <span className="rmp-org-zoom-val">{Math.round(zoom * 100)}%</span>
          <button className="rmp-icon-btn" onClick={() => setZoom(z => Math.min(1.6, +(z + 0.1).toFixed(2)))} title="تكبير">
            <ZoomIn size={14}/>
          </button>
        </div>
        <button className="rmp-btn rmp-btn--export" onClick={handlePrint}>
          <Printer size={14}/> طباعة / PDF
        </button>
      </div>

      <div className="rmp-org-stats">
        {roleCounts.map(rc => (
          <div key={rc.role} className={`rmp-org-stat rmp-org-stat--${rc.role}`}>
            <span className="rmp-org-stat-n">{rc.n}</span>
            <span className="rmp-org-stat-l">{rc.label}</span>
          </div>
        ))}
        <div className="rmp-org-stat rmp-org-stat--rep">
          <span className="rmp-org-stat-n">{reps.length}</span>
          <span className="rmp-org-stat-l">مندوب</span>
        </div>
      </div>

      {q && (
        <div className="rmp-org-search-note rmp-no-print">
          {matches.size ? `تم العثور على ${matches.size} نتيجة — تم توسيع الهيكل بالكامل والنتائج مظللة` : 'لا توجد نتائج مطابقة'}
        </div>
      )}

      <div className="rmp-org-viewport">
        <div className="rmp-org-canvas"
             style={{ transform: `scale(${zoom})`, width: `${100 / zoom}%` }}>
          {model.roots.length === 0 ? (
            <div className="rmp-empty">لا يمكن رسم الهيكل — لم يتم إسناد أي مدير/مشرف للمناديب بعد</div>
          ) : model.roots.map(rid => (
            <ul key={rid} className="rmp-org-ul rmp-org-ul--root">
              <OrgNode id={rid} model={model} totals={totals} isRoot collapsed={collapsed}
                toggle={toggle} matches={matches} searching={Boolean(q)} showNoSup={showNoSup}/>
            </ul>
          ))}
        </div>
      </div>

      {(model.unlinked.length > 0 || (showNoSup && model.orphanReps.length > 0)) && (
        <div className="rmp-org-orphans">
          <div className="rmp-org-orphans-title">
            <AlertTriangle size={14}/> خارج الهيكل — لم يتم إسنادهم في بيانات المناديب
          </div>
          {model.unlinked.length > 0 && (
            <div className="rmp-org-orphans-row">
              <span className="rmp-org-orphans-lbl">مديرون / مشرفون بلا فريق:</span>
              {model.unlinked.map(m => (
                <span key={m.id} className="rmp-org-orphan-chip">
                  {m.name_ar}<span className="rmp-muted"> · {ROLE_LABELS[m.role]}</span>
                </span>
              ))}
            </div>
          )}
          {showNoSup && model.orphanReps.length > 0 && (
            <div className="rmp-org-orphans-row">
              <span className="rmp-org-orphans-lbl">مناديب بلا رئيس ({model.orphanReps.length}):</span>
              {model.orphanReps.map(r => (
                <span key={r.id} className="rmp-org-orphan-chip">
                  {r.name_ar}{r.region_name && <span className="rmp-muted"> · {r.region_name}</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   MAIN PAGE
════════════════════════════════════════════════════════════════ */
export default function RepManagementPage() {
  const { user }  = useAuth();
  const isAdmin   = user && ADMIN_ROLES.includes(user.role);
  const [tab, setTab] = useState('reps');

  const TABS = [
    { key: 'reps',     label: 'المناديب',          icon: <Users size={15}/> },
    { key: 'managers', label: 'المديرون والمشرفون', icon: <Users size={15}/> },
    { key: 'targets',  label: 'الأهداف الشهرية',   icon: <Check size={15}/> },
    { key: 'org',      label: 'الهيكل التنظيمي',    icon: <Network size={15}/> },
  ];

  return (
    <div className="rmp-page">
      <div className="rmp-header">
        <div>
          <h1 className="rmp-title">👥 إدارة المناديب والأهداف</h1>
          <p className="rmp-subtitle">التسلسل الهرمي · الأهداف الشهرية · ربط بيانات NetSuite</p>
        </div>
      </div>

      <div className="rmp-tabs">
        {TABS.map(t => (
          <button key={t.key}
            className={`rmp-tab${tab === t.key ? ' rmp-tab--active' : ''}`}
            onClick={() => setTab(t.key)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'reps'     && <RepsTab     isAdmin={isAdmin} />}
      {tab === 'managers' && <ManagersTab isAdmin={isAdmin} />}
      {tab === 'targets'  && <TargetsTab  isAdmin={isAdmin} />}
      {tab === 'org'      && <OrgChartTab />}
    </div>
  );
}
