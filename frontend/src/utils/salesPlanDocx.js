/* Word (.docx) export of the "خطة المبيعات" page — built in the browser from the page's own
   computed data (live actuals), so the document always matches what the page shows.
   Arabic RTL, A4 landscape (the ramp table is 12 columns wide). Loaded lazily from the page. */
import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, LevelFormat, Packer,
  PageNumber, PageOrientation, Paragraph, ShadingType, Table, TableCell, TableRow,
  TextRun, WidthType,
} from 'docx';
import { PLAN_TARGET, PLAN_CUSTOMERS, PLAN_ITEMS, RAMP_STEPS, planDailyForRegion, planDailyForItem } from '../data/salesPlan';

const MONTHS_AR = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const FONT = 'Arial';
const BRAND = '14532D';      // dark green
const BRAND_LIGHT = 'E8F3EC';
const ZEBRA = 'F7F9F8';
const RED = 'B91C1C';
const GREEN = '15803D';
const MUTED = '6B7280';
const PAGE_W = 16838, PAGE_H = 11906, MARGIN = 900;
const CONTENT_W = PAGE_W - MARGIN * 2;   // landscape content width (DXA)

const fmt = (n, d = 0) => (n == null || !isFinite(n)) ? '—'
  : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtK = n => (n == null || !isFinite(n)) ? '—'
  : Math.abs(n) >= 1e6 ? `${fmt(n / 1e6, 2)}M` : Math.abs(n) >= 1e3 ? `${fmt(n / 1e3, 0)}K` : fmt(n);
const pct = (n, d = 0) => (n == null || !isFinite(n)) ? '—' : `${fmt(n, d)}%`;
const signed = n => (n == null || !isFinite(n)) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;

/* ── Building blocks ─────────────────────────────────────────── */
const run = (text, o = {}) => new TextRun({
  text: String(text), rightToLeft: true, font: { ascii: FONT, cs: FONT, hAnsi: FONT },
  size: o.size || 20, sizeComplexScript: o.size || 20,
  bold: o.bold, boldComplexScript: o.bold, color: o.color, italics: o.italics,
});
const para = (children, o = {}) => new Paragraph({
  bidirectional: true, alignment: o.align || AlignmentType.RIGHT,
  spacing: { before: o.before ?? 40, after: o.after ?? 80, line: o.line || 300 },
  children: (Array.isArray(children) ? children : [children]).map(c => typeof c === 'string' ? run(c, o) : c),
  ...(o.heading ? { heading: o.heading } : {}),
  ...(o.bullet ? { numbering: { reference: 'bullets', level: 0 } } : {}),
  ...(o.border ? { border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: BRAND, space: 4 } } } : {}),
  ...(o.pageBreakBefore ? { pageBreakBefore: true } : {}),
});
const h1 = (text, o = {}) => para([run(text, { size: 30, bold: true, color: BRAND })], { heading: HeadingLevel.HEADING_1, before: 120, after: 120, border: true, ...o });
const h2 = text => para([run(text, { size: 24, bold: true, color: BRAND })], { heading: HeadingLevel.HEADING_2, before: 200, after: 80 });
const bullet = (parts, o = {}) => para(
  (Array.isArray(parts) ? parts : [parts]).map(p => typeof p === 'string' ? run(p, o) : run(p.t, { ...o, ...p })),
  { bullet: true, after: 40 });
const note = text => para([run(text, { size: 16, color: MUTED, italics: true })], { after: 60 });

