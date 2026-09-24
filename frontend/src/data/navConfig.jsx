/**
 * navConfig.jsx
 * Single source of truth for all sidebar/bottom-nav items.
 * Icons are render functions so callers control the size.
 */
import React from 'react';
import {
  LayoutDashboard, FileText, MessageSquare, Upload, Users, UserSearch,
  ClipboardList, Thermometer, Package, Warehouse, ShieldCheck, TrendingUp,
  Mail, BarChart2, Contact, PieChart, Store, Wallet, ClockArrowUp,
  UserCog, Activity, Layers, Target, Tag, ClipboardCheck, Boxes, SearchCheck, Truck,
} from 'lucide-react';

/** Master list — order here is the fallback default.
 *  labelEn/labelShortEn are shown when the shell language is switched to
 *  English (see LanguageContext) — page content itself stays Arabic-only
 *  for now, this only covers the sidebar/bottom-nav labels. */
export const ALL_NAV = [
  { to: '/',               pageKey: 'dashboard',       label: 'الرئيسية',        labelShort: 'الرئيسية',   labelEn: 'Dashboard',            labelShortEn: 'Home',        icon: s => <LayoutDashboard size={s}/> },
  { to: '/invoices',       pageKey: 'invoices',        label: 'الفواتير',         labelShort: 'الفواتير',   labelEn: 'Invoices',              labelShortEn: 'Invoices',    icon: s => <FileText        size={s}/> },
  { to: '/reports',        pageKey: 'reports',         label: 'سجل الملاحظات',   labelShort: 'الملاحظات',  labelEn: 'Notes Log',             labelShortEn: 'Notes',       icon: s => <MessageSquare   size={s}/> },
  { to: '/sales-activity', pageKey: 'sales_activity',  label: 'تقرير العملاء',   labelShort: 'العملاء',    labelEn: 'Customer Report',       labelShortEn: 'Customers',   icon: s => <UserSearch      size={s}/> },
  { to: '/sales-tasks',    pageKey: 'sales_tasks',     label: 'مهام المبيعات',   labelShort: 'المهام',     labelEn: 'Sales Tasks',           labelShortEn: 'Tasks',       icon: s => <ClipboardList   size={s}/> },
  { to: '/fridges',        pageKey: 'fridges',         label: 'متابعة الثلاجات', labelShort: 'الثلاجات',  labelEn: 'Fridges',               labelShortEn: 'Fridges',     icon: s => <Thermometer     size={s}/> },
  { to: '/stock',          pageKey: 'stock',           label: 'المخزون',          labelShort: 'المخزون',    labelEn: 'Stock',                 labelShortEn: 'Stock',       icon: s => <Package         size={s}/> },
  { to: '/current-stock',  pageKey: 'current_stock',   label: 'المخزون الحالي',  labelShort: 'الحالي',     labelEn: 'Current Stock',         labelShortEn: 'Current',     icon: s => <Warehouse       size={s}/> },
  { to: '/upload',         pageKey: 'upload',          label: 'رفع البيانات',    labelShort: 'رفع',        labelEn: 'Upload Data',           labelShortEn: 'Upload',      icon: s => <Upload          size={s}/> },
  { to: '/users',          pageKey: 'users',           label: 'المستخدمون',      labelShort: 'المستخدمون', labelEn: 'Users',                 labelShortEn: 'Users',       icon: s => <Users           size={s}/> },
  { to: '/permissions',    pageKey: 'permissions',     label: 'الصلاحيات',       labelShort: 'الصلاحيات',  labelEn: 'Permissions',           labelShortEn: 'Permissions', icon: s => <ShieldCheck     size={s}/> },
  { to: '/sales-report',   pageKey: 'sales_report',   label: 'صفحة المبيعات',   labelShort: 'المبيعات',   labelEn: 'Sales Report',          labelShortEn: 'Sales',       icon: s => <BarChart2       size={s}/> },
  { to: '/coverage',       pageKey: 'coverage',        label: 'تغطية المناديب',   labelShort: 'التغطية',    labelEn: 'Rep Coverage',          labelShortEn: 'Coverage',    icon: s => <Contact         size={s}/> },
  { to: '/summary',        pageKey: 'summary',         label: 'الملخص العام',     labelShort: 'الملخص',     labelEn: 'General Summary',       labelShortEn: 'Summary',     icon: s => <PieChart        size={s}/> },
  { to: '/hypermarkets',          pageKey: 'hypermarkets',           label: 'Hypermarkets',         labelShort: 'Hyper',       labelEn: 'Hypermarkets',          labelShortEn: 'Hyper',       icon: s => <Store           size={s}/> },
  { to: '/category-performance',  pageKey: 'category_performance',   label: 'أداء فئات العملاء',    labelShort: 'أداء الفئات', labelEn: 'Category Performance',  labelShortEn: 'Categories',  icon: s => <Layers          size={s}/> },
  { to: '/region-performance',    pageKey: 'region_performance',     label: 'تقييم وتخطيط المناطق', labelShort: 'تخطيط المناطق', labelEn: 'Region Planning',     labelShortEn: 'Planning',    icon: s => <Target          size={s}/> },
  { to: '/quality-issues',        pageKey: 'quality_issues',         label: 'توالف الجودة',         labelShort: 'توالف الجودة', labelEn: 'Quality Issues',       labelShortEn: 'Quality',     icon: s => <ShieldCheck     size={s}/> },
  { to: '/collections-performance', pageKey: 'collections_performance', label: 'أداء التحصيل',        labelShort: 'التحصيل',     labelEn: 'Collections Performance', labelShortEn: 'Collections', icon: s => <Wallet          size={s}/> },
  { to: '/aging',                  pageKey: 'aging',                  label: 'أعمار المديونيات',    labelShort: 'الأعمار',     labelEn: 'Debt Aging',            labelShortEn: 'Aging',       icon: s => <ClockArrowUp    size={s}/> },
  { to: '/rep-management',          pageKey: 'rep_management',         label: 'إدارة المناديب',       labelShort: 'المناديب',    labelEn: 'Rep Management',        labelShortEn: 'Reps',        icon: s => <UserCog         size={s}/> },
  { to: '/performance-dashboard',  pageKey: 'performance_dashboard',  label: 'داشبورد الأداء',       labelShort: 'الأداء',      labelEn: 'Performance Dashboard', labelShortEn: 'Performance', icon: s => <Activity        size={s}/> },
  { to: '/profitability',  pageKey: 'profitability',   label: 'الربحية',          labelShort: 'الربحية',    labelEn: 'Profitability',         labelShortEn: 'Profit',      icon: s => <TrendingUp      size={s}/> },
  { to: '/discount-shops', pageKey: 'discount_shops',  label: 'أداء محلات التخفيضات', labelShort: 'التخفيضات', labelEn: 'Discount Shops',    labelShortEn: 'Discount',    icon: s => <Tag             size={s}/> },
  { to: '/carrefour-damage',        pageKey: 'carrefour_damage_entry',  label: 'مرتجعات وأرصدة واستلامات كارفور',      labelShort: 'إدخال كارفور', labelEn: 'Carrefour Returns, Stock & Orders Entry',  labelShortEn: 'Carrefour Entry', icon: s => <Boxes           size={s}/> },
  { to: '/carrefour-damage-report', pageKey: 'carrefour_damage_report', label: 'تقرير أرصدة ومرتجعات واستلامات كارفور',    labelShort: 'تقرير كارفور', labelEn: 'Carrefour Stock, Returns & Orders Report', labelShortEn: 'Carrefour Report', icon: s => <ClipboardCheck  size={s}/> },
  { to: '/quality-returns',        pageKey: 'quality_returns_entry',  label: 'مرتجعات عيوب الجودة',      labelShort: 'مرتجعات الجودة', labelEn: 'Quality Returns Entry',  labelShortEn: 'QR Entry',  icon: s => <SearchCheck     size={s}/> },
  { to: '/quality-returns-report', pageKey: 'quality_returns_report', label: 'تقرير مرتجعات عيوب الجودة', labelShort: 'تقرير الجودة',   labelEn: 'Quality Returns Report', labelShortEn: 'QR Report', icon: s => <ClipboardCheck  size={s}/> },
  { to: '/fleet-management',       pageKey: 'fleet_management',       label: 'إدارة أسطول السيارات',      labelShort: 'الأسطول',       labelEn: 'Fleet Management',        labelShortEn: 'Fleet',     icon: s => <Truck           size={s}/> },
  { to: '/settings',               pageKey: 'settings',               label: 'الإعدادات',            labelShort: 'الإعدادات',  labelEn: 'Settings',               labelShortEn: 'Settings',    icon: s => <Mail            size={s}/> },
];

