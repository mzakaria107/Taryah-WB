import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, FileText, MessageSquare, UserSearch,
  ClipboardList, Thermometer, Package, Warehouse, Upload, Users, ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { usePermissions } from '../../context/PermissionsContext';

const ITEMS = [
  { to: '/',               pageKey: 'dashboard',      label: 'الرئيسية',  icon: <LayoutDashboard size={20}/> },
  { to: '/invoices',       pageKey: 'invoices',       label: 'الفواتير',  icon: <FileText        size={20}/> },
  { to: '/reports',        pageKey: 'reports',        label: 'الملاحظات', icon: <MessageSquare   size={20}/> },
  { to: '/sales-activity', pageKey: 'sales_activity', label: 'العملاء',   icon: <UserSearch      size={20}/> },
  { to: '/sales-tasks',    pageKey: 'sales_tasks',    label: 'المهام',    icon: <ClipboardList   size={20}/> },
  { to: '/fridges',        pageKey: 'fridges',        label: 'الثلاجات',  icon: <Thermometer     size={20}/> },
  { to: '/stock',          pageKey: 'stock',          label: 'المخزون',   icon: <Package         size={20}/> },
  { to: '/current-stock',  pageKey: 'current_stock',  label: 'الحالي',    icon: <Warehouse       size={20}/> },
  { to: '/upload',         pageKey: 'upload',         label: 'رفع',       icon: <Upload          size={20}/> },
  { to: '/users',          pageKey: 'users',          label: 'المستخدمون',icon: <Users           size={20}/> },
  { to: '/permissions',    pageKey: 'permissions',    label: 'الصلاحيات', icon: <ShieldCheck     size={20}/> },
];

export default function BottomNav() {
  const { user } = useAuth();
  const { canAccess } = usePermissions();

  const visible = ITEMS.filter(n => user && canAccess(user.role, n.pageKey));

  return (
    <nav className="bottom-nav" aria-label="التنقل السفلي">
      {visible.map(n => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          className={({ isActive }) => `bottom-nav-item${isActive ? ' active' : ''}`}
        >
          {n.icon}
          <span>{n.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
