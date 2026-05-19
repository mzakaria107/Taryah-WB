import React, { createContext, useState, useCallback } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';
import './Toast.css';

export const ToastContext = createContext(null);

const ICONS = {
  success: <CheckCircle size={18} />,
  error:   <AlertCircle size={18} />,
  info:    <Info size={18} />,
};

const DURATION = 4000;

function ToastItem({ id, kind = 'info', title, message, onClose }) {
  return (
    <div
      className={`toast toast--${kind}`}
      role="alert"
      aria-live="assertive"
    >
      <span className="toast-icon">{ICONS[kind]}</span>
      <div className="toast-body">
        <div className="toast-title">{title}</div>
        {message && <div className="toast-msg">{message}</div>}
      </div>
      <button
        className="toast-close"
        onClick={() => onClose(id)}
        aria-label="إغلاق الإشعار"
      >
        <X size={14} />
      </button>
      <div className="toast-progress" />
    </div>
  );
}

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);

  const push = useCallback((toast) => {
    const id = Math.random().toString(36).slice(2);
    setItems((xs) => [...xs, { id, ...toast }]);
    setTimeout(() => {
      setItems((xs) => xs.filter((x) => x.id !== id));
    }, DURATION);
  }, []);

  const close = useCallback((id) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        className="toast-host"
        aria-live="polite"
        aria-atomic="false"
        aria-label="الإشعارات"
      >
        {items.map((t) => (
          <ToastItem key={t.id} {...t} onClose={close} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
