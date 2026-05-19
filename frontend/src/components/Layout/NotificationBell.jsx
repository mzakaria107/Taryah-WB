import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Bell, X, CheckCheck, ExternalLink } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import client from '../../api/client';
import './NotificationBell.css';

/* ── API helpers ─────────────────────────────────────────── */
const fetchNotifications  = () => client.get('/notifications').then(r => r.data.notifications);
const fetchUnreadCount    = () => client.get('/notifications/unread-count').then(r => r.data.count);
const markOne             = (id) => client.post(`/notifications/${id}/read`);
const markAll             = () => client.post('/notifications/read-all');
const deleteOne           = (id) => client.delete(`/notifications/${id}`);

/* ── Type → colour ──────────────────────────────────────── */
const TYPE_COLOR = {
  task_created:     '#3b82f6',
  task_acknowledged:'#8b5cf6',
  task_started:     '#f59e0b',
  task_completed:   '#10b981',
  task_cancelled:   '#ef4444',
  task:             '#6b7280',
};

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr);
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)   return 'الآن';
  if (mins  < 60)  return `منذ ${mins} دقيقة`;
  if (hours < 24)  return `منذ ${hours} ساعة`;
  return `منذ ${days} يوم`;
}

/* ── Component ───────────────────────────────────────────── */
export default function NotificationBell() {
  const [open, setOpen]     = useState(false);
  const panelRef            = useRef(null);
  const navigate            = useNavigate();
  const qc                  = useQueryClient();

  /* Poll unread count every 30 s */
  const { data: unreadCount = 0 } = useQuery({
    queryKey: ['notif-count'],
    queryFn:  fetchUnreadCount,
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
  });

  /* Load full list only when panel is open */
  const { data: notifications = [], isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn:  fetchNotifications,
    enabled:  open,
    refetchInterval: open ? 30000 : false,
  });

  /* Close on outside click */
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['notifications'] });
    qc.invalidateQueries({ queryKey: ['notif-count'] });
  }, [qc]);

  const { mutate: doMarkOne } = useMutation({
    mutationFn: markOne,
    onSuccess:  invalidate,
  });

  const { mutate: doMarkAll } = useMutation({
    mutationFn: markAll,
    onSuccess:  invalidate,
  });

  const { mutate: doDelete } = useMutation({
    mutationFn: deleteOne,
    onSuccess:  invalidate,
  });

  function handleClick(n) {
    if (!n.is_read) doMarkOne(n.id);
    if (n.task_id) {
      navigate('/sales-tasks', { state: { openTaskId: n.task_id } });
      setOpen(false);
    }
  }

  return (
    <div className="nb-wrap" ref={panelRef}>
      {/* Bell button */}
      <button
        className="navbar-icon-btn nb-bell-btn"
        onClick={() => setOpen(v => !v)}
        aria-label="الإشعارات"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="nb-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div className="nb-panel">
          {/* Header */}
          <div className="nb-header">
            <span className="nb-header-title">
              الإشعارات
              {unreadCount > 0 && <span className="nb-header-count">{unreadCount}</span>}
            </span>
            <div style={{ display:'flex', gap:6 }}>
              {unreadCount > 0 && (
                <button className="nb-action-btn" onClick={() => doMarkAll()} title="تحديد الكل كمقروء">
                  <CheckCheck size={14} /> الكل مقروء
                </button>
              )}
            </div>
          </div>

          {/* List */}
          <div className="nb-list">
            {isLoading ? (
              <div className="nb-empty">جارٍ التحميل…</div>
            ) : notifications.length === 0 ? (
              <div className="nb-empty">
                <Bell size={28} style={{ color:'#d1d5db', marginBottom:8 }} />
                <div>لا توجد إشعارات</div>
              </div>
            ) : (
              notifications.map(n => (
                <div
                  key={n.id}
                  className={`nb-item${n.is_read ? '' : ' nb-item-unread'}`}
                  onClick={() => handleClick(n)}
                >
                  <div
                    className="nb-dot"
                    style={{ background: TYPE_COLOR[n.type] || TYPE_COLOR.task }}
                  />
                  <div className="nb-content">
                    <div className="nb-title">{n.title}</div>
                    {n.body && <div className="nb-body">{n.body}</div>}
                    <div className="nb-time">{timeAgo(n.created_at)}</div>
                  </div>
                  {n.task_id && <ExternalLink size={12} className="nb-link-icon" />}
                  <button
                    className="nb-delete-btn"
                    onClick={e => { e.stopPropagation(); doDelete(n.id); }}
                    title="حذف"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
