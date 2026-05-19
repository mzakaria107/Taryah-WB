import React from 'react';

function fmt(n) {
  return Number(n).toLocaleString('en-SA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export default function YearStrip({ years = [], activeYear, onYearClick }) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-1 mb-4" style={{ direction: 'ltr' }}>
      <button
        onClick={() => onYearClick(null)}
        className={`flex-shrink-0 rounded-xl px-4 py-3 border text-sm font-semibold transition-all ${
          !activeYear
            ? 'bg-blue-600 text-white border-blue-600 shadow'
            : 'bg-white text-gray-600 border-gray-200 hover:border-blue-400'
        }`}
      >
        كل السنوات
      </button>

      {years.map((y) => {
        const active = String(activeYear) === String(y.year);
        const rate = parseFloat(y.collection_rate || 0);
        const rateColor = rate >= 90 ? '#16a34a' : rate >= 60 ? '#d97706' : '#dc2626';

        return (
          <button
            key={y.year}
            onClick={() => onYearClick(y.year)}
            className={`flex-shrink-0 rounded-xl px-4 py-3 border text-sm transition-all text-right ${
              active
                ? 'bg-blue-600 text-white border-blue-600 shadow'
                : 'bg-white text-gray-700 border-gray-200 hover:border-blue-400'
            }`}
          >
            <div className="font-bold text-base ltr-num">{y.year}</div>
            <div className={`text-xs mt-1 ltr-num ${active ? 'text-blue-100' : 'text-gray-500'}`}>
              {fmt(y.invoice_count)} فاتورة
            </div>
            <div className={`text-xs ltr-num ${active ? 'text-blue-100' : 'text-gray-500'}`}>
              رصيد: {fmt(y.total_balance)}
            </div>
            <div
              className="text-xs font-semibold ltr-num mt-0.5"
              style={{ color: active ? '#bfdbfe' : rateColor }}
            >
              {rate.toFixed(1)}%
            </div>
          </button>
        );
      })}
    </div>
  );
}
