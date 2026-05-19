import React from 'react';

const MONTHS = [
  { v: '', l: 'كل الأشهر' },
  { v: '1', l: 'يناير' }, { v: '2', l: 'فبراير' }, { v: '3', l: 'مارس' },
  { v: '4', l: 'أبريل' }, { v: '5', l: 'مايو' }, { v: '6', l: 'يونيو' },
  { v: '7', l: 'يوليو' }, { v: '8', l: 'أغسطس' }, { v: '9', l: 'سبتمبر' },
  { v: '10', l: 'أكتوبر' }, { v: '11', l: 'نوفمبر' }, { v: '12', l: 'ديسمبر' },
];

export default function Filters({ filters, onChange, regions = [], user }) {
  const handle        = (key) => (e) => onChange({ ...filters, [key]: e.target.value });
  const handleToggle  = () => onChange({ ...filters, includeDirect: !filters.includeDirect });

  const sel = 'block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400';

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">

        {/* Search — Arabic or English name */}
        <div className="col-span-2">
          <label className="block text-xs text-gray-500 mb-1">بحث (اسم العميل بالعربي أو الإنجليزي)</label>
          <input
            type="text"
            placeholder="اسم العميل..."
            value={filters.search || ''}
            onChange={handle('search')}
            className={sel}
          />
        </div>

        {/* Region */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">المنطقة</label>
          <select
            value={filters.region_id || ''}
            onChange={handle('region_id')}
            disabled={user?.role !== 'super_admin'}
            className={`${sel} ${user?.role !== 'super_admin' ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            <option value="">كل المناطق</option>
            {regions.map((r) => (
              <option key={r.id} value={r.id}>{r.name_ar}</option>
            ))}
          </select>
        </div>

        {/* Month */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">الشهر</label>
          <select value={filters.month || ''} onChange={handle('month')} className={sel}>
            {MONTHS.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
          </select>
        </div>

        {/* Status */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">حالة الدفع</label>
          <select value={filters.status || ''} onChange={handle('status')} className={sel}>
            <option value="">الكل</option>
            <option value="unpaid">غير مدفوع</option>
            <option value="partial">جزئي</option>
            <option value="paid">مدفوع</option>
          </select>
        </div>

        {/* Route */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">كود المسار</label>
          <input
            type="number"
            placeholder="مثال: 1101"
            value={filters.route_id || ''}
            onChange={handle('route_id')}
            className={`${sel} ltr-num`}
            dir="ltr"
          />
        </div>
      </div>

      {/* Second row */}
      <div className="mt-3 flex items-center gap-4 flex-wrap">
        {/* Include direct toggle */}
        <button
          onClick={handleToggle}
          className="flex items-center gap-2 focus:outline-none"
          type="button"
        >
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              filters.includeDirect !== false ? 'bg-blue-500' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                filters.includeDirect !== false ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </span>
          <span className="text-sm text-gray-600">تضمين المبيعات المباشرة</span>
        </button>

        {/* Balance only */}
        <button
          onClick={() => onChange({ ...filters, status: filters.status === 'unpaid' || filters.status === 'partial' ? '' : 'unpaid' })}
          className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
            (filters.status === 'unpaid' || filters.status === 'partial')
              ? 'bg-red-500 text-white border-red-500'
              : 'bg-white text-red-500 border-red-200 hover:border-red-400'
          }`}
        >
          عرض الرصيد المتبقي فقط
        </button>

        {/* Clear */}
        <button
          onClick={() => onChange({ includeDirect: true })}
          className="text-xs text-gray-400 hover:text-gray-600 underline mr-auto"
          type="button"
        >
          مسح كل الفلاتر
        </button>
      </div>
    </div>
  );
}
