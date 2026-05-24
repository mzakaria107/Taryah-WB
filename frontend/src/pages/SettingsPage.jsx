import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, Save, Wifi, Eye, EyeOff, CheckCircle, XCircle, Loader } from 'lucide-react';
import client from '../api/client';
import './SettingsPage.css';

/* ── API helpers ─────────────────────────────────── */
const fetchSmtp   = () => client.get('/settings/smtp').then(r => r.data.value || {});
const saveSmtp    = (cfg) => client.put('/settings/smtp', { value: cfg }).then(r => r.data);
const testSmtp    = (cfg) => client.post('/settings/smtp/test', cfg).then(r => r.data);

const EMPTY = { host: '', port: '587', secure: false, user: '', pass: '', from: '' };

export default function SettingsPage() {
  const qc = useQueryClient();

  /* ── Load saved config ── */
  const { data: saved, isLoading } = useQuery({
    queryKey: ['settings', 'smtp'],
    queryFn: fetchSmtp,
    staleTime: 60_000,
  });

  const [form,     setForm]     = useState(EMPTY);
  const [showPass, setShowPass] = useState(false);
  const [testState, setTestState] = useState(null); // null | 'loading' | {ok, msg}

  /* Populate form when data loads */
  useEffect(() => {
    if (saved) setForm({ ...EMPTY, ...saved });
  }, [saved]);

  const set = (k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    setTestState(null); // reset test status on any change
  };

  /* ── Save mutation ── */
  const saveMut = useMutation({
    mutationFn: saveSmtp,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'smtp'] });
    },
  });

  /* ── Test connection ── */
  const handleTest = async () => {
    setTestState('loading');
    try {
      const res = await testSmtp({
        host:   form.host,
        port:   form.port,
        secure: form.secure,
        user:   form.user,
        pass:   form.pass,
      });
      setTestState({ ok: true, msg: res.message || 'الاتصال ناجح ✓' });
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || 'فشل الاتصال';
      setTestState({ ok: false, msg });
    }
  };

  /* ── Save ── */
  const handleSave = () => {
    saveMut.mutate({ ...form });
  };

  if (isLoading) {
    return (
      <div className="sp-loading">
        <Loader size={28} className="sp-spin" />
        <span>جاري التحميل…</span>
      </div>
    );
  }

  return (
    <div className="sp-page">
      <div className="sp-header">
        <Mail size={22} className="sp-header-icon" />
        <div>
          <h1 className="sp-title">إعدادات البريد الإلكتروني</h1>
          <p className="sp-subtitle">إعداد خادم SMTP لإرسال إشعارات المهام تلقائياً</p>
        </div>
      </div>

      <div className="sp-card">
        <div className="sp-card-head">
          <Mail size={16} />
          <span>إعدادات خادم SMTP</span>
        </div>

        <div className="sp-grid">
          {/* Host */}
          <div className="sp-field sp-field--wide">
            <label className="sp-label">خادم SMTP (Host)</label>
            <input
              className="sp-input"
              type="text"
              placeholder="smtp.gmail.com"
              value={form.host}
              onChange={e => set('host', e.target.value)}
              dir="ltr"
            />
          </div>

          {/* Port */}
          <div className="sp-field">
            <label className="sp-label">المنفذ (Port)</label>
            <input
              className="sp-input"
              type="number"
              placeholder="587"
              value={form.port}
              onChange={e => set('port', e.target.value)}
              dir="ltr"
            />
          </div>

          {/* Secure */}
          <div className="sp-field sp-field--toggle">
            <label className="sp-label">تشفير SSL/TLS</label>
            <div
              className={`sp-toggle ${form.secure ? 'sp-toggle--on' : ''}`}
              onClick={() => set('secure', !form.secure)}
              role="switch"
              aria-checked={form.secure}
              tabIndex={0}
              onKeyDown={e => e.key === ' ' && set('secure', !form.secure)}
            >
              <span className="sp-toggle-thumb" />
              <span className="sp-toggle-label">{form.secure ? 'SSL مفعّل (465)' : 'STARTTLS (587)'}</span>
            </div>
          </div>

          {/* Username */}
          <div className="sp-field">
            <label className="sp-label">البريد الإلكتروني (Username)</label>
            <input
              className="sp-input"
              type="email"
              placeholder="noreply@company.com"
              value={form.user}
              onChange={e => set('user', e.target.value)}
              dir="ltr"
            />
          </div>

          {/* Password */}
          <div className="sp-field">
            <label className="sp-label">كلمة المرور (Password)</label>
            <div className="sp-pass-wrap">
              <input
                className="sp-input sp-input--pass"
                type={showPass ? 'text' : 'password'}
                placeholder="••••••••••••"
                value={form.pass}
                onChange={e => set('pass', e.target.value)}
                dir="ltr"
              />
              <button
                type="button"
                className="sp-pass-eye"
                onClick={() => setShowPass(v => !v)}
                aria-label={showPass ? 'إخفاء' : 'إظهار'}
              >
                {showPass ? <EyeOff size={15}/> : <Eye size={15}/>}
              </button>
            </div>
          </div>

          {/* From */}
          <div className="sp-field sp-field--wide">
            <label className="sp-label">اسم ومصدر الإرسال (From)</label>
            <input
              className="sp-input"
              type="text"
              placeholder='نظام المبيعات <noreply@company.com>'
              value={form.from}
              onChange={e => set('from', e.target.value)}
              dir="ltr"
            />
            <span className="sp-hint">يظهر كاسم المرسل في البريد الوارد</span>
          </div>
        </div>

        {/* Test status */}
        {testState && testState !== 'loading' && (
          <div className={`sp-test-result ${testState.ok ? 'sp-test-result--ok' : 'sp-test-result--err'}`}>
            {testState.ok
              ? <CheckCircle size={16}/>
              : <XCircle    size={16}/>
            }
            <span>{testState.msg}</span>
          </div>
        )}

        {/* Actions */}
        <div className="sp-actions">
          <button
            className="sp-btn sp-btn--test"
            onClick={handleTest}
            disabled={!form.host || !form.user || !form.pass || testState === 'loading'}
          >
            {testState === 'loading'
              ? <Loader size={15} className="sp-spin" />
              : <Wifi size={15}/>
            }
            اختبار الاتصال
          </button>

          <button
            className="sp-btn sp-btn--save"
            onClick={handleSave}
            disabled={saveMut.isPending}
          >
            {saveMut.isPending
              ? <Loader size={15} className="sp-spin" />
              : <Save size={15}/>
            }
            حفظ الإعدادات
          </button>

          {saveMut.isSuccess && !saveMut.isPending && (
            <span className="sp-save-ok">
              <CheckCircle size={14}/> تم الحفظ
            </span>
          )}
          {saveMut.isError && (
            <span className="sp-save-err">
              <XCircle size={14}/> فشل الحفظ
            </span>
          )}
        </div>
      </div>

      {/* Info box */}
      <div className="sp-info">
        <strong>ملاحظات:</strong>
        <ul>
          <li>يُستخدم هذا الخادم لإرسال إشعارات المهام تلقائياً عند إسنادها أو إنجازها.</li>
          <li>إذا كنت تستخدم Gmail، فعّل "كلمات مرور التطبيقات" (App Passwords) بدلاً من كلمة المرور الأصلية.</li>
          <li>المنفذ الافتراضي: <strong>587</strong> مع STARTTLS، أو <strong>465</strong> مع SSL مباشر.</li>
          <li>تُحفظ الإعدادات في قاعدة البيانات وتُطبَّق فوراً دون إعادة تشغيل.</li>
        </ul>
      </div>
    </div>
  );
}
