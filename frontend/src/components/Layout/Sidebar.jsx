import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, FileText, MessageSquare, Upload, Users, UserSearch,
  ClipboardList, Thermometer, Package, Warehouse, ShieldCheck,
  ChevronRight, ChevronLeft,
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
];

export default function Sidebar({ collapsed, onToggle }) {
  const { user } = useAuth();
  const { canAccess } = usePermissions();
  const location = useLocation();

  const visible = NAV.filter(n => user && canAccess(user.role, n.pageKey));
  const onCustomerPage = location.pathname.startsWith('/customers/');

  return (
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
    </aside>
  );
}
