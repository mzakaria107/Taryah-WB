import React from 'react';
import { Search, X } from 'lucide-react';
import './Filters.css';

const MONTH_AR = [
  '', 'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export const EMPTY_FILTERS = {
  search:         '',
  region_id:      '',
  sales_rep_name: '',
  route_id:       '',
  status:         '',
  includeDirect:  true,
  activeYears:    null,   // null = all years
  activeMonths:   null,   // null = all months
};

/* ── Period badge helper ─────────────────────────── */
function periodBadge(activeYears, activeMonths, availableYears) {
  const allY = !activeYears  || activeYears.size  === 0 || activeYears.size  === availableYears.length;
  const allM = !activeMonths || activeMonths.size === 0 || activeMonths.size === 12;
  if (allY && allM) return 'كل الفترات';
  const yPart = allY ? 'كل السنوات' : [...activeYears].sort().join('، ');
  const mPart = allM ? 'كل الأشهر'  : `${activeMonths.size} أشهر`;
  return `${yPart} · ${mPart}`;
}

export default function Filters({
  filters, onChange,
  regions = [], user,
  availableYears = [],
  directStats = null,
  metaReps   = [],   // distinct sales_rep_names from data
  metaRoutes = [],   // distinct route_ids from data
}) {
  const set = (key) => (e) => onChange({ ...filters, [key]: e.target.value });
  const isSuperAdmin = user?.role === 'super_admin';

  /* ── Year chip toggle ──────────────────────────── */
  const toggleYear = (y) => {
    const base = filters.activeYears ? new Set(filters.activeYears) : new Set(availableYears);
    if (base.has(y)) base.delete(y); else base.add(y);
    const next = base.size === availableYears.length ? null : base;
    onChange({ ...filters, activeYears: next });
  };
  const setAllYears = (on) =>
    onChange({ ...filters, activeYears: on ? null : new Set([availableYears[availableYears.length - 1]]) });
  const isYearActive = (y) => !filters.activeYears || filters.activeYears.has(y);

  /* ── Month chip toggle ─────────────────────────── */
  const toggleMonth = (m) => {
    const base = filters.activeMonths ? new Set(filters.activeMonths) : new Set(ALL_MONTHS);
    if (base.has(m)) base.delete(m); else base.add(m);
    const next = base.size === 12 ? null : base;
    onChange({ ...filters, activeMonths: next });
  };
  const setAllMonths = (on) =>
    onChange({ ...filters, activeMonths: on ? null : new Set([1]) });
  const isMonthActive = (m) => !filters.activeMonths || filters.activeMonths.has(m);

  /* ── Other toggles ─────────────────────────────── */
  const toggleDirect = () => onChange({ ...filters, includeDirect: !filters.includeDirect });
  const toggleDue    = () => onChange({ ...filters, status: filters.status === 'due' ? '' : 'due' });
  const clear        = () => onChange({ ...EMPTY_FILTERS, includeDirect: filters.includeDirect });

  const badge = periodBadge(filters.activeYears, filters.activeMonths, availableYears);

  return (
    <div className="filters-card">

      {/* ── Period section ── */}
      <div className="filters-period">
        <div className="period-header">
          <span className="period-title">الفترة الزمنية</span>
          <span className="period-badge">{badge}</span>
        </div>

        {/* Year chips */}
        {availableYears.length > 0 && (
          <div className="chips-row">
            <span className="chips-label">السنة:</span>
            <button className={`chip chip--all${!filters.activeYears ? ' chip--active' : ''}`}
              onClick={() => setAllYears(true)} type="button">الكل</button>
            {availableYears.map((y) => (
              <button key={y} className={`chip${isYearActive(y) ? ' chip--active' : ''}`}
                onClick={() => toggleYear(y)} type="button">{y}</button>
            ))}
            <button className="chip chip--ctrl" onClick={() => setAllYears(false)} type="button" title="إلغاء الكل">✕</button>
          </div>
        )}

        {/* Month chips */}
        <div className="chips-row chips-row--months">
          <span className="chips-label">الشهر:</span>
          <button className={`chip chip--all${!filters.activeMonths ? ' chip--active' : ''}`}
            onClick={() => setAllMonths(true)} type="button">الكل</button>
          {ALL_MONTHS.map((m) => (
            <button key={m} className={`chip chip--month${isMonthActive(m) ? ' chip--active' : ''}`}
              onClick={() => toggleMonth(m)} type="button">{m} - {MONTH_AR[m]}</button>
          ))}
          <button className="chip chip--ctrl" onClick={() => setAllMonths(false)} type="button" title="إلغاء الكل">✕</button>
        </div>
      </div>

      {/* ── Row 1: inputs (6 columns) ── */}
      <div className="filters-grid">

        {/* Search */}
        <div className="filter-field col-span-2">
          <label className="filter-label">بحث (اسم العميل عربي أو إنجليزي)</label>
          <div className="filter-search-wrap">
            <input
              type="text" className="filter-input"
              placeholder="اسم العميل…"
              value={filters.search || ''}
              onChange={set('search')}
            />
            <Search size={14} className="filter-search-icon" />
          </div>
        </div>

        {/* Region — from actual invoice data */}
        <div className="filter-field">
          <label className="filter-label">المنطقة</label>
          <select
            className="filter-input"
            value={filters.region_id || ''}
            onChange={set('region_id')}
          >
            <option value="">كل المناطق</option>
            {regions.map((r) => (
              <option key={r.id} value={r.id}>{r.name_ar}</option>
            ))}
          </select>
        </div>

        {/* Sales rep — from invoice data */}
        <div className="filter-field">
          <label className="filter-label">المندوب</label>
          <select
            className="filter-input"
            value={filters.sales_rep_name || ''}
            onChange={set('sales_rep_name')}
          >
            <option value="">كل المندوبين</option>
            {metaReps.map((rep) => (
              <option key={rep} value={rep}>{rep}</option>
            ))}
          </select>
        </div>

        {/* Route — select from actual data */}
        <div className="filter-field">
          <label className="filter-label">خط السير</label>
          <select
            className="filter-input"
            value={filters.route_id || ''}
            onChange={set('route_id')}
          >
            <option value="">كل الخطوط</option>
            {metaRoutes.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>

        {/* Status */}
        <div className="filter-field">
          <label className="filter-label">حالة الدفع</label>
          <select className="filter-input" value={filters.status || ''} onChange={set('status')}>
            <option value="">الكل</option>
            <option value="due">غير مسددة بالكامل (جزئي + غير مسدد)</option>
            <option value="unpaid">غير مسدد</option>
            <option value="partial">جزئي</option>
            <option value="paid">مسدد</option>
          </select>
        </div>
      </div>

      {/* ── Row 2: toggles & actions ── */}
      <div className="filters-row2">

        {/* Direct sales toggle */}
        <div className="direct-toggle-wrap">
          <button className="toggle-btn" onClick={toggleDirect} type="button">
            <span className={`toggle-track${filters.includeDirect !== false ? ' on' : ''}`}>
              <span className="toggle-thumb" />
            </span>
            <span className="toggle-label">
              المبيعات المباشرة:{' '}
              <strong className={filters.includeDirect !== false ? 'direct-on' : 'direct-off'}>
                {filters.includeDirect !== false ? 'مُدرجة' : 'مستبعدة'}
              </strong>
            </span>
          </button>
          {directStats && (
            <span className="direct-stats">
              {directStats.rows.toLocaleString('en-SA')} صف ·{' '}
              {Number(directStats.balance).toLocaleString('ar-SA', { maximumFractionDigits: 0 })} ريال
            </span>
          )}
        </div>

        {/* Quick: due (unpaid+partial) */}
        <button
          className={`quick-btn${filters.status === 'due' ? ' quick-btn--active' : ''}`}
          onClick={toggleDue} type="button"
        >
          الرصيد المتبقي فقط
        </button>

        {/* Clear */}
        <button className="clear-btn" onClick={clear} type="button">
          <X size={12} /> مسح الفلاتر
        </button>
      </div>
    </div>
  );
}
