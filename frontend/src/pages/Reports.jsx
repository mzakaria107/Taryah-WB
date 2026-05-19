import React, { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { MessageSquare, User, FileText, Download, Search, ChevronRight, ChevronLeft, Trash2 } from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './Reports.css';

/* ── Helpers ─────────────────────────────────── */
function fmtDateTime(dt) {
  if (!dt) return '—';
  const d = new Date(dt);
  const date = d.toLocaleDateString('ar-SA', { year:'numeric', month:'2-digit', day:'2-digit' });
  const time = d.toLocaleTimeString('ar-SA', { hour:'2-digit', minute:'2-digit' });
  return `${date} ${time}`;
}

const TYPE_LABEL = { customer: 'عميل', invoice: 'فاتورة' };
const TYPE_CLS   = { customer: 'badge-customer', invoice: 'badge-invoice' };

/* ── Fetch ───────────────────────────────────── */
async function fetchReport(params) {
  const { data } = await client.get('/notes/report', { params });
  return data;
}

/* ── CSV export ──────────────────────────────── */
function exportCSV(rows) {
  const hdr = ['التاريخ والوقت','المستخدم','كود العميل','اسم العميل','النوع','رقم الفاتورة','الملاحظة'];
  const body = rows.map(r => [
    fmtDateTime(r.created_at),
    r.user_name || '—',
    r.customer_id || '—',
    `"${(r.customer_name || '').replace(/"/g,'""')}"`,
    TYPE_LABEL[r.note_type] || r.note_type,
    r.invoice_number || '—',
    `"${(r.note_text || '').replace(/"/g,'""')}"`,
  ].join(','));
  const blob = new Blob(['﻿' + [hdr.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `سجل_الملاحظات_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

/* ── Main ────────────────────────────────────── */
export default function Reports() {
  const navigate     = useNavigate();
  const queryClient  = useQueryClient();
  const { user }     = useAuth();
  const isAdmin      = user?.role === 'super_admin';

  const [search,     setSearch]     = useState('');
  const [noteType,   setNoteType]   = useState('all');
  const [fromDate,   setFromDate]   = useState('');
  const [toDate,     setToDate]     = useState('');
  const [page,       setPage]       = useState(1);
  const [delConfirm, setDelConfirm] = useState(null);
  const [localDeleted, setLocalDeleted] = useState(new Set());
  const LIMIT = 50;

  const params = {
    search:    search  || undefined,
    note_type: noteType !== 'all' ? noteType : undefined,
    from_date: fromDate || undefined,
    to_date:   toDate   || undefined,
    page,
    limit: LIMIT,
  };

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['notes-report', params],
    queryFn:  () => fetchReport(params),
    keepPreviousData: true,
    staleTime: 30_000,
  });

  const rows       = (data?.rows || []).filter(r => !localDeleted.has(r.id));
  const total      = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  const handleSearch = useCallback((e) => {
    setSearch(e.target.value);
    setPage(1);
  }, []);

  const handleDelete = async (id) => {
    if (delConfirm !== id) { setDelConfirm(id); return; }
    setDelConfirm(null);
    try {
      await client.delete(`/notes/history/${id}`);
      setLocalDeleted(prev => new Set([...prev, id]));
    } catch { /* silent */ }
  };

  return (
    <div className="nr-page" style={{ animation:'fadeInUp 350ms ease-out both' }}>

      {/* ── Header ── */}
      <div className="nr-header">
        <div className="nr-title">
          <MessageSquare size={22} />
          <span>سجل الملاحظات</span>
          {total > 0 && <span className="nr-count">{total.toLocaleString('en-SA')}</span>}
        </div>
        <button
          className="chip-btn gold"
          onClick={() => exportCSV(rows)}
          disabled={!rows.length}
        >
          <Download size={13} /> تصدير CSV
        </button>
      </div>

      {/* ── Filters ── */}
      <div className="nr-filters">
        <div className="nr-search-wrap">
          <Search size={14} className="nr-search-icon" />
          <input
            className="nr-input"
            placeholder="بحث بالاسم أو الكود…"
            value={search}
            onChange={handleSearch}
          />
        </div>
        <select
          className="nr-select"
          value={noteType}
          onChange={e => { setNoteType(e.target.value); setPage(1); }}
        >
          <option value="all">جميع الأنواع</option>
          <option value="customer">ملاحظات العملاء</option>
          <option value="invoice">ملاحظات الفواتير</option>
        </select>
        <input
          type="date"
          className="nr-input nr-date"
          value={fromDate}
          onChange={e => { setFromDate(e.target.value); setPage(1); }}
          placeholder="من"
        />
        <input
          type="date"
          className="nr-input nr-date"
          value={toDate}
          onChange={e => { setToDate(e.target.value); setPage(1); }}
          placeholder="إلى"
        />
        {(search || noteType !== 'all' || fromDate || toDate) && (
          <button
            className="chip-btn"
            onClick={() => { setSearch(''); setNoteType('all'); setFromDate(''); setToDate(''); setPage(1); }}
          >
            مسح الفلاتر
          </button>
        )}
      </div>

      {/* ── Table ── */}
      <div className="nr-table-wrap">
        {(isLoading || isFetching) && <div className="nr-loading-bar" />}

        {!isLoading && rows.length === 0 ? (
          <div className="nr-empty">
            <MessageSquare size={40} strokeWidth={1.2} />
            <span>لا توجد ملاحظات مسجّلة بعد</span>
          </div>
        ) : (
          <table className="nr-table">
            <thead>
              <tr>
                <th>التاريخ والوقت</th>
                <th>المستخدم</th>
                <th>كود العميل</th>
                <th>اسم العميل</th>
                <th>النوع</th>
                <th>رقم الفاتورة</th>
                <th>الملاحظة</th>
                {isAdmin && <th style={{ width:100 }}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="nr-row">
                  <td className="nr-td-date"
                      style={{ cursor: r.customer_id ? 'pointer' : 'default' }}
                      onClick={() => r.customer_id && navigate(`/customers/${r.customer_id}`)}>
                    {fmtDateTime(r.created_at)}
                  </td>
                  <td className="nr-td-user">
                    <span className="nr-user-chip"><User size={11} />{r.user_name || '—'}</span>
                  </td>
                  <td className="nr-td-mono"
                      style={{ cursor: r.customer_id ? 'pointer' : 'default' }}
                      onClick={() => r.customer_id && navigate(`/customers/${r.customer_id}`)}>
                    {r.customer_id || '—'}
                  </td>
                  <td className="nr-td-name"
                      style={{ cursor: r.customer_id ? 'pointer' : 'default' }}
                      onClick={() => r.customer_id && navigate(`/customers/${r.customer_id}`)}>
                    {r.customer_name || '—'}
                  </td>
                  <td>
                    <span className={`nr-badge ${TYPE_CLS[r.note_type] || ''}`}>
                      {r.note_type === 'customer' ? <User size={10}/> : <FileText size={10}/>}
                      {TYPE_LABEL[r.note_type] || r.note_type}
                    </span>
                  </td>
                  <td className="nr-td-mono">{r.invoice_number || '—'}</td>
                  <td className="nr-td-note">{r.note_text || '—'}</td>
                  {isAdmin && (
                    <td style={{ textAlign:'center' }} onClick={e => e.stopPropagation()}>
                      {delConfirm === r.id ? (
                        <span style={{ display:'flex', alignItems:'center', gap:4, justifyContent:'center' }}>
                          <button className="nr-del-btn confirm" onClick={() => handleDelete(r.id)}>نعم</button>
                          <button className="nr-del-btn cancel"  onClick={() => setDelConfirm(null)}>لا</button>
                        </span>
                      ) : (
                        <button className="nr-del-btn" onClick={() => handleDelete(r.id)} title="حذف السجل">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="nr-pagination">
          <button
            className="nr-page-btn"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            <ChevronRight size={15} />
          </button>
          <span className="nr-page-info">
            صفحة <strong>{page}</strong> من <strong>{totalPages}</strong>
            <span className="nr-page-total"> ({total.toLocaleString('en-SA')} سجل)</span>
          </span>
          <button
            className="nr-page-btn"
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            <ChevronLeft size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
