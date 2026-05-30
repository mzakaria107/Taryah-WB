import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Download, Users, History, X, GripVertical, Eye, EyeOff, Printer } from 'lucide-react';
import client from '../api/client';
import SalesActivityKPI  from './SalesActivityKPI';
import SalesPieCharts    from './SalesPieCharts';
import RegionMatrix      from './RegionMatrix';
import CategoryKPI       from './CategoryKPI';
import LayoutCustomizer  from './LayoutCustomizer';
import { usePageLayout } from './usePageLayout';
import './SalesActivityPage.css';

/* ── Constants ───────────────────────────────────── */
const MONTH_AR = {
  1:'يناير', 2:'فبراير', 3:'مارس', 4:'أبريل', 5:'مايو', 6:'يونيو',
  7:'يوليو', 8:'أغسطس', 9:'سبتمبر', 10:'أكتوبر', 11:'نوفمبر', 12:'ديسمبر',
};

/* ── Fetch helpers ───────────────────────────────── */
async function fetchMeta(params) {
  const { data } = await client.get('/sales-activity/meta', { params });
  return data;
}

async function fetchReport(filters) {
  const { data } = await client.get('/sales-activity/report', { params: filters });
  return data;
}

async function fetchNewCustomers(filters) {
  const { data } = await client.get('/sales-activity/new-customers', { params: filters });
  return data;
}

async function fetchKPI(filters) {
  const { data } = await client.get('/sales-activity/kpi', { params: filters });
  return data;
}

async function fetchStoppedCustomers(filters) {
  const { data } = await client.get('/sales-activity/stopped-customers', { params: filters });
  return data;
}

async function fetchRegionStats(filters) {
  const { data } = await client.get('/sales-activity/region-stats', { params: filters });
  return data;
}

async function fetchCategoryStats(filters) {
  const { data } = await client.get('/sales-activity/category-stats', { params: filters });
  return data;
}

/* ── Note history popover — portal to body, anchored to button ── */
/*
 * anchorRect  — DOMRect captured at click time (no useEffect delay)
 * anchorEl    — the button DOM node (excluded from outside-click handler)
 */
