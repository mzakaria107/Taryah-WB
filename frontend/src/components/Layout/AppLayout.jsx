import React, { useState } from 'react';
import { useLocation } from 'react-router-dom';
import Navbar from './Navbar';
import Sidebar from './Sidebar';
import BottomNav from './BottomNav';
import './AppLayout.css';

export default function AppLayout({ children }) {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();

  return (
    <>
      <Navbar onMenuClick={() => setCollapsed((c) => !c)} />
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <BottomNav />

      <div className={`app-shell${collapsed ? ' sidebar-collapsed' : ''}`}>
        <main className="app-main">
          {/* key triggers CSS pageIn animation on route change */}
          <div key={location.pathname} className="page-enter">
            {children}
          </div>
        </main>
      </div>
    </>
  );
}
