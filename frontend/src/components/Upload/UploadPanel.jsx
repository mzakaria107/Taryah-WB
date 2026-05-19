import React, { useRef, useState, useEffect } from 'react';
import { Upload, CheckCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import client from '../../api/client';
import './UploadPanel.css';

/* ── Single upload row ───────────────────────────── */
function UploadRow({ title, endpoint, hint }) {
  const fileRef   = useRef(null);
  const qc        = useQueryClient();
  const [phase,   setPhase]   = useState('idle');    // idle | uploading | success | error
  const [pct,     setPct]     = useState(0);
  const [result,  setResult]  = useState(null);
  const [errMsg,  setErrMsg]  = useState('');
  const [fname,   setFname]   = useState('');
  const [batches, setBatches] = useState([]);

  const loadBatches = () => {
    client.get('/upload/batches')
      .then(({ data }) => setBatches(data.slice(0, 3)))
      .catch(() => {});
  };

  useEffect(() => { loadBatches(); }, []);

  const doUpload = async (file) => {
    if (!file) return;
    setPhase('uploading'); setPct(0); setResult(null); setErrMsg('');
    const form = new FormData();
    form.append('file', file);
    try {
      const { data } = await client.post(endpoint, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => e.total && setPct(Math.round((e.loaded / e.total) * 100)),
      });
      setResult(data);
      setPhase('success');
      loadBatches();
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['kpis'] });
      qc.invalidateQueries({ queryKey: ['years'] });
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'فشل الرفع';
      setErrMsg(msg);
      setPhase('error');
    }
  };

  const handlePick = (e) => {
    const file = e.target.files?.[0];
    if (file) { setFname(file.name); }
    e.target.value = '';
  };

  const handleUpload = () => {
    const file = fileRef.current?.files?.[0]
      ?? (fname ? null : null); // fallback
    // Re-trigger via hidden input click → then pick
    fileRef.current?.click();
  };

  // Separate: when file chosen, auto-upload
  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFname(file.name);
    await doUpload(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  const reset = () => { setPhase('idle'); setPct(0); setResult(null); setErrMsg(''); setFname(''); };

  const isLarge = fname?.toLowerCase().includes('balance') || fname?.toLowerCase().includes('customer');

  return (
    <div className="upload-row">
      <div className="upload-row__title">{title}</div>
      <div className="upload-row__hint">{hint}</div>

      {/* Pick + upload button */}
      {phase === 'idle' && (
        <div className="upload-row__actions">
          <label className={`upload-file-label${fname ? ' has-file' : ''}`}>
            <span style={{ fontSize: 18 }}>📎</span>
            <span className="upload-file-name">{fname || 'اختر ملف Excel…'}</span>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleChange} hidden />
          </label>
          <button className="btn-primary upload-btn" onClick={() => fileRef.current?.click()}>
            <Upload size={14} />
            رفع الملف
          </button>
        </div>
      )}

      {/* Progress */}
      {phase === 'uploading' && (
        <div className="upload-row__progress">
          <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
              {pct}% {isLarge ? '— الملف كبير، قد يستغرق دقيقة أو دقيقتين…' : ''}
            </div>
          </div>
        </div>
      )}

      {/* Success */}
      {phase === 'success' && result && (
        <div className="upload-row__result upload-row__result--success">
          <CheckCircle size={16} />
          <span style={{ display:'flex', flexWrap:'wrap', gap:'6px 12px', alignItems:'center' }}>
            {/* Customer balance result */}
            {result.rowsProcessed !== undefined && result.invoicesRelinked === undefined && (
              <>
                تمت المعالجة: <strong>{Number(result.rowsProcessed).toLocaleString('en-SA')}</strong> فاتورة
                {result.rowsSkipped > 0 && (
                  <span style={{ color:'var(--color-warning)' }}>· تخطي: {result.rowsSkipped}</span>
                )}
              </>
            )}
            {/* RouteMaster result */}
            {result.invoicesRelinked !== undefined && (
              <>
                <strong>{Number(result.routesUpserted).toLocaleString('en-SA')}</strong> مسار
                {result.regionsInserted > 0 && <span>· <strong>{result.regionsInserted}</strong> منطقة جديدة</span>}
                {result.regionsUpdated  > 0 && <span>· <strong>{result.regionsUpdated}</strong> منطقة محدّثة</span>}
                · <strong>{Number(result.invoicesRelinked).toLocaleString('en-SA')}</strong> فاتورة تم ربطها
              </>
            )}
          </span>
          <button className="clear-btn" onClick={reset} style={{ marginRight: 'auto' }}>رفع آخر</button>
        </div>
      )}

      {/* Errors detail */}
      {phase === 'success' && result?.errors?.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 11, color: 'var(--color-danger)', cursor: 'pointer' }}>
            {result.errors.length} أخطاء في الاستيراد ▾
          </summary>
          <div style={{ maxHeight: 100, overflowY: 'auto', marginTop: 4 }}>
            {result.errors.map((e, i) => (
              <div key={i} style={{ fontSize: 10, color: 'var(--color-danger)', lineHeight: 1.6 }}>
                صف {e.row}: {e.error}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Error */}
      {phase === 'error' && (
        <div className="upload-row__result upload-row__result--error">
          <AlertCircle size={16} />
          <span>{errMsg}</span>
          <button className="chip-btn" onClick={reset} style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            <RefreshCw size={12} /> إعادة المحاولة
          </button>
        </div>
      )}

      {/* Recent batches mini-list */}
      {batches.length > 0 && (
        <div className="upload-row__history">
          <div className="upload-row__history-title">آخر الرفعات</div>
          {batches.map((b) => (
            <div key={b.id} className="upload-row__batch">
              <span className="batch-name">{b.file_name}</span>
              <span className={`batch-status batch-status--${b.status}`}>
                {b.status === 'success'
                  ? `✓ ${Number(b.row_count || 0).toLocaleString('en-SA')}`
                  : b.status === 'processing' ? '⟳'
                  : '✗'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Payment upload row — uses /payments/upload endpoint ── */
function PaymentUploadRow() {
  const fileRef  = useRef(null);
  const [phase,  setPhase]  = useState('idle');
  const [pct,    setPct]    = useState(0);
  const [result, setResult] = useState(null);
  const [errMsg, setErrMsg] = useState('');
  const [fname,  setFname]  = useState('');

  const doUpload = async (file) => {
    if (!file) return;
    setPhase('uploading'); setPct(0); setResult(null); setErrMsg('');
    const form = new FormData();
    form.append('file', file);
    try {
      const { data } = await client.post('/payments/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => e.total && setPct(Math.round((e.loaded / e.total) * 100)),
      });
      setResult(data);
      setPhase('success');
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
    <div className="upload-row">
      <div className="upload-row__title">حركات السداد اليومية</div>
      <div className="upload-row__hint">Route Invoice Collection Payment.xlsx</div>

      {phase === 'idle' && (
        <div className="upload-row__actions">
          <label className={`upload-file-label${fname ? ' has-file' : ''}`}>
            <span style={{ fontSize: 18 }}>💳</span>
            <span className="upload-file-name">{fname || 'اختر ملف Excel…'}</span>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleChange} hidden />
          </label>
          <button className="btn-primary upload-btn" onClick={() => fileRef.current?.click()}>
            <Upload size={14} />
            رفع الملف
          </button>
        </div>
      )}

      {phase === 'uploading' && (
        <div className="upload-row__progress">
          <div className="spinner" style={{ width:20, height:20, borderWidth:2, flexShrink:0 }} />
          <div style={{ flex:1 }}>
            <div className="bar"><div className="bar-fill" style={{ width:`${pct}%` }} /></div>
            <div style={{ fontSize:12, color:'var(--color-text-muted)', marginTop:4 }}>
              {pct}% — الملف كبير، قد يستغرق دقيقة أو دقيقتين…
            </div>
          </div>
        </div>
      )}

      {phase === 'success' && result && (
        <div className="upload-row__result upload-row__result--success">
          <CheckCircle size={16} />
          <span style={{ display:'flex', flexWrap:'wrap', gap:'6px 12px', alignItems:'center' }}>
            تمت المعالجة: <strong>{Number(result.rowsProcessed).toLocaleString('en-SA')}</strong> معاملة
            {result.rowsSkipped > 0 && (
              <span style={{ color:'var(--color-warning)' }}>· تخطي: {result.rowsSkipped}</span>
            )}
          </span>
          <button className="clear-btn" onClick={reset} style={{ marginRight:'auto' }}>رفع آخر</button>
        </div>
      )}

      {phase === 'error' && (
        <div className="upload-row__result upload-row__result--error">
          <AlertCircle size={16} />
          <span>{errMsg}</span>
          <button className="chip-btn" onClick={reset} style={{ marginRight:'auto', display:'flex', alignItems:'center', gap:4 }}>
            <RefreshCw size={12} /> إعادة المحاولة
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Sales Activity upload row — posts to /sales-activity/upload ── */
function SalesActivityUploadRow() {
  const fileRef  = useRef(null);
  const qc       = useQueryClient();
  const [phase,  setPhase]  = useState('idle');
  const [pct,    setPct]    = useState(0);
  const [result, setResult] = useState(null);
  const [errMsg, setErrMsg] = useState('');
  const [fname,  setFname]  = useState('');

  const doUpload = async (file) => {
    if (!file) return;
    setPhase('uploading'); setPct(0); setResult(null); setErrMsg('');
    const form = new FormData();
    form.append('file', file);
    try {
      const { data } = await client.post('/sales-activity/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => e.total && setPct(Math.round((e.loaded / e.total) * 100)),
      });
      setResult(data);
      setPhase('success');
      qc.invalidateQueries({ queryKey: ['sales-report'] });
      qc.invalidateQueries({ queryKey: ['sales-new-customers'] });
      qc.invalidateQueries({ queryKey: ['sales-meta'] });
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
    <div className="upload-row">
      <div className="upload-row__title">تقرير العملاء المتعاملة (CSV)</div>
      <div className="upload-row__hint">CSV بنفس تنسيق تقرير العملاء المتعاملة والغير متعاملة</div>

      {phase === 'idle' && (
        <div className="upload-row__actions">
          <label className={`upload-file-label${fname ? ' has-file' : ''}`}>
            <span style={{ fontSize: 18 }}>👥</span>
            <span className="upload-file-name">{fname || 'اختر ملف CSV…'}</span>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleChange} hidden />
          </label>
          <button className="btn-primary upload-btn" onClick={() => fileRef.current?.click()}>
            <Upload size={14} />
            رفع الملف
          </button>
        </div>
      )}

      {phase === 'uploading' && (
        <div className="upload-row__progress">
          <div className="spinner" style={{ width:20, height:20, borderWidth:2, flexShrink:0 }} />
          <div style={{ flex:1 }}>
            <div className="bar"><div className="bar-fill" style={{ width:`${pct}%` }} /></div>
            <div style={{ fontSize:12, color:'var(--color-text-muted)', marginTop:4 }}>
              {pct}% — جاري المعالجة…
            </div>
          </div>
        </div>
      )}

      {phase === 'success' && result && (
        <div className="upload-row__result upload-row__result--success">
          <CheckCircle size={16} />
          <span style={{ display:'flex', flexWrap:'wrap', gap:'6px 12px', alignItems:'center' }}>
            إجمالي: <strong>{Number(result.total).toLocaleString('en-SA')}</strong> صف
            {result.inserted > 0 && <span>· جديد: <strong>{Number(result.inserted).toLocaleString('en-SA')}</strong></span>}
            {result.updated  > 0 && <span>· محدَّث: <strong>{Number(result.updated).toLocaleString('en-SA')}</strong></span>}
          </span>
          <button className="clear-btn" onClick={reset} style={{ marginRight:'auto' }}>رفع آخر</button>
        </div>
      )}

      {phase === 'success' && result?.errors?.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 11, color: 'var(--color-danger)', cursor: 'pointer' }}>
            {result.errors.length} أخطاء في الاستيراد ▾
          </summary>
          <div style={{ maxHeight: 100, overflowY: 'auto', marginTop: 4 }}>
            {result.errors.map((e, i) => (
              <div key={i} style={{ fontSize: 10, color: 'var(--color-danger)', lineHeight: 1.6 }}>
                صف {e.row}: {e.error}
              </div>
            ))}
          </div>
        </details>
      )}

      {phase === 'error' && (
        <div className="upload-row__result upload-row__result--error">
          <AlertCircle size={16} />
          <span>{errMsg}</span>
          <button className="chip-btn" onClick={reset} style={{ marginRight:'auto', display:'flex', alignItems:'center', gap:4 }}>
            <RefreshCw size={12} /> إعادة المحاولة
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Exported panel with four rows ────────────────── */
export default function UploadPanel() {
  return (
    <div className="upload-panel">
      <div className="upload-panel__header">
        <h2 className="upload-panel__title">رفع ملفات Excel</h2>
        <span className="upload-panel__badge">يدعم .xlsx حتى 50 ميجابايت</span>
      </div>
      <div className="upload-panel__grid">
        <UploadRow
          title="أرصدة العملاء"
          hint="customerBalanceDues.xlsx"
          endpoint="/upload/customer-balance"
        />
        <UploadRow
          title="دليل المسارات"
          hint="RouteMaster.xlsx"
          endpoint="/upload/route-master"
        />
        <PaymentUploadRow />
        <SalesActivityUploadRow />
      </div>
    </div>
  );
}
