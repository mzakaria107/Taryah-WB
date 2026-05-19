import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  RefreshCw, Download, Search, X,
  AlertCircle, Clock, Filter, Warehouse,
  ChevronRight, ChevronDown, LayoutGrid, List,
  ChevronsDown, ChevronsUp,
} from 'lucide-react';
import client from '../api/client';
import './CurrentStockPage.css';

/* ── Column names (exact from NetSuite) ───────────────────── */
const COL_LOC       = 'Location';
const COL_TYPE      = 'Item Type';
const COL_ITEM      = 'Item';
const COL_QTY       = 'Ending Inv Qty On-hand';

/* ── Helpers ──────────────────────────────────────────────── */
function fmtNum(v) {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  if (isNaN(n)) return v || '—';
  return n.toLocaleString('en-SA', { maximumFractionDigits: 2 });
}

function fmtQty(v) {
  if (v === null || v === undefined || v === 0) return null;
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
  return samples.filter(v => /^[\d,.\-+ ]+$/.test(String(v))).length >= samples.length * 0.8;
}

/* Extract region name: "المقر الرئيسي:الرياض:شقرا - المخزن" → "الرياض" */
function getRegion(loc) {
  if (!loc) return '—';
  const parts = loc.split(':').map(s => s.trim()).filter(Boolean);
  return parts[1] || parts[0] || loc;
}

