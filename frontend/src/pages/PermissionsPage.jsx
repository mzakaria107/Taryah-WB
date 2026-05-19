import React, { useState } from 'react';
import { ShieldCheck, Info } from 'lucide-react';
import './PermissionsPage.css';

/* ── Role definitions ─────────────────────────────── */
const ROLES = [
  { key: 'super_admin',    label: 'مدير عام',              color: 'role-super'   },
  { key: 'it_admin',       label: 'مدير تقنية',            color: 'role-it'      },
  { key: 'supervisor',     label: 'مشرف',                  color: 'role-sup'     },
  { key: 'region_manager', label: 'مدير منطقة',            color: 'role-region'  },
  { key: 'sales_rep',      label: 'مندوب مبيعات',          color: 'role-sales'   },
  { key: 'fridge_admin',   label: 'موظف إداري (ثلاجات)',   color: 'role-fridge'  },
  { key: 'viewer',         label: 'مستعرض',                color: 'role-viewer'  },
];

/* ── Pages / features matrix ─────────────────────── */
// access: 0=لا, 1=قراءة, 2=كامل, 3=كل المناطق, 4=منطقته فقط
const PAGES = [
  {
    page: 'لوحة التحكم',
    path: '/',
    desc: 'ملخص الأرصدة والعملاء وبطاقات KPI',
    super_admin:2, it_admin:2, supervisor:1, region_manager:1, sales_rep:1, fridge_admin:0, viewer:1,
  },
  {
    page: 'الفواتير',
    path: '/invoices',
    desc: 'عرض وتصفية فواتير العملاء',
    super_admin:2, it_admin:2, supervisor:1, region_manager:1, sales_rep:1, fridge_admin:0, viewer:1,
  },
  {
    page: 'ملف العميل',
    path: '/customers/:id',
    desc: 'تفاصيل العميل وسجل فواتيره',
    super_admin:2, it_admin:2, supervisor:1, region_manager:1, sales_rep:1, fridge_admin:0, viewer:1,
  },
  {
    page: 'سجل الملاحظات',
    path: '/reports',
    desc: 'إضافة وعرض ملاحظات العملاء',
    super_admin:2, it_admin:2, supervisor:2, region_manager:2, sales_rep:2, fridge_admin:0, viewer:0,
  },
  {
    page: 'تقرير العملاء',
    path: '/sales-activity',
    desc: 'نشاط المبيعات وتحليل الأداء',
    super_admin:2, it_admin:2, supervisor:1, region_manager:1, sales_rep:1, fridge_admin:0, viewer:0,
  },
  {
    page: 'مهام المبيعات',
    path: '/sales-tasks',
    desc: 'إدارة المهام ومتابعتها',
    super_admin:2, it_admin:2, supervisor:2, region_manager:2, sales_rep:2, fridge_admin:1, viewer:0,
  },
  {
    page: 'متابعة الثلاجات',
    path: '/fridges',
    desc: 'إدارة الثلاجات والنقل بين المواقع',
    super_admin:2, it_admin:2, supervisor:0, region_manager:1, sales_rep:0, fridge_admin:1, viewer:0,
  },
  {
    page: 'المخزون (NetSuite)',
    path: '/stock',
    desc: 'بيانات المخزون التاريخية',
    super_admin:2, it_admin:2, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, viewer:0,
  },
  {
    page: 'المخزون الحالي',
    path: '/current-stock',
    desc: 'مخزون NetSuite الحالي (مباشر)',
    super_admin:2, it_admin:2, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, viewer:0,
  },
  {
    page: 'رفع البيانات',
    path: '/upload',
    desc: 'استيراد ملفات Excel لتحديث البيانات',
    super_admin:2, it_admin:2, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, viewer:0,
  },
  {
    page: 'إدارة المستخدمين',
    path: '/users',
    desc: 'إنشاء وتعديل الحسابات وتغيير الأدوار',
    super_admin:2, it_admin:0, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, viewer:0,
  },
  {
    page: 'الصلاحيات',
    path: '/permissions',
    desc: 'عرض جدول صلاحيات الأدوار',
    super_admin:2, it_admin:1, supervisor:0, region_manager:0, sales_rep:0, fridge_admin:0, viewer:0,
  },
];

/* نطاق البيانات — row at end */
const DATA_SCOPE = {
  page: 'نطاق البيانات',
  path: null,
  desc: 'حدود الوصول الجغرافي للبيانات',
  super_admin:3, it_admin:3, supervisor:4, region_manager:4, sales_rep:4, fridge_admin:4, viewer:3,
};

