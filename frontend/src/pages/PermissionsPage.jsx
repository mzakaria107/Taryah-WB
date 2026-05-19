import React, { useState, useCallback } from 'react';
import { ShieldCheck, Lock, Unlock, RotateCcw, Check, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePermissions } from '../context/PermissionsContext';
import { ROLES, PAGES, LEVEL_MAP } from '../data/permissions';
import './PermissionsPage.css';

/* Data-scope row (read-only) */
const DATA_SCOPE = {
  label: 'نطاق البيانات',
  desc: 'حدود الوصول الجغرافي للبيانات',
  super_admin:    { icon: '🌐', label: 'كل المناطق', cls: 'pp-all' },
  it_admin:       { icon: '🌐', label: 'كل المناطق', cls: 'pp-all' },
  top_management: { icon: '🌐', label: 'كل المناطق', cls: 'pp-all' },
  sales_manager:  { icon: '🌐', label: 'كل المناطق', cls: 'pp-all' },
  supervisor:     { icon: '📍', label: 'منطقته فقط', cls: 'pp-own' },
  region_manager: { icon: '📍', label: 'منطقته فقط', cls: 'pp-own' },
  sales_rep:      { icon: '📍', label: 'منطقته فقط', cls: 'pp-own' },
  fridge_admin:   { icon: '📍', label: 'منطقته فقط', cls: 'pp-own' },
  viewer:         { icon: '🌐', label: 'كل المناطق', cls: 'pp-all' },
};

const ROLE_DESCS = {
  super_admin:    'صلاحية كاملة على جميع الصفحات والبيانات والمستخدمين لجميع المناطق.',
  it_admin:       'يملك صلاحية رفع البيانات والاطلاع على جميع المناطق، بدون إدارة المستخدمين.',
  top_management: 'الإدارة العليا — قراءة فقط على جميع التقارير والبيانات لكل المناطق، بدون أي صلاحية تعديل.',
  sales_manager:  'مدير مبيعات — صلاحية كاملة على تقارير المبيعات لجميع المناطق، بدون رفع بيانات أو إدارة مستخدمين.',
  supervisor:     'مشرف — يرى تقارير المبيعات والملاحظات لمنطقته فقط، بدون وصول للثلاجات أو المخزون.',
  region_manager: 'مدير منطقة — يرى جميع بيانات منطقته بما فيها الثلاجات.',
  sales_rep:      'مندوب مبيعات — يرى بياناته ويضيف ملاحظات، بدون وصول للثلاجات أو المخزون.',
  fridge_admin:   'موظف إداري ثلاجات — يرى صفحة الثلاجات ومهام المبيعات لمنطقته فقط.',
  viewer:         'مستعرض — قراءة فقط للرئيسية والفواتير، بدون أي صلاحية تعديل أو تصدير.',
};

/* Cell state machine: cycle 0→1→2→0 */
function nextLevel(current) {
  return (current + 1) % 3;
}

/* ── Single editable cell ──────────────────────────── */
function PermCell({ pageKey, role, level, editMode, onSave, protected: isProtected }) {
  const [status, setStatus] = useState(null); // null | 'saving' | 'ok' | 'err'

  const cfg = LEVEL_MAP[level] ?? LEVEL_MAP[0];

  const handleClick = useCallback(async () => {
    if (!editMode || isProtected) return;
    const next = nextLevel(level);
    setStatus('saving');
    try {
      await onSave(pageKey, role, next);
      setStatus('ok');
      setTimeout(() => setStatus(null), 1200);
    } catch {
      setStatus('err');
      setTimeout(() => setStatus(null), 2000);
    }
  }, [editMode, isProtected, level, onSave, pageKey, role]);

  const inner = status === 'saving' ? <span className="pp-saving-dot"/> :
                status === 'ok'     ? <Check size={13}/> :
                status === 'err'    ? <X size={13}/> :
                <span className="pp-icon">{cfg.icon}</span>;

  return (
    <td
      className={`pp-cell ${cfg.cls}${editMode && !isProtected ? ' pp-editable' : ''}${status === 'ok' ? ' pp-saved' : ''}${status === 'err' ? ' pp-error' : ''}`}
      title={editMode && !isProtected ? `النقر للتغيير — حالياً: ${cfg.label}` : cfg.label}
      onClick={handleClick}
    >
      {inner}
    </td>
  );
}

/* ═══════════════════════════════════════════════════
   PAGE
   ══════════════════════════════════════════════════ */
