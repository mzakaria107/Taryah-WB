import React, { useState, useEffect, useCallback } from 'react';
import {
  UserPlus, Trash2, Edit2, X, Check, ShieldCheck,
  ShieldOff, ChevronDown, ChevronUp, Eye, EyeOff, Circle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import client from '../api/client';
import './Users.css';

/* ── Role config ──────────────────────────────────── */
const ROLES = {
  super_admin:    { label: 'مدير عام',              color: 'role-super'     },
  it_admin:       { label: 'مدير تقنية',            color: 'role-it'        },
  top_management: { label: 'الإدارة العليا',         color: 'role-top'       },
  sales_manager:  { label: 'مدير مبيعات',           color: 'role-sales-mgr' },
  supervisor:     { label: 'مشرف',                  color: 'role-sup'       },
  region_manager: { label: 'مدير منطقة',            color: 'role-region'    },
  sales_rep:      { label: 'مندوب مبيعات',          color: 'role-sales'     },
  fridge_admin:   { label: 'موظف إداري (ثلاجات)',   color: 'role-fridge'    },
  accounts:       { label: 'الحسابات',              color: 'role-accounts'  },
  viewer:         { label: 'مستعرض',                color: 'role-viewer'    },
};

/* ── Permission matrix ────────────────────────────── */
const PERMS = [
  { feature: 'لوحة التحكم',      desc:'إجمالي العملاء والأرصدة', super_admin:2, it_admin:2, top_management:1, sales_manager:2, supervisor:1, region_manager:1, sales_rep:1, fridge_admin:0, accounts:1, viewer:1 },
  { feature: 'الفواتير',          desc:'عرض وتصفية الفواتير',      super_admin:2, it_admin:2, top_management:1, sales_manager:2, supervisor:1, region_manager:1, sales_rep:1, fridge_admin:0, accounts:1, viewer:1 },
  { feature: 'ملف العميل',        desc:'تفاصيل وتاريخ العميل',     super_admin:2, it_admin:2, top_management:1, sales_manager:2, supervisor:1, region_manager:1, sales_rep:1, fridge_admin:0, accounts:1, viewer:1 },
  { feature: 'الملاحظات',         desc:'إضافة وتعديل ملاحظات',     super_admin:2, it_admin:2, top_management:1, sales_manager:2, supervisor:2, region_manager:2, sales_rep:2, fridge_admin:0, accounts:1, viewer:0 },
  { feature: 'تقرير العملاء',     desc:'نشاط المبيعات والأداء',    super_admin:2, it_admin:2, top_management:1, sales_manager:2, supervisor:1, region_manager:1, sales_rep:1, fridge_admin:0, accounts:0, viewer:0 },
  { feature: 'متابعة الثلاجات',   desc:'إدارة الثلاجات والنقل',    super_admin:2, it_admin:2, top_management:1, sales_manager:0, supervisor:0, region_manager:1, sales_rep:0, fridge_admin:1, accounts:0, viewer:0 },
  { feature: 'المخزون',            desc:'بيانات المخزون من NetSuite',super_admin:2, it_admin:2, top_management:0, sales_manager:0, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, accounts:0, viewer:0 },
  { feature: 'تصدير Excel/CSV',   desc:'تنزيل تقارير البيانات',    super_admin:2, it_admin:2, top_management:0, sales_manager:2, supervisor:2, region_manager:2, sales_rep:2, fridge_admin:0, accounts:0, viewer:0 },
  { feature: 'رفع البيانات',      desc:'استيراد ملفات Excel',      super_admin:2, it_admin:2, top_management:0, sales_manager:0, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, accounts:0, viewer:0 },
  { feature: 'إدارة المستخدمين', desc:'إنشاء وتعديل الحسابات',    super_admin:2, it_admin:0, top_management:0, sales_manager:0, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, accounts:0, viewer:0 },
  { feature: 'نطاق البيانات',     desc:'حدود الوصول للبيانات',     super_admin:3, it_admin:3, top_management:3, sales_manager:3, supervisor:4, region_manager:4, sales_rep:4, fridge_admin:4, accounts:3, viewer:3 },
];
// 0=لا, 1=قراءة/منطقة, 2=كامل, 3=كل المناطق, 4=منطقته فقط

/* ── Online status helper ──────────────────────────── */
const ONLINE_MS = 5 * 60 * 1000; // 5 minutes
function isOnline(lastSeen) {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < ONLINE_MS;
}
function fmtLastSeen(lastSeen) {
  if (!lastSeen) return null;
  const d = new Date(lastSeen);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1)  return 'الآن';
  if (diffMin < 60) return `منذ ${diffMin} د`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return `منذ ${diffH} س`;
  return d.toLocaleDateString('ar-SA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const PERM_ICON = {
  0: { icon: '✕', cls: 'pm-no'    },
  1: { icon: '◉', cls: 'pm-read'  },
  2: { icon: '✓', cls: 'pm-full'  },
  3: { icon: '🌐', cls: 'pm-all'   },
  4: { icon: '📍', cls: 'pm-own'  },
};

const EMPTY_FORM = { name:'', email:'', password:'', role:'viewer', region_id:'' };

/* ── Helpers ──────────────────────────────────────── */
function Avatar({ name, email }) {
  const ch = (name || email || '?')[0].toUpperCase();
  return <div className="u-avatar">{ch}</div>;
}

function RoleBadge({ role }) {
  const cfg = ROLES[role] || { label: role, color: 'role-viewer' };
  return <span className={`u-role-badge ${cfg.color}`}>{cfg.label}</span>;
}

/* ── Field component ──────────────────────────────── */
function Field({ label, children }) {
  return (
    <div className="u-field">
      <label className="u-field-label">{label}</label>
      {children}
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════ */
export default function Users() {
  const { user: me } = useAuth();
  const [users,       setUsers]       = useState([]);
  const [regions,     setRegions]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [showCreate,  setShowCreate]  = useState(false);
  const [editId,      setEditId]      = useState(null);
  const [form,        setForm]        = useState(EMPTY_FORM);
  const [editForm,    setEditForm]    = useState({});
  const [formErr,     setFormErr]     = useState('');
  const [editErr,     setEditErr]     = useState('');
  const [saving,      setSaving]      = useState(false);
  const [showPerms,   setShowPerms]   = useState(false);
  const [showPwd,     setShowPwd]     = useState(false);
  const [showEditPwd, setShowEditPwd] = useState(false);

  const isSuperAdmin = me?.role === 'super_admin';

  /* ── Load data ────────────────────────────────── */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [uRes, rRes] = await Promise.all([
        client.get('/users'),
        client.get('/users/regions'),
      ]);
      setUsers(uRes.data);
      setRegions(rRes.data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  /* ── Create ───────────────────────────────────── */
  const handleCreate = async (e) => {
    e.preventDefault();
    setFormErr('');
    setSaving(true);
    try {
      await client.post('/auth/register', {
        ...form,
        region_id: form.region_id || null,
      });
      setShowCreate(false);
      setForm(EMPTY_FORM);
      setShowPwd(false);
      load();
    } catch (err) {
      setFormErr(err.response?.data?.error || 'فشل إنشاء المستخدم');
    } finally { setSaving(false); }
  };

  /* ── Start edit ───────────────────────────────── */
  const startEdit = (u) => {
    setEditId(u.id);
    setEditForm({ name: u.name, email: u.email, role: u.role, region_id: u.region_id || '', password: '' });
    setEditErr('');
    setShowEditPwd(false);
  };

  /* ── Save edit ────────────────────────────────── */
  const handleEdit = async (e) => {
    e.preventDefault();
    setEditErr('');
    setSaving(true);
    try {
      const body = { name: editForm.name, email: editForm.email, role: editForm.role, region_id: editForm.region_id || null };
      if (editForm.password) body.password = editForm.password;
      await client.put(`/users/${editId}`, body);
      setEditId(null);
      load();
    } catch (err) {
      setEditErr(err.response?.data?.error || 'فشل الحفظ');
    } finally { setSaving(false); }
  };

  /* ── Toggle active ────────────────────────────── */
  const handleToggle = async (u) => {
    const action = u.is_active ? 'تعطيل' : 'تفعيل';
    if (!window.confirm(`هل تريد ${action} مستخدم "${u.name}"؟`)) return;
    try {
      const res = await client.patch(`/users/${u.id}/toggle-active`);
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, is_active: res.data.is_active } : x));
    } catch (err) {
      window.alert(err.response?.data?.error || 'فشل العملية');
    }
  };

  /* ── Delete ───────────────────────────────────── */
  const handleDelete = async (u) => {
    if (!window.confirm(`هل أنت متأكد من حذف "${u.name}" نهائياً؟`)) return;
    try {
      await client.delete(`/users/${u.id}`);
      load();
    } catch (err) {
      window.alert(err.response?.data?.error || 'فشل الحذف');
    }
  };

  /* ── Stats ────────────────────────────────────── */
  const onlineCount = users.filter(u => isOnline(u.last_seen_at)).length;

  const stats = Object.keys(ROLES).map(role => ({
    role, count: users.filter(u => u.role === role).length
  })).filter(s => s.count > 0);

  const f  = (key) => (e) => setForm(p  => ({ ...p, [key]: e.target.value }));
  const ef = (key) => (e) => setEditForm(p => ({ ...p, [key]: e.target.value }));

  /* ── Render ───────────────────────────────────── */
  return (
    <div className="u-page">

      {/* ── Header ── */}
      <div className="u-header">
        <div>
          <h1 className="u-title">إدارة المستخدمين</h1>
          <p className="u-subtitle">تحكم كامل في الحسابات والصلاحيات</p>
        </div>
        <div className="u-header-actions">
          <button className="u-btn-ghost" onClick={() => setShowPerms(s => !s)}>
            {showPerms ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}
            جدول الصلاحيات
          </button>
          {isSuperAdmin && (
            <button className="u-btn-primary" onClick={() => { setShowCreate(s=>!s); setFormErr(''); }}>
              <UserPlus size={15}/> مستخدم جديد
            </button>
          )}
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="u-stats-row">
        <div className="u-stat">
          <span className="u-stat-num">{users.length}</span>
          <span className="u-stat-lbl">إجمالي المستخدمين</span>
        </div>
        <div className="u-stat">
          <span className="u-stat-num" style={{color:'var(--color-brand-green)'}}>
            {users.filter(u=>u.is_active).length}
          </span>
          <span className="u-stat-lbl">فعّال</span>
        </div>
        <div className="u-stat">
          <span className="u-stat-num" style={{color:'var(--color-danger)'}}>
            {users.filter(u=>!u.is_active).length}
          </span>
          <span className="u-stat-lbl">موقوف</span>
        </div>
        {onlineCount > 0 && (
          <div className="u-stat u-stat-online">
            <span className="u-stat-num" style={{color:'#16a34a'}}>
              {onlineCount}
            </span>
            <span className="u-stat-lbl">متصل الآن</span>
          </div>
        )}
        {stats.map(s => (
          <div key={s.role} className="u-stat">
            <span className="u-stat-num">{s.count}</span>
            <span className="u-stat-lbl">{ROLES[s.role].label}</span>
          </div>
        ))}
      </div>

      {/* ── Permission matrix ── */}
      {showPerms && (
        <div className="u-perms-card">
          <h3 className="u-perms-title">🔐 جدول الصلاحيات</h3>
          <div className="u-perms-wrap">
            <table className="u-perms-table">
              <thead>
                <tr>
                  <th>الميزة</th>
                  {Object.keys(ROLES).map(r => (
                    <th key={r}><RoleBadge role={r}/></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMS.map(row => (
                  <tr key={row.feature}>
                    <td>
                      <div className="u-feat-name">{row.feature}</div>
                      <div className="u-feat-desc">{row.desc}</div>
                    </td>
                    {Object.keys(ROLES).map(r => {
                      const v = row[r];
                      const { icon, cls } = PERM_ICON[v] ?? PERM_ICON[0];
                      return <td key={r} className={`u-pm-cell ${cls}`}>{icon}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="u-perms-legend">
            <span><span className="pm-full">✓</span> صلاحية كاملة</span>
            <span><span className="pm-read">◉</span> قراءة فقط</span>
            <span><span className="pm-all">🌐</span> كل المناطق</span>
            <span><span className="pm-own">📍</span> منطقته فقط</span>
            <span><span className="pm-no">✕</span> محظور</span>
          </div>
        </div>
      )}

      {/* ── Create form ── */}
      {showCreate && isSuperAdmin && (
        <div className="u-form-card">
          <div className="u-form-header">
            <span className="u-form-title">إنشاء مستخدم جديد</span>
            <button className="u-icon-btn" onClick={() => setShowCreate(false)}><X size={16}/></button>
          </div>
          <form onSubmit={handleCreate}>
            <div className="u-form-grid">
              <Field label="الاسم الكامل">
                <input className="u-input" required value={form.name} onChange={f('name')} placeholder="محمد أحمد" />
              </Field>
              <Field label="البريد الإلكتروني">
                <input className="u-input" type="email" required dir="ltr" value={form.email} onChange={f('email')} placeholder="user@example.com" />
              </Field>
              <Field label="كلمة المرور">
                <div className="u-pwd-wrap">
                  <input className="u-input" type={showPwd ? 'text' : 'password'} required dir="ltr"
                    value={form.password} onChange={f('password')} placeholder="6 أحرف على الأقل" minLength={6}/>
                  <button type="button" className="u-pwd-toggle" onClick={() => setShowPwd(s=>!s)}>
                    {showPwd ? <EyeOff size={14}/> : <Eye size={14}/>}
                  </button>
                </div>
              </Field>
              <Field label="الدور الوظيفي">
                <select className="u-input" value={form.role} onChange={f('role')}>
                  {Object.entries(ROLES).map(([v, c]) => (
                    <option key={v} value={v}>{c.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="المنطقة المخصصة">
                <select className="u-input" value={form.region_id} onChange={f('region_id')}>
                  <option value="">كل المناطق</option>
                  {regions.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
                </select>
              </Field>

              {/* Role hint */}
              <div className="u-role-hint">
                {form.role === 'super_admin'    && '⚠️ صلاحية كاملة على جميع البيانات والمستخدمين'}
                {form.role === 'it_admin'        && '💻 صلاحية رفع البيانات والاطلاع على كل المناطق'}
                {form.role === 'top_management'  && '🏢 الإدارة العليا — قراءة فقط على جميع المناطق والتقارير'}
                {form.role === 'sales_manager'   && '📊 مدير مبيعات — صلاحية كاملة على تقارير المبيعات لكل المناطق'}
                {form.role === 'supervisor'      && '👔 مشرف — يرى تقارير المبيعات لمنطقته فقط'}
                {form.role === 'region_manager'  && '📍 مدير منطقة — يرى بيانات منطقته بما فيها الثلاجات'}
                {form.role === 'sales_rep'        && '👤 مندوب — يرى بياناته ويضيف ملاحظات'}
                {form.role === 'fridge_admin'    && '🧊 إداري ثلاجات — يرى صفحة الثلاجات لمنطقته فقط'}
                {form.role === 'accounts'        && '🧾 الحسابات — قراءة الفواتير والأرصدة وملفات العملاء لكل المناطق'}
                {form.role === 'viewer'           && '👁️ قراءة فقط — لا يستطيع التعديل أو التصدير'}
              </div>
            </div>

            {formErr && <div className="u-err">{formErr}</div>}

            <div className="u-form-actions">
              <button type="button" className="u-btn-ghost" onClick={() => setShowCreate(false)}>إلغاء</button>
              <button type="submit" className="u-btn-primary" disabled={saving}>
                {saving ? 'جاري الحفظ…' : <><UserPlus size={14}/> إنشاء الحساب</>}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Users table ── */}
      <div className="u-table-card">
        {loading ? (
          <div className="u-loading">
            <div className="spinner" style={{width:30,height:30}}/>
            <span>جاري التحميل…</span>
          </div>
        ) : users.length === 0 ? (
          <div className="u-empty">لا يوجد مستخدمون</div>
        ) : (
          <div className="u-table-wrap">
            <table className="u-table">
              <thead>
                <tr>
                  <th>المستخدم</th>
                  <th>الدور</th>
                  <th>المنطقة</th>
                  <th>الحالة</th>
                  <th>آخر جلسة</th>
                  <th>تاريخ الإنشاء</th>
                  {isSuperAdmin && <th>إجراءات</th>}
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <React.Fragment key={u.id}>
                    <tr className={!u.is_active ? 'u-row-inactive' : ''}>
                      {/* User info */}
                      <td>
                        <div className="u-user-cell">
                          <div className="u-avatar-wrap">
                            <Avatar name={u.name} email={u.email}/>
                            {isOnline(u.last_seen_at) && <span className="u-online-dot" title="متصل الآن"/>}
                          </div>
                          <div>
                            <div className="u-user-name">
                              {u.name ?? '—'}
                              {u.id === me?.id && <span className="u-you-badge">أنت</span>}
                            </div>
                            <div className="u-user-email">{u.email}</div>
                          </div>
                        </div>
                      </td>

                      {/* Role */}
                      <td><RoleBadge role={u.role}/></td>

                      {/* Region */}
                      <td className="u-region-cell">
                        {u.region_name_ar
                          ? <span className="u-region-chip">{u.region_name_ar}</span>
                          : <span className="u-region-all">كل المناطق</span>}
                      </td>

                      {/* Status */}
                      <td>
                        {u.is_active
                          ? <span className="u-status-active"><ShieldCheck size={13}/> فعّال</span>
                          : <span className="u-status-inactive"><ShieldOff size={13}/> موقوف</span>}
                      </td>

                      {/* Last session */}
                      <td className="u-session-cell">
                        {isOnline(u.last_seen_at)
                          ? <span className="u-session-now">● الآن</span>
                          : fmtLastSeen(u.last_seen_at) ?? <span style={{color:'var(--color-text-muted)'}}>—</span>}
                      </td>

                      {/* Created at */}
                      <td className="u-date-cell">
                        {u.created_at ? new Date(u.created_at).toLocaleDateString('ar-SA') : '—'}
                      </td>

                      {/* Actions */}
                      {isSuperAdmin && (
                        <td>
                          {u.id !== me?.id && (
                            <div className="u-actions">
                              <button className="u-action-btn u-edit"
                                onClick={() => editId === u.id ? setEditId(null) : startEdit(u)}
                                title="تعديل">
                                <Edit2 size={13}/>
                              </button>
                              <button
                                className={`u-action-btn ${u.is_active ? 'u-deactivate' : 'u-activate'}`}
                                onClick={() => handleToggle(u)}
                                title={u.is_active ? 'تعطيل الحساب' : 'تفعيل الحساب'}>
                                {u.is_active ? <ShieldOff size={13}/> : <ShieldCheck size={13}/>}
                              </button>
                              <button className="u-action-btn u-delete"
                                onClick={() => handleDelete(u)}
                                title="حذف نهائي">
                                <Trash2 size={13}/>
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>

                    {/* Inline edit row */}
                    {editId === u.id && (
                      <tr className="u-edit-row">
                        <td colSpan={isSuperAdmin ? 7 : 6}>
                          <form className="u-edit-form" onSubmit={handleEdit}>
                            <div className="u-form-grid">
                              <Field label="الاسم">
                                <input className="u-input" value={editForm.name} onChange={ef('name')} required/>
                              </Field>
                              <Field label="البريد">
                                <input className="u-input" type="email" dir="ltr" value={editForm.email} onChange={ef('email')} required/>
                              </Field>
                              <Field label="الدور">
                                <select className="u-input" value={editForm.role} onChange={ef('role')}>
                                  {Object.entries(ROLES).map(([v,c]) => (
                                    <option key={v} value={v}>{c.label}</option>
                                  ))}
                                </select>
                              </Field>
                              <Field label="المنطقة">
                                <select className="u-input" value={editForm.region_id} onChange={ef('region_id')}>
                                  <option value="">كل المناطق</option>
                                  {regions.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
                                </select>
                              </Field>
                              <Field label="كلمة مرور جديدة (اختياري)">
                                <div className="u-pwd-wrap">
                                  <input className="u-input" type={showEditPwd?'text':'password'} dir="ltr"
                                    value={editForm.password} onChange={ef('password')} placeholder="اتركها فارغة للإبقاء على القديمة"/>
                                  <button type="button" className="u-pwd-toggle" onClick={()=>setShowEditPwd(s=>!s)}>
                                    {showEditPwd ? <EyeOff size={14}/> : <Eye size={14}/>}
                                  </button>
                                </div>
                              </Field>
                            </div>
                            {editErr && <div className="u-err">{editErr}</div>}
                            <div className="u-form-actions">
                              <button type="button" className="u-btn-ghost" onClick={()=>setEditId(null)}>
                                <X size={13}/> إلغاء
                              </button>
                              <button type="submit" className="u-btn-primary" disabled={saving}>
                                {saving ? 'جاري الحفظ…' : <><Check size={13}/> حفظ التعديلات</>}
                              </button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
