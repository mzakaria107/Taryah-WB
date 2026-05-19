import React from 'react';

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function rateColor(rate) {
  const r = parseFloat(rate);
  if (r >= 90) return 'text-green-600';
  if (r >= 60) return 'text-amber-500';
  return 'text-red-600';
}

function Card({ label, value, subLabel, colorClass = 'text-gray-900' }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex flex-col gap-1">
      <span className="text-xs text-gray-500 font-medium">{label}</span>
      <span className={`text-xl font-bold ltr-num ${colorClass}`}>{value}</span>
      {subLabel && <span className="text-xs text-gray-400">{subLabel}</span>}
    </div>
  );
}

export default function KPICards({ kpi }) {
  if (!kpi) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 animate-pulse h-20" />
        ))}
      </div>
    );
  }

  const rate = parseFloat(kpi.collection_rate || 0);

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
      <Card
        label="إجمالي المبالغ"
        value={fmt(kpi.total_amount)}
        subLabel="ريال سعودي"
      />
      <Card
        label="إجمالي المدفوع"
        value={fmt(kpi.total_paid)}
        subLabel="ريال سعودي"
        colorClass="text-green-600"
      />
      <Card
        label="الرصيد المتبقي"
        value={fmt(kpi.total_balance)}
        subLabel="ريال سعودي"
        colorClass="text-red-600"
      />
      <Card
        label="نسبة التحصيل"
        value={`${rate.toFixed(1)}%`}
        colorClass={rateColor(rate)}
      />
      <Card
        label="عدد العملاء"
        value={Number(kpi.customer_count || 0).toLocaleString()}
      />
      <Card
        label="عدد الفواتير"
        value={Number(kpi.invoice_count || 0).toLocaleString()}
      />
    </div>
  );
}
