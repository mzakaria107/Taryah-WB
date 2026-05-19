import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

export function useInvoices(filters = {}) {
  const [data, setData] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [kpi, setKpi] = useState(null);
  const [years, setYears] = useState([]);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { ...filters, limit: filters.limit || 200 };
      const [invRes, kpiRes, yearRes] = await Promise.all([
        axios.get('/api/invoices', { params }),
        axios.get('/api/invoices/kpi', { params }),
        axios.get('/api/invoices/years', { params }),
      ]);
      setData(invRes.data.data || []);
      setTotal(invRes.data.total || 0);
      setKpi(kpiRes.data);
      setYears(yearRes.data || []);
    } catch (err) {
      setError(err.response?.data?.error || 'خطأ في جلب البيانات');
    } finally {
      setLoading(false);
    }
  }, [JSON.stringify(filters)]);

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  return { data, total, loading, error, kpi, years, refetch: fetchInvoices };
}
