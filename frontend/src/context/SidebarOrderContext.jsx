/**
 * SidebarOrderContext
 * Fetches/persists the sidebar navigation order from the server (app_settings key: sidebar_order).
 * Any admin change is written to the DB and reflected for ALL users on next load.
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import client from '../api/client';
import { ALL_NAV } from '../data/navConfig';

const SidebarOrderContext = createContext(null);

export function SidebarOrderProvider({ children }) {
  // null  = use default order (ALL_NAV as-is)
  // array = server-persisted pageKey order
  const [order, setOrder] = useState(null);

  /* Fetch from server once on mount (only when logged in) */
  useEffect(() => {
    if (!localStorage.getItem('token')) return;
    client.get('/settings/sidebar_order')
      .then(res => {
        const val = res.data?.value;
        setOrder(Array.isArray(val) && val.length > 0 ? val : null);
      })
      .catch(() => {}); // silently fall back to default
  }, []);

  /** Admin: save new order to server → propagates to all users */
  const saveOrder = useCallback(async (arr) => {
    setOrder(arr);
    await client.put('/settings/sidebar_order', { value: arr });
  }, []);

  /** Admin: reset to factory default */
  const resetOrder = useCallback(async () => {
    setOrder(null);
    await client.put('/settings/sidebar_order', { value: [] });
  }, []);

  return (
    <SidebarOrderContext.Provider value={{ order, saveOrder, resetOrder }}>
      {children}
    </SidebarOrderContext.Provider>
  );
}

export function useSidebarOrder() {
  return useContext(SidebarOrderContext);
}
