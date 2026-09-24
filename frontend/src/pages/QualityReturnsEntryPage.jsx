import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './QualityReturnsEntryPage.css';

/* ── Helpers ───────────────────────────────────────────────── */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Item identity stays the English name — it's the key sales_activity/
// quality_returns_report_lines already use — but display prefers the
// admin-entered Arabic overlay (quality_returns_item_info), falling back to
// English when no translation was entered yet.
function lineKey(routeId, itemNameEn) {
  return `${routeId}__${itemNameEn}`;
}
function itemLabel(item) {
  return item.item_name_ar || item.item_name_en;
}
function fmtSavedAt(iso) {
  return new Date(iso).toLocaleString('en-SA', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * QualityReturnsEntryPage — the daily مرتجعات عيوب الجودة entry grid.
 * A quality_returns_monitor sees only the region(s) assigned to them; an
 * admin sees every region. One region's ENTIRE route set is entered and
 * saved together in one grid/submission: rows = items (pulled live from
 * sales_activity, grouped under their category, with an admin-entered
 * Arabic name + code overlay), columns = that region's routes (each showing
 * its assigned rep + vehicle), one quantity cell per item×route. Expiry
 * date is entered ONCE per item row (applied to every route's non-zero line
 * for that item on save) — a per-cell expiry would make an already-wide
 * grid (up to 11 routes × ~65 items) unusable.
 */
export default function QualityReturnsEntryPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const isAdmin = ['super_admin', 'it_admin'].includes(user?.role);

  const [date, setDate] = useState(todayISO());
  const [regionId, setRegionId] = useState('');
  const [quantities, setQuantities] = useState({}); // { 'routeId__itemNameEn': qtyString }
  const [itemExpiry, setItemExpiry] = useState({}); // { itemNameEn: 'YYYY-MM-DD' }
  const [notes, setNotes] = useState('');
  const [saveState, setSaveState] = useState(null);
  const [saveError, setSaveError] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [codeSortDir, setCodeSortDir] = useState(null); // null | 'asc' | 'desc'
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [photoError, setPhotoError] = useState('');

  const { data: regions = [] } = useQuery({
    queryKey: ['qre-my-regions'],
    queryFn: () => client.get('/quality-returns/my-regions').then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!regionId && regions.length === 1) setRegionId(String(regions[0].id));
  }, [regions, regionId]);

  const { data: entryData, isLoading: entryLoading } = useQuery({
    queryKey: ['qre-entry', regionId, date],
    queryFn: () => client.get('/quality-returns/entry', { params: { region_id: regionId, date } }).then(r => r.data),
    enabled: !!regionId && !!date,
  });

  // Signature log — every save is kept, not just the latest.
  const { data: saveLog = [] } = useQuery({
    queryKey: ['qre-save-log', regionId, date],
    queryFn: () => client.get('/quality-returns/save-log', { params: { region_id: regionId, date } }).then(r => r.data),
    enabled: !!regionId && !!date,
  });

  // Photo attachments — kept on (region, date) directly, so they can be
  // attached before the quantities are ever saved.
  const { data: photos = [], refetch: refetchPhotos } = useQuery({
    queryKey: ['qre-photos', regionId, date],
    queryFn: () => client.get('/quality-returns/photos', { params: { region_id: regionId, date } }).then(r => r.data),
    enabled: !!regionId && !!date,
  });

  useEffect(() => {
    if (!entryData) return;
    const qtyMap = {};
    const expMap = {};
    (entryData.lines || []).forEach(l => {
      qtyMap[lineKey(l.route_id, l.item_name)] = String(l.quantity ?? '');
      if (l.expiry_date) expMap[l.item_name] = String(l.expiry_date).slice(0, 10);
    });
    setQuantities(qtyMap);
    setItemExpiry(expMap);
    setNotes(entryData.report?.notes || '');
    setSaveState(null);
  }, [entryData]);

  const routes = entryData?.routes || [];
  const allItems = entryData?.items || [];

  // Per-user category visibility — a personal preference, independent of
  // the admin-only route toggle above. Filtering happens ONLY on the
  // `items`/`groupedItems` display lists, never on `allItems`, so a
  // category the user hides still saves correctly if it already has
  // values (handleSave below iterates allItems, unaffected by this).
  const { data: categoryPrefs = [] } = useQuery({
    queryKey: ['qre-category-prefs'],
    queryFn: () => client.get('/quality-returns/category-prefs').then(r => r.data),
  });
  const activeCategorySet = useMemo(
    () => new Set(categoryPrefs.filter(c => c.is_active).map(c => c.item_category)),
    [categoryPrefs]
  );
  const categoriesLoaded = categoryPrefs.length > 0;

  const items = useMemo(() => {
    let list = allItems;
    if (categoriesLoaded) {
      list = list.filter(it => activeCategorySet.has(it.item_category || 'غير مصنف'));
    }
    if (itemSearch.trim()) {
      const q = itemSearch.trim().toLowerCase();
      list = list.filter(it =>
        (it.item_name_ar || '').toLowerCase().includes(q) ||
        (it.item_name_en || '').toLowerCase().includes(q) ||
        (it.item_code || '').toLowerCase().includes(q)
      );
    }
    if (codeSortDir) {
      list = [...list].sort((a, b) => {
        const ca = parseInt(a.item_code, 10);
        const cb = parseInt(b.item_code, 10);
        const naNa = Number.isNaN(ca), naNb = Number.isNaN(cb);
        if (naNa && naNb) return 0;
        if (naNa) return 1;  // items with no code sort last regardless of direction
        if (naNb) return -1;
        return codeSortDir === 'asc' ? ca - cb : cb - ca;
      });
    }
    return list;
  }, [allItems, itemSearch, categoriesLoaded, activeCategorySet, codeSortDir]);

  const handleCodeSortClick = () => {
    setCodeSortDir(prev => (prev === null ? 'asc' : prev === 'asc' ? 'desc' : null));
  };

  // Grouped by category, preserving the backend's category+name ordering —
  // EXCEPT when sorting by code is active, which shows one flat list (by
  // code) instead, since the whole point is finding an item across
  // categories by its number.
  const groupedItems = useMemo(() => {
    if (codeSortDir) return [{ category: null, items }];
    const groups = [];
    let current = null;
    items.forEach(it => {
      const cat = it.item_category || 'غير مصنف';
      if (!current || current.category !== cat) {
        current = { category: cat, items: [] };
        groups.push(current);
      }
      current.items.push(it);
    });
    return groups;
  }, [items, codeSortDir]);

  const handleQtyChange = (routeId, itemNameEn, val) => {
    if (val !== '' && !/^\d*\.?\d*$/.test(val)) return;
    setQuantities(prev => ({ ...prev, [lineKey(routeId, itemNameEn)]: val }));
  };
  const handleExpiryChange = (itemNameEn, val) => {
    setItemExpiry(prev => ({ ...prev, [itemNameEn]: val }));
  };

  const rowTotal = useCallback((itemNameEn) => {
    return routes.reduce((s, r) => s + (Number(quantities[lineKey(r.route_id, itemNameEn)]) || 0), 0);
  }, [routes, quantities]);

  const grandTotal = useMemo(
    () => items.reduce((s, it) => s + rowTotal(it.item_name_en), 0),
    [items, rowTotal]
  );

  const handleSave = useCallback(async () => {
    if (!regionId || !date) return;
    setSaveState('saving');
    setSaveError('');
    try {
      const lines = [];
      allItems.forEach(it => {
        routes.forEach(r => {
          const qty = Number(quantities[lineKey(r.route_id, it.item_name_en)]) || 0;
          if (qty > 0) {
            lines.push({ route_id: r.route_id, item_name: it.item_name_en, quantity: qty, expiry_date: itemExpiry[it.item_name_en] || null });
          }
        });
      });
      await client.post('/quality-returns/entry', { region_id: Number(regionId), report_date: date, notes, lines });
      setSaveState('saved');
      qc.invalidateQueries({ queryKey: ['qre-entry', regionId, date] });
      qc.invalidateQueries({ queryKey: ['qre-save-log', regionId, date] });
      qc.invalidateQueries({ queryKey: ['qrr-report'] });
    } catch (err) {
      setSaveState('error');
      setSaveError(err?.response?.data?.error || 'حدث خطأ أثناء الحفظ');
    }
  }, [regionId, date, notes, allItems, routes, quantities, itemExpiry, qc]);

  const handlePhotoSelect = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length || !regionId || !date) return;
    setUploadingPhotos(true);
    setPhotoError('');
    try {
      const form = new FormData();
      // Text fields MUST come before the files so the backend's multer
      // destination callback (which reads req.body) sees them.
      form.append('region_id', regionId);
      form.append('report_date', date);
      files.forEach(f => form.append('files', f));
      await client.post('/quality-returns/photos', form);
      await refetchPhotos();
    } catch (err) {
      setPhotoError(err?.response?.data?.error || 'حدث خطأ أثناء رفع الصور');
    } finally {
      setUploadingPhotos(false);
    }
  }, [regionId, date, refetchPhotos]);

  const handlePhotoDelete = useCallback(async (photoId) => {
    if (!window.confirm('حذف هذه الصورة؟')) return;
    try {
      await client.delete(`/quality-returns/photos/${photoId}`);
      await refetchPhotos();
    } catch (err) {
      setPhotoError(err?.response?.data?.error || 'حدث خطأ أثناء حذف الصورة');
    }
  }, [refetchPhotos]);

  // Condensed print rows — only route×item cells with a recorded quantity,
  // per the explicit request to keep the printed table as small as
  // possible (the live grid needs every cell for input; the printout doesn't).
  const printRows = useMemo(() => {
    const out = [];
    allItems.forEach(it => {
      routes.forEach(r => {
        const qty = Number(quantities[lineKey(r.route_id, it.item_name_en)]) || 0;
        if (qty > 0) {
          out.push({
            route_id: r.route_id,
            reps: (r.reps || []).map(rep => rep.name).join('، '),
            vehicle_numbers: [...new Set((r.reps || []).map(rep => rep.vehicle_number).filter(Boolean))].join('، '),
            item_label: itemLabel(it),
            item_code: it.item_code || '',
            quantity: qty,
            expiry_date: itemExpiry[it.item_name_en] || null,
          });
        }
      });
    });
    return out;
  }, [allItems, routes, quantities, itemExpiry]);

  const printTotalQty = useMemo(() => printRows.reduce((s, r) => s + r.quantity, 0), [printRows]);

  const selectedRegion = regions.find(r => String(r.id) === String(regionId));

  const handlePrint = () => {
    const prevTitle = document.title;
    document.title = `مرتجعات عيوب الجودة — ${selectedRegion?.name_ar || ''} — ${date}`;
    window.print();
    window.onafterprint = () => { document.title = prevTitle; };
  };

  return (
    <div className="qre-page">
      <div className="qre-header">
        <h1>مرتجعات عيوب الجودة — الإدخال اليومي</h1>
        <p className="qre-subtitle">سجّل كمية مرتجعات عيوب الجودة لكل صنف على كل خط سير بالمنطقة.</p>
      </div>

      <div className="qre-card qre-filters">
        <div className="qre-field">
          <label>المنطقة</label>
          <select value={regionId} onChange={e => setRegionId(e.target.value)} className="qre-select">
            <option value="">— اختر المنطقة —</option>
            {regions.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
          </select>
        </div>
        <div className="qre-field">
          <label>التاريخ</label>
          <input type="date" value={date} max={todayISO()} onChange={e => setDate(e.target.value)} className="qre-input" />
        </div>
        <div className="qre-field qre-search-field">
          <label>بحث في الأصناف</label>
          <input type="text" className="qre-input" value={itemSearch} onChange={e => setItemSearch(e.target.value)} placeholder="اكتب اسم الصنف أو رقمه…" />
        </div>
        {isAdmin && <div className="qre-admin-note">وضع المدير: يمكنك الإدخال نيابةً عن أي منطقة.</div>}
      </div>

      {regionId && <QualityReturnsCategoryTogglePanel />}

      {/* Was admin-only; opened to the region's own assigned monitor too
          (same 'إدخال' edit permission POST /entry requires) — they're the
          one who actually needs to shrink a too-wide grid day to day, and
          previously had no way to do it without asking an admin. Matches
          the category panel above, which was never admin-gated. */}
      {regionId && (
        <QualityReturnsRouteTogglePanel
          regionId={regionId}
          onChanged={() => qc.invalidateQueries({ queryKey: ['qre-entry', regionId, date] })}
        />
      )}

      {!regionId && (
        <div className="qre-card qre-empty">
          {regions.length === 0
            ? 'لا توجد مناطق مخصصة لحسابك بعد — تواصل مع الإدارة لإضافتك على منطقة.'
            : 'اختر المنطقة للبدء في تسجيل مرتجعات عيوب الجودة.'}
        </div>
      )}

      {regionId && entryLoading && <div className="qre-card qre-empty">جاري تحميل البيانات…</div>}

      {regionId && !entryLoading && (
        <div className="qre-card">
          <div className="qre-card__title">
            {selectedRegion?.name_ar} — {date}
            {entryData?.report && <span className="qre-badge">تم إدخال تقرير لهذا اليوم — يمكنك تعديله</span>}
          </div>

          {routes.length === 0 ? (
            <div className="qre-empty">لا توجد خطوط سير مسجَّلة لهذه المنطقة.</div>
          ) : items.length === 0 ? (
            <div className="qre-empty">لا توجد أصناف مطابقة للبحث.</div>
          ) : (
            <div className="qre-table-wrap">
              <table className="qre-table">
                <thead>
                  <tr>
                    <th className="qre-th-code qre-th-sortable" onClick={handleCodeSortClick} title="ترتيب حسب رقم الصنف">
                      رقم الصنف {codeSortDir === 'asc' ? '▲' : codeSortDir === 'desc' ? '▼' : '⇅'}
                    </th>
                    <th className="qre-th-item">الصنف</th>
                    <th className="qre-th-expiry">تاريخ الانتهاء</th>
                    {routes.map(r => (
                      <th key={r.route_id} className="qre-th-route">
                        <div>خط {r.route_id}</div>
                        {(r.reps || []).map((rep, i) => (
                          <div key={i} className="qre-th-rep">
                            <div>{rep.name}</div>
                            {rep.vehicle_number && <div className="qre-th-vehicle">🚗 {rep.vehicle_number}</div>}
                          </div>
                        ))}
                        {(!r.reps || r.reps.length === 0) && <div className="qre-th-rep qre-muted">بدون مندوب</div>}
                      </th>
                    ))}
                    <th className="qre-th-total">الإجمالي</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedItems.map(group => (
                    <React.Fragment key={group.category ?? '__sorted__'}>
                      {group.category != null && (
                        <tr className="qre-cat-row">
                          <td colSpan={3 + routes.length + 1}>{group.category}</td>
                        </tr>
                      )}
                      {group.items.map(it => (
                        <tr key={it.item_name_en}>
                          <td className="qre-td-code">{it.item_code || '—'}</td>
                          <td className="qre-td-item">{itemLabel(it)}</td>
                          <td>
                            <input
                              type="date" className="qre-date-input"
                              value={itemExpiry[it.item_name_en] ?? ''}
                              onChange={e => handleExpiryChange(it.item_name_en, e.target.value)}
                            />
                          </td>
                          {routes.map(r => (
                            <td key={r.route_id}>
                              <input
                                type="text" inputMode="decimal" className="qre-qty-input"
                                placeholder="0"
                                value={quantities[lineKey(r.route_id, it.item_name_en)] ?? ''}
                                onChange={e => handleQtyChange(r.route_id, it.item_name_en, e.target.value)}
                              />
                            </td>
                          ))}
                          <td className="qre-td-rowtotal">{rowTotal(it.item_name_en).toLocaleString('en-SA')}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3 + routes.length}>الإجمالي الكلي</td>
                    <td><strong>{grandTotal.toLocaleString('en-SA')}</strong></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <div className="qre-field qre-notes-field">
            <label>ملاحظات عامة عن اليوم (اختياري)</label>
            <textarea
              className="qre-textarea" rows={3}
              value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="أي ملاحظات إضافية عن مرتجعات اليوم…"
            />
          </div>

          <div className="qre-field qre-photos-field">
            <label>صور مرفقة (اختياري)</label>
            <label className="qre-photo-upload-btn">
              📷 إرفاق صور
              <input type="file" accept="image/*" multiple hidden onChange={handlePhotoSelect} disabled={uploadingPhotos} />
            </label>
            {uploadingPhotos && <span className="qre-photo-uploading">جاري الرفع…</span>}
            {photoError && <div className="qre-error">{photoError}</div>}
            {photos.length > 0 && (
              <div className="qre-photo-grid">
                {photos.map(p => (
                  <div key={p.id} className="qre-photo-thumb">
                    <a href={p.url} target="_blank" rel="noopener noreferrer">
                      <img src={p.url} alt={p.original_filename || 'صورة مرفقة'} />
                    </a>
                    <button type="button" className="qre-photo-remove" onClick={() => handlePhotoDelete(p.id)} title="حذف الصورة">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="qre-actions">
            <button className="qre-btn qre-btn--primary" onClick={handleSave} disabled={saveState === 'saving' || routes.length === 0}>
              {saveState === 'saving' ? 'جاري الحفظ…' : '💾 حفظ التقرير'}
            </button>
            <button className="qre-btn qre-btn--outline" onClick={handlePrint} disabled={printRows.length === 0} title={printRows.length === 0 ? 'لا توجد كميات مسجَّلة للطباعة' : ''}>
              🖨️ طباعة PDF
            </button>
            {saveState === 'saved' && <span className="qre-save-ok">✓ تم الحفظ بنجاح</span>}
            {saveState === 'error' && <span className="qre-save-err">{saveError}</span>}
          </div>

          {saveLog.length > 0 && (
            <div className="qre-save-log">
              <div className="qre-save-log__title">سجل التوقيع — من قام بالحفظ ومتى</div>
              <ul className="qre-save-log__list">
                {saveLog.map((l, i) => (
                  <li key={i}>
                    <strong>{l.saved_by_name || 'غير معروف'}</strong>
                    {' — '}{fmtSavedAt(l.saved_at)}
                    {' — الإجمالي: '}{Number(l.total_qty).toLocaleString('en-SA')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── Print-only view (hidden on screen, shown via @media print) ──
          Condensed to items/routes with a recorded quantity only. */}
      <div className="qre-print-only">
        <div className="qre-print-header">
          <img src="/Logo.png" alt="طرية" className="qre-print-logo" />
          <div className="qre-print-title">
            <div>تقرير مرتجعات عيوب الجودة</div>
            <div className="qre-print-sub">{selectedRegion?.name_ar} — {date}</div>
          </div>
        </div>

        <div className="qre-print-summary">
          <div><strong>ملخص كميات الجودة</strong></div>
          <div>إجمالي الكمية: {printTotalQty.toLocaleString('en-SA')}</div>
          <div>عدد الأصناف المسجَّلة: {new Set(printRows.map(r => r.item_label)).size}</div>
          <div>عدد خطوط السير المسجَّلة: {new Set(printRows.map(r => r.route_id)).size}</div>
        </div>

        <table className="qre-print-table">
          <thead>
            <tr>
              <th>خط السير</th>
              <th>المندوب</th>
              <th>رقم السيارة</th>
              <th>رقم الصنف</th>
              <th>الصنف</th>
              <th>الكمية</th>
              <th>تاريخ الانتهاء</th>
            </tr>
          </thead>
          <tbody>
            {printRows.map((r, i) => (
              <tr key={i}>
                <td>خط {r.route_id}</td>
                <td>{r.reps || '—'}</td>
                <td>{r.vehicle_numbers || '—'}</td>
                <td>{r.item_code || '—'}</td>
                <td>{r.item_label}</td>
                <td>{r.quantity.toLocaleString('en-SA')}</td>
                <td>{r.expiry_date || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {notes && <div className="qre-print-notes">ملاحظات: {notes}</div>}
        <div className="qre-print-footer">تاريخ التقرير: {date}</div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Category toggle panel — per-USER preference (unlike the route toggle,
   this isn't admin-only: every monitor manages their own view). Hiding a
   category only affects what's shown/searched in the grid; it never
   touches what's saved (handleSave always iterates the full item list).
════════════════════════════════════════════════════════════ */
function QualityReturnsCategoryTogglePanel() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [busyCat, setBusyCat] = useState(null);
  const [error, setError] = useState('');

  const { data: prefs = [], refetch } = useQuery({
    queryKey: ['qre-category-prefs'],
    queryFn: () => client.get('/quality-returns/category-prefs').then(r => r.data),
  });

  const mandatoryCats = prefs.filter(c => c.is_mandatory);
  const optionalActiveCats = prefs.filter(c => !c.is_mandatory && c.is_active);
  const availableCats = prefs.filter(c => !c.is_mandatory && !c.is_active);
  const activeCount = mandatoryCats.length + optionalActiveCats.length;

  const toggle = async (category, isActive) => {
    setError('');
    setBusyCat(category);
    try {
      await client.put('/quality-returns/category-prefs', { item_category: category, is_active: isActive });
      await refetch();
      qc.invalidateQueries({ queryKey: ['qre-category-prefs'] });
    } catch (err) {
      setError(err?.response?.data?.error || 'حدث خطأ أثناء التعديل');
    } finally {
      setBusyCat(null);
    }
  };

  if (prefs.length === 0) return null;

  return (
    <div className="qre-card qre-route-toggle">
      <button type="button" className="qre-route-toggle__header" onClick={() => setExpanded(s => !s)}>
        <span>🗂️ التحكم بفئات الأصناف الظاهرة بالجدول ({activeCount} نشطة من {prefs.length})</span>
        <span>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="qre-route-toggle__body">
          {error && <div className="qre-save-err">{error}</div>}
          <div className="qre-route-toggle__section">
            <div className="qre-route-toggle__label">فئات إجبارية من الإدارة (لا يمكن إخفاؤها)</div>
            <div className="qre-route-chips">
              {mandatoryCats.length === 0 && <span className="qre-muted">لم تحدَّد فئات إجبارية بعد</span>}
              {mandatoryCats.map(c => (
                <span key={c.item_category} className="qre-route-chip qre-route-chip--mandatory">
                  🔒 {c.item_category}
                </span>
              ))}
            </div>
          </div>
          <div className="qre-route-toggle__section">
            <div className="qre-route-toggle__label">فئات إضافية فعّلتها بنفسك</div>
            <div className="qre-route-chips">
              {optionalActiveCats.length === 0 && <span className="qre-muted">لم تُفعِّل أي فئة إضافية</span>}
              {optionalActiveCats.map(c => (
                <span key={c.item_category} className="qre-route-chip qre-route-chip--active">
                  {c.item_category}
                  <button type="button" disabled={busyCat === c.item_category} onClick={() => toggle(c.item_category, false)} title="إخفاء">✕</button>
                </span>
              ))}
            </div>
          </div>
          <div className="qre-route-toggle__section">
            <div className="qre-route-toggle__label">فئات أخرى متاحة (اختياري)</div>
            <div className="qre-route-chips">
              {availableCats.length === 0 && <span className="qre-muted">كل الفئات مفعّلة بالفعل</span>}
              {availableCats.map(c => (
                <span key={c.item_category} className="qre-route-chip">
                  {c.item_category}
                  <button type="button" disabled={busyCat === c.item_category} onClick={() => toggle(c.item_category, true)} title="إظهار">➕</button>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Admin route toggle panel — controls which of the region's routes
   render as grid columns (a region can have far more routes than fit
   usefully in one table). Deactivating one frees a column slot for
   another without losing any of that route's already-saved history —
   the report/search page always shows every route regardless of its
   current toggle state.
════════════════════════════════════════════════════════════ */
function QualityReturnsRouteTogglePanel({ regionId, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [busyRoute, setBusyRoute] = useState(null);
  const [error, setError] = useState('');

  const { data: routes = [], refetch } = useQuery({
    queryKey: ['qre-route-settings', regionId],
    queryFn: () => client.get('/quality-returns/routes', { params: { region_id: regionId } }).then(r => r.data),
  });

  const activeRoutes = routes.filter(r => r.is_active);
  const inactiveRoutes = routes.filter(r => !r.is_active);

  const toggle = async (routeId, isActive) => {
    setError('');
    setBusyRoute(routeId);
    try {
      await client.put(`/quality-returns/routes/${routeId}/active`, { is_active: isActive });
      await refetch();
      onChanged?.();
    } catch (err) {
      setError(err?.response?.data?.error || 'حدث خطأ أثناء التعديل');
    } finally {
      setBusyRoute(null);
    }
  };

  const routeSummary = (r) => {
    const names = (r.reps || []).map(rep => rep.name + (rep.vehicle_number ? ` (🚗 ${rep.vehicle_number})` : '')).join('، ');
    return `خط ${r.route_id}${names ? ` — ${names}` : ' — بدون مندوب'}`;
  };

  return (
    <div className="qre-card qre-route-toggle">
      <button type="button" className="qre-route-toggle__header" onClick={() => setExpanded(s => !s)}>
        <span>⚙️ التحكم بخطوط السير الظاهرة بالجدول ({activeRoutes.length} نشط من {routes.length})</span>
        <span>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="qre-route-toggle__body">
          {error && <div className="qre-save-err">{error}</div>}
          <div className="qre-route-toggle__section">
            <div className="qre-route-toggle__label">خطوط نشطة (تظهر كأعمدة)</div>
            <div className="qre-route-chips">
              {activeRoutes.length === 0 && <span className="qre-muted">لا توجد خطوط نشطة</span>}
              {activeRoutes.map(r => (
                <span key={r.route_id} className="qre-route-chip qre-route-chip--active">
                  {routeSummary(r)}
                  <button type="button" disabled={busyRoute === r.route_id} onClick={() => toggle(r.route_id, false)} title="إلغاء التفعيل">✕</button>
                </span>
              ))}
            </div>
          </div>
          <div className="qre-route-toggle__section">
            <div className="qre-route-toggle__label">خطوط أخرى مسجَّلة بالمنطقة (غير ظاهرة)</div>
            <div className="qre-route-chips">
              {inactiveRoutes.length === 0 && <span className="qre-muted">كل خطوط المنطقة مفعّلة بالفعل</span>}
              {inactiveRoutes.map(r => (
                <span key={r.route_id} className="qre-route-chip">
                  {routeSummary(r)}
                  <button type="button" disabled={busyRoute === r.route_id} onClick={() => toggle(r.route_id, true)} title="تفعيل">➕</button>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
