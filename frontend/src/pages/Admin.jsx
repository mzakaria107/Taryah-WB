import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import { useAuth } from '../context/AuthContext';

const ROLE_LABELS = {
  super_admin:    'مدير عام',
  region_manager: 'مدير منطقة',
  sales_rep:      'مندوب مبيعات',
  it_admin:       'مدير تقنية',
};

export default function Admin() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [regions, setRegions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'sales_rep', region_id: '' });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [uRes, rRes] = await Promise.all([
        axios.get('/api/users'),
        axios.get('/api/users/regions'),
      ]);
      setUsers(uRes.data);
      setRegions(rRes.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setFormError('');
    setSaving(true);
    try {
      await axios.post('/api/auth/register', {
        ...form,
        region_id: form.region_id || null,
      });
      setShowForm(false);
      setForm({ name: '', email: '', password: '', role: 'sales_rep', region_id: '' });
      fetchData();
    } catch (err) {
      setFormError(err.response?.data?.error || 'فشل إنشاء المستخدم');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('هل أنت متأكد من حذف هذا المستخدم؟')) return;
    try {
      await axios.delete(`/api/users/${id}`);
      fetchData();
    } catch (err) {
      alert(err.response?.data?.error || 'فشل الحذف');
    }
  };

  const inp = 'block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400';

  return (
    <div className="min-h-screen bg-[#f4f6fa]">
      <Navbar />
      <main className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-xl font-bold text-gray-800">إدارة المستخدمين</h1>
            <Link to="/" className="text-xs text-blue-500 hover:underline">← العودة للوحة</Link>
          </div>
          {user?.role === 'super_admin' && (
            <button
              onClick={() => setShowForm(!showForm)}
              className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
            >
              + مستخدم جديد
            </button>
          )}
        </div>

        {/* Create User Form */}
        {showForm && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-5">
            <h2 className="font-semibold text-gray-700 mb-4">إنشاء مستخدم جديد</h2>
            <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">الاسم</label>
                <input className={inp} required value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">البريد الإلكتروني</label>
                <input className={inp} type="email" required dir="ltr" value={form.email} onChange={(e) => setForm({...form, email: e.target.value})} />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">كلمة المرور</label>
                <input className={inp} type="password" required dir="ltr" value={form.password} onChange={(e) => setForm({...form, password: e.target.value})} />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">الدور</label>
                <select className={inp} value={form.role} onChange={(e) => setForm({...form, role: e.target.value})}>
                  {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">المنطقة</label>
                <select className={inp} value={form.region_id} onChange={(e) => setForm({...form, region_id: e.target.value})}>
                  <option value="">كل المناطق</option>
                  {regions.map((r) => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
                </select>
              </div>

              {formError && (
                <div className="col-span-2 text-sm text-red-600 bg-red-50 rounded px-3 py-2">{formError}</div>
              )}

              <div className="col-span-2 flex gap-2 justify-end">
                <button type="button" onClick={() => setShowForm(false)} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5">إلغاء</button>
                <button type="submit" disabled={saving} className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {saving ? 'جاري الحفظ...' : 'حفظ'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Users Table */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-gray-400">جاري التحميل...</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">الاسم</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">البريد</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">الدور</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">المنطقة</th>
                  {user?.role === 'super_admin' && (
                    <th className="px-4 py-3 text-right font-semibold text-gray-600">إجراء</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-800">{u.name}</td>
                    <td className="px-4 py-3 text-gray-500 ltr-num">{u.email}</td>
                    <td className="px-4 py-3">
                      <span className="bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded-full">
                        {ROLE_LABELS[u.role] || u.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{u.region_name_ar || 'كل المناطق'}</td>
                    {user?.role === 'super_admin' && (
                      <td className="px-4 py-3">
                        {u.id !== user.id && (
                          <button
                            onClick={() => handleDelete(u.id)}
                            className="text-xs text-red-500 hover:text-red-700"
                          >
                            حذف
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}
