import React, { useRef, useState, useCallback } from 'react';
import { Upload, CheckCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import client from '../../api/client';
import './UploadPanel.css';

/* ── Mini history list shared by all cards ───────── */
function MiniHistory({ fileType }) {
  const { data: batches = [] } = useQuery({
    queryKey:  ['upload-batches', fileType],
    queryFn:   () => client.get(`/upload/batches?file_type=${fileType}`).then(r => r.data.slice(0, 3)),
    staleTime: 30_000,
  });

  if (!batches.length) return null;

  return (
    <div className="upload-row__history">
      <div className="upload-row__history-title">آخر الرفعات</div>
      {batches.map((b) => (
        <div key={b.id} className="upload-row__batch">
          <span className="batch-name">{b.file_name}</span>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'var(--font-en)' }}>
            {b.created_at ? new Date(b.created_at).toLocaleString('ar-SA', { dateStyle: 'short', timeStyle: 'short' }) : ''}
          </span>
          <span className={`batch-status batch-status--${b.status}`}>
            {b.status === 'success'
              ? `✓ ${Number(b.row_count || 0).toLocaleString('en-SA')}`
              : b.status === 'processing' ? '⟳'
              : '✗'}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Generic upload card ─────────────────────────── */
function UploadCard({ title, hint, endpoint, fileType, accept, icon, invalidateKeys = [] }) {
  const fileRef  = useRef(null);
  const qc       = useQueryClient();
  const [phase,  setPhase]  = useState('idle');
  const [pct,    setPct]    = useState(0);
  const [result, setResult] = useState(null);
  const [errMsg, setErrMsg] = useState('');
  const [fname,  setFname]  = useState('');

  const refreshHistory = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['upload-batches', fileType] });
    qc.invalidateQueries({ queryKey: ['upload-history'] });
  }, [qc, fileType]);

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
      refreshHistory();
      invalidateKeys.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
    } catch (err) {
      setErrMsg(err.response?.data?.error || err.message || 'فشل الرفع');
      setPhase('error');
      refreshHistory(); // refresh even on error — batch was created with 'failed' status
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

  const isLarge = fname?.toLowerCase().includes('balance') || fname?.toLowerCase().includes('customer')
               || fname?.toLowerCase().includes('payment') || fileType === 'payments';

  return (
    <div className="upload-row">
      <div className="upload-row__title">{title}</div>
      <div className="upload-row__hint">{hint}</div>

      {/* Idle */}
      {phase === 'idle' && (
        <div className="upload-row__actions">
          <label className={`upload-file-label${fname ? ' has-file' : ''}`}>
            <span style={{ fontSize: 18 }}>{icon}</span>
            <span className="upload-file-name">{fname || `اختر ملف ${accept?.includes('csv') ? 'CSV' : 'Excel'}…`}</span>
            <input ref={fileRef} type="file" accept={accept || '.xlsx,.xls'} onChange={handleChange} hidden />
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
            <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
              {pct}% {isLarge ? '— الملف كبير، قد يستغرق دقيقة أو دقيقتين…' : '— جاري المعالجة…'}
            </div>
          </div>
        </div>
      )}

      {/* Success */}
      {phase === 'success' && result && (
        <div className="upload-row__result upload-row__result--success">
          <CheckCircle size={16} />
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', alignItems: 'center' }}>
            {/* customer_balance */}
            {result.rowsProcessed !== undefined && result.invoicesRelinked === undefined && result.inserted === undefined && (
              <>
                تمت المعالجة: <strong>{Number(result.rowsProcessed).toLocaleString('en-SA')}</strong> سجل
                {result.rowsSkipped > 0 && <span style={{ color: 'var(--color-warning)' }}>· تخطي: {result.rowsSkipped}</span>}
              </>
            )}
            {/* route_master */}
            {result.invoicesRelinked !== undefined && (
              <>
                <strong>{Number(result.routesUpserted).toLocaleString('en-SA')}</strong> مسار
                {result.regionsInserted > 0 && <span>· <strong>{result.regionsInserted}</strong> منطقة جديدة</span>}
                {result.regionsUpdated  > 0 && <span>· <strong>{result.regionsUpdated}</strong> منطقة محدّثة</span>}
                · <strong>{Number(result.invoicesRelinked).toLocaleString('en-SA')}</strong> فاتورة تم ربطها
              </>
            )}
            {/* sales_activity */}
            {result.inserted !== undefined && (
              <>
                إجمالي: <strong>{Number(result.total).toLocaleString('en-SA')}</strong> صف
                {result.inserted > 0 && <span>· جديد: <strong>{Number(result.inserted).toLocaleString('en-SA')}</strong></span>}
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

      {/* Per-type history */}
      <MiniHistory fileType={fileType} />
    </div>
  );
}

/* ── Exported panel with four cards ─────────────── */
export default function UploadPanel() {
  return (
    <div className="upload-panel">
      <div className="upload-panel__header">
        <h2 className="upload-panel__title">رفع ملفات Excel</h2>
        <span className="upload-panel__badge">يدعم .xlsx حتى 50 ميجابايت</span>
      </div>
      <div className="upload-panel__grid">
        <UploadCard
          title="أرصدة العملاء"
          hint="customerBalanceDues.xlsx"
          endpoint="/upload/customer-balance"
          fileType="customer_balance"
          icon="📎"
          invalidateKeys={['invoices', 'kpis', 'years']}
        />
        <UploadCard
          title="دليل المسارات"
          hint="RouteMaster.xlsx"
          endpoint="/upload/route-master"
          fileType="route_master"
          icon="📎"
          invalidateKeys={['invoices']}
        />
        <UploadCard
          title="حركات السداد اليومية"
          hint="Route Invoice Collection Payment.xlsx"
          endpoint="/payments/upload"
          fileType="payments"
          icon="💳"
          invalidateKeys={[]}
        />
        <UploadCard
          title="تقرير العملاء المتعاملة (CSV)"
          hint="CSV بنفس تنسيق تقرير العملاء المتعاملة والغير متعاملة"
          endpoint="/sales-activity/upload"
          fileType="sales_activity"
          accept=".csv,.xlsx,.xls"
          icon="👥"
          invalidateKeys={['sales-report', 'sales-new-customers', 'sales-meta']}
        />
      </div>
    </div>
  );
}
