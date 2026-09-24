import React, { useState, useRef, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload as UploadIcon, CheckCircle, AlertCircle, RefreshCw, ShieldCheck, Cloud } from 'lucide-react';
import client from '../api/client';
import './QualityIssuesPage.css';

/* ── Formatters ────────────────────────────────────────────── */
const fmt = (n, dec = 0) =>
  n == null || !Number.isFinite(Number(n)) ? '—'
  : Number(n).toLocaleString('en-SA', { maximumFractionDigits: dec, minimumFractionDigits: dec ? dec : 0 });
const fmtM = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toLocaleString('en-SA', { maximumFractionDigits: 2 })}م`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toLocaleString('en-SA', { maximumFractionDigits: 1 })}ك`;
  return fmt(v);
};

/* ── KPI card ─────────────────────────────────────────────── */
function Kpi({ icon, label, value, sub, accent }) {
  return (
    <div className={`qi-kpi${accent ? ` qi-kpi--${accent}` : ''}`}>
      {icon && <span className="qi-kpi__icon">{icon}</span>}
      <div className="qi-kpi__body">
        <div className="qi-kpi__label">{label}</div>
        <div className="qi-kpi__value">{value}</div>
        {sub && <div className="qi-kpi__sub">{sub}</div>}
      </div>
    </div>
  );
}

/* ── Horizontal bar list ──────────────────────────────────── */
function HBar({ rows, valueKey, labelKey, colorClass = 'qi-bar--primary', maxBars = 12, money }) {
  const capped = (rows || []).slice(0, maxBars);
  const max = Math.max(...capped.map(r => Number(r[valueKey]) || 0), 1);
  return (
    <div className="qi-hbar">
      {capped.map((r, i) => (
        <div key={i} className="qi-hbar__row">
          <span className="qi-hbar__label" title={r[labelKey]}>{r[labelKey]}</span>
          <div className="qi-hbar__track">
            <div className={`qi-hbar__fill ${colorClass}`}
                 style={{ width: `${((Number(r[valueKey]) || 0) / max * 100).toFixed(1)}%` }} />
          </div>
          <span className="qi-hbar__val">{money ? fmtM(r[valueKey]) : fmt(r[valueKey])}</span>
        </div>
      ))}
      {!capped.length && <div className="qi-empty">لا توجد بيانات</div>}
    </div>
  );
}

/* ── Compact inline upload box ───────────────────────────── */
function QuickUpload({ onDone }) {
  const fileRef = useRef(null);
  const [phase, setPhase] = useState('idle');
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState(null);
  const [errMsg, setErrMsg] = useState('');
  const [fname, setFname] = useState('');

  const doUpload = async (file) => {
    if (!file) return;
    setPhase('uploading'); setPct(0); setResult(null); setErrMsg('');
    const form = new FormData();
    form.append('file', file);
    try {
      const { data } = await client.post('/quality-issues/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => e.total && setPct(Math.round((e.loaded / e.total) * 100)),
      });
      setResult(data);
      setPhase('success');
      onDone?.();
    } catch (err) {
      setErrMsg(err.response?.data?.error || err.message || 'فشل الرفع');
      setPhase('error');
    }
  };

  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFname(file.name);
    await doUpload(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  const reset = () => { setPhase('idle'); setPct(0); setResult(null); setErrMsg(''); setFname(''); };

  return (
    <div className="qi-upload">
      <div className="qi-upload__title"><ShieldCheck size={16} /> رفع تقرير توالف الجودة</div>
      <div className="qi-upload__hint">QualityIssuesQuantityandCost.xls — يمكن إعادة الرفع دوريًا، يتم دمج البيانات تلقائيًا دون تكرار</div>

      {phase === 'idle' && (
        <div className="qi-upload__actions">
          <label className={`qi-upload__file-label${fname ? ' has-file' : ''}`}>
            <span style={{ fontSize: 18 }}>📎</span>
            <span className="qi-upload__file-name">{fname || 'اختر ملف Excel…'}</span>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleChange} hidden />
          </label>
          <button className="btn-primary qi-upload__btn" onClick={() => fileRef.current?.click()}>
            <UploadIcon size={14} /> رفع الملف
          </button>
        </div>
      )}

      {phase === 'uploading' && (
        <div className="qi-upload__progress">
          <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>{pct}% — جاري المعالجة…</div>
          </div>
        </div>
      )}

      {phase === 'success' && result && (
        <div className="qi-upload__result qi-upload__result--success">
          <CheckCircle size={16} />
          <span>
            تمت المعالجة: <strong>{Number(result.rowsProcessed).toLocaleString('en-SA')}</strong> سجل
            {result.rowsSkipped > 0 && <span style={{ color: 'var(--color-warning)' }}> · تخطي: {result.rowsSkipped}</span>}
          </span>
          <button className="clear-btn" onClick={reset} style={{ marginRight: 'auto' }}>رفع آخر</button>
        </div>
      )}

      {phase === 'error' && (
        <div className="qi-upload__result qi-upload__result--error">
          <AlertCircle size={16} />
          <span>{errMsg}</span>
          <button className="chip-btn" onClick={reset} style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            <RefreshCw size={12} /> إعادة المحاولة
          </button>
        </div>
      )}
    </div>
  );
}

