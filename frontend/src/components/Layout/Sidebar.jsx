import React, { useState, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, FileText, MessageSquare, Upload, Users, UserSearch,
  ClipboardList, Thermometer, Package, Warehouse, ShieldCheck, TrendingUp,
  ChevronRight, ChevronLeft, Mail, BarChart2, GripVertical, Settings2, X, Check,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { usePermissions } from '../../context/PermissionsContext';

const NAV = [
  { to: '/',               pageKey: 'dashboard',       label: 'الرئيسية',        icon: <LayoutDashboard size={18}/> },
  { to: '/invoices',       pageKey: 'invoices',        label: 'الفواتير',         icon: <FileText        size={18}/> },
  { to: '/reports',        pageKey: 'reports',         label: 'سجل الملاحظات',   icon: <MessageSquare   size={18}/> },
  { to: '/sales-activity', pageKey: 'sales_activity',  label: 'تقرير العملاء',   icon: <UserSearch      size={18}/> },
  { to: '/sales-tasks',    pageKey: 'sales_tasks',     label: 'مهام المبيعات',   icon: <ClipboardList   size={18}/> },
  { to: '/fridges',        pageKey: 'fridges',         label: 'متابعة الثلاجات', icon: <Thermometer     size={18}/> },
  { to: '/stock',          pageKey: 'stock',           label: 'المخزون',          icon: <Package         size={18}/> },
  { to: '/current-stock',  pageKey: 'current_stock',   label: 'المخزون الحالي',  icon: <Warehouse       size={18}/> },
  { to: '/upload',         pageKey: 'upload',          label: 'رفع البيانات',    icon: <Upload          size={18}/> },
  { to: '/users',          pageKey: 'users',           label: 'المستخدمون',      icon: <Users           size={18}/> },
  { to: '/permissions',    pageKey: 'permissions',     label: 'الصلاحيات',       icon: <ShieldCheck     size={18}/> },
  { to: '/profitability',  pageKey: 'profitability',   label: 'الربحية',          icon: <TrendingUp      size={18}/> },
  { to: '/sales-report',  pageKey: 'sales_report',    label: 'صفحة المبيعات',   icon: <BarChart2       size={18}/> },
  { to: '/settings',      pageKey: 'settings',        label: 'الإعدادات',        icon: <Mail            size={18}/> },
];

const ADMIN_ROLES = ['super_admin', 'it_admin'];
const ORDER_KEY   = 'sidebar-order-v1';

function loadOrder() {
  try {
    const s = localStorage.getItem(ORDER_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

function applyOrder(items, order) {
  if (!order || !order.length) return items;
  return [...items].sort((a, b) => {
    const ai = order.indexOf(a.pageKey);
    const bi = order.indexOf(b.pageKey);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

/* Build a lookup map: pageKey → NAV item (stable — icons are JSX elements) */
const NAV_BY_KEY = Object.fromEntries(NAV.map(n => [n.pageKey, n]));

export default function Sidebar({ collapsed, onToggle }) {
  const { user }        = useAuth();
  const { canAccess }   = usePermissions();
  const location        = useLocation();
  const isAdmin         = user && ADMIN_ROLES.includes(user.role);

  /* ── Persistent order ──────────────────────────────────── */
  const [order, setOrder]           = useState(() => loadOrder());
  const [showReorder, setShowReorder] = useState(false);
  const [draftOrder, setDraftOrder]  = useState([]);
  const dragIdx = useRef(null);

  /* ── Derived nav list ─────────────────────────────────── */
  const orderedNav = applyOrder(NAV, order);
  const visible    = orderedNav.filter(n => user && canAccess(user.role, n.pageKey));
  const onCustomerPage = location.pathname.startsWith('/customers/');

  /* ── Reorder modal controls ───────────────────────────── */
  function openReorder() {
    setDraftOrder(applyOrder(NAV, order).map(n => n.pageKey));
    setShowReorder(true);
  }
  function saveReorder() {
    setOrder(draftOrder);
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(draftOrder)); } catch {}
    setShowReorder(false);
  }
  function cancelReorder() {
    setShowReorder(false);
  }
  function resetReorder() {
    setDraftOrder(NAV.map(n => n.pageKey));
  }

  /* ── HTML5 Drag-and-drop ──────────────────────────────── */
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
  function onDragEnd() {
    dragIdx.current = null;
  }

  return (
    <>
      {/* ── Sidebar ─────────────────────────────────────── */}
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
              {n.icon}
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

        {/* ── Admin reorder button ───────────────────────── */}
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

      {/* ── Reorder modal ───────────────────────────────── */}
      {showReorder && (
        <div className="sro-overlay" onClick={cancelReorder}>
          <div className="sro-modal" onClick={e => e.stopPropagation()}>

            <div className="sro-header">
              <Settings2 size={17}/>
              <span>ترتيب عناصر القائمة</span>
              <button className="sro-close" onClick={cancelReorder} aria-label="إغلاق">
                <X size={16}/>
              </button>
            </div>

            <p className="sro-hint">اسحب العناصر لتغيير الترتيب — يُحفظ في المتصفح</p>

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
                    <span className="sro-item-icon">{item.icon}</span>
                    <span className="sro-item-label">{item.label}</span>
                  </li>
                );
              })}
            </ul>

            <div className="sro-footer">
              <button className="sro-btn sro-btn--save" onClick={saveReorder}>
                <Check size={15}/> حفظ الترتيب
              </button>
              <button className="sro-btn sro-btn--reset" onClick={resetReorder} title="إعادة الترتيب الافتراضي">
                إعادة تعيين
              </button>
              <button className="sro-btn sro-btn--cancel" onClick={cancelReorder}>
                إلغاء
              </button>
            </div>

          </div>
        </div>
      )}
    </>
  );
}
