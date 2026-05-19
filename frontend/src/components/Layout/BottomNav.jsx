import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, FileText, BarChart2, Upload, Users } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const ITEMS = [
  { to: '/',        label: 'الرئيسية',  icon: <LayoutDashboard size={20} />, always: true },
  { to: '/invoices',label: 'الفواتير',  icon: <FileText size={20} />,        always: true },
  { to: '/reports', label: 'التقارير',  icon: <BarChart2 size={20} />,       always: true },
  { to: '/upload',  label: 'الرفع',     icon: <Upload size={20} />,          roles: ['super_admin','it_admin'] },
  { to: '/users',   label: 'المستخدمون',icon: <Users size={20} />,           roles: ['super_admin'] },
];

export default function BottomNav() {
  const { user } = useAuth();
  const role = user?.role;

  const visible = ITEMS.filter(
    (n) => n.always || (n.roles && role && n.roles.includes(role))
  ).slice(0, 5);

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
