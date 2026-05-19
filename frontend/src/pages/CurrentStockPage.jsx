import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  RefreshCw, Download, Search, X,
  AlertCircle, Clock, Filter, Warehouse,
  ChevronRight, ChevronDown,
  ChevronsDown, ChevronsUp, Save, BookmarkCheck,
} from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './CurrentStockPage.css';

/* ── Column names (exact from NetSuite) ───────────────────── */
const COL_LOC  = 'Location';
const COL_TYPE = 'Item Type';
const COL_ITEM = 'Item';
const COL_QTY  = 'Ending Inv Qty On-hand';

const SETTING_KEY  = 'matrix_type_filter';
const LS_USER_KEY  = 'csp-mx-types-v1';   // per-user local preference
const ADMIN_ROLES  = ['super_admin', 'it_admin'];

/* ── Helpers ──────────────────────────────────────────────── */
function cleanNum(v) {
  return String(v ?? '').replace(/^=/, '').replace(/,/g, '').trim();
}
function parseQty(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(cleanNum(v));
  return isNaN(n) ? null : n;
}
function fmtNum(v) {
  const n = parseFloat(cleanNum(v));
  if (isNaN(n)) return v || '—';
  return n.toLocaleString('en-SA', { maximumFractionDigits: 2 });
}
function fmtQty(v) {
  if (v === null || v === undefined) return null;
  return Number(v).toLocaleString('en-SA', { maximumFractionDigits: 1 });
}
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ar-SA', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
function isNumericCol(rows, key) {
  const samples = rows.slice(0, 30).map(r => r[key]).filter(v => v && v !== '');
  if (samples.length < 2) return false;
  return samples.filter(v => /^=?[\d,.\-+ ]+$/.test(String(v))).length >= samples.length * 0.8;
}

/* ══════════════════════════════════════════════════════════
   LOCATION → REGION DISPLAY NAME
   ══════════════════════════════════════════════════════════ */
const LOC_OVERRIDES = {
  'التصميم المخزن المركزي': 'شقرا - مخزن مركزي',
};
const SEGMENT_OVERRIDES = {
  'الخرج': 'الرياض',
  'الخرج - المخزن المركزي': 'الرياض',
};
const TYPE_SUFFIXES = [
  { test: 'منتج مواد تغذية وتغليف', remove: / - منتج مواد تغذية وتغليف$/i, keep: ' مواد تغذية' },
  { test: 'منتج دام ميردا',         remove: / - منتج دام ميردا$/i,         keep: '' },
  { test: 'منتج دام',               remove: / - منتج دام$/i,               keep: '' },
  { test: '- منتج',                 remove: / - منتج.*$/i,                  keep: '' },
];

function getRegion(loc) {
  if (!loc) return null;
  const clean = loc.trim();
  if (LOC_OVERRIDES[clean]) return LOC_OVERRIDES[clean];
  const parts   = clean.split(':').map(s => s.trim()).filter(Boolean);
  let   segment = parts[parts.length - 1] || clean;
  for (const { test, remove, keep } of TYPE_SUFFIXES) {
    if (segment.includes(test)) { segment = segment.replace(remove, keep).trim(); break; }
  }
  return SEGMENT_OVERRIDES[segment] ?? segment;
}

/* ── Column detection ────────────────────────────────────── */
function detectTypeCol(headers) {
  return (
    headers.find(h => h.toLowerCase() === 'item type') ||
    headers.find(h => ['نوع', 'type', 'category', 'تصنيف'].some(k => h.toLowerCase().includes(k))) ||
    headers[1] || ''
  );
}
function detectLocCol(headers) {
  return (
    headers.find(h => h.toLowerCase() === 'location') ||
    headers.find(h => ['موقع', 'فرع', 'مقر', 'subsidiary'].some(k => h.toLowerCase().includes(k))) ||
    headers[0] || ''
  );
}
function detectItemCol(headers) {
  return (
    headers.find(h => h.toLowerCase() === 'item') ||
    headers.find(h => ['item', 'صنف', 'product'].some(k =>
      h.toLowerCase().includes(k) && !h.toLowerCase().includes('type'))) ||
    headers[2] || ''
  );
}
function detectQtyCol(headers) {
  return (
    headers.find(h => h.toLowerCase().includes('ending inv')) ||
    headers.find(h => ['qty on-hand', 'on hand', 'كمية', 'مخزون'].some(k => h.toLowerCase().includes(k))) ||
    ''
  );
}

