import React, { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, Upload, ChevronRight, ChevronDown, Clock, Package,
  History, Settings, Wifi, WifiOff, Eye, X, CheckCircle, AlertCircle,
  Database, BarChart3, Calendar, User, Save,
} from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './StockPage.css';

/* ── API ──────────────────────────────────────────────────────────── */
const api = {
  combined:         ()   => client.get('/stock/combined').then(r => r.data),
  areas:            ()   => client.get('/stock/areas').then(r => r.data.areas),
  snapshots:        (p)  => client.get('/stock/snapshots', { params: p }).then(r => r.data),
  snapshotDetail:   (id) => client.get(`/stock/snapshots/${id}`).then(r => r.data),
  distributions:    (p)  => client.get('/stock/distributions', { params: p }).then(r => r.data),
  distributionDetail:(id) => client.get(`/stock/distributions/${id}`).then(r => r.data),
  sync:             (d)  => client.post('/stock/sync', d).then(r => r.data),
  uploadDist:       (fd) => client.post('/stock/distribution/upload', fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data),
  testConnection:   (d)  => client.post('/stock/test-connection', d).then(r => r.data),
  getSettings:      ()   => client.get('/settings').then(r => r.data),
  saveSettings:     (v)  => client.put('/settings/netsuite_config', v).then(r => r.data),
};

const ADMIN_ROLES = ['super_admin', 'it_admin'];
const isAdmin = (user) => ADMIN_ROLES.includes(user?.role);

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-SA', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-SA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-SA', { maximumFractionDigits: 0 });
}

/* ══════════════════════════════════════════════════════════════════
   COMBINED STOCK TABLE
   ══════════════════════════════════════════════════════════════════ */
