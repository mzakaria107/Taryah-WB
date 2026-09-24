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
const SettingsPage        = lazy(() => import('./pages/SettingsPage'));
const SalesReportPage     = lazy(() => import('./pages/SalesReportPage'));
const CoveragePage        = lazy(() => import('./pages/CoveragePage'));
const SummaryPage         = lazy(() => import('./pages/SummaryPage'));
const HypermarketsPage             = lazy(() => import('./pages/HypermarketsPage'));
const CategoryPerformancePage      = lazy(() => import('./pages/CategoryPerformancePage'));
const RegionPerformancePage        = lazy(() => import('./pages/RegionPerformancePage'));
const QualityIssuesPage            = lazy(() => import('./pages/QualityIssuesPage'));
const CollectionsPerformancePage   = lazy(() => import('./pages/CollectionsPerformancePage'));
const AgingPage                    = lazy(() => import('./pages/AgingPage'));
const RepManagementPage            = lazy(() => import('./pages/RepManagementPage'));
const PerformanceDashboardPage     = lazy(() => import('./pages/PerformanceDashboardPage'));
const RepDebtPage                  = lazy(() => import('./pages/RepDebtPage'));
const ProfitabilityPage            = lazy(() => import('./pages/ProfitabilityPage'));
const DiscountShopsPage            = lazy(() => import('./pages/DiscountShopsPage'));
const CarrefourDamageEntryPage     = lazy(() => import('./pages/CarrefourDamageEntryPage'));
const CarrefourDamageReportPage    = lazy(() => import('./pages/CarrefourDamageReportPage'));
const QualityReturnsEntryPage      = lazy(() => import('./pages/QualityReturnsEntryPage'));
const QualityReturnsReportPage     = lazy(() => import('./pages/QualityReturnsReportPage'));
const FleetManagementPage          = lazy(() => import('./pages/FleetManagementPage'));

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
    const fallback = user.role === 'fridge_admin' ? '/fridges'
      : user.role === 'carrefour_rep' ? '/carrefour-damage'
      : user.role === 'quality_returns_monitor' ? '/quality-returns'
      : user.role === 'fleet_supervisor' ? '/fleet-management'
      : '/';
    return <Navigate to={fallback} replace />;
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

      <Route path="/settings" element={
        <RoleRoute pageKey="settings">
          <AppLayout>
            <PageSuspense><SettingsPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/sales-report" element={
        <RoleRoute pageKey="sales_report">
          <AppLayout>
            <PageSuspense><SalesReportPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/coverage" element={
        <RoleRoute pageKey="coverage">
          <AppLayout>
            <PageSuspense><CoveragePage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/summary" element={
        <RoleRoute pageKey="summary">
          <AppLayout>
            <PageSuspense><SummaryPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/hypermarkets" element={
        <RoleRoute pageKey="hypermarkets">
          <AppLayout>
            <PageSuspense><HypermarketsPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/category-performance" element={
        <RoleRoute pageKey="category_performance">
          <AppLayout>
            <PageSuspense><CategoryPerformancePage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/region-performance" element={
        <RoleRoute pageKey="region_performance">
          <AppLayout>
            <PageSuspense><RegionPerformancePage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/quality-issues" element={
        <RoleRoute pageKey="quality_issues">
          <AppLayout>
            <PageSuspense><QualityIssuesPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/collections-performance" element={
        <RoleRoute pageKey="collections_performance">
          <AppLayout>
            <PageSuspense><CollectionsPerformancePage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/aging" element={
        <RoleRoute pageKey="aging">
          <AppLayout>
            <PageSuspense><AgingPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/rep-management" element={
        <RoleRoute pageKey="rep_management">
          <AppLayout>
            <PageSuspense><RepManagementPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/performance-dashboard" element={
        <RoleRoute pageKey="performance_dashboard">
          <AppLayout>
            <PageSuspense><PerformanceDashboardPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/rep-debt/:repName" element={
        <RoleRoute pageKey="summary">
          <AppLayout>
            <PageSuspense><RepDebtPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/profitability" element={
        <RoleRoute pageKey="profitability">
          <AppLayout>
            <PageSuspense><ProfitabilityPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/discount-shops" element={
        <RoleRoute pageKey="discount_shops">
          <AppLayout>
            <PageSuspense><DiscountShopsPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/carrefour-damage" element={
        <RoleRoute pageKey="carrefour_damage_entry">
          <AppLayout>
            <PageSuspense><CarrefourDamageEntryPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/carrefour-damage-report" element={
        <RoleRoute pageKey="carrefour_damage_report">
          <AppLayout>
            <PageSuspense><CarrefourDamageReportPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/quality-returns" element={
        <RoleRoute pageKey="quality_returns_entry">
          <AppLayout>
            <PageSuspense><QualityReturnsEntryPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/quality-returns-report" element={
        <RoleRoute pageKey="quality_returns_report">
          <AppLayout>
            <PageSuspense><QualityReturnsReportPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      <Route path="/fleet-management" element={
        <RoleRoute pageKey="fleet_management">
          <AppLayout>
            <PageSuspense><FleetManagementPage /></PageSuspense>
          </AppLayout>
        </RoleRoute>
      } />

      {/* Fallback */}
      <Route path="*" element={<PrivateRoute><Navigate to="/" replace /></PrivateRoute>} />
    </Routes>
  );
}
