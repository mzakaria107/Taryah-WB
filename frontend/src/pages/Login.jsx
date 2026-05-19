import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './Login.css';
// Login page — branded scaleIn card, logoBounce logo, gold divider

export default function Login() {
  const { login, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [error, setError]       = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const res = await login(email, password);
    if (res.success) navigate('/');
    else setError(res.error);
  };

  return (
    <div className="login-bg">
      <div className="login-card">
        {/* Logo */}
        <div className="login-logo-wrap">
          <img
            src="/logo.png"
            alt="طرية"
            className="login-logo"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              e.currentTarget.nextElementSibling.style.display = 'flex';
            }}
          />
          <div className="login-logo-fallback" style={{ display: 'none' }}>ط</div>
        </div>

        {/* Title */}
        <h1 className="login-title">مرحباً بك</h1>
        <p className="login-sub">لوحة تحصيل طرية — سجّل دخولك للمتابعة</p>

        {/* Gold divider */}
        <div className="login-divider" />

        {/* Form */}
        <form className="login-form" onSubmit={handleSubmit} noValidate>
          {/* Email */}
          <label className="login-field">
            <span className="login-label">البريد الإلكتروني</span>
            <input
              type="email"
              className="login-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
              dir="ltr"
              placeholder="you@taryah.com"
            />
          </label>

          {/* Password */}
          <label className="login-field">
            <span className="login-label">كلمة المرور</span>
            <div className="login-pw-wrap">
              <input
                type={showPw ? 'text' : 'password'}
                className="login-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                dir="ltr"
                placeholder="••••••••"
              />
              <button
                type="button"
                className="login-pw-eye"
                onClick={() => setShowPw((s) => !s)}
                aria-label={showPw ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
              >
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>

          {/* Error */}
          {error && (
            <div className="login-error" role="alert">{error}</div>
          )}

          {/* Submit */}
          <button
            type="submit"
            className="login-btn"
            disabled={loading}
          >
            {loading
              ? <><span className="login-spinner" />جاري تسجيل الدخول…</>
              : 'تسجيل الدخول'}
          </button>
        </form>
      </div>
    </div>
  );
}