/* Table: widths are relative weights; converted to DXA that sum to CONTENT_W (or `width`). */
function table(headers, rows, weights, o = {}) {
  const total = o.width || CONTENT_W;
  const sumW = weights.reduce((s, w) => s + w, 0);
  const widths = weights.map(w => Math.floor((w / sumW) * total));
  widths[widths.length - 1] += total - widths.reduce((s, w) => s + w, 0);
  const cell = (content, i, opt = {}) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA },
    shading: opt.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: opt.fill } : undefined,
    margins: { top: 50, bottom: 50, left: 70, right: 70 },
    columnSpan: opt.span,
    children: [para([run(content == null ? '—' : content, {
      size: opt.size || 17, bold: opt.bold, color: opt.color,
    })], { align: i === 0 && !opt.center ? AlignmentType.RIGHT : AlignmentType.CENTER, before: 0, after: 0, line: 260 })],
  });
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => cell(h, i, { fill: BRAND, color: 'FFFFFF', bold: true, size: 16, center: true })),
  });
  const body = rows.map((r, ri) => new TableRow({
    children: r.cells.map((c, i) => {
      const spec = (c && typeof c === 'object') ? c : { v: c };
      return cell(spec.v, i, {
        fill: r.total ? BRAND_LIGHT : r.fill || (ri % 2 ? ZEBRA : undefined),
        bold: r.total || spec.bold, color: spec.color,
      });
    }),
  }));
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    visuallyRightToLeft: true,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' }, right: { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'E5E7EB' }, insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'E5E7EB' },
    },
    rows: [headerRow, ...body],
  });
}
const spacer = () => para([run(' ')], { after: 60 });
const neg = n => ({ v: signed(-n), color: n > 0 ? RED : GREEN, bold: true });   // gap shown as shortfall

/* KPI strip: one row of label/value boxes */
function kpis(items) {
  const w = Math.floor(CONTENT_W / items.length);
  return new Table({
    width: { size: w * items.length, type: WidthType.DXA },
    columnWidths: items.map(() => w),
    visuallyRightToLeft: true,
    borders: {
      top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideVertical: { style: BorderStyle.SINGLE, size: 24, color: 'FFFFFF' },
    },
    rows: [new TableRow({
      children: items.map(k => new TableCell({
        width: { size: w, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: k.fill || BRAND_LIGHT },
        margins: { top: 120, bottom: 120, left: 120, right: 120 },
        children: [
          para([run(k.label, { size: 16, color: k.dark ? 'E5E7EB' : MUTED, bold: true })], { align: AlignmentType.CENTER, before: 0, after: 40 }),
          para([run(k.value, { size: 34, bold: true, color: k.dark ? 'FFFFFF' : (k.color || BRAND) })], { align: AlignmentType.CENTER, before: 0, after: 20 }),
          para([run(k.sub || ' ', { size: 15, color: k.dark ? 'E5E7EB' : MUTED })], { align: AlignmentType.CENTER, before: 0, after: 0 }),
        ],
      })),
    })],
  });
}

