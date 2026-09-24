/**
 * Shared commission-calculation formula — used by both the performance
 * dashboard ("الأداء المرجح" column) and the commissions tab/report, so
 * the two always agree on the same number.
 *
 * Five weighted items (weights admin-configurable in commission_weights,
 * should sum to 100 but not enforced):
 *   qty       — % of qty target achieved, earns that fraction of its weight,
 *               capped at 110% (i.e. 150% achievement still only earns
 *               110% of the weight — same cap the debt item uses).
 *               Requires achieving at least MIN_QTY_ACH_PCT (80%) of the
 *               target to earn ANY of this item's weight — below that
 *               threshold the entire qty item weight is forfeited (a
 *               distinct, milder rule than the zero-sales kill-switch
 *               below, which zeroes the WHOLE commission only at 0%).
 *   customers — % of customer target achieved, same 110% cap
 *   debt      — debt_pct = balance/credit_limit×100. Full weight if ≤110%,
 *               ZERO weight (the entire debt item, not a gradual scale)
 *               the moment debt exceeds 110% — the excess % above 110 is
 *               reported as the reason via debtExcessInfo().
 *   damage    — binary: full weight if توالف% ≤ DAMAGE_TARGET_PCT, else 0.
 *   fridges   — average of (coverage%, fridge-target%), each uncapped,
 *               each worth half the item's weight. If the rep's route
 *               has no fridges registered at all, earns the full weight
 *               (nothing to be penalized for).
 *
 * Total commission % is NOT capped here (can exceed 100 if items over-
 * achieve) — the 110%-of-registered-limit cap is applied separately,
 * only when converting the percentage into an actual money amount.
 */

const DAMAGE_TARGET_PCT = 0.5; // max allowed توالف as % of gross qty sold
const MIN_QTY_ACH_PCT = 80; // below this % of qty target, the qty item's whole weight is forfeited
const ITEM_KEYS = ['qty', 'customers', 'debt', 'damage', 'fridges'];
const ITEM_LABELS_AR = {
  qty:       'تحقيق هدف المبيعات',
  customers: 'تحقيق هدف العملاء',
  debt:      'نسبة المديونية',
  damage:    'تحقيق هدف التوالف',
  fridges:   'تغطية وهدف الثلاجات',
};

function itemEarnedFraction(key, m) {
  switch (key) {
    case 'qty': {
      if (m.qtyAch == null) return 0;
      if (m.qtyAch < MIN_QTY_ACH_PCT) return 0; // below 80% of target → entire item weight forfeited
      return Math.min(m.qtyAch / 100, 1.10);
    }
    // Capped at 100% — same rule as the fridges item: over-achieving the
    // customer target never earns more than the item's registered weight.
    case 'customers': return m.custAch != null ? Math.min(m.custAch / 100, 1) : 0;
    case 'debt': {
      if (m.debtPct == null) return 1; // no credit limit registered → full credit
      return m.debtPct <= 110 ? 1 : 0; // exceeding 110% loses the entire debt weight
    }
    case 'damage': {
      if (m.damagePct == null) return 1; // no sales this month → nothing to penalize
      return m.damagePct <= DAMAGE_TARGET_PCT ? 1 : 0;
    }
    case 'fridges': {
      // No fridges registered on this route at all → nothing to be
      // covered or sold, so don't penalize the rep for it: full weight.
      if (m.fridgeCoveragePct == null && m.fridgeTargetAch == null) return 1;
      const cov = (m.fridgeCoveragePct ?? 0) / 100;
      const tgt = (m.fridgeTargetAch   ?? 0) / 100;
      // Capped at 100% — over-achieving the fridge target can never earn
      // more than the item's own registered weight.
      return Math.min((cov + tgt) / 2, 1);
    }
    default: return 0;
  }
}

/** m: { qtyAch, custAch, debtPct, damagePct, fridgeCoveragePct, fridgeTargetAch }
    weights: { qty, customers, debt, damage, fridges } (percentages, ~sum to 100) */
