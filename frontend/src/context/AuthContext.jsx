import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import axios from 'axios';

const AuthContext = createContext(null);

// A corrupted or legacy localStorage['user'] value (e.g. the literal string
// "undefined", written by `JSON.stringify(undefined)` if a login response
// ever omitted `user`) must not crash the whole app on mount — there is no
// error boundary, so an uncaught exception here blanks the entire page with
// no navbar/error message at all. Treat any unparsable value as logged-out.
function readStoredUser() {
  const raw = localStorage.getItem('user');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    localStorage.removeItem('user');
    localStorage.removeItem('token');
    return null;
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [user, setUser] = useState(readStoredUser);
  const [loading, setLoading] = useState(false);
  const heartbeatRef = useRef(null);

  useEffect(() => {
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      // Send heartbeat immediately + every 3 minutes to track last_seen_at
      const beat = () => axios.post('/api/auth/heartbeat').catch(() => {});
      beat();
      heartbeatRef.current = setInterval(beat, 3 * 60 * 1000);
    } else {
      delete axios.defaults.headers.common['Authorization'];
      clearInterval(heartbeatRef.current);
    }
    return () => clearInterval(heartbeatRef.current);
  }, [token]);

  const login = async (email, password) => {
    setLoading(true);
    try {
      const { data } = await axios.post('/api/auth/login', { email, password });
      if (!data?.token || !data?.user) {
        return { success: false, error: 'استجابة غير صالحة من الخادم، حاول مجدداً' };
      }
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      axios.defaults.headers.common['Authorization'] = `Bearer ${data.token}`;
      setToken(data.token);
      setUser(data.user);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.response?.data?.error || 'فشل تسجيل الدخول' };
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    delete axios.defaults.headers.common['Authorization'];
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ token, user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
