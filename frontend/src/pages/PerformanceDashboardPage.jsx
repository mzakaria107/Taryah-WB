import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import {
  RefreshCw, ChevronDown, ChevronLeft, Printer,
  TrendingUp, Users, MapPin, Target, Wallet, BarChart2, AlertTriangle,
  Settings, X, ChevronUp, FileSpreadsheet,
} from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import { usePermissions } from '../context/PermissionsContext';
import './PerformanceDashboardPage.css';

const ADMIN_ROLES = ['super_admin', 'it_admin'];

const MONTHS = [
  {v:1,l:'يناير'},{v:2,l:'فبراير'},{v:3,l:'مارس'},{v:4,l:'أبريل'},
  {v:5,l:'مايو'},{v:6,l:'يونيو'},{v:7,l:'يوليو'},{v:8,l:'أغسطس'},
  {v:9,l:'سبتمبر'},{v:10,l:'أكتوبر'},{v:11,l:'نوفمبر'},{v:12,l:'ديسمبر'},
];
const now = new Date();
const CUR_YEAR  = now.getFullYear();
const CUR_MONTH = now.getMonth() + 1;

const fmt  = n => (n ?? 0).toLocaleString('en-SA', { maximumFractionDigits: 0 });
const fmtC = n => (n ?? 0).toLocaleString('en-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtP = n => n !== null && n !== undefined ? `${n.toFixed(1)}%` : '—';

/* ── Item-category qty colors (product type, not customer category) ── */
const ITEM_CAT_COLORS = {
  'دجاج مبرد طرية': '#2563eb',
  'مقطعات طرية':    '#d97706',
  'دجاج مجمد':      '#7c3aed',
  'أخرى':           '#64748b',
};
function ItemCatBreakdown({ rows, field }) {
  if (!rows?.length) return null;
  const visible = field === 'target' ? rows.filter(c => c.target > 0)
    : field === 'achievement' ? rows.filter(c => c.achievement !== null)
    : rows;
  if (!visible.length) return null;
  return (
    <div className="pdp-qty-cats">
      {visible.map(c => (
        <span key={c.category} className="pdp-qty-cat" style={{ color: ITEM_CAT_COLORS[c.category] || '#64748b' }}>
          {c.category}: {field === 'target' ? fmt(c.target) : field === 'achievement' ? fmtP(c.achievement) : fmt(c.qty)}
        </span>
      ))}
    </div>
  );
}

/* ── Achievement color ───────────────────────────────────────── */
function achColor(pct) {
  if (pct === null || pct === undefined) return 'var(--color-text-muted)';
  if (pct >= 100) return '#059669';
  if (pct >= 80)  return '#16a34a';
  if (pct >= 60)  return '#d97706';
  if (pct >= 40)  return '#ea580c';
  return '#dc2626';
}
function achBg(pct) {
  if (pct === null || pct === undefined) return 'transparent';
  if (pct >= 100) return '#d1fae5';
  if (pct >= 80)  return '#dcfce7';
  if (pct >= 60)  return '#fef3c7';
  if (pct >= 40)  return '#ffedd5';
  return '#fee2e2';
}

function AchBadge({ pct }) {
  if (pct === null || pct === undefined) return <span className="pdp-muted">—</span>;
  return (
    <span className="pdp-ach-badge" style={{ background: achBg(pct), color: achColor(pct) }}>
      {pct.toFixed(1)}%
    </span>
  );
}

/* ── Category-penalty indicator — shown under the qty achievement badge
   when a customer-category shortfall reduced the raw qty_mtd/qty_target
   ratio (surplus in one category can't offset a deficit in another).
   Hover/title lists which categories caused it and by how much. ── */
function PenaltyBadge({ penaltyPct, reasons }) {
  if (!penaltyPct || penaltyPct <= 0) return null;
  const title = (reasons || [])
    .map(r => `${r.category}: نقص ${fmt(r.shortfall_qty)} (${r.shortfall_pct_of_target}% من الهدف)`)
    .join('\n');
  return (
    <div className="pdp-penalty-badge" title={title}>
      خصم جزائي: -{penaltyPct.toFixed(1)}%
    </div>
  );
}

/* ── Minimum-qty-achievement indicator — the qty item's entire weight is
   forfeited if achievement is below 80% of target (a distinct, milder
   rule than the zero-sales kill-switch, which zeroes the whole commission
   only at literal 0%). Only shown for the 0–80% range, not at exactly 0%
   (already visually obvious there as a 0.0% badge). ── */
function MinQtyThresholdBadge({ qtyAch }) {
  if (qtyAch === null || qtyAch === undefined || qtyAch <= 0 || qtyAch >= 80) return null;
  return (
    <div className="pdp-penalty-badge" title="يلزم تحقيق 80% على الأقل من الهدف لاستحقاق وزن بند تحقيق المبيعات — أقل من ذلك يُخصم وزن البند بالكامل">
      أقل من الحد الأدنى (80%)
    </div>
  );
}

/* ── Growth badge ────────────────────────────────────────────── */
function GrowthBadge({ pct }) {
  if (pct === null || pct === undefined) return <span className="pdp-muted">—</span>;
  const color = pct >= 0 ? '#059669' : '#dc2626';
  return <span style={{ color, fontWeight: 600 }}>{pct >= 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%</span>;
}

/* ── التوالف (damage) cell — green at/under 0.5% of gross qty sold,
   red above it ── */
function DamageCell({ qty, pct, exceeded }) {
  if (pct === null || pct === undefined) return <span className="pdp-muted">—</span>;
  return (
    <span className={exceeded ? 'pdp-debt-exceeded' : 'pdp-debt-ok'}>
      {exceeded && <AlertTriangle size={12} style={{marginLeft:3, verticalAlign:'middle'}}/>}
      {fmt(qty)} ({pct.toFixed(2)}%)
    </span>
  );
}

/* ── تغطية الثلاجات cell ── two stacked lines:
   1) coverage % = fridges whose customer bought this month ÷ total fridges
   2) target %   = actual qty sold to fridge customers ÷ (fridges × 40/day × working days) ── */
function FridgeCoverageCell({ total, covered, coveragePct, target, qty, targetAch }) {
  if (!total) return <span className="pdp-muted">—</span>;
  return (
    <div className="pdp-fridge-cell">
      <div className="pdp-fridge-line">
        <span className="pdp-fridge-lbl">التغطية:</span> {covered}/{total}
        <span className="pdp-fridge-pct" style={{ color: achColor(coveragePct) }}> ({fmtP(coveragePct)})</span>
      </div>
      <div className="pdp-fridge-line">
        <span className="pdp-fridge-lbl">الهدف:</span> {fmt(qty)}/{fmt(target)} <AchBadge pct={targetAch}/>
      </div>
    </div>
  );
}

/* ── KPI Card ────────────────────────────────────────────────── */
function KpiCard({ icon, label, value, sub, color }) {
  return (
    <div className="pdp-kpi" style={{ '--kpi-color': color }}>
      <div className="pdp-kpi-icon">{icon}</div>
      <div className="pdp-kpi-body">
        <div className="pdp-kpi-val">{value ?? '—'}</div>
        <div className="pdp-kpi-lbl">{label}</div>
        {sub && <div className="pdp-kpi-sub">{sub}</div>}
      </div>
    </div>
  );
}

/* ── Category breakdown mini-table ──────────────────────────────
   Shared by the rep-expand row and the region-expand row. Shows, per
   customer category: qty sold this month, that category's slice of
   the overall qty_target (via the admin-configured split %), and the
   resulting achievement %. ── */
function CategoryBreakdownTable({ rows }) {
  if (!rows?.length) {
    return <div className="pdp-cat-empty">لا توجد مبيعات مصنّفة بفئة هذا الشهر</div>;
  }
  return (
    <table className="pdp-cat-table">
      <thead>
        <tr>
          <th>الفئة</th>
          <th>الكمية المباعة</th>
          <th>% من الهدف</th>
          <th>هدف الفئة</th>
          <th>% التحقق</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(c => (
          <tr key={c.category}>
            <td className="pdp-cat-name">{c.category}</td>
            <td>{fmt(c.qty)}</td>
            <td>{c.target_pct > 0 ? `${c.target_pct}%` : <span className="pdp-muted">—</span>}</td>
            <td>{c.target > 0 ? fmt(c.target) : <span className="pdp-muted">—</span>}</td>
            <td><AchBadge pct={c.achievement}/></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── Rep row ─────────────────────────────────────────────────── */
function RepRow({ rep, showCategoryBreakdown, bulkToggle }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (bulkToggle) setOpen(bulkToggle.open); }, [bulkToggle?.ts]);
  const expandable = showCategoryBreakdown;
  return (
    <>
      <tr className="pdp-rep-row" onClick={expandable ? () => setOpen(v => !v) : undefined} style={expandable ? { cursor: 'pointer' } : undefined}>
        <td className="pdp-td pdp-td-name">
          {expandable && <span className="pdp-rep-toggle">{open ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}</span>}
          <span className="pdp-rep-avatar">{rep.rep_name?.charAt(0) || '?'}</span>
          <div>
            <div className="pdp-rep-name">{rep.rep_name}</div>
            {rep.supervisor && <div className="pdp-rep-sup">مشرف: {rep.supervisor}</div>}
          </div>
        </td>
        <td className="pdp-td pdp-td-num">
          {fmt(rep.qty_mtd)}
          <ItemCatBreakdown rows={rep.item_qty_breakdown} field="qty"/>
        </td>
        <td className="pdp-td pdp-td-num">{fmt(rep.qty_prev)}</td>
        <td className="pdp-td pdp-td-num"><GrowthBadge pct={rep.qty_growth}/></td>
        <td className="pdp-td pdp-td-num">
          {rep.qty_target > 0 ? fmt(rep.qty_target) : <span className="pdp-muted">—</span>}
          <ItemCatBreakdown rows={rep.item_qty_breakdown} field="target"/>
        </td>
        <td className="pdp-td pdp-td-center">
          <AchBadge pct={rep.qty_achievement}/>
          <PenaltyBadge penaltyPct={rep.qty_penalty_pct} reasons={rep.qty_penalty_reasons}/>
          <MinQtyThresholdBadge qtyAch={rep.qty_achievement}/>
          <ItemCatBreakdown rows={rep.item_qty_breakdown} field="achievement"/>
        </td>
        <td className="pdp-td pdp-td-num">{rep.customers_prev}</td>
        <td className="pdp-td pdp-td-num">
          {rep.customers_mtd}
          {rep.new_customers_mtd > 0 && <span className="pdp-new-cust">+{rep.new_customers_mtd} جديد</span>}
        </td>
        <td className="pdp-td pdp-td-num">{rep.customer_target > 0 ? rep.customer_target : <span className="pdp-muted">—</span>}</td>
        <td className="pdp-td pdp-td-num">{rep.customer_gap !== null ? rep.customer_gap : <span className="pdp-muted">—</span>}</td>
        <td className="pdp-td pdp-td-center"><AchBadge pct={rep.customer_achievement}/></td>
        <td className="pdp-td pdp-td-num">
          {rep.credit_limit > 0
            ? <><span>{fmt(rep.credit_limit)}</span><div className="pdp-limit-hint">الحد المسموح: {fmt(rep.max_allowed_debt)}</div></>
            : <span className="pdp-muted">—</span>}
        </td>
        <td className="pdp-td pdp-td-num">{rep.outstanding_balance > 0 ? fmt(rep.outstanding_balance) : <span className="pdp-muted">—</span>}</td>
        <td className="pdp-td pdp-td-num">
          {rep.debt_pct !== null
            ? <span className={rep.debt_exceeded ? 'pdp-debt-exceeded' : 'pdp-debt-ok'}>
                {rep.debt_exceeded && <AlertTriangle size={12} style={{marginLeft:3, verticalAlign:'middle'}}/>}
                {fmtP(rep.debt_pct)}
              </span>
            : <span className="pdp-muted">—</span>}
        </td>
        <td className="pdp-td pdp-td-num"><DamageCell qty={rep.damage_qty} pct={rep.damage_pct} exceeded={rep.damage_exceeded}/></td>
        <td className="pdp-td pdp-td-num">
          <FridgeCoverageCell
            total={rep.fridges_total} covered={rep.fridges_covered} coveragePct={rep.fridge_coverage_pct}
            target={rep.fridge_target} qty={rep.fridge_qty} targetAch={rep.fridge_target_achievement}
          />
        </td>
        <td className="pdp-td pdp-td-center"><AchBadge pct={rep.weighted_achievement}/></td>
      </tr>
      {expandable && open && (
        <tr className="pdp-cat-row">
          <td colSpan={17}>
            <div className="pdp-cat-wrap">
              <div className="pdp-cat-title">توزيع كمية {rep.rep_name} حسب فئة العميل</div>
              <CategoryBreakdownTable rows={rep.category_breakdown} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ── Region block ────────────────────────────────────────────── */
function RegionBlock({ region, rank, showCategoryBreakdown, bulkToggle }) {
  const [open, setOpen] = useState(rank < 3);
  useEffect(() => { if (bulkToggle) setOpen(bulkToggle.open); }, [bulkToggle?.ts]);
  return (
    <>
      <tr className="pdp-region-row" onClick={() => setOpen(v => !v)}>
        <td className="pdp-td pdp-td-name pdp-region-name">
          <span className="pdp-toggle">{open ? <ChevronDown size={14}/> : <ChevronLeft size={14}/>}</span>
          {rank === 0 && <span className="pdp-crown">🏆</span>}
          📍 {region.region_name}
          <span className="pdp-region-meta">{region.reps_count} مندوب</span>
        </td>
        <td className="pdp-td pdp-td-num pdp-bold">
          {fmt(region.qty_mtd)}
          <ItemCatBreakdown rows={region.item_qty_breakdown} field="qty"/>
        </td>
        <td className="pdp-td pdp-td-num">{fmt(region.qty_prev)}</td>
        <td className="pdp-td pdp-td-num"><GrowthBadge pct={region.qty_growth}/></td>
        <td className="pdp-td pdp-td-num">
          {region.qty_target > 0 ? fmt(region.qty_target) : <span className="pdp-muted">—</span>}
          <ItemCatBreakdown rows={region.item_qty_breakdown} field="target"/>
        </td>
        <td className="pdp-td pdp-td-center">
          <AchBadge pct={region.qty_achievement}/>
          <PenaltyBadge penaltyPct={region.qty_penalty_pct} reasons={region.qty_penalty_reasons}/>
          <MinQtyThresholdBadge qtyAch={region.qty_achievement}/>
          <ItemCatBreakdown rows={region.item_qty_breakdown} field="achievement"/>
        </td>
        <td className="pdp-td pdp-td-num">{region.customers_prev}</td>
        <td className="pdp-td pdp-td-num pdp-bold">
          {region.customers_mtd}
          {region.new_customers_mtd > 0 && <span className="pdp-new-cust">+{region.new_customers_mtd} جديد</span>}
        </td>
        <td className="pdp-td pdp-td-num">{region.customer_target > 0 ? region.customer_target : <span className="pdp-muted">—</span>}</td>
        <td className="pdp-td pdp-td-num">{region.customer_gap !== null ? region.customer_gap : <span className="pdp-muted">—</span>}</td>
        <td className="pdp-td pdp-td-center"><AchBadge pct={region.customer_achievement}/></td>
        <td className="pdp-td pdp-td-num">{region.credit_limit > 0 ? fmt(region.credit_limit) : <span className="pdp-muted">—</span>}</td>
        <td className="pdp-td pdp-td-num">{region.outstanding_balance > 0 ? fmt(region.outstanding_balance) : <span className="pdp-muted">—</span>}</td>
        <td className="pdp-td pdp-td-num">
          {region.debt_pct !== null
            ? <span className={region.debt_exceeded ? 'pdp-debt-exceeded' : 'pdp-debt-ok'}>
                {region.debt_exceeded && <AlertTriangle size={12} style={{marginLeft:3, verticalAlign:'middle'}}/>}
                {fmtP(region.debt_pct)}
                {region.reps_exceeded_limit > 0 && <span className="pdp-debt-reps-count"> ({region.reps_exceeded_limit})</span>}
              </span>
            : <span className="pdp-muted">—</span>}
        </td>
        <td className="pdp-td pdp-td-num">
          <DamageCell qty={region.damage_qty} pct={region.damage_pct} exceeded={region.damage_exceeded}/>
          {region.reps_damage_exceeded > 0 && <span className="pdp-debt-reps-count"> ({region.reps_damage_exceeded})</span>}
        </td>
        <td className="pdp-td pdp-td-num">
          <FridgeCoverageCell
            total={region.fridges_total} covered={region.fridges_covered} coveragePct={region.fridge_coverage_pct}
            target={region.fridge_target} qty={region.fridge_qty} targetAch={region.fridge_target_achievement}
          />
        </td>
        <td className="pdp-td pdp-td-center"><AchBadge pct={region.weighted_achievement}/></td>
      </tr>
      {showCategoryBreakdown && open && (
        <tr className="pdp-cat-row pdp-cat-row--region">
          <td colSpan={17}>
            <div className="pdp-cat-wrap">
              <div className="pdp-cat-title">توزيع كمية منطقة {region.region_name} حسب فئة العميل (إجمالي المناديب)</div>
              <CategoryBreakdownTable rows={region.category_breakdown} />
            </div>
          </td>
        </tr>
      )}
      {open && region.reps.map(rep => <RepRow key={rep.rep_id} rep={rep} showCategoryBreakdown={showCategoryBreakdown} bulkToggle={bulkToggle}/>)}
    </>
  );
}

/* ── Category target-split settings modal (admin only) ─────────
   Lets an admin set, per customer category, what % of a rep's overall
   qty_target that category is expected to carry — at three levels
   (عام/منطقة/مندوب), resolved on the backend as rep > region > global. ── */
function CategorySplitModal({ onClose, regionList, repList }) {
  const qc = useQueryClient();
  const [scope, setScope] = useState('global'); // 'global' | 'region' | 'rep'
  const [scopeId, setScopeId] = useState('');

  const scopeReady = scope === 'global' || !!scopeId;
  const { data, isLoading } = useQuery({
    queryKey: ['pdp-category-splits', scope, scopeId],
    queryFn: () => client.get('/performance-dashboard/category-splits', {
      params: { scope, ...(scopeId ? { scope_id: scopeId } : {}) },
    }).then(r => r.data),
    enabled: scopeReady,
    staleTime: 60 * 1000,
  });

  const [draft, setDraft] = useState(null); // { [category]: pct }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const categories = data?.categories || [];
  const splitsByCat = useMemo(() => {
    const m = {};
    (data?.splits || []).forEach(s => { m[s.category_name] = Number(s.pct); });
    return m;
  }, [data]);

  // Reset the draft whenever the scope changes so stale edits don't leak
  // across e.g. switching from one rep to another.
  const values = draft || splitsByCat;
  const setPct = (cat, v) => setDraft({ ...values, [cat]: v });

  const handleScopeChange = (newScope) => { setScope(newScope); setScopeId(''); setDraft(null); };
  const handleScopeIdChange = (id) => { setScopeId(id); setDraft(null); };

  const total = categories.reduce((s, c) => s + (parseFloat(values[c]) || 0), 0);
  const hasOverrides = scope !== 'global' && (data?.splits?.length > 0);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const splits = categories.map(c => ({ category_name: c, pct: parseFloat(values[c]) || 0 }));
      await client.put('/performance-dashboard/category-splits', { splits, scope, scope_id: scopeId || undefined });
      await qc.invalidateQueries({ queryKey: ['pdp-category-splits'] });
      qc.invalidateQueries({ queryKey: ['performance-dashboard'] });
      setDraft(null);
    } catch (e) {
      setError(e?.response?.data?.error || 'حدث خطأ أثناء الحفظ');
    } finally {
      setSaving(false);
    }
  };

  const handleClearOverride = async () => {
    if (scope === 'global' || !scopeId) return;
    setSaving(true);
    setError('');
    try {
      await Promise.all(categories.map(cat =>
        client.delete('/performance-dashboard/category-splits', { params: { scope, scope_id: scopeId, category_name: cat } })
      ));
      await qc.invalidateQueries({ queryKey: ['pdp-category-splits'] });
      qc.invalidateQueries({ queryKey: ['performance-dashboard'] });
      setDraft(null);
    } catch (e) {
      setError(e?.response?.data?.error || 'حدث خطأ أثناء الحذف');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pdp-modal-overlay" onClick={onClose}>
      <div className="pdp-modal" onClick={e => e.stopPropagation()}>
        <div className="pdp-modal-header">
          <span>🎯 توزيع الهدف حسب فئة العميل</span>
          <button className="pdp-modal-close" onClick={onClose}><X size={18}/></button>
        </div>
        <div className="pdp-modal-body">
          <p className="pdp-modal-hint">
            حدد نسبة كل فئة من إجمالي الهدف. يمكن ضبط نسب مختلفة لكل منطقة أو مندوب — الأولوية عند الحساب: مندوب &gt; منطقة &gt; عام (افتراضي). لا يلزم أن يكون المجموع 100%.
          </p>

          <div className="pdp-scope-tabs">
            <button className={`pdp-scope-tab${scope === 'global' ? ' pdp-scope-tab--active' : ''}`} onClick={() => handleScopeChange('global')}>عام (افتراضي)</button>
            <button className={`pdp-scope-tab${scope === 'region' ? ' pdp-scope-tab--active' : ''}`} onClick={() => handleScopeChange('region')}>منطقة</button>
            <button className={`pdp-scope-tab${scope === 'rep' ? ' pdp-scope-tab--active' : ''}`} onClick={() => handleScopeChange('rep')}>مندوب</button>
          </div>

          {scope === 'region' && (
            <select className="pdp-select" style={{ width: '100%', marginBottom: 14 }} value={scopeId} onChange={e => handleScopeIdChange(e.target.value)}>
              <option value="">اختر منطقة…</option>
              {regionList.map(r => <option key={r.id} value={r.id}>{r.name_ar || r.name_en}</option>)}
            </select>
          )}
          {scope === 'rep' && (
            <select className="pdp-select" style={{ width: '100%', marginBottom: 14 }} value={scopeId} onChange={e => handleScopeIdChange(e.target.value)}>
              <option value="">اختر مندوباً…</option>
              {repList.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
            </select>
          )}

          {!scopeReady ? (
            <div className="pdp-empty">اختر {scope === 'region' ? 'منطقة' : 'مندوباً'} أولاً</div>
          ) : isLoading ? (
            <div className="pdp-loading"><RefreshCw size={18} className="pdp-spin"/> جارٍ التحميل…</div>
          ) : !categories.length ? (
            <div className="pdp-empty">لا توجد فئات عملاء في بيانات المبيعات بعد</div>
          ) : (
            <>
              {scope !== 'global' && (
                <div className="pdp-scope-note">
                  {hasOverrides
                    ? 'توجد نسب مخصصة لهذا النطاق — تُستخدم بدلاً من القيم العامة.'
                    : 'لا توجد نسب مخصصة بعد — القيم أدناه هي القيم العامة الحالية كمرجع فقط؛ الحفظ هنا ينشئ نسخة خاصة بهذا النطاق.'}
                </div>
              )}
              <table className="pdp-split-table">
                <thead>
                  <tr><th>الفئة</th><th>النسبة من الهدف</th></tr>
                </thead>
                <tbody>
                  {categories.map(cat => (
                    <tr key={cat}>
                      <td>{cat}</td>
                      <td>
                        <div className="pdp-split-input-wrap">
                          <input
                            type="number" min="0" max="100" step="0.1"
                            className="pdp-split-input"
                            value={values[cat] ?? 0}
                            onChange={e => setPct(cat, e.target.value)}
                          />
                          <span>%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>الإجمالي</td>
                    <td className={Math.abs(total - 100) > 0.5 ? 'pdp-split-total-warn' : 'pdp-split-total-ok'}>
                      {total.toFixed(1)}%
                    </td>
                  </tr>
                </tfoot>
              </table>
              {error && <div className="pdp-error" style={{ marginTop: 10 }}>{error}</div>}
              <div className="pdp-modal-actions">
                <button className="pdp-btn pdp-btn--refresh" onClick={handleSave} disabled={saving}>
                  {saving ? 'جارٍ الحفظ…' : 'حفظ'}
                </button>
                {scope !== 'global' && hasOverrides && (
                  <button className="pdp-btn pdp-btn--danger" onClick={handleClearOverride} disabled={saving}>
                    إزالة التخصيص (العودة للعام)
                  </button>
                )}
                <button className="pdp-btn" onClick={onClose}>إغلاق</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   TAB: حساب العمولات (admin only)
════════════════════════════════════════════════════════════════ */
const ITEM_ORDER = ['qty', 'customers', 'debt', 'damage', 'fridges'];
const ITEM_SHORT_AR = {
  qty: 'مبيعات', customers: 'عملاء', debt: 'مديونية', damage: 'توالف', fridges: 'ثلاجات',
};
const MANAGER_ROLE_LABELS = {
  supervisor: 'المشرفون', region_manager: 'مديرو المناطق',
  sector_manager: 'مديرو القطاعات', sales_manager: 'مديرو المبيعات',
};
const MANAGER_ROLE_ORDER = ['supervisor', 'region_manager', 'sector_manager', 'sales_manager'];

function CommissionWeightsPanel({ canEdit }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['commission-weights'],
    queryFn: () => client.get('/commissions/weights').then(r => r.data),
    staleTime: 60_000,
  });
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const values = draft || data?.weights || {};
  const total = ITEM_ORDER.reduce((s, k) => s + (parseFloat(values[k]) || 0), 0);

  const handleSave = async () => {
    setSaving(true);
    try {
      await client.put('/commissions/weights', { weights: values });
      await qc.invalidateQueries({ queryKey: ['commission-weights'] });
      qc.invalidateQueries({ queryKey: ['commission-report'] });
      qc.invalidateQueries({ queryKey: ['performance-dashboard'] });
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) return <div className="pdp-loading"><RefreshCw size={16} className="pdp-spin"/> جارٍ التحميل…</div>;

  return (
    <div className="pdp-comm-weights">
      <div className="pdp-comm-weights-title">⚖️ أوزان بنود العمولة الافتراضية (لكل الأفراد)</div>
      <p className="pdp-modal-hint">
        كل بند يستحق نسبة من العمولة بحسب وزنه المسجل هنا × نسبة تحقيقه الفعلية. مجموع الأوزان يمثل 100% من العمولة.
      </p>
      <div className="pdp-comm-weights-grid">
        {ITEM_ORDER.map(k => (
          <div key={k} className="pdp-comm-weight-field">
            <label>{data?.labels?.[k] || ITEM_SHORT_AR[k]}</label>
            <div className="pdp-split-input-wrap">
              <input type="number" min="0" max="100" step="0.5" className="pdp-split-input"
                value={values[k] ?? 0} disabled={!canEdit}
                onChange={e => setDraft({ ...values, [k]: e.target.value })}/>
              <span>%</span>
            </div>
          </div>
        ))}
        <div className="pdp-comm-weight-field pdp-comm-weight-total">
          <label>الإجمالي</label>
          <span className={Math.abs(total - 100) > 0.5 ? 'pdp-split-total-warn' : 'pdp-split-total-ok'}>{total.toFixed(1)}%</span>
        </div>
      </div>
      {canEdit && (
        <button className="pdp-btn pdp-btn--refresh" onClick={handleSave} disabled={saving || !draft}>
          {saving ? 'جارٍ الحفظ…' : 'حفظ الأوزان'}
        </button>
      )}
    </div>
  );
}

/* ── Methodology guide — plain-language explanation of exactly how the
   commission % is computed, kept in sync with utils/commission.js so it
   never drifts from the real formula. ── */
function CommissionMethodologyPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="pdp-comm-methodology">
      <button className="pdp-comm-methodology-toggle" onClick={() => setOpen(v => !v)}>
        {open ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
        📘 طريقة حساب العمولات بالتفصيل
      </button>
      {open && (
        <div className="pdp-comm-methodology-body">
          <p>العمولة = مجموع 5 بنود، كل بند يستحق (وزنه المسجل أعلاه × نسبة تحقيقه). أوزان البنود قابلة للتعديل ويُفترض أن يكون مجموعها 100%.</p>
          <ul>
            <li><strong>تحقيق هدف المبيعات (الكمية):</strong> الكمية المباعة ÷ الهدف، بحد أقصى 110% (أي تحقيق 150% لا يستحق أكثر من 110% من وزن هذا البند).
              <ul>
                <li>يشترط تحقيق <strong>80% على الأقل</strong> من الهدف لاستحقاق أي جزء من وزن هذا البند — أقل من 80% يُخصم وزن البند بالكامل (خصم جزائي كامل، وليس نسبيًا)، وتظهر ملاحظة "أقل من الحد الأدنى (80%)" تحت النسبة كسبب الخصم.</li>
                <li>عند وجود توزيع للهدف حسب فئة العميل: الخصم الجزائي = فقط نِسَب عدم التحقيق (الفرق الهدف − المحقق) لكل فئة غير محققة، تُخصم من إجمالي الكمية المحققة الخام قبل حساب النسبة النهائية (وقبل تطبيق شرط الـ80% أعلاه) — فائض فئة محققة فوق هدفها يبقى محسوبًا بالكامل ولا يُهدر، فقط النقص هو ما يُخصم؛ لا يُسمح بتعويض نقص فئة من فائض فئة أخرى. تظهر نسبة هذا "الخصم الجزائي" وسببه (الفئات الناقصة وقيمتها) كملاحظة حمراء تحت النسبة.</li>
              </ul>
            </li>
            <li><strong>تحقيق هدف العملاء:</strong> عدد العملاء النشطين ÷ الهدف، بحد أقصى 100% من وزن البند مهما بلغت نسبة التحقيق (نفس قاعدة بند الثلاجات).</li>
            <li><strong>نسبة المديونية:</strong> الرصيد القائم ÷ الحد الائتماني.
              <ul>
                <li>يستحق كامل وزن هذا البند طالما النسبة ≤ 110% من الحد.</li>
                <li>بمجرد تجاوز 110% يُخصم <strong>كامل وزن البند</strong> فورًا (صفر بالكامل وليس خصمًا تدريجيًا) — وتظهر نسبة التجاوز فوق الحد كسبب للخصم.</li>
              </ul>
            </li>
            <li><strong>تحقيق هدف التوالف:</strong> بند ثنائي — كامل الوزن إذا نسبة التوالف من إجمالي الكمية المباعة ≤ 0.5%، وصفر تمامًا إذا تجاوزتها.</li>
            <li><strong>تغطية وهدف الثلاجات:</strong> متوسط نسبتين، كل واحدة تستحق نصف وزن هذا البند، بحد أقصى 100% من وزن البند مهما بلغت نسبة التحقيق:
              <ul>
                <li>نسبة التغطية = عدد الثلاجات النشطة التي اشترى صاحبها هذا الشهر ÷ إجمالي الثلاجات النشطة على خط السير.</li>
                <li>نسبة تحقيق هدف الثلاجات = الكمية المباعة لعملاء الثلاجات ÷ (عدد الثلاجات × 40 وحدة/يوم × أيام العمل).</li>
                <li>إذا لم يكن على خط السير أي ثلاجات مسجلة أصلًا، يُمنح كامل وزن هذا البند (لا يوجد ما يُحاسَب عليه).</li>
              </ul>
            </li>
          </ul>
          <p><strong>قاعدة صفر المبيعات:</strong> إذا كانت نسبة تحقيق هدف المبيعات = 0% (سواء لعدم وجود هدف أصلًا أو لعدم تحقيق أي كمية)، فإن العمولة الكلية تُحتسب صفرًا مهما كانت باقي البنود.</p>
          <p><strong>السقف النهائي:</strong> عند تحويل نسبة العمولة الإجمالية إلى مبلغ مالي، تُحدَّد النسبة المستخدمة في الحساب بحد أقصى 110% من حد العمولة المسجل لكل فرد.</p>
          <p><strong>حساب المشرفين ومديري المناطق والقطاعات والمبيعات:</strong></p>
          <ul>
            <li>بند الكمية والعملاء: مجموع المحقق ÷ مجموع الهدف لكل المناديب المرتبطين مباشرة بهذا المدير (وتُطبَّق عليه نفس قاعدة الخصم الجزائي لفئات العملاء أعلاه على المستوى المجمّع).</li>
            <li>بند المديونية: إجمالي الرصيد القائم لكل المناديب المرتبطين مباشرة بهذا المدير ÷ إجمالي حدودهم الائتمانية (وليس متوسط نسبهم الفردية — حتى لا يسحب مندوب واحد شاذ الفريق كله فوق حد الـ110% رغم أن إجمالي الفريق داخل الحد المسموح).</li>
            <li>بند التوالف والثلاجات: متوسط نسب المناديب المرتبطين مباشرة بالمشرف أو مدير المنطقة.</li>
            <li>لمدير القطاع ومدير المبيعات تحديدًا (أدوار على مستوى الشركة): هذه البنود الثلاثة تُحسب كمتوسط لجميع المناديب النشطين، وليس فقط من هم مرتبطون به مباشرة.</li>
          </ul>
        </div>
      )}
    </div>
  );
}

function CommissionBreakdownCells({ breakdown, person }) {
  const debtExcess = person?.metrics?.debt_excess_pct;
  return ITEM_ORDER.map(k => (
    <td key={k} className="pdp-td pdp-td-num" title={`تحقيق ${breakdown[k]?.earned_fraction_pct ?? 0}% × وزن ${breakdown[k]?.weight ?? 0}%`}>
      {(breakdown[k]?.earned_pct ?? 0).toFixed(1)}%
      {k === 'qty' && <PenaltyBadge penaltyPct={person?.qty_penalty_pct} reasons={person?.qty_penalty_reasons}/>}
      {k === 'qty' && <MinQtyThresholdBadge qtyAch={person?.metrics?.qty_achievement}/>}
      {k === 'debt' && debtExcess != null && (
        <div className="pdp-penalty-badge" title={`المديونية تجاوزت الحد المسموح (110%) بنسبة ${debtExcess}% — خُصم كامل وزن بند المديونية`}>
          خصم كامل الوزن: تجاوز {debtExcess}%
        </div>
      )}
    </td>
  ));
}

function CommissionPersonRow({ person, personType, personId, extraLabel, limitDraft, onLimitChange, blurAmounts, canEdit }) {
  const cappedNote = person.total_pct > 110;
  return (
    <tr>
      <td className="pdp-td pdp-td-name">{person.rep_name || person.name}{extraLabel}</td>
      <CommissionBreakdownCells breakdown={person.breakdown} person={person} />
      <td className="pdp-td pdp-td-center pdp-bold">
        {person.total_pct.toFixed(1)}%
        {cappedNote && <div className="pdp-limit-hint" title="محدود بـ110% من العمولة المسجلة">→ {person.capped_pct.toFixed(1)}%</div>}
      </td>
      <td className={`pdp-td pdp-td-num${blurAmounts ? ' pdp-blur' : ''}`}>
        <input type="number" min="0" className="pdp-num-input" disabled={!canEdit}
          value={limitDraft ?? person.commission_limit ?? 0}
          onChange={e => onLimitChange(personType, personId, e.target.value)} />
      </td>
      <td className={`pdp-td pdp-td-num pdp-bold${blurAmounts ? ' pdp-blur' : ''}`}>{fmt(person.commission_amount)} ر.س</td>
    </tr>
  );
}

function CommissionsTab({ year, month, canEdit }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['commission-report', year, month],
    queryFn: () => client.get('/commissions/report', { params: { year, month } }).then(r => r.data),
    staleTime: 2 * 60 * 1000,
  });

  const [limitDrafts, setLimitDrafts] = useState({}); // { "rep-12": "5000" }
  const [saving, setSaving] = useState(false);
  const [blurAmounts, setBlurAmounts] = useState(true);
  const setLimitDraft = (personType, personId, val) => {
    setLimitDrafts(d => ({ ...d, [`${personType}-${personId}`]: val }));
  };

  const handleSaveLimits = async () => {
    const rows = Object.entries(limitDrafts).map(([key, val]) => {
      const [person_type, person_id] = key.split('-');
      return { person_type, person_id: Number(person_id), commission_limit: Number(val) || 0 };
    });
    if (!rows.length) return;
    setSaving(true);
    try {
      await client.put('/commissions/limits', rows);
      await qc.invalidateQueries({ queryKey: ['commission-report'] });
      setLimitDrafts({});
    } finally {
      setSaving(false);
    }
  };

  const reps = data?.reps || [];
  const managers = data?.managers || {};

  return (
    <div>
      <CommissionMethodologyPanel />
      <CommissionWeightsPanel canEdit={canEdit}/>

      {isLoading ? (
        <div className="pdp-loading"><RefreshCw size={24} className="pdp-spin"/> جارٍ تحميل بيانات العمولات…</div>
      ) : error ? (
        <div className="pdp-error">⚠️ خطأ في تحميل بيانات العمولات</div>
      ) : (
        <>
          <div className="pdp-comm-actions">
            {canEdit && (
              <button className="pdp-btn pdp-btn--refresh" onClick={handleSaveLimits} disabled={saving || !Object.keys(limitDrafts).length}>
                {saving ? 'جارٍ الحفظ…' : `حفظ حدود العمولة${Object.keys(limitDrafts).length ? ` (${Object.keys(limitDrafts).length})` : ''}`}
              </button>
            )}
            <button className="pdp-btn" onClick={() => setBlurAmounts(v => !v)}>
              {blurAmounts ? '👁️ إظهار حد وقيمة العمولة' : '🙈 تعتيم حد وقيمة العمولة'}
            </button>
          </div>

          {MANAGER_ROLE_ORDER.map(role => {
            const list = managers[role] || [];
            if (!list.length) return null;
            return (
              <div key={role} className="pdp-table-wrap pdp-comm-section">
                <div className="pdp-comm-section-title">👤 {MANAGER_ROLE_LABELS[role]}</div>
                <table className="pdp-table">
                  <thead>
                    <tr className="pdp-thead-row">
                      <th className="pdp-th pdp-th-name">الاسم</th>
                      {ITEM_ORDER.map(k => <th key={k} className="pdp-th pdp-th-num">{ITEM_SHORT_AR[k]}</th>)}
                      <th className="pdp-th pdp-th-center">الإجمالي %</th>
                      <th className="pdp-th pdp-th-num">حد العمولة</th>
                      <th className="pdp-th pdp-th-num">قيمة العمولة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map(m => (
                      <CommissionPersonRow key={m.manager_id} person={m} personType="manager" personId={m.manager_id}
                        extraLabel={<span className="pdp-muted"> ({m.reps_count} مندوب)</span>}
                        limitDraft={limitDrafts[`manager-${m.manager_id}`]}
                        onLimitChange={setLimitDraft} blurAmounts={blurAmounts} canEdit={canEdit} />
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}

          <div className="pdp-table-wrap pdp-comm-section">
            <div className="pdp-comm-section-title">🧑‍💼 المناديب</div>
            {!reps.length ? (
              <div className="pdp-empty">لا يوجد مناديب</div>
            ) : (
              <table className="pdp-table">
                <thead>
                  <tr className="pdp-thead-row">
                    <th className="pdp-th pdp-th-name">المندوب</th>
                    {ITEM_ORDER.map(k => <th key={k} className="pdp-th pdp-th-num">{ITEM_SHORT_AR[k]}</th>)}
                    <th className="pdp-th pdp-th-center">الإجمالي %</th>
                    <th className="pdp-th pdp-th-num">حد العمولة</th>
                    <th className="pdp-th pdp-th-num">قيمة العمولة</th>
                  </tr>
                </thead>
                <tbody>
                  {reps.map(rep => (
                    <CommissionPersonRow key={rep.rep_id} person={rep} personType="rep" personId={rep.rep_id}
                      extraLabel={rep.region_name ? <span className="pdp-muted"> · {rep.region_name}</span> : null}
                      limitDraft={limitDrafts[`rep-${rep.rep_id}`]}
                      onLimitChange={setLimitDraft} blurAmounts={blurAmounts} canEdit={canEdit} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
   MAIN PAGE
════════════════════════════════════════════════════════════════ */
export default function PerformanceDashboardPage() {
  const { user }    = useAuth();
  const isAdmin = user && ADMIN_ROLES.includes(user.role);
  const { perms } = usePermissions();
  const commissionsLevel  = user ? (perms?.commissions?.[user.role] ?? 0) : 0;
  const canViewCommissions = commissionsLevel > 0;
  const canEditCommissions = isAdmin || commissionsLevel >= 2;
  const [year, setYear]     = useState(CUR_YEAR);
  const [month, setMonth]   = useState(CUR_MONTH);
  const [regionId, setRegionId] = useState('');
  const [repId, setRepId]       = useState('');
  const [showSplitModal, setShowSplitModal] = useState(false);
  const [showCatSummary, setShowCatSummary] = useState(false);
  const [tab, setTab] = useState('performance'); // 'performance' | 'commissions'
  const [showCategoryBreakdown, setShowCategoryBreakdown] = useState(false);
  // Forces every RegionBlock/RepRow's expand state at once — { open, ts }
  // (ts changes on every click so the effect fires even for repeated clicks).
  const [bulkToggle, setBulkToggle] = useState(null);
  const expandAllRows   = () => setBulkToggle({ open: true,  ts: Date.now() });
  const collapseAllRows = () => setBulkToggle({ open: false, ts: Date.now() });

  // Font-size zoom for the matrix's numeric cells only (names/labels stay
  // fixed). Defaults above 1 for readability; the user's chosen zoom is
  // remembered across visits.
  const [numFontScale, setNumFontScale] = useState(() => {
    const saved = parseFloat(localStorage.getItem('pdp-num-scale'));
    return Number.isFinite(saved) && saved >= 0.7 && saved <= 1.6 ? saved : 1.25;
  });
  useEffect(() => { localStorage.setItem('pdp-num-scale', String(numFontScale)); }, [numFontScale]);
  const zoomInNums  = () => setNumFontScale(v => Math.min(1.6, +(v + 0.1).toFixed(1)));
  const zoomOutNums = () => setNumFontScale(v => Math.max(0.7, +(v - 0.1).toFixed(1)));

  const { data: regionList = [] } = useQuery({
    queryKey: ['pdp-regions'],
    queryFn: () => client.get('/users/regions').then(r => r.data),
    staleTime: 30 * 60 * 1000,
  });
  const { data: allReps = [] } = useQuery({
    queryKey: ['pdp-reps'],
    queryFn: () => client.get('/sales-reps').then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  // Rep dropdown narrows to the selected region (if any)
  const repOptions = regionId
    ? allReps.filter(r => String(r.region_id) === String(regionId))
    : allReps;

  const handleRegionChange = (val) => {
    setRegionId(val);
    // Clear rep selection if it no longer belongs to the newly selected region
    if (val && repId) {
      const stillValid = allReps.some(r => String(r.id) === String(repId) && String(r.region_id) === String(val));
      if (!stillValid) setRepId('');
    }
  };

  const params = new URLSearchParams({ year, month });
  if (regionId) params.set('region_id', regionId);
  if (repId)    params.set('rep_id', repId);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['performance-dashboard', year, month, regionId, repId],
    queryFn: () => client.get(`/performance-dashboard?${params.toString()}`).then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });

  // Shares its cache with CommissionsTab's own identical query (same
  // key) — used here only so the header export button can read it
  // regardless of which tab is active.
  const { data: commissionData } = useQuery({
    queryKey: ['commission-report', year, month],
    queryFn: () => client.get('/commissions/report', { params: { year, month } }).then(r => r.data),
    enabled: canViewCommissions && tab === 'commissions',
    staleTime: 2 * 60 * 1000,
  });

  const handlePrint = useCallback(() => {
    const prev = document.title;
    document.title = `أداء المناديب — ${data?.monthName || ''} ${year}`;
    window.print();
    window.onafterprint = () => { document.title = prev; window.onafterprint = null; };
  }, [data, year]);

  const kpi     = data?.kpi     || {};
  const regions = data?.regions || [];

  const handleExportCommissions = useCallback(() => {
    if (!commissionData) return;
    const wb = XLSX.utils.book_new();
    const header = [
      'المستوى', 'الاسم', 'المنطقة / عدد المناديب',
      ...ITEM_ORDER.map(k => ITEM_SHORT_AR[k]),
      'الإجمالي %', 'النسبة بعد حد 110%', 'حد العمولة', 'قيمة العمولة',
    ];

    const buildRows = (levelLabel, list, extraLabelFn) => list.map(p => ([
      levelLabel,
      p.rep_name || p.name,
      extraLabelFn(p),
      ...ITEM_ORDER.map(k => p.breakdown[k]?.earned_pct ?? 0),
      p.total_pct, p.capped_pct, p.commission_limit, p.commission_amount,
    ]));

    const rows = [];
    MANAGER_ROLE_ORDER.forEach(role => {
      const list = commissionData.managers?.[role] || [];
      if (!list.length) return;
      rows.push(...buildRows(MANAGER_ROLE_LABELS[role], list, m => `${m.reps_count} مندوب`));
    });
    rows.push(...buildRows('المناديب', commissionData.reps || [], r => r.region_name || ''));

    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws['!cols'] = header.map(() => ({ wch: 14 }));
    XLSX.utils.book_append_sheet(wb, ws, 'حساب العمولات');

    XLSX.writeFile(wb, `حساب_العمولات_${commissionData.month || month}_${commissionData.year || year}.xlsx`);
  }, [commissionData, month, year]);

  const handleExportPerformance = useCallback(() => {
    if (!data) return;
    const wb = XLSX.utils.book_new();

    const header = [
      'المنطقة', 'المندوب',
      'الكمية (حالي)', 'الكمية (سابق)', 'النمو %', 'هدف الكمية', '% تحقق الكمية',
      'عملاء (سابق)', 'عملاء (حالي)', 'عملاء جدد', 'هدف العملاء', 'فجوة العملاء', '% تحقق العملاء',
      'الحد الائتماني', 'الحد المسموح', 'المديونية القائمة', '% المديونية',
      'كمية التوالف', '% التوالف',
      'إجمالي الثلاجات', 'ثلاجات مغطاة', '% تغطية الثلاجات', 'كمية مبيعات الثلاجات', 'هدف الثلاجات', '% تحقق هدف الثلاجات',
      'التحصيل', 'هدف التحصيل', '% تحقق التحصيل',
      'الأداء المرجح %',
    ];

    const rows = [];
    regions.forEach(region => {
      region.reps.forEach(rep => {
        rows.push([
          region.region_name, rep.rep_name,
          rep.qty_mtd, rep.qty_prev, rep.qty_growth ?? '', rep.qty_target, rep.qty_achievement ?? '',
          rep.customers_prev, rep.customers_mtd, rep.new_customers_mtd, rep.customer_target, rep.customer_gap ?? '', rep.customer_achievement ?? '',
          rep.credit_limit, rep.max_allowed_debt ?? '', rep.outstanding_balance, rep.debt_pct ?? '',
          rep.damage_qty, rep.damage_pct ?? '',
          rep.fridges_total, rep.fridges_covered, rep.fridge_coverage_pct ?? '', rep.fridge_qty, rep.fridge_target, rep.fridge_target_achievement ?? '',
          rep.collected, rep.collection_target, rep.coll_achievement ?? '',
          rep.weighted_achievement ?? '',
        ]);
      });
      // Region subtotal row
      rows.push([
        region.region_name, `إجمالي ${region.region_name}`,
        region.qty_mtd, region.qty_prev, region.qty_growth ?? '', region.qty_target, region.qty_achievement ?? '',
        region.customers_prev, region.customers_mtd, region.new_customers_mtd, region.customer_target, region.customer_gap ?? '', region.customer_achievement ?? '',
        region.credit_limit, region.max_allowed_debt ?? '', region.outstanding_balance, region.debt_pct ?? '',
        region.damage_qty, region.damage_pct ?? '',
        region.fridges_total, region.fridges_covered, region.fridge_coverage_pct ?? '', region.fridge_qty, region.fridge_target, region.fridge_target_achievement ?? '',
        region.collected, region.collection_target, region.coll_achievement ?? '',
        region.weighted_achievement ?? '',
      ]);
    });
    // Grand total row
    rows.push([
      '', 'الإجمالي العام',
      kpi.total_qty_mtd, kpi.total_qty_prev, kpi.qty_growth ?? '', kpi.total_qty_target, kpi.overall_qty_achievement ?? '',
      kpi.total_customers_prev, kpi.total_customers, kpi.total_new_customers, kpi.total_customer_target, '', '',
      kpi.total_credit_limit, '', kpi.total_balance, kpi.overall_debt_pct ?? '',
      kpi.total_damage_qty, kpi.overall_damage_pct ?? '',
      kpi.total_fridges, kpi.total_fridges_covered, kpi.overall_fridge_coverage_pct ?? '', kpi.total_fridge_qty, kpi.total_fridge_target, kpi.overall_fridge_target_achievement ?? '',
      kpi.total_collected, kpi.total_collection_target, kpi.overall_coll_achievement ?? '',
      kpi.weighted_achievement ?? '',
    ]);

    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws['!cols'] = header.map(() => ({ wch: 14 }));
    XLSX.utils.book_append_sheet(wb, ws, 'أداء المناديب');
    XLSX.writeFile(wb, `أداء_المناديب_${data.monthName || ''}_${year}.xlsx`);
  }, [data, regions, kpi, year]);

  const handleExport = useCallback(() => {
    if (tab === 'commissions') handleExportCommissions();
    else handleExportPerformance();
  }, [tab, handleExportCommissions, handleExportPerformance]);

  const years   = [CUR_YEAR - 1, CUR_YEAR, CUR_YEAR + 1];

  const noData = !isLoading && regions.length === 0;

  return (
    <div className="pdp-page">

      {/* Print header */}
      <div className="pdp-print-header">
        <span>📊</span>
        <span>أداء المناديب — {data?.monthName} {year}</span>
        <span>{new Date().toLocaleDateString('ar-SA-u-nu-latn',{year:'numeric',month:'long',day:'numeric'})}</span>
      </div>

      {/* Page header */}
      <div className="pdp-header pdp-no-print">
        <div>
          <h1 className="pdp-title">📊 داشبورد أداء المناديب</h1>
          <p className="pdp-subtitle">الكميات · العملاء · التحصيل · المديونية — مقارنة بالأهداف</p>
        </div>
        <div className="pdp-header-actions">
          <select className="pdp-select" value={month} onChange={e => setMonth(Number(e.target.value))}>
            {MONTHS.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
          </select>
          <select className="pdp-select" value={year} onChange={e => setYear(Number(e.target.value))}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <select className="pdp-select" value={regionId} onChange={e => handleRegionChange(e.target.value)}>
            <option value="">كل المناطق</option>
            {regionList.map(r => <option key={r.id} value={r.id}>{r.name_ar || r.name_en}</option>)}
          </select>
          <select className="pdp-select" value={repId} onChange={e => setRepId(e.target.value)}>
            <option value="">كل المناديب</option>
            {repOptions.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
          </select>
          <button className="pdp-btn pdp-btn--refresh" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw size={14} className={isFetching ? 'pdp-spin' : ''}/> تحديث
          </button>
          <button className="pdp-btn pdp-btn--print" onClick={handlePrint}>
            <Printer size={14}/> PDF
          </button>
          <button className="pdp-btn pdp-btn--refresh" onClick={handleExport} disabled={tab === 'commissions' ? !commissionData : !data}>
            <FileSpreadsheet size={14}/> تصدير Excel
          </button>
          {isAdmin && (
            <button className="pdp-btn" onClick={() => setShowSplitModal(true)}>
              <Settings size={14}/> توزيع الهدف حسب الفئة
            </button>
          )}
          <button className="pdp-btn" onClick={() => setShowCategoryBreakdown(v => !v)}>
            {showCategoryBreakdown ? '🙈 إخفاء توزيع الفئات' : '👁️ إظهار توزيع الفئات'}
          </button>
          <button className="pdp-btn" onClick={expandAllRows}>⊞ توسيع الكل</button>
          <button className="pdp-btn" onClick={collapseAllRows}>⊟ ضم الكل</button>
          <div className="pdp-font-zoom">
            <button className="pdp-btn pdp-font-zoom-btn" onClick={zoomOutNums} disabled={numFontScale <= 0.7} title="تصغير حجم الأرقام">A-</button>
            <button className="pdp-btn pdp-font-zoom-btn" onClick={zoomInNums} disabled={numFontScale >= 1.6} title="تكبير حجم الأرقام">A+</button>
          </div>
        </div>
      </div>

      {showSplitModal && (
        <CategorySplitModal
          onClose={() => setShowSplitModal(false)}
          regionList={regionList}
          repList={allReps}
        />
      )}

      {canViewCommissions && (
        <div className="pdp-tabs pdp-no-print">
          <button className={`pdp-tab-btn${tab === 'performance' ? ' pdp-tab-btn--active' : ''}`} onClick={() => setTab('performance')}>
            📊 الأداء
          </button>
          <button className={`pdp-tab-btn${tab === 'commissions' ? ' pdp-tab-btn--active' : ''}`} onClick={() => setTab('commissions')}>
            💰 حساب العمولات
          </button>
        </div>
      )}

      {tab === 'commissions' && canViewCommissions ? (
        <CommissionsTab year={year} month={month} canEdit={canEditCommissions} />
      ) : (
      <>
      {/* Error */}
      {error && <div className="pdp-error">⚠️ خطأ في تحميل البيانات</div>}

      {/* KPI row */}
      {!noData && (
        <div className="pdp-kpi-row">
          <KpiCard icon={<TrendingUp size={20}/>} label="إجمالي الكمية MTD"
            value={isLoading ? '…' : fmt(kpi.total_qty_mtd)}
            sub={kpi.qty_growth !== null ? `النمو: ${fmtP(kpi.qty_growth)}` : undefined}
            color="#1d4ed8"/>
          <KpiCard icon={<Target size={20}/>} label="الهدف الإجمالي"
            value={isLoading ? '…' : fmt(kpi.total_qty_target)}
            sub={kpi.overall_qty_achievement !== null ? `التحقق: ${fmtP(kpi.overall_qty_achievement)}` : undefined}
            color="#059669"/>
          <KpiCard icon={<Users size={20}/>} label="العملاء النشطين"
            value={isLoading ? '…' : fmt(kpi.total_customers)}
            sub={[
              kpi.total_customer_target ? `الهدف: ${fmt(kpi.total_customer_target)}` : null,
              kpi.total_new_customers   ? `${kpi.total_new_customers} جديد` : null,
            ].filter(Boolean).join(' · ') || undefined}
            color="#7c3aed"/>
          <KpiCard icon={<Wallet size={20}/>} label="إجمالي التحصيل"
            value={isLoading ? '…' : `${fmt(kpi.total_collected)} ر.س`}
            sub={kpi.overall_coll_achievement !== null
              ? `من الهدف: ${fmtP(kpi.overall_coll_achievement)} (${fmt(kpi.total_collection_target)} ر.س)`
              : undefined}
            color="#0891b2"/>
          <KpiCard icon={<MapPin size={20}/>} label="المناطق النشطة"
            value={isLoading ? '…' : kpi.regions_count}
            sub={`${kpi.reps_count} مندوب`}
            color="#d97706"/>
          <KpiCard icon={<BarChart2 size={20}/>} label="إجمالي المديونية"
            value={isLoading ? '…' : `${fmt(kpi.total_balance)} ر.س`}
            sub={kpi.overall_debt_pct !== null
              ? `${fmtP(kpi.overall_debt_pct)} من السقف${kpi.reps_exceeded_limit ? ` · ${kpi.reps_exceeded_limit} تجاوز الحد` : ''}`
              : undefined}
            color="#dc2626"/>
        </div>
      )}

      {/* Note about data source */}
      {!isLoading && !error && (
        <div className="pdp-note pdp-no-print">
          ℹ️ البيانات مبنية على تقارير العملاء المرفوعة في النظام · الأهداف مُدخَلة من صفحة&nbsp;
          <a href="/rep-management" className="pdp-link">إدارة المناديب</a>
        </div>
      )}

      {/* Company-wide category breakdown */}
      {!noData && showCategoryBreakdown && data?.category_breakdown?.length > 0 && (
        <div className="pdp-cat-summary pdp-no-print">
          <button className="pdp-cat-summary-toggle" onClick={() => setShowCatSummary(v => !v)}>
            {showCatSummary ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
            توزيع إجمالي الكمية حسب فئة العميل (كل المناديب)
          </button>
          {showCatSummary && (
            <div className="pdp-cat-wrap">
              <CategoryBreakdownTable rows={data.category_breakdown} />
            </div>
          )}
        </div>
      )}

      {/* Main Table */}
      <div className="pdp-table-wrap" style={{ '--pdp-num-scale': numFontScale }}>
        {isLoading ? (
          <div className="pdp-loading"><RefreshCw size={24} className="pdp-spin"/> جارٍ تحميل البيانات…</div>
        ) : noData ? (
          <div className="pdp-empty">
            <div style={{fontSize:'2.5rem', marginBottom:12}}>📋</div>
            <div>لا يوجد مناديب مسجّلون بعد</div>
            <div className="pdp-empty-hint">أضف مناديب من <a href="/rep-management" className="pdp-link">صفحة إدارة المناديب</a> ثم حدد أهدافهم الشهرية</div>
          </div>
        ) : (
          <table className="pdp-table">
            <thead>
              <tr className="pdp-thead-row">
                <th className="pdp-th pdp-th-name">المنطقة / المندوب</th>
                <th className="pdp-th pdp-th-num">الكمية<br/><span className="pdp-th-sub">الشهر الحالي</span></th>
                <th className="pdp-th pdp-th-num">الكمية<br/><span className="pdp-th-sub">الشهر الماضي</span></th>
                <th className="pdp-th pdp-th-num">النمو</th>
                <th className="pdp-th pdp-th-num">الهدف</th>
                <th className="pdp-th pdp-th-center">% التحقق<br/><span className="pdp-th-sub">كمية</span></th>
                <th className="pdp-th pdp-th-num">عملاء<br/><span className="pdp-th-sub">سابق</span></th>
                <th className="pdp-th pdp-th-num">عملاء<br/><span className="pdp-th-sub">حالي</span></th>
                <th className="pdp-th pdp-th-num">هدف<br/><span className="pdp-th-sub">عملاء</span></th>
                <th className="pdp-th pdp-th-num">فجوة<br/><span className="pdp-th-sub">عملاء</span></th>
                <th className="pdp-th pdp-th-center">% التحقق<br/><span className="pdp-th-sub">عملاء</span></th>
                <th className="pdp-th pdp-th-num">الحد<br/><span className="pdp-th-sub">الائتماني</span></th>
                <th className="pdp-th pdp-th-num">المديونية<br/><span className="pdp-th-sub">القائمة</span></th>
                <th className="pdp-th pdp-th-num">% المديونية<br/><span className="pdp-th-sub">الحد = 110% من السقف</span></th>
                <th className="pdp-th pdp-th-num">التوالف<br/><span className="pdp-th-sub">الحد المسموح 0.5%</span></th>
                <th className="pdp-th pdp-th-num">تغطية الثلاجات<br/><span className="pdp-th-sub">عدد مغطى / إجمالي · هدف الكمية</span></th>
                <th className="pdp-th pdp-th-center">الأداء<br/><span className="pdp-th-sub">المرجح</span></th>
              </tr>
            </thead>
            <tbody>
              {regions.map((region, i) => <RegionBlock key={region.region_name} region={region} rank={i} showCategoryBreakdown={showCategoryBreakdown} bulkToggle={bulkToggle}/>)}
            </tbody>
            <tfoot>
              <tr className="pdp-tfoot-row">
                <td className="pdp-td pdp-bold">الإجمالي</td>
                <td className="pdp-td pdp-td-num pdp-bold">
                  {fmt(kpi.total_qty_mtd)}
                  <ItemCatBreakdown rows={kpi.item_qty_breakdown} field="qty"/>
                </td>
                <td className="pdp-td pdp-td-num">{fmt(kpi.total_qty_prev)}</td>
                <td className="pdp-td pdp-td-num"><GrowthBadge pct={kpi.qty_growth}/></td>
                <td className="pdp-td pdp-td-num">
                  {fmt(kpi.total_qty_target)}
                  <ItemCatBreakdown rows={kpi.item_qty_breakdown} field="target"/>
                </td>
                <td className="pdp-td pdp-td-center">
                  <AchBadge pct={kpi.overall_qty_achievement}/>
                  <PenaltyBadge penaltyPct={kpi.qty_penalty_pct} reasons={kpi.qty_penalty_reasons}/>
                  <MinQtyThresholdBadge qtyAch={kpi.overall_qty_achievement}/>
                  <ItemCatBreakdown rows={kpi.item_qty_breakdown} field="achievement"/>
                </td>
                <td className="pdp-td pdp-td-num">{fmt(kpi.total_customers_prev)}</td>
                <td className="pdp-td pdp-td-num pdp-bold">
                  {fmt(kpi.total_customers)}
                  {kpi.total_new_customers > 0 && <span className="pdp-new-cust">+{kpi.total_new_customers} جديد</span>}
                </td>
                <td className="pdp-td pdp-td-num">{fmt(kpi.total_customer_target)}</td>
                <td className="pdp-td pdp-td-num">{kpi.total_customer_target ? fmt(kpi.total_customer_target - kpi.total_customers) : '—'}</td>
                <td className="pdp-td pdp-td-center">
                  <AchBadge pct={kpi.total_customer_target > 0 ? +((kpi.total_customers / kpi.total_customer_target) * 100).toFixed(1) : null}/>
                </td>
                <td className="pdp-td pdp-td-num">{fmt(kpi.total_credit_limit)}</td>
                <td className="pdp-td pdp-td-num">{fmt(kpi.total_balance)}</td>
                <td className="pdp-td pdp-td-num">
                  {kpi.overall_debt_pct !== null
                    ? <span className={kpi.overall_debt_pct > 110 ? 'pdp-debt-exceeded' : 'pdp-debt-ok'}>
                        {kpi.overall_debt_pct > 110 && <AlertTriangle size={12} style={{marginLeft:3, verticalAlign:'middle'}}/>}
                        {fmtP(kpi.overall_debt_pct)}
                      </span>
                    : '—'}
                </td>
                <td className="pdp-td pdp-td-num">
                  <DamageCell qty={kpi.total_damage_qty} pct={kpi.overall_damage_pct} exceeded={kpi.overall_damage_pct > (kpi.damage_target_pct ?? 0.5)}/>
                  {kpi.reps_damage_exceeded > 0 && <span className="pdp-debt-reps-count"> ({kpi.reps_damage_exceeded})</span>}
                </td>
                <td className="pdp-td pdp-td-num">
                  <FridgeCoverageCell
                    total={kpi.total_fridges} covered={kpi.total_fridges_covered} coveragePct={kpi.overall_fridge_coverage_pct}
                    target={kpi.total_fridge_target} qty={kpi.total_fridge_qty} targetAch={kpi.overall_fridge_target_achievement}
                  />
                </td>
                <td className="pdp-td pdp-td-center"><AchBadge pct={kpi.weighted_achievement}/></td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
      </>
      )}

    </div>
  );
}