/** Lookup map: pageKey → item */
export const NAV_BY_KEY = Object.fromEntries(ALL_NAV.map(n => [n.pageKey, n]));

/** Sort items according to a saved order array. Each entry is either a
 *  plain pageKey string (ungrouped item) or a group node
 *  `{ type: 'group', id, label, keys: [pageKey, ...] }` — see
 *  buildSidebarLayout below for why groups exist. This function only
 *  needs a FLAT ordering (used by the mobile bottom nav, which has no
 *  concept of groups), so a group's keys are simply flattened in place.
 *  Items not mentioned anywhere in `order` are appended at the end. */
export function applyNavOrder(items, order) {
  if (!order || !order.length) return items;
  const flatKeys = [];
  order.forEach(entry => {
    if (typeof entry === 'string') flatKeys.push(entry);
    else if (entry && entry.type === 'group') flatKeys.push(...(entry.keys || []));
  });
  return [...items].sort((a, b) => {
    const ai = flatKeys.indexOf(a.pageKey);
    const bi = flatKeys.indexOf(b.pageKey);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

/** Builds the GROUPED rendering layout for the sidebar from the same
 *  saved order value applyNavOrder reads — admins can bundle related
 *  pages (e.g. the growing list of Carrefour/Quality-Returns entry+report
 *  pairs) under a collapsible named group to keep the sidebar scannable
 *  as more report pages get added. Returns an array of
 *  `{ type:'item', nav }` | `{ type:'group', id, label, items:[nav,...] }`.
 *  A pageKey missing from `order` (a page added after an admin last saved
 *  a custom layout) is appended, ungrouped, at the end — same fallback
 *  `applyNavOrder` uses, so neither function can ever "lose" a nav item. */
export function buildSidebarLayout(items, order) {
  const byKey = Object.fromEntries(items.map(n => [n.pageKey, n]));
  if (!order || !order.length) return items.map(nav => ({ type: 'item', nav }));

  const seen = new Set();
  const layout = [];
  order.forEach(entry => {
    if (typeof entry === 'string') {
      const nav = byKey[entry];
      if (nav && !seen.has(entry)) { seen.add(entry); layout.push({ type: 'item', nav }); }
    } else if (entry && entry.type === 'group') {
      const groupItems = (entry.keys || [])
        .filter(k => byKey[k] && !seen.has(k))
        .map(k => { seen.add(k); return byKey[k]; });
      if (groupItems.length) layout.push({ type: 'group', id: entry.id, label: entry.label, items: groupItems });
    }
  });
  items.forEach(nav => {
    if (!seen.has(nav.pageKey)) layout.push({ type: 'item', nav });
  });
  return layout;
}
