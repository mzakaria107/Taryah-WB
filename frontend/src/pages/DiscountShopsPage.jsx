import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './DiscountShopsPage.css';

/* ── Constants ─────────────────────────────────────────────── */
const ADMIN_ROLES = ['super_admin', 'it_admin'];
const MONTHS = [
  [1,'يناير'],[2,'فبراير'],[3,'مارس'],[4,'أبريل'],
  [5,'مايو'],[6,'يونيو'],[7,'يوليو'],[8,'أغسطس'],
  [9,'سبتمبر'],[10,'أكتوبر'],[11,'نوفمبر'],[12,'ديسمبر'],
];
const MONTH_AR = Object.fromEntries(MONTHS);
const currentYear  = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;
const YEARS = [currentYear - 1, currentYear, currentYear + 1];

/* ── Helpers ────────────────────────────────────────────────── */
function fmt(n, dec = 0) {
  if (n == null) return '—';
  // 'en-SA' matches the rest of the app (e.g. PerformanceDashboardPage) —
  // Western digits with Arabic-appropriate grouping, instead of 'ar-SA'
  // which renders Arabic-Indic numerals (٣٬٨٠٦).
  return Number(n).toLocaleString('en-SA', { maximumFractionDigits: dec });
}

/* Prints with a specific page size, sidestepping the fact that a CSS
   `@page` at-rule can't be scoped to a class/selector at all. This page has
   TWO print modes (whole-page report = landscape, customer contract =
   portrait) — two coexisting static `@page {size:...}` rules left the
   browser free to pick either one for a given print() call regardless of
   source order or even CSS named pages (`page: contract` — tried first,
   Chrome kept using the OTHER rule's orientation for the contract print
   regardless). Injecting a single, temporary <style> with exactly one
   `@page` rule right before calling print(), then removing it once
   printing is done, guarantees only one `size` is ever in the cascade for
   that specific print job — no ambiguity for the browser to resolve either
   way. `extraCleanup` runs alongside the style-tag removal (e.g. toggling
   back a body class / document.title used for that same print job). */
function printWithPageSize(sizeCss, marginCss, extraCleanup) {
  const style = document.createElement('style');
  style.textContent = `@media print { @page { size: ${sizeCss}; margin: ${marginCss}; } }`;
  document.head.appendChild(style);
  window.print();
  window.onafterprint = () => {
    style.remove();
    extraCleanup?.();
  };
}

