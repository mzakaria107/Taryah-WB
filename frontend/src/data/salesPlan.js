/* Sales plan "60,000 units/day" — transcribed from the management plan sheet.
   Every row and column foots to the sheet's own totals (60,000; 4,800 / 4,800 /
   5,050 / 4,350 / 5,150 / 4,450 / 9,200 / 9,800 / 12,400).
   `db` = regions.name_ar (English identifier also used by sales_activity.branch_name). */

export const PLAN_TARGET = 60000;

export const PLAN_REGIONS = [
  { key: 'qassim',  label: 'القصيم',          db: 'Al-Qassem',  type: 'retail', staff: { manager: 1, supervisors: 2, activeReps: 7,  plannedReps: 12 } },
  { key: 'riyadh',  label: 'الرياض',          db: 'Riyadh',     type: 'retail', staff: { manager: 1, supervisors: 3, activeReps: 10, plannedReps: 15 } },
  { key: 'hail',    label: 'حائل',            db: 'Hael',       type: 'retail', staff: { manager: 0, supervisors: 2, activeReps: 4,  plannedReps: 6 } },
  { key: 'dawadmi', label: 'الدوادمي',        db: 'Al Duwadmi', type: 'retail', staff: { manager: 0, supervisors: 1, activeReps: 3,  plannedReps: 4 } },
  { key: 'shaqra',  label: 'شقراء',           db: 'Shaqraa',    type: 'retail', staff: { manager: 0, supervisors: 1, activeReps: 5,  plannedReps: 5 } },
  { key: 'arar',    label: 'عرعر',            db: 'Arar',       type: 'retail', staff: { manager: 0, supervisors: 1, activeReps: 2,  plannedReps: 3 } },
  { key: 'dammam',  label: 'الدمام',          db: 'Dammam',     type: 'retail', staff: { manager: 0, supervisors: 1, activeReps: 1,  plannedReps: 5 } },
  { key: 'madinah', label: 'المدينة (وكالة)', db: 'Madinah',    type: 'agency', staff: { agency: 1 } },
  { key: 'jeddah',  label: 'جدة (وكالة)',     db: 'Jeddah',     type: 'agency', staff: { agency: 1 } },
];

// Daily plan per item × region. grams = unit weight read from the item name; null = fillet line.
export const PLAN_ITEMS = [
  { key: '700',    label: 'وزن 700',      grams: 700,  price: 10.0, qty: { qassim: 100,  riyadh: 500,  hail: 0,    dawadmi: 200,  shaqra: 200,  arar: 0,   dammam: 0,    madinah: 200,  jeddah: 200 } },
  { key: '800',    label: 'وزن 800',      grams: 800,  price: 12.5, qty: { qassim: 500,  riyadh: 1000, hail: 1000, dawadmi: 1000, shaqra: 1500, arar: 500, dammam: 500,  madinah: 500,  jeddah: 500 } },
  { key: '900',    label: 'وزن 900',      grams: 900,  price: 13.5, qty: { qassim: 3000, riyadh: 2000, hail: 2000, dawadmi: 1200, shaqra: 1500, arar: 1000, dammam: 1000, madinah: 1000, jeddah: 1000 } },
  { key: '1000',   label: 'وزن 1000',     grams: 1000, price: 14.0, qty: { qassim: 3000, riyadh: 1500, hail: 1500, dawadmi: 800,  shaqra: 800,  arar: 800, dammam: 1000, madinah: 1000, jeddah: 1000 } },
  { key: '1100',   label: 'وزن 1100',     grams: 1100, price: 14.3, qty: { qassim: 2700, riyadh: 1000, hail: 1500, dawadmi: 500,  shaqra: 500,  arar: 500, dammam: 500,  madinah: 500,  jeddah: 500 } },
  { key: '1200',   label: 'وزن 1200',     grams: 1200, price: 15.0, qty: { qassim: 1000, riyadh: 1500, hail: 1000, dawadmi: 400,  shaqra: 300,  arar: 500, dammam: 1000, madinah: 500,  jeddah: 500 } },
  { key: '1300',   label: 'وزن 1300',     grams: 1300, price: 15.5, qty: { qassim: 1000, riyadh: 1000, hail: 1000, dawadmi: 200,  shaqra: 200,  arar: 500, dammam: 500,  madinah: 500,  jeddah: 500 } },
  { key: '1400',   label: 'وزن 1400',     grams: 1400, price: 16.0, qty: { qassim: 1000, riyadh: 1000, hail: 1000, dawadmi: 100,  shaqra: 100,  arar: 500, dammam: 500,  madinah: 500,  jeddah: 500 } },
  { key: 'fillet', label: 'فيليه 450ج',   grams: null, price: 13.0, qty: { qassim: 100,  riyadh: 300,  hail: 200,  dawadmi: 50,   shaqra: 50,   arar: 50,  dammam: 50,   madinah: 100,  jeddah: 100 } },
];

export const planDailyForRegion = key => PLAN_ITEMS.reduce((s, it) => s + (it.qty[key] || 0), 0);
export const planDailyForItem = it => Object.values(it.qty).reduce((s, v) => s + v, 0);

/* Customer target: 2,500 active customers for the retail (مفرق) regions only — agencies are
   excluded. Split across regions in proportion to each region's planned daily volume
   (largest-remainder rounding, so the split always sums to exactly 2,500). */
export const PLAN_CUSTOMERS = 2500;

export function planCustomersByRegion() {
  const retail = PLAN_REGIONS.filter(r => r.type === 'retail');
  const vol = retail.map(r => planDailyForRegion(r.key));
  const totalVol = vol.reduce((s, v) => s + v, 0);
  const raw = vol.map(v => (v / totalVol) * PLAN_CUSTOMERS);
  const out = raw.map(Math.floor);
  let left = PLAN_CUSTOMERS - out.reduce((s, v) => s + v, 0);
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => { if (left > 0) { out[i] += 1; left -= 1; } });
  return Object.fromEntries(retail.map((r, i) => [r.key, out[i]]));
}