const PERM_MAP = {
  0: { icon: '✕',  label: 'محظور',          cls: 'pp-no'   },
  1: { icon: '◉',  label: 'قراءة فقط',      cls: 'pp-read' },
  2: { icon: '✓',  label: 'صلاحية كاملة',   cls: 'pp-full' },
  3: { icon: '🌐', label: 'كل المناطق',      cls: 'pp-all'  },
  4: { icon: '📍', label: 'منطقته فقط',      cls: 'pp-own'  },
};

function PermCell({ value }) {
  const { icon, label, cls } = PERM_MAP[value] ?? PERM_MAP[0];
  return (
    <td className={`pp-cell ${cls}`} title={label}>
      <span className="pp-icon">{icon}</span>
    </td>
  );
}

/* ── Role descriptions ───────────────────────────── */
const ROLE_DETAILS = {
  super_admin:    'صلاحية كاملة على جميع الصفحات والبيانات والمستخدمين لجميع المناطق.',
  it_admin:       'يملك صلاحية رفع البيانات والاطلاع على جميع المناطق، بدون إدارة المستخدمين.',
  supervisor:     'مشرف — يرى تقارير المبيعات والملاحظات لمنطقته فقط، بدون وصول للثلاجات أو المخزون.',
  region_manager: 'مدير منطقة — يرى جميع بيانات منطقته بما فيها الثلاجات.',
  sales_rep:      'مندوب مبيعات — يرى بياناته ويضيف ملاحظات، بدون وصول للثلاجات أو المخزون.',
  fridge_admin:   'موظف إداري ثلاجات — يرى صفحة الثلاجات ومهام المبيعات لمنطقته فقط.',
  viewer:         'مستعرض — قراءة فقط للرئيسية والفواتير، بدون أي صلاحية تعديل أو تصدير.',
};

export default function PermissionsPage() {
  const [activeRole, setActiveRole] = useState(null);

  const allRows = [...PAGES, DATA_SCOPE];

  return (
    <div className="pp-page">

      {/* ── Header ── */}
      <div className="pp-header">
        <div>
          <h1 className="pp-title"><ShieldCheck size={20}/> جدول الصلاحيات</h1>
          <p className="pp-subtitle">صلاحيات الوصول لكل صفحة حسب الدور الوظيفي</p>
        </div>
      </div>

      {/* ── Role cards ── */}
      <div className="pp-roles-row">
        {ROLES.map(r => (
          <button
            key={r.key}
            className={`pp-role-card ${activeRole === r.key ? 'pp-role-active' : ''}`}
            onClick={() => setActiveRole(v => v === r.key ? null : r.key)}
          >
            <span className={`pp-role-badge ${r.color}`}>{r.label}</span>
            <span className="pp-role-count">
              {allRows.filter(p => (PERM_MAP[p[r.key]] ?? PERM_MAP[0]).cls !== 'pp-no').length}
              <span className="pp-role-count-lbl"> صفحة</span>
            </span>
          </button>
        ))}
      </div>

      {/* ── Role description box ── */}
      {activeRole && (
        <div className="pp-role-desc">
          <Info size={14}/>
          <strong>{ROLES.find(r => r.key === activeRole)?.label}:</strong>
          {' '}{ROLE_DETAILS[activeRole]}
        </div>
      )}

      {/* ── Matrix table ── */}
      <div className="pp-card">
        <div className="pp-table-wrap">
          <table className="pp-table">
            <thead>
              <tr>
                <th className="pp-th-page">الصفحة</th>
                {ROLES.map(r => (
                  <th
                    key={r.key}
                    className={activeRole === r.key ? 'pp-th-highlight' : ''}
                  >
                    <span className={`pp-role-badge ${r.color}`}>{r.label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allRows.map((row, i) => (
                <tr key={i} className={row.path === null ? 'pp-scope-row' : ''}>
                  <td className="pp-td-page">
                    <div className="pp-page-name">{row.page}</div>
                    <div className="pp-page-desc">{row.desc}</div>
                    {row.path && <div className="pp-page-path">{row.path}</div>}
                  </td>
                  {ROLES.map(r => (
                    <PermCell
                      key={r.key}
                      value={row[r.key]}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div className="pp-legend">
          {Object.entries(PERM_MAP).map(([v, { icon, label, cls }]) => (
            <span key={v} className="pp-legend-item">
              <span className={`pp-icon ${cls}`}>{icon}</span>
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