function detectTypeCol(headers) {
  const kw = ['نوع', 'type', 'category', 'صنف', 'تصنيف'];
  return headers.find(h => kw.some(k => h.toLowerCase().includes(k))) || headers[1] || '';
}
function detectLocCol(headers) {
  const kw = ['location', 'موقع', 'فرع', 'مقر', 'الوحدة', 'subsidiary'];
  return headers.find(h => kw.some(k => h.toLowerCase().includes(k))) || headers[0] || '';
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
   Rows    = Item Type (collapsible) → Items (children)
   Columns = Region names (extracted from Location)
   Cells   = SUM of Ending Inv Qty On-hand
   ══════════════════════════════════════════════════════════ */
function StockMatrix({ rows, typeFilter, locFilter, search }) {
  const [expanded,   setExpanded]   = useState(new Set());
  const [sortCol,    setSortCol]    = useState('__total__');
  const [sortDir,    setSortDir]    = useState('desc');

  /* ── Build matrix data ── */
  const { regions, typeMap, grandByRegion, grandTotal, maxTypeTotal } = useMemo(() => {
    // Apply same filters as table view
    const q = search?.toLowerCase() || '';
    let filtered = rows;
    if (typeFilter) filtered = filtered.filter(r => r[COL_TYPE] === typeFilter);
    if (locFilter)  filtered = filtered.filter(r => r[COL_LOC]  === locFilter);
    if (q) filtered = filtered.filter(r =>
      Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q))
    );

    // Collect unique regions
    const regionSet = new Set();
    filtered.forEach(r => regionSet.add(getRegion(r[COL_LOC])));
    const regions = [...regionSet].sort();

    // typeMap: type → { locTotals: Map<region, qty>, items: Map<item, Map<region, qty>> }
    const typeMap = new Map();
    let maxTypeTotal = 1;

    filtered.forEach(r => {
      const type   = r[COL_TYPE] || '(بدون نوع)';
      const item   = r[COL_ITEM] || '—';
      const region = getRegion(r[COL_LOC]);
      const qty    = parseFloat(String(r[COL_QTY] || '0').replace(/,/g, '')) || 0;

      if (!typeMap.has(type)) {
        typeMap.set(type, { locTotals: new Map(), items: new Map() });
      }
      const td = typeMap.get(type);

      // Type-level totals
      td.locTotals.set(region, (td.locTotals.get(region) || 0) + qty);

      // Item-level totals
      if (!td.items.has(item)) td.items.set(item, new Map());
      const im = td.items.get(item);
      im.set(region, (im.get(region) || 0) + qty);
    });

    // Grand totals per region
    const grandByRegion = new Map();
    let grandTotal = 0;
    typeMap.forEach(td => {
      td.locTotals.forEach((qty, reg) => {
        grandByRegion.set(reg, (grandByRegion.get(reg) || 0) + qty);
        grandTotal += qty;
      });
      // Track max type total for heat coloring
      const tt = [...td.locTotals.values()].reduce((a, b) => a + b, 0);
      if (tt > maxTypeTotal) maxTypeTotal = tt;
    });

    return { regions, typeMap, grandByRegion, grandTotal, maxTypeTotal };
  }, [rows, typeFilter, locFilter, search]);

  /* ── Sorted types ── */
  const sortedTypes = useMemo(() => {
    const entries = [...typeMap.entries()];
    return entries.sort(([aT, aD], [bT, bD]) => {
      if (sortCol === '__total__') {
        const aSum = [...aD.locTotals.values()].reduce((s, v) => s + v, 0);
        const bSum = [...bD.locTotals.values()].reduce((s, v) => s + v, 0);
        return sortDir === 'desc' ? bSum - aSum : aSum - bSum;
      }
      const aV = aD.locTotals.get(sortCol) || 0;
      const bV = bD.locTotals.get(sortCol) || 0;
      return sortDir === 'desc' ? bV - aV : aV - bV;
    });
  }, [typeMap, sortCol, sortDir]);

  /* ── Expand/collapse ── */
  const toggleType = type =>
    setExpanded(prev => {
      const n = new Set(prev);
      n.has(type) ? n.delete(type) : n.add(type);
      return n;
    });
  const expandAll   = () => setExpanded(new Set(typeMap.keys()));
  const collapseAll = () => setExpanded(new Set());

  /* ── Column sort ── */
  const handleColSort = col => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  /* ── Heat-map cell background ── */
  const heatBg = (qty, max) => {
    if (!qty || qty <= 0) return {};
    const ratio   = Math.min(qty / (max || 1), 1);
    const opacity = 0.06 + ratio * 0.55;
    return { background: `rgba(46,125,50,${opacity.toFixed(2)})`,
             color: ratio > 0.6 ? '#fff' : ratio > 0.3 ? '#1b5e20' : 'inherit' };
  };

  if (!regions.length) return (
    <div className="csp-empty" style={{ padding: '40px 0' }}>
      <Warehouse size={36} />
      <p>لا توجد بيانات للمصفوفة</p>
    </div>
  );

  const SortIcon = ({ col }) => {
    if (sortCol !== col) return <span className="csp-mx-sort-icon">⇅</span>;
    return <span className="csp-mx-sort-icon active">{sortDir === 'desc' ? '↓' : '↑'}</span>;
  };

  return (
    <div className="csp-matrix-section">

      {/* ── Matrix toolbar ── */}
      <div className="csp-matrix-bar">
        <div className="csp-matrix-bar-right">
          <span className="csp-matrix-title">
            🗂 مصفوفة المخزون — إجمالي الكمية المتاحة
          </span>
          <span className="csp-matrix-meta">
            {typeMap.size} نوع · {regions.length} منطقة
          </span>
        </div>
        <div className="csp-matrix-bar-left">
          <button className="csp-mx-ctrl" onClick={expandAll}   title="توسيع جميع الأنواع">
            <ChevronsDown size={14} /> توسيع الكل
          </button>
          <button className="csp-mx-ctrl" onClick={collapseAll} title="طي جميع الأنواع">
            <ChevronsUp size={14} /> طي الكل
          </button>
        </div>
      </div>

      {/* ── Matrix table ── */}
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
              {regions.map(reg => (
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

              // Sort items by total descending
              const sortedItems = [...td.items.entries()].sort(([, aM], [, bM]) => {
                const aS = [...aM.values()].reduce((a, b) => a + b, 0);
                const bS = [...bM.values()].reduce((a, b) => a + b, 0);
                return bS - aS;
              });

              return (
                <React.Fragment key={type}>

                  {/* ── Type row (parent) ── */}
                  <tr
                    className={`csp-mx-type-row${isOpen ? ' open' : ''}`}
                    onClick={() => toggleType(type)}
                  >
                    <td className="csp-mx-td-label">
                      <span className="csp-mx-toggle">
                        {isOpen
                          ? <ChevronDown  size={13} />
                          : <ChevronRight size={13} />
                        }
                      </span>
                      <span className="csp-mx-type-name">{type}</span>
                      <span className="csp-mx-count">({td.items.size})</span>
                    </td>
                    <td className="csp-mx-td-type-total">
                      {fmtQty(typeTotal) ?? '—'}
                    </td>
                    {regions.map(reg => {
                      const qty = td.locTotals.get(reg) || 0;
                      return (
                        <td
                          key={reg}
                          className="csp-mx-td-type-cell"
                          style={heatBg(qty, maxTypeTotal)}
                        >
                          {fmtQty(qty) ?? <span className="csp-mx-dash">—</span>}
                        </td>
                      );
                    })}
                  </tr>

                  {/* ── Item rows (children) ── */}
                  {isOpen && sortedItems.map(([item, itemLocs]) => {
                    const itemTotal = [...itemLocs.values()].reduce((a, b) => a + b, 0);
                    return (
                      <tr key={`${type}__${item}`} className="csp-mx-item-row">
                        <td className="csp-mx-td-item">
                          <span className="csp-mx-item-tree">└</span>
                          <span className="csp-mx-item-name">{item}</span>
                        </td>
                        <td className="csp-mx-td-item-total">
                          {fmtQty(itemTotal) ?? '—'}
                        </td>
                        {regions.map(reg => {
                          const qty = itemLocs.get(reg) || 0;
                          return (
                            <td
                              key={reg}
                              className="csp-mx-td-item-cell"
                              style={heatBg(qty, maxTypeTotal * 0.4)}
                            >
                              {fmtQty(qty) ?? <span className="csp-mx-dash">—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>

          {/* ── Grand total footer ── */}
          <tfoot>
            <tr className="csp-mx-grand-row">
              <td className="csp-mx-grand-label">الإجمالي الكلي</td>
              <td className="csp-mx-grand-total">{fmtQty(grandTotal) ?? '—'}</td>
              {regions.map(reg => (
                <td key={reg} className="csp-mx-grand-cell">
                  {fmtQty(grandByRegion.get(reg) || 0) ?? '—'}
                </td>
              ))}
            </tr>
          </tfoot>

        </table>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════ */
export default function CurrentStockPage() {
  const [search,     setSearch]     = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [locFilter,  setLocFilter]  = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [exporting,  setExporting]  = useState(false);
  const [view,       setView]       = useState('matrix'); // 'matrix' | 'table'

  /* ── Data fetch ── */
  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['current-stock', refreshKey],
    queryFn: () =>
      client
        .get('/current-stock', {
          params: refreshKey > 0 ? { refresh: '1' } : {},
        })
        .then(r => r.data),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const headers     = data?.headers ?? [];
  const allRows     = data?.rows    ?? [];

  const typeColName = useMemo(() => detectTypeCol(headers), [headers]);
  const locColName  = useMemo(() => detectLocCol(headers),  [headers]);

  const numericCols = useMemo(
    () => new Set(headers.filter(h => isNumericCol(allRows, h))),
    [headers, allRows]
  );

  const itemTypes = useMemo(
    () => [...new Set(allRows.map(r => r[typeColName]).filter(Boolean))].sort(),
    [allRows, typeColName]
  );

  const locations = useMemo(
    () => [...new Set(allRows.map(r => r[locColName]).filter(Boolean))].sort(),
    [allRows, locColName]
  );

  /* ── Filtered rows (for detail table) ── */
  const filtered = useMemo(() => {
    if (!search && !typeFilter && !locFilter) return allRows;
    const q = search.toLowerCase();
    return allRows.filter(row => {
      if (typeFilter && row[typeColName] !== typeFilter) return false;
      if (locFilter  && row[locColName]  !== locFilter)  return false;
      if (q && !Object.values(row).some(v => String(v ?? '').toLowerCase().includes(q)))
        return false;
      return true;
    });
  }, [allRows, typeFilter, locFilter, search, typeColName, locColName]);

  /* ── Handlers ── */
  const handleRefresh   = () => setRefreshKey(k => k + 1);
  const activeFilters   = [typeFilter, locFilter, search].filter(Boolean).length;
  const clearFilters    = () => { setTypeFilter(''); setLocFilter(''); setSearch(''); };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await client.get('/current-stock/export', {
        responseType: 'blob',
        params: {
          ...(typeFilter && { type_filter: typeFilter }),
          ...(locFilter  && { loc_filter:  locFilter  }),
          ...(search     && { search                  }),
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

  /* ── Render ── */
  return (
    <div className="csp-page">

      {/* ── Page header ── */}
      <div className="csp-header">
        <div className="csp-header-left">
          <div className="csp-icon-wrap">
            <Warehouse size={20} />
          </div>
          <div>
            <h1 className="csp-title">المخزون الحالي</h1>
            <div className="csp-meta">
              {data?.stale && (
                <span className="csp-badge csp-badge-warn">⚠ بيانات قديمة</span>
              )}
              {data?.fromCache && !data?.stale && (
                <span className="csp-badge csp-badge-cache">
                  <Clock size={10} /> محفوظ مؤقتاً
                </span>
              )}
              {data?.fetchedAt && (
                <span className="csp-fetch-time">
                  آخر تحديث: {fmtTime(data.fetchedAt)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="csp-actions">
          {/* View toggle */}
          <div className="csp-view-toggle">
            <button
              className={`csp-view-btn${view === 'matrix' ? ' active' : ''}`}
              onClick={() => setView('matrix')}
              title="عرض المصفوفة"
            >
              <LayoutGrid size={14} /> مصفوفة
            </button>
            <button
              className={`csp-view-btn${view === 'table' ? ' active' : ''}`}
              onClick={() => setView('table')}
              title="عرض الجدول التفصيلي"
            >
              <List size={14} /> جدول
            </button>
          </div>

          <button
            className="csp-btn csp-btn-secondary"
            onClick={handleRefresh}
            disabled={isFetching}
          >
            <RefreshCw size={14} className={isFetching ? 'csp-spin' : ''} />
            {isFetching ? 'جاري التحديث…' : 'تحديث'}
          </button>

          <button
            className="csp-btn csp-btn-primary"
            onClick={handleExport}
            disabled={!allRows.length || exporting}
          >
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
              {[...new Set(allRows.map(r => getRegion(r[COL_LOC])).filter(Boolean))].length}
            </span>
            <span className="csp-kpi-lbl">المناطق</span>
          </div>
          <div className={`csp-kpi${activeFilters ? ' csp-kpi-active' : ''}`}>
            <span className="csp-kpi-val">{filtered.length.toLocaleString('en-SA')}</span>
            <span className="csp-kpi-lbl">النتائج المعروضة</span>
          </div>
        </div>
      )}

      {/* ── Filters ── */}
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
            <button className="csp-input-clear" onClick={() => setSearch('')}>
              <X size={12} />
            </button>
          )}
        </div>

        <div className="csp-select-wrap">
          <Filter size={13} className="csp-select-icon" />
          <select className="csp-select" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">كل أنواع الأصناف</option>
            {itemTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
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

      {/* ── Active chips ── */}
      {activeFilters > 0 && (
        <div className="csp-chips">
          {typeFilter && (
            <span className="csp-chip">
              النوع: {typeFilter}
              <button onClick={() => setTypeFilter('')}><X size={11} /></button>
            </span>
          )}
          {locFilter && (
            <span className="csp-chip">
              الموقع: {locFilter}
              <button onClick={() => setLocFilter('')}><X size={11} /></button>
            </span>
          )}
          {search && (
            <span className="csp-chip">
              بحث: "{search}"
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
          <span className="csp-error-msg">
            {error?.response?.data?.error || error?.message}
          </span>
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
        <>
          {/* ══ MATRIX VIEW ══ */}
          {view === 'matrix' && (
            <StockMatrix
              rows={allRows}
              typeFilter={typeFilter}
              locFilter={locFilter}
              search={search}
            />
          )}

          {/* ══ TABLE VIEW ══ */}
          {view === 'table' && (
            <>
              {filtered.length === 0 ? (
                <div className="csp-empty">
                  <Filter size={40} />
                  <p>لا توجد نتائج تطابق الفلتر</p>
                  <button className="csp-clear-btn" onClick={clearFilters}>مسح الفلاتر</button>
                </div>
              ) : (
                <>
                  <div className="csp-table-wrap">
                    <table className="csp-table">
                      <thead>
                        <tr>
                          <th className="csp-th-seq">#</th>
                          {headers.map(h => (
                            <th key={h} className={numericCols.has(h) ? 'csp-num' : ''}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((row, i) => (
                          <tr key={i} className={i % 2 === 0 ? '' : 'csp-alt'}>
                            <td className="csp-td-seq">{(i + 1).toLocaleString('en-SA')}</td>
                            {headers.map(h => (
                              <td key={h} className={numericCols.has(h) ? 'csp-num' : ''}>
                                {numericCols.has(h)
                                  ? fmtNum(row[h])
                                  : (row[h] || <span className="csp-null">—</span>)
                                }
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="csp-footer">
                    <span>
                      عرض <strong>{filtered.length.toLocaleString('en-SA')}</strong> من أصل{' '}
                      <strong>{allRows.length.toLocaleString('en-SA')}</strong> صنف
                      {activeFilters > 0 && (
                        <> — <button className="csp-footer-clear" onClick={clearFilters}>مسح الفلاتر</button></>
                      )}
                    </span>
                    {data?.warning && (
                      <span className="csp-footer-warn">⚠ {data.warning}</span>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
