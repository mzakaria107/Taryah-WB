import client from './client';

export const getKPIs = (params) =>
  client.get('/invoices/kpi', { params }).then((r) => r.data);

export const getYears = (params) =>
  client.get('/invoices/years', { params }).then((r) => r.data);
