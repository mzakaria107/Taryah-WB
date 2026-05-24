import React, { useState, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { UserSearch, ChevronRight, ChevronLeft, GripVertical, Settings2, X, Check } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { usePermissions } from '../../context/PermissionsContext';
import { useSidebarOrder } from '../../context/SidebarOrderContext';
import { ALL_NAV, NAV_BY_KEY, applyNavOrder } from '../../data/navConfig';

const ADMIN_ROLES = ['super_admin', 'it_admin'];

export default function Sidebar({ collapsed, onToggle }) {
  const { user }            = useAuth();
  const { canAccess }       = usePermissions();
  const { order, saveOrder, resetOrder } = useSidebarOrder();
  const location            = useLocation();
  const isAdmin             = user && ADMIN_ROLES.includes(user.role);

  /* ── Reorder modal state ──────────────────────────── */
  const [showReorder, setShowReorder] = useState(false);
  const [draftOrder, setDraftOrder]   = useState([]);
  const [saving, setSaving]           = useState(false);
  const dragIdx = useRef(null);

  /* ── Derived nav ──────────────────────────────────── */
  const orderedNav = applyNavOrder(ALL_NAV, order);
  const visible    = orderedNav.filter(n => user && canAccess(user.role, n.pageKey));
  const onCustomerPage = location.pathname.startsWith('/customers/');

  /* ── Modal controls ───────────────────────────────── */
  function openReorder() {
    setDraftOrder(applyNavOrder(ALL_NAV, order).map(n => n.pageKey));
    setShowReorder(true);
  }
  async function handleSave() {
    setSaving(true);
    try { await saveOrder(draftOrder); } finally { setSaving(false); }
    setShowReorder(false);
  }
  async function handleReset() {
    setSaving(true);
    try { await resetOrder(); } finally { setSaving(false); }
    setDraftOrder(ALL_NAV.map(n => n.pageKey));
    setShowReorder(false);
  }
  function handleCancel() { setShowReorder(false); }

  /* ── HTML5 Drag-and-drop ──────────────────────────── */
  function onDragStart(e, idx) {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  }
  function onDragOver(e, idx) {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === idx) return;
    const updated = [...draftOrder];
    const [moved] = updated.splice(dragIdx.current, 1);
    updated.splice(idx, 0, moved);
    dragIdx.current = idx;
    setDraftOrder(updated);
  }
  function onDragEnd() { dragIdx.current = null; }

  return (
    <>
      {/* ── Sidebar ─────────────────────────────────── */}
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        <button
          className="sidebar-collapse-btn"
          onClick={onToggle}
          aria-label={collapsed ? 'توسيع القائمة' : 'طي القائمة'}
        >
          {collapsed ? <ChevronLeft size={16}/> : <ChevronRight size={16}/>}
        </button>

        <nav className="sidebar-nav" aria-label="التنقل الرئيسي">
          <div className="sidebar-section">القائمة</div>

          {visible.map(n => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              title={collapsed ? n.label : undefined}
            >
              {n.icon(18)}
              <span className="sidebar-link-label">{n.label}</span>
            </NavLink>
          ))}

          {onCustomerPage && (
            <>
              <div className="sidebar-section" style={{ marginTop: 8 }}>بيانات العميل</div>
              <div className="sidebar-link active" style={{ pointerEvents: 'none' }}>
                <UserSearch size={18}/>
                <span className="sidebar-link-label">ملف العميل</span>
              </div>
            </>
          )}
        </nav>

        {/* ── Admin reorder button ─────────────────── */}
        {isAdmin && (
          <button
            className={`sidebar-reorder-btn${collapsed ? ' sidebar-reorder-btn--icon' : ''}`}
            onClick={openReorder}
            title="ترتيب القائمة"
          >
            <Settings2 size={15}/>
            {!collapsed && <span>ترتيب القائمة</span>}
          </button>
        )}
      </aside>

      {/* ── Reorder modal ───────────────────────────── */}
      {showReorder && (
        <div className="sro-overlay" onClick={handleCancel}>
          <div className="sro-modal" onClick={e => e.stopPropagation()}>

            <div className="sro-header">
              <Settings2 size={17}/>
              <span>ترتيب عناصر القائمة</span>
              <button className="sro-close" onClick={handleCancel} aria-label="إغلاق">
                <X size={16}/>
              </button>
            </div>

            <p className="sro-hint">اسحب العناصر لتغيير الترتيب — يُطبَّق على جميع المستخدمين</p>

            <ul className="sro-list">
              {draftOrder.map((key, idx) => {
                const item = NAV_BY_KEY[key];
                if (!item) return null;
                return (
                  <li
                    key={key}
                    className="sro-item"
                    draggable
                    onDragStart={e => onDragStart(e, idx)}
                    onDragOver={e  => onDragOver(e, idx)}
                    onDragEnd={onDragEnd}
                  >
                    <GripVertical size={16} className="sro-grip"/>
                    <span className="sro-item-icon">{item.icon(18)}</span>
                    <span className="sro-item-label">{item.label}</span>
                  </li>
                );
              })}
            </ul>

            <div className="sro-footer">
              <button className="sro-btn sro-btn--save" onClick={handleSave} disabled={saving}>
                <Check size={15}/> {saving ? 'جاري الحفظ...' : 'حفظ الترتيب'}
              </button>
              <button className="sro-btn sro-btn--reset" onClick={handleReset} disabled={saving} title="إعادة الترتيب الافتراضي">
                إعادة تعيين
              </button>
              <button className="sro-btn sro-btn--cancel" onClick={handleCancel} disabled={saving}>
                إلغاء
              </button>
            </div>

          </div>
        </div>
      )}
    </>
  );
}
