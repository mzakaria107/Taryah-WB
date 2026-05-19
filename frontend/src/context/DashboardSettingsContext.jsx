import React, { createContext, useContext, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './AuthContext';
import client from '../api/client';

/* ── Shared default values ───────────────────────── */
export const SETTING_DEFAULTS = {
  kpi_settings: {
    size: 'normal', fontScale: 1.0,
    cardOrder:  ['invoices_total', 'paid_total', 'balance', 'rate', 'customers', 'invoice_count'],
    cardSizes:  {}, cardSpans: {}, cardHidden: {},
  },
  status_row_settings: {
    order:     ['partial_card', 'unpaid_card', 'invoice_chart', 'year_strip'],
    sizes:     { partial_card: 'normal', unpaid_card: 'normal', invoice_chart: 'large', year_strip: 'large' },
    rowHeight: 480,
    fontScale: 1.0,
  },
  region_card_settings: {
    cardSize:  'normal',
    fontScale: 1.0,
  },
};

const DashboardSettingsContext = createContext(null);

export function DashboardSettingsProvider({ children }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = user?.role === 'super_admin';

  /* ── Fetch all settings from server ── */
  const { data: remote = {}, isLoading } = useQuery({
    queryKey:  ['dashboard-settings'],
    queryFn:   () => client.get('/settings').then(r => r.data),
    staleTime: 60_000,
    enabled:   !!user,            // only when logged in
  });

  /* ── Mutation: PUT /api/settings/:key ── */
  const mutation = useMutation({
    mutationFn: ({ key, value }) => client.put(`/settings/${key}`, value),
    onMutate: async ({ key, value }) => {
      await queryClient.cancelQueries({ queryKey: ['dashboard-settings'] });
      const prev = queryClient.getQueryData(['dashboard-settings']);
      queryClient.setQueryData(['dashboard-settings'], old => ({ ...(old || {}), [key]: value }));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined)
        queryClient.setQueryData(['dashboard-settings'], ctx.prev);
    },
  });

  /* ── Public API ── */
  const getSetting = useCallback((key) => {
    const defaults = SETTING_DEFAULTS[key] ?? {};
    const saved    = remote[key] ?? {};
    return { ...defaults, ...saved };
  }, [remote]);

  const updateSetting = useCallback((key, value) => {
    if (!canEdit) return;
    mutation.mutate({ key, value });
  }, [canEdit, mutation]);

  return (
    <DashboardSettingsContext.Provider value={{ getSetting, updateSetting, canEdit, isLoading }}>
      {children}
    </DashboardSettingsContext.Provider>
  );
}

export function useDashboardSettings() {
  const ctx = useContext(DashboardSettingsContext);
  if (!ctx) throw new Error('useDashboardSettings must be inside DashboardSettingsProvider');
  return ctx;
}
