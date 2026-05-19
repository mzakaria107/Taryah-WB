import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  MessageSquare,
  Upload,
  Users,
  UserSearch,
  ClipboardList,
  Thermometer,
  ChevronRight,
  ChevronLeft,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const NAV = [
  { to: '/',         label: 'الرئيسية',     icon: <LayoutDashboard size={18} />, always: true },
  { to: '/invoices', label: 'الفواتير',      icon: <FileText size={18} />,        always: true },
  { to: '/reports',  label: 'سجل الملاحظات', icon: <MessageSquare size={18} />,   always: true },
  { to: '/sales-activity', label: 'تقرير العملاء',   icon: <UserSearch size={18} />,    always: true },
  { to: '/sales-tasks',    label: 'مهام المبيعات',   icon: <ClipboardList size={18} />, always: true },
  { to: '/fridges',        label: 'متابعة الثلاجات', icon: <Thermometer   size={18} />, always: true },
  { to: '/upload',         label: 'رفع البيانات',    icon: <Upload size={18} />,        roles: ['super_admin','it_admin'] },
  { to: '/users',    label: 'المستخدمون',    icon: <Users size={18} />,           roles: ['super_admin'] },
];

export default function Sidebar({ collapsed, onToggle }) {
  const { user } = useAuth();
  const location = useLocation();
  const role     = user?.role;

  const visible = NAV.filter(
    (n) => n.always || (n.roles && role && n.roles.includes(role))
  );

  // Customer sub-page active when URL starts with /customers/
  const onCustomerPage = location.pathname.startsWith('/customers/');

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      {/* Collapse toggle */}
      <button
        className="sidebar-collapse-btn"
        onClick={onToggle}
        aria-label={collapsed ? 'توسيع القائمة' : 'طي القائمة'}
      >
        {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>

      <nav className="sidebar-nav" aria-label="التنقل الرئيسي">
        <div className="sidebar-section">القائمة</div>
        {visible.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              `sidebar-link${isActive ? ' active' : ''}`
            }
            title={collapsed ? n.label : undefined}
          >
            {n.icon}
            <span className="sidebar-link-label">{n.label}</span>
          </NavLink>
        ))}

        {/* Customer sub-page — shown when active, as a visual context item */}
        {onCustomerPage && (
          <>
            <div className="sidebar-section" style={{ marginTop: 8 }}>بيانات العميل</div>
            <div className="sidebar-link active" style={{ pointerEvents:'none' }}>
              <UserSearch size={18} />
              <span className="sidebar-link-label">ملف العميل</span>
            </div>
          </>
        )}
      </nav>
    </aside>
  );
}
