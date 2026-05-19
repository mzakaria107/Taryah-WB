import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const ROLE_LABELS = {
  super_admin:    'مدير عام',
  region_manager: 'مدير منطقة',
  sales_rep:      'مندوب مبيعات',
  it_admin:       'مدير تقنية',
};

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <header className="bg-gray-900 text-white safe-top sticky top-0 z-50 shadow-lg">
      <div className="max-w-screen-2xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold">لوحة أرصدة العملاء</span>
          <span className="hidden md:inline text-xs text-gray-400">| شركة توزيع الغذاء</span>
        </div>

        <div className="flex items-center gap-4">
          {user && (
            <div className="text-right hidden sm:block">
              <p className="text-sm font-medium leading-none">{user.name}</p>
              <p className="text-xs text-gray-400 mt-0.5">{ROLE_LABELS[user.role] || user.role}</p>
            </div>
          )}

          {['super_admin', 'it_admin'].includes(user?.role) && (
            <Link
              to="/admin"
              className="text-xs bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg transition-colors"
            >
              الإدارة
            </Link>
          )}

          <button
            onClick={handleLogout}
            className="text-xs text-gray-300 hover:text-white transition-colors"
          >
            خروج
          </button>
        </div>
      </div>
    </header>
  );
}
