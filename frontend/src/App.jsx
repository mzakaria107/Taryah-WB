import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { usePermissions } from './context/PermissionsContext';
import AppLayout from './components/Layout/AppLayout';

// Lazy-loaded pages
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

function RoleRoute({ children, pageKey }) {
  const { user } = useAuth();
  const { canAccess } = usePermissions();
  if (!user) return <Navigate to="/login" replace />;
  if (pageKey && !canAccess(user.role, pageKey)) {
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

      <Route path="/" element={
        <RoleRoute pageKey="dashboard">
          <AppLayout>
            <PageSuspense><Dashboard /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/invoices" element={
        <RoleRoute pageKey="invoices">
          <AppLayout>
            <PageSuspense><Invoices /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/reports" element={
        <RoleRoute pageKey="reports">
          <AppLayout>
            <PageSuspense><Reports /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/upload" element={
        <RoleRoute pageKey="upload">
          <AppLayout>
            <PageSuspense><Upload /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/users" element={
        <RoleRoute pageKey="users">
          <AppLayout>
            <PageSuspense><Users /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/permissions" element={
        <RoleRoute pageKey="permissions">
          <AppLayout>
            <PageSuspense><PermissionsPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/sales-activity" element={
        <RoleRoute pageKey="sales_activity">
          <AppLayout>
            <PageSuspense><SalesActivityPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/sales-tasks" element={
        <RoleRoute pageKey="sales_tasks">
          <AppLayout>
            <PageSuspense><SalesTasksPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/customers/:customerId" element={
        <RoleRoute pageKey="customer_detail">
          <AppLayout>
            <PageSuspense><CustomerDetailPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/fridges" element={
        <RoleRoute pageKey="fridges">
          <AppLayout>
            <PageSuspense><FridgesPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/stock" element={
        <RoleRoute pageKey="stock">
          <AppLayout>
            <PageSuspense><StockPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/current-stock" element={
        <RoleRoute pageKey="current_stock">
          <AppLayout>
            <PageSuspense><CurrentStockPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      {/* Fallback */}
      <Route path="*" element={<PrivateRoute><Navigate to="/" replace /></PrivateRoute>} />
    </Routes>
  );
}
