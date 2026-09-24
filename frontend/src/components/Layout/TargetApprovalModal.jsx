import React from 'react';
import { X, Check, CheckCircle2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import client from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import './TargetApprovalModal.css';

const MONTH_AR = {
  1:'يناير',2:'فبراير',3:'مارس',4:'أبريل',5:'مايو',6:'يونيو',
  7:'يوليو',8:'أغسطس',9:'سبتمبر',10:'أكتوبر',11:'نوفمبر',12:'ديسمبر',
};
const fmt = n => (n ?? 0).toLocaleString('en-SA', { maximumFractionDigits: 0 });

export default function TargetApprovalModal({ requestId, onClose, onApproved }) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: detail, isLoading: loadingDetail } = useQuery({
    queryKey: ['target-approval-detail', requestId],
    queryFn: () => client.get(`/target-approvals/${requestId}`).then(r => r.data),
  });

  const { data: targets = [], isLoading: loadingTargets } = useQuery({
    queryKey: ['rep-targets', detail?.year, detail?.month],
    queryFn: () => client.get('/sales-reps/targets', { params: { year: detail.year, month: detail.month } }).then(r => r.data),
    enabled: !!detail,
  });

  const regionTargets = (targets || []).filter(t => t.region_name === detail?.region_name);

  const { mutate: approve, isPending: approving } = useMutation({
    mutationFn: () => client.post(`/target-approvals/${requestId}/approve`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['target-approval-detail', requestId] });
      qc.invalidateQueries({ queryKey: ['target-approvals-status'] });
      onApproved?.();
    },
  });

  const alreadyApproved = detail?.approvals?.some(a => String(a.user_id) === String(user?.id));

  return (
    <div className="tam-overlay" onClick={onClose}>
      <div className="tam-modal" onClick={e => e.stopPropagation()}>
        <div className="tam-header">
          <span>اعتماد الأهداف الشهرية</span>
          <button className="tam-close" onClick={onClose}><X size={16}/></button>
        </div>

        {loadingDetail ? (
          <div className="tam-loading">جارٍ التحميل…</div>
        ) : !detail ? (
          <div className="tam-loading">تعذّر تحميل بيانات الطلب</div>
        ) : (
          <div className="tam-body">
            <div className="tam-meta">
              <div><strong>المنطقة:</strong> 📍 {detail.region_name}</div>
              <div><strong>الفترة:</strong> {MONTH_AR[detail.month]} {detail.year}</div>
              {detail.sent_by_name && <div><strong>أُرسلت بواسطة:</strong> {detail.sent_by_name}</div>}
            </div>

            {loadingTargets ? (
              <div className="tam-loading">جارٍ تحميل الأهداف…</div>
            ) : (
              <div className="tam-table-wrap">
                <table className="tam-table">
                  <thead>
                    <tr>
                      <th>المندوب</th>
                      <th>دجاج مبرد طرية</th>
                      <th>مقطعات طرية</th>
                      <th>دجاج مجمد</th>
                      <th>الإجمالي</th>
                      <th>هدف العملاء</th>
                      <th>هدف التحصيل %</th>
                      <th>الحد الائتماني</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regionTargets.map(t => (
                      <tr key={t.rep_id}>
                        <td>{t.rep_name}</td>
                        <td>{fmt(t.qty_target_chilled)}</td>
                        <td>{fmt(t.qty_target_cuts)}</td>
                        <td>{fmt(t.qty_target_frozen)}</td>
                        <td className="tam-total-cell">{fmt(t.qty_target)}</td>
                        <td>{fmt(t.customer_target)}</td>
                        <td>{fmt(t.collection_target_pct)}%</td>
                        <td>{fmt(t.credit_limit)}</td>
                      </tr>
                    ))}
                    {!regionTargets.length && (
                      <tr><td colSpan={8} className="tam-empty">لا توجد أهداف مسجّلة لهذه المنطقة بعد</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div className="tam-approvals">
              <div className="tam-approvals-title">حالة الاعتماد</div>
              {detail.approvals?.length ? (
                <ul className="tam-approvals-list">
                  {detail.approvals.map(a => (
                    <li key={a.user_id}>
                      <CheckCircle2 size={14} color="#059669"/> {a.name}
                      <span className="tam-approved-at"> — {new Date(a.approved_at).toLocaleString('ar-SA-u-nu-latn')}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="tam-no-approvals">لم يوافق أحد بعد</div>
              )}
            </div>

            <div className="tam-actions">
              {alreadyApproved ? (
                <span className="tam-already-approved"><CheckCircle2 size={16}/> لقد وافقت على هذه الأهداف</span>
              ) : (
                <button className="tam-approve-btn" onClick={() => approve()} disabled={approving}>
                  <Check size={15}/> {approving ? 'جارٍ الاعتماد…' : 'أوافق على الأهداف'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
