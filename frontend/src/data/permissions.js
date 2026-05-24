/* Shared permissions data — used by PermissionsContext and PermissionsPage */

export const ROLES = [
  { key: 'super_admin',    label: 'مدير عام',             color: 'role-super'     },
  { key: 'it_admin',       label: 'مدير تقنية',           color: 'role-it'        },
  { key: 'top_management', label: 'الإدارة العليا',        color: 'role-top'       },
  { key: 'sales_manager',  label: 'مدير مبيعات',          color: 'role-sales-mgr' },
  { key: 'supervisor',     label: 'مشرف',                 color: 'role-sup'       },
  { key: 'region_manager', label: 'مدير منطقة',           color: 'role-region'    },
  { key: 'sales_rep',      label: 'مندوب مبيعات',         color: 'role-sales'     },
  { key: 'fridge_admin',   label: 'موظف إداري (ثلاجات)', color: 'role-fridge'    },
  { key: 'viewer',         label: 'مستعرض',               color: 'role-viewer'    },
];

export const PAGES = [
  { key: 'dashboard',       label: 'لوحة التحكم',       path: '/',               desc: 'ملخص الأرصدة والعملاء وبطاقات KPI' },
  { key: 'invoices',        label: 'الفواتير',           path: '/invoices',       desc: 'عرض وتصفية فواتير العملاء' },
  { key: 'reports',         label: 'سجل الملاحظات',     path: '/reports',        desc: 'إضافة وعرض ملاحظات العملاء' },
  { key: 'customer_detail', label: 'ملف العميل',         path: '/customers/:id', desc: 'تفاصيل العميل وسجل فواتيره' },
  { key: 'sales_activity',  label: 'تقرير العملاء',     path: '/sales-activity', desc: 'نشاط المبيعات وتحليل الأداء' },
  { key: 'sales_tasks',     label: 'مهام المبيعات',     path: '/sales-tasks',    desc: 'إدارة المهام ومتابعتها' },
  { key: 'fridges',         label: 'متابعة الثلاجات',   path: '/fridges',        desc: 'إدارة الثلاجات والنقل بين المواقع' },
  { key: 'stock',           label: 'المخزون (NetSuite)', path: '/stock',          desc: 'بيانات المخزون التاريخية' },
  { key: 'current_stock',   label: 'المخزون الحالي',    path: '/current-stock',  desc: 'مخزون NetSuite الحالي (مباشر)' },
  { key: 'upload',          label: 'رفع البيانات',       path: '/upload',         desc: 'استيراد ملفات Excel لتحديث البيانات' },
  { key: 'users',           label: 'إدارة المستخدمين',  path: '/users',          desc: 'إنشاء وتعديل الحسابات وتغيير الأدوار' },
  { key: 'permissions',     label: 'الصلاحيات',          path: '/permissions',    desc: 'عرض وتعديل جدول صلاحيات الأدوار' },
  { key: 'profitability',   label: 'الربحية',            path: '/profitability',  desc: 'تقرير ربحية المنتجات من NetSuite' },
  { key: 'settings',       label: 'الإعدادات',          path: '/settings',       desc: 'إعدادات خادم البريد الإلكتروني SMTP' },
];

/* Default access matrix — fallback before API loads */
export const DEFAULT_PERMS = {
  dashboard:       { super_admin:2, it_admin:2, top_management:1, sales_manager:2, supervisor:1, region_manager:1, sales_rep:1, fridge_admin:0, viewer:1 },
  invoices:        { super_admin:2, it_admin:2, top_management:1, sales_manager:2, supervisor:1, region_manager:1, sales_rep:1, fridge_admin:0, viewer:1 },
  reports:         { super_admin:2, it_admin:2, top_management:1, sales_manager:2, supervisor:2, region_manager:2, sales_rep:2, fridge_admin:0, viewer:0 },
  customer_detail: { super_admin:2, it_admin:2, top_management:1, sales_manager:2, supervisor:1, region_manager:1, sales_rep:1, fridge_admin:0, viewer:1 },
  sales_activity:  { super_admin:2, it_admin:2, top_management:1, sales_manager:2, supervisor:1, region_manager:1, sales_rep:1, fridge_admin:0, viewer:0 },
  sales_tasks:     { super_admin:2, it_admin:2, top_management:1, sales_manager:2, supervisor:2, region_manager:2, sales_rep:2, fridge_admin:1, viewer:0 },
  fridges:         { super_admin:2, it_admin:2, top_management:1, sales_manager:0, supervisor:0, region_manager:1, sales_rep:0, fridge_admin:1, viewer:0 },
  stock:           { super_admin:2, it_admin:2, top_management:0, sales_manager:0, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, viewer:0 },
  current_stock:   { super_admin:2, it_admin:2, top_management:0, sales_manager:0, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, viewer:0 },
  upload:          { super_admin:2, it_admin:2, top_management:0, sales_manager:0, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, viewer:0 },
  users:           { super_admin:2, it_admin:0, top_management:0, sales_manager:0, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, viewer:0 },
  permissions:     { super_admin:2, it_admin:1, top_management:0, sales_manager:0, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, viewer:0 },
  profitability:   { super_admin:2, it_admin:2, top_management:1, sales_manager:2, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, viewer:0 },
  settings:        { super_admin:2, it_admin:2, top_management:0, sales_manager:0, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, viewer:0 },
};

/* Access level display config */
export const LEVEL_MAP = {
  0: { icon: '✕', label: 'محظور',        cls: 'pp-no'   },
  1: { icon: '◉', label: 'قراءة فقط',   cls: 'pp-read' },
  2: { icon: '✓', label: 'صلاحية كاملة', cls: 'pp-full' },
};
