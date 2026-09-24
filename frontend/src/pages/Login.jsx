import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Languages } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import './Login.css';
// Login page — branded scaleIn card, logoBounce logo, gold divider

export default function Login() {
  const { login, loading } = useAuth();
  const { lang, setLang, t } = useLanguage();
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
      <button
        type="button"
        className="login-lang-btn"
        onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
      >
        <Languages size={14} /> {lang === 'ar' ? 'EN' : 'ع'}
      </button>
      <div className="login-card">
        {/* Logo */}
        <div className="login-logo-wrap">
          <img
            src="/Logo.png"
            alt={t('logo')}
            className="login-logo"
            onError={(e) => {
              e.currentTarget.onerror = null; // prevent repeated retries
              e.currentTarget.style.display = 'none';
              e.currentTarget.nextElementSibling.style.display = 'flex';
            }}
          />
          <div className="login-logo-fallback" style={{ display: 'none' }}>ط</div>
        </div>

        {/* Title */}
        <h1 className="login-title">{t('loginWelcome')}</h1>
        <p className="login-sub">{t('loginSub')}</p>

        {/* Gold divider */}
        <div className="login-divider" />

        {/* Form */}
        <form className="login-form" onSubmit={handleSubmit} noValidate>
          {/* Email */}
          <label className="login-field">
            <span className="login-label">{t('loginEmail')}</span>
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
            <span className="login-label">{t('loginPassword')}</span>
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
                aria-label={showPw ? t('loginHidePw') : t('loginShowPw')}
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
              ? <><span className="login-spinner" />{t('loginSubmitting')}</>
              : t('loginSubmit')}
          </button>
        </form>
      </div>
    </div>
  );
}