function computeCommissionPct(m, weights) {
  // Zero sales achievement kills the whole commission — no other item
  // (debt compliance, damage, fridges, even customer count) earns
  // anything if the "مبيعات" contribution is truly 0%. This covers BOTH
  // a real target with 0 achieved (qtyAch === 0) AND no target/no sales
  // at all (qtyAch === null) — matching exactly what the "مبيعات" column
  // displays. Checked against the raw metric (not itemEarnedFraction)
  // so it stays scoped to literal zero — the milder MIN_QTY_ACH_PCT rule
  // below only forfeits the qty item's own weight, not the whole thing.
  if (m.qtyAch === null || m.qtyAch === undefined || m.qtyAch === 0) {
    const breakdown = {};
    ITEM_KEYS.forEach(k => {
      breakdown[k] = { weight: Number(weights[k] || 0), earned_fraction_pct: 0, earned_pct: 0 };
    });
    return { total_pct: 0, breakdown };
  }

  let total = 0;
  const breakdown = {};
  ITEM_KEYS.forEach(k => {
    const w = Number(weights[k] || 0);
    const frac = itemEarnedFraction(k, m);
    const earnedPct = w * frac;
    breakdown[k] = {
      weight: w,
      earned_fraction_pct: +(frac * 100).toFixed(1),
      earned_pct: +earnedPct.toFixed(2),
    };
    total += earnedPct;
  });
  return { total_pct: +total.toFixed(2), breakdown };
}

/**
 * سبب خصم كامل وزن بند المديونية: نسبة التجاوز فوق الحد المسموح (110%).
 * يُعاد null إذا لم تتجاوز المديونية الحد (لا يوجد خصم).
 */
function debtExcessInfo(debtPct) {
  if (debtPct == null || debtPct <= 110) return null;
  return { excess_pct: +(debtPct - 110).toFixed(1) };
}

/**
 * توزيع الهدف للكميات حسب فئة العميل — إذا لم يحقق المندوب هدف إحدى فئات
 * العملاء بالكامل، لا يُسمح بتعويض النقص من فائض فئة أخرى. الخصم الجزائي
 * = فقط نِسَب عدم التحقيق (الفرق target − qty) لكل فئة غير محققة، مطروحة
 * من إجمالي الكمية المحققة الخام — وليس الفرق بين المحقق الخام والمحقق
 * بعد تسقيف كل فئة على حدة عند هدفها؛ فائض فئة محققة فوق هدفها يظل
 * محسوبًا بالكامل ضمن الإجمالي (لا يُهدر)، فقط النقص هو ما يُخصم.
 *
 * categoryBreakdown: [{ category, qty, target }, ...] — فئات بلا هدف مُعدّ
 * (target = 0) لا تُحتسب ضمن فحص القصور (لا يوجد ما يُقصَّر فيه) لكن
 * كميتها تبقى ضمن الإجمالي الخام كأي فئة أخرى.
 * يُعاد null إذا لم يوجد أي فئة لها هدف مُعدّ (لا يوجد نظام توزيع فعّال).
 */
function computeCategoryPenalty(categoryBreakdown, qtyTarget) {
  if (!qtyTarget || qtyTarget <= 0 || !categoryBreakdown || !categoryBreakdown.length) return null;
  let totalQty = 0;
  let totalShortfallQty = 0;
  let hasTargetedCategory = false;
  const shortfalls = [];
  categoryBreakdown.forEach(c => {
    const target = Number(c.target || 0);
    const qty    = Number(c.qty || 0);
    totalQty += qty;
    if (target > 0) {
      hasTargetedCategory = true;
      if (qty < target) {
        const shortfallQty = target - qty;
        totalShortfallQty += shortfallQty;
        shortfalls.push({
          category: c.category,
          target: +target.toFixed(1),
          qty: +qty.toFixed(1),
          shortfall_qty: +shortfallQty.toFixed(1),
          shortfall_pct_of_target: +((shortfallQty / qtyTarget) * 100).toFixed(2),
        });
      }
    }
  });
  if (!hasTargetedCategory) return null;
  const penalizedQty = totalQty - totalShortfallQty;
  const penalizedPct = +((penalizedQty / qtyTarget) * 100).toFixed(1);
  shortfalls.sort((a, b) => b.shortfall_qty - a.shortfall_qty);
  return { penalized_pct: penalizedPct, penalized_qty: +penalizedQty.toFixed(1), shortfalls };
}

module.exports = {
  DAMAGE_TARGET_PCT, MIN_QTY_ACH_PCT, ITEM_KEYS, ITEM_LABELS_AR, itemEarnedFraction, computeCommissionPct,
  computeCategoryPenalty, debtExcessInfo,
};