/* ── NetSuite live sync ───────────────────────────────────────
   Fetches the same "Quality Issues Quantity and Cost" report live from
   NetSuite instead of a manual .xls upload, UPSERTing on the same
   (document_number, item_name, issue_date) key — running this and
   uploading a file never duplicates rows. Kept as its OWN button rather
   than replacing the upload box, so a manual re-upload still works if
   the NetSuite link ever changes or is unreachable. */
function NetSuiteSync({ onDone }) {
  const [phase, setPhase]     = useState('idle');
  const [result, setResult]   = useState(null);
  const [errMsg, setErrMsg]   = useState('');

  const doSync = async () => {
    setPhase('syncing'); setResult(null); setErrMsg('');
    try {
      const { data } = await client.post('/quality-issues/sync-netsuite');
      setResult(data);
      setPhase('success');
      onDone?.();
    } catch (err) {
      setErrMsg(err.response?.data?.error || err.message || 'فشلت المزامنة');
      setPhase('error');
    }
  };

  const reset = () => { setPhase('idle'); setResult(null); setErrMsg(''); };

  return (
    <div className="qi-upload">
      <div className="qi-upload__title"><Cloud size={16} /> مزامنة مباشرة مع NetSuite</div>
      <div className="qi-upload__hint">يجلب نفس التقرير مباشرة من NetSuite بدون رفع ملف — يتم الدمج تلقائياً دون تكرار</div>

      {phase === 'idle' && (
        <div className="qi-upload__actions">
          <button className="btn-primary qi-upload__btn" onClick={doSync}>
            <Cloud size={14} /> مزامنة الآن
          </button>
        </div>
      )}

      {phase === 'syncing' && (
        <div className="qi-upload__progress">
          <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2, flexShrink: 0 }} />
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>جارٍ الجلب من NetSuite…</div>
        </div>
      )}

      {phase === 'success' && result && (
        <div className="qi-upload__result qi-upload__result--success">
          <CheckCircle size={16} />
          <span>
            تمت المزامنة: <strong>{Number(result.rowsProcessed).toLocaleString('en-SA')}</strong> سجل
            {result.rowsSkipped > 0 && <span style={{ color: 'var(--color-warning)' }}> · تخطي: {result.rowsSkipped}</span>}
          </span>
          <button className="clear-btn" onClick={reset} style={{ marginRight: 'auto' }}>مزامنة أخرى</button>
        </div>
      )}

      {phase === 'error' && (
        <div className="qi-upload__result qi-upload__result--error">
          <AlertCircle size={16} />
          <span>{errMsg}</span>
          <button className="chip-btn" onClick={reset} style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            <RefreshCw size={12} /> إعادة المحاولة
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────── */
export default function QualityIssuesPage() {
  const qc = useQueryClient();
  const [regionId, setRegionId]   = useState('');
  const [itemType, setItemType]   = useState('');
  const [from, setFrom]           = useState('');
  const [to, setTo]               = useState('');

  const { data: filters } = useQuery({
    queryKey: ['quality-issues-filters'],
    queryFn: () => client.get('/quality-issues/filters').then(r => r.data),
    staleTime: 60_000,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['quality-issues-summary', regionId, itemType, from, to],
    queryFn: () => client.get('/quality-issues/summary', {
      params: { region_id: regionId || undefined, item_type: itemType || undefined, from: from || undefined, to: to || undefined },
    }).then(r => r.data),
    staleTime: 30_000,
  });

  const refreshAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['quality-issues-summary'] });
    qc.invalidateQueries({ queryKey: ['quality-issues-filters'] });
  }, [qc]);

  const totals = data?.totals;
  const monthly = data?.monthly || [];
  const byRegion = data?.by_region || [];
  const byItem = data?.by_item || [];
  const itemMonthly = data?.item_monthly || [];

  /* Region × month cost matrix — the requested "monthly trend per region",
     with per-item detail rows nested under each region. */
  const { months, regionRows, totalsByMonth, grandCost, grandQty } = useMemo(() => {
    const monthKeys = [];
    const monthLabels = {};
    monthly.forEach(m => {
      const key = `${m.year}-${String(m.month).padStart(2, '0')}`;
      if (!monthLabels[key]) { monthLabels[key] = m.month_name; monthKeys.push(key); }
    });
    monthKeys.sort();

    const byRegionKey = {};
    const totalsByMonth = {};
    let grandCost = 0, grandQty = 0;
    monthly.forEach(m => {
      const rKey = m.region_id ?? `_${m.region_name}`;
      if (!byRegionKey[rKey]) byRegionKey[rKey] = { key: String(rKey), region_name: m.region_name, cells: {}, total_cost: 0, total_qty: 0, items: {} };
      const key = `${m.year}-${String(m.month).padStart(2, '0')}`;
      const cost = Number(m.total_cost) || 0;
      const qty  = Number(m.quantity) || 0;
      byRegionKey[rKey].cells[key] = { cost, qty };
      byRegionKey[rKey].total_cost += cost;
      byRegionKey[rKey].total_qty  += qty;

      if (!totalsByMonth[key]) totalsByMonth[key] = { cost: 0, qty: 0 };
      totalsByMonth[key].cost += cost;
      totalsByMonth[key].qty  += qty;
      grandCost += cost;
      grandQty  += qty;
    });

    itemMonthly.forEach(m => {
      const rKey = m.region_id ?? `_${m.region_name}`;
      const region = byRegionKey[rKey];
      if (!region) return;
      const key = `${m.year}-${String(m.month).padStart(2, '0')}`;
      const cost = Number(m.total_cost) || 0;
      const qty  = Number(m.quantity) || 0;
      if (!region.items[m.item_name]) region.items[m.item_name] = { item_name: m.item_name, cells: {}, total_cost: 0, total_qty: 0 };
      const item = region.items[m.item_name];
      if (!item.cells[key]) item.cells[key] = { cost: 0, qty: 0 };
      item.cells[key].cost += cost;
      item.cells[key].qty  += qty;
      item.total_cost += cost;
      item.total_qty  += qty;
    });

    const rows = Object.values(byRegionKey)
      .map(r => ({ ...r, items: Object.values(r.items).sort((a, b) => b.total_cost - a.total_cost) }))
      .sort((a, b) => b.total_cost - a.total_cost);
    return {
      months: monthKeys.map(k => ({ key: k, label: monthLabels[k] })),
      regionRows: rows,
      totalsByMonth,
      grandCost,
      grandQty,
    };
  }, [monthly, itemMonthly]);

  /* Expand/collapse per-region item detail */
  const [expandedRegions, setExpandedRegions] = useState(() => new Set());
  const toggleRegion = (key) => setExpandedRegions(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const [matrixMetric, setMatrixMetric] = useState('cost'); // 'cost' | 'qty' | 'both'
  const renderCell = (cell) => {
    if (!cell) return <span className="qi-matrix-dash">—</span>;
    if (matrixMetric === 'both') {
      return (
        <span className="qi-matrix-both">
          <span className="qi-matrix-qty">{fmtM(cell.cost)}</span>
          <span className="qi-matrix-sub">{fmt(cell.qty)} وحدة</span>
        </span>
      );
    }
    return <span className="qi-matrix-qty">{matrixMetric === 'qty' ? fmt(cell.qty) : fmtM(cell.cost)}</span>;
  };

  return (
    <div className="qi-page">
      <div className="qi-header">
        <h1 className="qi-title"><ShieldCheck size={22} /> توالف الجودة</h1>
        <p className="qi-subtitle">تقييم مشاكل توالف الجودة (كمية وتكلفة) حسب المنطقة، مع ترند شهري — الهدف تقليل التوالف لأدنى معدلات</p>
      </div>

      <div className="qi-upload-row">
        <QuickUpload onDone={refreshAll} />
        <NetSuiteSync onDone={refreshAll} />
      </div>

      <div className="qi-filters">
        <select className="qi-select" value={regionId} onChange={e => setRegionId(e.target.value)}>
          <option value="">كل المناطق</option>
          {(filters?.regions || []).map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
        </select>
        <select className="qi-select" value={itemType} onChange={e => setItemType(e.target.value)}>
          <option value="">كل الأصناف</option>
          {(filters?.item_types || []).map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input type="date" className="qi-date" value={from} onChange={e => setFrom(e.target.value)} />
        <span className="qi-filters__sep">إلى</span>
        <input type="date" className="qi-date" value={to} onChange={e => setTo(e.target.value)} />
        {(regionId || itemType || from || to) && (
          <button className="chip-btn" onClick={() => { setRegionId(''); setItemType(''); setFrom(''); setTo(''); }}>
            مسح الفلاتر
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="qi-empty">جاري التحميل…</div>
      ) : (
        <>
          <div className="qi-kpis">
            <Kpi icon="📋" label="عدد المشاكل" value={fmt(totals?.issue_count)} accent="primary" />
            <Kpi icon="📦" label="إجمالي الكمية المتضررة" value={fmtM(totals?.quantity)} accent="warning" />
            <Kpi icon="💰" label="إجمالي التكلفة" value={fmtM(totals?.total_cost)} sub="ريال" accent="danger" />
            <Kpi icon="🗺️" label="عدد المناطق المتأثرة" value={fmt(totals?.region_count)} accent="info" />
          </div>

          <div className="qi-grid-2">
            <div className="qi-card">
              <h3 className="qi-card__title">التكلفة حسب المنطقة</h3>
              <HBar rows={byRegion} valueKey="total_cost" labelKey="region_name" money colorClass="qi-bar--danger" />
            </div>
            <div className="qi-card">
              <h3 className="qi-card__title">أعلى الأصناف تضررًا (تكلفة)</h3>
              <HBar rows={byItem} valueKey="total_cost" labelKey="item_name" money colorClass="qi-bar--warning" />
            </div>
          </div>

          <div className="qi-card">
            <div className="qi-card__header">
              <h3 className="qi-card__title">الترند الشهري للتوالف حسب المنطقة</h3>
              <div className="qi-metric-toggle">
                <button className={matrixMetric === 'cost' ? 'active' : ''} onClick={() => setMatrixMetric('cost')}>التكلفة</button>
                <button className={matrixMetric === 'qty' ? 'active' : ''} onClick={() => setMatrixMetric('qty')}>الكمية</button>
                <button className={matrixMetric === 'both' ? 'active' : ''} onClick={() => setMatrixMetric('both')}>كلاهما</button>
              </div>
            </div>
            {!months.length ? (
              <div className="qi-empty">لا توجد بيانات</div>
            ) : (
              <div className="qi-matrix-wrap">
                <table className="qi-matrix-table">
                  <thead>
                    <tr>
                      <th className="qi-matrix-th-item">المنطقة</th>
                      {months.map(m => <th key={m.key} className="qi-matrix-th-month">{m.label}</th>)}
                      <th className="qi-matrix-th-total">الإجمالي</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regionRows.map(r => {
                      const open = expandedRegions.has(r.key);
                      return (
                        <React.Fragment key={r.key}>
                          <tr className="qi-matrix-region-row" onClick={() => toggleRegion(r.key)}
                              title={open ? 'إخفاء تفاصيل الأصناف' : 'عرض تفاصيل الأصناف'}>
                            <td className="qi-matrix-td-item">
                              <span className="qi-matrix-chevron">{open ? '▾' : '◂'}</span> {r.region_name}
                              <span className="qi-matrix-items-count">({r.items.length} صنف)</span>
                            </td>
                            {months.map(m => (
                              <td key={m.key} className="qi-matrix-td-cell">{renderCell(r.cells[m.key])}</td>
                            ))}
                            <td className="qi-matrix-td-total">{renderCell({ cost: r.total_cost, qty: r.total_qty })}</td>
                          </tr>
                          {open && r.items.map(it => (
                            <tr key={`${r.key}-${it.item_name}`} className="qi-matrix-item-row">
                              <td className="qi-matrix-td-item qi-matrix-td-item--sub">{it.item_name}</td>
                              {months.map(m => (
                                <td key={m.key} className="qi-matrix-td-cell qi-matrix-td-cell--sub">{renderCell(it.cells[m.key])}</td>
                              ))}
                              <td className="qi-matrix-td-total qi-matrix-td-total--sub">{renderCell({ cost: it.total_cost, qty: it.total_qty })}</td>
                            </tr>
                          ))}
                        </React.Fragment>
                      );
                    })}
                    {!regionRows.length && <tr><td colSpan={months.length + 2} className="qi-empty">لا توجد بيانات</td></tr>}
                  </tbody>
                  <tfoot>
                    <tr className="qi-matrix-tf-row">
                      <td className="qi-matrix-td-item qi-matrix-td-item--tf">الإجمالي</td>
                      {months.map(m => (
                        <td key={m.key} className="qi-matrix-td-total">{renderCell(totalsByMonth[m.key])}</td>
                      ))}
                      <td className="qi-matrix-td-total qi-matrix-td-grand">
                        {renderCell({ cost: grandCost, qty: grandQty })}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
