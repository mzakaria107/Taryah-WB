import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { usePermissions } from '../../context/PermissionsContext';
import { useSidebarOrder } from '../../context/SidebarOrderContext';
import { useLanguage } from '../../context/LanguageContext';
import { ALL_NAV, applyNavOrder } from '../../data/navConfig';

export default function BottomNav() {
  const { user }      = useAuth();
  const { canAccess } = usePermissions();
  const { order }     = useSidebarOrder();
  const { lang, t }   = useLanguage();

  const orderedNav = applyNavOrder(ALL_NAV, order);
  const visible    = orderedNav.filter(n => user && canAccess(user.role, n.pageKey));

  return (
    <nav className="bottom-nav" aria-label={t('bottomNav')}>
      {visible.map(n => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          className={({ isActive }) => `bottom-nav-item${isActive ? ' active' : ''}`}
        >
          {n.icon(20)}
          <span>{lang === 'en' ? (n.labelShortEn || n.labelShort) : n.labelShort}</span>
        </NavLink>
      ))}
    </nav>
  );
}
