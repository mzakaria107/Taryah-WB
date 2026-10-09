import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Target, Printer } from 'lucide-react';
import api from '../api/client';
import { PLAN_TARGET, PLAN_REGIONS, PLAN_ITEMS, planDailyForRegion, planDailyForItem } from '../data/salesPlan';
import './SalesPlanPage.css';

const fmt  = (n, d = 0) => (n == null || !isFinite(n)) ? '—' : Number(n).toLocaleString('en-SA', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtK = n => (n == null || !isFinite(n)) ? '—' : Math.abs(n) >= 1e6 ? `${fmt(n / 1e6, 2)}M` : Math.abs(n) >= 1e3 ? `${fmt(n / 1e3, 0)}K` : fmt(n);
const pct  = (n, d = 1) => (n == null || !isFinite(n)) ? '—' : `${fmt(n, d)}%`;
const MONTHS_AR = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

function GapCell({ gap }) {
  if (gap == null || !isFinite(gap)) return <td>—</td>;
  return <td className={gap > 0 ? 'sp-neg' : 'sp-pos'}>{gap > 0 ? '−' : '+'}{fmt(Math.abs(gap))}</td>;
}

export default function SalesPlanPage() {
  const [months,   setMonths]   = useState(9);
  const [buffer,   setBuffer]   = useState(15);   // safety margin on required customers, %
  const [uplift,   setUplift]   = useState(0);    // assumed growth in sales per customer, %
  const [daysMode, setDaysMode] = useState('selling'); // 'selling' | 'calendar'

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['sales-plan', months],
    queryFn: () => api.get('/sales-plan', { params: { months } }).then(r => r.data),
    staleTime: 300_000,
  });

  const calc = useMemo(() => {
    if (!data) return null;
    const days = daysMode === 'selling' ? (data.window.selling_days || data.window.calendar_days) : data.window.calendar_days;
    const byDb = new Map(data.regions.map(r => [r.region, r]));

    const totalActualDaily = data.regions.reduce((s, r) => s + r.qty, 0) / days;
    const totalActive = data.regions.reduce((s, r) => s + r.avg_active_customers, 0);
    const companyPerCust = totalActive ? totalActualDaily / totalActive : 0;

    const regions = PLAN_REGIONS.map(p => {
      const a = byDb.get(p.db) || {};
      const actualDaily = (a.qty || 0) / days;
      const planDaily = planDailyForRegion(p.key);
      const active = a.avg_active_customers || 0;
      const perCustActual = active ? actualDaily / active : 0;
      // Agencies / regions without history borrow the company productivity.
      const perCustBase = perCustActual || companyPerCust;
      const perCustPlan = perCustBase * (1 + uplift / 100);
      const required = perCustPlan ? planDaily / perCustPlan : null;
      const safe = required != null ? Math.ceil(required * (1 + buffer / 100)) : null;
      const reps = p.staff.plannedReps || 0;
      return {
        ...p, a, actualDaily, planDaily, gap: planDaily - actualDaily,
        achievement: planDaily ? (actualDaily / planDaily) * 100 : null,
        active, perCustActual, perCustBase, required, safe,
        additional: safe != null ? safe - active : null,
        actualReps: a.avg_active_reps || 0,
        custPerRep: reps && safe ? safe / reps : null,
        dailyPerRep: reps ? planDaily / reps : null,
        actualPerRep: a.avg_active_reps ? actualDaily / a.avg_active_reps : null,
        borrowed: !perCustActual,
        collectionRate: a.invoiced ? (a.collected / a.invoiced) * 100 : null,
        dso: a.invoiced ? a.debt / (a.invoiced / data.window.calendar_days) : null,
        over90Share: a.debt ? (a.over90 / a.debt) * 100 : null,
      };
    });

    // Regions with sales/debt that are not in the plan (e.g. Hafir El Batin)
    const planned = new Set(PLAN_REGIONS.map(p => p.db));
    const outside = data.regions.filter(r => !planned.has(r.region));

    const sum = (list, f) => list.reduce((s, r) => s + (f(r) || 0), 0);
    const all = data.regions;
    const totals = {
      actualDaily: totalActualDaily,
      planDaily: PLAN_TARGET,
      gap: PLAN_TARGET - totalActualDaily,
      active: totalActive,
      planActive: sum(regions, r => r.active),
      required: sum(regions, r => r.required),
      safe: sum(regions, r => r.safe),
      reps: sum(regions, r => r.staff.plannedReps),
      activeRepsSheet: sum(regions, r => r.staff.activeReps),
      actualReps: sum(all, r => r.avg_active_reps),
      invoiced: sum(all, r => r.invoiced),
      collected: sum(all, r => r.collected),
      debt: sum(all, r => r.debt),
      over60: sum(all, r => r.over60),
      over90: sum(all, r => r.over90),
      over180: sum(all, r => r.over180),
      over365: sum(all, r => r.over365),
      debtors: sum(all, r => r.debtors),
      dormantCustomers: sum(all, r => r.dormant_customers),
      dormantDebt: sum(all, r => r.dormant_debt),
      revenue: sum(all, r => r.revenue),
      qty: sum(all, r => r.qty),
    };
    totals.collectionRate = totals.invoiced ? (totals.collected / totals.invoiced) * 100 : null;
    totals.dso = totals.invoiced ? totals.debt / (totals.invoiced / data.window.calendar_days) : null;
    totals.achievement = (totals.actualDaily / PLAN_TARGET) * 100;
    totals.asp = totals.qty ? totals.revenue / totals.qty : null;

    // Item mix: actual daily per weight class (company + per region)
    const itemActual = (regionDb, it) => {
      const rows = regionDb ? [byDb.get(regionDb)].filter(Boolean) : all;
      if (it.grams == null) return sum(rows, r => r.fillet?.qty) / days;
      return sum(rows, r => r.weights?.[String(it.grams)]?.qty) / days;
    };
    const itemRevenue = it => it.grams == null ? sum(all, r => r.fillet?.revenue) : sum(all, r => r.weights?.[String(it.grams)]?.revenue);
    const itemQty = it => it.grams == null ? sum(all, r => r.fillet?.qty) : sum(all, r => r.weights?.[String(it.grams)]?.qty);
    const items = PLAN_ITEMS.map(it => {
      const plan = planDailyForItem(it);
      const actual = itemActual(null, it);
      const q = itemQty(it);
      return { ...it, plan, actual, gap: plan - actual, planRevenue: plan * it.price,
               asp: q ? itemRevenue(it) / q : null };
    });
    const planRevenue = sum(items, i => i.planRevenue);
    const actualRevenueDaily = totals.revenue / days;

    return { days, regions, outside, totals, items, itemActual, planRevenue, actualRevenueDaily, companyPerCust };
  }, [data, buffer, uplift, daysMode]);

  /* ── Data-driven findings ─────────────────────────────── */
  const findings = useMemo(() => {
    if (!calc || !data) return null;
    const t = calc.totals;
    const debtProblems = [];
    const top10 = data.top_debtors.reduce((s, r) => s + r.debt, 0);
    if (t.debt) {
      debtProblems.push({ w: t.over90, title: 'تقادم المديونية',
        text: `${pct((t.over90 / t.debt) * 100)} من المديونية (${fmtK(t.over90)}) عمرها أكثر من 90 يوم، منها ${fmtK(t.over180)} أكثر من 180 يوم و${fmtK(t.over365)} أكثر من سنة — كلما زاد العمر قلّت فرصة التحصيل.` });
      debtProblems.push({ w: t.dormantDebt, title: 'عملاء مدينون توقفوا عن الشراء',
        text: `${fmt(t.dormantCustomers)} عميل عليهم ${fmtK(t.dormantDebt)} (${pct((t.dormantDebt / t.debt) * 100)} من الدين) ولم يشتروا منذ أكثر من 60 يوم — العميل الذي توقف عن الشراء فقد حافز السداد.` });
      debtProblems.push({ w: top10, title: 'تركّز المديونية',
        text: `أكبر 10 عملاء عليهم ${fmtK(top10)} = ${pct((top10 / t.debt) * 100)} من إجمالي الدين — تعثّر أي منهم يؤثر مباشرة على السيولة.` });
      if (data.carrefour_debt) debtProblems.push({ w: data.carrefour_debt, title: 'مديونية كارفور',
        text: `${fmtK(data.carrefour_debt)} (${pct((data.carrefour_debt / t.debt) * 100)}) على كارفور — دورة سداد طويلة بطبيعة التعامل مع الهايبر، تحتاج متابعة مطالبات منتظمة وليس مندوب.` });
      if (data.bad_debt?.debt) debtProblems.push({ w: data.bad_debt.debt, title: 'مديونية معدومة مسجّلة',
        text: `${fmt(data.bad_debt.customers)} عميل مسجّل كمعدوم برصيد ${fmtK(data.bad_debt.debt)} — تحتاج قرار شطب/إجراء قانوني وفصلها عن الدين القابل للتحصيل.` });
      const worstRep = data.reps_overdue[0];
      if (worstRep?.over90) debtProblems.push({ w: worstRep.over90 * 0.5, title: 'تركّز المتأخرات عند مناديب',
        text: `أعلى مندوب في الدين المتأخر (+90 يوم): ${worstRep.rep} (${worstRep.region || '—'}) بـ ${fmtK(worstRep.over90)} — البيع الآجل يتم بدون ربط بحدود ائتمان فعلية.` });
      if (t.collectionRate != null && t.collectionRate < 100) debtProblems.push({ w: t.invoiced - t.collected, title: 'التحصيل أقل من المبيعات',
        text: `خلال الفترة تم تحصيل ${pct(t.collectionRate)} فقط من قيمة الفواتير (${fmtK(t.collected)} من ${fmtK(t.invoiced)}) — الفرق ${fmtK(t.invoiced - t.collected)} أضيف للمديونية.` });
    }
    const shown = debtProblems.filter(p => p.w > 0).sort((a, b) => b.w - a.w);

    const lagging = calc.regions.filter(r => r.gap > 0).sort((a, b) => b.gap - a.gap);
    const lowPerCust = calc.regions.filter(r => r.perCustActual && r.perCustActual < calc.companyPerCust * 0.8);
    const worstCollection = calc.regions.filter(r => r.collectionRate != null).sort((a, b) => a.collectionRate - b.collectionRate).slice(0, 3);
    return { debtProblems: shown, lagging, lowPerCust, worstCollection };
  }, [calc, data]);

  if (isLoading) return <div className="sp-page"><div className="sp-loading">جاري تحميل البيانات الفعلية…</div></div>;
  if (isError)   return <div className="sp-page"><div className="sp-loading">حدث خطأ في تحميل البيانات: {error?.response?.data?.error || error?.message}</div></div>;
  if (!calc) return null;

  const { totals: t, regions, items } = calc;
  const w = data.window;
  const periodLabel = `${MONTHS_AR[w.months[0].m - 1]} ${w.months[0].y} — ${MONTHS_AR[w.months[w.months.length - 1].m - 1]} ${w.months[w.months.length - 1].y}`;

  return (
    <div className="sp-page">
      <div className="sp-header">
        <Target size={24} color="#15803d" />
        <h1 className="sp-title">خطة المبيعات — الوصول إلى {fmt(PLAN_TARGET)} حبة يومياً</h1>
        <button className="sp-print-btn sp-no-print" onClick={() => window.print()}><Printer size={16} /> طباعة / PDF</button>
      </div>

      <div className="sp-controls sp-no-print">
        <label>فترة الفعلي
          <select value={months} onChange={e => setMonths(Number(e.target.value))}>
            {[3, 6, 9, 12].map(m => <option key={m} value={m}>آخر {m} أشهر مكتملة</option>)}
          </select>
        </label>
        <label>المتوسط اليومي على
          <select value={daysMode} onChange={e => setDaysMode(e.target.value)}>
            <option value="selling">أيام البيع الفعلية ({w.selling_days} يوم)</option>
            <option value="calendar">الأيام التقويمية ({w.calendar_days} يوم)</option>
          </select>
        </label>
        <label>هامش أمان العملاء
          <select value={buffer} onChange={e => setBuffer(Number(e.target.value))}>
            {[0, 10, 15, 20, 25, 30].map(b => <option key={b} value={b}>{b}%</option>)}
          </select>
        </label>
        <label>تحسين مبيعات العميل المفترض
          <select value={uplift} onChange={e => setUplift(Number(e.target.value))}>
            {[0, 5, 10, 15, 20, 25, 30].map(b => <option key={b} value={b}>{b}%</option>)}
          </select>
        </label>
      </div>
      <div className="sp-note">
        الفعلي: {periodLabel} · الصنف: {data.categories.join('، ')} · {data.exclude_direct ? 'بدون مبيعات المستودع المركزي (direct)' : 'شامل direct'} · المتوسط اليومي = الكمية ÷ {calc.days} يوم.
      </div>

      {/* ── KPIs ── */}
      <div className="sp-kpis">
        <div className="sp-kpi sp-kpi--main"><span>المتوسط اليومي الفعلي</span><b>{fmt(t.actualDaily)}</b><small>حبة / يوم</small></div>
        <div className="sp-kpi"><span>المستهدف اليومي</span><b>{fmt(PLAN_TARGET)}</b><small>نسبة التحقيق {pct(t.achievement)}</small></div>
        <div className="sp-kpi sp-kpi--gap"><span>الفجوة اليومية</span><b>{fmt(t.gap)}</b><small>نمو مطلوب {pct((t.gap / t.actualDaily) * 100, 0)}</small></div>
        <div className="sp-kpi"><span>متوسط العملاء الفعّالين / شهر</span><b>{fmt(t.active)}</b><small>{fmt(calc.companyPerCust, 1)} حبة / عميل / يوم</small></div>
        <div className="sp-kpi sp-kpi--target"><span>العملاء المطلوبين (آمن)</span><b>{fmt(t.safe)}</b><small>إضافي {fmt(t.safe - t.planActive)} عميل</small></div>
        <div className="sp-kpi"><span>إيراد يومي مخطط</span><b>{fmtK(calc.planRevenue)}</b><small>الفعلي {fmtK(calc.actualRevenueDaily)} ر.س / يوم</small></div>
      </div>

      {/* ── 1. Region plan vs actual ── */}
      <section className="sp-section">
        <h2>1) الفجوة بين المتوسط اليومي الفعلي والمخطط لكل منطقة</h2>
        <div className="sp-table-wrap">
          <table className="sp-table">
            <thead>
              <tr>
                <th>المنطقة</th><th>النوع</th>
                <th>الفعلي / يوم</th><th>المخطط / يوم</th><th>الفجوة</th><th>التحقيق</th>
                <th>عملاء فعّالين (متوسط شهري)</th><th>حبة / عميل / يوم</th>
                <th>العملاء المطلوبين</th><th>المطلوب الآمن (+{buffer}%)</th><th>إضافي مطلوب</th>
              </tr>
            </thead>
            <tbody>
              {regions.map(r => (
                <tr key={r.key} className={r.type === 'agency' ? 'sp-row--agency' : ''}>
                  <td className="sp-strong">{r.label}</td>
                  <td>{r.type === 'agency' ? 'وكالة' : 'مفرق'}</td>
                  <td>{fmt(r.actualDaily)}</td>
                  <td>{fmt(r.planDaily)}</td>
                  <GapCell gap={r.gap} />
                  <td><span className={`sp-ach ${r.achievement >= 90 ? 'sp-ach--ok' : r.achievement >= 60 ? 'sp-ach--mid' : 'sp-ach--low'}`}>{pct(r.achievement, 0)}</span></td>
                  <td>{fmt(r.active)}</td>
                  <td>{fmt(r.perCustActual, 1)}{r.borrowed && <span className="sp-hint" title="لا توجد مبيعات فعلية — استخدم متوسط الشركة">*</span>}</td>
                  <td>{fmt(r.required)}</td>
                  <td className="sp-strong">{fmt(r.safe)}</td>
                  <td className={r.additional > 0 ? 'sp-neg' : 'sp-pos'}>{r.additional > 0 ? '+' : ''}{fmt(r.additional)}</td>
                </tr>
              ))}
              {calc.outside.map(o => (
                <tr key={o.region} className="sp-row--outside">
                  <td>{o.region}</td><td>خارج الخطة</td>
                  <td>{fmt(o.qty / calc.days)}</td><td>—</td><td>—</td><td>—</td>
                  <td>{fmt(o.avg_active_customers)}</td><td>{fmt(o.avg_active_customers ? (o.qty / calc.days) / o.avg_active_customers : null, 1)}</td>
                  <td>—</td><td>—</td><td>—</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>الإجمالي</td><td />
                <td>{fmt(t.actualDaily)}</td><td>{fmt(PLAN_TARGET)}</td>
                <GapCell gap={t.gap} />
                <td>{pct(t.achievement, 0)}</td>
                <td>{fmt(t.active)}</td><td>{fmt(calc.companyPerCust, 1)}</td>
                <td>{fmt(t.required)}</td><td>{fmt(t.safe)}</td><td>+{fmt(t.safe - t.planActive)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="sp-explain">
          العملاء المطلوبين = المخطط اليومي ÷ (مبيعات العميل اليومية الفعلية في المنطقة × (1 + تحسين {uplift}%)).
          المطلوب الآمن يضيف {buffer}% لتعويض العملاء غير المنتظمين والتسرب. * = منطقة بلا مبيعات فعلية في الفترة، استُخدم متوسط الشركة.
        </p>
      </section>

      {/* ── 2. Staffing ── */}
      <section className="sp-section">
        <h2>2) الطاقة البيعية: المناديب والعملاء لكل مندوب</h2>
        <div className="sp-table-wrap">
          <table className="sp-table">
            <thead>
              <tr>
                <th>المنطقة</th><th>مدير فرع</th><th>مشرف</th><th>مناديب نشطة (الخطة)</th><th>مناديب بائعة فعلياً (متوسط)</th>
                <th>المناديب المخطط</th><th>حبة / مندوب / يوم مطلوب</th><th>حبة / مندوب / يوم فعلي</th><th>عملاء / مندوب مطلوب</th>
              </tr>
            </thead>
            <tbody>
              {regions.filter(r => r.type === 'retail').map(r => (
                <tr key={r.key}>
                  <td className="sp-strong">{r.label}</td>
                  <td>{r.staff.manager || '—'}</td><td>{r.staff.supervisors}</td><td>{r.staff.activeReps}</td>
                  <td>{fmt(r.actualReps, 1)}</td>
                  <td className="sp-strong">{r.staff.plannedReps}</td>
                  <td>{fmt(r.dailyPerRep)}</td><td>{fmt(r.actualPerRep)}</td>
                  <td>{fmt(r.custPerRep)}</td>
                </tr>
              ))}
              <tr className="sp-row--agency"><td className="sp-strong">جدة + المدينة</td><td colSpan={8}>وكالات للغير — الهدف {fmt(planDailyForRegion('jeddah') + planDailyForRegion('madinah'))} حبة/يوم يُدار بعقد كميات شهرية مع الوكيل وليس بمناديب</td></tr>
            </tbody>
            <tfoot>
              <tr>
                <td>الإجمالي</td><td>2</td><td>11</td><td>{t.activeRepsSheet}</td><td>{fmt(t.actualReps, 1)}</td><td>{t.reps}</td>
                <td>{fmt((PLAN_TARGET - planDailyForRegion('jeddah') - planDailyForRegion('madinah')) / t.reps)}</td><td /><td />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* ── 3. Item mix ── */}
      <section className="sp-section">
        <h2>3) مزيج الأصناف: المخطط مقابل الفعلي (حبة / يوم)</h2>
        <div className="sp-table-wrap">
          <table className="sp-table">
            <thead>
              <tr><th>الصنف</th><th>سعر الخطة</th><th>متوسط سعر البيع الفعلي</th><th>الفعلي / يوم</th><th>المخطط / يوم</th><th>الفجوة</th><th>إيراد يومي مخطط</th></tr>
            </thead>
            <tbody>
              {items.map(i => (
                <tr key={i.key}>
                  <td className="sp-strong">{i.label}</td>
                  <td>{fmt(i.price, 2)}</td><td>{fmt(i.asp, 2)}</td>
                  <td>{fmt(i.actual)}</td><td>{fmt(i.plan)}</td><GapCell gap={i.gap} />
                  <td>{fmt(i.planRevenue)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td>الإجمالي</td><td /><td>{fmt(t.asp, 2)}</td><td>{fmt(items.reduce((s, i) => s + i.actual, 0))}</td><td>{fmt(PLAN_TARGET)}</td><td /><td>{fmt(calc.planRevenue)}</td></tr>
            </tfoot>
          </table>
        </div>
        <details className="sp-details">
          <summary>تفصيل الأصناف لكل منطقة (فعلي / مخطط)</summary>
          <div className="sp-table-wrap">
            <table className="sp-table sp-table--matrix">
              <thead><tr><th>المنطقة</th>{PLAN_ITEMS.map(i => <th key={i.key}>{i.label}</th>)}</tr></thead>
              <tbody>
                {PLAN_REGIONS.map(r => (
                  <tr key={r.key}>
                    <td className="sp-strong">{r.label}</td>
                    {PLAN_ITEMS.map(i => {
                      const a = calc.itemActual(r.db, i), p = i.qty[r.key] || 0;
                      return <td key={i.key} className={p && a < p * 0.6 ? 'sp-neg' : ''}>{fmt(a)} <span className="sp-muted">/ {fmt(p)}</span></td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      {/* ── 4. Collection & debt ── */}
      <section className="sp-section">
        <h2>4) التحصيل والمديونية لكل منطقة</h2>
        <div className="sp-table-wrap">
          <table className="sp-table">
            <thead>
              <tr><th>المنطقة</th><th>مبيعات الفترة (فواتير)</th><th>المحصّل</th><th>معدل التحصيل</th><th>المديونية الحالية</th><th>أيام التحصيل (DSO)</th><th>أكثر من 90 يوم</th><th>% متأخر</th><th>مدينون متوقفون عن الشراء</th></tr>
            </thead>
            <tbody>
              {regions.map(r => (
                <tr key={r.key}>
                  <td className="sp-strong">{r.label}</td>
                  <td>{fmtK(r.a.invoiced)}</td><td>{fmtK(r.a.collected)}</td>
                  <td className={r.collectionRate != null && r.collectionRate < 95 ? 'sp-neg' : 'sp-pos'}>{pct(r.collectionRate)}</td>
                  <td>{fmtK(r.a.debt)}</td>
                  <td className={r.dso > 45 ? 'sp-neg' : ''}>{fmt(r.dso)}</td>
                  <td>{fmtK(r.a.over90)}</td>
                  <td className={r.over90Share > 30 ? 'sp-neg' : ''}>{pct(r.over90Share, 0)}</td>
                  <td>{r.a.dormant_customers ? `${fmt(r.a.dormant_customers)} · ${fmtK(r.a.dormant_debt)}` : '—'}</td>
                </tr>
              ))}
              {calc.outside.map(o => (
                <tr key={o.region} className="sp-row--outside">
                  <td>{o.region}</td><td>{fmtK(o.invoiced)}</td><td>{fmtK(o.collected)}</td>
                  <td>{pct(o.invoiced ? (o.collected / o.invoiced) * 100 : null)}</td><td>{fmtK(o.debt)}</td>
                  <td>{fmt(o.invoiced ? o.debt / (o.invoiced / w.calendar_days) : null)}</td><td>{fmtK(o.over90)}</td>
                  <td>{pct(o.debt ? (o.over90 / o.debt) * 100 : null, 0)}</td><td>{o.dormant_customers ? `${fmt(o.dormant_customers)} · ${fmtK(o.dormant_debt)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>الإجمالي</td><td>{fmtK(t.invoiced)}</td><td>{fmtK(t.collected)}</td><td>{pct(t.collectionRate)}</td>
                <td>{fmtK(t.debt)}</td><td>{fmt(t.dso)}</td><td>{fmtK(t.over90)}</td><td>{pct(t.debt ? (t.over90 / t.debt) * 100 : null, 0)}</td>
                <td>{fmt(t.dormantCustomers)} · {fmtK(t.dormantDebt)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="sp-explain">معدل التحصيل = المحصّل في الفترة ÷ قيمة فواتير الفترة (كل الأصناف، بدون direct). DSO = المديونية ÷ متوسط المبيعات اليومية بالريال.</p>

        <div className="sp-two-col">
          <div>
            <h3>أكبر 10 عملاء مديونية</h3>
            <table className="sp-table sp-table--small">
              <thead><tr><th>العميل</th><th>المنطقة</th><th>الدين</th><th>أقدم دين</th><th>آخر فاتورة</th></tr></thead>
              <tbody>{data.top_debtors.map(d => (
                <tr key={d.customer_id}><td>{d.customer_name}</td><td>{d.region || '—'}</td><td>{fmtK(d.debt)}</td><td>{fmt(d.oldest_days)} يوم</td><td>{d.last_invoice}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div>
            <h3>أعلى المناديب في الدين المتأخر (+90 يوم)</h3>
            <table className="sp-table sp-table--small">
              <thead><tr><th>المندوب</th><th>المنطقة</th><th>إجمالي الدين</th><th>+90 يوم</th></tr></thead>
              <tbody>{data.reps_overdue.map(r => (
                <tr key={r.rep}><td>{r.rep}</td><td>{r.region || '—'}</td><td>{fmtK(r.debt)}</td><td className="sp-neg">{fmtK(r.over90)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── 5. Biggest debt problems ── */}
      <section className="sp-section">
        <h2>5) أكبر مشاكل المديونية (مرتبة حسب الحجم)</h2>
        <ol className="sp-problems">
          {findings.debtProblems.map(p => <li key={p.title}><b>{p.title}:</b> {p.text}</li>)}
        </ol>
      </section>

      {/* ── 6. Recommendations ── */}
      <section className="sp-section sp-reco">
        <h2>6) المقترحات للوصول إلى {fmt(PLAN_TARGET)} حبة يومياً</h2>
        <h3>أ. رافعات النمو</h3>
        <ul>
          <li><b>زيادة قاعدة العملاء:</b> الوصول إلى <b>{fmt(t.safe)}</b> عميل فعّال شهرياً (حالياً {fmt(t.active)}) — إضافة {fmt(t.safe - t.planActive)} عميل موزعة حسب جدول (1). أولوية الاستقطاب للمناطق الأكبر فجوة: {findings.lagging.slice(0, 3).map(r => `${r.label} (${fmt(r.gap)} حبة/يوم)`).join('، ')}.</li>
          <li><b>رفع مبيعات العميل:</b> كل 10% تحسين في متوسط مبيعات العميل يقلل العملاء المطلوبين بنحو 9% (جرّب خيار "تحسين مبيعات العميل" أعلى الصفحة). {findings.lowPerCust.length > 0 && <>مناطق مبيعات العميل فيها أقل من متوسط الشركة بأكثر من 20%: {findings.lowPerCust.map(r => `${r.label} (${fmt(r.perCustActual, 1)})`).join('، ')} — تحتاج تشكيلة أوسع وترويج داخل المحل.</>}</li>
          <li><b>اكتمال الطاقة البيعية:</b> تعيين {t.reps - t.activeRepsSheet} مندوب للوصول إلى {t.reps} مندوب مخطط، بأولوية الدمام (1 → 5) والرياض (10 → 15) والقصيم (7 → 12)، مع خط سير لكل مندوب 10–15 زيارة يومياً.</li>
          <li><b>الوكالات (جدة والمدينة):</b> عقد كميات شهري ثابت {fmt(planDailyForRegion('jeddah'))} حبة/يوم لكل وكيل بدفعة مقدمة أو ضمان بنكي، وتسعير وكالة واضح، ومتابعة سحب أسبوعية.</li>
          <li><b>مزيج الأصناف:</b> الخطة تعتمد على أوزان 900–1100 ({fmt(PLAN_ITEMS.filter(i => ['900', '1000', '1100'].includes(i.key)).reduce((s, i) => s + planDailyForItem(i), 0))} حبة = {pct(PLAN_ITEMS.filter(i => ['900', '1000', '1100'].includes(i.key)).reduce((s, i) => s + planDailyForItem(i), 0) / PLAN_TARGET * 100, 0)}) — يجب تأمين إنتاج هذه الأوزان أولاً قبل التوسع.</li>
          <li><b>متابعة يومية:</b> لوحة يومية لكل منطقة (فعلي اليوم مقابل المخطط اليومي) ومراجعة أسبوعية للفجوة مع المشرفين، وحوافز المناديب مربوطة بالكمية والتحصيل معاً.</li>
        </ul>

        <h3>ب. خطة تحسين التحصيل وتقليل المديونية</h3>
        <ul>
          <li><b>هدف:</b> رفع معدل التحصيل من {pct(t.collectionRate)} إلى 100%+ شهرياً (تحصيل المبيعات الجارية + جزء من القديم)، وخفض DSO من {fmt(t.dso)} يوم إلى 30 يوم.</li>
          <li><b>الديون فوق 90 يوم ({fmtK(t.over90)}):</b> حملة تحصيل مركزة لأكبر 10 عملاء ولكل مندوب في جدول المتأخرات، جدولة سداد مكتوبة، ووقف البيع الآجل لأي عميل تجاوز 90 يوم حتى يسدد أو يوقّع جدولة.</li>
          <li><b>المدينون المتوقفون ({fmt(t.dormantCustomers)} عميل · {fmtK(t.dormantDebt)}):</b> مطالبة رسمية خلال أسبوعين، ثم تحويل للتحصيل القانوني، وتسجيل المتعذر كمديونية معدومة لفصله عن الدين القابل للتحصيل.</li>
          <li><b>الكاش أولاً:</b> العملاء الجدد كاش أو آجل بحد صغير لمدة 3 أشهر قبل منح حد ائتماني، والعملاء الحاليون آجل بحد ائتماني وأيام سداد (7–15 يوم للمفرق).</li>
          <li><b>عمولة المندوب على المحصّل وليس المباع:</b> وخصم من العمولة للديون التي تتجاوز 60 يوم على عملائه.</li>
          {findings.worstCollection.length > 0 && <li><b>مناطق أولوية التحصيل:</b> {findings.worstCollection.map(r => `${r.label} (${pct(r.collectionRate)})`).join('، ')}.</li>}
        </ul>

        <h3>ج. تفادي تكرار المشاكل مستقبلاً</h3>
        <ul>
          <li>حد ائتماني لكل عميل في النظام يمنع إصدار فاتورة آجلة عند تجاوزه أو عند وجود دين أقدم من 60 يوم.</li>
          <li>اعتماد المشرف لأي بيع آجل لعميل عليه متأخرات، واعتماد مدير المنطقة فوق حد معين.</li>
          <li>كشف حساب أسبوعي للعميل ومطابقة رصيد ربع سنوية موقعة.</li>
          <li>تقرير أعمار ديون أسبوعي لكل مندوب ومراجعته في اجتماع المنطقة، وتنبيه تلقائي عند وصول فاتورة لعمر 45 يوم.</li>
          <li>للهايبر والوكالات: عقود بشروط سداد محددة وغرامة تأخير، ومتابعة مطالبات شهرية من الحسابات.</li>
        </ul>
      </section>
    </div>
  );
}
