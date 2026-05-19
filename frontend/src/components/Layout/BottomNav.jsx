import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  MessageSquare,
  UserSearch,
  ClipboardList,
  Thermometer,
  Package,
  Warehouse,
  Upload,
  Users,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const ITEMS = [
  { to: '/',               label: 'الرئيسية',  icon: <LayoutDashboard size={20}/>, roles: ['super_admin','it_admin','supervisor','region_manager','sales_rep','viewer'] },
  { to: '/invoices',       label: 'الفواتير',  icon: <FileText        size={20}/>, roles: ['super_admin','it_admin','supervisor','region_manager','sales_rep','viewer'] },
  { to: '/reports',        label: 'الملاحظات', icon: <MessageSquare   size={20}/>, roles: ['super_admin','it_admin','supervisor','region_manager','sales_rep'] },
  { to: '/sales-activity', label: 'العملاء',   icon: <UserSearch      size={20}/>, roles: ['super_admin','it_admin','supervisor','region_manager','sales_rep'] },
  { to: '/sales-tasks',    label: 'المهام',    icon: <ClipboardList   size={20}/>, roles: ['super_admin','it_admin','supervisor','region_manager','sales_rep','fridge_admin'] },
  { to: '/fridges',        label: 'الثلاجات',  icon: <Thermometer     size={20}/>, roles: ['super_admin','it_admin','region_manager','fridge_admin'] },
  { to: '/stock',          label: 'المخزون',   icon: <Package         size={20}/>, roles: ['super_admin','it_admin'] },
  { to: '/current-stock',  label: 'الحالي',    icon: <Warehouse       size={20}/>, roles: ['super_admin','it_admin'] },
  { to: '/upload',         label: 'رفع',       icon: <Upload          size={20}/>, roles: ['super_admin','it_admin'] },
  { to: '/users',          label: 'المستخدمون',icon: <Users           size={20}/>, roles: ['super_admin'] },
  { to: '/permissions',    label: 'الصلاحيات', icon: <ShieldCheck     size={20}/>, roles: ['super_admin','it_admin'] },
];

export default function BottomNav() {
  const { user } = useAuth();
  const role = user?.role;

  const visible = ITEMS.filter(
    (n) => n.roles && role && n.roles.includes(role)
  );

  return (
    <nav className="bottom-nav" aria-label="التنقل السفلي">
      {visible.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          className={({ isActive }) =>
            `bottom-nav-item${isActive ? ' active' : ''}`
          }
        >
          {n.icon}
          <span>{n.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
