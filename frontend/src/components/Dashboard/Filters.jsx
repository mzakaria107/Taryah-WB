import React from 'react';
import { Search, X } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import './Filters.css';

const MONTH_AR = [
  '', 'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];
const MONTH_EN = [
  '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export const EMPTY_FILTERS = {
  search:         '',
  region_id:      '',
  sales_rep_name: '',
  route_id:       '',
  status:         '',
  includeDirect:  false,
  excludeCarrefour: false, // true = hide Carrefour customers' dues
  activeYears:    null,   // null = all years
  activeMonths:   null,   // null = all months
  catFilter:      {},     // { [catName]: 'include' | 'exclude' }
};

/* ── Period badge helper ─────────────────────────── */
function periodBadge(activeYears, activeMonths, availableYears, en) {
  const allY = !activeYears  || activeYears.size  === 0 || activeYears.size  === availableYears.length;
  const allM = !activeMonths || activeMonths.size === 0 || activeMonths.size === 12;
  if (allY && allM) return en ? 'All periods' : 'كل الفترات';
  const yPart = allY ? (en ? 'All years' : 'كل السنوات') : [...activeYears].sort().join(en ? ', ' : '، ');
  const mPart = allM ? (en ? 'All months' : 'كل الأشهر') : (en ? `${activeMonths.size} months` : `${activeMonths.size} أشهر`);
  return `${yPart} · ${mPart}`;
}

export default function Filters({
  filters, onChange,
  regions = [], user,
  availableYears = [],
  directStats = null,
  metaReps   = [],   // distinct sales_rep_names from data
  metaRoutes = [],   // distinct route_ids from data
  customerCategories = [],
}) {
  const { lang } = useLanguage();
  const en = lang === 'en';
  const MONTHS = en ? MONTH_EN : MONTH_AR;
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
  const toggleDirect    = () => onChange({ ...filters, includeDirect: !filters.includeDirect });
  const toggleCarrefour = () => onChange({ ...filters, excludeCarrefour: !filters.excludeCarrefour });
  const toggleDue    = () => onChange({ ...filters, status: filters.status === 'due' ? '' : 'due' });
  const clear        = () => onChange({ ...EMPTY_FILTERS }); // includeDirect resets to false (default)

  /* ── Category pill toggle ── cycle: neutral → include → exclude → neutral */
  const toggleCat = (cat) => {
    const prev = (filters.catFilter || {})[cat];
    const next = { ...(filters.catFilter || {}) };
    if (!prev)               next[cat] = 'include';
    else if (prev === 'include') next[cat] = 'exclude';
    else                     delete next[cat];
    onChange({ ...filters, catFilter: next });
  };

  const badge = periodBadge(filters.activeYears, filters.activeMonths, availableYears, en);

  return (
    <div className="filters-card">

      {/* ── Period section ── */}
      <div className="filters-period">
        <div className="period-header">
          <span className="period-title">{en ? 'Period' : 'الفترة الزمنية'}</span>
          <span className="period-badge">{badge}</span>
        </div>

        {/* Year chips */}
        {availableYears.length > 0 && (
          <div className="chips-row">
            <span className="chips-label">{en ? 'Year:' : 'السنة:'}</span>
            <button className={`chip chip--all${!filters.activeYears ? ' chip--active' : ''}`}
              onClick={() => setAllYears(true)} type="button">{en ? 'All' : 'الكل'}</button>
            {availableYears.map((y) => (
              <button key={y} className={`chip${isYearActive(y) ? ' chip--active' : ''}`}
                onClick={() => toggleYear(y)} type="button">{y}</button>
            ))}
            <button className="chip chip--ctrl" onClick={() => setAllYears(false)} type="button" title={en ? 'Clear all' : 'إلغاء الكل'}>✕</button>
          </div>
        )}

        {/* Month chips */}
        <div className="chips-row chips-row--months">
          <span className="chips-label">{en ? 'Month:' : 'الشهر:'}</span>
          <button className={`chip chip--all${!filters.activeMonths ? ' chip--active' : ''}`}
            onClick={() => setAllMonths(true)} type="button">{en ? 'All' : 'الكل'}</button>
          {ALL_MONTHS.map((m) => (
            <button key={m} className={`chip chip--month${isMonthActive(m) ? ' chip--active' : ''}`}
              onClick={() => toggleMonth(m)} type="button">{m} - {MONTHS[m]}</button>
          ))}
          <button className="chip chip--ctrl" onClick={() => setAllMonths(false)} type="button" title={en ? 'Clear all' : 'إلغاء الكل'}>✕</button>
        </div>
      </div>

      {/* ── Row 1: inputs (6 columns) ── */}
      <div className="filters-grid">

        {/* Search */}
        <div className="filter-field col-span-2">
          <label className="filter-label">{en ? 'Search (customer name, Arabic or English, or code)' : 'بحث (اسم العميل عربي أو إنجليزي أو رقم العميل)'}</label>
          <div className="filter-search-wrap">
            <input
              type="text" className="filter-input"
              placeholder={en ? 'Customer name or code…' : 'اسم العميل أو رقمه…'}
              value={filters.search || ''}
              onChange={set('search')}
            />
            <Search size={14} className="filter-search-icon" />
          </div>
        </div>

        {/* Region — from actual invoice data */}
        <div className="filter-field">
          <label className="filter-label">{en ? 'Region' : 'المنطقة'}</label>
          <select
            className="filter-input"
            value={filters.region_id || ''}
            onChange={set('region_id')}
          >
            <option value="">{en ? 'All regions' : 'كل المناطق'}</option>
            {regions.map((r) => (
              <option key={r.id} value={r.id}>{r.name_ar}</option>
            ))}
          </select>
        </div>

        {/* Sales rep — from invoice data */}
        <div className="filter-field">
          <label className="filter-label">{en ? 'Rep' : 'المندوب'}</label>
          <select
            className="filter-input"
            value={filters.sales_rep_name || ''}
            onChange={set('sales_rep_name')}
          >
            <option value="">{en ? 'All reps' : 'كل المندوبين'}</option>
            {metaReps.map((rep) => (
              <option key={rep} value={rep}>{rep}</option>
            ))}
          </select>
        </div>

        {/* Route — select from actual data */}
        <div className="filter-field">
          <label className="filter-label">{en ? 'Route' : 'خط السير'}</label>
          <select
            className="filter-input"
            value={filters.route_id || ''}
            onChange={set('route_id')}
          >
            <option value="">{en ? 'All routes' : 'كل الخطوط'}</option>
            {metaRoutes.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>

        {/* Status */}
        <div className="filter-field">
          <label className="filter-label">{en ? 'Payment Status' : 'حالة الدفع'}</label>
          <select className="filter-input" value={filters.status || ''} onChange={set('status')}>
            <option value="">{en ? 'All' : 'الكل'}</option>
            <option value="due">{en ? 'Not fully paid (partial + unpaid)' : 'غير مسددة بالكامل (جزئي + غير مسدد)'}</option>
            <option value="unpaid">{en ? 'Unpaid' : 'غير مسدد'}</option>
            <option value="partial">{en ? 'Partial' : 'جزئي'}</option>
            <option value="paid">{en ? 'Paid' : 'مسدد'}</option>
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
              {en ? 'Direct sales:' : 'المبيعات المباشرة:'}{' '}
              <strong className={filters.includeDirect !== false ? 'direct-on' : 'direct-off'}>
                {filters.includeDirect !== false ? (en ? 'Included' : 'مُدرجة') : (en ? 'Excluded' : 'مستبعدة')}
              </strong>
            </span>
          </button>
          {directStats && (
            <span className="direct-stats">
              {directStats.rows.toLocaleString('en-SA')} {en ? 'rows' : 'صف'} ·{' '}
              {Number(directStats.balance).toLocaleString('en-SA', { maximumFractionDigits: 0 })} {en ? 'SAR' : 'ريال'}
            </span>
          )}
        </div>

        {/* Carrefour dues toggle */}
        <button className="toggle-btn" onClick={toggleCarrefour} type="button">
          <span className={`toggle-track${filters.excludeCarrefour ? ' on' : ''}`}>
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-label">
            {en ? 'Carrefour dues:' : 'مديونيات كارفور:'}{' '}
            <strong className={filters.excludeCarrefour ? 'direct-off' : 'direct-on'}>
              {filters.excludeCarrefour ? (en ? 'Excluded' : 'مستبعدة') : (en ? 'Included' : 'مُدرجة')}
            </strong>
          </span>
        </button>

        {/* Quick: due (unpaid+partial) */}
        <button
          className={`quick-btn${filters.status === 'due' ? ' quick-btn--active' : ''}`}
          onClick={toggleDue} type="button"
        >
          {en ? 'Outstanding balance only' : 'الرصيد المتبقي فقط'}
        </button>

        {/* Clear */}
        <button className="clear-btn" onClick={clear} type="button">
          <X size={12} /> {en ? 'Clear filters' : 'مسح الفلاتر'}
        </button>
      </div>

      {/* ── Customer category pills ── */}
      {customerCategories.length > 0 && (
        <div className="filters-cat-pills">
          <span className="filters-cat-label">{en ? 'Customer category:' : 'فئة العملاء:'}</span>
          {customerCategories.map(cat => {
            const state = (filters.catFilter || {})[cat];
            return (
              <button
                key={cat}
                type="button"
                className={`cat-pill${state === 'include' ? ' cat-pill--include' : state === 'exclude' ? ' cat-pill--exclude' : ''}`}
                onClick={() => toggleCat(cat)}
                title={!state ? (en ? 'Click to include' : 'انقر للتضمين') : state === 'include' ? (en ? 'Click to exclude' : 'انقر للاستبعاد') : (en ? 'Click to clear filter' : 'انقر لإلغاء الفلتر')}
              >
                {state === 'include' && <span className="cat-pill-icon">✓</span>}
                {state === 'exclude' && <span className="cat-pill-icon">✕</span>}
                {cat}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
