import React from 'react';
import { useQuery } from '@tanstack/react-query';
import UploadPanel from '../components/Upload/UploadPanel';
import client from '../api/client';

const STATUS_AR  = { success: 'ناجح', processing: 'معالجة', failed: 'فاشل', pending: 'انتظار' };
const TYPE_AR    = {
  customer_balance: 'أرصدة العملاء',
  route_master:     'دليل المسارات',
  payments:         'حركات السداد',
  sales_activity:   'العملاء المتعاملة',
};

export default function Upload() {
  const { data: history, isLoading } = useQuery({
    queryKey: ['upload-history'],
    queryFn:  () => client.get('/upload/batches').then((r) => r.data),
    staleTime: 30_000,
  });

  return (
    <>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 20 }}>
        رفع البيانات
      </h1>

      <UploadPanel />

      {/* Full history table */}
      <div className="upload-history">
        <h3>سجل الرفع الكامل</h3>
        <table>
          <thead>
            <tr>
              <th>اسم الملف</th>
              <th>نوع الرفع</th>
              <th>التاريخ</th>
              <th>السجلات</th>
              <th>المستخدم</th>
              <th>الحالة</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--color-text-muted)' }}>جاري التحميل…</td></tr>
            ) : !history?.length ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--color-text-muted)' }}>لا يوجد سجل رفع بعد</td></tr>
            ) : history.map((h) => (
              <tr key={h.id}>
                <td style={{ fontFamily: 'var(--font-en)', fontSize: 12 }}>{h.file_name}</td>
                <td>
                  <span style={{
                    display: 'inline-block', padding: '2px 8px', borderRadius: 999,
                    fontSize: 11, fontWeight: 600,
                    background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)',
                  }}>
                    {TYPE_AR[h.file_type] ?? h.file_type}
                  </span>
                </td>
                <td style={{ fontFamily: 'var(--font-en)', fontSize: 12, whiteSpace: 'nowrap' }}>
                  {h.created_at ? new Date(h.created_at).toLocaleString('ar-SA', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                </td>
                <td style={{ fontFamily: 'var(--font-en)' }}>
                  {Number(h.row_count || 0).toLocaleString('en-SA')}
                </td>
                <td>{h.uploader_name ?? '—'}</td>
                <td>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                    background: h.status === 'success' ? 'var(--color-success-bg)' :
                                h.status === 'failed'  ? 'var(--color-danger-bg)'  : 'var(--color-warning-bg)',
                    color:      h.status === 'success' ? 'var(--color-success)' :
                                h.status === 'failed'  ? 'var(--color-danger)'  : 'var(--color-warning)',
                  }}>
                    {STATUS_AR[h.status] ?? h.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
