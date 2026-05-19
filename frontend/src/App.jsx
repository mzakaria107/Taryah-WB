import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import AppLayout from './components/Layout/AppLayout';

// Lazy-loaded pages for code splitting
const Login              = lazy(() => import('./pages/Login'));
const Dashboard          = lazy(() => import('./pages/Dashboard'));
const Invoices           = lazy(() => import('./pages/Invoices'));
const Reports            = lazy(() => import('./pages/Reports'));
const Upload             = lazy(() => import('./pages/Upload'));
const Users              = lazy(() => import('./pages/Users'));
const CustomerDetailPage  = lazy(() => import('./pages/CustomerDetailPage'));
const SalesActivityPage   = lazy(() => import('./pages/SalesActivityPage'));
const SalesTasksPage      = lazy(() => import('./pages/SalesTasksPage'));
const FridgesPage         = lazy(() => import('./pages/FridgesPage'));
const StockPage           = lazy(() => import('./pages/StockPage'));
const CurrentStockPage    = lazy(() => import('./pages/CurrentStockPage'));
const PermissionsPage     = lazy(() => import('./pages/PermissionsPage'));

/* ── Guards ──────────────────────────────────────── */
function PrivateRoute({ children }) {
  const { token } = useAuth();
  return token ? children : <Navigate to="/login" replace />;
}

function RoleRoute({ children, roles }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) {
    return <Navigate to={user.role === 'fridge_admin' ? '/fridges' : '/'} replace />;
  }
  return children;
}

function PageSuspense({ children }) {
  return (
    <Suspense fallback={
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)' }}>
        جاري التحميل…
      </div>
    }>
      {children}
    </Suspense>
  );
}

/* ── App ─────────────────────────────────────────── */
export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={
        <PageSuspense><Login /></PageSuspense>
      } />

      {/* Protected — wrapped in AppLayout */}
      <Route path="/" element={
        <RoleRoute roles={['super_admin','it_admin','supervisor','region_manager','sales_rep','viewer']}>
          <AppLayout>
            <PageSuspense><Dashboard /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/invoices" element={
        <RoleRoute roles={['super_admin','it_admin','supervisor','region_manager','sales_rep','viewer']}>
          <AppLayout>
            <PageSuspense><Invoices /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/reports" element={
        <RoleRoute roles={['super_admin','it_admin','supervisor','region_manager','sales_rep']}>
          <AppLayout>
            <PageSuspense><Reports /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/upload" element={
        <RoleRoute roles={['super_admin','it_admin']}>
          <AppLayout>
            <PageSuspense><Upload /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/users" element={
        <RoleRoute roles={['super_admin']}>
          <AppLayout>
            <PageSuspense><Users /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/permissions" element={
        <RoleRoute roles={['super_admin','it_admin']}>
          <AppLayout>
            <PageSuspense><PermissionsPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      {/* Sales Activity Report */}
      <Route path="/sales-activity" element={
        <RoleRoute roles={['super_admin','it_admin','supervisor','region_manager','sales_rep']}>
          <AppLayout>
            <PageSuspense><SalesActivityPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      {/* Sales Tasks */}
      <Route path="/sales-tasks" element={
        <RoleRoute roles={['super_admin','it_admin','supervisor','region_manager','sales_rep','fridge_admin']}>
          <AppLayout>
            <PageSuspense><SalesTasksPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      {/* Customer detail sub-page */}
      <Route path="/customers/:customerId" element={
        <RoleRoute roles={['super_admin','it_admin','supervisor','region_manager','sales_rep','viewer']}>
          <AppLayout>
            <PageSuspense><CustomerDetailPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      {/* Fridges */}
      <Route path="/fridges" element={
        <RoleRoute roles={['super_admin','it_admin','region_manager','fridge_admin']}>
          <AppLayout>
            <PageSuspense><FridgesPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      {/* Stock / NetSuite */}
      <Route path="/stock" element={
        <RoleRoute roles={['super_admin','it_admin']}>
          <AppLayout>
            <PageSuspense><StockPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      {/* Current Stock — live NetSuite web query */}
      <Route path="/current-stock" element={
        <RoleRoute roles={['super_admin','it_admin']}>
          <AppLayout>
            <PageSuspense><CurrentStockPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