function StockTable({ data }) {
  const { items = [], areas = [], snapshot, distribution } = data;
  const [search, setSearch]   = useState('');
  const [catFilter, setCat]   = useState('');
  const [collapseAreas, setCollapseAreas] = useState(false);

  const categories = [...new Set(items.map(i => i.category).filter(Boolean))].sort();

  const filtered = items.filter(item => {
    if (catFilter && item.category !== catFilter) return false;
    if (search && !item.item_name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const hasStock = !!snapshot;
  const hasDist  = !!distribution;

  return (
    <div className="stk-table-section">
      {/* ── Info strip ── */}
      <div className="stk-info-strip">
        <div className="stk-info-chip">
          <Database size={13} />
          <span>آخر مزامنة NetSuite:</span>
          <strong>{snapshot ? fmtDateTime(snapshot.synced_at) : 'لا يوجد'}</strong>
        </div>
        <div className="stk-info-chip">
          <BarChart3 size={13} />
          <span>آخر توزيع:</span>
          <strong>{distribution ? fmtDate(distribution.distribution_date) : 'لا يوجد'}</strong>
        </div>
        <div className="stk-info-chip">
          <Package size={13} />
          <strong>{items.length}</strong><span>صنف</span>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="stk-filter-bar">
        <input
          className="stk-search"
          placeholder="بحث عن صنف..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="stk-cat-select"
          value={catFilter}
          onChange={e => setCat(e.target.value)}
        >
          <option value="">جميع الفئات</option>
          {categories.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <button
          className="stk-btn-sm stk-btn-outline"
          onClick={() => setCollapseAreas(v => !v)}
          title="إظهار/إخفاء أعمدة المناطق"
        >
          {collapseAreas ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          المناطق
        </button>
      </div>

      {/* ── Table ── */}
      {filtered.length === 0 ? (
        <div className="stk-empty">
          <Package size={36} />
          <p>{items.length === 0 ? 'لا توجد بيانات مخزون. ابدأ بمزامنة NetSuite أو رفع ملف التوزيع.' : 'لا توجد نتائج للبحث.'}</p>
        </div>
      ) : (
        <div className="stk-table-wrap">
          <table className="stk-table">
            <thead>
              <tr>
                <th className="stk-th-name stk-sticky-col">الصنف</th>
                <th className="stk-th-cat stk-sticky-col2">الفئة</th>
                {hasStock && (
                  <>
                    <th className="stk-th-stock">المخزون (On Hand)</th>
                    <th className="stk-th-stock">المتاح (Available)</th>
                  </>
                )}
                {hasDist && !collapseAreas && areas.map(area => (
                  <th key={area.id} className="stk-th-area">{area.area_name}</th>
                ))}
                {hasDist && (
                  <th className="stk-th-total">إجمالي التوزيع</th>
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.map((item, idx) => {
                const totDist = areas.reduce((s, a) => s + (item.distribution?.[a.id] || 0), 0);
                return (
                  <tr key={idx} className="stk-tr">
                    <td className="stk-td-name stk-sticky-col" title={item.item_name}>
                      {item.item_name}
                    </td>
                    <td className="stk-td-cat stk-sticky-col2">
                      {item.category || '—'}
                    </td>
                    {hasStock && (
                      <>
                        <td className={`stk-td-num ${item.qty_on_hand === 0 ? 'stk-zero' : ''}`}>
                          {fmtNum(item.qty_on_hand)}
                        </td>
                        <td className={`stk-td-num ${item.qty_available === 0 ? 'stk-zero' : ''}`}>
                          {fmtNum(item.qty_available)}
                        </td>
                      </>
                    )}
                    {hasDist && !collapseAreas && areas.map(area => {
                      const qty = item.distribution?.[area.id] || 0;
                      return (
                        <td key={area.id} className={`stk-td-area ${qty === 0 ? 'stk-zero' : ''}`}>
                          {qty > 0 ? fmtNum(qty) : '—'}
                        </td>
                      );
                    })}
                    {hasDist && (
                      <td className={`stk-td-total ${totDist === 0 ? 'stk-zero' : ''}`}>
                        {totDist > 0 ? fmtNum(totDist) : '—'}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   HISTORY TAB
   ══════════════════════════════════════════════════════════════════ */
function HistoryTab() {
  const [activeSection, setActiveSection] = useState('snapshots'); // 'snapshots' | 'distributions'
  const [selectedId, setSelectedId]       = useState(null);

  const snapshotsQ = useQuery({
    queryKey: ['stock-snapshots'],
    queryFn:  () => api.snapshots({ limit: 50 }),
  });
  const distributionsQ = useQuery({
    queryKey: ['stock-distributions'],
    queryFn:  () => api.distributions({ limit: 50 }),
  });

  const detailQ = useQuery({
    queryKey: activeSection === 'snapshots'
      ? ['stock-snap-detail', selectedId]
      : ['stock-dist-detail', selectedId],
    queryFn:  () => activeSection === 'snapshots'
      ? api.snapshotDetail(selectedId)
      : api.distributionDetail(selectedId),
    enabled: !!selectedId,
  });

  const list = activeSection === 'snapshots'
    ? (snapshotsQ.data?.snapshots  || [])
    : (distributionsQ.data?.distributions || []);

  return (
    <div className="stk-history">
      {/* Sub-tabs */}
      <div className="stk-history-tabs">
        <button
          className={`stk-history-tab ${activeSection === 'snapshots' ? 'active' : ''}`}
          onClick={() => { setActiveSection('snapshots'); setSelectedId(null); }}
        >
          <Database size={14} /> سجل NetSuite ({snapshotsQ.data?.total || 0})
        </button>
        <button
          className={`stk-history-tab ${activeSection === 'distributions' ? 'active' : ''}`}
          onClick={() => { setActiveSection('distributions'); setSelectedId(null); }}
        >
          <BarChart3 size={14} /> سجل التوزيع ({distributionsQ.data?.total || 0})
        </button>
      </div>

      <div className="stk-history-body">
        {/* Left: list */}
        <div className="stk-history-list">
          {(snapshotsQ.isLoading || distributionsQ.isLoading) ? (
            <div className="stk-loading"><RefreshCw size={16} className="stk-spin" /> جاري التحميل...</div>
          ) : list.length === 0 ? (
            <div className="stk-empty-sm">لا يوجد سجل بعد</div>
          ) : (
            list.map(row => (
              <button
                key={row.id}
                className={`stk-history-row ${selectedId === row.id ? 'active' : ''}`}
                onClick={() => setSelectedId(row.id)}
              >
                <div className="stk-history-row-top">
                  <span className="stk-history-date">
                    {fmtDate(activeSection === 'snapshots' ? row.snapshot_date : row.distribution_date)}
                  </span>
                  <span className={`stk-source-badge stk-source-${row.source || 'upload'}`}>
                    {activeSection === 'snapshots'
                      ? (row.source === 'netsuite' ? 'NetSuite' : 'يدوي')
                      : 'Excel'}
                  </span>
                </div>
                <div className="stk-history-row-meta">
                  <span><Package size={11} /> {row.item_count} صنف</span>
                  <span><Clock size={11} /> {fmtDateTime(row.synced_at || row.uploaded_at)}</span>
                </div>
                {(row.synced_by_name || row.uploaded_by_name) && (
                  <div className="stk-history-row-user">
                    <User size={11} /> {row.synced_by_name || row.uploaded_by_name}
                  </div>
                )}
              </button>
            ))
          )}
        </div>

        {/* Right: detail */}
        <div className="stk-history-detail">
          {!selectedId ? (
            <div className="stk-empty-sm">
              <Eye size={24} />
              <p>اختر سجلاً لعرض التفاصيل</p>
            </div>
          ) : detailQ.isLoading ? (
            <div className="stk-loading"><RefreshCw size={16} className="stk-spin" /> جاري التحميل...</div>
          ) : detailQ.data ? (
            <HistoryDetail
              data={detailQ.data}
              type={activeSection}
              onClose={() => setSelectedId(null)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function HistoryDetail({ data, type, onClose }) {
  const { items = [], areas = [] } = data;
  const record = type === 'snapshots' ? data.snapshot : data.distribution;

  return (
    <div className="stk-hist-detail">
      <div className="stk-hist-detail-header">
        <div>
          <div className="stk-hist-detail-date">
            {fmtDate(record?.snapshot_date || record?.distribution_date)}
          </div>
          <div className="stk-hist-detail-meta">
            {type === 'snapshots' ? (
              <>{record?.source === 'netsuite' ? 'NetSuite' : 'يدوي'} · {record?.item_count} صنف</>
            ) : (
              <>Excel · {record?.item_count} صنف</>
            )}
          </div>
        </div>
        <button className="stk-btn-icon" onClick={onClose}><X size={14} /></button>
      </div>

      <div className="stk-hist-table-wrap">
        <table className="stk-table stk-table-sm">
          <thead>
            <tr>
              <th className="stk-th-name">الصنف</th>
              <th className="stk-th-cat">الفئة</th>
              {type === 'snapshots' ? (
                <>
                  <th className="stk-th-stock">On Hand</th>
                  <th className="stk-th-stock">Available</th>
                </>
              ) : (
                areas.map(a => (
                  <th key={a.id} className="stk-th-area">{a.area_name}</th>
                ))
              )}
              {type === 'distributions' && <th className="stk-th-total">الإجمالي</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => {
              const totDist = type === 'distributions'
                ? areas.reduce((s, a) => s + (item.distribution?.[a.id] || 0), 0)
                : 0;
              return (
                <tr key={idx} className="stk-tr">
                  <td className="stk-td-name">{item.item_name}</td>
                  <td className="stk-td-cat">{item.category || '—'}</td>
                  {type === 'snapshots' ? (
                    <>
                      <td className="stk-td-num">{fmtNum(item.qty_on_hand)}</td>
                      <td className="stk-td-num">{fmtNum(item.qty_available)}</td>
                    </>
                  ) : (
                    <>
                      {areas.map(a => (
                        <td key={a.id} className="stk-td-area">
                          {(item.distribution?.[a.id] || 0) > 0 ? fmtNum(item.distribution[a.id]) : '—'}
                        </td>
                      ))}
                      <td className="stk-td-total">{totDist > 0 ? fmtNum(totDist) : '—'}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   SETTINGS TAB (admin only)
   ══════════════════════════════════════════════════════════════════ */
function SettingsTab() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const settingsQ = useQuery({
    queryKey: ['app-settings'],
    queryFn:  api.getSettings,
  });

  const initial = {
    account_id:      '',
    consumer_key:    '',
    consumer_secret: '',
    token_key:       '',
    token_secret:    '',
    saved_search_id: '',
    company_name:    '',
  };

  const [form, setForm]       = useState(null);
  const [testResult, setTest] = useState(null); // null | {ok, message/error}
  const [saved, setSaved]     = useState(false);

  // Populate form from settings once loaded
  React.useEffect(() => {
    if (settingsQ.data && !form) {
      const cfg = settingsQ.data.netsuite_config || {};
      setForm({ ...initial, ...cfg });
    }
  }, [settingsQ.data]);

  const saveMut = useMutation({
    mutationFn: (data) => api.saveSettings(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  const testMut = useMutation({
    mutationFn: (data) => api.testConnection(data),
    onSuccess:  (d) => setTest({ ok: true,  message: d.message }),
    onError:    (e) => setTest({ ok: false, message: e.response?.data?.error || e.message }),
  });

  if (!isAdmin(user)) {
    return (
      <div className="stk-empty">
        <Settings size={36} />
        <p>هذا القسم متاح للمدير فقط</p>
      </div>
    );
  }

  if (!form) return <div className="stk-loading"><RefreshCw size={16} className="stk-spin" /> جاري التحميل...</div>;

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="stk-settings">
      <div className="stk-settings-card">
        <div className="stk-settings-header">
          <Database size={18} />
          <span>إعدادات NetSuite REST API</span>
        </div>

        <div className="stk-settings-body">
          <p className="stk-settings-hint">
            احصل على هذه البيانات من: NetSuite → Setup → Integration → Manage Integrations
          </p>

          <div className="stk-field-row">
            <label>Company Name <span className="stk-optional">(اختياري)</span></label>
            <input value={form.company_name} onChange={set('company_name')} placeholder="Taryah Poultry" />
          </div>

          <div className="stk-field-row">
            <label>Account ID <span className="stk-req">*</span></label>
            <input value={form.account_id} onChange={set('account_id')} placeholder="1234567" dir="ltr" />
            <span className="stk-field-hint">مثال: 1234567 أو 1234567_SB1 للـ Sandbox</span>
          </div>

          <div className="stk-fields-2col">
            <div className="stk-field-row">
              <label>Consumer Key <span className="stk-req">*</span></label>
              <input value={form.consumer_key} onChange={set('consumer_key')} type="password" dir="ltr" />
            </div>
            <div className="stk-field-row">
              <label>Consumer Secret <span className="stk-req">*</span></label>
              <input value={form.consumer_secret} onChange={set('consumer_secret')} type="password" dir="ltr" />
            </div>
            <div className="stk-field-row">
              <label>Token Key (Access Token) <span className="stk-req">*</span></label>
              <input value={form.token_key} onChange={set('token_key')} type="password" dir="ltr" />
            </div>
            <div className="stk-field-row">
              <label>Token Secret <span className="stk-req">*</span></label>
              <input value={form.token_secret} onChange={set('token_secret')} type="password" dir="ltr" />
            </div>
          </div>

          <div className="stk-field-row">
            <label>Saved Search ID <span className="stk-optional">(اختياري)</span></label>
            <input value={form.saved_search_id} onChange={set('saved_search_id')} placeholder="customsearch1234" dir="ltr" />
            <span className="stk-field-hint">اتركه فارغاً للحصول على كل المخزون تلقائياً</span>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`stk-test-result ${testResult.ok ? 'ok' : 'err'}`}>
              {testResult.ok ? <CheckCircle size={15} /> : <AlertCircle size={15} />}
              {testResult.message}
            </div>
          )}

          <div className="stk-settings-actions">
            <button
              className="stk-btn stk-btn-outline"
              onClick={() => { setTest(null); testMut.mutate(form); }}
              disabled={testMut.isPending}
            >
              {testMut.isPending
                ? <><RefreshCw size={14} className="stk-spin" /> جاري الاختبار...</>
                : <><Wifi size={14} /> اختبار الاتصال</>
              }
            </button>
            <button
              className="stk-btn stk-btn-primary"
              onClick={() => saveMut.mutate(form)}
              disabled={saveMut.isPending}
            >
              {saveMut.isPending
                ? <><RefreshCw size={14} className="stk-spin" /> جاري الحفظ...</>
                : saved
                  ? <><CheckCircle size={14} /> تم الحفظ!</>
                  : <><Save size={14} /> حفظ الإعدادات</>
              }
            </button>
          </div>
        </div>
      </div>

      {/* Instructions card */}
      <div className="stk-settings-card stk-settings-help">
        <div className="stk-settings-header">
          <Settings size={16} />
          <span>كيفية إعداد NetSuite Integration</span>
        </div>
        <div className="stk-settings-body">
          <ol className="stk-help-list">
            <li>في NetSuite: <strong>Setup → Company → Enable Features → Suite Cloud → REST Web Services</strong> ✓</li>
            <li><strong>Setup → Integration → Manage Integrations → New</strong> — أنشئ Integration جديدة</li>
            <li>فعّل <strong>Token-Based Authentication</strong> وانسخ Consumer Key/Secret</li>
            <li><strong>Setup → Users/Roles → Access Tokens → New</strong> — أنشئ Access Token للمستخدم المناسب</li>
            <li>انسخ Token Key/Secret وأدخلها أعلاه</li>
            <li>اضغط <strong>اختبار الاتصال</strong> ثم <strong>حفظ</strong></li>
          </ol>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   UPLOAD DISTRIBUTION MODAL
   ══════════════════════════════════════════════════════════════════ */
function UploadDistModal({ onClose, onSuccess }) {
  const [file, setFile]    = useState(null);
  const [date, setDate]    = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes]  = useState('');
  const [result, setResult] = useState(null);
  const fileRef = useRef();

  const mut = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('distribution_date', date);
      fd.append('notes', notes);
      return api.uploadDist(fd);
    },
    onSuccess: (d) => {
      setResult({ ok: true, ...d });
      onSuccess();
    },
    onError: (e) => setResult({ ok: false, error: e.response?.data?.error || e.message }),
  });

  return (
    <div className="stk-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="stk-modal">
        <div className="stk-modal-header">
          <span>رفع ملف التوزيع</span>
          <button className="stk-btn-icon" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="stk-modal-body">
          <p className="stk-modal-hint">
            ارفع ملف <strong>Areas Daily Orders.xlsx</strong> أو أي ملف بنفس التنسيق.
            الصفوف الأولى: عنوان "Distribution"، سطر فارغ، ثم رؤوس الأعمدة.
          </p>

          <div className="stk-field-row">
            <label>ملف Excel <span className="stk-req">*</span></label>
            <div
              className={`stk-drop-zone ${file ? 'has-file' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); setFile(e.dataTransfer.files[0]); }}
            >
              {file ? (
                <><CheckCircle size={16} className="stk-drop-ok" /> {file.name}</>
              ) : (
                <><Upload size={16} /> اسحب الملف هنا أو انقر للاختيار</>
              )}
            </div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
              onChange={e => setFile(e.target.files[0])} />
          </div>

          <div className="stk-fields-2col">
            <div className="stk-field-row">
              <label>تاريخ التوزيع</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>
            <div className="stk-field-row">
              <label>ملاحظات <span className="stk-optional">(اختياري)</span></label>
              <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="مثال: توزيع أسبوع 3" />
            </div>
          </div>

          {result && (
            <div className={`stk-test-result ${result.ok ? 'ok' : 'err'}`}>
              {result.ok
                ? <><CheckCircle size={14} /> تم رفع الملف: {result.itemCount} صنف، {result.rowCount} سجل</>
                : <><AlertCircle size={14} /> {result.error}</>
              }
            </div>
          )}
        </div>
        <div className="stk-modal-footer">
          <button className="stk-btn stk-btn-outline" onClick={onClose}>إلغاء</button>
          <button
            className="stk-btn stk-btn-primary"
            disabled={!file || mut.isPending}
            onClick={() => mut.mutate()}
          >
            {mut.isPending
              ? <><RefreshCw size={14} className="stk-spin" /> جاري الرفع...</>
              : <><Upload size={14} /> رفع الملف</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════ */
export default function StockPage() {
  const { user }   = useAuth();
  const qc         = useQueryClient();
  const [tab, setTab] = useState('stock');
  const [showUpload, setShowUpload] = useState(false);

  const combinedQ = useQuery({
    queryKey: ['stock-combined'],
    queryFn:  api.combined,
    staleTime: 60_000,
  });

  const syncMut = useMutation({
    mutationFn: () => api.sync({}),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['stock-combined'] });
      qc.invalidateQueries({ queryKey: ['stock-snapshots'] });
    },
  });

  const admin = isAdmin(user);

  return (
    <div className="stk-page">
      {/* ── Page header ── */}
      <div className="stk-page-header">
        <div className="stk-page-title">
          <Package size={20} />
          <h1>إدارة المخزون</h1>
          <span className="stk-badge-ns">NetSuite</span>
        </div>

        {admin && tab === 'stock' && (
          <div className="stk-header-actions">
            <button
              className="stk-btn stk-btn-outline"
              onClick={() => setShowUpload(true)}
            >
              <Upload size={14} /> رفع التوزيع
            </button>
            <button
              className="stk-btn stk-btn-primary"
              onClick={() => syncMut.mutate()}
              disabled={syncMut.isPending}
              title="سحب البيانات من NetSuite الآن"
            >
              {syncMut.isPending
                ? <><RefreshCw size={14} className="stk-spin" /> جاري المزامنة...</>
                : <><RefreshCw size={14} /> مزامنة NetSuite</>
              }
            </button>
          </div>
        )}
      </div>

      {/* ── Sync error ── */}
      {syncMut.isError && (
        <div className="stk-alert stk-alert-err">
          <AlertCircle size={15} />
          {syncMut.error?.response?.data?.error || syncMut.error?.message}
        </div>
      )}
      {syncMut.isSuccess && (
        <div className="stk-alert stk-alert-ok">
          <CheckCircle size={15} />
          تمت المزامنة بنجاح
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="stk-tabs">
        {[
          { key: 'stock',    label: 'المخزون',   icon: <Package   size={15} /> },
          { key: 'history',  label: 'السجل',     icon: <History   size={15} /> },
          { key: 'settings', label: 'الإعدادات', icon: <Settings  size={15} /> },
        ].map(t => (
          <button
            key={t.key}
            className={`stk-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      <div className="stk-tab-content">
        {tab === 'stock' && (
          combinedQ.isLoading ? (
            <div className="stk-loading stk-loading-lg">
              <RefreshCw size={22} className="stk-spin" />
              <span>جاري تحميل بيانات المخزون...</span>
            </div>
          ) : combinedQ.isError ? (
            <div className="stk-empty">
              <WifiOff size={36} />
              <p>فشل في تحميل البيانات. حاول مجدداً.</p>
              <button className="stk-btn stk-btn-outline" onClick={() => combinedQ.refetch()}>
                <RefreshCw size={14} /> إعادة المحاولة
              </button>
            </div>
          ) : (
            <StockTable data={combinedQ.data || {}} />
          )
        )}
        {tab === 'history'  && <HistoryTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>

      {/* ── Upload modal ── */}
      {showUpload && (
        <UploadDistModal
          onClose={() => setShowUpload(false)}
          onSuccess={() => {
            setShowUpload(false);
            qc.invalidateQueries({ queryKey: ['stock-combined'] });
            qc.invalidateQueries({ queryKey: ['stock-distributions'] });
          }}
        />
      )}
    </div>
  );
}
