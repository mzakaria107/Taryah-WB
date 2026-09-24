import React from 'react';
import { LogOut, MapPin, Languages } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import NotificationBell from './NotificationBell';

export default function Navbar({ onMenuClick }) {
  const { user, logout } = useAuth();
  const { lang, setLang, t } = useLanguage();

  const initials = user?.name
    ? user.name.split(' ').map((w) => w[0]).slice(0, 2).join('')
    : 'T';

  return (
    <header className="navbar">
      {/* ── Brand ─────────────────── */}
      <div className="navbar-brand">
        <button
          className="navbar-icon-btn"
          onClick={onMenuClick}
          aria-label={t('toggleSidebar')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="6"  x2="21" y2="6"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>

        {/* Logo — try /logo.png, fallback to placeholder */}
        <img
          src="/logo.png"
          alt={t('logo')}
          className="navbar-logo"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
            e.currentTarget.nextElementSibling.style.display = 'flex';
          }}
        />
        <div className="navbar-logo-placeholder" style={{ display: 'none' }}>ط</div>

        <div className="navbar-titles">
          <div className="navbar-title-ar">{lang === 'ar' ? 'دواجن طرية' : 'Taryah Poultry Dashboard'}</div>
          <div className="navbar-title-en">TARYAH POULTRY DASHBOARD</div>
        </div>
      </div>

      {/* ── Actions ───────────────── */}
      <div className="navbar-actions">
        {user?.region_name && (
          <div className="navbar-region-pill">
            <MapPin size={12} />
            {user.region_name}
          </div>
        )}

        <button
          className="navbar-icon-btn navbar-lang-btn"
          onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
          aria-label={t('language')}
          title={t('language')}
        >
          <Languages size={16} />
          <span className="navbar-lang-code">{lang === 'ar' ? 'EN' : 'ع'}</span>
        </button>

        <NotificationBell />

        <button className="navbar-avatar-btn" aria-label={`${t('user')}: ${user?.name}`}>
          <div className="navbar-avatar">{initials}</div>
          <span className="navbar-user-name">{user?.name ?? t('user')}</span>
        </button>

        <button
          className="navbar-icon-btn"
          onClick={logout}
          aria-label={t('logout')}
          title={t('logout')}
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
