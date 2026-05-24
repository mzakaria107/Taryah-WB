/**
 * navConfig.jsx
 * Single source of truth for all sidebar/bottom-nav items.
 * Icons are render functions so callers control the size.
 */
import React from 'react';
import {
  LayoutDashboard, FileText, MessageSquare, Upload, Users, UserSearch,
  ClipboardList, Thermometer, Package, Warehouse, ShieldCheck, TrendingUp,
  Mail, BarChart2,
} from 'lucide-react';

/** Master list — order here is the fallback default */
export const ALL_NAV = [
  { to: '/',               pageKey: 'dashboard',       label: 'الرئيسية',        labelShort: 'الرئيسية',   icon: s => <LayoutDashboard size={s}/> },
  { to: '/invoices',       pageKey: 'invoices',        label: 'الفواتير',         labelShort: 'الفواتير',   icon: s => <FileText        size={s}/> },
  { to: '/reports',        pageKey: 'reports',         label: 'سجل الملاحظات',   labelShort: 'الملاحظات',  icon: s => <MessageSquare   size={s}/> },
  { to: '/sales-activity', pageKey: 'sales_activity',  label: 'تقرير العملاء',   labelShort: 'العملاء',    icon: s => <UserSearch      size={s}/> },
  { to: '/sales-tasks',    pageKey: 'sales_tasks',     label: 'مهام المبيعات',   labelShort: 'المهام',     icon: s => <ClipboardList   size={s}/> },
  { to: '/fridges',        pageKey: 'fridges',         label: 'متابعة الثلاجات', labelShort: 'الثلاجات',  icon: s => <Thermometer     size={s}/> },
  { to: '/stock',          pageKey: 'stock',           label: 'المخزون',          labelShort: 'المخزون',    icon: s => <Package         size={s}/> },
  { to: '/current-stock',  pageKey: 'current_stock',   label: 'المخزون الحالي',  labelShort: 'الحالي',     icon: s => <Warehouse       size={s}/> },
  { to: '/upload',         pageKey: 'upload',          label: 'رفع البيانات',    labelShort: 'رفع',        icon: s => <Upload          size={s}/> },
  { to: '/users',          pageKey: 'users',           label: 'المستخدمون',      labelShort: 'المستخدمون', icon: s => <Users           size={s}/> },
  { to: '/permissions',    pageKey: 'permissions',     label: 'الصلاحيات',       labelShort: 'الصلاحيات',  icon: s => <ShieldCheck     size={s}/> },
  { to: '/profitability',  pageKey: 'profitability',   label: 'الربحية',          labelShort: 'الربحية',    icon: s => <TrendingUp      size={s}/> },
  { to: '/sales-report',   pageKey: 'sales_report',   label: 'صفحة المبيعات',   labelShort: 'المبيعات',   icon: s => <BarChart2       size={s}/> },
  { to: '/settings',       pageKey: 'settings',        label: 'الإعدادات',        labelShort: 'الإعدادات',  icon: s => <Mail            size={s}/> },
];

/** Lookup map: pageKey → item */
export const NAV_BY_KEY = Object.fromEntries(ALL_NAV.map(n => [n.pageKey, n]));

/** Sort items according to a saved order array (pageKeys).
 *  Items not in the order list are appended at the end. */
export function applyNavOrder(items, order) {
  if (!order || !order.length) return items;
  return [...items].sort((a, b) => {
    const ai = order.indexOf(a.pageKey);
    const bi = order.indexOf(b.pageKey);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}