/* ── Document ─────────────────────────────────────────────────── */
export async function exportSalesPlanDocx({ data, calc, ramp, findings, periodLabel }) {
  const t = calc.totals;
  const today = new Date().toLocaleDateString('en-GB');
  const rampLabel = data.ramp_months.map(m => `${MONTHS_AR[m.m - 1]} ${m.y}`);
  const recentLabel = data.recent.months.map(m => MONTHS_AR[m.m - 1]).join(' – ');
  const retailRegions = calc.regions.filter(r => r.type === 'retail');
  const rt = ramp.totals;
  const focusRows = ramp.rows.filter(r => r.focus);
  const c = [];

  /* Cover */
  c.push(para([run(' ')], { before: 1600 }));
  c.push(para([run('دواجن طرية', { size: 28, bold: true, color: MUTED })], { align: AlignmentType.CENTER, after: 360, line: 360 }));
  c.push(para([run(`خطة المبيعات — الوصول إلى ${fmt(PLAN_TARGET)} حبة يومياً`, { size: 52, bold: true, color: BRAND })], { align: AlignmentType.CENTER, before: 120, after: 240, line: 480, border: true }));
  c.push(para([run(`الدجاج المبرد · الخطة التصاعدية ${rampLabel[0]} – ${rampLabel[2]}`, { size: 28, color: BRAND })], { align: AlignmentType.CENTER, after: 600 }));
  c.push(para([run(`الفعلي محسوب من بيانات النظام: ${periodLabel} · الوضع الحالي = متوسط ${recentLabel}`, { size: 20, color: MUTED })], { align: AlignmentType.CENTER }));
  c.push(para([run(`تاريخ الإعداد: ${today}`, { size: 20, color: MUTED })], { align: AlignmentType.CENTER }));

  /* 1. Executive summary */
  c.push(h1('1. الملخص التنفيذي', { pageBreakBefore: true }));
  c.push(kpis([
    { label: 'الوضع الحالي (آخر 3 أشهر)', value: fmt(rt.cur), sub: 'حبة / يوم عمل', fill: BRAND, dark: true },
    { label: 'الهدف اليومي', value: fmt(PLAN_TARGET), sub: `بنهاية ${rampLabel[2]}` },
    { label: 'الفجوة', value: fmt(PLAN_TARGET - rt.cur), sub: `نمو مطلوب ${pct(rt.cur ? (PLAN_TARGET / rt.cur - 1) * 100 : null)}`, color: RED },
    { label: 'العملاء الفعّالين (مفرق)', value: `${fmt(rt.curCust)} ← ${fmt(PLAN_CUSTOMERS)}`, sub: `إضافة ${fmt(PLAN_CUSTOMERS - rt.curCust)} عميل` },
    { label: 'المناديب', value: `${t.activeRepsSheet} ← ${t.reps}`, sub: `تعيين ${t.reps - t.activeRepsSheet} مندوب` },
  ]));
  c.push(spacer());
  c.push(h2('أهم النقاط'));
  c.push(bullet([{ t: 'الوضع الحالي: ', bold: true }, `${fmt(rt.cur)} حبة يومياً (متوسط ${recentLabel} على أيام العمل)، ومتوسط ${calc.days} يوم عمل في الفترة كاملة ${fmt(t.actualDaily)} حبة يومياً.`]));
  c.push(bullet([{ t: 'الخطة التصاعدية: ', bold: true }, rampLabel.map((l, i) => `${l} ${fmt(rt.steps[i].daily)}`).join(' ← '), ` حبة يومياً (إغلاق ${RAMP_STEPS.map(k => pct(k * 100)).join(' / ')} من الفجوة).`]));
  c.push(bullet([{ t: 'العملاء: ', bold: true }, `الوصول إلى ${fmt(PLAN_CUSTOMERS)} عميل فعّال شهرياً في المناطق النشطة بدون الوكالات، التركيز على ${focusRows.map(r => `${r.label} (${fmt(r.curCust)} ← ${fmt(r.finalCust)})`).join('، ')}.`]));
  c.push(bullet([{ t: 'فرص سريعة: ', bold: true }, `${fmt(rt.lost)} عميل مفقود و${fmt(rt.declining)} عميل متراجع يمثلون ≈ ${fmt(rt.recoverable)} حبة يومياً قابلة للاسترجاع (${pct(rt.recoverable / Math.max(1, PLAN_TARGET - rt.cur) * 100)} من الفجوة).`]));
  c.push(bullet([{ t: 'التحصيل: ', bold: true }, `معدل التحصيل في الفترة ${pct(t.collectionRate, 1)}، المديونية ${fmtK(t.debt)} منها ${fmtK(t.over90)} (${pct(t.debt ? t.over90 / t.debt * 100 : null)}) أكثر من 90 يوم، وأيام التحصيل ${fmt(t.dso)} يوم.`]));
  c.push(bullet([{ t: 'الإيراد: ', bold: true }, `إيراد يومي مخطط ${fmtK(calc.planRevenue)} ر.س مقابل ${fmtK(calc.actualRevenueDaily)} ر.س فعلي.`]));

  /* 2. Plan vs actual by region */
  c.push(h1('2. الخطة مقابل الفعلي لكل منطقة', { pageBreakBefore: true }));
  c.push(table(
    ['المنطقة', 'النوع', 'الفعلي / يوم', 'المخطط / يوم', 'الفجوة', 'التحقيق', 'عملاء فعّالين', 'حبة/عميل/يوم', 'العملاء المستهدفين', 'إضافي', 'حبة/عميل مطلوب'],
    [
      ...calc.regions.map(r => ({ fill: r.type === 'agency' ? 'EFF6FF' : undefined, cells: [
        { v: r.label + (r.focus ? ' ★' : ''), bold: true }, r.type === 'agency' ? 'وكالة' : 'مفرق',
        fmt(r.actualDaily), fmt(r.planDaily), neg(r.gap), pct(r.achievement),
        fmt(r.active), fmt(r.perCustActual, 1),
        r.type === 'agency' ? 'وكالة' : fmt(r.target), r.type === 'agency' ? '—' : signed(r.additional),
        r.type === 'agency' ? '—' : fmt(r.perCustTarget, 1),
      ] })),
      { total: true, cells: ['الإجمالي', '', fmt(t.actualDaily), fmt(PLAN_TARGET), signed(-(t.gap)), pct(t.achievement),
        fmt(t.active), fmt(calc.companyPerCust, 1), fmt(PLAN_CUSTOMERS), signed(PLAN_CUSTOMERS - t.retailActive), fmt(t.retailPerCustTarget, 1)] },
    ],
    [14, 6, 9, 9, 9, 7, 9, 9, 10, 7, 10],
  ));
  c.push(note(`المتوسط اليومي = كمية الدجاج المبرد (شامل المستودع المركزي) ÷ ${calc.days} يوم عمل (بدون الجمعة والإجازات) — نفس طريقة صفحة تقييم المناطق. ★ = منطقة تركيز التوسع.`));

  c.push(h2('الطاقة البيعية'));
  c.push(table(
    ['المنطقة', 'مدير فرع', 'مشرف', 'مناديب نشطة', 'المناديب المخطط', 'حبة/مندوب/يوم مطلوب', 'حبة/مندوب/يوم فعلي', 'عملاء/مندوب مطلوب'],
    [
      ...retailRegions.map(r => ({ cells: [
        { v: r.label, bold: true }, r.staff.manager || '—', r.staff.supervisors, r.staff.activeReps, { v: r.staff.plannedReps, bold: true },
        fmt(r.dailyPerRep), fmt(r.actualPerRep), fmt(r.custPerRep),
      ] })),
      { total: true, cells: ['الإجمالي', '2', '11', t.activeRepsSheet, t.reps, fmt((PLAN_TARGET - planDailyForRegion('jeddah') - planDailyForRegion('madinah')) / t.reps), '', ''] },
    ],
    [16, 8, 8, 10, 11, 13, 13, 13],
  ));
  c.push(note('جدة والمدينة وكالات للغير — الهدف يُدار بعقد كميات شهري مع الوكيل.'));

  /* 3. Ramp */
  c.push(h1('3. الخطة التصاعدية — 3 أشهر', { pageBreakBefore: true }));
  c.push(para(`الوضع الحالي = متوسط ${recentLabel} على أيام العمل. يُغلق ${RAMP_STEPS.map(k => pct(k * 100)).join(' ثم ')} من الفجوة بنهاية كل شهر — تصاعد متدرج لأن المناديب والعملاء الجدد يحتاجون أسابيع للوصول لكامل طاقتهم.`, { size: 19 }));
  c.push(table(
    ['المنطقة', 'الحالي / يوم', ...rampLabel.flatMap(l => [`${l} / يوم`, 'كمية الشهر']), 'المخطط النهائي'],
    [
      ...ramp.rows.map(r => ({ fill: r.type === 'agency' ? 'EFF6FF' : undefined, cells: [
        { v: r.label + (r.focus ? ' ★' : ''), bold: true }, fmt(r.cur),
        ...r.steps.flatMap(st => [{ v: fmt(st.daily), bold: true }, fmtK(st.monthly)]),
        fmt(r.plan),
      ] })),
      { total: true, cells: ['الإجمالي', fmt(rt.cur), ...rt.steps.flatMap(st => [fmt(st.daily), fmtK(st.monthly)]), fmt(rt.plan)] },
    ],
    [14, 9, 9, 8, 9, 8, 9, 8, 9],
  ));
  c.push(spacer());
  c.push(h2('العملاء والمناديب شهرياً'));
  c.push(table(
    ['المنطقة', 'العملاء الحاليين', ...rampLabel.map(l => `عملاء ${l}`), 'حبة/عميل/يوم (الشهر 3)', 'المناديب الحاليين', ...rampLabel.map(l => `مناديب ${l}`)],
    [
      ...ramp.rows.filter(r => r.type === 'retail').map(r => ({ cells: [
        { v: r.label + (r.focus ? ' ★' : ''), bold: true }, fmt(r.curCust), ...r.steps.map(st => fmt(st.cust)),
        fmt(r.steps[2].perCust, 1), r.curReps, ...r.steps.map(st => fmt(st.reps)),
      ] })),
      { total: true, cells: ['الإجمالي', fmt(rt.curCust), ...rt.steps.map(st => fmt(st.cust)), '', t.activeRepsSheet, ...rt.steps.map(st => fmt(st.reps))] },
    ],
    [14, 9, 9, 9, 9, 11, 9, 8, 8, 8],
  ));
  c.push(note('المنطقة التي تبيع حالياً أكثر من خطتها تبقى على مستواها الحالي. العملاء: مفرق بدون الوكالات.'));

  /* 4. Expansion */
  c.push(h1('4. المناطق والعملاء القابلين للتوسع', { pageBreakBefore: true }));
  c.push(kpis([
    { label: 'عملاء مفقودين', value: fmt(rt.lost), sub: `كانوا يشترون ≈ ${fmt(rt.lostDaily)} حبة/يوم` },
    { label: 'عملاء متراجعين', value: fmt(rt.declining), sub: `فاقد ≈ ${fmt(rt.decliningLoss)} حبة/يوم` },
    { label: 'حجم قابل للاسترجاع', value: fmt(rt.recoverable), sub: `${pct(rt.recoverable / Math.max(1, PLAN_TARGET - rt.cur) * 100)} من الفجوة` },
    { label: 'عملاء جدد شهرياً', value: fmt(rt.newPerMonthNow), sub: `المطلوب ≈ ${fmt(rt.newNeeded / 3)} شهرياً` },
  ]));
  c.push(spacer());
  c.push(table(
    ['#', 'المنطقة', 'الفجوة / يوم', 'مفقودين', 'متراجعين', 'عملاء جدد/شهر (حالي ← مطلوب)', 'الإجراءات المقترحة'],
    ramp.priority.map((r, i) => ({ cells: [
      String(i + 1), { v: r.label + (r.focus ? ' ★' : ''), bold: true }, { v: fmt(r.gap), color: RED, bold: true },
      `${fmt(r.pool.lost)} (${fmt(r.pool.lost_daily)}/يوم)`, `${fmt(r.pool.declining)} (${fmt(r.pool.declining_loss)}/يوم)`,
      r.type === 'retail' ? `${fmt(r.newPerMonthNow, 1)} ← ${fmt(r.newPerMonthNeeded)}` : '—',
      r.actions.join(' · '),
    ] })),
    [4, 11, 8, 10, 10, 12, 45],
  ));
  c.push(note('مفقود = اشترى قبل آخر 3 أشهر ولا يوجد له صافي شراء فيها. متراجع = متوسطه اليومي في آخر 3 أشهر أقل من 70% من متوسطه قبلها. الأولوية = الفجوة (×1.5 لمناطق التركيز) + الحجم القابل للاسترجاع.'));

  c.push(h2('أكبر 10 عملاء مفقودين — أولوية الاسترجاع'));
  c.push(table(['العميل', 'المنطقة', 'المندوب', 'كان يشتري / يوم', 'آخر شراء'],
    data.lost_customers.slice(0, 10).map(x => ({ cells: [x.customer_name, x.region, x.rep || '—', fmt(x.prior_daily, 1),
      x.last_ym ? `${MONTHS_AR[(x.last_ym % 100) - 1]} ${Math.floor(x.last_ym / 100)}` : '—'] })),
    [34, 14, 18, 14, 14]));
  c.push(h2('أكبر 10 عملاء متراجعين — أولوية الزيارة'));
  c.push(table(['العميل', 'المنطقة', 'المندوب', 'قبل / يوم', 'الآن / يوم'],
    data.declining_customers.slice(0, 10).map(x => ({ cells: [x.customer_name, x.region, x.rep || '—', fmt(x.prior_daily, 1),
      { v: fmt(x.recent_daily, 1), color: RED }] })),
    [34, 14, 18, 14, 14]));

  /* 5. Item mix */
  c.push(h1('5. مزيج الأصناف', { pageBreakBefore: true }));
  c.push(table(
    ['الصنف', 'سعر الخطة', 'متوسط سعر البيع الفعلي', 'الفعلي / يوم', 'المخطط / يوم', 'الفجوة', 'إيراد يومي مخطط'],
    [
      ...calc.items.map(i => ({ cells: [{ v: i.label, bold: true }, fmt(i.price, 2), fmt(i.asp, 2), fmt(i.actual), fmt(i.plan), neg(i.gap), fmt(i.planRevenue)] })),
      { total: true, cells: ['الإجمالي', '', fmt(t.asp, 2), fmt(calc.items.reduce((s, i) => s + i.actual, 0)), fmt(PLAN_TARGET), '', fmt(calc.planRevenue)] },
    ],
    [16, 12, 16, 13, 13, 13, 17],
  ));

  /* 6. Collection & debt */
  c.push(h1('6. التحصيل والمديونية'));
  c.push(table(
    ['المنطقة', 'مبيعات الفترة', 'المحصّل', 'معدل التحصيل', 'المديونية', 'أيام التحصيل', '+90 يوم', '% متأخر', 'مدينون متوقفون'],
    [
      ...calc.regions.map(r => ({ cells: [
        { v: r.label, bold: true }, fmtK(r.a.invoiced), fmtK(r.a.collected),
        { v: pct(r.collectionRate, 1), color: r.collectionRate != null && r.collectionRate < 95 ? RED : GREEN, bold: true },
        fmtK(r.a.debt), fmt(r.dso), fmtK(r.a.over90), pct(r.over90Share),
        r.a.dormant_customers ? `${fmt(r.a.dormant_customers)} · ${fmtK(r.a.dormant_debt)}` : '—',
      ] })),
      { total: true, cells: ['الإجمالي', fmtK(t.invoiced), fmtK(t.collected), pct(t.collectionRate, 1), fmtK(t.debt), fmt(t.dso),
        fmtK(t.over90), pct(t.debt ? t.over90 / t.debt * 100 : null), `${fmt(t.dormantCustomers)} · ${fmtK(t.dormantDebt)}`] },
    ],
    [14, 11, 11, 10, 11, 9, 10, 8, 14],
  ));
  c.push(note('معدل التحصيل = المحصّل ÷ قيمة فواتير الفترة (كل الأصناف بدون المستودع المركزي). أيام التحصيل = المديونية ÷ متوسط المبيعات اليومية بالريال.'));
  c.push(h2('أكبر مشاكل المديونية (مرتبة حسب الحجم)'));
  findings.debtProblems.forEach(p => c.push(bullet([{ t: `${p.title}: `, bold: true }, p.text])));

  /* 7. Recommendations */
  c.push(h1('7. المقترحات وخطة العمل', { pageBreakBefore: true }));
  c.push(h2('أ. الوصول إلى الهدف'));
  c.push(bullet([{ t: 'ابدأ بالأسرع: ', bold: true }, `استرجاع ${fmt(rt.lost)} عميل مفقود ومعالجة ${fmt(rt.declining)} عميل متراجع خلال الشهر الأول — ≈ ${fmt(rt.recoverable)} حبة يومياً بدون تكلفة استقطاب.`]));
  c.push(bullet([{ t: 'التوسع بعملاء جدد: ', bold: true }, `التركيز على ${focusRows.map(r => `${r.label} +${fmt(Math.max(0, r.finalCust - r.curCust))}`).join('، ')} عميل، وتوسع أقل في باقي المناطق — إجمالي ${fmt(PLAN_CUSTOMERS)} عميل فعّال.`]));
  c.push(bullet([{ t: 'المناديب: ', bold: true }, `تعيين ${t.reps - t.activeRepsSheet} مندوب في الشهر الأول (الأولوية: الدمام 1→5، الرياض 10→15، القصيم 7→12)، بخط سير 10–15 زيارة يومياً.`]));
  c.push(bullet([{ t: 'مبيعات العميل: ', bold: true }, `المطلوب ${fmt(t.retailPerCustTarget, 1)} حبة/عميل/يوم مقابل ${fmt(t.retailPerCustActual, 1)} حالياً — تشكيلة أوزان أوسع (900–1100 = ${pct(PLAN_ITEMS.filter(i => ['900', '1000', '1100'].includes(i.key)).reduce((s, i) => s + planDailyForItem(i), 0) / PLAN_TARGET * 100)} من الخطة)، عرض داخل المحل، وزيارتين أسبوعياً للعملاء الكبار.`]));
  c.push(bullet([{ t: 'الوكالات: ', bold: true }, `عقد كميات شهري لجدة والمدينة (${fmt(planDailyForRegion('jeddah'))} حبة/يوم لكل وكيل) بدفعة مقدمة أو ضمان بنكي ومتابعة سحب أسبوعية.`]));
  c.push(bullet([{ t: 'المتابعة: ', bold: true }, 'مراجعة أسبوعية للمستهدف اليومي لكل منطقة مقابل الفعلي، وأي منطقة تتأخر أسبوعين يُعاد توزيع خطتها؛ حوافز المناديب مرتبطة بالكمية والتحصيل معاً.']));
  c.push(h2('ب. تحسين التحصيل وتقليل المديونية'));
  c.push(bullet([{ t: 'الهدف: ', bold: true }, `رفع معدل التحصيل من ${pct(t.collectionRate, 1)} إلى 100%+ شهرياً، وخفض أيام التحصيل من ${fmt(t.dso)} إلى 30 يوم.`]));
  c.push(bullet([{ t: 'الديون فوق 90 يوم: ', bold: true }, `(${fmtK(t.over90)}) حملة مركزة لأكبر العملاء والمناديب، جدولة سداد مكتوبة، ووقف البيع الآجل لمن تجاوز 90 يوم.`]));
  c.push(bullet([{ t: 'المدينون المتوقفون: ', bold: true }, `(${fmt(t.dormantCustomers)} عميل · ${fmtK(t.dormantDebt)}) مطالبة رسمية خلال أسبوعين ثم تحويل للتحصيل القانوني، وتسجيل المتعذر كمديونية معدومة.`]));
  c.push(bullet([{ t: 'السياسة: ', bold: true }, 'العملاء الجدد كاش أو آجل بحد صغير لأول 3 أشهر؛ عمولة المندوب على المحصّل وليس المباع.']));
  c.push(h2('ج. تفادي تكرار المشاكل'));
  ['حد ائتماني لكل عميل في النظام يمنع الفاتورة الآجلة عند تجاوزه أو عند وجود دين أقدم من 60 يوم.',
   'اعتماد المشرف لأي بيع آجل لعميل عليه متأخرات، واعتماد مدير المنطقة فوق حد معين.',
   'كشف حساب أسبوعي للعميل ومطابقة رصيد ربع سنوية موقعة.',
   'تقرير أعمار ديون أسبوعي لكل مندوب، وتنبيه تلقائي عند وصول فاتورة لعمر 45 يوم.',
   'عقود الهايبر والوكالات بشروط سداد محددة وغرامة تأخير، ومتابعة مطالبات شهرية.',
  ].forEach(x => c.push(bullet(x)));

  /* 8. Methodology */
  c.push(h1('8. منهجية الحساب'));
  [
    `الصنف: دجاج مبرد طرية، شامل مبيعات المستودع المركزي (direct). الفترة: ${periodLabel}.`,
    'المتوسط اليومي = الكمية ÷ أيام العمل (بدون الجمعة وإجازة العيد) — مطابق لصفحة تقييم المناطق.',
    'العميل الفعّال = صافي كمية موجبة في الشهر؛ المتوسط الشهري على أشهر الفترة.',
    `هدف العملاء ${fmt(PLAN_CUSTOMERS)} للمفرق فقط: كل منطقة تحتفظ بعملائها وتأخذ نصيباً من الزيادة حسب كميتها المخططة، بوزن 3× للرياض والقصيم والدمام.`,
    'المديونية = صافي الأرصدة بدون المستودع المركزي؛ التقادم حسب تاريخ الفاتورة.',
  ].forEach(x => c.push(bullet(x, { size: 18 })));

  const doc = new Document({
    creator: 'Taryah Dashboard',
    title: 'خطة المبيعات',
    styles: {
      default: { document: { run: { font: FONT, size: 20 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 30, bold: true, color: BRAND, font: FONT }, paragraph: { spacing: { before: 120, after: 120 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 24, bold: true, color: BRAND, font: FONT }, paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 1 } },
      ],
    },
    numbering: { config: [{ reference: 'bullets', levels: [{
      level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.RIGHT,
      style: { paragraph: { indent: { right: 360, hanging: 260 } } },
    }] }] },
    sections: [{
      properties: { page: {
        size: { width: PAGE_H, height: PAGE_W, orientation: PageOrientation.LANDSCAPE },
        margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      }, titlePage: true },
      headers: { default: new Header({ children: [para([run(`دواجن طرية — خطة المبيعات ${fmt(PLAN_TARGET)} حبة يومياً`, { size: 16, color: MUTED })], { after: 0 })] }) },
      footers: { default: new Footer({ children: [para([
        run('صفحة ', { size: 16, color: MUTED }),
        new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED, font: FONT }),
        run(' من ', { size: 16, color: MUTED }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: MUTED, font: FONT }),
      ], { align: AlignmentType.CENTER, after: 0 })] }) },
      children: c,
    }],
  });

  const blob = await Packer.toBlob(doc);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Sales-Plan_${new Date().toLocaleDateString('en-CA')}.docx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

