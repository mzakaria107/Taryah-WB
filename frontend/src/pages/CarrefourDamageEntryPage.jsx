import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './CarrefourDamageEntryPage.css';

/* ── Helpers ───────────────────────────────────────────────── */
function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function fmtSavedAt(iso) {
  return new Date(iso).toLocaleString('en-SA', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/* ── "الأسعار Survey" — item × brand price matrix ─────────────────────
   Self-contained: fetches its own data and saves each cell immediately on
   blur (POST /price-survey/cell), rather than sharing the parent's
   quantities/save-button state which is shaped for a flat item list, not
   a matrix. Average = mean of every OTHER (non-"طريه") brand's entered
   price for that row; the lowest entered price in the row (any brand,
   "طريه" included) is highlighted — both per the request. */
function PriceSurveyMatrix({ branchId, date }) {
  const qc = useQueryClient();
  const [values, setValues] = useState({});   // `${itemId}:${brandId}` -> string
  const [meta, setMeta] = useState({});        // `${itemId}:${brandId}` -> { initials, savedAt }
  const [cellStatus, setCellStatus] = useState({}); // `${itemId}:${brandId}` -> 'saving' | 'saved' | 'error' | undefined

  const { data, isLoading } = useQuery({
    queryKey: ['cf-price-survey', branchId, date],
    queryFn: () => client.get('/carrefour-damage/price-survey/entry', { params: { branch_id: branchId, date } }).then(r => r.data),
    enabled: !!branchId && !!date,
  });

  const items = data?.items || [];
  const brands = data?.brands || [];
  const ownBrand = brands.find(b => b.is_own_brand);

  useEffect(() => {
    if (!data) return;
    const v = {}, m = {};
    (data.entries || []).forEach(e => {
      const key = `${e.item_id}:${e.brand_id}`;
      v[key] = String(e.price);
      m[key] = { initials: e.entered_by_initials, name: e.entered_by_name, price: e.price };
    });
    setValues(v);
    setMeta(m);
    setCellStatus({});
  }, [data]);

  const groupedItems = useMemo(() => {
    const groups = [];
    let cur = null;
    items.forEach(it => {
      const cat = it.category || '';
      if (!cur || cur.category !== cat) { cur = { category: cat, rows: [] }; groups.push(cur); }
      cur.rows.push(it);
    });
    return groups;
  }, [items]);

  const handleCellChange = (itemId, brandId, val) => {
    if (val !== '' && !/^\d*\.?\d*$/.test(val)) return;
    setValues(prev => ({ ...prev, [`${itemId}:${brandId}`]: val }));
  };

  const handleCellBlur = useCallback(async (itemId, brandId) => {
    const key = `${itemId}:${brandId}`;
    const raw = values[key] ?? '';
    const price = raw === '' ? null : Number(raw);
    // Skip the round trip if the value is unchanged from what's already
    // saved (e.g. tabbing through cells without editing them).
    const savedPrice = meta[key]?.price != null ? Number(meta[key].price) : null;
    if (price === savedPrice) return;
    setCellStatus(prev => ({ ...prev, [key]: 'saving' }));
    try {
      const res = await client.post('/carrefour-damage/price-survey/cell', {
        branch_id: Number(branchId), report_date: date, item_id: itemId, brand_id: brandId, price,
      });
      if (res.data.entry) {
        setMeta(prev => ({ ...prev, [key]: { initials: res.data.entry.entered_by_initials, name: res.data.entry.entered_by_name, price: res.data.entry.price } }));
      } else {
        setMeta(prev => { const n = { ...prev }; delete n[key]; return n; });
      }
      setCellStatus(prev => ({ ...prev, [key]: 'saved' }));
      qc.invalidateQueries({ queryKey: ['cf-price-survey', branchId, date] });
    } catch (err) {
      setCellStatus(prev => ({ ...prev, [key]: 'error' }));
    }
  }, [values, meta, branchId, date, qc]);

  if (isLoading) return <div className="cfe-card cfe-empty">جاري تحميل البيانات…</div>;
  if (!items.length || !brands.length) {
    return <div className="cfe-card cfe-empty">لا توجد أصناف أو براندات مضافة بعد — تواصل مع الإدارة لإضافتها.</div>;
  }

  return (
    <div className="cfe-card cfe-price-survey">
      <div className="cfe-table-wrap">
        <table className="cfe-table cfe-price-table">
          <thead>
            <tr>
              <th className="cfe-price-item-col">الصنف</th>
              {brands.map(b => (
                <th key={b.id} className={b.is_own_brand ? 'cfe-price-own-col' : ''}>{b.name}</th>
              ))}
              <th>Average</th>
            </tr>
          </thead>
          <tbody>
            {groupedItems.map(group => (
              <React.Fragment key={group.category}>
                {group.category && (
                  <tr className="cfe-price-cat-row">
                    <td colSpan={brands.length + 2}><span className="cfe-price-cat-label">{group.category}</span></td>
                  </tr>
                )}
                {group.rows.map(it => {
                  const rowVals = brands.map(b => {
                    const key = `${it.id}:${b.id}`;
                    const v = values[key];
                    return { brand: b, num: v !== undefined && v !== '' ? Number(v) : null };
                  });
                  const competitorVals = rowVals.filter(r => !r.brand.is_own_brand && r.num != null).map(r => r.num);
                  const avg = competitorVals.length ? competitorVals.reduce((s, v) => s + v, 0) / competitorVals.length : null;
                  const allFilled = rowVals.filter(r => r.num != null);
                  const minVal = allFilled.length ? Math.min(...allFilled.map(r => r.num)) : null;
                  const ownVal = rowVals.find(r => r.brand.is_own_brand)?.num ?? null;
                  const ownDevPct = avg != null && avg > 0 && ownVal != null ? ((ownVal - avg) / avg) * 100 : null;

                  return (
                    <tr key={it.id}>
                      <td className="cfe-price-item-col">{it.item_name}</td>
                      {rowVals.map(({ brand, num }) => {
                        const key = `${it.id}:${brand.id}`;
                        const isMin = num != null && minVal != null && num === minVal;
                        const status = cellStatus[key];
                        return (
                          <td key={brand.id} className={`cfe-price-cell${isMin ? ' cfe-price-cell--min' : ''}${brand.is_own_brand ? ' cfe-price-own-col' : ''}`}>
                            <input
                              type="text" inputMode="decimal" className="cfe-price-input"
                              placeholder="—"
                              value={values[key] ?? ''}
                              onChange={e => handleCellChange(it.id, brand.id, e.target.value)}
                              onBlur={() => handleCellBlur(it.id, brand.id)}
                            />
                            {meta[key]?.initials && <span className="cfe-price-initials" title={meta[key]?.name || ''}>{meta[key].initials}</span>}
                            {status === 'saving' && <span className="cfe-price-status">⏳</span>}
                            {status === 'error' && <span className="cfe-price-status cfe-price-status--err">⚠️</span>}
                          </td>
                        );
                      })}
                      <td className="cfe-price-avg-col">
                        {avg != null ? avg.toFixed(2) : '—'}
                        {ownDevPct != null && (
                          <div className={`cfe-price-dev ${ownDevPct <= 0 ? 'cfe-price-dev--good' : 'cfe-price-dev--bad'}`}>
                            {ownDevPct <= 0 ? '▼' : '▲'} {Math.abs(ownDevPct).toFixed(1)}%
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cfe-hint">
        الخلية المميّزة بالأخضر الفاتح = أقل سعر مسجَّل للصنف بين كل البراندات.
        {ownBrand && ` "Average" = متوسط أسعار المنافسين (بدون ${ownBrand.name})، والنسبة أسفلها تقارن سعر ${ownBrand.name} بهذا المتوسط.`}
      </p>
    </div>
  );
}

/* Two tabs, one shared form — مرتجعات كارفور (damage/returns) and جرد أرصدة
   (stock on hand) are the same branch/day/item-lines shape against a
   different pair of backend tables (see makeEntryGetHandler/
   makeEntrySaveHandler in carrefourDamage.js — table names there stay
   "damage" internally, only the user-facing labels say "مرتجعات"), so the
   tab only swaps the endpoint + labels. */
const TABS = {
  damage: {
    key: 'damage',
    label: 'مرتجعات كارفور',
    entryPath: '/carrefour-damage/entry',
    quantityLabel: 'الكمية المرتجعة',
    pageTitle: 'مرتجعات فروع كارفور — الإدخال اليومي',
    pageSubtitle: 'سجّل كمية المرتجعات اليوم لكل صنف في الفرع الخاص بك.',
  },
  stock: {
    key: 'stock',
    label: 'جرد الأرصدة',
    entryPath: '/carrefour-damage/stock-entry',
    quantityLabel: 'الرصيد الحالي',
    pageTitle: 'جرد أرصدة فروع كارفور — الإدخال اليومي',
    pageSubtitle: 'سجّل الرصيد الحالي اليوم لكل صنف في الفرع الخاص بك.',
  },
  orders: {
    key: 'orders',
    label: 'الطلبيات المستلمة',
    entryPath: '/carrefour-damage/order-entry',
    quantityLabel: 'الكمية المستلمة',
    pageTitle: 'جرد الطلبيات المستلمة فروع كارفور — الإدخال اليومي',
    pageSubtitle: 'سجّل الكمية المستلمة اليوم لكل صنف في الفرع الخاص بك.',
  },
  // Distinct shape from the three tabs above (a matrix, not an item list;
  // each cell saves immediately, not one batch "حفظ") — rendered by its own
  // <PriceSurveyMatrix> component below, sharing only the branch/date
  // selectors and page chrome with the other tabs.
  priceSurvey: {
    key: 'priceSurvey',
    label: 'الأسعار Survey',
    pageTitle: 'مسح أسعار المنافسين — كارفور',
    pageSubtitle: 'سجّل السعر الملاحظ لكل صنف عند كل براند في الفرع الخاص بك — يُحفظ كل سعر فور إدخاله.',
    isMatrix: true,
  },
};

/**
 * CarrefourDamageEntryPage — the promoter's daily entry form, covering two
 * tabs: مرتجعات كارفور (damage/returns) and جرد أرصدة (stock-on-hand count). A
 * carrefour_rep sees only the branch(es) assigned to them; an admin sees
 * every active branch (for on-behalf entry / testing). Selecting a
 * branch+date fetches any existing report for that day so it can be edited
 * rather than silently overwritten.
 */
export default function CarrefourDamageEntryPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const isAdmin = ['super_admin', 'it_admin'].includes(user?.role);

  const [tab, setTab] = useState('damage');
  const mode = TABS[tab];

  const [date, setDate] = useState(todayISO());
  const [branchId, setBranchId] = useState('');
  const [quantities, setQuantities] = useState({}); // { item_id: qtyString }
  const [expiryDates, setExpiryDates] = useState({}); // { item_id: 'YYYY-MM-DD' }
  const [itemNotes, setItemNotes] = useState({}); // { item_id: text }
  const [notes, setNotes] = useState('');
  const [saveState, setSaveState] = useState(null); // null | 'saving' | 'saved' | 'error'
  const [saveError, setSaveError] = useState('');
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [photoError, setPhotoError] = useState('');

  const { data: branches = [] } = useQuery({
    queryKey: ['cfe-my-branches'],
    queryFn: () => client.get('/carrefour-damage/my-branches').then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!branchId && branches.length === 1) setBranchId(String(branches[0].id));
  }, [branches, branchId]);

  // None of these three apply to the "الأسعار Survey" tab (isMatrix) — it's
  // a completely different shape with its own dedicated query inside
  // <PriceSurveyMatrix>, and mode.entryPath is undefined for it, so these
  // must stay disabled rather than firing a request to `undefined`.
  const { data: entryData, isLoading: entryLoading } = useQuery({
    queryKey: ['cfe-entry', tab, branchId, date],
    queryFn: () => client.get(mode.entryPath, { params: { branch_id: branchId, date } }).then(r => r.data),
    enabled: !!branchId && !!date && !mode.isMatrix,
  });

  // Signature log — every save is kept, not just the latest, so this shows
  // the full history of who saved this branch/date/tab and when.
  const { data: saveLog = [] } = useQuery({
    queryKey: ['cfe-save-log', tab, branchId, date],
    queryFn: () => client.get('/carrefour-damage/save-log', { params: { report_type: tab, branch_id: branchId, date } }).then(r => r.data),
    enabled: !!branchId && !!date && !mode.isMatrix,
  });

  // Photo attachments — kept on (tab, branch, date) directly, so they can be
  // attached before the quantities are ever saved.
  const { data: photos = [], refetch: refetchPhotos } = useQuery({
    queryKey: ['cfe-photos', tab, branchId, date],
    queryFn: () => client.get('/carrefour-damage/photos', { params: { report_type: tab, branch_id: branchId, date } }).then(r => r.data),
    enabled: !!branchId && !!date && !mode.isMatrix,
  });

  // Prefill quantities/notes whenever the fetched entry changes
  useEffect(() => {
    if (!entryData) return;
    const qtyMap = {};
    const expMap = {};
    const noteMap = {};
    (entryData.lines || []).forEach(l => {
      qtyMap[l.item_id] = String(l.quantity ?? '');
      if (l.expiry_date) expMap[l.item_id] = String(l.expiry_date).slice(0, 10);
      if (l.notes) noteMap[l.item_id] = l.notes;
    });
    setQuantities(qtyMap);
    setExpiryDates(expMap);
    setItemNotes(noteMap);
    setNotes(entryData.report?.notes || '');
    setSaveState(null);
  }, [entryData]);

  const items = entryData?.items || [];

  const handleTabChange = (nextTab) => {
    setTab(nextTab);
    setSaveState(null);
    setSaveError('');
  };

  const handleQtyChange = (itemId, val) => {
    if (val !== '' && !/^\d*\.?\d*$/.test(val)) return; // numeric only
    setQuantities(prev => ({ ...prev, [itemId]: val }));
  };
  const handleExpiryChange = (itemId, val) => {
    setExpiryDates(prev => ({ ...prev, [itemId]: val }));
  };
  const handleItemNoteChange = (itemId, val) => {
    setItemNotes(prev => ({ ...prev, [itemId]: val }));
  };

  const totalQty = useMemo(
    () => Object.values(quantities).reduce((s, v) => s + (Number(v) || 0), 0),
    [quantities]
  );

  const handleSave = useCallback(async () => {
    if (!branchId || !date) return;
    setSaveState('saving');
    setSaveError('');
    try {
      const payload = {
        branch_id: Number(branchId),
        report_date: date,
        notes,
        items: items.map(it => ({
          item_id: it.id,
          item_name: it.item_name,
          quantity: Number(quantities[it.id]) || 0,
          expiry_date: expiryDates[it.id] || null,
          notes: itemNotes[it.id] || null,
        })),
      };
      await client.post(mode.entryPath, payload);
      setSaveState('saved');
      qc.invalidateQueries({ queryKey: ['cfe-entry', tab, branchId, date] });
      qc.invalidateQueries({ queryKey: ['cfe-save-log', tab, branchId, date] });
      qc.invalidateQueries({ queryKey: ['cfr-report'] }); // matches all report tabs (key prefix)
    } catch (err) {
      setSaveState('error');
      setSaveError(err?.response?.data?.error || 'حدث خطأ أثناء الحفظ');
    }
  }, [branchId, date, notes, items, quantities, expiryDates, itemNotes, qc, mode.entryPath, tab]);

  const handlePhotoSelect = useCallback(async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-selecting the same file later
    if (!files.length || !branchId || !date) return;
    setUploadingPhotos(true);
    setPhotoError('');
    try {
      const form = new FormData();
      // Text fields MUST come before the files so the backend's multer
      // destination callback (which reads req.body) sees them.
      form.append('report_type', tab);
      form.append('branch_id', branchId);
      form.append('report_date', date);
      files.forEach(f => form.append('files', f));
      await client.post('/carrefour-damage/photos', form);
      await refetchPhotos();
    } catch (err) {
      setPhotoError(err?.response?.data?.error || 'حدث خطأ أثناء رفع الصور');
    } finally {
      setUploadingPhotos(false);
    }
  }, [branchId, date, tab, refetchPhotos]);

  const handlePhotoDelete = useCallback(async (photoId) => {
    if (!window.confirm('حذف هذه الصورة؟')) return;
    try {
      await client.delete(`/carrefour-damage/photos/${photoId}`);
      await refetchPhotos();
    } catch (err) {
      setPhotoError(err?.response?.data?.error || 'حدث خطأ أثناء حذف الصورة');
    }
  }, [refetchPhotos]);

  const selectedBranch = branches.find(b => String(b.id) === String(branchId));

  return (
    <div className={`cfe-page${mode.isMatrix ? ' cfe-page--wide' : ''}`}>
      <div className="cfe-header">
        <h1>{mode.pageTitle}</h1>
        <p className="cfe-subtitle">{mode.pageSubtitle}</p>
      </div>

      <div className="cfe-tabs">
        {Object.values(TABS).map(t => (
          <button
            key={t.key}
            className={`cfe-tab ${tab === t.key ? 'cfe-tab--active' : ''}`}
            onClick={() => handleTabChange(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="cfe-card cfe-filters">
        <div className="cfe-field">
          <label>الفرع</label>
          <select value={branchId} onChange={e => setBranchId(e.target.value)} className="cfe-select">
            <option value="">— اختر الفرع —</option>
            {branches.map(b => (
              <option key={b.id} value={b.id}>{b.branch_name}{b.branch_code ? ` (${b.branch_code})` : ''}</option>
            ))}
          </select>
        </div>
        <div className="cfe-field">
          <label>التاريخ</label>
          <input type="date" value={date} max={todayISO()} onChange={e => setDate(e.target.value)} className="cfe-input" />
        </div>
        {isAdmin && (
          <div className="cfe-admin-note">وضع المدير: يمكنك الإدخال نيابةً عن أي فرع.</div>
        )}
      </div>

      {!branchId && (
        <div className="cfe-card cfe-empty">
          {branches.length === 0
            ? 'لا توجد فروع مخصصة لحسابك بعد — تواصل مع الإدارة لإضافتك على فرع.'
            : 'اختر الفرع للبدء في تسجيل الجرد.'}
        </div>
      )}

      {branchId && mode.isMatrix && (
        <PriceSurveyMatrix branchId={branchId} date={date} />
      )}

      {branchId && !mode.isMatrix && entryLoading && (
        <div className="cfe-card cfe-empty">جاري تحميل البيانات…</div>
      )}

      {branchId && !mode.isMatrix && !entryLoading && (
        <div className="cfe-card">
          <div className="cfe-card__title">
            {selectedBranch?.branch_name} — {date}
            {entryData?.report && <span className="cfe-badge">تم إدخال تقرير لهذا اليوم — يمكنك تعديله</span>}
          </div>

          {items.length === 0 ? (
            <div className="cfe-empty">لا توجد أصناف في القائمة بعد — تواصل مع الإدارة لإضافة أصناف الجرد.</div>
          ) : (
            <div className="cfe-table-wrap">
              <table className="cfe-table">
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>{mode.quantityLabel}</th>
                    <th>تاريخ الانتهاء</th>
                    <th>ملاحظات</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(it => (
                    <tr key={it.id}>
                      <td>{it.item_name}</td>
                      <td>
                        <input
                          type="text" inputMode="decimal" className="cfe-qty-input"
                          placeholder="0"
                          value={quantities[it.id] ?? ''}
                          onChange={e => handleQtyChange(it.id, e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="date" className="cfe-date-input"
                          value={expiryDates[it.id] ?? ''}
                          onChange={e => handleExpiryChange(it.id, e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="text" className="cfe-note-input"
                          placeholder="ملاحظة على الصنف…"
                          value={itemNotes[it.id] ?? ''}
                          onChange={e => handleItemNoteChange(it.id, e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>الإجمالي</td>
                    <td><strong>{totalQty.toLocaleString('en-SA')}</strong></td>
                    <td></td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <div className="cfe-field cfe-notes-field">
            <label>ملاحظات عامة عن اليوم (اختياري)</label>
            <textarea
              className="cfe-textarea" rows={3}
              value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="أي ملاحظات إضافية عن جرد اليوم…"
            />
          </div>

          <div className="cfe-field cfe-photos-field">
            <label>صور مرفقة (اختياري)</label>
            <label className="cfe-photo-upload-btn">
              📷 إرفاق صور
              <input type="file" accept="image/*" multiple hidden onChange={handlePhotoSelect} disabled={uploadingPhotos} />
            </label>
            {uploadingPhotos && <span className="cfe-photo-uploading">جاري الرفع…</span>}
            {photoError && <div className="cfe-error">{photoError}</div>}
            {photos.length > 0 && (
              <div className="cfe-photo-grid">
                {photos.map(p => (
                  <div key={p.id} className="cfe-photo-thumb">
                    <a href={p.url} target="_blank" rel="noopener noreferrer">
                      <img src={p.url} alt={p.original_filename || 'صورة مرفقة'} />
                    </a>
                    <button type="button" className="cfe-photo-remove" onClick={() => handlePhotoDelete(p.id)} title="حذف الصورة">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="cfe-actions">
            <button className="cfe-btn cfe-btn--primary" onClick={handleSave} disabled={saveState === 'saving' || items.length === 0}>
              {saveState === 'saving' ? 'جاري الحفظ…' : '💾 حفظ التقرير'}
            </button>
            {saveState === 'saved' && <span className="cfe-save-ok">✓ تم الحفظ بنجاح</span>}
            {saveState === 'error' && <span className="cfe-save-err">{saveError}</span>}
          </div>

          {saveLog.length > 0 && (
            <div className="cfe-save-log">
              <div className="cfe-save-log__title">سجل التوقيع — من قام بالحفظ ومتى</div>
              <ul className="cfe-save-log__list">
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
    </div>
  );
}
