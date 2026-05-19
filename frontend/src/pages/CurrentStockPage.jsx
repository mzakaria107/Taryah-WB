import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  RefreshCw, Download, Search, X,
  AlertCircle, Clock, Filter, Warehouse,
} from 'lucide-react';
import client from '../api/client';
import './CurrentStockPage.css';

/* ── Helpers ──────────────────────────────────────────────── */
function fmtNum(v) {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  if (isNaN(n)) return v || '—';
  return n.toLocaleString('en-SA', { maximumFractionDigits: 2 });
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

/* Detect item-type column */
function detectTypeCol(headers) {
  const keywords = ['نوع', 'type', 'category', 'صنف', 'تصنيف', 'classification', 'النوع'];
  return (
    headers.find(h => keywords.some(k => h.toLowerCase().includes(k.toLowerCase()))) ||
    headers[1] ||
    ''
  );
}

/* Detect location column */
function detectLocCol(headers) {
  const keywords = ['location', 'موقع', 'فرع', 'مقر', 'الوحدة', 'subsidiary', 'مستودع', 'warehouse'];
  return (
    headers.find(h => keywords.some(k => h.toLowerCase().includes(k.toLowerCase()))) ||
    headers[0] ||
    ''
  );
}

/* ── Skeleton ─────────────────────────────────────────────── */
function Skeleton({ cols = 7, rows = 12 }) {
  return (
    <div className="csp-skeleton-wrap">
      {/* fake header */}
      <div className="csp-sk-header">
        {Array.from({ length: cols }, (_, i) => (
          <div key={i} className="csp-sk csp-sk-th" style={{ width: `${60 + (i * 17) % 40}%` }} />
        ))}
      </div>
      {/* fake rows */}
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

/* ── Page ─────────────────────────────────────────────────── */
export default function CurrentStockPage() {
  const [search,     setSearch]     = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [locFilter,  setLocFilter]  = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [exporting,  setExporting]  = useState(false);

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

  const typeCol = useMemo(() => detectTypeCol(headers), [headers]);
  const locCol  = useMemo(() => detectLocCol(headers),  [headers]);

  const numericCols = useMemo(
    () => new Set(headers.filter(h => isNumericCol(allRows, h))),
    [headers, allRows]
  );

  const itemTypes = useMemo(
    () => [...new Set(allRows.map(r => r[typeCol]).filter(Boolean))].sort(),
    [allRows, typeCol]
  );

  const locations = useMemo(
    () => [...new Set(allRows.map(r => r[locCol]).filter(Boolean))].sort(),
    [allRows, locCol]
  );

  /* ── Filtered rows ── */
  const filtered = useMemo(() => {
    if (!search && !typeFilter && !locFilter) return allRows;
    const q = search.toLowerCase();
    return allRows.filter(row => {
      if (typeFilter && row[typeCol] !== typeFilter) return false;
      if (locFilter  && row[locCol]  !== locFilter)  return false;
      if (q && !Object.values(row).some(v => String(v ?? '').toLowerCase().includes(q)))
        return false;
      return true;
    });
  }, [allRows, typeFilter, locFilter, search, typeCol, locCol]);

  /* ── Handlers ── */
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
          ...(search     && { search                  }),
        },
      });
      const url  = URL.createObjectURL(res.data);
      const link = document.createElement('a');
      link.href     = url;
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
          <button
            className="csp-btn csp-btn-secondary"
            onClick={handleRefresh}
            disabled={isFetching}
            title="جلب بيانات محدثة من NetSuite"
          >
            <RefreshCw size={14} className={isFetching ? 'csp-spin' : ''} />
            {isFetching ? 'جاري التحديث…' : 'تحديث'}
          </button>

          <button
            className="csp-btn csp-btn-primary"
            onClick={handleExport}
            disabled={!allRows.length || exporting}
            title="تصدير البيانات المعروضة إلى Excel"
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
            <span className="csp-kpi-val">{locations.length}</span>
            <span className="csp-kpi-lbl">المواقع / الفروع</span>
          </div>
          <div className={`csp-kpi${activeFilters ? ' csp-kpi-active' : ''}`}>
            <span className="csp-kpi-val">{filtered.length.toLocaleString('en-SA')}</span>
            <span className="csp-kpi-lbl">النتائج المعروضة</span>
          </div>
        </div>
      )}

      {/* ── Filters bar ── */}
      <div className="csp-filters">
        {/* Search */}
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

        {/* Item type filter */}
        <div className="csp-select-wrap">
          <Filter size={13} className="csp-select-icon" />
          <select
            className="csp-select"
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
          >
            <option value="">كل أنواع الأصناف</option>
            {itemTypes.map(t => (
              <option key={t} value={t}>{t || '(بدون نوع)'}</option>
            ))}
          </select>
        </div>

        {/* Location filter */}
        <div className="csp-select-wrap">
          <Filter size={13} className="csp-select-icon" />
          <select
            className="csp-select"
            value={locFilter}
            onChange={e => setLocFilter(e.target.value)}
          >
            <option value="">كل المواقع</option>
            {locations.map(l => (
              <option key={l} value={l}>{l || '(بدون موقع)'}</option>
            ))}
          </select>
        </div>

        {/* Clear all */}
        {activeFilters > 0 && (
          <button className="csp-clear-btn" onClick={clearFilters}>
            <X size={13} />
            مسح الفلاتر ({activeFilters})
          </button>
        )}
      </div>

      {/* ── Active filter chips ── */}
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

      ) : filtered.length === 0 ? (
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
                    <th key={h} className={numericCols.has(h) ? 'csp-num' : ''}>
                      {h}
                    </th>
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

          {/* Footer count */}
          <div className="csp-footer">
            <span>
              عرض <strong>{filtered.length.toLocaleString('en-SA')}</strong> من أصل{' '}
              <strong>{allRows.length.toLocaleString('en-SA')}</strong> صنف
              {activeFilters > 0 && <> — <button className="csp-footer-clear" onClick={clearFilters}>مسح الفلاتر</button></>}
            </span>
            {data?.warning && (
              <span className="csp-footer-warn">⚠ {data.warning}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