/* ── Skeleton ─────────────────────────────────────────────── */
function Skeleton({ cols = 7, rows = 12 }) {
  return (
    <div className="csp-skeleton-wrap">
      <div className="csp-sk-header">
        {Array.from({ length: cols }, (_, i) => (
          <div key={i} className="csp-sk csp-sk-th" style={{ width: `${60 + (i * 17) % 40}%` }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="csp-sk-row">
          {Array.from({ length: cols }, (_, j) => (
            <div key={j} className="csp-sk" style={{ width: `${50 + ((i * 9 + j * 11) % 45)}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   STOCK MATRIX
   ══════════════════════════════════════════════════════════ */
function StockMatrix({
  rows, locFilter, search,
  typeCol, locCol, itemCol, qtyCol,
  defaultTypes,    // Array|null — from saved global or user preference
  onSaveTypes,     // async (types: Array|null) => void
  userRole,        // string — current user role
}) {
  const isAdmin = ADMIN_ROLES.includes(userRole);

  /* ── Type multi-select ── */
  const [checkedTypes, setCheckedTypes]   = useState(null);
  const [saveStatus,   setSaveStatus]     = useState('idle'); // idle|saving|saved|error

  /* ── Region multi-select ── */
  const [checkedRegions, setCheckedRegions] = useState(null);

  /* ── Table sorting ── */
  const [expanded, setExpanded] = useState(new Set());
  const [sortCol,  setSortCol]  = useState('__total__');
  const [sortDir,  setSortDir]  = useState('desc');

  /* Apply defaultTypes once when first loaded */
  const defaultApplied = useRef(false);
  useEffect(() => {
    if (!defaultApplied.current && defaultTypes !== undefined) {
      if (Array.isArray(defaultTypes) && defaultTypes.length > 0) {
        setCheckedTypes(new Set(defaultTypes));
      }
      defaultApplied.current = true;
    }
  }, [defaultTypes]);

  /* ── All item types in this dataset ── */
  const allTypes = useMemo(() =>
    [...new Set(rows.map(r => r[typeCol]).filter(Boolean))].sort()
  , [rows, typeCol]);

  const activeTypes = checkedTypes === null ? new Set(allTypes) : checkedTypes;

  const toggleType   = type => setCheckedTypes(prev => {
    const cur = prev === null ? new Set(allTypes) : new Set(prev);
    cur.has(type) ? cur.delete(type) : cur.add(type);
    return cur.size === allTypes.length ? null : cur;
  });
  const selectAllTypes  = () => setCheckedTypes(null);
  const clearAllTypes   = () => setCheckedTypes(new Set());

  /* ── Save handler ── */
  const handleSave = async () => {
    const arr = checkedTypes === null ? null : [...checkedTypes];
    setSaveStatus('saving');
    try {
      await onSaveTypes(arr);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2500);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 2500);
    }
  };

  /* ── Build matrix data ── */
  const { regions, typeMap, grandByRegion, grandTotal, maxTypeTotal } = useMemo(() => {
    const q = search?.toLowerCase() || '';
    let filtered = rows;
    if (locFilter) filtered = filtered.filter(r => r[locCol] === locFilter);
    if (checkedTypes !== null && checkedTypes.size > 0)
      filtered = filtered.filter(r => checkedTypes.has(r[typeCol]));
    else if (checkedTypes !== null && checkedTypes.size === 0)
      filtered = [];
    if (q) filtered = filtered.filter(r =>
      Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q))
    );

    const regionSet = new Set();
    filtered.forEach(r => { const reg = getRegion(r[locCol]); if (reg) regionSet.add(reg); });
    const regions = [...regionSet].sort();

    const typeMap    = new Map();
    let maxTypeTotal = 1;

    filtered.forEach(r => {
      const type   = r[typeCol] || '(بدون نوع)';
      const item   = r[itemCol] || '—';
      const region = getRegion(r[locCol]);
      if (!region) return;
      const qty = parseQty(r[qtyCol]) ?? 0;

      if (!typeMap.has(type)) typeMap.set(type, { locTotals: new Map(), items: new Map() });
      const td = typeMap.get(type);
      td.locTotals.set(region, (td.locTotals.get(region) ?? 0) + qty);
      if (!td.items.has(item)) td.items.set(item, new Map());
      const im = td.items.get(item);
      im.set(region, (im.get(region) ?? 0) + qty);
    });

    const grandByRegion = new Map();
    let grandTotal = 0;
    typeMap.forEach(td => {
      td.locTotals.forEach((qty, reg) => {
        grandByRegion.set(reg, (grandByRegion.get(reg) ?? 0) + qty);
        grandTotal += qty;
      });
      const tt = [...td.locTotals.values()].reduce((a, b) => a + b, 0);
      if (tt > maxTypeTotal) maxTypeTotal = tt;
    });

    return { regions, typeMap, grandByRegion, grandTotal, maxTypeTotal };
  }, [rows, locFilter, search, checkedTypes, typeCol, locCol, itemCol, qtyCol]);

  /* ── Region multi-select helpers ── */
  const activeRegions   = checkedRegions === null ? new Set(regions) : checkedRegions;
  const visibleRegions  = regions.filter(r => activeRegions.has(r));

  const toggleRegion    = reg => setCheckedRegions(prev => {
    const cur = prev === null ? new Set(regions) : new Set(prev);
    cur.has(reg) ? cur.delete(reg) : cur.add(reg);
    return cur.size === regions.length ? null : cur;
  });
  const selectAllRegions  = () => setCheckedRegions(null);
  const clearAllRegions   = () => setCheckedRegions(new Set());

  /* ── Sorted types ── */
  const sortedTypes = useMemo(() => {
    return [...typeMap.entries()].sort(([, aD], [, bD]) => {
      if (sortCol === '__total__') {
        const aS = [...aD.locTotals.values()].reduce((s, v) => s + v, 0);
        const bS = [...bD.locTotals.values()].reduce((s, v) => s + v, 0);
        return sortDir === 'desc' ? bS - aS : aS - bS;
      }
      const aV = aD.locTotals.get(sortCol) ?? 0;
      const bV = bD.locTotals.get(sortCol) ?? 0;
      return sortDir === 'desc' ? bV - aV : aV - bV;
    });
  }, [typeMap, sortCol, sortDir]);

  const toggleRow    = type => setExpanded(prev => {
    const n = new Set(prev); n.has(type) ? n.delete(type) : n.add(type); return n;
  });
  const expandAll   = () => setExpanded(new Set(typeMap.keys()));
  const collapseAll = () => setExpanded(new Set());
  const handleColSort = col => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  /* ── Heat-map ── */
  const heatBg = (qty, max) => {
    if (!qty || qty <= 0) return {};
    const ratio   = Math.min(qty / (max || 1), 1);
    const opacity = 0.06 + ratio * 0.55;
    return { background: `rgba(46,125,50,${opacity.toFixed(2)})`,
             color: ratio > 0.6 ? '#fff' : ratio > 0.3 ? '#1b5e20' : 'inherit' };
  };

  /* ── Cell renderer — distinguishes 0-entry vs missing ── */
  const cellVal = (map, reg) => {
    if (!map.has(reg)) return <span className="csp-mx-dash">—</span>;
    const qty = map.get(reg);
    if (qty === 0) return <span className="csp-mx-zero">0</span>;
    return fmtQty(qty);
  };

  const SortIcon = ({ col }) => (
    sortCol !== col
      ? <span className="csp-mx-sort-icon">⇅</span>
      : <span className="csp-mx-sort-icon active">{sortDir === 'desc' ? '↓' : '↑'}</span>
  );

  /* ═══════════════════════ RENDER ═══════════════════════════ */
  return (
    <div className="csp-matrix-section">

      {/* ══ 1. TYPE FILTER CHIPS ══ */}
      {allTypes.length > 0 && (
        <div className="csp-mx-type-filter">
          <span className="csp-mx-type-filter-label">نوع الصنف:</span>

          <button
            className={`csp-mx-type-chip csp-mx-type-chip-all${checkedTypes === null ? ' active' : ''}`}
            onClick={selectAllTypes}
            title="عرض جميع الأنواع"
          >
            الكل
            <span className="csp-mx-type-chip-count">{allTypes.length}</span>
          </button>

          <button
            className={`csp-mx-type-chip csp-mx-type-chip-none${checkedTypes !== null && checkedTypes.size === 0 ? ' active-none' : ''}`}
            onClick={clearAllTypes}
            title="إلغاء تحديد الكل"
          >
            لا شيء
          </button>

          <span className="csp-mx-type-filter-sep" />

          {allTypes.map(type => {
            const isActive = activeTypes.has(type);
            return (
              <button
                key={type}
                className={`csp-mx-type-chip${isActive ? ' active' : ' inactive'}`}
                onClick={() => toggleType(type)}
                title={isActive ? `استثناء: ${type}` : `إضافة: ${type}`}
              >
                {!isActive && <X size={10} style={{ opacity: 0.6, flexShrink: 0 }} />}
                {type}
              </button>
            );
          })}

          {checkedTypes !== null && (
            <span className="csp-mx-type-filter-hint">
              {checkedTypes.size === 0 ? 'لا شيء محدد' : `${checkedTypes.size} من ${allTypes.length}`}
            </span>
          )}

          {/* ── Save button ── */}
          <span className="csp-mx-type-filter-sep" style={{ marginRight: 'auto' }} />
          <button
            className={`csp-mx-save-btn${saveStatus === 'saved' ? ' saved' : saveStatus === 'error' ? ' error' : ''}`}
            onClick={handleSave}
            disabled={saveStatus === 'saving'}
            title={isAdmin ? 'حفظ الاختيارات الحالية كافتراضي لجميع المستخدمين' : 'حفظ اختياراتي الشخصية'}
          >
            {saveStatus === 'saving' && <RefreshCw size={13} className="csp-spin" />}
            {saveStatus === 'saved'  && <BookmarkCheck size={13} />}
            {saveStatus === 'error'  && <AlertCircle size={13} />}
            {saveStatus === 'idle'   && <Save size={13} />}
            <span>
              {saveStatus === 'saved'  ? 'تم الحفظ'
               : saveStatus === 'error' ? 'خطأ في الحفظ'
               : saveStatus === 'saving' ? 'جاري الحفظ…'
               : isAdmin ? 'حفظ للجميع' : 'حفظ تفضيلاتي'
              }
            </span>
            {isAdmin && saveStatus === 'idle' && (
              <span className="csp-mx-save-badge">Admin</span>
            )}
          </button>
        </div>
      )}

      {/* ══ 2. REGION FILTER CHIPS ══ */}
      {regions.length > 1 && (
        <div className="csp-mx-region-filter">
          <span className="csp-mx-type-filter-label">المناطق:</span>

          <button
            className={`csp-mx-reg-chip${checkedRegions === null ? ' active' : ''}`}
            onClick={selectAllRegions}
          >
            الكل
            <span className="csp-mx-type-chip-count">{regions.length}</span>
          </button>

          <button
            className={`csp-mx-reg-chip${checkedRegions !== null && checkedRegions.size === 0 ? ' active-none' : ''}`}
            onClick={clearAllRegions}
          >
            لا شيء
          </button>

          <span className="csp-mx-type-filter-sep" />

          {regions.map(reg => {
            const isActive = activeRegions.has(reg);
            return (
              <button
                key={reg}
                className={`csp-mx-reg-chip${isActive ? ' active' : ' inactive'}`}
                onClick={() => toggleRegion(reg)}
                title={isActive ? `إخفاء: ${reg}` : `إظهار: ${reg}`}
              >
                {!isActive && <X size={10} style={{ opacity: 0.6, flexShrink: 0 }} />}
                {reg}
              </button>
            );
          })}

          {checkedRegions !== null && checkedRegions.size > 0 && (
            <span className="csp-mx-type-filter-hint">
              {`${checkedRegions.size} من ${regions.length} منطقة`}
            </span>
          )}
        </div>
      )}

      {/* ══ 3. TOOLBAR ══ */}
      <div className="csp-matrix-bar">
        <div className="csp-matrix-bar-right">
          <span className="csp-matrix-title">🗂 مصفوفة المخزون — إجمالي الكمية المتاحة</span>
          <span className="csp-matrix-meta">
            {typeMap.size} نوع · {visibleRegions.length} منطقة ظاهرة
            {visibleRegions.length < regions.length && (
              <span style={{ color: 'var(--color-warning, #d97706)', marginRight: 4 }}>
                ({regions.length - visibleRegions.length} مخفية)
              </span>
            )}
          </span>
          {(!typeCol || !locCol || !qtyCol) && (
            <span style={{ fontSize: 10, color: '#c00', fontWeight: 700 }}>
              ⚠ أعمدة: نوع="{typeCol}" موقع="{locCol}" كمية="{qtyCol}"
            </span>
          )}
        </div>
        <div className="csp-matrix-bar-left">
          <button className="csp-mx-ctrl" onClick={expandAll}>
            <ChevronsDown size={14} /> توسيع الكل
          </button>
          <button className="csp-mx-ctrl" onClick={collapseAll}>
            <ChevronsUp size={14} /> طي الكل
          </button>
        </div>
      </div>

      {/* ══ EMPTY STATE ══ */}
      {(!regions.length || !typeMap.size || !visibleRegions.length) && (
        <div className="csp-empty" style={{ padding: '40px 0' }}>
          <Warehouse size={36} />
          <p>
            {checkedTypes !== null && checkedTypes.size === 0
              ? 'اختر نوعاً واحداً على الأقل من شريط الأنواع'
              : checkedRegions !== null && checkedRegions.size === 0
              ? 'اختر منطقة واحدة على الأقل من شريط المناطق'
              : 'لا توجد بيانات للمصفوفة'}
          </p>
        </div>
      )}

      {/* ══ 4. MATRIX TABLE ══ */}
      {regions.length > 0 && typeMap.size > 0 && visibleRegions.length > 0 && (
        <div className="csp-matrix-wrap">
          <table className="csp-matrix-table">
            <thead>
              <tr>
                <th className="csp-mx-th-label">النوع / الصنف</th>
                <th
                  className={`csp-mx-th-total${sortCol === '__total__' ? ' sorted' : ''}`}
                  onClick={() => handleColSort('__total__')}
                >
                  الإجمالي <SortIcon col="__total__" />
                </th>
                {visibleRegions.map(reg => (
                  <th
                    key={reg}
                    className={`csp-mx-th-reg${sortCol === reg ? ' sorted' : ''}`}
                    onClick={() => handleColSort(reg)}
                    title={reg}
                  >
                    <span className="csp-mx-reg-name">{reg}</span>
                    <SortIcon col={reg} />
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {sortedTypes.map(([type, td]) => {
                const isOpen    = expanded.has(type);
                const typeTotal = [...td.locTotals.values()].reduce((a, b) => a + b, 0);
                const sortedItems = [...td.items.entries()].sort(([, aM], [, bM]) => {
                  const aS = [...aM.values()].reduce((a, b) => a + b, 0);
                  const bS = [...bM.values()].reduce((a, b) => a + b, 0);
                  return bS - aS;
                });

                return (
                  <React.Fragment key={type}>
                    {/* Type row */}
                    <tr
                      className={`csp-mx-type-row${isOpen ? ' open' : ''}`}
                      onClick={() => toggleRow(type)}
                    >
                      <td className="csp-mx-td-label">
                        <span className="csp-mx-toggle">
                          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </span>
                        <span className="csp-mx-type-name">{type}</span>
                        <span className="csp-mx-count">({td.items.size})</span>
                      </td>
                      <td className="csp-mx-td-type-total">
                        {typeTotal > 0 ? fmtQty(typeTotal) : <span className="csp-mx-zero">0</span>}
                      </td>
                      {visibleRegions.map(reg => (
                        <td
                          key={reg}
                          className="csp-mx-td-type-cell"
                          style={td.locTotals.has(reg) && (td.locTotals.get(reg) ?? 0) > 0
                            ? heatBg(td.locTotals.get(reg), maxTypeTotal) : {}}
                        >
                          {cellVal(td.locTotals, reg)}
                        </td>
                      ))}
                    </tr>

                    {/* Item rows */}
                    {isOpen && sortedItems.map(([item, itemLocs]) => {
                      const itemTotal = [...itemLocs.values()].reduce((a, b) => a + b, 0);
                      return (
                        <tr key={`${type}__${item}`} className="csp-mx-item-row">
                          <td className="csp-mx-td-item">
                            <span className="csp-mx-item-tree">└</span>
                            <span className="csp-mx-item-name">{item}</span>
                          </td>
                          <td className="csp-mx-td-item-total">
                            {itemTotal > 0 ? fmtQty(itemTotal) : <span className="csp-mx-zero">0</span>}
                          </td>
                          {visibleRegions.map(reg => (
                            <td
                              key={reg}
                              className="csp-mx-td-item-cell"
                              style={itemLocs.has(reg) && (itemLocs.get(reg) ?? 0) > 0
                                ? heatBg(itemLocs.get(reg), maxTypeTotal * 0.4) : {}}
                            >
                              {cellVal(itemLocs, reg)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>

            <tfoot>
              <tr className="csp-mx-grand-row">
                <td className="csp-mx-grand-label">الإجمالي الكلي</td>
                <td className="csp-mx-grand-total">
                  {grandTotal > 0 ? fmtQty(grandTotal) : <span className="csp-mx-zero">0</span>}
                </td>
                {visibleRegions.map(reg => (
                  <td key={reg} className="csp-mx-grand-cell">
                    {cellVal(grandByRegion, reg)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════ */
export default function CurrentStockPage() {
  const { user } = useAuth();
  const userRole = user?.role ?? '';

  const [search,     setSearch]     = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [locFilter,  setLocFilter]  = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [exporting,  setExporting]  = useState(false);

  /* ── Load global saved default from backend ── */
  const { data: globalSetting } = useQuery({
    queryKey: ['settings', SETTING_KEY],
    queryFn:  () => client.get(`/settings/${SETTING_KEY}`).then(r => r.data?.value ?? null),
    staleTime: 30 * 60 * 1000,
  });

  /* ── User's personal preference (localStorage) ── */
  const [localTypes, setLocalTypes] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_USER_KEY);
      if (raw === null) return undefined;  // not set → use global default
      return JSON.parse(raw);              // null (all) or Array
    } catch { return undefined; }
  });

  /* Effective default: local preference > global default > undefined */
  const defaultTypes = localTypes !== undefined ? localTypes : globalSetting;

  /* ── Save handler (passed to StockMatrix) ── */
  const handleSaveTypes = async (types) => {
    const isAdmin = ADMIN_ROLES.includes(userRole);
    if (isAdmin) {
      /* Save to backend (affects all users without personal preference) */
      await client.put(`/settings/${SETTING_KEY}`, { value: types });
    }
    /* Always also save to localStorage for this user */
    if (types === null) {
      localStorage.removeItem(LS_USER_KEY);
      setLocalTypes(undefined); // revert to global default
    } else {
      localStorage.setItem(LS_USER_KEY, JSON.stringify(types));
      setLocalTypes(types);
    }
  };

  /* ── NetSuite data fetch ── */
  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['current-stock', refreshKey],
    queryFn:  () =>
      client.get('/current-stock', { params: refreshKey > 0 ? { refresh: '1' } : {} })
            .then(r => r.data),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const headers = data?.headers ?? [];
  const allRows = data?.rows    ?? [];

  const typeColName = useMemo(() => detectTypeCol(headers), [headers]);
  const locColName  = useMemo(() => detectLocCol(headers),  [headers]);
  const itemColName = useMemo(() => detectItemCol(headers), [headers]);
  const qtyColName  = useMemo(() => detectQtyCol(headers),  [headers]);

  const itemTypes = useMemo(
    () => [...new Set(allRows.map(r => r[typeColName]).filter(Boolean))].sort(),
    [allRows, typeColName]
  );

  const locations = useMemo(
    () => [...new Set(allRows.map(r => r[locColName]).filter(Boolean))].sort(),
    [allRows, locColName]
  );

  const handleRefresh = () => setRefreshKey(k => k + 1);
  const activeFilters = [typeFilter, locFilter, search].filter(Boolean).length;
  const clearFilters  = () => { setTypeFilter(''); setLocFilter(''); setSearch(''); };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await client.get('/current-stock/export', {
        responseType: 'blob',
        params: {
          ...(typeFilter && { type_filter: typeFilter }),
          ...(locFilter  && { loc_filter:  locFilter  }),
          ...(search     && { search }),
        },
      });
      const url  = URL.createObjectURL(res.data);
      const link = document.createElement('a');
      link.href  = url;
      link.download = `current-stock-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export error:', err);
    } finally {
      setExporting(false);
    }
  };

  /* ─────────────────────────── RENDER ────────────────────── */
  return (
    <div className="csp-page">

      {/* ── Page header ── */}
      <div className="csp-header">
        <div className="csp-header-left">
          <div className="csp-icon-wrap"><Warehouse size={20} /></div>
          <div>
            <h1 className="csp-title">المخزون الحالي</h1>
            <div className="csp-meta">
              {data?.stale && <span className="csp-badge csp-badge-warn">⚠ بيانات قديمة</span>}
              {data?.fromCache && !data?.stale && (
                <span className="csp-badge csp-badge-cache"><Clock size={10} /> محفوظ مؤقتاً</span>
              )}
              {data?.fetchedAt && (
                <span className="csp-fetch-time">آخر تحديث: {fmtTime(data.fetchedAt)}</span>
              )}
            </div>
          </div>
        </div>

        <div className="csp-actions">
          <button className="csp-btn csp-btn-secondary" onClick={handleRefresh} disabled={isFetching}>
            <RefreshCw size={14} className={isFetching ? 'csp-spin' : ''} />
            {isFetching ? 'جاري التحديث…' : 'تحديث'}
          </button>

          <button className="csp-btn csp-btn-primary" onClick={handleExport} disabled={!allRows.length || exporting}>
            <Download size={14} className={exporting ? 'csp-spin' : ''} />
            {exporting ? 'جاري التصدير…' : 'تصدير Excel'}
          </button>
        </div>
      </div>

      {/* ── KPI strip ── */}
      {!isLoading && allRows.length > 0 && (
        <div className="csp-kpis">
          <div className="csp-kpi">
            <span className="csp-kpi-val">{allRows.length.toLocaleString('en-SA')}</span>
            <span className="csp-kpi-lbl">إجمالي الأصناف</span>
          </div>
          <div className="csp-kpi">
            <span className="csp-kpi-val">{itemTypes.length}</span>
            <span className="csp-kpi-lbl">أنواع الأصناف</span>
          </div>
          <div className="csp-kpi">
            <span className="csp-kpi-val">
              {[...new Set(allRows.map(r => getRegion(r[locColName])).filter(v => v && v !== '—'))].length}
            </span>
            <span className="csp-kpi-lbl">المناطق</span>
          </div>
          <div className="csp-kpi">
            <span className="csp-kpi-val">{locations.length.toLocaleString('en-SA')}</span>
            <span className="csp-kpi-lbl">المواقع / الفروع</span>
          </div>
        </div>
      )}

      {/* ── Filter bar ── */}
      <div className="csp-filters">
        <div className="csp-search-wrap">
          <Search size={14} className="csp-search-icon" />
          <input
            className="csp-search"
            placeholder="بحث في جميع الحقول…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="csp-input-clear" onClick={() => setSearch('')}><X size={12} /></button>
          )}
        </div>

        <div className="csp-select-wrap">
          <Filter size={13} className="csp-select-icon" />
          <select className="csp-select" value={locFilter} onChange={e => setLocFilter(e.target.value)}>
            <option value="">كل المواقع</option>
            {locations.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>

        {activeFilters > 0 && (
          <button className="csp-clear-btn" onClick={clearFilters}>
            <X size={13} /> مسح الفلاتر ({activeFilters})
          </button>
        )}
      </div>

      {/* ── Active filter chips ── */}
      {activeFilters > 0 && (
        <div className="csp-chips">
          {typeFilter && (
            <span className="csp-chip">النوع: {typeFilter}
              <button onClick={() => setTypeFilter('')}><X size={11} /></button>
            </span>
          )}
          {locFilter && (
            <span className="csp-chip">الموقع: {locFilter}
              <button onClick={() => setLocFilter('')}><X size={11} /></button>
            </span>
          )}
          {search && (
            <span className="csp-chip">بحث: "{search}"
              <button onClick={() => setSearch('')}><X size={11} /></button>
            </span>
          )}
        </div>
      )}

      {/* ── Content ── */}
      {isError ? (
        <div className="csp-error">
          <AlertCircle size={36} />
          <p>تعذّر الاتصال بـ NetSuite</p>
          <span className="csp-error-msg">{error?.response?.data?.error || error?.message}</span>
          <button className="csp-btn csp-btn-secondary" onClick={handleRefresh}>
            <RefreshCw size={14} /> إعادة المحاولة
          </button>
        </div>

      ) : isLoading ? (
        <Skeleton />

      ) : !allRows.length ? (
        <div className="csp-empty">
          <Warehouse size={48} />
          <p>لا توجد بيانات</p>
          <button className="csp-btn csp-btn-secondary" onClick={handleRefresh}>
            <RefreshCw size={14} /> تحديث
          </button>
        </div>

      ) : (
        <StockMatrix
          rows={allRows}
          locFilter={locFilter}
          search={search}
          typeCol={typeColName}
          locCol={locColName}
          itemCol={itemColName}
          qtyCol={qtyColName}
          defaultTypes={defaultTypes}
          onSaveTypes={handleSaveTypes}
          userRole={userRole}
        />
      )}
    </div>
  );
}