export default function PermissionsPage() {
  const { user: me } = useAuth();
  const { perms, updatePerm } = usePermissions();
  const isSuperAdmin = me?.role === 'super_admin';

  const [editMode,    setEditMode]   = useState(false);
  const [activeRole,  setActiveRole] = useState(null);

  const handleSave = useCallback(
    (pageKey, role, level) => updatePerm(pageKey, role, level),
    [updatePerm]
  );

  /* count accessible pages per role */
  const accessCount = ROLES.reduce((acc, r) => {
    acc[r.key] = PAGES.filter(p => (perms[p.key]?.[r.key] ?? 0) > 0).length;
    return acc;
  }, {});

  return (
    <div className="pp-page">

      {/* ── Header ── */}
      <div className="pp-header">
        <div>
          <h1 className="pp-title"><ShieldCheck size={20}/> جدول الصلاحيات</h1>
          <p className="pp-subtitle">صلاحيات الوصول لكل صفحة حسب الدور الوظيفي</p>
        </div>
        {isSuperAdmin && (
          <button
            className={`pp-edit-btn${editMode ? ' pp-edit-btn-active' : ''}`}
            onClick={() => setEditMode(s => !s)}
          >
            {editMode ? <><Unlock size={14}/> وضع التعديل</>
                      : <><Lock   size={14}/> تعديل الصلاحيات</>}
          </button>
        )}
      </div>

      {/* ── Edit mode notice ── */}
      {editMode && (
        <div className="pp-edit-notice">
          <RotateCcw size={13}/>
          انقر على أي خلية لتغيير مستوى الصلاحية — التغييرات تُحفظ فوراً وتسري مباشرة على جميع المستخدمين.
        </div>
      )}

      {/* ── Role cards ── */}
      <div className="pp-roles-row">
        {ROLES.map(r => (
          <button
            key={r.key}
            className={`pp-role-card${activeRole === r.key ? ' pp-role-active' : ''}`}
            onClick={() => setActiveRole(v => v === r.key ? null : r.key)}
          >
            <span className={`pp-role-badge ${r.color}`}>{r.label}</span>
            <span className="pp-role-count">
              {accessCount[r.key]}
              <span className="pp-role-count-lbl"> صفحة</span>
            </span>
          </button>
        ))}
      </div>

      {/* ── Role description ── */}
      {activeRole && (
        <div className="pp-role-desc">
          <ShieldCheck size={14}/>
          <strong>{ROLES.find(r => r.key === activeRole)?.label}:</strong>
          {' '}{ROLE_DESCS[activeRole]}
        </div>
      )}

      {/* ── Matrix table ── */}
      <div className="pp-card">
        <div className="pp-table-wrap">
          <table className="pp-table">
            <thead>
              <tr>
                <th className="pp-th-page">الصفحة</th>
                {ROLES.map(r => (
                  <th key={r.key} className={activeRole === r.key ? 'pp-th-highlight' : ''}>
                    <span className={`pp-role-badge ${r.color}`}>{r.label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PAGES.map(page => (
                <tr key={page.key}>
                  <td className="pp-td-page">
                    <div className="pp-page-name">{page.label}</div>
                    <div className="pp-page-desc">{page.desc}</div>
                    <div className="pp-page-path">{page.path}</div>
                  </td>
                  {ROLES.map(r => {
                    const level = perms[page.key]?.[r.key] ?? 0;
                    /* super_admin can't lose access to dashboard or permissions */
                    const isProtected = r.key === 'super_admin' &&
                      ['dashboard', 'permissions'].includes(page.key);
                    return (
                      <PermCell
                        key={r.key}
                        pageKey={page.key}
                        role={r.key}
                        level={level}
                        editMode={editMode}
                        onSave={handleSave}
                        protected={isProtected}
                      />
                    );
                  })}
                </tr>
              ))}

              {/* Data scope row — read-only */}
              <tr className="pp-scope-row">
                <td className="pp-td-page">
                  <div className="pp-page-name">{DATA_SCOPE.label}</div>
                  <div className="pp-page-desc">{DATA_SCOPE.desc}</div>
                </td>
                {ROLES.map(r => {
                  const { icon, label, cls } = DATA_SCOPE[r.key];
                  return (
                    <td key={r.key} className={`pp-cell ${cls}`} title={label}>
                      <span className="pp-icon">{icon}</span>
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div className="pp-legend">
          {Object.entries(LEVEL_MAP).map(([v, { icon, label, cls }]) => (
            <span key={v} className="pp-legend-item">
              <span className={`pp-icon ${cls}`}>{icon}</span>{label}
            </span>
          ))}
          <span className="pp-legend-item"><span className="pp-icon pp-all">🌐</span> كل المناطق</span>
          <span className="pp-legend-item"><span className="pp-icon pp-own">📍</span> منطقته فقط</span>
          {editMode && (
            <span className="pp-legend-item pp-legend-edit">
              <span className="pp-icon pp-full">↺</span> انقر للتغيير
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
