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

/* ── Guards ──────────────────────────────────────── */
function PrivateRoute({ children }) {
  const { token } = useAuth();
  return token ? children : <Navigate to="/login" replace />;
}

function RoleRoute({ children, roles }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
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
        <PrivateRoute>
          <AppLayout>
            <PageSuspense><Dashboard /></PageSuspense>
          </AppLayout>
        </PrivateRoute>
      } />

      <Route path="/invoices" element={
        <PrivateRoute>
          <AppLayout>
            <PageSuspense><Invoices /></PageSuspense>
          </AppLayout>
        </PrivateRoute>
      } />

      <Route path="/reports" element={
        <PrivateRoute>
          <AppLayout>
            <PageSuspense><Reports /></PageSuspense>
          </AppLayout>
        </PrivateRoute>
      } />

      <Route path="/upload" element={
        <RoleRoute roles={['super_admin', 'it_admin']}>
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

      {/* Sales Activity Report */}
      <Route path="/sales-activity" element={
        <PrivateRoute>
          <AppLayout>
            <PageSuspense><SalesActivityPage /></PageSuspense>
          </AppLayout>
        </PrivateRoute>
      } />

      {/* Sales Tasks */}
      <Route path="/sales-tasks" element={
        <PrivateRoute>
          <AppLayout>
            <PageSuspense><SalesTasksPage /></PageSuspense>
          </AppLayout>
        </PrivateRoute>
      } />

      {/* Customer detail sub-page */}
      <Route path="/customers/:customerId" element={
        <PrivateRoute>
          <AppLayout>
            <PageSuspense><CustomerDetailPage /></PageSuspense>
          </AppLayout>
        </PrivateRoute>
      } />

      {/* Fridges */}
      <Route path="/fridges" element={
        <PrivateRoute>
          <AppLayout>
            <PageSuspense><FridgesPage /></PageSuspense>
          </AppLayout>
        </PrivateRoute>
      } />

      {/* Stock / NetSuite */}
      <Route path="/stock" element={
        <PrivateRoute>
          <AppLayout>
            <PageSuspense><StockPage /></PageSuspense>
          </AppLayout>
        </PrivateRoute>
      } />

      {/* Current Stock — live NetSuite web query */}
      <Route path="/current-stock" element={
        <PrivateRoute>
          <AppLayout>
            <PageSuspense><CurrentStockPage /></PageSuspense>
          </AppLayout>
        </PrivateRoute>
      } />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
