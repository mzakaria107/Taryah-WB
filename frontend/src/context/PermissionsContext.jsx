import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import client from '../api/client';
import { DEFAULT_PERMS } from '../data/permissions';

const PermissionsContext = createContext(null);

function loadCache() {
  try {
    const s = localStorage.getItem('pp_v2');
    return s ? JSON.parse(s) : DEFAULT_PERMS;
  } catch { return DEFAULT_PERMS; }
}

export function PermissionsProvider({ children }) {
  const [perms, setPerms] = useState(loadCache);

  useEffect(() => {
    client.get('/permissions')
      .then(res => {
        // Merge API data over defaults so any missing keys still have a fallback
        const merged = { ...DEFAULT_PERMS };
        for (const [page, roles] of Object.entries(res.data)) {
          merged[page] = { ...(DEFAULT_PERMS[page] || {}), ...roles };
        }
        setPerms(merged);
        localStorage.setItem('pp_v2', JSON.stringify(merged));
      })
      .catch(() => {}); // keep cache/default on error
  }, []);

  const canAccess = useCallback(
    (role, pageKey) => (perms[pageKey]?.[role] ?? 0) > 0,
    [perms]
  );

  const updatePerm = useCallback(async (pageKey, role, level) => {
    // Optimistic update
    setPerms(prev => {
      const next = { ...prev, [pageKey]: { ...prev[pageKey], [role]: level } };
      localStorage.setItem('pp_v2', JSON.stringify(next));
      return next;
    });
    await client.put(`/permissions/${pageKey}/${role}`, { level });
  }, []);

  return (
    <PermissionsContext.Provider value={{ perms, canAccess, updatePerm }}>
      {children}
    </PermissionsContext.Provider>
  );
}

export function usePermissions() {
  return useContext(PermissionsContext);
}
