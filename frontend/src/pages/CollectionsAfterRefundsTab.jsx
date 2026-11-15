/* «التحصيل بعد الاستردادات» — collections-performance tab. Data: GET /collections/after-refunds
   (NetSuite SuiteQL). Every exclusion is a toggle that is ON (excluded) by default and can be
   switched off to include it. */
import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Printer, RefreshCw } from 'lucide-react';
import api from '../api/client';
import './CollectionsAfterRefundsTab.css';

const MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const DAYS = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const fmt = n => (n == null ? '–' : Math.round(Number(n)).toLocaleString('en-US'));
const dayNum = iso => Number(iso.slice(8, 10));
const dayLabel = r => `${DAYS[r.dow]} ${dayNum(r.date)}`;
const longDate = iso => {
  const d = new Date(`${iso}T00:00:00`);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

const TOGGLES = [
  { key: 'ex_clearing',    on: 'سندات «إقفال الدورة» مستبعدة', off: 'سندات «إقفال الدورة» مضمّنة',
    hint: 'سندات قبض مسجلة على حساب «خزينة عملاء وموردين» — تسوية وليست تحصيلاً نقدياً' },
  { key: 'ex_main',        on: 'المركز الرئيسي مستبعد من المناطق والمتوسط', off: 'المركز الرئيسي مضمّن في المناطق والمتوسط',
    hint: 'عملاء فئة «عملاء دجاج حي»' },
  { key: 'ex_friday',      on: 'الجمعة مستبعدة من المتوسط', off: 'الجمعة مضمّنة في المتوسط' },
  { key: 'ex_today',       on: 'اليوم الجاري مستبعد من المتوسط', off: 'اليوم الجاري مضمّن في المتوسط',
    hint: 'اليوم لم يكتمل بعد' },
  { key: 'deduct_refunds', on: 'الاستردادات مخصومة', off: 'الاستردادات غير مخصومة',
    hint: 'استردادات العملاء (Customer Refund) تُطرح من سندات القبض' },
];

export default function CollectionsAfterRefundsTab() {
  const now = new Date();
  const [mode, setMode] = useState('month'); // 'month' | 'range'
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const todayIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(todayIso);
  const [opts, setOpts] = useState({ ex_clearing: true, ex_main: true, ex_friday: true, ex_today: true, deduct_refunds: true });
  const [refreshTick, setRefreshTick] = useState(0);
  const rangeInvalid = mode === 'range' && (!dateFrom || !dateTo || dateTo < dateFrom);

  const params = useMemo(() => {
    const p = mode === 'range' ? { date_from: dateFrom, date_to: dateTo } : { year, month };
    Object.entries(opts).forEach(([k, v]) => { p[k] = v ? 1 : 0; });
    return p;
  }, [mode, dateFrom, dateTo, year, month, opts]);

  const { data, isLoading, isFetching, isError, error } = useQuery({
    queryKey: ['collections-after-refunds', params, refreshTick],
    queryFn: () => api.get('/collections/after-refunds', { params: refreshTick ? { ...params, refresh: 1 } : params }).then(r => r.data),
    enabled: !rangeInvalid,
    staleTime: 2 * 60 * 1000,
    keepPreviousData: true,
  });

  const maxNet = useMemo(() => Math.max(1, ...(data?.days || []).map(d => d.net)), [data]);
  const handlePrint = () => {
    const prev = document.title;
    document.title = 'التحصيل بعد الاستردادات';
    document.body.classList.add('car-printing');
    window.onafterprint = () => { document.body.classList.remove('car-printing'); document.title = prev; window.onafterprint = null; };
    window.print();
  };

  const k = data?.kpis;
  const o = data?.options || opts;
  const years = [now.getFullYear() - 1, now.getFullYear()];

  return (
    <div className="car">
      {/* ── Controls ── */}
      <div className="car-controls car-no-print">
        <div className="car-row">
          <div className="car-mode">
            <button className={mode === 'month' ? 'is-on' : ''} onClick={() => setMode('month')}>شهر محدد</button>
            <button className={mode === 'range' ? 'is-on' : ''} onClick={() => setMode('range')}>من تاريخ — إلى تاريخ</button>
          </div>
          {mode === 'month' ? (
            <>
              <select className="car-input" value={year} onChange={e => setYear(Number(e.target.value))}>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <select className="car-input" value={month} onChange={e => setMonth(Number(e.target.value))}>
                {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
              </select>
            </>
          ) : (
            <>
              <label className="car-lbl">من</label>
              <input type="date" className="car-input" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} />
              <label className="car-lbl">إلى</label>
              <input type="date" className="car-input" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} />
            </>
          )}
          <button className="car-btn" onClick={() => setRefreshTick(t => t + 1)} disabled={isFetching} title="جلب أحدث البيانات من NetSuite">
            <RefreshCw size={14} className={isFetching ? 'car-spin' : ''} /> تحديث
          </button>
          <button className="car-btn car-btn--dark" onClick={handlePrint} disabled={!data}>
            <Printer size={14} /> طباعة / PDF
          </button>
        </div>
        <div className="car-row car-toggles">
          <span className="car-lbl">الاستثناءات:</span>
          {TOGGLES.map(t => (
            <button key={t.key} title={t.hint || ''}
              className={`car-toggle${opts[t.key] ? ' is-on' : ''}`}
              onClick={() => setOpts(s => ({ ...s, [t.key]: !s[t.key] }))}>
              <span className="car-toggle-dot" />{opts[t.key] ? t.on : t.off}
            </button>
          ))}
        </div>
        {rangeInvalid && <div className="car-error">نطاق التاريخ غير صحيح.</div>}
      </div>

      {isLoading && <div className="car-empty">جاري جلب البيانات من NetSuite…</div>}
      {isError && <div className="car-error">{error?.response?.data?.error || 'تعذّر تحميل التقرير'}</div>}

      {data && (
        <div className="car-report">
          <div className="car-title">
            التحصيل بعد الاستردادات – {data.period.from === data.period.to ? longDate(data.period.to) : `${longDate(data.period.from)} — ${longDate(data.period.to)}`}
          </div>
          <div className="car-sub">
            من {dayNum(data.period.from)} {MONTHS[Number(data.period.from.slice(5, 7)) - 1]} حتى {dayNum(data.period.to)} {MONTHS[Number(data.period.to.slice(5, 7)) - 1]} {data.period.to.slice(0, 4)}
            {' | '}المصدر: NetSuite{' | '}البيانات حتى {new Date(data.fetched_at).toLocaleString('ar-SA-u-nu-latn', { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })}
            {isFetching && ' · جاري التحديث…'}
          </div>

          {/* ── KPI cards ── */}
          <div className="car-kpis">
            <Kpi label={`تحصيل اليوم${k.today_date === data.period.today ? ' (حتى الآن)' : ''}`} value={k.today_net}
                 sub={`${o.ex_main ? 'بدون المركز الرئيسي ' : ''}${fmt(o.ex_main ? k.today_without_main : k.today_net)}`} />
            <Kpi label="التحصيل التراكمي للفترة" value={k.cumulative} sub={`بدون المركز الرئيسي ${fmt(k.cumulative_without_main)}`} />
            <Kpi label="متوسط التحصيل اليومي" value={k.avg_daily}
                 sub={`على ${k.avg_days} يوم${o.ex_friday ? ' بدون الجمعة' : ''}${o.ex_main ? ' · بدون المركز الرئيسي' : ''}`} />
            <Kpi label="أعلى يوم" value={k.best_day?.net} sub={k.best_day ? dayLabel({ date: k.best_day.date, dow: new Date(`${k.best_day.date}T00:00:00`).getDay() }) : ''} />
            <Kpi label="الاستردادات المخصومة" value={k.refunds} sub={`${k.refunds_pct}% من سندات القبض`} tone="red" />
            <Kpi label="عملاء دفعوا (الفترة)" value={k.customers_period} sub={`اليوم ${fmt(k.customers_today)}`} />
          </div>

          <div className="car-grid">
            {/* ── Daily table ── */}
            <table className="car-table car-daily">
              <thead>
                <tr>
                  <th>اليوم</th><th>سندات القبض</th><th className="car-th-red">الاستردادات</th><th>التحصيل الصافي</th><th className="car-th-bar" />
                  <th>منه المركز الرئيسي</th><th>بدون المركز الرئيسي</th><th>التراكمي</th><th>عن المتوسط</th><th>عملاء دفعوا</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map(r => (
                  <tr key={r.date} className={`${r.is_today ? 'is-today' : ''}${r.is_friday ? ' is-friday' : ''}`}>
                    <td className="car-day">{dayLabel(r)}{r.is_today ? ' (جاري)' : ''}</td>
                    <td>{fmt(r.receipts)}</td>
                    <td className="car-red">{r.refunds ? fmt(r.refunds) : '–'}</td>
                    <td className="car-bold">{fmt(r.net)}</td>
                    <td className="car-bar-cell"><span className="car-bar" style={{ width: `${Math.max(0, r.net) / maxNet * 100}%` }} /></td>
                    <td>{r.main ? fmt(r.main) : '–'}</td>
                    <td>{fmt(r.without_main)}</td>
                    <td className="car-bold">{fmt(r.cumulative)}</td>
                    <td className={r.vs_avg_pct == null ? '' : r.vs_avg_pct >= 0 ? 'car-up' : 'car-down'}>
                      {r.vs_avg_pct == null ? '–' : <bdi dir="ltr">{`${r.vs_avg_pct > 0 ? '+' : ''}${Math.round(r.vs_avg_pct)}%`}</bdi>}
                    </td>
                    <td>{r.customers || '–'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>الإجمالي</td><td>{fmt(data.totals.receipts)}</td><td className="car-red">{fmt(data.totals.refunds)}</td>
                  <td>{fmt(data.totals.net)}</td><td /><td>{fmt(data.totals.main)}</td><td>{fmt(data.totals.without_main)}</td>
                  <td>{fmt(data.totals.net)}</td><td /><td>{fmt(data.totals.customers)}</td>
                </tr>
              </tfoot>
            </table>

            {/* ── Region table + notes ── */}
            <div className="car-side">
              <table className="car-table car-regions">
                <thead>
                  <tr><th>المنطقة</th><th>اليوم</th><th>التراكمي</th><th>المتوسط اليومي</th><th>النسبة</th></tr>
                </thead>
                <tbody>
                  {data.regions.map(r => (
                    <tr key={r.region}>
                      <td className="car-day">{r.region}</td><td>{fmt(r.today)}</td><td className="car-bold">{fmt(r.cumulative)}</td>
                      <td>{fmt(r.avg_daily)}</td><td>{Math.round(r.share_pct)}%</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>الإجمالي{o.ex_main ? ' بدون المركز الرئيسي' : ''}</td><td>{fmt(data.region_totals.today)}</td>
                    <td>{fmt(data.region_totals.cumulative)}</td><td>{fmt(data.region_totals.avg_daily)}</td><td>100%</td>
                  </tr>
                </tfoot>
              </table>

              <ul className="car-notes">
                <li>التحصيل = سندات القبض{o.deduct_refunds ? ' − استردادات العملاء (Customer Refund) في نفس اليوم' : ' (الاستردادات غير مخصومة)'}.</li>
                <li>التراكمي من أول الفترة. المتوسط اليومي = تحصيل الأيام {o.ex_today ? 'المكتملة' : ''}{o.ex_friday ? ' ما عدا الجمعة' : ''} ÷ عددها ({k.avg_days} يوم){o.ex_main ? '، بدون المركز الرئيسي' : ''}.</li>
                <li>المنطقة = مستودع الفاتورة المسددة؛ غير المخصص على فواتير والاستردادات حسب منطقة آخر فاتورة للعميل.</li>
                <li>{o.ex_main
                  ? <>جدول المناطق والمتوسط <b>بدون عملاء المركز الرئيسي (الدجاج الحي)</b> — تحصيلهم في الفترة {fmt(data.totals.main)} ريال، ظاهر يوم بيوم في عمود «منه المركز الرئيسي».</>
                  : <>عملاء المركز الرئيسي (الدجاج الحي) <b>مضمّنون</b> في المناطق والمتوسط.</>}</li>
                <li>«عن المتوسط» = فرق تحصيل اليوم {o.ex_main ? 'بدون المركز الرئيسي ' : ''}عن المتوسط اليومي.</li>
                {data.excluded_docs.length > 0 && (
                  <li>
                    <b>{o.ex_clearing ? 'مستبعد من التقرير' : 'مضمّن في التقرير'}:</b> {data.excluded_docs.length} سند «إقفال دورة» على حساب «خزينة عملاء وموردين» بإجمالي{' '}
                    <b>{fmt(data.excluded_docs.reduce((s, d) => s + d.amount, 0))}</b> ريال
                    ({data.excluded_docs.map(d => `${d.customer} ${fmt(d.amount)} — ${dayNum(d.date)}/${Number(d.date.slice(5, 7))}`).join('، ')}) — تسوية وليست تحصيلاً نقدياً.
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone }) {
  return (
    <div className={`car-kpi${tone === 'red' ? ' car-kpi--red' : ''}`}>
      <div className="car-kpi-lbl">{label}</div>
      <div className="car-kpi-val">{fmt(value)}</div>
      {sub && <div className="car-kpi-sub">{sub}</div>}
    </div>
  );
}
