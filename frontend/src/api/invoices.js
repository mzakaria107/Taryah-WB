import client from './client';

export const getInvoices = (params) =>
  client.get('/invoices', { params }).then((r) => r.data);

export const getYears = (params) =>
  client.get('/invoices/years', { params }).then((r) => r.data);

export const getKPIs = (params) =>
  client.get('/invoices/kpi', { params }).then((r) => r.data);

export const getInvoice = (id) =>
  client.get(`/invoices/${id}`).then((r) => r.data);

export const patchNote = (id, note) =>
  client.put(`/notes/${id}`, { note_text: note }).then((r) => r.data);

export const exportCSV = (params) =>
  client
    .get('/invoices/export/csv', { params, responseType: 'blob' })
    .then((r) => r.data);

export const exportExcel = (params) =>
  client
    .get('/invoices/export/excel', { params, responseType: 'blob' })
    .then((r) => r.data);
