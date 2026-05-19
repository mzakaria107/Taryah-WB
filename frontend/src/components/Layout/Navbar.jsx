import React from 'react';
import { LogOut, MapPin } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import NotificationBell from './NotificationBell';

export default function Navbar({ onMenuClick }) {
  const { user, logout } = useAuth();

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
          aria-label="تبديل القائمة الجانبية"
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
          alt="طرية"
          className="navbar-logo"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
            e.currentTarget.nextElementSibling.style.display = 'flex';
          }}
        />
        <div className="navbar-logo-placeholder" style={{ display: 'none' }}>ط</div>

        <div className="navbar-titles">
          <div className="navbar-title-ar">Taryah Poultry Dashboard</div>
          <div className="navbar-title-en">Taryah Poultry Dashboard</div>
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

        <NotificationBell />

        <button className="navbar-avatar-btn" aria-label={`المستخدم: ${user?.name}`}>
          <div className="navbar-avatar">{initials}</div>
          <span className="navbar-user-name">{user?.name ?? 'مستخدم'}</span>
        </button>

        <button
          className="navbar-icon-btn"
          onClick={logout}
          aria-label="تسجيل الخروج"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