function NoteHistoryPopover({ customerCode, anchorRect, anchorEl, onClose }) {
  const popoverRef = useRef(null);

  const { data, isLoading } = useQuery({
    queryKey: ['note-history', customerCode],
    queryFn:  () => client.get(`/sales-activity/note-history/${customerCode}`).then(r => r.data),
    staleTime: 0,
  });

  /* ── Position computed synchronously — no useEffect, no flicker ── */
  const PW  = 300;
  const PH  = 390;
  const gap = 8;

  // ── Vertical: top of popover = top of the button row (same line as customer row)
  // Clamp downward so it never goes below the viewport
  let top = anchorRect.top;
  if (top + PH > window.innerHeight - 8) {
    top = window.innerHeight - PH - 8;
  }
  top = Math.max(8, top);

  // ── Horizontal: pick the side with more available space
  const spaceRight = window.innerWidth - anchorRect.right - gap;
  const spaceLeft  = anchorRect.left  - gap;
  let left;
  if (spaceRight >= PW || spaceRight >= spaceLeft) {
    // enough room to the right — open to the right of the button
    left = anchorRect.right + gap;
  } else {
    // more room to the left — open to the left of the button
    left = anchorRect.left - PW - gap;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - PW - 8));

  /* ── Close on Escape / outside mousedown ── */
  useEffect(() => {
    const onKey  = e => { if (e.key === 'Escape') onClose(); };
    const onDown = e => {
      // Don't close when clicking the anchor button — NoteCell handles the toggle
      if (anchorEl && anchorEl.contains(e.target)) return;
      if (popoverRef.current && !popoverRef.current.contains(e.target)) onClose();
    };
    window.addEventListener('keydown',   onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown',   onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose, anchorEl]);

  const history = data?.history || [];

  function fmt(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('ar-SA', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
  }

  /* Render into document.body — bypasses any table stacking context */
  return createPortal(
    <div
      ref={popoverRef}
      className="sap-hist-popover"
      style={{ position: 'fixed', top, left, width: PW }}
    >
      <div className="sap-hist-header">
        <History size={14} />
        سجل الملاحظات
        <button className="sap-hist-close" onClick={onClose}><X size={14} /></button>
      </div>

      {isLoading ? (
        <div className="sap-hist-loading">جاري التحميل…</div>
      ) : history.length === 0 ? (
        <div className="sap-hist-empty">لا يوجد سجل لهذا العميل</div>
      ) : (
        <div className="sap-hist-list">
          {history.map((h, i) => (
            <div key={h.id} className={`sap-hist-row${i === 0 ? ' sap-hist-latest' : ''}`}>
              <div className="sap-hist-meta">
                <span className="sap-hist-user">{h.saved_by_name || 'مجهول'}</span>
                <span className="sap-hist-time">{fmt(h.saved_at)}</span>
                {i === 0 && <span className="sap-hist-badge">الأحدث</span>}
              </div>
              <div className="sap-hist-text">
                {h.note_text || <em style={{ color: 'var(--color-text-muted)' }}>ملاحظة فارغة</em>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body
  );
}

/* ── Note cell ───────────────────────────────────── */
function NoteCell({ customerCode, initialNote }) {
  const qc = useQueryClient();

  /* savedRef tracks the last persisted value so isDirty is always accurate
     even after multiple save cycles within the same mounted component        */
  const savedRef = useRef(initialNote || '');
  const timerRef = useRef(null);

  const [text,     setText]    = useState(initialNote || '');
  const [isDirty,  setIsDirty] = useState(false);
  const [status,   setStatus]  = useState(''); // '' | 'saving' | 'saved' | 'error'
  /* histRect: null = closed; DOMRect = open at that position */
  const [histRect, setHistRect] = useState(null);
  const histBtnRef = useRef(null);

  /* ── Sync textarea when parent data refreshes (only if not mid-edit) ── */
  useEffect(() => {
    if (!isDirty) {
      const val = initialNote || '';
      setText(val);
      savedRef.current = val;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNote]);

  const handleChange = e => {
    const val = e.target.value;
    setText(val);
    setIsDirty(val !== savedRef.current);
    if (status !== '') setStatus('');
  };

  const handleSave = async () => {
    if (status === 'saving') return;
    setStatus('saving');
    try {
      await client.put('/sales-activity/note', { customer_code: customerCode, note_text: text });
      savedRef.current = text;   // update baseline to newly saved value
      setIsDirty(false);
      setStatus('saved');
      /* refresh history so popover shows the new entry immediately */
      qc.invalidateQueries({ queryKey: ['note-history', customerCode] });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setStatus(''), 2500);
    } catch {
      setStatus('error');
      timerRef.current = setTimeout(() => setStatus(''), 3000);
    }
  };

  const handleCancel = () => {
    setText(savedRef.current);
    setIsDirty(false);
    setStatus('');
  };

  /* Toggle history popover — capture rect at click time for exact positioning */
  const toggleHist = () => {
    setHistRect(prev => {
      if (prev) return null; // already open → close
      if (!histBtnRef.current) return null;
      return histBtnRef.current.getBoundingClientRect(); // open at button position
    });
  };

  const hasNote = text.trim().length > 0;

  return (
    <div className="sap-note-wrap">
      <textarea
        className={`sap-note-ta${isDirty ? ' sap-note-dirty' : ''}`}
        value={text}
        onChange={handleChange}
        rows={1}
        placeholder="أضف ملاحظة…"
      />

      <div className="sap-note-actions">
        {/* Save / Cancel — visible only when there are unsaved changes */}
        {isDirty ? (
          <>
            <button
              className="sap-note-save-btn"
              onClick={handleSave}
              disabled={status === 'saving'}
              title="حفظ الملاحظة"
              type="button"
            >
              {status === 'saving' ? '…' : '✓ حفظ'}
            </button>
            <button
              className="sap-note-cancel-btn"
              onClick={handleCancel}
              title="إلغاء التعديل"
              type="button"
            >
              ✕
            </button>
          </>
        ) : (
          status === 'saved' ? <span className="sap-note-saved">✓ تم</span> :
          status === 'error' ? <span className="sap-note-err">! خطأ</span>  :
          null
        )}

        {/* History button — always visible */}
        <button
          ref={histBtnRef}
          className={`sap-note-hist-btn${hasNote ? ' sap-note-hist-has' : ''}`}
          title="سجل الملاحظات"
          onClick={toggleHist}
          type="button"
        >
          <History size={12} />
        </button>
      </div>

      {histRect && (
        <NoteHistoryPopover
          customerCode={customerCode}
          anchorRect={histRect}
          anchorEl={histBtnRef.current}
          onClose={() => setHistRect(null)}
        />
      )}
    </div>
  );
}

/* ── Skeleton ────────────────────────────────────── */
function TableSkeleton({ rows = 8, cols = 10 }) {
  return (
    <div className="sap-skeleton">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="sap-skeleton-row">
          {Array.from({ length: cols }).map((_, j) => (
            <div key={j} className="sap-skel" style={{ flex: j < 4 ? 2 : 1 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── Tab 1: Monthly report ───────────────────────── */
function ReportTab({ filters }) {
  const { data, isLoading, isError } = useQuery({
    queryKey:  ['sales-report', filters],
    queryFn:   () => fetchReport(filters),
    staleTime: 60_000,
  });

  if (isLoading) return <TableSkeleton rows={10} cols={10} />;
  if (isError)   return <div className="sap-empty">حدث خطأ في تحميل البيانات</div>;
  if (!data || !data.customers || data.customers.length === 0) {
    return <div className="sap-empty">
      <Users size={40} strokeWidth={1} />
      لا توجد بيانات — يرجى رفع ملف CSV أولاً
    </div>;
  }

  const { months, customers, maxMonth } = data;

  return (
    <div className="sap-table-wrap">
      <table className="sap-table">
        <thead>
          <tr>
            <th>#</th>
            <th>اسم العميل</th>
            <th>الكود</th>
            <th>المنطقة</th>
            <th>المندوب</th>
            <th>التصنيف</th>
            {months.map(m => <th key={m}>{MONTH_AR[m] || m}</th>)}
            <th>الإجمالي</th>
            <th>صافي المرتجعات</th>
            <th>الحالة</th>
            <th>ملاحظات</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c, idx) => (
            <tr key={c.customer_code} className={!c.active_current ? 'sap-row-inactive' : ''}>
              <td className="sap-row-num">{idx + 1}</td>
              <td>{c.customer_name}</td>
              <td style={{ fontFamily: 'var(--font-en, monospace)', fontSize: 12 }}>{c.customer_code}</td>
              <td>{c.branch_name   || '—'}</td>
              <td>{c.salesrep_name || '—'}</td>
              <td>{c.category_name || '—'}</td>
              {months.map(m => (
                <td key={m} style={{ textAlign: 'center' }}>
                  {c.months[m] > 0
                    ? <span className="sap-month-badge">{c.months[m]}</span>
                    : <span className="sap-month-dash">—</span>
                  }
                </td>
              ))}
              <td className="sap-total-cell" style={{ textAlign: 'center' }}>{c.total}</td>
              <td className="sap-return-cell" style={{ textAlign: 'center' }}>
                {c.total_bad_return_qty > 0
                  ? <span className="sap-return-badge">{c.total_bad_return_qty.toLocaleString('en-SA')}</span>
                  : <span className="sap-month-dash">—</span>
                }
              </td>
              <td>
                {c.active_current
                  ? <span className="sap-status-active">✅ نشط</span>
                  : <span className="sap-status-inactive">❌ غير نشط</span>
                }
              </td>
              <td>
                <NoteCell customerCode={c.customer_code} initialNote={c.note} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Tab 2: New customers ────────────────────────── */
function NewCustomersTab({ filters }) {
  const { data, isLoading, isError } = useQuery({
    queryKey:  ['sales-new-customers', filters],
    queryFn:   () => fetchNewCustomers(filters),
    staleTime: 60_000,
  });

  if (isLoading) return <TableSkeleton rows={6} cols={6} />;
  if (isError)   return <div className="sap-empty">حدث خطأ في تحميل البيانات</div>;

  const currentMonth = data?.currentMonth || 0;
  const customers    = data?.customers    || [];

  if (!customers.length) {
    return (
      <div className="sap-empty">
        <Users size={40} strokeWidth={1} />
        {currentMonth
          ? `لا يوجد عملاء جدد في ${MONTH_AR[currentMonth] || currentMonth}`
          : 'لا توجد بيانات'
        }
      </div>
    );
  }

  const trueNewCount  = customers.filter(c => !c.is_returning).length;
  const returningCount = customers.filter(c =>  c.is_returning).length;

  return (
    <div className="sap-table-wrap">
      {/* Summary banner */}
      {returningCount > 0 && (
        <div className="sap-new-banner">
          <span>🆕 جديد فعلاً: <strong>{trueNewCount}</strong></span>
          <span className="sap-banner-sep">|</span>
          <span>🔄 عائد من سنة سابقة: <strong>{returningCount}</strong></span>
          <span className="sap-banner-sep">|</span>
          <span>الإجمالي: <strong>{customers.length}</strong></span>
        </div>
      )}
      <table className="sap-table">
        <thead>
          <tr>
            <th>#</th>
            <th>اسم العميل</th>
            <th>الكود</th>
            <th>المنطقة</th>
            <th>المندوب</th>
            <th>عدد الفواتير</th>
            <th>الحالة</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c, idx) => (
            <tr key={c.customer_code} className={c.is_returning ? 'sap-row-returning' : ''}>
              <td className="sap-row-num">{idx + 1}</td>
              <td>{c.customer_name}</td>
              <td style={{ fontFamily: 'var(--font-en, monospace)', fontSize: 12 }}>{c.customer_code}</td>
              <td>{c.branch_name   || '—'}</td>
              <td>{c.salesrep_name || '—'}</td>
              <td className="sap-total-cell" style={{ textAlign: 'center' }}>{c.invoice_count}</td>
              <td>
                {c.is_returning
                  ? <span className="sap-status-returning">🔄 عائد من عام سابق</span>
                  : <span className="sap-status-active">🆕 جديد</span>
                }
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Tab 3: Stopped customers ────────────────────── */
function StoppedCustomersTab({ filters }) {
  const { data, isLoading, isError } = useQuery({
    queryKey:  ['sales-stopped-customers', filters],
    queryFn:   () => fetchStoppedCustomers(filters),
    staleTime: 60_000,
  });

  if (isLoading) return <TableSkeleton rows={6} cols={7} />;
  if (isError)   return <div className="sap-empty">حدث خطأ في تحميل البيانات</div>;

  const currentMonth = data?.currentMonth || 0;
  const prevMonth    = data?.prevMonth    || 0;
  const customers    = data?.customers    || [];

  if (!prevMonth) {
    return (
      <div className="sap-empty">
        <Users size={40} strokeWidth={1} />
        لا يوجد شهر سابق في البيانات
      </div>
    );
  }

  if (!customers.length) {
    return (
      <div className="sap-empty">
        <Users size={40} strokeWidth={1} />
        {`لا يوجد عملاء متوقفون — اشتروا في ${MONTH_AR[prevMonth]} وكذلك في ${MONTH_AR[currentMonth]}`}
      </div>
    );
  }

  return (
    <div className="sap-table-wrap">
      {/* sub-header */}
      <div className="sap-stopped-banner">
        <span className="sap-stopped-icon">⚠️</span>
        اشتروا في <strong>{MONTH_AR[prevMonth]}</strong> ولم يشتروا في <strong>{MONTH_AR[currentMonth]}</strong>
        <span className="sap-stopped-count">{customers.length} عميل</span>
      </div>

      <table className="sap-table">
        <thead>
          <tr>
            <th>#</th>
            <th>اسم العميل</th>
            <th>الكود</th>
            <th>المنطقة</th>
            <th>المندوب</th>
            <th>فواتير {MONTH_AR[prevMonth]}</th>
            <th>الحالة</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c, idx) => (
            <tr key={c.customer_code} className="sap-row-stopped">
              <td className="sap-row-num">{idx + 1}</td>
              <td>{c.customer_name}</td>
              <td style={{ fontFamily: 'var(--font-en, monospace)', fontSize: 12 }}>{c.customer_code}</td>
              <td>{c.branch_name   || '—'}</td>
              <td>{c.salesrep_name || '—'}</td>
              <td className="sap-total-cell" style={{ textAlign: 'center' }}>{c.invoice_count}</td>
              <td>
                <span className="sap-status-inactive">⛔ متوقف</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Chart edit wrapper (matrix / pie-new / pie-stopped) ── */
function ChartEditWrapper({ cardId, label, size, visible, editMode, onToggle, onSize, children }) {
  const sz = size || 'md';
  const SIZES = ['sm', 'md', 'lg'];

  /* ── View mode: always wrap in a sized div (so flex-basis works) ── */
  if (!editMode) {
    if (visible === false) return null;
    return <div className={`sap-chart-sz-${sz}`}>{children}</div>;
  }

  /* ── Edit mode ── */
  return (
    <div className={`sap-chart-edit-wrap sap-chart-sz-${sz}${!visible ? ' sap-chart-hidden-wrap' : ''}`}>
      <div className="sap-chart-edit-bar">
        <span className="sap-ebar-label">{label}</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {SIZES.map(s => (
            <button
              key={s}
              className={`sap-chart-edit-sz-btn${sz === s ? ' active' : ''}`}
              onClick={() => onSize && onSize(cardId, s)}
              title={s === 'sm' ? 'صغير' : s === 'md' ? 'متوسط' : 'كبير'}
            >
              {s === 'sm' ? 'S' : s === 'md' ? 'M' : 'L'}
            </button>
          ))}
        </div>
        <button
          className="sap-chart-edit-vis"
          onClick={() => onToggle && onToggle(cardId)}
          title={visible ? 'إخفاء' : 'إظهار'}
        >
          {visible ? <Eye size={11} /> : <EyeOff size={11} />}
          <span>{visible ? 'إخفاء' : 'إظهار'}</span>
        </button>
      </div>
      {!visible ? (
        <div
          className="sap-chart-hidden-placeholder"
          onClick={() => onToggle && onToggle(cardId)}
          title="انقر لإظهار"
        >
          <EyeOff size={13} style={{ display: 'inline', marginLeft: 4 }} />
          {label}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

/* ── Main Page ───────────────────────────────────── */
export default function SalesActivityPage() {
  const [activeTab,  setActiveTab]  = useState(0);
  const [branch,     setBranch]     = useState('');
  const [rep,        setRep]        = useState('');
  const [exporting,  setExporting]  = useState(false);
  const layout = usePageLayout();

  /* Section drag refs */
  const secDragIdx  = useRef(null);
  const secDragOver = useRef(null);
  const [secDragState, setSecDragState] = useState({ dragging: null, over: null });

  const year = 2026;

  // Meta (branches + reps filtered by selected branch)
  const { data: meta } = useQuery({
    queryKey:  ['sales-meta', year, branch],
    queryFn:   () => fetchMeta({ year, branch: branch || undefined }),
    staleTime: 60_000,
  });

  // New customers data (needed for badge count on tab label)
  const { data: newData } = useQuery({
    queryKey:  ['sales-new-customers', { branch, rep, year }],
    queryFn:   () => fetchNewCustomers({ branch, rep, year }),
    staleTime: 60_000,
  });

  // Stopped customers (needed for badge count on tab label)
  const { data: stoppedData } = useQuery({
    queryKey:  ['sales-stopped-customers', { branch, rep, year }],
    queryFn:   () => fetchStoppedCustomers({ branch: branch || undefined, rep: rep || undefined, year }),
    staleTime: 60_000,
  });

  // KPI summary — keep previous data visible while refetching (no flicker)
  const { data: kpiData, isLoading: kpiLoading, isFetching: kpiFetching } = useQuery({
    queryKey:     ['sales-kpi', { branch, rep, year }],
    queryFn:      () => fetchKPI({ branch: branch || undefined, rep: rep || undefined, year }),
    staleTime:    60_000,
    placeholderData: keepPreviousData,
  });

  // Region stats (for pie charts) — same treatment
  const { data: regionStats, isLoading: regionLoading, isFetching: regionFetching } = useQuery({
    queryKey:     ['sales-region-stats', { branch, rep, year }],
    queryFn:      () => fetchRegionStats({ branch: branch || undefined, rep: rep || undefined, year }),
    staleTime:    60_000,
    placeholderData: keepPreviousData,
  });

  // Category stats (for category KPI strip below pies)
  const { data: categoryStats, isLoading: categoryLoading, isFetching: categoryFetching } = useQuery({
    queryKey:     ['sales-category-stats', { branch, rep, year }],
    queryFn:      () => fetchCategoryStats({ branch: branch || undefined, rep: rep || undefined, year }),
    staleTime:    60_000,
    placeholderData: keepPreviousData,
  });

  // All hooks above — no conditional returns before this line
  const filters = { branch: branch || undefined, rep: rep || undefined, year };

  /* Map activeTab index → tab key sent to backend */
  const TAB_KEY  = ['report', 'new', 'stopped'];
  const TAB_NAME = ['التقرير الشهري', 'العملاء الجدد', 'المتوقفون'];

  const handleExport = async () => {
    setExporting(true);
    const tabKey = TAB_KEY[activeTab] || 'report';
    try {
      const response = await client.get('/sales-activity/export', {
        params: { ...filters, tab: tabKey },
        responseType: 'blob',
      });
      const url = URL.createObjectURL(response.data);
      const a   = document.createElement('a');
      a.href     = url;
      // Derive filename from content-disposition header if available
      const cd   = response.headers['content-disposition'] || '';
      const match = cd.match(/filename="([^"]+)"/);
      a.download = match ? match[1] : `sales_${tabKey}_${year}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('فشل التصدير: ' + (err.response?.data?.error || err.message));
    } finally {
      setExporting(false);
    }
  };

  const newCount     = newData?.customers?.length     || 0;
  const stoppedCount = stoppedData?.customers?.length || 0;

  /* ── Compute hidden count for badge ── */
  const hiddenCount = layout.sections.reduce((total, sec) => {
    let count = sec.visible === false ? 1 : 0;
    count += sec.cards.filter(c => c.visible === false).length;
    return total + count;
  }, 0);

  /* ── Section drag handlers ── */
  function onSecDragStart(e, idx) {
    secDragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
    setSecDragState({ dragging: idx, over: null });
  }

  const handlePrint = () => {
    const prev = document.title;
    document.title = `تقرير العملاء العام ${year} — ${new Date().toLocaleDateString('ar-SA', { year:'numeric', month:'long', day:'numeric' })}`;
    window.print();
    window.onafterprint = () => { document.title = prev; window.onafterprint = null; };
  };

  function onSecDragEnd() {
    if (secDragIdx.current !== null && secDragOver.current !== null && secDragIdx.current !== secDragOver.current) {
      layout.reorderSections(secDragIdx.current, secDragOver.current);
    }
    secDragIdx.current = null;
    secDragOver.current = null;
    setSecDragState({ dragging: null, over: null });
  }

  function onSecDragOver(e, idx) {
    e.preventDefault();
    if (secDragOver.current === idx) return;
    secDragOver.current = idx;
    setSecDragState(s => ({ ...s, over: idx }));
  }

  function onSecDrop(e) {
    e.preventDefault();
  }

  return (
    <div className="sap-page">
      {/* Header */}
      <div className="sap-header">
        <div className="sap-title">
          <Users size={20} />
          تقرير العملاء العام
          <span className="sap-badge">{year}</span>
        </div>
        <div className="sap-header-actions">
          <LayoutCustomizer
            editMode={layout.editMode}
            toggleEditMode={layout.toggleEditMode}
            reset={layout.reset}
            hiddenCount={hiddenCount}
          />
          <button className="sap-btn-export" onClick={handleExport} disabled={exporting}>
            <Download size={15} />
            {exporting ? 'جاري التصدير…' : `تصدير — ${TAB_NAME[activeTab] || 'التقرير'}`}
          </button>
          <button className="sap-btn-pdf sap-no-print" onClick={handlePrint} title="تصدير PDF / طباعة">
            <Printer size={15} /> PDF
          </button>
        </div>
      </div>
      <div className="sap-print-header">
        <span>📊</span>
        <span className="sap-print-title">تقرير العملاء العام — {year}</span>
        <span className="sap-print-date">{new Date().toLocaleDateString('ar-SA',{year:'numeric',month:'long',day:'numeric',weekday:'long'})}</span>
      </div>

      {/* Filters */}
      <div className="sap-filters">
        <span className="sap-filter-label">تصفية:</span>

        <select
          className="sap-select"
          value={branch}
          onChange={e => { setBranch(e.target.value); setRep(''); }}
        >
          <option value="">كل المناطق</option>
          {(meta?.branches || []).map(b => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>

        <select
          className="sap-select"
          value={rep}
          onChange={e => setRep(e.target.value)}
        >
          <option value="">كل المندوبين</option>
          {(meta?.reps || []).map(r => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>

        {(branch || rep) && (
          <button
            style={{ fontSize: 12, color: 'var(--color-danger)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}
            onClick={() => { setBranch(''); setRep(''); }}
          >
            × مسح الفلاتر
          </button>
        )}
      </div>

      {/* ── Dynamic sections — ordered by layout, per-card config ── */}
      {layout.sections.map((sec, si) => {
        const isSecHidden = sec.visible === false;
        const editMode    = layout.editMode;

        /* In normal mode, skip hidden sections entirely */
        if (!editMode && isSecHidden) return null;

        /* helper: get config for a card in this section */
        const ccfg = (cid) => layout.cardCfg(sec.id, cid);

        /* Section drag wrapper props */
        const secDragProps = editMode ? {
          draggable: true,
          onDragStart: (e) => onSecDragStart(e, si),
          onDragEnd:   onSecDragEnd,
          onDragOver:  (e) => onSecDragOver(e, si),
          onDrop:      onSecDrop,
        } : {};

        const isDraggingSec = secDragState.dragging === si;
        const isDragOverSec = secDragState.over === si && secDragState.dragging !== si;

        /* ── Section edit bar ── */
        function SectionEditBar() {
          if (!editMode) return null;
          return (
            <div className="sap-sec-edit-bar">
              <span className="sap-sec-grip"><GripVertical size={15} /></span>
              <span className="sap-sec-label">{sec.label}</span>
              <button
                className="sap-sec-vis-btn"
                onClick={() => layout.toggleSection(sec.id)}
                title={isSecHidden ? 'إظهار القسم' : 'إخفاء القسم'}
              >
                {isSecHidden ? <Eye size={13} /> : <EyeOff size={13} />}
                <span>{isSecHidden ? 'إظهار' : 'إخفاء'}</span>
              </button>
            </div>
          );
        }

        /* ── Hidden section placeholder ── */
        if (editMode && isSecHidden) {
          return (
            <div
              key={sec.id}
              {...secDragProps}
              style={{ opacity: isDraggingSec ? 0.4 : 1 }}
            >
              <SectionEditBar />
              <div
                className="sap-sec-hidden-row"
                onClick={() => layout.toggleSection(sec.id)}
                title="انقر لإظهار القسم"
              >
                <Eye size={13} />
                <span>{sec.label} — مخفي، انقر لإظهاره</span>
              </div>
            </div>
          );
        }

        if (sec.id === 'kpi') {
          const kpiSec    = layout.sections.find(s => s.id === 'kpi');
          const kpiCardIds = kpiSec?.cards.map(c => c.id) ?? [];
          return (
            <div
              key="kpi"
              className="sap-section-kpi"
              style={{ opacity: isDraggingSec ? 0.4 : 1, outline: isDragOverSec ? '2px dashed #3b82f6' : undefined }}
              {...secDragProps}
            >
              <SectionEditBar />
              <SalesActivityKPI
                data={kpiData}
                loading={kpiLoading}
                fetching={kpiFetching}
                cardCfg={ccfg}
                editMode={editMode}
                cardIds={kpiCardIds}
                onToggleCard={(cid) => layout.toggleCard('kpi', cid)}
                onSizeCard={(cid, sz) => layout.setCardSize('kpi', cid, sz)}
                onReorderCards={(from, to) => layout.reorderCards('kpi', from, to)}
              />
            </div>
          );
        }

        if (sec.id === 'charts') {
          const cfgMatrix  = ccfg('matrix');
          const cfgPieNew  = ccfg('pie-new');
          const cfgPieStp  = ccfg('pie-stopped');

          const showMatrix  = cfgMatrix.visible     !== false;
          const showPieNew  = cfgPieNew.visible     !== false;
          const showPieStp  = cfgPieStp.visible     !== false;
          const anyChart    = showMatrix || showPieNew || showPieStp;

          if (!editMode && !anyChart) return null;

          return (
            <div
              key="charts"
              className="sap-section-charts"
              style={{ opacity: isDraggingSec ? 0.4 : 1, outline: isDragOverSec ? '2px dashed #3b82f6' : undefined }}
              {...secDragProps}
            >
              <SectionEditBar />
              <div className="sap-charts-row">
                {/* Left: region matrix */}
                <ChartEditWrapper
                  cardId="matrix"
                  label="مصفوفة المناطق"
                  size={cfgMatrix.size}
                  visible={showMatrix}
                  editMode={editMode}
                  onToggle={(cid) => layout.toggleCard('charts', cid)}
                  onSize={(cid, sz) => layout.setCardSize('charts', cid, sz)}
                >
                  <RegionMatrix data={regionStats} loading={regionLoading} />
                </ChartEditWrapper>

                {/* Right column: region pies on top, category pie below */}
                <div className="sap-charts-right-col">
                  {(editMode || showPieNew || showPieStp) && (
                    <SalesPieCharts
                      data={regionStats}
                      loading={regionLoading}
                      fetching={regionFetching}
                      cardCfg={ccfg}
                      editMode={editMode}
                      onToggleCard={(cid) => layout.toggleCard('charts', cid)}
                      onSizeCard={(cid, sz) => layout.setCardSize('charts', cid, sz)}
                    />
                  )}
                  <CategoryKPI
                    data={categoryStats}
                    loading={categoryLoading}
                    fetching={categoryFetching}
                  />
                </div>
              </div>
            </div>
          );
        }

        if (sec.id === 'table') {
          const tableVisible = ccfg('table-main').visible !== false;
          if (!editMode && !tableVisible) return null;

          return (
            <div
              key="table"
              className="sap-section-table"
              style={{ opacity: isDraggingSec ? 0.4 : 1, outline: isDragOverSec ? '2px dashed #3b82f6' : undefined }}
              {...secDragProps}
            >
              <SectionEditBar />
              {editMode && !tableVisible ? (
                <div
                  className="sap-sec-hidden-row"
                  onClick={() => layout.toggleCard('table', 'table-main')}
                  title="انقر لإظهار الجدول"
                >
                  <Eye size={13} />
                  <span>الجدول الرئيسي — مخفي، انقر لإظهاره</span>
                </div>
              ) : (
                <>
                  {editMode && (
                    <div className="sap-chart-edit-bar" style={{ borderRadius: 8, borderBottom: '1px dashed rgba(59,130,246,0.3)', marginBottom: 8 }}>
                      <span className="sap-ebar-label">جدول العملاء</span>
                      <button
                        className="sap-chart-edit-vis"
                        onClick={() => layout.toggleCard('table', 'table-main')}
                        title="إخفاء الجدول"
                      >
                        <EyeOff size={11} />
                        <span>إخفاء</span>
                      </button>
                    </div>
                  )}
                  {/* Tabs */}
                  <div className="sap-tabs">
                    <button
                      className={`sap-tab${activeTab === 0 ? ' active' : ''}`}
                      onClick={() => setActiveTab(0)}
                    >
                      تقرير الحضور الشهري
                    </button>
                    <button
                      className={`sap-tab${activeTab === 1 ? ' active' : ''}`}
                      onClick={() => setActiveTab(1)}
                    >
                      العملاء الجدد
                      {newCount > 0 && <span className="sap-new-badge">{newCount}</span>}
                    </button>
                    <button
                      className={`sap-tab${activeTab === 2 ? ' active' : ''}`}
                      onClick={() => setActiveTab(2)}
                    >
                      المتوقفون
                      {stoppedCount > 0 && <span className="sap-stopped-badge">{stoppedCount}</span>}
                    </button>
                  </div>
                  {activeTab === 0 && <ReportTab          filters={filters} />}
                  {activeTab === 1 && <NewCustomersTab     filters={filters} />}
                  {activeTab === 2 && <StoppedCustomersTab filters={filters} />}
                </>
              )}
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