/* ── Deviation badge ──────────────────────────────────────── */
function Dev({ pct, invert = false, size = 'md' }) {
  if (pct == null) return null;
  const positive = invert ? pct < 0 : pct > 0;
  const neutral  = pct === 0;
  const cls = neutral ? 'ds-dev--flat' : positive ? 'ds-dev--up' : 'ds-dev--down';
  const arrow = neutral ? '→' : positive ? '↑' : '↓';
  return (
    <span className={`ds-dev ds-dev--${size} ${cls}`}>
      {arrow} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/* ── KPI Card ─────────────────────────────────────────────── */
function KpiCard({ icon, label, value, sub, deviation, invertDev = false, accent, big = false }) {
  return (
    <div className={`ds-kpi${accent ? ` ds-kpi--${accent}` : ''}${big ? ' ds-kpi--big' : ''}`}>
      {icon && <span className="ds-kpi__icon">{icon}</span>}
      <div className="ds-kpi__body">
        <div className="ds-kpi__label">{label}</div>
        <div className="ds-kpi__value">{value}</div>
        {sub && <div className="ds-kpi__sub">{sub}</div>}
        {deviation != null && <Dev pct={deviation} invert={invertDev} size="sm" />}
      </div>
    </div>
  );
}

/* ── Trend Bar Chart ──────────────────────────────────────────
   labelKey lets the overview (multi-year) trend show "شهر سنة"
   instead of just the month name used by the single-year view. */
function TrendChart({ trend, highlight, labelKey = 'month_name' }) {
  if (!trend?.length) return <div className="ds-empty">لا توجد بيانات</div>;
  const maxQty = Math.max(...trend.map(t => t.total_qty), 1);

  return (
    <div className="ds-trend">
      <div className="ds-trend__cols">
        {trend.map((t, i) => {
          const isHL = highlight != null && t.month_num === highlight;
          const qtyPct = (t.total_qty / maxQty * 100).toFixed(1);
          const retPct = (t.total_returns / maxQty * 100).toFixed(1);
          return (
            <div key={i} className={`ds-trend__col${isHL ? ' ds-trend__col--active' : ''}`}>
              <div className="ds-trend__bars">
                <div className="ds-trend__bar-wrap" title={`كمية: ${fmt(t.total_qty)}`}>
                  <div className="ds-trend__bar ds-trend__bar--qty"
                       style={{ height: `${qtyPct}%` }} />
                </div>
                <div className="ds-trend__bar-wrap" title={`مرتجعات: ${fmt(t.total_returns)}`}>
                  <div className="ds-trend__bar ds-trend__bar--ret"
                       style={{ height: `${retPct}%` }} />
                </div>
              </div>
              <div className="ds-trend__label">{t[labelKey]}</div>
              <div className="ds-trend__qty">{fmt(t.total_qty)}</div>
              {t.total_returns > 0 && (
                <div className="ds-trend__ret">↩{fmt(t.total_returns)}</div>
              )}
            </div>
          );
        })}
      </div>
      <div className="ds-trend__legend">
        <span className="ds-trend__legend-item ds-trend__legend-item--qty">■ كمية المبيعات</span>
        <span className="ds-trend__legend-item ds-trend__legend-item--ret">■ المرتجعات</span>
      </div>
    </div>
  );
}

/* ── Horizontal bar ──────────────────────────────────────── */
function HBar({ rows, valueKey, labelKey, colorClass = 'ds-bar--primary', maxBars = 12 }) {
  const capped = rows.slice(0, maxBars);
  const max    = Math.max(...capped.map(r => Number(r[valueKey]) || 0), 1);
  return (
    <div className="ds-hbar">
      {capped.map((r, i) => {
        const val = Number(r[valueKey]) || 0;
        const w   = (val / max * 100).toFixed(1);
        return (
          <div key={i} className="ds-hbar__row">
            <span className="ds-hbar__label" title={r[labelKey]}>{r[labelKey]}</span>
            <div className="ds-hbar__track">
              <div className={`ds-hbar__fill ${colorClass}`} style={{ width: `${w}%` }} />
            </div>
            <span className="ds-hbar__val">{fmt(val)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Sortable Th ─────────────────────────────────────────── */
function Th({ col, sortCol, sortDir, onSort, children }) {
  const active = sortCol === col;
  return (
    <th className={`ds-th${active ? ' ds-th--sorted' : ''}`} onClick={() => onSort(col)}>
      {children}
      <span className={`ds-sort${active ? ' ds-sort--active' : ''}`}>
        {active ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ' ⇅'}
      </span>
    </th>
  );
}

/* ── Generic multi-select dropdown ──────────────────────────
   Compact checkbox popover (never allows an empty selection).
   `options` is [{ value, label }]; used for both the year and
   month filters with the same behavior. ── */
function MultiSelectDropdown({ options, selected, onChange, multiLabel }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const toggle = (v) => {
    const has = selected.includes(v);
    if (has && selected.length === 1) return; // keep at least one option selected
    const next = has ? selected.filter(x => x !== v) : [...selected, v];
    onChange(next.sort((a, b) => a - b));
  };

  const singleLabel = options.find(o => o.value === selected[0])?.label ?? selected[0];
  const label = selected.length > 1 ? multiLabel(selected.length) : String(singleLabel);

  return (
    <div className="ds-year-ms" ref={ref}>
      <button type="button" className="ds-year-ms__btn" onClick={() => setOpen(o => !o)}>
        {label} <span className="ds-year-ms__caret">▾</span>
      </button>
      {open && (
        <div className="ds-year-ms__panel">
          {options.map(o => (
            <label key={o.value} className="ds-year-ms__opt">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Region multi-select ──────────────────────────────────────
   Unlike MultiSelectDropdown above (years/months, which always need at
   least one value selected), regions default to EMPTY meaning "جميع
   المناطق" — so unticking one from that state reads as "كل المناطق عدا
   هذه" in a single click, which is the "اهمال البعض" half of the request;
   "فقط" next to a row gives the other half, a single region in one click.
   Kept as its own component (not a MultiSelectDropdown variant) because
   the two need genuinely different minimum-selection rules. */
function RegionMultiSelect({ branches, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const active = selected.length ? selected : branches;
  const set = next => onChange(next.length === 0 || next.length === branches.length ? [] : next);
  const toggle = b => set(active.includes(b)
    ? (active.length === 1 ? active : active.filter(x => x !== b))
    : [...active, b]);

  const label = !selected.length ? 'جميع المناطق'
    : selected.length === 1 ? selected[0]
    : selected.length === branches.length - 1
      ? `الكل عدا ${branches.find(b => !selected.includes(b))}`
      : `${selected.length} مناطق`;

  return (
    <div className="ds-year-ms" ref={ref}>
      <button type="button" className="ds-year-ms__btn" onClick={() => setOpen(o => !o)} title={selected.length ? selected.join('، ') : 'جميع المناطق'}>
        {label} <span className="ds-year-ms__caret">▾</span>
      </button>
      {open && (
        <div className="ds-year-ms__panel">
          <div className="ds-region-ms__head">
            <button type="button" className="ds-region-ms__mini" onClick={() => onChange([])}>الكل</button>
            <span className="ds-region-ms__count">{active.length} / {branches.length}</span>
          </div>
          {branches.map(b => {
            const on = active.includes(b);
            return (
              <div key={b} className={`ds-region-ms__row${on ? ' ds-region-ms__row--on' : ''}`}>
                <label className="ds-year-ms__opt">
                  <input type="checkbox" checked={on} onChange={() => toggle(b)} />
                  {b}
                </label>
                <button type="button" className="ds-region-ms__only" onClick={() => set([b])}>فقط</button>
              </div>
            );
          })}
          {!branches.length && <div className="ds-region-ms__empty">لا توجد مناطق</div>}
        </div>
      )}
    </div>
  );
}

/* ── Admin-only: discount-shop customer list upload panel ────
   Lets an admin refresh the DB-backed customer_code segment (migration
   087 / discount_shop_customers table) from inside the page itself,
   instead of needing a code change every time the list is updated.
   Upload is a full TRUNCATE+INSERT replace on the backend (segment
   membership, not an additive master), so this surfaces the diff
   (previous_count → new_count, added, removed) right after the upload
   completes rather than applying it silently — the same
   "surface consequential actions" convention used elsewhere in this app
   (e.g. the fridge pending-contract flag, region-plan diffs). A native
   confirm() before sending gives the "before" half too. ── */
function DiscountShopCustomerListPanel({ onUploaded }) {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null); // last upload diff summary
  const [error, setError] = useState('');
  const [showList, setShowList] = useState(false);
  const [addCode, setAddCode] = useState('');
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState(null);
  const [addError, setAddError] = useState('');
  const [deletingCode, setDeletingCode] = useState(null);
  const [listSearch, setListSearch] = useState('');

  const { data: listInfo, refetch } = useQuery({
    queryKey: ['ds-customer-list'],
    queryFn: () => client.get('/discount-shops/customer-list').then(r => r.data),
    staleTime: 60 * 1000,
  });

  const handleAddCustomer = async () => {
    const code = addCode.trim();
    if (!code) return;
    setAdding(true);
    setAddError('');
    setAddResult(null);
    try {
      const res = await client.post('/discount-shops/customer-list/add-one', { customer_code: code });
      setAddResult(res.data);
      setAddCode('');
      await refetch();
      onUploaded?.();
    } catch (err) {
      setAddError(err?.response?.data?.error || 'حدث خطأ أثناء إضافة العميل');
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteCustomer = async (code, name) => {
    const ok = window.confirm(`حذف العميل "${name || code}" (${code}) من قائمة محلات التخفيضات؟`);
    if (!ok) return;
    setDeletingCode(code);
    try {
      await client.delete(`/discount-shops/customer-list/${encodeURIComponent(code)}`);
      await refetch();
      onUploaded?.();
    } catch (err) {
      window.alert(err?.response?.data?.error || 'حدث خطأ أثناء حذف العميل');
    } finally {
      setDeletingCode(null);
    }
  };

  const filteredList = useMemo(() => {
    const rows = listInfo?.customers || [];
    if (!listSearch.trim()) return rows;
    const q = listSearch.trim().toLowerCase();
    return rows.filter(c => (c.customer_name || '').toLowerCase().includes(q) || c.customer_code.includes(q));
  }, [listInfo, listSearch]);

  const handleFilePick = () => fileRef.current?.click();

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file name later
    if (!file) return;

    const ok = window.confirm(
      `سيتم استبدال قائمة عملاء محلات التخفيضات بالكامل بمحتوى الملف "${file.name}" — ` +
      `أي عميل غير موجود في الملف الجديد سيُحذف من القائمة فوراً. متابعة؟`
    );
    if (!ok) return;

    setUploading(true);
    setError('');
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await client.post('/discount-shops/customer-list/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(res.data);
      await refetch();
      onUploaded?.();
    } catch (err) {
      setError(err?.response?.data?.error || 'حدث خطأ أثناء رفع الملف');
    } finally {
      setUploading(false);
    }
  };

  const lastUploaded = listInfo?.last_uploaded_at
    ? new Date(listInfo.last_uploaded_at).toLocaleString('en-SA')
    : '—';

  return (
    <div className="ds-card ds-no-print ds-upload-card">
      <div className="ds-card__title">قائمة عملاء محلات التخفيضات</div>
      <div className="ds-upload-card__row">
        <span>عدد العملاء الحالي: <strong>{fmt(listInfo?.count)}</strong></span>
        <span>آخر تحديث: <strong>{lastUploaded}</strong></span>
        <button className="ds-btn ds-btn--outline" onClick={() => setShowList(s => !s)}>
          {showList ? '▲ إخفاء القائمة' : '▼ عرض القائمة'}
        </button>
        <button className="ds-btn ds-btn--outline" onClick={handleFilePick} disabled={uploading}>
          {uploading ? 'جاري الرفع…' : '⬆️ رفع/تحديث القائمة بالكامل'}
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
               onChange={handleFileChange} />
      </div>

      {/* ── Add a single customer by code ── */}
      <div className="ds-upload-card__row ds-upload-card__add-row">
        <input
          type="text" className="ds-inline-input ds-add-cust-input"
          placeholder="كود العميل"
          value={addCode}
          onChange={e => setAddCode(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAddCustomer(); }}
        />
        <button className="ds-btn ds-btn--outline" onClick={handleAddCustomer} disabled={adding || !addCode.trim()}>
          {adding ? 'جاري الإضافة…' : '➕ إضافة عميل بالكود'}
        </button>
      </div>
      {addError && <div className="ds-error">{addError}</div>}
      {addResult && (
        <div className="ds-upload-card__result">
          {addResult.was_already_in_list ? 'تم تحديث بيانات العميل' : 'تمت إضافة العميل'}:{' '}
          <strong>{addResult.customer_name || addResult.customer_code}</strong> ({addResult.customer_code})
          {addResult.name_not_found && (
            <span className="ds-add-cust-warning"> — تحذير: لم يتم العثور على اسم لهذا الكود في السجلات، تمت الإضافة بدون اسم</span>
          )}
        </div>
      )}

      {error && <div className="ds-error">{error}</div>}
      {result && (
        <div className="ds-upload-card__result">
          تم التحديث: {fmt(result.previous_count)} → {fmt(result.new_count)} عميل
          {' · '}أُضيف {fmt(result.added?.length)}{' · '}حُذف {fmt(result.removed?.length)}
          {result.removed?.length > 0 && (
            <div className="ds-upload-card__codes">المحذوفون: {result.removed.join('، ')}</div>
          )}
          {result.added?.length > 0 && (
            <div className="ds-upload-card__codes">المضافون: {result.added.join('، ')}</div>
          )}
          {result.row_errors?.length > 0 && (
            <div className="ds-upload-card__codes">تحذير: {result.row_errors.length} صف بدون اسم عميل</div>
          )}
        </div>
      )}

      {/* ── Full list with per-row delete ── */}
      {showList && (
        <div className="ds-cust-list-panel">
          <input
            type="text" className="ds-chicken-search"
            placeholder="بحث بالاسم أو الكود…"
            value={listSearch}
            onChange={e => setListSearch(e.target.value)}
          />
          <div className="ds-table-wrap">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>كود العميل</th>
                  <th>اسم العميل</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredList.map(c => (
                  <tr key={c.customer_code}>
                    <td className="ds-td-num">{c.customer_code}</td>
                    <td>{c.customer_name || <span className="ds-add-cust-warning">— بدون اسم —</span>}</td>
                    <td className="ds-td-num">
                      <button
                        type="button" className="ds-cust-del-btn"
                        title="حذف العميل من القائمة"
                        disabled={deletingCode === c.customer_code}
                        onClick={() => handleDeleteCustomer(c.customer_code, c.customer_name)}
                      >
                        {deletingCode === c.customer_code ? '…' : '🗑'}
                      </button>
                    </td>
                  </tr>
                ))}
                {filteredList.length === 0 && (
                  <tr><td colSpan={3} className="ds-empty">لا يوجد عملاء مطابقون</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   Main Page
═══════════════════════════════════════════════════════════ */
export default function DiscountShopsPage() {
  const { user } = useAuth();
  const isAdmin  = user && ADMIN_ROLES.includes(user.role);
  const qc = useQueryClient();

  /* ── Admin insight note — free-text comment stored in the generic
     app_settings key/value table (same API used by SMTP/sidebar-order
     settings elsewhere), shown on the Insight card below. ── */
  const { data: insightNoteData } = useQuery({
    queryKey: ['ds-insight-note'],
    queryFn: () => client.get('/settings/discount_shops_insight_note').then(r => r.data.value || ''),
    staleTime: 60 * 1000,
  });
  const [insightNoteDraft, setInsightNoteDraft] = useState(null); // null = not editing yet
  const [insightNoteSaving, setInsightNoteSaving] = useState(false);
  const insightNoteText = insightNoteDraft !== null ? insightNoteDraft : (insightNoteData || '');

  const saveInsightNote = async () => {
    setInsightNoteSaving(true);
    try {
      await client.put('/settings/discount_shops_insight_note', { value: insightNoteText });
      qc.invalidateQueries(['ds-insight-note']);
      setInsightNoteDraft(null);
    } catch {
      // keep the draft on screen so the admin doesn't lose what they typed
    } finally {
      setInsightNoteSaving(false);
    }
  };

  const [selectedYears, setSelectedYears] = useState([currentYear]);
  const year = selectedYears[0]; // primary year — used wherever a single year is needed (item-matrix, labels, export filenames)
  const yearsLabel = selectedYears.length > 1 ? [...selectedYears].sort((a,b)=>a-b).join('، ') : String(year);

  const [selectedMonths, setSelectedMonths] = useState([currentMonth]);
  const month = selectedMonths[0]; // primary month — used wherever a single month is needed (labels, export filenames)
  // Declared here (not reusing the later `monthName` const) to avoid a TDZ
  // ReferenceError — this runs before that later declaration's line executes.
  const primaryMonthName = MONTHS.find(m => m[0] === month)?.[1] || '';
  const monthsLabel = selectedMonths.length > 1
    ? [...selectedMonths].sort((a,b)=>a-b).map(m => MONTHS.find(x => x[0] === m)?.[1] || m).join('، ')
    : primaryMonthName;

  /* Kept regions; empty = جميع المناطق (see RegionMultiSelect). */
  const [branchNames, setBranchNames] = useState([]);
  const [repName,    setRepName]    = useState('');
  const [activeTab,  setActiveTab]  = useState('general');

  /* ── Calendar date-range filter — an alternative to year/month, not an
     addition to it: when active it overrides the year/month multi-select
     entirely and can span multiple months/years (backend rebuilds the real
     date from sales_activity's report_year/month_num/day). Same pattern as
     SalesReportPage.jsx's "ملخص المبيعات" (branch-summary) tab. Wired
     through to every API call the page makes (main summary, matrices,
     item overview, and the chilled-chicken baseline) so the whole page
     consistently reflects one selected period. ── */
  function monthBoundsDS(y, m) {
    const today   = new Date();
    const isCur   = today.getFullYear() === y && today.getMonth() + 1 === m;
    const lastDay = isCur ? today.getDate() : new Date(y, m, 0).getDate();
    const pad = n => String(n).padStart(2, '0');
    return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay)}` };
  }
  const [useDateRange, setUseDateRange] = useState(false);
  const defaultRangeDS = monthBoundsDS(currentYear, currentMonth);
  const [dateFrom, setDateFrom] = useState(defaultRangeDS.from);
  const [dateTo,   setDateTo]   = useState(defaultRangeDS.to);
  const rangeInvalid = useDateRange && dateFrom && dateTo && dateTo < dateFrom;

  /* Sort state for reps table */
  const [repSort, setRepSort]       = useState({ col: 'total_qty', dir: 'desc' });
  /* Sort state for customers table */
  const [custSort, setCustSort]     = useState({ col: 'total_qty', dir: 'desc' });
  /* Sort state for items table */
  const [itemSort, setItemSort]     = useState({ col: 'total_qty', dir: 'desc' });

  const handleRepSort  = useCallback(col => setRepSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);
  const handleCustSort = useCallback(col => setCustSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);
  const handleItemSort = useCallback(col => setItemSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);

  /* Metric visibility toggle for the customer × month matrix — allows
     showing any single-or-multiple combination of qty/returns/revenue. */
  const [custMatrixMetrics, setCustMatrixMetrics] = useState({ qty: true, returns: true, revenue: true });
  const toggleCustMatrixMetric = useCallback((key) => {
    setCustMatrixMetrics(prev => {
      const next = { ...prev, [key]: !prev[key] };
      // never allow all three to be turned off — fall back to qty
      if (!next.qty && !next.returns && !next.revenue) next.qty = true;
      return next;
    });
  }, []);

  /* Same metric visibility toggle, for the region × month matrix. */
  const [regionMatrixMetrics, setRegionMatrixMetrics] = useState({ qty: true, returns: true, revenue: true });
  const toggleRegionMatrixMetric = useCallback((key) => {
    setRegionMatrixMetrics(prev => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.qty && !next.returns && !next.revenue) next.qty = true;
      return next;
    });
  }, []);

  /* ── Filters query ─────────────────────────────────────── */
  const { data: filters } = useQuery({
    queryKey: ['ds-filters', year],
    queryFn: () => client.get(`/discount-shops/filters?year=${year}`).then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  const repOptions = useMemo(() => {
    if (!filters?.reps) return [];
    return branchNames.length ? filters.reps.filter(r => branchNames.includes(r.branch)) : filters.reps;
  }, [filters, branchNames]);

  /* Written out in full on the print sheet and the Excel export, since
     whoever reads the paper has no filter bar to check the scope against. */
  const allBranches = filters?.branches || [];
  const branchLabel = !branchNames.length ? 'جميع المناطق'
    : branchNames.length === allBranches.length - 1
      ? `الكل عدا ${allBranches.find(b => !branchNames.includes(b))}`
      : branchNames.join('، ');

  /* ── Main data query ───────────────────────────────────── */
  const params = useDateRange
    ? new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    : new URLSearchParams({ years: selectedYears.join(','), months: selectedMonths.join(',') });
  branchNames.forEach(b => params.append('branch_name', b));
  if (repName)    params.set('salesrep_name', repName);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['ds-summary', useDateRange, useDateRange ? dateFrom : selectedYears.join(','),
               useDateRange ? dateTo : selectedMonths.join(','), branchNames.join('|'), repName],
    queryFn:  () => client.get(`/discount-shops/summary?${params}`).then(r => r.data),
    enabled: !rangeInvalid,
    staleTime: 2 * 60 * 1000,
  });

  /* ── Overview query — powers the "نظرة عامة" tab. Now follows the
       page's own period filter (years/months multi-select, or the
       calendar range when active) exactly like every other tab, instead
       of always showing every year of history regardless of the filter. ── */
  const overviewParams = useDateRange
    ? new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    : new URLSearchParams({ years: selectedYears.join(','), months: selectedMonths.join(',') });
  branchNames.forEach(b => overviewParams.append('branch_name', b));
  if (repName)    overviewParams.set('salesrep_name', repName);

  const { data: overview, isLoading: isOverviewLoading, isError: isOverviewError } = useQuery({
    queryKey: ['ds-overview', useDateRange, useDateRange ? dateFrom : selectedYears.join(','),
               useDateRange ? dateTo : selectedMonths.join(','), branchNames.join('|'), repName],
    queryFn:  () => client.get(`/discount-shops/overview?${overviewParams}`).then(r => r.data),
    enabled: !rangeInvalid,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Item matrix (monthly sales/returns per item, selected year, or the
       calendar range when active — overrides ?year= entirely) ── */
  const matrixParams = useDateRange
    ? new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    : new URLSearchParams({ year });
  branchNames.forEach(b => matrixParams.append('branch_name', b));
  if (repName)    matrixParams.set('salesrep_name', repName);

  const { data: itemMatrix, isLoading: isMatrixLoading, isError: isMatrixError } = useQuery({
    queryKey: ['ds-item-matrix', useDateRange, useDateRange ? dateFrom : year, useDateRange ? dateTo : null, branchNames.join('|'), repName],
    queryFn:  () => client.get(`/discount-shops/item-matrix?${matrixParams}`).then(r => r.data),
    enabled: !rangeInvalid,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Item totals for the whole period (every year, not just the
       selected month) — powers the "كامل الفترة" best/worst cards.
       Honors the calendar range when active, same as the other tabs. ── */
  const itemOverviewParams = useDateRange
    ? new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    : new URLSearchParams();
  branchNames.forEach(b => itemOverviewParams.append('branch_name', b));
  if (repName)    itemOverviewParams.set('salesrep_name', repName);

  const { data: itemOverview, isLoading: isItemOverviewLoading, isError: isItemOverviewError } = useQuery({
    queryKey: ['ds-item-overview', useDateRange, useDateRange ? dateFrom : null, useDateRange ? dateTo : null, branchNames.join('|'), repName],
    queryFn:  () => client.get(`/discount-shops/item-overview?${itemOverviewParams}`).then(r => r.data),
    enabled: !rangeInvalid,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Customer matrix (whole-period monthly sales/returns/revenue, or
       narrowed to the calendar range when active) ── */
  const custMatrixParams = useDateRange
    ? new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    : new URLSearchParams();
  branchNames.forEach(b => custMatrixParams.append('branch_name', b));
  if (repName)    custMatrixParams.set('salesrep_name', repName);

  const { data: custMatrix, isLoading: isCustMatrixLoading, isError: isCustMatrixError } = useQuery({
    queryKey: ['ds-customer-matrix', useDateRange, useDateRange ? dateFrom : null, useDateRange ? dateTo : null, branchNames.join('|'), repName],
    queryFn:  () => client.get(`/discount-shops/customer-matrix?${custMatrixParams}`).then(r => r.data),
    enabled: !rangeInvalid,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Item include/exclude filter for the 10+1 scenario ── */
  const [excludedChickenItems, setExcludedChickenItems] = useState(() => new Set());
  // Stable master list of item names for the checkbox UI — captured from
  // whichever response came back UNFILTERED (meta.items_filter_applied
  // null), so the checkbox list doesn't shrink/reorder as items get
  // excluded. Refreshes itself whenever the period changes and no
  // exclusion is active, so it always reflects the real item set for
  // whatever period is selected.
  const [chickenMasterItems, setChickenMasterItems] = useState([]);
  const toggleChickenItem = useCallback((name) => {
    setExcludedChickenItems(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        // Mirror the established "last remaining tick can't be removed"
        // rule from RegionPerformancePage's cust_category picker — an
        // empty include-set would silently read as "no filter" server-side
        // (see chilled-chicken-baseline's itemsParam handling), which is
        // the opposite of what excluding every item should show.
        if (next.size >= chickenMasterItems.length - 1) return prev;
        next.add(name);
      }
      return next;
    });
  }, [chickenMasterItems]);

  /* ── Chilled-chicken 10+1 promo baseline — reuses the page's own
       years/months multi-select (same convention /summary uses), so the
       baseline respects whatever period is selected elsewhere on the page.
       When the calendar range is active it overrides years/months here too.
       The item filter (above) narrows the SAME rows server-side, so
       excluding an item removes it from the per-customer baseline too —
       not just from the display. ── */
  const chickenParams = useDateRange
    ? new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    : new URLSearchParams({ years: selectedYears.join(','), months: selectedMonths.join(',') });
  branchNames.forEach(b => chickenParams.append('branch_name', b));
  if (repName) chickenParams.set('salesrep_name', repName);
  if (excludedChickenItems.size > 0 && chickenMasterItems.length) {
    const included = chickenMasterItems.filter(n => !excludedChickenItems.has(n));
    chickenParams.set('items', included.join(','));
  }

  const excludedChickenItemsKey = [...excludedChickenItems].sort().join('|');
  const { data: chickenBaseline, isLoading: isChickenLoading, isError: isChickenError } = useQuery({
    queryKey: ['ds-chicken-baseline', useDateRange, useDateRange ? dateFrom : selectedYears.join(','),
               useDateRange ? dateTo : selectedMonths.join(','), branchNames.join('|'), repName, excludedChickenItemsKey],
    queryFn:  () => client.get(`/discount-shops/chilled-chicken-baseline?${chickenParams}`).then(r => r.data),
    enabled: !rangeInvalid,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (chickenBaseline && !chickenBaseline.meta?.items_filter_applied) {
      setChickenMasterItems(chickenBaseline.items.map(it => it.item_name_en));
    }
  }, [chickenBaseline]);

  /* ── 10+1 promo scenario controls (client-side, instant response) ── */
  const [growthPct, setGrowthPct]           = useState(10);
  const [freeCostPerUnit, setFreeCostPerUnit] = useState(11.75);
  const [coveragePct, setCoveragePct]       = useState(100);
  const chickenDetailRef = useRef(null);

  const GROWTH_PRESETS   = [5, 10, 15, 20];
  const COVERAGE_PRESETS = [0, 50, 100];

  /* Per-item "current ASP" override — lets the user simulate a different
     starting price per SKU instead of the real historical average. Keyed
     by item_name_en; absent/undefined means "use the real baseline ASP". */
  const [chickenAspOverrides, setChickenAspOverrides] = useState({});
  const setChickenAspOverride = useCallback((itemName, value) => {
    setChickenAspOverrides(prev => {
      const next = { ...prev };
      if (value === '' || value == null || isNaN(value)) {
        delete next[itemName];
      } else {
        next[itemName] = parseFloat(value);
      }
      return next;
    });
  }, []);
  const resetChickenAspOverride = useCallback((itemName) => {
    setChickenAspOverrides(prev => {
      if (!(itemName in prev)) return prev;
      const next = { ...prev };
      delete next[itemName];
      return next;
    });
  }, []);

  /* Pure function of (growth%, coverage%, freeCost, baseline, ASP overrides)
     so it can be reused both for the live detail view and for each of the
     12 matrix cells without duplicating the math. */
  const calcChickenScenario = useCallback((gPct, cPct, freeCost, aspOverrides) => {
    if (!chickenBaseline) return null;
    const { items, customers, overall } = chickenBaseline;

    let totalFreeQty   = 0; // Σ of FLOORED per-customer free_qty — must be the
    let totalFreeCost  = 0; // authoritative total (never derived from unrounded sums)
    let totalTargetQty = 0; // Σ unrounded per-customer target_qty

    const perCustomer = customers.map(c => {
      const targetQty = c.avg_monthly_qty * (1 + gPct / 100);
      const freeQtyRaw = targetQty / 10;
      const freeQty = Math.floor(freeQtyRaw);
      const freeCostVal = freeQty * freeCost;
      totalFreeQty   += freeQty;
      totalFreeCost  += freeCostVal;
      totalTargetQty += targetQty;
      return {
        customer_code: c.customer_code,
        customer_name: c.customer_name,
        active_months: c.active_months,
        avg_monthly_qty: c.avg_monthly_qty,
        target_qty: targetQty,
        free_qty: freeQty,
        free_cost: freeCostVal,
      };
    });

    const overallQty = overall.total_qty || 0;
    let sumItemFreeQty = 0, sumItemTargetQty = 0, sumItemFreeCost = 0,
        sumRequiredSales = 0, sumUnrecovered = 0, weightedUpliftNum = 0;

    const perItem = items.map(it => {
      const baselineAsp = it.asp;
      const hasOverride = aspOverrides && aspOverrides[it.item_name_en] != null && !isNaN(aspOverrides[it.item_name_en]);
      const effectiveAsp = hasOverride ? aspOverrides[it.item_name_en] : baselineAsp;

      const share = overallQty > 0 ? it.total_qty / overallQty : 0;
      const itemTargetQty = totalTargetQty * share;
      const itemFreeQty   = totalFreeQty * share;
      const itemFreeCost  = itemFreeQty * freeCost;
      const requiredUplift = itemTargetQty > 0 ? (itemFreeCost * cPct / 100) / itemTargetQty : 0;
      const requiredNewAsp = effectiveAsp + requiredUplift;
      const requiredMovementPct = effectiveAsp > 0 ? (requiredUplift / effectiveAsp) * 100 : 0;
      const requiredSalesValue = itemTargetQty * requiredNewAsp;
      const unrecoveredCost = itemFreeCost * (1 - cPct / 100);
      const netRevenueImpact = requiredSalesValue - unrecoveredCost;
      const costToSalesPct = requiredSalesValue > 0 ? (itemFreeCost / requiredSalesValue) * 100 : 0;

      sumItemFreeQty    += itemFreeQty;
      sumItemTargetQty  += itemTargetQty;
      sumItemFreeCost   += itemFreeCost;
      sumRequiredSales  += requiredSalesValue;
      sumUnrecovered    += unrecoveredCost;
      weightedUpliftNum += requiredMovementPct * itemTargetQty;

      return {
        item_name_en: it.item_name_en,
        asp: effectiveAsp,
        baseline_asp: baselineAsp,
        asp_overridden: hasOverride,
        total_qty_baseline: it.total_qty,
        item_share: share,
        target_qty: itemTargetQty,
        free_qty: itemFreeQty,
        free_cost: itemFreeCost,
        required_new_asp: requiredNewAsp,
        required_uplift: requiredUplift,
        required_price_movement_pct: requiredMovementPct,
        required_sales_value: requiredSalesValue,
        unrecovered_cost: unrecoveredCost,
        net_revenue_impact: netRevenueImpact,
        cost_to_sales_pct: costToSalesPct,
      };
    });

    const blendedUpliftPct = sumItemTargetQty > 0 ? weightedUpliftNum / sumItemTargetQty : 0;
    const totalCostToSalesPct = sumRequiredSales > 0 ? (sumItemFreeCost / sumRequiredSales) * 100 : 0;
    const totalNetRevenueImpact = sumRequiredSales - sumUnrecovered;

    return {
      growthPct: gPct, coveragePct: cPct, freeCostPerUnit: freeCost,
      perCustomer, perItem,
      totals: {
        total_free_qty: totalFreeQty,
        total_free_cost: totalFreeCost,
        total_target_qty: totalTargetQty,
        item_free_qty_sum: sumItemFreeQty,   // should equal total_free_qty (fp rounding only)
        item_target_qty_sum: sumItemTargetQty, // should equal total_target_qty
        blended_required_price_movement_pct: blendedUpliftPct,
        total_required_sales_value: sumRequiredSales,
        total_cost_to_sales_pct: totalCostToSalesPct,
        total_net_revenue_impact: totalNetRevenueImpact,
      },
    };
  }, [chickenBaseline]);

  const chickenScenario = useMemo(
    () => calcChickenScenario(growthPct, coveragePct, freeCostPerUnit, chickenAspOverrides),
    [calcChickenScenario, growthPct, coveragePct, freeCostPerUnit, chickenAspOverrides]
  );

  const chickenMatrix = useMemo(() => {
    if (!chickenBaseline) return [];
    const rows = [];
    for (const g of GROWTH_PRESETS) {
      for (const c of COVERAGE_PRESETS) {
        const s = calcChickenScenario(g, c, freeCostPerUnit, chickenAspOverrides);
        rows.push({ growth: g, coverage: c, ...s.totals });
      }
    }
    return rows;
  }, [chickenBaseline, calcChickenScenario, freeCostPerUnit, chickenAspOverrides]);

  const [chickenCustSort, setChickenCustSort] = useState({ col: 'total_qty', dir: 'desc' });
  const handleChickenCustSort = useCallback(col => setChickenCustSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);
  const [chickenCustSearch, setChickenCustSearch] = useState('');

  const sortedChickenCusts = useMemo(() => {
    if (!chickenScenario?.perCustomer) return [];
    let rows = chickenScenario.perCustomer;
    if (chickenCustSearch.trim()) {
      const q = chickenCustSearch.trim().toLowerCase();
      rows = rows.filter(c => (c.customer_name || '').toLowerCase().includes(q) || (c.customer_code || '').includes(q));
    }
    const dir = chickenCustSort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => (Number(b[chickenCustSort.col]) - Number(a[chickenCustSort.col])) * dir);
  }, [chickenScenario, chickenCustSort, chickenCustSearch]);

  const handleChickenExport = useCallback(() => {
    if (!chickenScenario) return;
    const wb = XLSX.utils.book_new();

    const hdrRows = [
      ['التقرير', `سيناريو مجانيات 10+1 — دجاج مبرد`],
      ['نسبة النمو المطلوبة %', growthPct],
      ['تكلفة الوحدة المجانية (ر.س)', freeCostPerUnit],
      ['نسبة تغطية التكلفة عبر رفع السعر %', coveragePct],
      ['الأصناف المُضمّنة بالسيناريو', `${fmt(chickenMasterItems.length - excludedChickenItems.size)} من ${fmt(chickenMasterItems.length)}`],
      ...(excludedChickenItems.size > 0 ? [['الأصناف المستبعدة', [...excludedChickenItems].join(', ')]] : []),
      [''],
      ['إجمالي الكمية المجانية', chickenScenario.totals.total_free_qty],
      ['إجمالي تكلفة المجانيات (ر.س)', +chickenScenario.totals.total_free_cost.toFixed(2)],
      ['نسبة رفع السعر المطلوبة (مرجحة) %', +chickenScenario.totals.blended_required_price_movement_pct.toFixed(2)],
      ['إجمالي قيمة المبيعات المطلوبة (ر.س)', +chickenScenario.totals.total_required_sales_value.toFixed(2)],
      ['نسبة التكلفة إلى المبيعات %', +chickenScenario.totals.total_cost_to_sales_pct.toFixed(2)],
      ['صافي الأثر على الإيراد (ر.س)', +chickenScenario.totals.total_net_revenue_impact.toFixed(2)],
      [''],
      ['ملاحظة: الربحية المعروضة هي الأثر الصافي على الإيراد بعد تغطية تكلفة المجانيات، وليست هامش ربح نهائي — تكلفة المنتج الكاملة (COGS) غير متوفرة.'],
    ];
    const wsHdr = XLSX.utils.aoa_to_sheet(hdrRows);
    wsHdr['!cols'] = [{ wch: 36 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, wsHdr, 'ملخص السيناريو');

    const itemHeader = ['الصنف', 'ASP الحالي (مستخدم بالسيناريو)', 'ASP الفعلي (تاريخي)', 'مُعدَّل يدويًا؟', 'الكمية المستهدفة', 'الكمية المجانية', 'تكلفة المجانيات', 'ASP المطلوب', 'حركة السعر المطلوبة %', 'قيمة المبيعات المطلوبة', 'تكلفة/مبيعات %'];
    const itemRows = chickenScenario.perItem.map(it => [
      it.item_name_en, +it.asp.toFixed(2), +it.baseline_asp.toFixed(2), it.asp_overridden ? 'نعم' : 'لا',
      +it.target_qty.toFixed(1), +it.free_qty.toFixed(1),
      +it.free_cost.toFixed(2), +it.required_new_asp.toFixed(4), +it.required_price_movement_pct.toFixed(2),
      +it.required_sales_value.toFixed(2), +it.cost_to_sales_pct.toFixed(2),
    ]);
    const wsItems = XLSX.utils.aoa_to_sheet([itemHeader, ...itemRows]);
    wsItems['!cols'] = [{ wch: 32 }, { wch: 20 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsItems, 'الأصناف');

    const custHeader = ['كود العميل', 'اسم العميل', 'أشهر النشاط', 'متوسط الكمية الشهري', 'الكمية المستهدفة', 'الكمية المجانية', 'تكلفة المجانيات'];
    const custRows = [...chickenScenario.perCustomer].sort((a, b) => b.target_qty - a.target_qty).map(c => [
      c.customer_code, c.customer_name, c.active_months, +c.avg_monthly_qty.toFixed(2),
      +c.target_qty.toFixed(2), c.free_qty, +c.free_cost.toFixed(2),
    ]);
    const wsCust = XLSX.utils.aoa_to_sheet([custHeader, ...custRows]);
    wsCust['!cols'] = [{ wch: 14 }, { wch: 28 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsCust, 'العملاء');

    const today = new Date().toLocaleDateString('en-CA');
    XLSX.writeFile(wb, `Discount Shops_Chicken10+1_g${growthPct}_c${coveragePct}_${today}.xlsx`);
  }, [chickenScenario, growthPct, freeCostPerUnit, coveragePct, chickenMasterItems, excludedChickenItems]);

  /* ── "% of sales" incentive scenario — sales-value target each customer
       must reach to qualify for a tiered cash incentive. Baseline covers
       the WHOLE discount-shop segment (every category), not just chilled
       chicken, since the incentive is priced on total sales value. ── */
  const incentiveParams = useDateRange
    ? new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    : new URLSearchParams({ years: selectedYears.join(','), months: selectedMonths.join(',') });
  branchNames.forEach(b => incentiveParams.append('branch_name', b));
  if (repName) incentiveParams.set('salesrep_name', repName);

  const { data: incentiveBaseline, isLoading: isIncentiveLoading, isError: isIncentiveError } = useQuery({
    queryKey: ['ds-incentive-baseline', useDateRange, useDateRange ? dateFrom : selectedYears.join(','),
               useDateRange ? dateTo : selectedMonths.join(','), branchNames.join('|'), repName],
    queryFn:  () => client.get(`/discount-shops/incentive-baseline?${incentiveParams}`).then(r => r.data),
    enabled: !rangeInvalid,
    staleTime: 5 * 60 * 1000,
  });

  const [incentiveGrowthPct, setIncentiveGrowthPct] = useState(10);
  // Tiered rate table — achievement below the first tier's minPct earns
  // nothing (doesn't qualify). Editable: both the achievement thresholds
  // and the rates can be adjusted, so this isn't locked to one policy.
  const [incentiveTiers, setIncentiveTiers] = useState([
    { minPct: 100, rate: 2 },
    { minPct: 110, rate: 3 },
    { minPct: 125, rate: 4 },
  ]);
  const updateIncentiveTier = useCallback((idx, field, value) => {
    setIncentiveTiers(prev => prev.map((t, i) => i === idx ? { ...t, [field]: parseFloat(value) || 0 } : t));
  }, []);

  /* ── Persist growth%/tiers server-side ──────────────────────
     These were pure client state before — every reload (or another user
     opening the page) reset the growth% and tier table back to the
     hardcoded defaults above, silently discarding whatever the admin had
     tuned it to. Reuses the generic app_settings key/value store
     (same infra as SMTP/sidebar_order — GET is open to any authed user,
     PUT is admin-only server-side) rather than adding a dedicated table
     for two numbers and an array. The contract-print tab downstream
     reads these same incentiveGrowthPct/incentiveTiers values, so
     persisting them here also fixes it from resetting on reload. */
  const INCENTIVE_SETTINGS_KEY = 'discount_shops_incentive_settings';
  const [incentiveSettingsSavedAt, setIncentiveSettingsSavedAt] = useState(null);
  const [savingIncentiveSettings, setSavingIncentiveSettings] = useState(false);
  const [incentiveSettingsSaveError, setIncentiveSettingsSaveError] = useState('');
  const [incentiveSettingsJustSaved, setIncentiveSettingsJustSaved] = useState(false);

  useEffect(() => {
    client.get(`/settings/${INCENTIVE_SETTINGS_KEY}`).then(res => {
      const val = res.data?.value;
      if (val && typeof val === 'object') {
        if (typeof val.growthPct === 'number') setIncentiveGrowthPct(val.growthPct);
        if (Array.isArray(val.tiers) && val.tiers.length) setIncentiveTiers(val.tiers);
      }
      if (res.data?.updatedAt) setIncentiveSettingsSavedAt(res.data.updatedAt);
    }).catch(() => {}); // no saved value yet — keep the hardcoded defaults
  }, []);

  const handleSaveIncentiveSettings = useCallback(async () => {
    setSavingIncentiveSettings(true);
    setIncentiveSettingsSaveError('');
    setIncentiveSettingsJustSaved(false);
    try {
      await client.put(`/settings/${INCENTIVE_SETTINGS_KEY}`, {
        value: { growthPct: incentiveGrowthPct, tiers: incentiveTiers },
      });
      setIncentiveSettingsSavedAt(new Date().toISOString());
      setIncentiveSettingsJustSaved(true);
    } catch (err) {
      setIncentiveSettingsSaveError(err?.response?.data?.error || 'حدث خطأ أثناء حفظ الإعدادات');
    } finally {
      setSavingIncentiveSettings(false);
    }
  }, [incentiveGrowthPct, incentiveTiers]);

  /* Highest tier whose minPct the achievement % has reached; 0% (doesn't
     qualify) if it hasn't reached even the first tier. */
  const rateForAchievement = useCallback((achievementPct, tiers) => {
    let rate = 0;
    for (const t of tiers) if (achievementPct >= t.minPct) rate = t.rate;
    return rate;
  }, []);

  const calcIncentiveScenario = useCallback((gPct, tiers) => {
    if (!incentiveBaseline) return null;
    const { customers } = incentiveBaseline;

    let totalTargetRevenue = 0, totalIncentiveAtTarget = 0, totalIncentiveAtStretch = 0;
    let totalNetQty = 0, totalTargetQty = 0;

    const perCustomer = customers.map(c => {
      const targetRevenue = c.avg_monthly_revenue * (1 + gPct / 100);
      // "At target" = the minimum qualifying payout, exactly at 100% achievement.
      const rateAtTarget = rateForAchievement(100, tiers);
      const incentiveAtTarget = targetRevenue * (rateAtTarget / 100);
      // "Stretch" = an illustrative 125% achievement, at whatever tier that reaches.
      const stretchRevenue = targetRevenue * 1.25;
      const rateAtStretch = rateForAchievement(125, tiers);
      const incentiveAtStretch = stretchRevenue * (rateAtStretch / 100);
      // Same growth% applied to quantity, mirroring the revenue target —
      // "صافي الكمية المستهدفة" alongside the SAR target.
      const targetQty = c.avg_monthly_qty * (1 + gPct / 100);

      totalTargetRevenue      += targetRevenue;
      totalIncentiveAtTarget  += incentiveAtTarget;
      totalIncentiveAtStretch += incentiveAtStretch;
      totalNetQty    += c.total_qty;
      totalTargetQty += targetQty;

      return {
        customer_code: c.customer_code,
        customer_name: c.customer_name,
        // customer_name_ar/region_name weren't copied here before — the raw
        // API response (incentiveBaseline.customers) carried them correctly,
        // but this derived perCustomer array silently dropped both on the
        // way to the contract tab, which is why "اسم العميل (عربي)" showed
        // "—" even for a customer whose Arabic name WAS resolved server-side.
        customer_name_ar: c.customer_name_ar || null,
        region_name: c.region_name || null,
        active_months: c.active_months,
        avg_monthly_revenue: c.avg_monthly_revenue,
        target_revenue: targetRevenue,
        rate_at_target: rateAtTarget,
        incentive_at_target: incentiveAtTarget,
        stretch_revenue: stretchRevenue,
        rate_at_stretch: rateAtStretch,
        incentive_at_stretch: incentiveAtStretch,
        // Quantity fields — real historical net qty sold (total_qty, over
        // the whole selected period) alongside the projected qty target.
        total_qty: c.total_qty,
        avg_monthly_qty: c.avg_monthly_qty,
        target_qty: targetQty,
      };
    });

    return {
      growthPct: gPct, tiers,
      perCustomer,
      totals: {
        total_target_revenue:      totalTargetRevenue,
        total_incentive_at_target:  totalIncentiveAtTarget,
        total_incentive_at_stretch: totalIncentiveAtStretch,
        cost_pct_at_target:  totalTargetRevenue > 0 ? (totalIncentiveAtTarget  / totalTargetRevenue) * 100 : 0,
        cost_pct_at_stretch: totalTargetRevenue > 0 ? (totalIncentiveAtStretch / (totalTargetRevenue * 1.25)) * 100 : 0,
        // "صافي الكميات المباعة" — real historical total across all
        // customers for the selected period (not a projection).
        total_net_qty:    totalNetQty,
        total_target_qty: totalTargetQty,
      },
    };
  }, [incentiveBaseline, rateForAchievement]);

  const incentiveScenario = useMemo(
    () => calcIncentiveScenario(incentiveGrowthPct, incentiveTiers),
    [calcIncentiveScenario, incentiveGrowthPct, incentiveTiers]
  );

  const [incentiveCustSort, setIncentiveCustSort] = useState({ col: 'target_revenue', dir: 'desc' });
  const handleIncentiveCustSort = useCallback(col => setIncentiveCustSort(s => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' })), []);
  const [incentiveCustSearch, setIncentiveCustSearch] = useState('');

  const sortedIncentiveCusts = useMemo(() => {
    if (!incentiveScenario?.perCustomer) return [];
    let rows = incentiveScenario.perCustomer;
    if (incentiveCustSearch.trim()) {
      const q = incentiveCustSearch.trim().toLowerCase();
      rows = rows.filter(c => (c.customer_name || '').toLowerCase().includes(q) || (c.customer_code || '').includes(q));
    }
    const dir = incentiveCustSort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => (Number(b[incentiveCustSort.col]) - Number(a[incentiveCustSort.col])) * dir);
  }, [incentiveScenario, incentiveCustSort, incentiveCustSearch]);

  /* ══════════════════════════════════════════════
     TAB: صافي المبيعات الشهري للعملاء — the SAME customer set/filters as
     "سيناريو حافز % من المبيعات" (reads incentiveBaseline directly, not
     incentiveScenario, since this tab has nothing to do with growth%/tiers),
     broken down month by month instead of collapsed into one period total.
     `months`/`by_month` come straight from /incentive-baseline — one query
     shape shared with the totals already shown on the incentive tab, so
     summing a customer's month cells here always foots exactly to that
     tab's total_qty/total_revenue for the same customer. ══════════════ */
  const [monthlyCustSearch, setMonthlyCustSearch] = useState('');
  const [monthlySortCol, setMonthlySortCol] = useState('total_revenue');
  const handleMonthlySort = useCallback(col => setMonthlySortCol(c => c === col ? c : col), []);

  const monthlyCustomers = useMemo(() => {
    if (!incentiveBaseline?.customers) return [];
    let rows = incentiveBaseline.customers;
    if (monthlyCustSearch.trim()) {
      const q = monthlyCustSearch.trim().toLowerCase();
      rows = rows.filter(c => (c.customer_name || '').toLowerCase().includes(q) || (c.customer_code || '').includes(q));
    }
    return [...rows].sort((a, b) => Number(b[monthlySortCol]) - Number(a[monthlySortCol]));
  }, [incentiveBaseline, monthlyCustSearch, monthlySortCol]);

  const monthlyMonths = incentiveBaseline?.months || [];

  const handleMonthlyExport = useCallback(() => {
    if (!incentiveBaseline) return;
    const header = ['كود العميل', 'اسم العميل',
      ...monthlyMonths.flatMap(m => [`${MONTH_AR[m.month]} ${m.year} — كمية`, `${MONTH_AR[m.month]} ${m.year} — قيمة`]),
      'إجمالي الكمية', 'إجمالي القيمة', 'متوسط الفترة — كمية', 'متوسط الفترة — قيمة'];
    const rows = monthlyCustomers.map(c => [
      c.customer_code, c.customer_name,
      ...monthlyMonths.flatMap(m => {
        const cell = c.by_month?.[m.key];
        return [cell ? cell.qty : 0, cell ? +cell.revenue.toFixed(2) : 0];
      }),
      c.total_qty, +c.total_revenue.toFixed(2),
      +c.avg_monthly_qty.toFixed(1), +c.avg_monthly_revenue.toFixed(2),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'صافي المبيعات الشهري');
    const today = new Date().toLocaleDateString('en-CA');
    XLSX.writeFile(wb, `Discount Shops_Monthly Net Sales_${today}.xlsx`);
  }, [incentiveBaseline, monthlyCustomers, monthlyMonths]);

  const handleIncentiveExport = useCallback(() => {
    if (!incentiveScenario) return;
    const wb = XLSX.utils.book_new();

    const hdrRows = [
      ['التقرير', 'سيناريو حافز % من المبيعات'],
      ['نسبة النمو المطلوبة للهدف %', incentiveGrowthPct],
      [''],
      ['شرائح الحافز'],
      ['نسبة تحقيق الهدف % (من)', 'نسبة الحافز %'],
      ...incentiveTiers.map(t => [t.minPct, t.rate]),
      [''],
      ['صافي الكميات المباعة (الفترة المحددة)', incentiveScenario.totals.total_net_qty],
      ['الكمية المستهدفة (بنفس نسبة النمو)', +incentiveScenario.totals.total_target_qty.toFixed(1)],
      ['إجمالي المبيعات المستهدفة (كل العملاء)', +incentiveScenario.totals.total_target_revenue.toFixed(2)],
      ['إجمالي الحافز عند تحقيق الهدف فقط (100%)', +incentiveScenario.totals.total_incentive_at_target.toFixed(2)],
      ['نسبة تكلفة الحافز إلى المبيعات عند 100% %', +incentiveScenario.totals.cost_pct_at_target.toFixed(2)],
      ['إجمالي الحافز التقديري عند تحقيق 125% من الهدف', +incentiveScenario.totals.total_incentive_at_stretch.toFixed(2)],
      ['نسبة تكلفة الحافز إلى المبيعات عند 125% %', +incentiveScenario.totals.cost_pct_at_stretch.toFixed(2)],
    ];
    const wsHdr = XLSX.utils.aoa_to_sheet(hdrRows);
    wsHdr['!cols'] = [{ wch: 42 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, wsHdr, 'ملخص السيناريو');

    const custHeader = ['كود العميل', 'اسم العميل', 'أشهر النشاط', 'صافي الكمية المباعة', 'الكمية المستهدفة', 'متوسط المبيعات الشهري', 'الهدف المطلوب لاستحقاق الحافز', 'نسبة الحافز عند الهدف %', 'قيمة الحافز عند الهدف', 'مبيعات عند تحقيق 125%', 'قيمة الحافز عند 125%'];
    const custRows = [...incentiveScenario.perCustomer].sort((a, b) => b.target_revenue - a.target_revenue).map(c => [
      c.customer_code, c.customer_name, c.active_months, c.total_qty, +c.target_qty.toFixed(1),
      +c.avg_monthly_revenue.toFixed(2), +c.target_revenue.toFixed(2), c.rate_at_target, +c.incentive_at_target.toFixed(2),
      +c.stretch_revenue.toFixed(2), +c.incentive_at_stretch.toFixed(2),
    ]);
    const wsCust = XLSX.utils.aoa_to_sheet([custHeader, ...custRows]);
    wsCust['!cols'] = [{ wch: 14 }, { wch: 28 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, wsCust, 'العملاء');

    const today = new Date().toLocaleDateString('en-CA');
    XLSX.writeFile(wb, `Discount Shops_Incentive_g${incentiveGrowthPct}_${today}.xlsx`);
  }, [incentiveScenario, incentiveGrowthPct, incentiveTiers]);

  /* ══════════════════════════════════════════════
     TAB: Customer contract print — turns one row of the incentive
     scenario above into the signed "اتفاقية تعاون تجاري وحوافز مبيعات"
     paper form. Reuses incentiveScenario.perCustomer as-is (same
     customer list, same growth% and tiers the admin already set on the
     "سيناريو حافز % من المبيعات" tab) rather than recomputing anything,
     so the two tabs can never disagree on a customer's numbers. Company
     identity (CR number/address) is fixed — it's the same legal entity
     on every contract — while the customer's own CR number, the
     agreement dates and the credit limit are left blank on the printed
     sheet for manual completion, exactly like the source paper template.
  ══════════════════════════════════════════════ */
  const COMPANY_CR_NUMBER = '1113003711';
  const COMPANY_ADDRESS = 'شركة ريادة طرية للدواجن شركة شخص واحد – 8970 وحدة رقم 2 شقراء 15573-3244 المملكة العربية السعودية';

  const [contractCustSearch, setContractCustSearch] = useState('');
  const [contractCustCode, setContractCustCode] = useState('');

  // The full admin-uploaded discount-shop segment ("القائمة المدخلة") —
  // shares its cache with DiscountShopCustomerListPanel's own identical
  // query, so this doesn't add a second network request. Used so the
  // contract customer picker below offers EVERY customer in that list, not
  // just the ones incentiveBaseline happened to find sales for in whatever
  // date range/branch/rep filters are currently selected up top.
  const { data: dsCustomerList } = useQuery({
    queryKey: ['ds-customer-list'],
    queryFn: () => client.get('/discount-shops/customer-list').then(r => r.data),
    staleTime: 60 * 1000,
  });

  // Union of incentiveScenario.perCustomer (real computed averages/targets
  // for customers with sales in the selected period) with every OTHER
  // customer from the full segment list, zero-filled — so a customer can
  // always be picked and a contract printed for them even before they have
  // any sales recorded in the currently-selected filters. `no_sales_data`
  // flags the zero-filled ones so the dropdown/print preview can say so
  // plainly instead of silently showing a misleading "0" target.
  const contractCustAllOptions = useMemo(() => {
    const byCode = new Map();
    (incentiveScenario?.perCustomer || []).forEach(c => byCode.set(c.customer_code, c));
    (dsCustomerList?.customers || []).forEach(mc => {
      if (!byCode.has(mc.customer_code)) {
        byCode.set(mc.customer_code, {
          customer_code: mc.customer_code,
          // mc.customer_name (discount_shop_customers' own field) is
          // Arabic-preferred by that table's own upload/add-one design —
          // NOT reliably English. mc.customer_name_en is the customers
          // MASTER's own always-English column, resolved separately on the
          // backend specifically so this can't happen again; only falls
          // back to mc.customer_name for a segment customer absent from the
          // master entirely (name unresolved either way at that point).
          customer_name: mc.customer_name_en || mc.customer_name,
          customer_name_ar: mc.customer_name_ar || null,
          region_name: mc.region_name || null,
          active_months: 0,
          avg_monthly_revenue: 0, target_revenue: 0, rate_at_target: 0, incentive_at_target: 0,
          stretch_revenue: 0, rate_at_stretch: 0, incentive_at_stretch: 0,
          total_qty: 0, avg_monthly_qty: 0, target_qty: 0,
          no_sales_data: true,
        });
      }
    });
    return Array.from(byCode.values());
  }, [incentiveScenario, dsCustomerList]);

  const contractCustOptions = useMemo(() => {
    let rows = contractCustAllOptions;
    if (contractCustSearch.trim()) {
      const q = contractCustSearch.trim().toLowerCase();
      rows = rows.filter(c =>
        (c.customer_name || '').toLowerCase().includes(q) ||
        (c.customer_name_ar || '').toLowerCase().includes(q) ||
        (c.customer_code || '').includes(q));
    }
    // Sorted by the Arabic name first (the primary displayed identity below),
    // falling back to English for a customer with no Arabic name resolved.
    return [...rows].sort((a, b) =>
      (a.customer_name_ar || a.customer_name || '').localeCompare(b.customer_name_ar || b.customer_name || '', 'ar'));
  }, [contractCustAllOptions, contractCustSearch]);

  // Arabic-primary display label used everywhere a customer is picked from
  // this list — falls back to the English name only when no Arabic name was
  // resolved (never to the bare code alone).
  const custDisplayName = c => c.customer_name_ar || c.customer_name;

  const contractCustomer = useMemo(
    () => contractCustAllOptions.find(c => c.customer_code === contractCustCode) || null,
    [contractCustAllOptions, contractCustCode]
  );

  /* Basis toggle — a contract's monthly target/tiers can be pegged to
     either physical quantity ("حبة", the paper template's original unit)
     or sales value ("ر.س"), since some deals are negotiated on revenue
     rather than unit count. Revenue amounts keep 2 decimals; quantities
     are whole units — matching how each is displayed everywhere else on
     this page (avg_monthly_qty/target_qty vs avg_monthly_revenue/target_revenue). */
  const [contractBasis, setContractBasis] = useState('qty'); // 'qty' | 'revenue'
  const contractUnitLabel = contractBasis === 'revenue' ? 'ر.س' : 'حبة';
  const contractValueDecimals = contractBasis === 'revenue' ? 2 : 0;
  const contractAvgValue = contractCustomer
    ? (contractBasis === 'revenue' ? contractCustomer.avg_monthly_revenue : contractCustomer.avg_monthly_qty)
    : 0;
  const contractTargetValue = contractCustomer
    ? (contractBasis === 'revenue' ? contractCustomer.target_revenue : contractCustomer.target_qty)
    : 0;

  /* Tier thresholds derived from this customer's own 100%-baseline target
     (target_qty or target_revenue, matching contractBasis) times each
     tier's minPct/100 — so "الشريحة الثانية" lines up exactly with the
     110% figure the incentive tab itself uses, etc. The upper bound of
     a row is one unit below the next tier's threshold (one SAR cent for
     revenue, one whole unit for quantity); the last tier is open-ended
     ("فأكثر"), matching the paper template. */
  const contractTierRows = useMemo(() => {
    if (!contractCustomer) return [];
    const round = v => contractBasis === 'revenue' ? +v.toFixed(2) : Math.round(v);
    const step = contractBasis === 'revenue' ? 0.01 : 1;
    const thresholds = incentiveTiers.map(t => round(contractTargetValue * (t.minPct / 100)));
    return incentiveTiers.map((t, i) => ({
      label: ['الأولى', 'الثانية', 'الثالثة'][i] || `الشريحة ${i + 1}`,
      from: thresholds[i],
      to: i < incentiveTiers.length - 1 ? round(thresholds[i + 1] - step) : null,
      rate: t.rate,
    }));
  }, [contractCustomer, incentiveTiers, contractBasis, contractTargetValue]);

  /* ── Save log — every saved contract gets a permanent, unique
     contract_no (backend SERIAL, see 101_discount_shop_contracts.sql).
     Saving happens automatically right before printing (one click =
     one signed contract = one log row), rather than as a separate step
     a user could forget, since the whole point of the request was that
     NO printed contract goes unlogged. ── */
  // Gate the actual save+print behind an explicit review step — the print
  // button no longer fires the save immediately; it first flags this true,
  // which reveals a confirmation banner over the (already-live) preview
  // card asking the user to confirm the exact numbers before anything is
  // written to the save log.
  const [pendingSaveConfirm, setPendingSaveConfirm] = useState(false);
  const [savingContract, setSavingContract] = useState(false);
  const [saveContractError, setSaveContractError] = useState('');
  // { contract_no, created_at, customer_code } — only rendered on the print
  // sheet / preview once it matches the currently-selected customer, so an
  // earlier contract's number can never bleed onto a different customer's
  // sheet after switching the dropdown.
  const [lastSavedContract, setLastSavedContract] = useState(null);
  const [pendingPrint, setPendingPrint] = useState(false);
  const [contractLogCustCode, setContractLogCustCode] = useState(''); // '' = show all customers' contracts
  const [contractLogRegion, setContractLogRegion] = useState(''); // '' = كل المناطق
  const [expandedContractId, setExpandedContractId] = useState(null);
  // A saved log row picked for reprint/browse — when set, the print sheet
  // and preview render its FROZEN snapshot instead of the live customer
  // selection above, letting a user re-open and re-print (or just review)
  // an old contract exactly as it was originally saved.
  const [printTarget, setPrintTarget] = useState(null);
  const [editingContractId, setEditingContractId] = useState(null);
  const [editDraft, setEditDraft] = useState(null); // working copy while editing a log row
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState('');

  const { data: contractLog, isLoading: isContractLogLoading, refetch: refetchContractLog } = useQuery({
    queryKey: ['ds-contracts', contractLogCustCode],
    queryFn: () => client
      .get('/discount-shops/contracts', contractLogCustCode ? { params: { customer_code: contractLogCustCode } } : undefined)
      .then(r => r.data),
    staleTime: 30 * 1000,
  });

  // Region filter for the log table — distinct region_names actually present
  // in the current (possibly customer-filtered) log, so the dropdown never
  // offers a region with zero matching rows. Filtered client-side (the log
  // is small — no need for a server round-trip per region toggle).
  const contractLogRegionOptions = useMemo(() => {
    const set = new Set((contractLog?.contracts || []).map(c => c.region_name).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b, 'ar'));
  }, [contractLog]);
  const contractLogRowsFiltered = useMemo(() => {
    const rows = contractLog?.contracts || [];
    return contractLogRegion ? rows.filter(c => c.region_name === contractLogRegion) : rows;
  }, [contractLog, contractLogRegion]);

  const displayedSavedContract = (lastSavedContract && lastSavedContract.customer_code === contractCustCode)
    ? lastSavedContract : null;

  /* Single source of truth for both the on-screen preview card and the
     print-only sheet — either a browsed/reprinted saved log row
     (printTarget) or the live customer selection above. Unifying the two
     means the print DOM never has to know which source it's rendering. */
  const printSheetData = useMemo(() => {
    if (printTarget) {
      return {
        customerName: printTarget.customer_name,
        customerNameAr: printTarget.customer_name_ar || null,
        customerCode: printTarget.customer_code,
        unitLabel: printTarget.basis === 'revenue' ? 'ر.س' : 'حبة',
        decimals: printTarget.basis === 'revenue' ? 2 : 0,
        avgValue: Number(printTarget.avg_monthly_value),
        tiers: printTarget.tiers || [],
        contractNo: printTarget.contract_no,
      };
    }
    if (contractCustomer) {
      return {
        customerName: contractCustomer.customer_name,
        customerNameAr: contractCustomer.customer_name_ar || null,
        customerCode: contractCustomer.customer_code,
        unitLabel: contractUnitLabel,
        decimals: contractValueDecimals,
        avgValue: contractAvgValue,
        tiers: contractTierRows,
        contractNo: displayedSavedContract?.contract_no ?? null,
        noSalesData: !!contractCustomer.no_sales_data,
      };
    }
    return null;
  }, [printTarget, contractCustomer, contractUnitLabel, contractValueDecimals, contractAvgValue, contractTierRows, displayedSavedContract]);

  /* Step 1: just open the review banner — no API call yet. */
  const handleRequestSaveContract = useCallback(() => {
    if (!contractCustomer || !contractTierRows.length) return;
    setSaveContractError('');
    setPendingSaveConfirm(true);
  }, [contractCustomer, contractTierRows]);

  /* Step 2: the user has reviewed printSheetData (still the live selection
     at this point, since printTarget is null) and confirmed — now actually
     save + print. */
  const handleConfirmSaveAndPrint = useCallback(async () => {
    if (!contractCustomer || !contractTierRows.length) return;
    setSaveContractError('');
    setSavingContract(true);
    try {
      const res = await client.post('/discount-shops/contracts', {
        customer_code: contractCustomer.customer_code,
        customer_name: contractCustomer.customer_name,
        customer_name_ar: contractCustomer.customer_name_ar || null,
        region_name: contractCustomer.region_name || null,
        avg_monthly_value: contractAvgValue,
        growth_pct: incentiveGrowthPct,
        target_value: contractTargetValue,
        tiers: contractTierRows,
        basis: contractBasis,
      });
      setPendingSaveConfirm(false);
      // Make sure a stale reprint target from the log can't override this
      // freshly-saved live contract on the next render.
      setPrintTarget(null);
      // Stash the customer_code alongside the API response so the printed
      // sheet only ever shows a number that belongs to what's on screen —
      // then defer the actual print to the effect below, which fires only
      // AFTER React has committed this state (and the print-only DOM
      // now includes "رقم العقد: #N"). Calling window.print() synchronously
      // here would race the render and could print the sheet with no
      // number, or worse, the PREVIOUS customer's number still showing.
      setLastSavedContract({ ...res.data.contract, customer_code: contractCustomer.customer_code });
      setPendingPrint(true);
      refetchContractLog();
    } catch (err) {
      setSaveContractError(err?.response?.data?.error || 'حدث خطأ أثناء حفظ سجل العقد — لم تتم الطباعة');
    } finally {
      setSavingContract(false);
    }
  }, [contractCustomer, contractTierRows, incentiveGrowthPct, contractAvgValue, contractTargetValue, contractBasis, refetchContractLog]);

  const handleCancelSaveConfirm = useCallback(() => setPendingSaveConfirm(false), []);

  // Selecting a different customer or flipping the basis makes the pending
  // review stale (it was reviewing different numbers) — close it rather
  // than let a confirm click save the NEW selection under a review the
  // user never actually saw.
  useEffect(() => { setPendingSaveConfirm(false); }, [contractCustCode, contractBasis]);

  /* Browse a saved contract before deciding whether to print it — loads
     its frozen snapshot into the preview card (printSheetData above)
     WITHOUT printing or creating any new save-log row. Printing it is a
     separate, explicit action (handlePrintViewedContract) so opening a
     row to look at it can never accidentally trigger the print dialog. */
  const handleViewSavedContract = useCallback((c) => {
    setEditingContractId(null);
    setPrintTarget(c);
  }, []);

  const handleClosePreview = useCallback(() => setPrintTarget(null), []);

  const handlePrintViewedContract = useCallback(() => {
    if (!printTarget) return;
    setPendingPrint(true);
  }, [printTarget]);

  useEffect(() => {
    if (!pendingPrint || !printSheetData) return;
    document.body.classList.add('ds-printing-contract');
    printWithPageSize('A4 portrait', '1.5cm 1.3cm', () => document.body.classList.remove('ds-printing-contract'));
    setPendingPrint(false);
  }, [pendingPrint, printSheetData]);

  /* ── Edit an existing saved contract ── */
  const startEditContract = useCallback((c) => {
    setExpandedContractId(null);
    setEditError('');
    setEditingContractId(c.id);
    setEditDraft({
      avg_monthly_value: Number(c.avg_monthly_value),
      growth_pct: Number(c.growth_pct),
      basis: c.basis,
      tiers: (c.tiers || []).map(t => ({ ...t })),
    });
  }, []);

  const cancelEditContract = useCallback(() => {
    setEditingContractId(null);
    setEditDraft(null);
    setEditError('');
  }, []);

  const updateEditTier = useCallback((idx, field, value) => {
    setEditDraft(d => ({
      ...d,
      tiers: d.tiers.map((t, i) => i === idx ? { ...t, [field]: value === '' ? null : Number(value) } : t),
    }));
  }, []);

  /* Editing "الهدف الشهري" or "نسبة النمو" by hand recomputes every tier's
     من/إلى from scratch — anchored exactly the way a brand-new contract's
     tiers are (see contractTierRows above): tier 1 starts EXACTLY at the
     grown target (avg_monthly_value × (1 + growth_pct/100)), tier 2/3 sit
     at that same target × their own minPct/100 from the global
     incentiveTiers ladder, and each row's upper bound is one step below
     the next tier's threshold. An earlier version tried to PRESERVE
     whatever من/إلى ratios a hand-edited contract already had and just
     rescale them proportionally — but that only keeps tier 1 anchored to
     the target if it already was, so a contract whose tiers had drifted
     (or predate this feature) could come out with tier 1 starting BELOW
     the target after an "edit", which is exactly backwards. Recomputing
     from the percentage ladder every time guarantees tier 1 = the grown
     target by construction, regardless of what was there before. Only
     rate/بونص% (independently hand-tunable per contract) survives the
     recompute untouched. */
  const recalcEditTiers = useCallback((tiers, avgValue, growthPct, basis) => {
    const target = avgValue * (1 + growthPct / 100);
    const step = basis === 'revenue' ? 0.01 : 1;
    const round = v => basis === 'revenue' ? +v.toFixed(2) : Math.round(v);
    const thresholds = tiers.map((t, i) =>
      incentiveTiers[i] ? round(target * (incentiveTiers[i].minPct / 100)) : t.from
    );
    return tiers.map((t, i) => ({
      ...t,
      from: thresholds[i],
      to: i < tiers.length - 1 ? round(thresholds[i + 1] - step) : null,
    }));
  }, [incentiveTiers]);

  const updateEditTarget = useCallback((field, rawValue) => {
    const newVal = Number(rawValue) || 0;
    setEditDraft(d => {
      const next = { ...d, [field]: newVal };
      return { ...next, tiers: recalcEditTiers(d.tiers, next.avg_monthly_value, next.growth_pct, next.basis) };
    });
  }, [recalcEditTiers]);

  const saveEditContract = useCallback(async (contractId) => {
    if (!editDraft) return;
    setSavingEdit(true);
    setEditError('');
    try {
      // "target_value" is redundant with the first tier's "from" once tiers
      // are hand-edited (they may no longer be a clean 100%/110%/125%
      // ladder off one baseline) — the tiers array is the source of truth
      // after an edit, so target_value is just re-derived from tier 1.
      const targetValue = editDraft.tiers[0]?.from ?? 0;
      const res = await client.put(`/discount-shops/contracts/${contractId}`, {
        avg_monthly_value: editDraft.avg_monthly_value,
        growth_pct: editDraft.growth_pct,
        target_value: targetValue,
        tiers: editDraft.tiers,
        basis: editDraft.basis,
      });
      setEditingContractId(null);
      setEditDraft(null);
      await refetchContractLog();
      // If the freshly-edited row is the one currently on the print sheet,
      // refresh printTarget so a subsequent reprint shows the correction.
      setPrintTarget(prev => (prev && prev.id === contractId) ? res.data.contract : prev);
    } catch (err) {
      setEditError(err?.response?.data?.error || 'حدث خطأ أثناء حفظ التعديل');
    } finally {
      setSavingEdit(false);
    }
  }, [editDraft, refetchContractLog]);

  /* ── Delete a saved contract ── */
  const [deletingContractId, setDeletingContractId] = useState(null);
  const handleDeleteContract = useCallback(async (c) => {
    const ok = window.confirm(`حذف العقد #${c.contract_no} (${c.customer_name}) نهائياً من السجل؟ لا يمكن التراجع عن هذا الإجراء.`);
    if (!ok) return;
    setDeletingContractId(c.id);
    try {
      await client.delete(`/discount-shops/contracts/${c.id}`);
      if (expandedContractId === c.id) setExpandedContractId(null);
      if (editingContractId === c.id) cancelEditContract();
      if (printTarget?.id === c.id) setPrintTarget(null);
      await refetchContractLog();
    } catch (err) {
      window.alert(err?.response?.data?.error || 'حدث خطأ أثناء حذف العقد');
    } finally {
      setDeletingContractId(null);
    }
  }, [expandedContractId, editingContractId, printTarget, cancelEditContract, refetchContractLog]);

  /* ── Sorted reps & customers ────────────────────────────── */
  const sortedReps = useMemo(() => {
    if (!data?.by_rep) return [];
    const dir = repSort.dir === 'desc' ? -1 : 1;
    return [...data.by_rep].sort((a, b) => (Number(b[repSort.col]) - Number(a[repSort.col])) * dir);
  }, [data, repSort]);

  const sortedCusts = useMemo(() => {
    if (!data?.customers) return [];
    const dir = custSort.dir === 'desc' ? -1 : 1;
    return [...data.customers].sort((a, b) => (Number(b[custSort.col]) - Number(a[custSort.col])) * dir);
  }, [data, custSort]);

  const sortedItems = useMemo(() => {
    if (!data?.by_item) return [];
    const dir = itemSort.dir === 'desc' ? -1 : 1;
    return [...data.by_item].sort((a, b) => (Number(b[itemSort.col]) - Number(a[itemSort.col])) * dir);
  }, [data, itemSort]);

  const topItems = useMemo(() => {
    if (!data?.by_item) return [];
    return [...data.by_item].sort((a, b) => b.total_qty - a.total_qty).slice(0, 10);
  }, [data]);

  const bottomItems = useMemo(() => {
    if (!data?.by_item) return [];
    return [...data.by_item]
      .filter(it => it.total_qty > 0)
      .sort((a, b) => a.total_qty - b.total_qty)
      .slice(0, 10);
  }, [data]);

  const topItemsAllTime = useMemo(() => {
    if (!itemOverview?.items) return [];
    return [...itemOverview.items].sort((a, b) => b.total_qty - a.total_qty).slice(0, 10);
  }, [itemOverview]);

  const bottomItemsAllTime = useMemo(() => {
    if (!itemOverview?.items) return [];
    return [...itemOverview.items]
      .filter(it => it.total_qty > 0)
      .sort((a, b) => a.total_qty - b.total_qty)
      .slice(0, 10);
  }, [itemOverview]);

  /* ── Branch × month matrix (qty/returns/revenue summed across every
       year present) for the "نظرة عامة" tab — includes row totals
       (per branch, across all months) and column totals (per month,
       across all branches), plus a grand total. ── */
  /* ── Insight card: best/worst branch by sales, most/least returns ── */
  const branchInsights = useMemo(() => {
    if (!overview?.by_branch?.length) return null;
    const byQtyDesc = [...overview.by_branch].sort((a, b) => b.total_qty - a.total_qty);
    const byReturnsDesc = [...overview.by_branch].sort((a, b) => b.total_returns - a.total_returns);
    return {
      bestSales:    byQtyDesc[0],
      worstSales:   byQtyDesc[byQtyDesc.length - 1],
      mostReturns:  byReturnsDesc[0],
      leastReturns: byReturnsDesc[byReturnsDesc.length - 1],
    };
  }, [overview]);

  const overviewMatrix = useMemo(() => {
    if (!overview?.branch_month_matrix?.length) return null;
    const zeroCell = () => ({ total_qty: 0, total_returns: 0, gross_revenue: 0, net_revenue: 0 });

    const branchTotals    = {}; // branch_name → summed cell (row total)
    const cellByBranchMonth = {};
    const colTotals = Array.from({ length: 12 }, zeroCell); // index 0 = month 1
    const grandTotal = zeroCell();
    let maxQty = 1;

    overview.branch_month_matrix.forEach(c => {
      cellByBranchMonth[`${c.branch_name}-${c.month_num}`] = c;
      if (c.total_qty > maxQty) maxQty = c.total_qty;

      if (!branchTotals[c.branch_name]) branchTotals[c.branch_name] = zeroCell();
      branchTotals[c.branch_name].total_qty      += c.total_qty;
      branchTotals[c.branch_name].total_returns  += c.total_returns;
      branchTotals[c.branch_name].gross_revenue  += c.gross_revenue;
      branchTotals[c.branch_name].net_revenue    += c.net_revenue;

      const col = colTotals[c.month_num - 1];
      col.total_qty     += c.total_qty;
      col.total_returns += c.total_returns;
      col.gross_revenue += c.gross_revenue;
      col.net_revenue   += c.net_revenue;

      grandTotal.total_qty     += c.total_qty;
      grandTotal.total_returns += c.total_returns;
      grandTotal.gross_revenue += c.gross_revenue;
      grandTotal.net_revenue   += c.net_revenue;
    });

    const branches = Object.keys(branchTotals).sort((a, b) => branchTotals[b].total_qty - branchTotals[a].total_qty);
    return { branches, cellByBranchMonth, branchTotals, colTotals, grandTotal, maxQty };
  }, [overview]);

  /* ── Customer × month matrix column/grand totals (row totals already
       come pre-computed per customer as annual_qty/returns/revenue) ── */
  const custMatrixTotals = useMemo(() => {
    if (!custMatrix?.items?.length) return null;
    const zeroCell = () => ({ qty: 0, returns: 0, revenue: 0 });
    const colTotals = Array.from({ length: 12 }, zeroCell);
    const grandTotal = zeroCell();
    custMatrix.items.forEach(it => {
      it.months.forEach((mo, i) => {
        colTotals[i].qty     += mo.qty;
        colTotals[i].returns += mo.returns;
        colTotals[i].revenue += mo.revenue;
      });
      grandTotal.qty     += it.annual_qty;
      grandTotal.returns += it.annual_returns;
      grandTotal.revenue += it.annual_revenue;
    });
    return { colTotals, grandTotal };
  }, [custMatrix]);

  /* ── Derived values ──────────────────────────────────────── */
  const periodLabel   = useDateRange ? `${dateFrom} → ${dateTo}` : `${monthsLabel} ${yearsLabel}`;
  const monthName     = MONTHS.find(m => m[0] === month)?.[1] || '';
  const prevMonthName = MONTHS.find(m => m[0] === (month === 1 ? 12 : month - 1))?.[1] || '';

  // Declared here (before handleExport) since its useCallback dependency
  // array reads cur/prev/dev — referencing them before this point would be
  // a TDZ ReferenceError ("Cannot access 'x' before initialization").
  const d    = data;
  const cur  = d?.cur;
  const prev = d?.prev;
  const dev  = d?.deviation;

  function handlePrint() {
    const prev = document.title;
    document.title = `Discount Shops — ${monthsLabel} ${yearsLabel}`;
    printWithPageSize('A4 landscape', '1.2cm 1cm', () => { document.title = prev; });
  }

  /* ── Excel export ─────────────────────────────────────────── */
  const handleExport = useCallback(() => {
    if (!data) return;
    const wb = XLSX.utils.book_new();

    /* ── Sheet 1: KPI summary ── */
    const kpiRows = [
      ['التقرير', `Discount Shops — ${monthsLabel} ${yearsLabel}`],
      ['المنطقة', branchLabel],
      ['المندوب', repName || 'جميع المناديب'],
      ['أيام العمل', data.meta?.working_days_cur ?? ''],
      [''],
      ['المؤشر', monthName, prevMonthName, 'الانحراف %'],
      ['إجمالي الكمية',       fmt(cur?.total_qty),         fmt(prev?.total_qty),         dev?.qty_pct ?? ''],
      ['المتوسط اليومي',      fmt(cur?.daily_avg, 1),      fmt(prev?.daily_avg, 1),      dev?.daily_avg_pct ?? ''],
      ['متوسط الكمية/عميل',   fmt(cur?.avg_per_customer,1), '', ''],
      ['المرتجعات',           fmt(cur?.total_returns),     fmt(prev?.total_returns),     ''],
      ['نسبة المرتجعات %',    fmt(cur?.returns_pct,1),      fmt(prev?.returns_pct,1),     dev?.returns_delta ?? ''],
      ['العملاء المتعاملون',  fmt(cur?.active_customers),   fmt(prev?.active_customers),  dev?.customers_pct ?? ''],
      ['عملاء جدد',           fmt(cur?.new_customers), '', ''],
      ['عملاء متوقفون',       fmt(cur?.stopped_customers), '', ''],
      ['كمية صفر أو سالبة',   fmt(cur?.inactive_customers), '', ''],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(kpiRows);
    ws1['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'ملخص KPI');

    /* ── Sheet 2: Regions ── */
    const regHeader = ['المنطقة', 'الكمية', 'الشهر الماضي', 'الانحراف %', 'العملاء', 'المرتجعات', 'نسبة المرتجعات %'];
    const regRows = (data.by_region || []).map(r => {
      const dv = r.prev_qty > 0 ? +((r.total_qty - r.prev_qty) / r.prev_qty * 100).toFixed(1) : '';
      return [
        r.branch_name, Number(r.total_qty) || 0, Number(r.prev_qty) || 0, dv,
        Number(r.active_customers) || 0, Number(r.total_returns) || 0, Number(r.returns_pct) || 0,
      ];
    });
    const ws2 = XLSX.utils.aoa_to_sheet([regHeader, ...regRows]);
    ws2['!cols'] = [{ wch: 20 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'المناطق');

    /* ── Sheet 3: Reps ── */
    const repHeader = ['المندوب', 'المنطقة', 'الكمية', 'الشهر الماضي', 'الانحراف %', 'العملاء', 'المرتجعات', 'نسبة المرتجعات %'];
    const repRows = [...(data.by_rep || [])].sort((a, b) => b.total_qty - a.total_qty).map(r => {
      const dv = r.prev_qty > 0 ? +((r.total_qty - r.prev_qty) / r.prev_qty * 100).toFixed(1) : '';
      return [
        r.salesrep_name, r.branch_name, Number(r.total_qty) || 0, Number(r.prev_qty) || 0, dv,
        Number(r.active_customers) || 0, Number(r.total_returns) || 0, Number(r.returns_pct) || 0,
      ];
    });
    const ws3 = XLSX.utils.aoa_to_sheet([repHeader, ...repRows]);
    ws3['!cols'] = [{ wch: 26 }, { wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'المناديب');

    /* ── Sheet 4: Customers ── */
    const custHeader = ['كود العميل', 'اسم العميل', 'المنطقة', 'المندوب', 'الكمية', 'المرتجعات', 'نسبة المرتجعات %', 'عدد الفواتير'];
    const custRows = [...(data.customers || [])].sort((a, b) => b.total_qty - a.total_qty).map(c => [
      c.customer_code, c.customer_name, c.branch_name || '', c.salesrep_name || '',
      Number(c.total_qty) || 0, Number(c.total_returns) || 0, Number(c.returns_pct) || 0, Number(c.invoice_count) || 0,
    ]);
    const ws4 = XLSX.utils.aoa_to_sheet([custHeader, ...custRows]);
    ws4['!cols'] = [{ wch: 14 }, { wch: 28 }, { wch: 16 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws4, 'العملاء');

    /* ── Sheet: Items ── */
    const itemHeader = ['الصنف', 'الفئة', 'الكمية', 'الشهر الماضي', 'الانحراف %', 'المرتجعات', 'نسبة المرتجعات %', 'عدد الفواتير'];
    const itemRows = [...(data.by_item || [])].sort((a, b) => b.total_qty - a.total_qty).map(it => {
      const dv = it.prev_qty > 0 ? +((it.total_qty - it.prev_qty) / it.prev_qty * 100).toFixed(1) : '';
      return [
        it.item_name, it.item_category, Number(it.total_qty) || 0, Number(it.prev_qty) || 0, dv,
        Number(it.total_returns) || 0, Number(it.returns_pct) || 0, Number(it.invoice_count) || 0,
      ];
    });
    const wsItems = XLSX.utils.aoa_to_sheet([itemHeader, ...itemRows]);
    wsItems['!cols'] = [{ wch: 28 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsItems, 'الأصناف');

    /* ── Sheet 5: Whole-period overview (if loaded) ── */
    if (overview) {
      const ovRows = [
        ['الفترة', `${overview.period.from_year} — ${overview.period.to_year}`],
        ['إجمالي الكمية', overview.totals.total_qty],
        ['إجمالي المرتجعات', overview.totals.total_returns],
        ['نسبة المرتجعات %', overview.totals.returns_pct],
        ['صافي الإيرادات', overview.totals.net_revenue],
        ['عدد الفواتير المدخلة', overview.totals.invoice_count],
        ['العملاء المتعاملون', overview.totals.active_customers],
        [''],
        ['إجمالي المبيعات العامة (نفس الفترة/الفرع، كل العملاء) — الكمية', overview.totals.company_total_qty],
        ['إجمالي المبيعات العامة — صافي الإيرادات', overview.totals.company_total_revenue],
        ['الحصة من إجمالي المبيعات — الكمية %', overview.totals.qty_share_pct],
        ['الحصة من إجمالي المبيعات — الإيرادات %', overview.totals.revenue_share_pct],
        [''],
        ['أفضل الفروع (كل الفترة)'],
        ['الفرع', 'الكمية', 'العملاء', 'عدد الفواتير', 'المرتجعات', 'نسبة المرتجعات %'],
        ...overview.by_branch.map(b => [b.branch_name, b.total_qty, b.active_customers, b.invoice_count, b.total_returns, b.returns_pct]),
        [''],
        ['الترند الشهري (كل الفترة)'],
        ['الشهر', 'الكمية', 'المرتجعات', 'صافي الإيرادات', 'العملاء', 'عدد الفواتير'],
        ...overview.trend.map(t => [t.label, t.total_qty, t.total_returns, t.net_revenue, t.active_customers, t.invoice_count]),
      ];
      const ws5 = XLSX.utils.aoa_to_sheet(ovRows);
      ws5['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, ws5, 'نظرة عامة');
    }

    const today = new Date().toLocaleDateString('en-CA');
    XLSX.writeFile(wb, `Discount Shops_${monthsLabel.replace(/[،\s]+/g, '-')}_${yearsLabel.replace(/[،\s]+/g, '-')}_${today}.xlsx`);
  }, [data, overview, monthName, prevMonthName, monthsLabel, yearsLabel, branchLabel, repName, cur, prev, dev]);

  /* ── Comparison row helper ───────────────────────────────── */
  function CmpRow({ label, curVal, prevVal, pct, invert = false }) {
    return (
      <div className="ds-cmp-row">
        <span className="ds-cmp-label">{label}</span>
        <span className="ds-cmp-cur">{curVal}</span>
        <span className="ds-cmp-prev">{prevVal}</span>
        <span className="ds-cmp-dev"><Dev pct={pct} invert={invert} size="sm" /></span>
      </div>
    );
  }

  return (
    <div className="ds-page">

      {/* ── Print header ─────────────────────────────────── */}
      <div className="ds-print-header">
        <div className="ds-print-logo">🏷️ Discount Shops Performance Report</div>
        <div className="ds-print-sub">{periodLabel}{branchNames.length ? ` · ${branchLabel}` : ''}{repName ? ` · ${repName}` : ''}</div>
      </div>

      {/* ── Page header ──────────────────────────────────── */}
      <div className="ds-header ds-no-print">
        <div className="ds-header__left">
          <span className="ds-header__icon">🏷️</span>
          <div>
            <div className="ds-header__title">أداء فئات محلات التخفيضات</div>
            <div className="ds-header__sub">تقرير أداء مبيعات ومرتجعات قائمة محلات التخفيضات المحددة (Discount Shops)</div>
          </div>
        </div>
        <div className="ds-header__actions">
          <button className="ds-btn ds-btn--outline" onClick={handleExport} disabled={!data}>📊 تصدير Excel</button>
          <button className="ds-btn ds-btn--outline" onClick={handlePrint}>🖨️ طباعة</button>
        </div>
      </div>

      {/* ── Filters ──────────────────────────────────────── */}
      <div className="ds-filters ds-no-print">
        <label className="ds-range-toggle">
          <input type="checkbox" checked={useDateRange}
                 onChange={e => setUseDateRange(e.target.checked)} />
          فترة محددة بالتاريخ
        </label>

        {useDateRange ? (
          <>
            <div className="ds-filter-group">
              <label>من تاريخ</label>
              <input type="date" value={dateFrom} max={dateTo || undefined}
                     onChange={e => setDateFrom(e.target.value)} />
            </div>
            <div className="ds-filter-group">
              <label>إلى تاريخ</label>
              <input type="date" value={dateTo} min={dateFrom || undefined}
                     onChange={e => setDateTo(e.target.value)} />
            </div>
          </>
        ) : (
          <>
            <div className="ds-filter-group">
              <label>السنة</label>
              <MultiSelectDropdown
                options={YEARS.map(y => ({ value: y, label: y }))}
                selected={selectedYears} onChange={setSelectedYears}
                multiLabel={n => `${n} سنوات`} />
            </div>
            <div className="ds-filter-group">
              <label>الشهر</label>
              <MultiSelectDropdown
                options={MONTHS.map(([v, l]) => ({ value: v, label: l }))}
                selected={selectedMonths} onChange={setSelectedMonths}
                multiLabel={n => `${n} أشهر`} />
            </div>
          </>
        )}

        <div className="ds-filter-group">
          <label>المنطقة</label>
          <RegionMultiSelect
            branches={allBranches}
            selected={branchNames}
            onChange={next => { setBranchNames(next); setRepName(''); }}
          />
        </div>
        <div className="ds-filter-group">
          <label>المندوب</label>
          <select value={repName} onChange={e => setRepName(e.target.value)}>
            <option value="">جميع المناديب</option>
            {repOptions.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
          </select>
        </div>

        {(branchNames.length > 0 || repName) && (
          <button className="ds-btn ds-btn--ghost" onClick={() => { setBranchNames([]); setRepName(''); }}>
            ✕ إعادة تعيين
          </button>
        )}
      </div>

      {rangeInvalid && (
        <div className="ds-error">نطاق التاريخ غير صحيح — «إلى» قبل «من».</div>
      )}

      {isAdmin && (
        <DiscountShopCustomerListPanel onUploaded={() => {
          qc.invalidateQueries({ queryKey: ['ds-summary'] });
          qc.invalidateQueries({ queryKey: ['ds-overview'] });
          qc.invalidateQueries({ queryKey: ['ds-item-matrix'] });
          qc.invalidateQueries({ queryKey: ['ds-item-overview'] });
          qc.invalidateQueries({ queryKey: ['ds-customer-matrix'] });
          qc.invalidateQueries({ queryKey: ['ds-chicken-baseline'] });
          qc.invalidateQueries({ queryKey: ['ds-incentive-baseline'] });
          qc.invalidateQueries({ queryKey: ['ds-filters'] });
        }} />
      )}

      {/* ── Loading / Error ─────────────────────────────── */}
      {isLoading && (
        <div className="ds-loading"><div className="ds-spinner"/><span>جاري التحميل…</span></div>
      )}
      {isError && !isLoading && (
        <div className="ds-error">حدث خطأ في تحميل البيانات — يرجى المحاولة مجدداً.</div>
      )}

      {d && !isLoading && (
        <>
          {/* ── Period badge ──────────────────────────────── */}
          <div className="ds-period">
            <span className="ds-period__cur">{periodLabel}</span>
            {!useDateRange && <span className="ds-period__vs">مقارنةً بـ</span>}
            {!useDateRange && <span className="ds-period__prev">{prevMonthName}</span>}
            <span className="ds-period__wd">· أيام العمل: {d.meta.working_days_cur}</span>
          </div>

          {/* ══════════════════════════════════════════════
              KPI ROW 1 — Sales Performance
          ══════════════════════════════════════════════ */}
          <div className="ds-section-title">مؤشرات المبيعات</div>
          <div className="ds-kpi-row">
            <KpiCard big
              icon="📦" accent="blue"
              label="إجمالي الكمية"
              value={fmt(cur?.total_qty)}
              sub={`الشهر الماضي: ${fmt(prev?.total_qty)}`}
              deviation={dev?.qty_pct}
            />
            <KpiCard big
              icon="📅" accent="blue"
              label="المتوسط اليومي"
              value={fmt(cur?.daily_avg, 1)}
              sub={`الشهر الماضي: ${fmt(prev?.daily_avg, 1)}`}
              deviation={dev?.daily_avg_pct}
            />
            <KpiCard big
              icon="🏷️" accent="purple"
              label="متوسط الكمية / عميل"
              value={fmt(cur?.avg_per_customer, 1)}
              sub={`${fmt(cur?.active_customers)} عميل نشط`}
            />
            <KpiCard big
              icon="↩️" accent="orange"
              label="نسبة المرتجعات"
              value={`${fmt(cur?.returns_pct, 1)}%`}
              sub={`الكمية: ${fmt(cur?.total_returns)} · الشهر الماضي: ${fmt(prev?.returns_pct, 1)}%`}
              deviation={dev?.returns_delta}
              invertDev
            />
          </div>

          {/* ══════════════════════════════════════════════
              KPI ROW 2 — Customer Movement
          ══════════════════════════════════════════════ */}
          <div className="ds-section-title">حركة العملاء</div>
          <div className="ds-kpi-row">
            <KpiCard
              icon="✅" accent="green"
              label="العملاء المتعاملون"
              value={fmt(cur?.active_customers)}
              sub={`الشهر الماضي: ${fmt(prev?.active_customers)}`}
              deviation={dev?.customers_pct}
            />
            <KpiCard
              icon="🆕" accent="blue"
              label="عملاء جدد"
              value={fmt(cur?.new_customers)}
              sub={`أول ظهور في ${monthsLabel}`}
            />
            <KpiCard
              icon="⛔" accent="red"
              label="عملاء متوقفون"
              value={fmt(cur?.stopped_customers)}
              sub={`كانوا نشطين في ${prevMonthName}`}
            />
            <KpiCard
              icon="⚪" accent="muted"
              label="كمية صفر أو سالبة"
              value={fmt(cur?.inactive_customers)}
              sub="لديهم فواتير بكمية ≤ 0"
            />
          </div>

          {/* ══════════════════════════════════════════════
              Trend Chart + Comparison Table
          ══════════════════════════════════════════════ */}
          <div className="ds-section-title">الاتجاه الشهري — {yearsLabel}</div>
          <div className="ds-twin-grid">
            {/* Trend chart */}
            <div className="ds-card">
              <div className="ds-card__title">مقارنة المبيعات والمرتجعات شهرياً</div>
              <TrendChart trend={d.trend} highlight={month} />
            </div>

            {/* Month-over-month comparison table */}
            <div className="ds-card">
              <div className="ds-card__title">
                المقارنة الشهرية — {monthName} vs {prevMonthName}
              </div>
              <div className="ds-cmp">
                <div className="ds-cmp-head">
                  <span></span>
                  <span>{monthName}</span>
                  <span>{prevMonthName}</span>
                  <span>الانحراف</span>
                </div>
                <CmpRow
                  label="إجمالي الكمية"
                  curVal={fmt(cur?.total_qty)}
                  prevVal={fmt(prev?.total_qty)}
                  pct={dev?.qty_pct}
                />
                <CmpRow
                  label="المتوسط اليومي"
                  curVal={fmt(cur?.daily_avg, 1)}
                  prevVal={fmt(prev?.daily_avg, 1)}
                  pct={dev?.daily_avg_pct}
                />
                <CmpRow
                  label="المرتجعات"
                  curVal={fmt(cur?.total_returns)}
                  prevVal={fmt(prev?.total_returns)}
                  pct={cur?.total_returns != null && prev?.total_returns != null && prev.total_returns > 0
                    ? +((cur.total_returns - prev.total_returns) / prev.total_returns * 100).toFixed(1)
                    : null}
                  invert
                />
                <CmpRow
                  label="نسبة المرتجعات %"
                  curVal={`${fmt(cur?.returns_pct, 1)}%`}
                  prevVal={`${fmt(prev?.returns_pct, 1)}%`}
                  pct={dev?.returns_delta}
                  invert
                />
                <CmpRow
                  label="العملاء النشطون"
                  curVal={fmt(cur?.active_customers)}
                  prevVal={fmt(prev?.active_customers)}
                  pct={dev?.customers_pct}
                />
              </div>

              {/* Achievement indicator */}
              {dev?.qty_pct != null && (
                <div className={`ds-achievement${dev.qty_pct >= 0 ? ' ds-achievement--pos' : ' ds-achievement--neg'}`}>
                  {dev.qty_pct >= 10  && '🚀 نمو ممتاز'}
                  {dev.qty_pct >= 0 && dev.qty_pct < 10 && '✅ أداء مستقر'}
                  {dev.qty_pct < 0 && dev.qty_pct >= -10 && '⚠️ تراجع طفيف'}
                  {dev.qty_pct < -10 && '🔴 تراجع ملحوظ — يحتاج متابعة'}
                  <span className="ds-achievement__num">
                    {dev.qty_pct >= 0 ? '+' : ''}{dev.qty_pct}% عن الشهر الماضي
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ══════════════════════════════════════════════
              Tabs
          ══════════════════════════════════════════════ */}
          <div className="ds-tabs ds-no-print">
            {[
              ['general',  'نظرة عامة'],
              ['regions',  'المناطق'],
              ['reps',     'المناديب'],
              ['customers','العملاء'],
              ['items',    'أداء الأصناف'],
              ['chicken_promo', 'سيناريو مجانيات 10+1 (دجاج مبرد)'],
              ['incentive_promo', 'سيناريو حافز % من المبيعات'],
              ['incentive_monthly', 'صافي المبيعات الشهري للعملاء'],
              ['contract', 'طباعة عقد عميل'],
            ].map(([k, l]) => (
              <button
                key={k}
                className={`ds-tab${activeTab === k ? ' ds-tab--active' : ''}`}
                onClick={() => setActiveTab(k)}
              >{l}</button>
            ))}
          </div>

          {/* ══════════════════════════════════════════════
              TAB: General overview — whole-period performance
          ══════════════════════════════════════════════ */}
          {activeTab === 'general' && (
            <div className="ds-tab-content">
              {isOverviewLoading && (
                <div className="ds-loading"><div className="ds-spinner"/><span>جاري التحميل…</span></div>
              )}
              {isOverviewError && !isOverviewLoading && (
                <div className="ds-error">حدث خطأ في تحميل النظرة العامة.</div>
              )}
              {overview && !isOverviewLoading && (
                <>
                  <div className="ds-period">
                    <span className="ds-period__cur">
                      {overview.period.filter_applied ? 'الفترة المحددة' : 'كامل الفترة'}: {overview.period.from_year} — {overview.period.to_year}
                    </span>
                    <span className="ds-period__wd">· {overview.period.months_count} شهر بيانات</span>
                  </div>

                  <div className="ds-kpi-row ds-kpi-row--overview">
                    <KpiCard big icon="📦" accent="blue"
                      label={`إجمالي الكمية (${overview.period.filter_applied ? 'الفترة المحددة' : 'كل الفترة'})`}
                      value={fmt(overview.totals.total_qty)}
                      sub={overview.totals.qty_share_pct != null
                        ? `الحصة من إجمالي المبيعات: ${fmt(overview.totals.qty_share_pct, 2)}%`
                        : 'لا توجد مبيعات عامة لهذه الفترة'} />
                    <KpiCard big icon="↩️" accent="orange"
                      label="إجمالي المرتجعات"
                      value={fmt(overview.totals.total_returns)}
                      sub={`نسبة المرتجعات: ${fmt(overview.totals.returns_pct, 1)}%`} />
                    <KpiCard big icon="🧾" accent="purple"
                      label="عدد الفواتير المدخلة"
                      value={fmt(overview.totals.invoice_count)} />
                    <KpiCard big icon="✅" accent="green"
                      label="العملاء المتعاملون"
                      value={fmt(overview.totals.active_customers)}
                      sub={overview.period.filter_applied ? 'عبر الفترة المحددة' : 'عبر كامل الفترة'} />
                    <KpiCard big icon="💰" accent="green"
                      label={`صافي الإيرادات (${overview.period.filter_applied ? 'الفترة المحددة' : 'كل الفترة'})`}
                      value={`${fmt(overview.totals.net_revenue)} ر.س`}
                      sub={overview.totals.revenue_share_pct != null
                        ? `الحصة من إجمالي المبيعات: ${fmt(overview.totals.revenue_share_pct, 2)}%`
                        : 'لا توجد مبيعات عامة لهذه الفترة'} />
                  </div>
                  <div className="ds-chicken-meta ds-overview-company-note">
                    <span>
                      إجمالي المبيعات العامة لنفس الفترة/الفرع: <strong>{fmt(overview.totals.company_total_qty)}</strong> كمية ·{' '}
                      <strong>{fmt(overview.totals.company_total_revenue)} ر.س</strong>
                    </span>
                  </div>

                  {overview.best_branch && (
                    <div className="ds-best-branch">
                      <span className="ds-best-branch__crown">🏆</span>
                      <div className="ds-best-branch__body">
                        <div className="ds-best-branch__lbl">أفضل فرع أداءً</div>
                        <div className="ds-best-branch__name">{overview.best_branch.branch_name}</div>
                      </div>
                      <div className="ds-best-branch__stats">
                        <span><strong>{fmt(overview.best_branch.total_qty)}</strong> كمية</span>
                        <span><strong>{fmt(overview.best_branch.invoice_count)}</strong> فاتورة</span>
                        <span><strong>{fmt(overview.best_branch.active_customers)}</strong> عميل</span>
                      </div>
                    </div>
                  )}

                  {/* ── Insight card: quick highlights + admin comment ── */}
                  {branchInsights && (
                    <div className="ds-card ds-insight-card">
                      <div className="ds-card__title">💡 Insight — نظرة سريعة</div>
                      <div className="ds-insight-grid">
                        <div className="ds-insight-item ds-insight-item--pos">
                          <span className="ds-insight-icon">📈</span>
                          <div>
                            <div className="ds-insight-lbl">أفضل فرع مبيعاً</div>
                            <div className="ds-insight-val">{branchInsights.bestSales.branch_name}</div>
                            <div className="ds-insight-sub">{fmt(branchInsights.bestSales.total_qty)} كمية</div>
                          </div>
                        </div>
                        <div className="ds-insight-item ds-insight-item--neg">
                          <span className="ds-insight-icon">📉</span>
                          <div>
                            <div className="ds-insight-lbl">أقل فرع مبيعاً</div>
                            <div className="ds-insight-val">{branchInsights.worstSales.branch_name}</div>
                            <div className="ds-insight-sub">{fmt(branchInsights.worstSales.total_qty)} كمية</div>
                          </div>
                        </div>
                        <div className="ds-insight-item ds-insight-item--neg">
                          <span className="ds-insight-icon">↩️</span>
                          <div>
                            <div className="ds-insight-lbl">أكثر فرع مرتجعات</div>
                            <div className="ds-insight-val">{branchInsights.mostReturns.branch_name}</div>
                            <div className="ds-insight-sub">{fmt(branchInsights.mostReturns.total_returns)} مرتجعات</div>
                          </div>
                        </div>
                        <div className="ds-insight-item ds-insight-item--pos">
                          <span className="ds-insight-icon">✅</span>
                          <div>
                            <div className="ds-insight-lbl">أقل فرع مرتجعات (توالف)</div>
                            <div className="ds-insight-val">{branchInsights.leastReturns.branch_name}</div>
                            <div className="ds-insight-sub">{fmt(branchInsights.leastReturns.total_returns)} مرتجعات</div>
                          </div>
                        </div>
                      </div>

                      {/* ── Admin free-text comment ── */}
                      <div className="ds-insight-note">
                        <div className="ds-insight-note__lbl">ملاحظة الإدارة</div>
                        {isAdmin ? (
                          <>
                            <textarea
                              className="ds-insight-note__input"
                              rows={3}
                              placeholder="اكتب تعليقاً أو نقاطاً حول أداء هذا الشهر…"
                              value={insightNoteText}
                              onChange={e => setInsightNoteDraft(e.target.value)}
                            />
                            <div className="ds-insight-note__actions">
                              <button
                                type="button" className="ds-btn ds-btn--outline"
                                disabled={insightNoteSaving || insightNoteDraft === null}
                                onClick={saveInsightNote}
                              >
                                {insightNoteSaving ? 'جارٍ الحفظ…' : '💾 حفظ الملاحظة'}
                              </button>
                              {insightNoteDraft !== null && (
                                <button
                                  type="button" className="ds-btn ds-btn--ghost"
                                  onClick={() => setInsightNoteDraft(null)}
                                >إلغاء</button>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="ds-insight-note__readonly">
                            {insightNoteText ? insightNoteText : <span className="ds-dash">لا توجد ملاحظات بعد</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="ds-card">
                    <div className="ds-card__title">ترند الأداء الشهري لكامل الفترة — المبيعات والمرتجعات</div>
                    <TrendChart trend={overview.trend} labelKey="label" />
                  </div>

                  {/* ── Branch × month matrix: qty, returns & revenue heatmap ── */}
                  {overviewMatrix && (
                    <div className="ds-card">
                      <div className="ds-card__title ds-card__title--with-filters">
                        <span>مصفوفة الأداء الشهري لكامل الفترة حسب المنطقة — مبيعات ومرتجعات وإيرادات</span>
                        <span className="ds-metric-toggle">
                          <button type="button"
                            className={`ds-metric-btn${regionMatrixMetrics.qty ? ' ds-metric-btn--active ds-metric-btn--qty' : ''}`}
                            onClick={() => toggleRegionMatrixMetric('qty')}>المبيعات</button>
                          <button type="button"
                            className={`ds-metric-btn${regionMatrixMetrics.revenue ? ' ds-metric-btn--active ds-metric-btn--revenue' : ''}`}
                            onClick={() => toggleRegionMatrixMetric('revenue')}>الإيرادات</button>
                          <button type="button"
                            className={`ds-metric-btn${regionMatrixMetrics.returns ? ' ds-metric-btn--active ds-metric-btn--returns' : ''}`}
                            onClick={() => toggleRegionMatrixMetric('returns')}>المرتجعات</button>
                        </span>
                      </div>
                      <div className="ds-matrix-wrap">
                        <table className="ds-matrix-table">
                          <thead>
                            <tr>
                              <th className="ds-matrix-th-item">المنطقة</th>
                              {MONTHS.map(([mn, ml]) => (
                                <th key={mn} className="ds-matrix-th-month">{ml}</th>
                              ))}
                              <th className="ds-matrix-th-total">الإجمالي</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overviewMatrix.branches.map(br => {
                              const rowTotal = overviewMatrix.branchTotals[br];
                              return (
                                <tr key={br}>
                                  <td className="ds-matrix-td-item">{br}</td>
                                  {MONTHS.map(([mn]) => {
                                    const cell = overviewMatrix.cellByBranchMonth[`${br}-${mn}`];
                                    const qty = cell?.total_qty || 0;
                                    const returns = cell?.total_returns || 0;
                                    const revenue = cell?.net_revenue || 0;
                                    const intensity = overviewMatrix.maxQty > 0 ? qty / overviewMatrix.maxQty : 0;
                                    const bg = qty > 0 ? `rgba(59,130,246,${0.08 + intensity * 0.55})` : 'transparent';
                                    const showQty     = regionMatrixMetrics.qty && qty > 0;
                                    const showReturns = regionMatrixMetrics.returns && returns > 0;
                                    const showRevenue = regionMatrixMetrics.revenue && revenue > 0;
                                    return (
                                      <td key={mn} className="ds-matrix-td-cell" style={{ background: bg }}>
                                        {showQty && <span className="ds-matrix-qty">{fmt(qty)}</span>}
                                        {showReturns && <span className="ds-matrix-ret">↩{fmt(returns)}</span>}
                                        {showRevenue && <span className="ds-matrix-rev">{fmt(revenue)} ر.س</span>}
                                        {!showQty && !showReturns && !showRevenue && <span className="ds-matrix-dash">—</span>}
                                      </td>
                                    );
                                  })}
                                  <td className="ds-matrix-td-total">
                                    {regionMatrixMetrics.qty && <span className="ds-matrix-qty">{fmt(rowTotal.total_qty)}</span>}
                                    {regionMatrixMetrics.returns && rowTotal.total_returns > 0 && <span className="ds-matrix-ret">↩{fmt(rowTotal.total_returns)}</span>}
                                    {regionMatrixMetrics.revenue && rowTotal.net_revenue > 0 && <span className="ds-matrix-rev">{fmt(rowTotal.net_revenue)} ر.س</span>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="ds-matrix-tf-row">
                              <td className="ds-matrix-td-item ds-matrix-td-item--tf">الإجمالي</td>
                              {overviewMatrix.colTotals.map((col, i) => (
                                <td key={i} className="ds-matrix-td-total">
                                  {regionMatrixMetrics.qty && <span className="ds-matrix-qty">{fmt(col.total_qty)}</span>}
                                  {regionMatrixMetrics.returns && col.total_returns > 0 && <span className="ds-matrix-ret">↩{fmt(col.total_returns)}</span>}
                                  {regionMatrixMetrics.revenue && col.net_revenue > 0 && <span className="ds-matrix-rev">{fmt(col.net_revenue)} ر.س</span>}
                                </td>
                              ))}
                              <td className="ds-matrix-td-total ds-matrix-td-grand">
                                {regionMatrixMetrics.qty && <span className="ds-matrix-qty">{fmt(overviewMatrix.grandTotal.total_qty)}</span>}
                                {regionMatrixMetrics.returns && overviewMatrix.grandTotal.total_returns > 0 && <span className="ds-matrix-ret">↩{fmt(overviewMatrix.grandTotal.total_returns)}</span>}
                                {regionMatrixMetrics.revenue && overviewMatrix.grandTotal.net_revenue > 0 && <span className="ds-matrix-rev">{fmt(overviewMatrix.grandTotal.net_revenue)} ر.س</span>}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  )}

                  <div className="ds-card">
                    <div className="ds-card__title">أفضل الفروع (مرتبة حسب الكمية)</div>
                    <HBar rows={overview.by_branch} valueKey="total_qty" labelKey="branch_name" colorClass="ds-bar--primary" />
                  </div>

                  <div className="ds-table-wrap">
                    {(() => {
                      const grandQty = overview.by_branch.reduce((s, b) => s + Number(b.total_qty || 0), 0);
                      return (
                        <table className="ds-table">
                          <thead>
                            <tr>
                              <th style={{width:32}}>#</th>
                              <th>الفرع</th>
                              <th>الكمية</th>
                              <th>نسبة الحصة</th>
                              <th>العملاء</th>
                              <th>عدد الفواتير</th>
                              <th>المرتجعات</th>
                              <th>نسبة المرتجعات</th>
                            </tr>
                          </thead>
                          <tbody>
                            {overview.by_branch.map((b, i) => {
                              const sharePct = grandQty > 0 ? (Number(b.total_qty || 0) / grandQty) * 100 : 0;
                              return (
                                <tr key={b.branch_name}>
                                  <td className="ds-td-rank">{i === 0 ? '🏆' : i + 1}</td>
                                  <td className="ds-td-name">{b.branch_name}</td>
                                  <td className="ds-td-num ds-td-bold">{fmt(b.total_qty)}</td>
                                  <td className="ds-td-num">{sharePct.toFixed(1)}%</td>
                                  <td className="ds-td-num">{fmt(b.active_customers)}</td>
                                  <td className="ds-td-num">{fmt(b.invoice_count)}</td>
                                  <td className="ds-td-num">{b.total_returns > 0 ? <span className="ds-ret-badge">{fmt(b.total_returns)}</span> : <span className="ds-dash">—</span>}</td>
                                  <td className="ds-td-num">{b.returns_pct > 0 ? <span className="ds-ret-pct">{b.returns_pct}%</span> : <span className="ds-dash">—</span>}</td>
                                </tr>
                              );
                            })}
                            {overview.by_branch.length === 0 && <tr><td colSpan={8} className="ds-empty">لا توجد بيانات</td></tr>}
                          </tbody>
                          {overview.by_branch.length > 0 && (() => {
                            const sum = (key) => overview.by_branch.reduce((s, b) => s + Number(b[key] || 0), 0);
                            const totalReturns = sum('total_returns');
                            // Overall returns rate = total returns ÷ total qty (weighted),
                            // not a simple average of each branch's own percentage.
                            const pct = grandQty > 0 ? (totalReturns / grandQty) * 100 : 0;
                            return (
                              <tfoot>
                                <tr className="ds-tfoot-row">
                                  <td></td>
                                  <td className="ds-td-name ds-td-bold">الإجمالي</td>
                                  <td className="ds-td-num ds-td-bold">{fmt(grandQty)}</td>
                                  <td className="ds-td-num ds-td-bold">100%</td>
                                  <td className="ds-td-num ds-td-bold">{fmt(sum('active_customers'))}</td>
                                  <td className="ds-td-num ds-td-bold">{fmt(sum('invoice_count'))}</td>
                                  <td className="ds-td-num ds-td-bold">{fmt(totalReturns)}</td>
                                  <td className="ds-td-num ds-td-bold">{pct.toFixed(1)}%</td>
                                </tr>
                              </tfoot>
                            );
                          })()}
                        </table>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Regions
          ══════════════════════════════════════════════ */}
          {activeTab === 'regions' && (
            <div className="ds-tab-content">
              <div className="ds-twin-grid">
                <div className="ds-card">
                  <div className="ds-card__title">الكمية حسب المنطقة</div>
                  <HBar rows={d.by_region} valueKey="total_qty" labelKey="branch_name" colorClass="ds-bar--primary" />
                </div>
                <div className="ds-card">
                  <div className="ds-card__title">المرتجعات حسب المنطقة</div>
                  <HBar rows={d.by_region} valueKey="total_returns" labelKey="branch_name" colorClass="ds-bar--danger" />
                </div>
              </div>

              <div className="ds-table-wrap">
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th>المنطقة</th>
                      <th>الكمية</th>
                      <th>الشهر الماضي</th>
                      <th>الانحراف</th>
                      <th>العملاء</th>
                      <th>المرتجعات</th>
                      <th>نسبة المرتجعات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.by_region.map((r, i) => {
                      const dv = r.prev_qty > 0 ? +((r.total_qty - r.prev_qty) / r.prev_qty * 100).toFixed(1) : null;
                      return (
                        <tr key={i}>
                          <td className="ds-td-name">{r.branch_name}</td>
                          <td className="ds-td-num ds-td-bold">{fmt(r.total_qty)}</td>
                          <td className="ds-td-num ds-td-muted">{fmt(r.prev_qty)}</td>
                          <td className="ds-td-num"><Dev pct={dv} size="sm" /></td>
                          <td className="ds-td-num">{fmt(r.active_customers)}</td>
                          <td className="ds-td-num">{r.total_returns > 0 ? <span className="ds-ret-badge">{fmt(r.total_returns)}</span> : <span className="ds-dash">—</span>}</td>
                          <td className="ds-td-num">{r.returns_pct > 0 ? <span className="ds-ret-pct">{r.returns_pct}%</span> : <span className="ds-dash">—</span>}</td>
                        </tr>
                      );
                    })}
                    {d.by_region.length === 0 && <tr><td colSpan={7} className="ds-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Reps
          ══════════════════════════════════════════════ */}
          {activeTab === 'reps' && (
            <div className="ds-tab-content">
              <div className="ds-twin-grid">
                <div className="ds-card">
                  <div className="ds-card__title">الكمية حسب المندوب (أعلى 10)</div>
                  <HBar rows={[...d.by_rep].sort((a,b)=>b.total_qty-a.total_qty).slice(0,10)}
                        valueKey="total_qty" labelKey="salesrep_name" colorClass="ds-bar--accent" />
                </div>
                <div className="ds-card">
                  <div className="ds-card__title">المرتجعات حسب المندوب (أعلى 10)</div>
                  <HBar rows={[...d.by_rep].sort((a,b)=>b.total_returns-a.total_returns).slice(0,10)}
                        valueKey="total_returns" labelKey="salesrep_name" colorClass="ds-bar--danger" />
                </div>
              </div>

              <div className="ds-table-wrap">
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th style={{width:32}}>#</th>
                      <th>المندوب</th>
                      <th>المنطقة</th>
                      <Th col="total_qty"        sortCol={repSort.col} sortDir={repSort.dir} onSort={handleRepSort}>الكمية</Th>
                      <Th col="prev_qty"         sortCol={repSort.col} sortDir={repSort.dir} onSort={handleRepSort}>الشهر الماضي</Th>
                      <th>الانحراف</th>
                      <Th col="active_customers" sortCol={repSort.col} sortDir={repSort.dir} onSort={handleRepSort}>العملاء</Th>
                      <Th col="total_returns"    sortCol={repSort.col} sortDir={repSort.dir} onSort={handleRepSort}>المرتجعات</Th>
                      <Th col="returns_pct"      sortCol={repSort.col} sortDir={repSort.dir} onSort={handleRepSort}>نسبة المرتجعات</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedReps.map((r, i) => {
                      const rank = [...d.by_rep].sort((a,b)=>b[repSort.col]-a[repSort.col]).findIndex(x=>x.salesrep_name===r.salesrep_name)+1;
                      const dv = r.prev_qty > 0 ? +((r.total_qty - r.prev_qty) / r.prev_qty * 100).toFixed(1) : null;
                      return (
                        <tr key={r.salesrep_name}>
                          <td className="ds-td-rank">{rank}</td>
                          <td className="ds-td-name">{r.salesrep_name}</td>
                          <td className="ds-td-muted" style={{fontSize:'0.74rem'}}>{r.branch_name}</td>
                          <td className="ds-td-num ds-td-bold">{fmt(r.total_qty)}</td>
                          <td className="ds-td-num ds-td-muted">{fmt(r.prev_qty)}</td>
                          <td className="ds-td-num"><Dev pct={dv} size="sm" /></td>
                          <td className="ds-td-num">{fmt(r.active_customers)}</td>
                          <td className="ds-td-num">{r.total_returns > 0 ? <span className="ds-ret-badge">{fmt(r.total_returns)}</span> : <span className="ds-dash">—</span>}</td>
                          <td className="ds-td-num">{r.returns_pct > 0 ? <span className="ds-ret-pct">{r.returns_pct}%</span> : <span className="ds-dash">—</span>}</td>
                        </tr>
                      );
                    })}
                    {sortedReps.length === 0 && <tr><td colSpan={9} className="ds-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Customers
          ══════════════════════════════════════════════ */}
          {activeTab === 'customers' && (
            <div className="ds-tab-content">
              <div className="ds-cust-meta">
                <span>إجمالي العملاء: <strong>{fmt(d.customers.length)}</strong></span>
                <span>إجمالي الكمية: <strong>{fmt(cur?.total_qty)}</strong></span>
                <span>إجمالي المرتجعات: <strong>{fmt(cur?.total_returns)}</strong></span>
              </div>
              <div className="ds-table-wrap">
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th style={{width:32}}>#</th>
                      <th>اسم العميل</th>
                      <th>المنطقة</th>
                      <th>المندوب</th>
                      <Th col="total_qty"      sortCol={custSort.col} sortDir={custSort.dir} onSort={handleCustSort}>الكمية</Th>
                      <Th col="total_returns"  sortCol={custSort.col} sortDir={custSort.dir} onSort={handleCustSort}>المرتجعات</Th>
                      <Th col="returns_pct"    sortCol={custSort.col} sortDir={custSort.dir} onSort={handleCustSort}>نسبة المرتجعات</Th>
                      <Th col="invoice_count"  sortCol={custSort.col} sortDir={custSort.dir} onSort={handleCustSort}>الفواتير</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCusts.map((c, i) => (
                      <tr key={c.customer_code}
                          className={c.total_qty <= 0 ? 'ds-tr--inactive' : ''}>
                        <td className="ds-td-rank">{i + 1}</td>
                        <td className="ds-td-name">
                          {c.customer_name}
                          <span className="ds-td-code"> ({c.customer_code})</span>
                        </td>
                        <td className="ds-td-muted" style={{fontSize:'0.74rem'}}>{c.branch_name || '—'}</td>
                        <td className="ds-td-muted" style={{fontSize:'0.74rem'}}>{c.salesrep_name || '—'}</td>
                        <td className={`ds-td-num${c.total_qty <= 0 ? ' ds-td-muted' : ' ds-td-bold'}`}>{fmt(c.total_qty)}</td>
                        <td className="ds-td-num">
                          {c.total_returns > 0
                            ? <span className="ds-ret-badge">{fmt(c.total_returns)}</span>
                            : <span className="ds-dash">—</span>}
                        </td>
                        <td className="ds-td-num">
                          {c.returns_pct > 0
                            ? <span className={`ds-ret-pct${c.returns_pct >= 30 ? ' ds-ret-pct--high' : ''}`}>{c.returns_pct}%</span>
                            : <span className="ds-dash">—</span>}
                        </td>
                        <td className="ds-td-num ds-td-muted">{fmt(c.invoice_count)}</td>
                      </tr>
                    ))}
                    {sortedCusts.length === 0 && (
                      <tr><td colSpan={8} className="ds-empty">لا توجد بيانات</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* ── Whole-period matrix: qty/returns/revenue per customer ── */}
              <div className="ds-card" style={{marginTop: 4}}>
                <div className="ds-card__title ds-card__title--with-filters">
                  <span>
                    مصفوفة الأداء الشهري لكامل الفترة حسب العميل — مبيعات ومرتجعات وإيرادات
                    {custMatrix?.items?.length ? ` (أعلى ${custMatrix.items.length} عميلاً حسب الكمية)` : ''}
                  </span>
                  <span className="ds-metric-toggle">
                    <button type="button"
                      className={`ds-metric-btn${custMatrixMetrics.qty ? ' ds-metric-btn--active ds-metric-btn--qty' : ''}`}
                      onClick={() => toggleCustMatrixMetric('qty')}>المبيعات</button>
                    <button type="button"
                      className={`ds-metric-btn${custMatrixMetrics.revenue ? ' ds-metric-btn--active ds-metric-btn--revenue' : ''}`}
                      onClick={() => toggleCustMatrixMetric('revenue')}>الإيرادات</button>
                    <button type="button"
                      className={`ds-metric-btn${custMatrixMetrics.returns ? ' ds-metric-btn--active ds-metric-btn--returns' : ''}`}
                      onClick={() => toggleCustMatrixMetric('returns')}>المرتجعات</button>
                  </span>
                </div>
                {isCustMatrixLoading && (
                  <div className="ds-loading"><div className="ds-spinner"/><span>جاري التحميل…</span></div>
                )}
                {isCustMatrixError && !isCustMatrixLoading && (
                  <div className="ds-error">حدث خطأ في تحميل مصفوفة العملاء.</div>
                )}
                {custMatrix && custMatrixTotals && !isCustMatrixLoading && (
                  <div className="ds-matrix-wrap">
                    <table className="ds-matrix-table">
                      <thead>
                        <tr>
                          <th className="ds-matrix-th-item">العميل</th>
                          <th className="ds-matrix-th-month">المنطقة</th>
                          {MONTHS.map(([mn, ml]) => (
                            <th key={mn} className="ds-matrix-th-month">{ml}</th>
                          ))}
                          <th className="ds-matrix-th-total">الإجمالي</th>
                        </tr>
                      </thead>
                      <tbody>
                        {custMatrix.items.map(it => (
                          <tr key={it.customer_code}>
                            <td className="ds-matrix-td-item" title={it.customer_code}>{it.customer_name}</td>
                            <td className="ds-matrix-td-cell ds-matrix-td-branch">{it.branch_name}</td>
                            {it.months.map(mo => {
                              const intensity = custMatrix.max_qty > 0 ? mo.qty / custMatrix.max_qty : 0;
                              const bg = mo.qty > 0 ? `rgba(59,130,246,${0.08 + intensity * 0.55})` : 'transparent';
                              const showQty     = custMatrixMetrics.qty && mo.qty > 0;
                              const showReturns = custMatrixMetrics.returns && mo.returns > 0;
                              const showRevenue = custMatrixMetrics.revenue && mo.revenue > 0;
                              return (
                                <td key={mo.month} className="ds-matrix-td-cell" style={{ background: bg }}>
                                  {showQty && <span className="ds-matrix-qty">{fmt(mo.qty)}</span>}
                                  {showReturns && <span className="ds-matrix-ret">↩{fmt(mo.returns)}</span>}
                                  {showRevenue && <span className="ds-matrix-rev">{fmt(mo.revenue)} ر.س</span>}
                                  {!showQty && !showReturns && !showRevenue && <span className="ds-matrix-dash">—</span>}
                                </td>
                              );
                            })}
                            <td className="ds-matrix-td-total">
                              {custMatrixMetrics.qty && <span className="ds-matrix-qty">{fmt(it.annual_qty)}</span>}
                              {custMatrixMetrics.returns && it.annual_returns > 0 && <span className="ds-matrix-ret">↩{fmt(it.annual_returns)}</span>}
                              {custMatrixMetrics.revenue && it.annual_revenue > 0 && <span className="ds-matrix-rev">{fmt(it.annual_revenue)} ر.س</span>}
                            </td>
                          </tr>
                        ))}
                        {(!custMatrix.items || custMatrix.items.length === 0) && (
                          <tr><td colSpan={15} className="ds-empty">لا توجد بيانات</td></tr>
                        )}
                      </tbody>
                      {custMatrix.items.length > 0 && (
                        <tfoot>
                          <tr className="ds-matrix-tf-row">
                            <td className="ds-matrix-td-item ds-matrix-td-item--tf">الإجمالي</td>
                            <td className="ds-matrix-td-cell"></td>
                            {custMatrixTotals.colTotals.map((col, i) => (
                              <td key={i} className="ds-matrix-td-total">
                                {custMatrixMetrics.qty && <span className="ds-matrix-qty">{fmt(col.qty)}</span>}
                                {custMatrixMetrics.returns && col.returns > 0 && <span className="ds-matrix-ret">↩{fmt(col.returns)}</span>}
                                {custMatrixMetrics.revenue && col.revenue > 0 && <span className="ds-matrix-rev">{fmt(col.revenue)} ر.س</span>}
                              </td>
                            ))}
                            <td className="ds-matrix-td-total ds-matrix-td-grand">
                              {custMatrixMetrics.qty && <span className="ds-matrix-qty">{fmt(custMatrixTotals.grandTotal.qty)}</span>}
                              {custMatrixMetrics.returns && custMatrixTotals.grandTotal.returns > 0 && <span className="ds-matrix-ret">↩{fmt(custMatrixTotals.grandTotal.returns)}</span>}
                              {custMatrixMetrics.revenue && custMatrixTotals.grandTotal.revenue > 0 && <span className="ds-matrix-rev">{fmt(custMatrixTotals.grandTotal.revenue)} ر.س</span>}
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Items — monthly sales/returns by item
          ══════════════════════════════════════════════ */}
          {activeTab === 'items' && (
            <div className="ds-tab-content">
              <div className="ds-cust-meta">
                <span>إجمالي الأصناف: <strong>{fmt(d.by_item.length)}</strong></span>
                <span>إجمالي الكمية: <strong>{fmt(cur?.total_qty)}</strong></span>
                <span>إجمالي المرتجعات: <strong>{fmt(cur?.total_returns)}</strong></span>
              </div>

              <div className="ds-twin-grid">
                <div className="ds-card">
                  <div className="ds-card__title">🏆 أهم الأصناف مبيعاً (أعلى 10)</div>
                  <HBar rows={topItems} valueKey="total_qty" labelKey="item_name" colorClass="ds-bar--primary" />
                </div>
                <div className="ds-card">
                  <div className="ds-card__title">⚠️ أقل الأصناف مبيعاً (أدنى 10)</div>
                  <HBar rows={bottomItems} valueKey="total_qty" labelKey="item_name" colorClass="ds-bar--danger" />
                </div>
              </div>

              {/* ── Same cards again, but summing the whole period (every
                   year present) instead of just the selected month ── */}
              {isItemOverviewLoading && (
                <div className="ds-loading"><div className="ds-spinner"/><span>جاري التحميل…</span></div>
              )}
              {isItemOverviewError && !isItemOverviewLoading && (
                <div className="ds-error">حدث خطأ في تحميل إجمالي الأصناف لكامل الفترة.</div>
              )}
              {itemOverview && !isItemOverviewLoading && (
                <div className="ds-twin-grid">
                  <div className="ds-card">
                    <div className="ds-card__title">🏆 أهم الأصناف مبيعاً (كامل الفترة — أعلى 10)</div>
                    <HBar rows={topItemsAllTime} valueKey="total_qty" labelKey="item_name" colorClass="ds-bar--primary" />
                  </div>
                  <div className="ds-card">
                    <div className="ds-card__title">⚠️ أقل الأصناف مبيعاً (كامل الفترة — أدنى 10)</div>
                    <HBar rows={bottomItemsAllTime} valueKey="total_qty" labelKey="item_name" colorClass="ds-bar--danger" />
                  </div>
                </div>
              )}

              <div className="ds-table-wrap">
                <table className="ds-table">
                  <thead>
                    <tr>
                      <th style={{width:32}}>#</th>
                      <th>الصنف</th>
                      <th>الفئة</th>
                      <Th col="total_qty"      sortCol={itemSort.col} sortDir={itemSort.dir} onSort={handleItemSort}>الكمية</Th>
                      <Th col="prev_qty"       sortCol={itemSort.col} sortDir={itemSort.dir} onSort={handleItemSort}>الشهر الماضي</Th>
                      <th>الانحراف</th>
                      <Th col="total_returns"  sortCol={itemSort.col} sortDir={itemSort.dir} onSort={handleItemSort}>المرتجعات</Th>
                      <Th col="returns_pct"    sortCol={itemSort.col} sortDir={itemSort.dir} onSort={handleItemSort}>نسبة المرتجعات</Th>
                      <Th col="invoice_count"  sortCol={itemSort.col} sortDir={itemSort.dir} onSort={handleItemSort}>الفواتير</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedItems.map((it, i) => {
                      const dv = it.prev_qty > 0 ? +((it.total_qty - it.prev_qty) / it.prev_qty * 100).toFixed(1) : null;
                      return (
                        <tr key={`${it.item_name}-${it.item_category}`}
                            className={it.total_qty <= 0 ? 'ds-tr--inactive' : ''}>
                          <td className="ds-td-rank">{i + 1}</td>
                          <td className="ds-td-name">{it.item_name}</td>
                          <td className="ds-td-muted" style={{fontSize:'0.74rem'}}>{it.item_category}</td>
                          <td className={`ds-td-num${it.total_qty <= 0 ? ' ds-td-muted' : ' ds-td-bold'}`}>{fmt(it.total_qty)}</td>
                          <td className="ds-td-num ds-td-muted">{fmt(it.prev_qty)}</td>
                          <td className="ds-td-num"><Dev pct={dv} size="sm" /></td>
                          <td className="ds-td-num">
                            {it.total_returns > 0
                              ? <span className="ds-ret-badge">{fmt(it.total_returns)}</span>
                              : <span className="ds-dash">—</span>}
                          </td>
                          <td className="ds-td-num">
                            {it.returns_pct > 0
                              ? <span className={`ds-ret-pct${it.returns_pct >= 30 ? ' ds-ret-pct--high' : ''}`}>{it.returns_pct}%</span>
                              : <span className="ds-dash">—</span>}
                          </td>
                          <td className="ds-td-num ds-td-muted">{fmt(it.invoice_count)}</td>
                        </tr>
                      );
                    })}
                    {sortedItems.length === 0 && (
                      <tr><td colSpan={9} className="ds-empty">لا توجد بيانات</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* ── Monthly matrix: qty & returns per item, whole year ── */}
              <div className="ds-card" style={{marginTop: 4}}>
                <div className="ds-card__title">
                  مصفوفة الأداء الشهري للأصناف — {year} (أعلى {itemMatrix?.items?.length || 0} صنفاً حسب الكمية السنوية)
                </div>
                {isMatrixLoading && (
                  <div className="ds-loading"><div className="ds-spinner"/><span>جاري التحميل…</span></div>
                )}
                {isMatrixError && !isMatrixLoading && (
                  <div className="ds-error">حدث خطأ في تحميل المصفوفة.</div>
                )}
                {itemMatrix && !isMatrixLoading && (
                  <div className="ds-matrix-wrap">
                    <table className="ds-matrix-table">
                      <thead>
                        <tr>
                          <th className="ds-matrix-th-item">الصنف</th>
                          {Object.entries(itemMatrix.month_names).map(([mn, ml]) => (
                            <th key={mn} className="ds-matrix-th-month">{ml}</th>
                          ))}
                          <th className="ds-matrix-th-total">الإجمالي</th>
                        </tr>
                      </thead>
                      <tbody>
                        {itemMatrix.items.map(it => (
                          <tr key={it.item_name}>
                            <td className="ds-matrix-td-item" title={it.item_category}>{it.item_name}</td>
                            {it.months.map(mo => {
                              const intensity = itemMatrix.max_qty > 0 ? mo.qty / itemMatrix.max_qty : 0;
                              const bg = mo.qty > 0 ? `rgba(59,130,246,${0.08 + intensity * 0.55})` : 'transparent';
                              return (
                                <td key={mo.month} className="ds-matrix-td-cell" style={{ background: bg }}>
                                  {mo.qty > 0
                                    ? <span className="ds-matrix-qty">{fmt(mo.qty)}</span>
                                    : <span className="ds-matrix-dash">—</span>}
                                  {mo.returns > 0 && <span className="ds-matrix-ret">↩{fmt(mo.returns)}</span>}
                                </td>
                              );
                            })}
                            <td className="ds-matrix-td-total">
                              <span className="ds-matrix-qty">{fmt(it.annual_qty)}</span>
                              {it.annual_returns > 0 && <span className="ds-matrix-ret">↩{fmt(it.annual_returns)}</span>}
                            </td>
                          </tr>
                        ))}
                        {(!itemMatrix.items || itemMatrix.items.length === 0) && (
                          <tr><td colSpan={14} className="ds-empty">لا توجد بيانات</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Chilled-chicken 10+1 free-goods promo scenario
          ══════════════════════════════════════════════ */}
          {activeTab === 'chicken_promo' && (
            <div className="ds-tab-content">
              {isChickenLoading && (
                <div className="ds-loading"><div className="ds-spinner"/><span>جاري التحميل…</span></div>
              )}
              {isChickenError && !isChickenLoading && (
                <div className="ds-error">حدث خطأ في تحميل بيانات دجاج مبرد الأساسية.</div>
              )}

              {chickenBaseline && chickenScenario && !isChickenLoading && (
                <>
                  <div className="ds-chicken-meta">
                    <span>الفترة: <strong>{chickenBaseline.meta?.date_range_applied}</strong></span>
                    <span>الأصناف: <strong>{fmt(chickenBaseline.items.length)}</strong></span>
                    <span>العملاء: <strong>{fmt(chickenBaseline.customers.length)}</strong></span>
                  </div>

                  {/* ── Disclaimer — mandatory, always visible ── */}
                  <div className="ds-chicken-disclaimer">
                    ⚠️ الربحية المعروضة هي الأثر الصافي على الإيراد بعد تغطية تكلفة المجانيات
                    (بافتراض 11.75 ريال لكل حبة مجانية)، وليست هامش ربح نهائي — تكلفة المنتج الكاملة
                    (COGS) غير متوفرة في هذا التقرير.
                  </div>

                  {/* ── Controls ── */}
                  <div className="ds-card ds-chicken-controls">
                    <div className="ds-card__title">إعدادات السيناريو</div>
                    <div className="ds-chicken-controls__row">
                      <div className="ds-chicken-field">
                        <label>نسبة النمو المطلوبة %</label>
                        <input
                          type="number" step="0.5" value={growthPct}
                          onChange={e => setGrowthPct(parseFloat(e.target.value) || 0)}
                        />
                      </div>
                      <div className="ds-chicken-field">
                        <label>تكلفة الوحدة المجانية (ر.س)</label>
                        <input
                          type="number" step="0.05" value={freeCostPerUnit}
                          onChange={e => setFreeCostPerUnit(parseFloat(e.target.value) || 0)}
                        />
                      </div>
                      <div className="ds-chicken-field ds-chicken-field--wide">
                        <label>نسبة تغطية التكلفة عبر رفع السعر</label>
                        <div className="ds-chicken-coverage-toggle">
                          {COVERAGE_PRESETS.map(c => (
                            <button
                              key={c} type="button"
                              className={`ds-chicken-cov-btn${coveragePct === c ? ' ds-chicken-cov-btn--active' : ''}`}
                              onClick={() => setCoveragePct(c)}
                            >
                              {c}%{c === 0 ? ' — امتصاص كامل من الهامش' : c === 100 ? ' — استرداد كامل (موصى به)' : ' — استرداد جزئي'}
                            </button>
                          ))}
                        </div>
                      </div>
                      <button type="button" className="ds-btn ds-btn--outline" onClick={handleChickenExport}>
                        📊 تصدير Excel
                      </button>
                    </div>
                  </div>

                  {/* ── Item filter — include/exclude specific SKUs from the
                       scenario itself (narrows the server-side baseline, not
                       just the display) ── */}
                  <div className="ds-card ds-chicken-items-filter">
                    <div className="ds-card__title">
                      فلتر الأصناف
                      <span className="ds-chicken-items-filter__count">
                        {' '}({fmt(chickenMasterItems.length - excludedChickenItems.size)} من {fmt(chickenMasterItems.length)} مُضمّن بالسيناريو)
                      </span>
                    </div>
                    <div className="ds-chicken-items-filter__actions">
                      <button type="button" className="ds-btn ds-btn--outline"
                        onClick={() => setExcludedChickenItems(new Set())}>
                        تضمين الكل
                      </button>
                    </div>
                    <div className="ds-chicken-items-filter__grid">
                      {chickenMasterItems.map(name => {
                        const included = !excludedChickenItems.has(name);
                        return (
                          <label key={name} className={`ds-chicken-item-chip${included ? '' : ' ds-chicken-item-chip--excluded'}`}>
                            <input type="checkbox" checked={included} onChange={() => toggleChickenItem(name)} />
                            <span>{name}</span>
                          </label>
                        );
                      })}
                    </div>
                    {excludedChickenItems.size > 0 && (
                      <div className="ds-chicken-items-filter__note">
                        الأصناف المستبعدة لا تدخل في حساب متوسط أداء العميل ولا في إجمالي المجانيات — تم استبعادها من السيناريو بالكامل، وليس فقط من العرض.
                      </div>
                    )}
                  </div>

                  {/* ── Comparison matrix: growth × coverage ── */}
                  <div className="ds-card">
                    <div className="ds-card__title">مصفوفة المقارنة — نسبة النمو × نسبة التغطية</div>
                    <div className="ds-table-wrap">
                      <table className="ds-table ds-chicken-matrix-table">
                        <thead>
                          <tr>
                            <th>النمو %</th>
                            <th>التغطية %</th>
                            <th>الكمية المجانية</th>
                            <th>تكلفة المجانيات</th>
                            <th>حركة السعر المطلوبة %</th>
                            <th>التكلفة / المبيعات %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {chickenMatrix.map((row, i) => {
                            const active = row.growth === growthPct && row.coverage === coveragePct;
                            return (
                              <tr
                                key={i}
                                className={`ds-chicken-matrix-row${active ? ' ds-chicken-matrix-row--active' : ''}`}
                                onClick={() => {
                                  setGrowthPct(row.growth);
                                  setCoveragePct(row.coverage);
                                  chickenDetailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                }}
                              >
                                <td className="ds-td-num ds-td-bold">{row.growth}%</td>
                                <td className="ds-td-num">{row.coverage}%</td>
                                <td className="ds-td-num">{fmt(row.total_free_qty)}</td>
                                <td className="ds-td-num">{fmt(row.total_free_cost, 2)} ر.س</td>
                                <td className="ds-td-num">{row.blended_required_price_movement_pct.toFixed(2)}%</td>
                                <td className="ds-td-num">{row.total_cost_to_sales_pct.toFixed(2)}%</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* ── Detail: current scenario ── */}
                  <div ref={chickenDetailRef} className="ds-chicken-detail-anchor" />

                  {/* ── Totals strip ── */}
                  <div className="ds-kpi-row">
                    <KpiCard icon="🎁" accent="blue" label="إجمالي الكمية المجانية"
                      value={fmt(chickenScenario.totals.total_free_qty)}
                      sub={`عند نمو ${growthPct}% وتغطية ${coveragePct}%`} />
                    <KpiCard icon="💸" accent="orange" label="إجمالي تكلفة المجانيات"
                      value={`${fmt(chickenScenario.totals.total_free_cost, 2)} ر.س`}
                      sub={`${fmt(freeCostPerUnit, 2)} ر.س / حبة`} />
                    <KpiCard icon="📈" accent="purple" label="حركة السعر المطلوبة (مرجحة)"
                      value={`${chickenScenario.totals.blended_required_price_movement_pct.toFixed(2)}%`} />
                    <KpiCard icon="💰" accent="green" label="إجمالي قيمة المبيعات المطلوبة"
                      value={`${fmt(chickenScenario.totals.total_required_sales_value, 2)} ر.س`} />
                    <KpiCard icon="📊" accent="muted" label="التكلفة / المبيعات"
                      value={`${chickenScenario.totals.total_cost_to_sales_pct.toFixed(2)}%`} />
                    <KpiCard icon="✅" accent="green" label="صافي الأثر على الإيراد"
                      value={`${fmt(chickenScenario.totals.total_net_revenue_impact, 2)} ر.س`}
                      sub="بعد تغطية تكلفة المجانيات" />
                  </div>

                  {/* ── Per-item table ── */}
                  <div className="ds-card">
                    <div className="ds-card__title ds-card__title--with-filters">
                      <span>تفصيل حسب الصنف — دجاج مبرد فقط</span>
                      {Object.keys(chickenAspOverrides).length > 0 && (
                        <button type="button" className="ds-btn ds-btn--outline"
                          onClick={() => setChickenAspOverrides({})}>
                          إرجاع كل الأسعار للافتراضي
                        </button>
                      )}
                    </div>
                    <div className="ds-chicken-items-filter__note">
                      عمود "ASP الحالي" قابل للتعديل — عدّل سعر أي صنف لمحاكاة سيناريو بسعر مختلف، والباقي (ASP المطلوب، حركة السعر، القيمة المطلوبة...) بيتحدث تلقائيًا. اضغط ↺ لإرجاع صنف واحد لسعره الفعلي.
                    </div>
                    <div className="ds-table-wrap">
                      <table className="ds-table">
                        <thead>
                          <tr>
                            <th>الصنف</th>
                            <th>ASP الحالي</th>
                            <th>الكمية المستهدفة</th>
                            <th>الكمية المجانية</th>
                            <th>تكلفة المجانيات</th>
                            <th>ASP المطلوب</th>
                            <th>حركة السعر %</th>
                            <th>قيمة المبيعات المطلوبة</th>
                            <th>التكلفة / المبيعات %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...chickenScenario.perItem].sort((a, b) => b.target_qty - a.target_qty).map(it => (
                            <tr key={it.item_name_en}>
                              <td className="ds-td-name">{it.item_name_en}</td>
                              <td className="ds-td-num">
                                <div className="ds-asp-edit">
                                  <input
                                    type="number" step="0.01" className="ds-inline-input"
                                    value={chickenAspOverrides[it.item_name_en] ?? +it.baseline_asp.toFixed(2)}
                                    onChange={e => setChickenAspOverride(it.item_name_en, e.target.value)}
                                  />
                                  {it.asp_overridden && (
                                    <button type="button" className="ds-asp-reset" title="إرجاع للسعر الفعلي"
                                      onClick={() => resetChickenAspOverride(it.item_name_en)}>
                                      ↺
                                    </button>
                                  )}
                                </div>
                                {it.asp_overridden && (
                                  <div className="ds-asp-baseline">الفعلي: {fmt(it.baseline_asp, 2)}</div>
                                )}
                              </td>
                              <td className="ds-td-num">{fmt(it.target_qty, 1)}</td>
                              <td className="ds-td-num ds-td-bold">{fmt(it.free_qty, 1)}</td>
                              <td className="ds-td-num">{fmt(it.free_cost, 2)}</td>
                              <td className="ds-td-num">{fmt(it.required_new_asp, 4)}</td>
                              <td className="ds-td-num">{it.required_price_movement_pct.toFixed(2)}%</td>
                              <td className="ds-td-num">{fmt(it.required_sales_value, 2)}</td>
                              <td className="ds-td-num">{it.cost_to_sales_pct.toFixed(2)}%</td>
                            </tr>
                          ))}
                          {chickenScenario.perItem.length === 0 && (
                            <tr><td colSpan={9} className="ds-empty">لا توجد بيانات</td></tr>
                          )}
                        </tbody>
                        <tfoot>
                          <tr className="ds-tfoot-row">
                            <td className="ds-td-bold">الإجمالي</td>
                            <td></td>
                            <td className="ds-td-num ds-td-bold">{fmt(chickenScenario.totals.item_target_qty_sum, 1)}</td>
                            <td className="ds-td-num ds-td-bold">{fmt(chickenScenario.totals.item_free_qty_sum, 1)}</td>
                            <td className="ds-td-num ds-td-bold">{fmt(chickenScenario.totals.total_free_cost, 2)}</td>
                            <td></td>
                            <td className="ds-td-num ds-td-bold">{chickenScenario.totals.blended_required_price_movement_pct.toFixed(2)}%</td>
                            <td className="ds-td-num ds-td-bold">{fmt(chickenScenario.totals.total_required_sales_value, 2)}</td>
                            <td className="ds-td-num ds-td-bold">{chickenScenario.totals.total_cost_to_sales_pct.toFixed(2)}%</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>

                  {/* ── Per-customer table ── */}
                  <div className="ds-card">
                    <div className="ds-card__title ds-card__title--with-filters">
                      <span>تفصيل حسب العميل</span>
                      <input
                        type="text" className="ds-chicken-search"
                        placeholder="بحث بالاسم أو الكود…"
                        value={chickenCustSearch}
                        onChange={e => setChickenCustSearch(e.target.value)}
                      />
                    </div>
                    <div className="ds-table-wrap">
                      <table className="ds-table">
                        <thead>
                          <tr>
                            <th style={{width:32}}>#</th>
                            <th>العميل</th>
                            <Th col="active_months"   sortCol={chickenCustSort.col} sortDir={chickenCustSort.dir} onSort={handleChickenCustSort}>أشهر النشاط</Th>
                            <Th col="avg_monthly_qty" sortCol={chickenCustSort.col} sortDir={chickenCustSort.dir} onSort={handleChickenCustSort}>متوسط الكمية الشهري</Th>
                            <Th col="target_qty"      sortCol={chickenCustSort.col} sortDir={chickenCustSort.dir} onSort={handleChickenCustSort}>الكمية المستهدفة</Th>
                            <Th col="free_qty"        sortCol={chickenCustSort.col} sortDir={chickenCustSort.dir} onSort={handleChickenCustSort}>الكمية المجانية</Th>
                            <Th col="free_cost"       sortCol={chickenCustSort.col} sortDir={chickenCustSort.dir} onSort={handleChickenCustSort}>تكلفة المجانيات</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedChickenCusts.map((c, i) => (
                            <tr key={c.customer_code}>
                              <td className="ds-td-rank">{i + 1}</td>
                              <td className="ds-td-name">
                                {c.customer_name}
                                <span className="ds-td-code"> ({c.customer_code})</span>
                              </td>
                              <td className="ds-td-num">{fmt(c.active_months)}</td>
                              <td className="ds-td-num">{fmt(c.avg_monthly_qty, 2)}</td>
                              <td className="ds-td-num">{fmt(c.target_qty, 2)}</td>
                              <td className="ds-td-num ds-td-bold">{fmt(c.free_qty)}</td>
                              <td className="ds-td-num">{fmt(c.free_cost, 2)}</td>
                            </tr>
                          ))}
                          {sortedChickenCusts.length === 0 && (
                            <tr><td colSpan={7} className="ds-empty">لا توجد بيانات</td></tr>
                          )}
                        </tbody>
                        <tfoot>
                          <tr className="ds-tfoot-row">
                            <td></td>
                            <td className="ds-td-bold">الإجمالي</td>
                            <td></td>
                            <td></td>
                            <td className="ds-td-num ds-td-bold">{fmt(chickenScenario.totals.total_target_qty, 1)}</td>
                            <td className="ds-td-num ds-td-bold">{fmt(chickenScenario.totals.total_free_qty)}</td>
                            <td className="ds-td-num ds-td-bold">{fmt(chickenScenario.totals.total_free_cost, 2)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: "% of sales" incentive scenario
          ══════════════════════════════════════════════ */}
          {activeTab === 'incentive_promo' && (
            <div className="ds-tab-content">
              {isIncentiveLoading && (
                <div className="ds-loading"><div className="ds-spinner"/><span>جاري التحميل…</span></div>
              )}
              {isIncentiveError && !isIncentiveLoading && (
                <div className="ds-error">حدث خطأ في تحميل بيانات الأساس لسيناريو الحافز.</div>
              )}

              {incentiveBaseline && incentiveScenario && !isIncentiveLoading && (
                <>
                  <div className="ds-chicken-meta">
                    <span>الفترة: <strong>{incentiveBaseline.meta?.date_range_applied}</strong></span>
                    <span>العملاء: <strong>{fmt(incentiveBaseline.customers.length)}</strong></span>
                  </div>

                  <div className="ds-chicken-disclaimer">
                    ⚠️ الهدف المطلوب لكل عميل = متوسط مبيعاته الشهرية (على الشهور اللي باع فيها فعلاً)
                    × (1 + نسبة النمو المطلوبة). العميل لا يستحق أي حافز إلا بعد الوصول لهذا الهدف —
                    الشرائح أدناه تحدد نسبة الحافز بعد تخطي كل مستوى تحقيق.
                  </div>

                  {/* ── Controls ── */}
                  <div className="ds-card ds-chicken-controls">
                    <div className="ds-card__title">إعدادات السيناريو</div>
                    <div className="ds-chicken-controls__row">
                      <div className="ds-chicken-field">
                        <label>نسبة النمو المطلوبة للهدف %</label>
                        <input
                          type="number" step="0.5" value={incentiveGrowthPct}
                          onChange={e => setIncentiveGrowthPct(parseFloat(e.target.value) || 0)}
                        />
                      </div>
                      <button
                        type="button" className="ds-btn ds-btn--primary" disabled={savingIncentiveSettings}
                        onClick={handleSaveIncentiveSettings}
                      >
                        {savingIncentiveSettings ? '⏳ جارٍ الحفظ…' : '💾 حفظ الإعدادات'}
                      </button>
                      <button type="button" className="ds-btn ds-btn--outline" onClick={handleIncentiveExport}>
                        📊 تصدير Excel
                      </button>
                    </div>
                    {incentiveSettingsJustSaved && (
                      <div className="ds-contract-saved-note">✅ تم حفظ الإعدادات — ستبقى محفوظة لكل المستخدمين حتى تعديلها مجددًا.</div>
                    )}
                    {incentiveSettingsSaveError && <div className="ds-error">{incentiveSettingsSaveError}</div>}
                    {!incentiveSettingsJustSaved && incentiveSettingsSavedAt && (
                      <div className="ds-hint">آخر حفظ: {new Date(incentiveSettingsSavedAt).toLocaleString('ar-SA')}</div>
                    )}
                  </div>

                  {/* ── Incentive tiers — editable ── */}
                  <div className="ds-card">
                    <div className="ds-card__title">شرائح الحافز</div>
                    <div className="ds-table-wrap">
                      <table className="ds-table">
                        <thead>
                          <tr>
                            <th>نسبة تحقيق الهدف % (من)</th>
                            <th>نسبة الحافز %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {incentiveTiers.map((t, i) => (
                            <tr key={i}>
                              <td>
                                <input type="number" step="1" value={t.minPct}
                                  onChange={e => updateIncentiveTier(i, 'minPct', e.target.value)}
                                  className="ds-inline-input" />
                                %
                              </td>
                              <td>
                                <input type="number" step="0.5" value={t.rate}
                                  onChange={e => updateIncentiveTier(i, 'rate', e.target.value)}
                                  className="ds-inline-input" />
                                %
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="ds-chicken-items-filter__note">
                      دون تحقيق أول شريحة (100% من الهدف)، لا يستحق العميل أي حافز.
                    </div>
                    <button
                      type="button" className="ds-btn ds-btn--primary" disabled={savingIncentiveSettings}
                      onClick={handleSaveIncentiveSettings} style={{ marginTop: 10 }}
                    >
                      {savingIncentiveSettings ? '⏳ جارٍ الحفظ…' : '💾 حفظ الشرائح'}
                    </button>
                  </div>

                  {/* ── Totals ── */}
                  <div className="ds-kpi-row">
                    <KpiCard big icon="📦" accent="purple"
                      label="صافي الكميات المباعة (الفترة المحددة)"
                      value={fmt(incentiveScenario.totals.total_net_qty)}
                      sub={`الكمية المستهدفة (بنفس نسبة النمو): ${fmt(incentiveScenario.totals.total_target_qty)}`} />
                    <KpiCard big icon="🎯" accent="blue"
                      label="إجمالي المبيعات المستهدفة (كل العملاء)"
                      value={`${fmt(incentiveScenario.totals.total_target_revenue)} ر.س`} />
                    <KpiCard big icon="💵" accent="orange"
                      label="إجمالي الحافز عند تحقيق الهدف فقط (100%)"
                      value={`${fmt(incentiveScenario.totals.total_incentive_at_target)} ر.س`}
                      sub={`نسبة التكلفة: ${fmt(incentiveScenario.totals.cost_pct_at_target, 2)}%`} />
                    <KpiCard big icon="🚀" accent="green"
                      label="إجمالي الحافز التقديري عند تحقيق 125%"
                      value={`${fmt(incentiveScenario.totals.total_incentive_at_stretch)} ر.س`}
                      sub={`نسبة التكلفة: ${fmt(incentiveScenario.totals.cost_pct_at_stretch, 2)}%`} />
                  </div>

                  {/* ── Per-customer table ── */}
                  <div className="ds-card">
                    <div className="ds-card__title ds-card__title--with-filters">
                      <span>الهدف المطلوب لكل عميل</span>
                      <input
                        type="text" className="ds-chicken-search"
                        placeholder="بحث بالاسم أو الكود…"
                        value={incentiveCustSearch}
                        onChange={e => setIncentiveCustSearch(e.target.value)}
                      />
                    </div>
                    <div className="ds-table-wrap">
                      <table className="ds-table">
                        <thead>
                          <tr>
                            <th onClick={() => handleIncentiveCustSort('customer_name')}>العميل</th>
                            <th onClick={() => handleIncentiveCustSort('active_months')}>أشهر النشاط</th>
                            <th onClick={() => handleIncentiveCustSort('total_qty')}>صافي الكمية المباعة</th>
                            <th onClick={() => handleIncentiveCustSort('target_qty')}>الكمية المستهدفة</th>
                            <th onClick={() => handleIncentiveCustSort('avg_monthly_revenue')}>متوسط المبيعات الشهري</th>
                            <th onClick={() => handleIncentiveCustSort('target_revenue')}>الهدف المطلوب للاستحقاق</th>
                            <th>الحافز عند الهدف (100%)</th>
                            <th>الحافز التقديري عند 125%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedIncentiveCusts.map(c => (
                            <tr key={c.customer_code}>
                              <td>{c.customer_name}</td>
                              <td className="ds-td-num">{fmt(c.active_months)}</td>
                              <td className="ds-td-num">{fmt(c.total_qty)}</td>
                              <td className="ds-td-num">{fmt(c.target_qty, 1)}</td>
                              <td className="ds-td-num">{fmt(c.avg_monthly_revenue, 2)} ر.س</td>
                              <td className="ds-td-num ds-td-bold">{fmt(c.target_revenue, 2)} ر.س</td>
                              <td className="ds-td-num">{fmt(c.incentive_at_target, 2)} ر.س ({fmt(c.rate_at_target,1)}%)</td>
                              <td className="ds-td-num">{fmt(c.incentive_at_stretch, 2)} ر.س ({fmt(c.rate_at_stretch,1)}%)</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td colSpan={2} className="ds-td-bold">الإجمالي</td>
                            <td className="ds-td-num ds-td-bold">{fmt(incentiveScenario.totals.total_net_qty)}</td>
                            <td className="ds-td-num ds-td-bold">{fmt(incentiveScenario.totals.total_target_qty, 1)}</td>
                            <td></td>
                            <td className="ds-td-num ds-td-bold">{fmt(incentiveScenario.totals.total_target_revenue, 2)} ر.س</td>
                            <td className="ds-td-num ds-td-bold">{fmt(incentiveScenario.totals.total_incentive_at_target, 2)} ر.س</td>
                            <td className="ds-td-num ds-td-bold">{fmt(incentiveScenario.totals.total_incentive_at_stretch, 2)} ر.س</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: صافي المبيعات الشهري للعملاء
          ══════════════════════════════════════════════ */}
          {activeTab === 'incentive_monthly' && (
            <div className="ds-tab-content">
              {isIncentiveLoading && (
                <div className="ds-loading"><div className="ds-spinner"/><span>جاري التحميل…</span></div>
              )}
              {isIncentiveError && !isIncentiveLoading && (
                <div className="ds-error">حدث خطأ في تحميل بيانات المبيعات الشهرية.</div>
              )}

              {incentiveBaseline && !isIncentiveLoading && (
                <>
                  <div className="ds-chicken-meta">
                    <span>الفترة: <strong>{incentiveBaseline.meta?.date_range_applied}</strong></span>
                    <span>العملاء: <strong>{fmt(incentiveBaseline.customers.length)}</strong></span>
                    <span>عدد الأشهر: <strong>{fmt(monthlyMonths.length)}</strong></span>
                  </div>

                  <div className="ds-chicken-disclaimer">
                    ⚠️ نفس مجموعة العملاء والفترة المستخدمة في تبويب "سيناريو حافز % من المبيعات" —
                    هنا موزّعة شهرًا بشهر بدل إجمالي واحد للفترة كلها، كمية وقيمة معًا. شهر بلا مبيعات
                    لعميل معيّن يظهر "—".
                  </div>

                  <div className="ds-card">
                    <div className="ds-card__title ds-card__title--with-filters">
                      <span>صافي المبيعات الشهري لكل عميل</span>
                      <input
                        type="text" className="ds-chicken-search"
                        placeholder="بحث بالاسم أو الكود…"
                        value={monthlyCustSearch}
                        onChange={e => setMonthlyCustSearch(e.target.value)}
                      />
                      <button type="button" className="ds-btn ds-btn--outline" onClick={handleMonthlyExport}>
                        📊 تصدير Excel
                      </button>
                    </div>
                    {!monthlyMonths.length ? (
                      <div className="ds-empty">لا توجد بيانات مبيعات لهذه الفترة</div>
                    ) : (
                      <div className="ds-table-wrap">
                        <table className="ds-table ds-table--monthly">
                          <thead>
                            <tr>
                              <th onClick={() => handleMonthlySort('customer_name')}>العميل</th>
                              {monthlyMonths.map(m => (
                                <th key={m.key}>{MONTH_AR[m.month]}{monthlyMonths.some(x => x.year !== m.year) ? ` ${m.year}` : ''}</th>
                              ))}
                              <th onClick={() => handleMonthlySort('total_qty')}>إجمالي الكمية</th>
                              <th onClick={() => handleMonthlySort('total_revenue')}>إجمالي القيمة</th>
                              <th onClick={() => handleMonthlySort('avg_monthly_qty')}>متوسط الفترة</th>
                            </tr>
                          </thead>
                          <tbody>
                            {monthlyCustomers.map(c => (
                              <tr key={c.customer_code}>
                                <td>
                                  <div className="ds-td-bold">{c.customer_name}</div>
                                  <div className="ds-monthly-code">{c.customer_code}</div>
                                </td>
                                {monthlyMonths.map(m => {
                                  const cell = c.by_month?.[m.key];
                                  return (
                                    <td key={m.key} className="ds-td-num">
                                      {cell ? (
                                        <div className="ds-monthly-cell">
                                          <span className="ds-monthly-qty">{fmt(cell.qty)}</span>
                                          <span className="ds-monthly-rev">{fmt(cell.revenue, 2)} ر.س</span>
                                        </div>
                                      ) : <span className="ds-monthly-dash">—</span>}
                                    </td>
                                  );
                                })}
                                <td className="ds-td-num ds-td-bold">{fmt(c.total_qty)}</td>
                                <td className="ds-td-num ds-td-bold">{fmt(c.total_revenue, 2)} ر.س</td>
                                <td className="ds-td-num">
                                  <div className="ds-monthly-cell">
                                    <span className="ds-monthly-qty">{fmt(c.avg_monthly_qty, 1)}</span>
                                    <span className="ds-monthly-rev">{fmt(c.avg_monthly_revenue, 2)} ر.س</span>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr>
                              <td className="ds-td-bold">الإجمالي</td>
                              {monthlyMonths.map(m => {
                                const q = monthlyCustomers.reduce((s, c) => s + (c.by_month?.[m.key]?.qty || 0), 0);
                                const v = monthlyCustomers.reduce((s, c) => s + (c.by_month?.[m.key]?.revenue || 0), 0);
                                return (
                                  <td key={m.key} className="ds-td-num ds-td-bold">
                                    <div className="ds-monthly-cell">
                                      <span className="ds-monthly-qty">{fmt(q)}</span>
                                      <span className="ds-monthly-rev">{fmt(v, 2)} ر.س</span>
                                    </div>
                                  </td>
                                );
                              })}
                              <td className="ds-td-num ds-td-bold">{fmt(monthlyCustomers.reduce((s, c) => s + c.total_qty, 0))}</td>
                              <td className="ds-td-num ds-td-bold">{fmt(monthlyCustomers.reduce((s, c) => s + c.total_revenue, 0), 2)} ر.س</td>
                              <td></td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ══════════════════════════════════════════════
              TAB: Customer contract print
          ══════════════════════════════════════════════ */}
          {activeTab === 'contract' && (
            <div className="ds-tab-content ds-no-print">
              {isIncentiveLoading && (
                <div className="ds-loading"><div className="ds-spinner"/><span>جاري التحميل…</span></div>
              )}
              {isIncentiveError && !isIncentiveLoading && (
                <div className="ds-error">حدث خطأ في تحميل بيانات العملاء.</div>
              )}

              {incentiveScenario && !isIncentiveLoading && (
                <>
                  <div className="ds-chicken-disclaimer">
                    ⚠️ يعتمد هذا العقد على نفس نسبة النمو وشرائح الحافز المضبوطة حالياً في تبويب
                    «سيناريو حافز % من المبيعات» — عدّلها من هناك أولاً إن أردت تغييرها قبل الطباعة.
                    الهدف الشهري المطبوع = متوسط الكمية أو قيمة المبيعات الشهرية الفعلية للعميل (حسب
                    الأساس المختار أدناه)، وشرائح الجدول محسوبة من الهدف المطلوب (100%/110%/125%)
                    بنفس أرقام تلك التبويب.
                  </div>

                  <div className="ds-card">
                    <div className="ds-card__title">اختيار العميل</div>
                    <div className="ds-chicken-controls__row">
                      <div className="ds-chicken-field">
                        <label>بحث بالاسم أو الكود</label>
                        <input
                          type="text" className="ds-chicken-search"
                          placeholder="ابحث عن عميل من القائمة المضافة…"
                          value={contractCustSearch}
                          onChange={e => setContractCustSearch(e.target.value)}
                        />
                      </div>
                      <div className="ds-chicken-field">
                        <label>العميل</label>
                        <select value={contractCustCode} onChange={e => setContractCustCode(e.target.value)}>
                          <option value="">— اختر عميلاً —</option>
                          {contractCustOptions.map(c => (
                            <option key={c.customer_code} value={c.customer_code}>
                              {custDisplayName(c)} ({c.customer_code}){c.no_sales_data ? ' — بدون مبيعات في الفترة الحالية' : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="ds-chicken-field">
                        <label>أساس الهدف والشرائح</label>
                        <select value={contractBasis} onChange={e => setContractBasis(e.target.value)}>
                          <option value="qty">الكمية (حبة)</option>
                          <option value="revenue">قيمة المبيعات (ر.س)</option>
                        </select>
                      </div>
                      <button
                        type="button" className="ds-btn ds-btn--primary"
                        disabled={!contractCustomer || savingContract || pendingSaveConfirm}
                        onClick={handleRequestSaveContract}
                      >📝 مراجعة العقد قبل الحفظ</button>
                    </div>
                    {saveContractError && <div className="ds-error">{saveContractError}</div>}
                    {displayedSavedContract && (
                      <div className="ds-contract-saved-note">
                        ✅ تم حفظ العقد بنجاح — رقم العقد <strong>#{displayedSavedContract.contract_no}</strong>
                      </div>
                    )}
                  </div>

                  {printSheetData && (
                    <div className="ds-card ds-contract-preview">
                      <div className="ds-card__title ds-card__title--with-filters">
                        <span>{printTarget ? 'معاينة عقد محفوظ سابقًا' : 'معاينة بيانات العميل بالعقد'}</span>
                        {printTarget && (
                          <div className="ds-chicken-controls__row">
                            <button type="button" className="ds-btn ds-btn--primary" onClick={handlePrintViewedContract}>
                              🖨️ طباعة هذا العقد
                            </button>
                            <button type="button" className="ds-btn ds-btn--outline" onClick={handleClosePreview}>
                              ✖️ إغلاق وعرض العميل الحالي
                            </button>
                          </div>
                        )}
                      </div>
                      {printSheetData.noSalesData && (
                        <div className="ds-contract-saved-note ds-contract-saved-note--info">
                          ⚠️ لا توجد مبيعات مسجّلة لهذا العميل ضمن الفترة/الفلاتر المختارة أعلى الصفحة —
                          الهدف الشهري والشرائح أدناه صفر. وسّع الفترة أو غيّر الفلاتر إن كان له مبيعات
                          فعلية لم تظهر بعد.
                        </div>
                      )}
                      {printTarget && (
                        <div className="ds-contract-saved-note ds-contract-saved-note--info">
                          👁️ تعرض الآن عقدًا محفوظًا سابقًا — رقم العقد <strong>#{printTarget.contract_no}</strong>. لتعديله استخدم زر "تعديل" بسجل العقود أدناه.
                        </div>
                      )}
                      {pendingSaveConfirm && !printTarget && (
                        <div className="ds-contract-saved-note ds-contract-saved-note--confirm">
                          ⚠️ راجع البيانات أدناه جيداً — بعد التأكيد سيُنشأ عقد جديد برقم دائم في السجل ولا يمكن التراجع سوى بحذفه لاحقاً.
                          <div className="ds-chicken-controls__row">
                            <button type="button" className="ds-btn ds-btn--primary" disabled={savingContract} onClick={handleConfirmSaveAndPrint}>
                              {savingContract ? '⏳ جارٍ الحفظ…' : '✅ تأكيد الحفظ والطباعة'}
                            </button>
                            <button type="button" className="ds-btn ds-btn--outline" disabled={savingContract} onClick={handleCancelSaveConfirm}>
                              ❌ إلغاء
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="ds-table-wrap">
                        <table className="ds-table">
                          <tbody>
                            {printSheetData.contractNo != null && (
                              <tr><td>رقم العقد</td><td className="ds-td-bold">#{printSheetData.contractNo}</td></tr>
                            )}
                            <tr><td>اسم العميل (عربي)</td><td className="ds-td-bold">{printSheetData.customerNameAr || '—'}</td></tr>
                            <tr><td>اسم العميل (إنجليزي)</td><td className="ds-td-bold">{printSheetData.customerName}</td></tr>
                            <tr><td>رقم العميل</td><td className="ds-td-bold">{printSheetData.customerCode}</td></tr>
                            <tr><td>الأساس</td><td className="ds-td-bold">{printSheetData.unitLabel === 'ر.س' ? 'قيمة المبيعات (ر.س)' : 'الكمية (حبة)'}</td></tr>
                            <tr><td>الهدف الشهري (متوسط فعلي)</td><td className="ds-td-num ds-td-bold">{fmt(printSheetData.avgValue, printSheetData.decimals)} {printSheetData.unitLabel}</td></tr>
                            {printSheetData.tiers.map((t, i) => (
                              <tr key={i}>
                                <td>الشريحة {t.label}</td>
                                <td className="ds-td-num">
                                  من {fmt(t.from, printSheetData.decimals)} {t.to != null ? `إلى ${fmt(t.to, printSheetData.decimals)}` : 'فأكثر'} {printSheetData.unitLabel} — بونص {fmt(t.rate, 1)}%
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* ── Save log — every contract ever saved, newest first ── */}
                  <div className="ds-card">
                    <div className="ds-card__title ds-card__title--with-filters">
                      <span>سجل العقود المحفوظة</span>
                      <select value={contractLogCustCode} onChange={e => setContractLogCustCode(e.target.value)}>
                        <option value="">كل العملاء</option>
                        {contractCustOptions.map(c => (
                          <option key={c.customer_code} value={c.customer_code}>{custDisplayName(c)} ({c.customer_code})</option>
                        ))}
                      </select>
                      <select value={contractLogRegion} onChange={e => setContractLogRegion(e.target.value)}>
                        <option value="">كل المناطق</option>
                        {contractLogRegionOptions.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                    {isContractLogLoading && (
                      <div className="ds-loading"><div className="ds-spinner"/><span>جاري التحميل…</span></div>
                    )}
                    {!isContractLogLoading && (!contractLog?.contracts?.length ? (
                      <div className="ds-empty">لا توجد عقود محفوظة بعد.</div>
                    ) : !contractLogRowsFiltered.length ? (
                      <div className="ds-empty">لا توجد عقود مطابقة لهذه المنطقة.</div>
                    ) : (
                      <div className="ds-table-wrap">
                        <table className="ds-table">
                          <thead>
                            <tr>
                              <th></th>
                              <th>رقم العقد</th>
                              <th>العميل</th>
                              <th>المنطقة</th>
                              <th>الأساس</th>
                              <th>الهدف الشهري</th>
                              <th>صافي مبيعات الشهر الحالي</th>
                              <th>الحافز المستحق</th>
                              <th>نسبة النمو</th>
                              <th>حُفظ بواسطة</th>
                              <th>تاريخ الحفظ</th>
                              <th>الإجراءات</th>
                            </tr>
                          </thead>
                          <tbody>
                            {contractLogRowsFiltered.map(c => {
                              const unit = c.basis === 'revenue' ? 'ر.س' : 'حبة';
                              const dec = c.basis === 'revenue' ? 2 : 0;
                              const isEditing = editingContractId === c.id;
                              return (
                              <React.Fragment key={c.id}>
                                <tr
                                  className="ds-contract-log-row"
                                  onClick={() => !isEditing && setExpandedContractId(id => id === c.id ? null : c.id)}
                                >
                                  <td className="ds-contract-log-toggle">{expandedContractId === c.id ? '▾' : '▸'}</td>
                                  <td className="ds-td-bold">#{c.contract_no}</td>
                                  <td>{c.customer_name_ar ? `${c.customer_name_ar} / ${c.customer_name}` : c.customer_name} ({c.customer_code})</td>
                                  <td>{c.region_name || '—'}</td>
                                  <td>{c.basis === 'revenue' ? 'قيمة مبيعات' : 'كمية'}</td>
                                  <td className="ds-td-num">{fmt(c.avg_monthly_value, dec)} {unit}</td>
                                  <td className="ds-td-num">
                                    {fmt(c.current_month_value, dec)} {unit}
                                    <div className="ds-muted">{c.current_month_label}</div>
                                    {c.target_value > 0 && (
                                      <Dev pct={((c.current_month_value - c.target_value) / c.target_value) * 100} size="sm" />
                                    )}
                                  </td>
                                  <td>
                                    {c.qualifies ? (
                                      <>
                                        <span className="ds-qualify-badge ds-qualify-badge--yes">✅ مستحق</span>
                                        <div className="ds-muted">
                                          الشريحة {c.achieved_tier?.label} — {fmt(c.bonus_amount, 2)} ر.س
                                        </div>
                                      </>
                                    ) : (
                                      <span className="ds-qualify-badge ds-qualify-badge--no">❌ غير مستحق</span>
                                    )}
                                  </td>
                                  <td className="ds-td-num">{fmt(c.growth_pct, 1)}%</td>
                                  <td>
                                    {c.created_by_name || '—'}
                                    {c.updated_at && <div className="ds-muted">عُدِّل بواسطة {c.updated_by_name || '—'}</div>}
                                  </td>
                                  <td>{new Date(c.created_at).toLocaleString('ar-SA')}</td>
                                  <td onClick={e => e.stopPropagation()}>
                                    <button type="button" className="ds-btn ds-btn--outline ds-btn--sm" onClick={() => handleViewSavedContract(c)}>👁️ عرض</button>
                                    <button type="button" className="ds-btn ds-btn--outline ds-btn--sm" onClick={() => startEditContract(c)}>✏️ تعديل</button>
                                    <button
                                      type="button" className="ds-btn ds-btn--ghost ds-btn--sm"
                                      disabled={deletingContractId === c.id}
                                      onClick={() => handleDeleteContract(c)}
                                    >{deletingContractId === c.id ? '⏳' : '🗑️ حذف'}</button>
                                  </td>
                                </tr>
                                {expandedContractId === c.id && !isEditing && (
                                  <tr className="ds-contract-log-detail-row">
                                    <td colSpan={12}>
                                      <table className="ds-table ds-table--nested">
                                        <thead>
                                          <tr><th>الشريحة</th><th>صافي المسحوبات الشهرية</th><th>البونص المستحق</th></tr>
                                        </thead>
                                        <tbody>
                                          {(c.tiers || []).map((t, i) => (
                                            <tr key={i}>
                                              <td>{t.label}</td>
                                              <td>{t.to != null ? `من ${fmt(t.from, dec)} إلى ${fmt(t.to, dec)} ${unit}` : `من ${fmt(t.from, dec)} ${unit} فأكثر`}</td>
                                              <td>{fmt(t.rate, 1)}%</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </td>
                                  </tr>
                                )}
                                {isEditing && editDraft && (
                                  <tr className="ds-contract-log-detail-row">
                                    <td colSpan={12}>
                                      <div className="ds-contract-edit">
                                        <div className="ds-chicken-controls__row">
                                          <div className="ds-chicken-field">
                                            <label>الأساس</label>
                                            <select
                                              value={editDraft.basis}
                                              onChange={e => setEditDraft(d => ({ ...d, basis: e.target.value }))}
                                            >
                                              <option value="qty">الكمية (حبة)</option>
                                              <option value="revenue">قيمة المبيعات (ر.س)</option>
                                            </select>
                                          </div>
                                          <div className="ds-chicken-field">
                                            <label>الهدف الشهري (متوسط فعلي)</label>
                                            <input
                                              type="number" step="0.01" className="ds-inline-input"
                                              value={editDraft.avg_monthly_value}
                                              onChange={e => updateEditTarget('avg_monthly_value', e.target.value)}
                                            />
                                          </div>
                                          <div className="ds-chicken-field">
                                            <label>نسبة النمو %</label>
                                            <input
                                              type="number" step="0.5" className="ds-inline-input"
                                              value={editDraft.growth_pct}
                                              onChange={e => updateEditTarget('growth_pct', e.target.value)}
                                            />
                                          </div>
                                        </div>
                                        <div className="ds-hint">تعديل "الهدف الشهري" أو "نسبة النمو" يعيد حساب من/إلى لكل الشرائح تلقائياً — الشريحة الأولى تبدأ دائماً من الهدف بعد إضافة نسبة النمو. يمكن تعديل شريحة بعينها يدوياً بعد ذلك دون التأثير على البقية.</div>
                                        <table className="ds-table ds-table--nested">
                                          <thead>
                                            <tr><th>الشريحة</th><th>من</th><th>إلى (فارغ = فأكثر)</th><th>بونص %</th></tr>
                                          </thead>
                                          <tbody>
                                            {editDraft.tiers.map((t, i) => (
                                              <tr key={i}>
                                                <td>{t.label}</td>
                                                <td><input type="number" step="0.01" className="ds-inline-input" value={t.from ?? ''} onChange={e => updateEditTier(i, 'from', e.target.value)} /></td>
                                                <td><input type="number" step="0.01" className="ds-inline-input" value={t.to ?? ''} onChange={e => updateEditTier(i, 'to', e.target.value)} /></td>
                                                <td><input type="number" step="0.5" className="ds-inline-input" value={t.rate ?? ''} onChange={e => updateEditTier(i, 'rate', e.target.value)} /></td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                        {editError && <div className="ds-error">{editError}</div>}
                                        <div className="ds-chicken-controls__row">
                                          <button type="button" className="ds-btn ds-btn--primary" disabled={savingEdit} onClick={() => saveEditContract(c.id)}>
                                            {savingEdit ? '⏳ جارٍ الحفظ…' : '💾 حفظ التعديل'}
                                          </button>
                                          <button type="button" className="ds-btn ds-btn--outline" onClick={cancelEditContract}>إلغاء</button>
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Print-only contract sheet — kept off-screen (display:none)
               until handleConfirmSaveAndPrint / handlePrintViewedContract flag
               <body> with ds-printing-contract; see the @media print rules in
               DiscountShopsPage.css. Independent of the whole-page
               ds-print-header/.ds-no-print print mode used by the other
               tabs, so the two print modes can't clash. ── */}
          {printSheetData && (
            <div className="ds-contract-print-only">
              <div className="ds-contract-doc">
                <div className="ds-contract-doc__brand">
                  <img src="/Logo.png" alt="طرية" className="ds-contract-doc__logo" />
                  <div>
                    <div className="ds-contract-doc__brand-name">شركة ريادة طرية | اتفاق تجاري</div>
                    <div className="ds-contract-doc__brand-sub">اتفاقية تعاون تجاري وحوافز مبيعات | صفحة 1</div>
                  </div>
                </div>

                <h1 className="ds-contract-doc__title">اتفاقية تعاون تجاري وحوافز مبيعات</h1>
                {printSheetData.contractNo != null && (
                  <div className="ds-contract-doc__no">رقم العقد: #{printSheetData.contractNo}</div>
                )}

                <p>
                  إنه في يوم ‎____‎/‎____‎/‎________‎م، تم الاتفاق والتراضي بين كلٍّ من:
                </p>

                <p>
                  <strong>الطرف الأول:</strong> شركة ريادة طرية، سجل تجاري رقم ({COMPANY_CR_NUMBER})، وعنوانها بـ
                  ({COMPANY_ADDRESS})، ويشار إليها لاحقاً بـ«الشركة».
                </p>
                <p>
                  <strong>الطرف الثاني:</strong> مؤسسة/شركة ({printSheetData.customerNameAr || printSheetData.customerName}
                  {printSheetData.customerNameAr ? ` / ${printSheetData.customerName}` : ''})، سجل تجاري رقم
                  (‎____________‎)، ورقم العميل ({printSheetData.customerCode})، ويشار إليها لاحقاً بـ«العميل».
                </p>
                <p>وقد اتفق الطرفان، وهما بكامل الأهلية المعتبرة، على الأحكام الآتية:</p>

                <h2>أولاً: مدة الاتفاقية</h2>
                <p>
                  يبدأ التعامل بموجب هذه الاتفاقية اعتباراً من تاريخ ‎____‎/‎____‎/‎________‎م، وينتهي بتاريخ
                  ‎____‎/‎____‎/‎________‎م، ولا تُمدد إلا بموافقة كتابية من الطرفين.
                </p>

                <h2>ثانياً: الهدف الشهري وشرائح المسحوبات</h2>
                <p>
                  يُحدد الهدف الشهري للعميل بمقدار ({fmt(printSheetData.avgValue, printSheetData.decimals)} {printSheetData.unitLabel})، ويُحتسب صافي
                  المسحوبات الشهرية بعد استبعاد المرتجعات والإشعارات الدائنة والكميات المجانية، وفق الشرائح التالية:
                </p>
                <table className="ds-contract-doc__table">
                  <thead>
                    <tr>
                      <th>الشريحة</th>
                      <th>صافي المسحوبات الشهرية</th>
                      <th>البونص المستحق</th>
                    </tr>
                  </thead>
                  <tbody>
                    {printSheetData.tiers.map((t, i) => (
                      <tr key={i}>
                        <td>{t.label}</td>
                        <td>{t.to != null ? `من ${fmt(t.from, printSheetData.decimals)} إلى ${fmt(t.to, printSheetData.decimals)} ${printSheetData.unitLabel}` : `من ${fmt(t.from, printSheetData.decimals)} ${printSheetData.unitLabel} فأكثر`}</td>
                        <td>{fmt(t.rate, 1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p>
                  يُحتسب البونص وفق أعلى شريحة يحققها العميل خلال الشهر، ولا يجوز الجمع بين أكثر من شريحة عن الشهر
                  نفسه، إلا بموافقة كتابية من الشركة.
                </p>

                <h2>ثالثاً: استحقاق وتسليم البونص</h2>
                <p>
                  يستحق العميل البونص بعد انتهاء الشهر واعتماد صافي المسحوبات من الشركة، بشرط سداد الفواتير المستحقة
                  وعدم وجود مبالغ متأخرة. ويُسلَّم البونص بموجب نموذج «تسليم بضاعة مجانية» موقع من العميل أو ممثله
                  المعتمد، مع مراعاة الإجراءات المحاسبية والضريبية المعمول بها. ولا يجوز تحويل البونص إلى مبلغ نقدي أو
                  خصمه من الفواتير، ويخضع صرفه لتوافر المنتج لدى الشركة.
                </p>

                <h2>رابعاً: السداد وحد الائتمان</h2>
                <p>
                  يكون السداد بنظام «فاتورة مقابل فاتورة»، بحيث تُسدد قيمة كل فاتورة بالكامل قبل إصدار أو توريد
                  الفاتورة التالية، ما لم توافق الشركة كتابةً على خلاف ذلك. ويُحدد الحد الائتماني للعميل بمبلغ
                  (‎____________‎ ريال سعودي)، ولا يجوز تجاوزه. ويحق للشركة إيقاف التوريد أو تعليق البونص عند تجاوز
                  الحد الائتماني أو التأخر في السداد، دون أن يترتب عليها أي مسؤولية.
                </p>

                <h2>خامساً: أحكام عامة</h2>
                <p>
                  تخضع الأسعار والكميات ومواعيد التوريد لسياسة الشركة ومدى توافر المنتجات. ولا يُعتد بأي تعديل على
                  هذه الاتفاقية إلا إذا كان مكتوباً ومعتمداً من الطرفين. وقد حُررت الاتفاقية من نسختين أصليتين، تسلم
                  كل طرف نسخة للعمل بموجبها.
                </p>

                <h2>سادساً: التوقيعات</h2>
                <table className="ds-contract-doc__table ds-contract-doc__table--sign">
                  <thead>
                    <tr>
                      <th>الطرف الأول: شركة رياده طريه</th>
                      <th>الطرف الثاني</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr><td>الاسم: ‎____________________________‎</td><td>الاسم: ‎____________________________‎</td></tr>
                    <tr><td>الصفة: ‎____________________________‎</td><td>الصفة: ‎____________________________‎</td></tr>
                    <tr><td>التوقيع والختم: ‎__________________‎</td><td>التوقيع والختم: ‎__________________‎</td></tr>
                  </tbody>
                </table>

                <div className="ds-contract-doc__footer">اتفاقية تعاون تجاري وحوافز مبيعات | صفحة 1</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
