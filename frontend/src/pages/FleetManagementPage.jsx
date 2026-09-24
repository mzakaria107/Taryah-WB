/**
 * FleetManagementPage — full fleet management: vehicle master (seeded
 * from sales_reps.vehicle_number, plus manually-added transport/farm
 * trucks), weekly odometer readings, a per-vehicle maintenance schedule
 * with due/overdue alerts computed from odometer deltas, a maintenance
 * history log, and expense tracking. See 104_fleet_management.sql and
 * backend/src/routes/fleet.js for the schema/API this page drives.
 *
 * One central fleet coordinator updates every vehicle's odometer weekly
 * (product decision — not self-service per rep), so there is no
 * per-vehicle ownership gate on the frontend: access is controlled
 * entirely by the existing page_permissions level for 'fleet_management'
 * (view vs edit), same as every other page in the app.
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import client from '../api/client';
import { useAuth } from '../context/AuthContext';
import './FleetManagementPage.css';

/* Vehicle categories (تصنيفات السيارات) and expense line items (بنود
   المصروفات) used to be hardcoded here — they're now admin-editable rows
   fetched from /fleet/vehicle-categories and /fleet/expense-categories
   (settings tab below), same DB-backed pattern as maintenance types.
   `toOptions` turns a categories row list into the {value,label} shape
   every select/labelOf call in this file already expects, so nothing
   downstream needs to change shape. `pickableOptions` is for pickers
   where the user is choosing a category for something NEW (add vehicle,
   add expense) — deactivated categories are hidden there, but a record's
   OWN current value stays selectable even if it was deactivated after the
   fact (`currentKey`), so editing an old vehicle never shows a blank/
   silently-reset select. Plain `toOptions` (no filtering) is used for
   filter dropdowns and labelOf lookups, where a deactivated category must
   still be findable/label-able for whatever already used it. */
const toOptions = (categories) => (categories || []).map(c => ({ value: c.key, label: c.name_ar, is_active: c.is_active }));
const pickableOptions = (categories, currentKey) => {
  const opts = toOptions(categories);
  const active = opts.filter(o => o.is_active);
  if (currentKey && !active.some(o => o.value === currentKey)) {
    const cur = opts.find(o => o.value === currentKey);
    if (cur) return [...active, cur];
  }
  return active;
};
const ASSIGNMENT_OPTIONS = [
  { value: 'rep',                  label: 'مندوب' },
  { value: 'region_transport',     label: 'نقل بضاعة لمنطقة' },
  { value: 'farm_slaughterhouse',  label: 'نقل بضاعة لمزرعة/مسلخ' },
  { value: 'unassigned',           label: 'غير مخصصة' },
];
const STATUS_OPTIONS = [
  { value: 'active',        label: 'نشطة' },
  { value: 'in_maintenance',label: 'في الصيانة' },
  { value: 'inactive',      label: 'متوقفة' },
  { value: 'sold',          label: 'مُباعة' },
];
const labelOf = (opts, v) => opts.find(o => o.value === v)?.label || v || '—';
// Small colored "light" (dot + glow) for vehicle status — one distinct color
// per status (see .flt-status--* in the CSS) so the الحالة column reads at a
// glance. Falls back to the plain label if the status isn't one of the four
// known values (shouldn't happen, but avoids an unstyled/undefined class).
const StatusLight = ({ status }) => {
  const known = STATUS_OPTIONS.some(o => o.value === status);
  if (!known) return <span>{labelOf(STATUS_OPTIONS, status)}</span>;
  return (
    <span className={`flt-status flt-status--${status}`}>
      <span className="flt-status__dot" />
      {labelOf(STATUS_OPTIONS, status)}
    </span>
  );
};
const fmt = (n, d = 0) => (n == null || isNaN(Number(n))) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
// Deleting a vehicle is irreversible (cascades its whole odometer/
// maintenance/expense history) — restricted to admins, tighter than the
// page's normal edit level that fleet_supervisor also holds. Same
// ADMIN_ROLES list the backend's DELETE /vehicles/:id now enforces; this
// is just the UI-side mirror (hide the button) — the API call is still
// the actual gate.
const ADMIN_ROLES = ['super_admin', 'it_admin'];

export default function FleetManagementPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = ADMIN_ROLES.includes(user?.role);
  const [activeTab, setActiveTab] = useState('overview');

  /* ══════════════ Overview / dashboard ══════════════ */
  const { data: dash, isLoading: dashLoading } = useQuery({
    queryKey: ['fleet-dashboard'],
    queryFn: () => client.get('/fleet/dashboard').then(r => r.data),
    staleTime: 60 * 1000,
  });

  /* ══════════════ Vehicles list ══════════════ */
  const [filterCategory, setFilterCategory] = useState('');
  const [filterAssignment, setFilterAssignment] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterRegion, setFilterRegion] = useState('');
  const [search, setSearch] = useState('');

  const { data: vehiclesData, isLoading: vehiclesLoading, refetch: refetchVehicles } = useQuery({
    queryKey: ['fleet-vehicles', filterCategory, filterAssignment, filterStatus, filterRegion, search],
    queryFn: () => client.get('/fleet/vehicles', {
      params: {
        category: filterCategory || undefined,
        assignment_type: filterAssignment || undefined,
        status: filterStatus || undefined,
        region_id: filterRegion || undefined,
        search: search || undefined,
      },
    }).then(r => r.data),
    staleTime: 30 * 1000,
  });

  /* Full region list (unrestricted — see GET /fleet/regions) for the
     region filter and the manual region select on non-rep vehicles. */
  const { data: regionsData } = useQuery({
    queryKey: ['fleet-regions'],
    queryFn: () => client.get('/fleet/regions').then(r => r.data),
    staleTime: 10 * 60 * 1000,
  });
  const regions = regionsData?.regions || [];

  const refreshAll = useCallback(() => {
    refetchVehicles();
    qc.invalidateQueries({ queryKey: ['fleet-dashboard'] });
    qc.invalidateQueries({ queryKey: ['fleet-vehicle'] });
  }, [refetchVehicles, qc]);

  /* ── Excel bulk import/export (سيارات + قراءات عداد) ──
     "تنزيل نموذج" pulls a FRESH full snapshot from the backend (not the
     on-screen `vehicles` list, which can be narrowed by the toolbar
     filters) so the template always covers every registered vehicle
     regardless of what's currently filtered on screen, pre-filled with
     Arabic labels the /import endpoint parses right back — an admin who
     doesn't touch a cell re-uploads the same value, which is how "only
     change what I actually edited" works for a spreadsheet with no
     partial-update concept of its own. */
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const fileInputRef = useRef(null);

  const handleDownloadTemplate = async () => {
    const { data } = await client.get('/fleet/import/template-data');
    const catLabel = key => data.category_labels?.[key] || key || '';
    const vehRows = data.vehicles.map(v => ({
      'رقم اللوحة':          v.plate_number,
      'التصنيف':             v.category ? catLabel(v.category) : '',
      'نوع التخصيص':          labelOf(ASSIGNMENT_OPTIONS, v.assignment_type),
      'اسم المندوب':          v.assigned_rep_name || '',
      'وصف الجهة':            v.assignment_label || '',
      'اسم السائق':           v.driver_name || '',
      'المنطقة':              v.region_name || '',
      'الشركة المصنّعة':      v.make || '',
      'الموديل':              v.model || '',
      'سنة الصنع':            v.model_year || '',
      'الحالة':               labelOf(STATUS_OPTIONS, v.status),
      'العداد الحالي (كم)':   v.current_odometer_km ?? 0,
      'ملاحظات':              v.notes || '',
    }));
    const wsVeh = XLSX.utils.json_to_sheet(vehRows);
    const odoRows = data.vehicles.map(v => ({
      'رقم اللوحة':            v.plate_number,
      'تاريخ القراءة':          '',
      'قراءة العداد (كم)':      '',
    }));
    const wsOdo = XLSX.utils.json_to_sheet(odoRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsVeh, 'السيارات');
    XLSX.utils.book_append_sheet(wb, wsOdo, 'قراءات العداد');
    XLSX.writeFile(wb, `نموذج_أسطول_السيارات_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const handleImportFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await client.post('/fleet/import', fd);
      setImportResult(r.data);
      refreshAll();
    } catch (err) {
      setImportResult({ error: err?.response?.data?.error || 'خطأ في رفع الملف' });
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  };

  /* Registered-reps list — for the "اختر مندوب" dropdown, so a rep-owned
     vehicle is always linked by a real assigned_rep_id (FK to
     sales_reps), never a free-text name that could drift out of sync. */
  const { data: repsData } = useQuery({
    queryKey: ['fleet-reps'],
    queryFn: () => client.get('/fleet/reps').then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });
  const reps = repsData?.reps || [];

  /* ── Add vehicle form ── */
  const [showAddForm, setShowAddForm] = useState(false);
  const emptyForm = {
    plate_number: '', category: '', assignment_type: 'unassigned',
    assigned_rep_id: '', assignment_label: '', driver_name: '', region_id: '',
    make: '', model: '', current_odometer_km: '',
  };
  const [addForm, setAddForm] = useState(emptyForm);
  const [addError, setAddError] = useState('');
  const [adding, setAdding] = useState(false);

  const handleAddVehicle = async () => {
    if (!addForm.plate_number.trim()) { setAddError('رقم اللوحة مطلوب'); return; }
    if (addForm.assignment_type === 'rep' && !addForm.assigned_rep_id) {
      setAddError('يجب اختيار المندوب من القائمة'); return;
    }
    setAdding(true); setAddError('');
    try {
      await client.post('/fleet/vehicles', {
        ...addForm,
        category: addForm.category || null,
        current_odometer_km: addForm.current_odometer_km ? Number(addForm.current_odometer_km) : 0,
      });
      setAddForm(emptyForm);
      setShowAddForm(false);
      refreshAll();
    } catch (err) {
      setAddError(err?.response?.data?.error || 'حدث خطأ أثناء إضافة السيارة');
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteVehicle = async (v) => {
    if (!window.confirm(`حذف السيارة (${v.plate_number}) نهائياً؟ سيتم حذف كل سجلاتها (عداد/صيانة/مصاريف).`)) return;
    try {
      await client.delete(`/fleet/vehicles/${v.id}`);
      if (expandedVehicleId === v.id) setExpandedVehicleId(null);
      refreshAll();
    } catch (err) {
      window.alert(err?.response?.data?.error || 'حدث خطأ أثناء حذف السيارة');
    }
  };

  /* ── Inline category classification — the fastest way to work through
     the batch of "غير مصنّفة" vehicles seeded from sales_reps.vehicle_number
     is a dropdown right in the list row, rather than opening each
     vehicle's full profile just to set one field. ── */
  const [savingCategoryId, setSavingCategoryId] = useState(null);
  const handleUpdateCategory = async (v, category) => {
    setSavingCategoryId(v.id);
    try {
      await client.put(`/fleet/vehicles/${v.id}`, { category: category || null });
      refreshAll();
    } catch (err) {
      window.alert(err?.response?.data?.error || 'حدث خطأ أثناء تعديل التصنيف');
    } finally {
      setSavingCategoryId(null);
    }
  };

  /* ── Expandable vehicle profile ── */
  const [expandedVehicleId, setExpandedVehicleId] = useState(null);
  const toggleExpand = (id) => setExpandedVehicleId(cur => cur === id ? null : id);

  /* ══════════════ Maintenance types (settings) ══════════════ */
  const { data: typesData, refetch: refetchTypes } = useQuery({
    queryKey: ['fleet-maintenance-types'],
    queryFn: () => client.get('/fleet/maintenance-types').then(r => r.data),
    staleTime: 60 * 1000,
  });
  const [newType, setNewType] = useState({ name: '', category: '', default_interval_km: '' });
  const [typeError, setTypeError] = useState('');

  const handleAddType = async () => {
    if (!newType.name.trim() || !newType.default_interval_km) { setTypeError('الاسم والفترة الافتراضية مطلوبان'); return; }
    setTypeError('');
    try {
      await client.post('/fleet/maintenance-types', {
        name: newType.name.trim(), category: newType.category || null,
        default_interval_km: Number(newType.default_interval_km),
      });
      setNewType({ name: '', category: '', default_interval_km: '' });
      refetchTypes();
    } catch (err) {
      setTypeError(err?.response?.data?.error || 'حدث خطأ أثناء إضافة نوع الصيانة');
    }
  };
  const handleUpdateType = async (id, patch) => {
    try { await client.put(`/fleet/maintenance-types/${id}`, patch); refetchTypes(); refreshAll(); }
    catch (err) { window.alert(err?.response?.data?.error || 'حدث خطأ أثناء التعديل'); }
  };

  /* ══════════════ Vehicle categories (settings) ══════════════ */
  const { data: vehicleCatsData, refetch: refetchVehicleCats } = useQuery({
    queryKey: ['fleet-vehicle-categories'],
    queryFn: () => client.get('/fleet/vehicle-categories').then(r => r.data),
    staleTime: 60 * 1000,
  });
  const vehicleCategories = vehicleCatsData?.categories || [];
  const [newVehicleCatName, setNewVehicleCatName] = useState('');
  const [vehicleCatError, setVehicleCatError] = useState('');

  const handleAddVehicleCategory = async () => {
    if (!newVehicleCatName.trim()) { setVehicleCatError('اسم التصنيف مطلوب'); return; }
    setVehicleCatError('');
    try {
      await client.post('/fleet/vehicle-categories', { name_ar: newVehicleCatName.trim() });
      setNewVehicleCatName('');
      refetchVehicleCats();
    } catch (err) {
      setVehicleCatError(err?.response?.data?.error || 'حدث خطأ أثناء إضافة التصنيف');
    }
  };
  const handleUpdateVehicleCategory = async (key, patch) => {
    try { await client.put(`/fleet/vehicle-categories/${key}`, patch); refetchVehicleCats(); refreshAll(); }
    catch (err) { window.alert(err?.response?.data?.error || 'حدث خطأ أثناء التعديل'); }
  };
  const handleDeleteVehicleCategory = async (c) => {
    if (!window.confirm(`حذف تصنيف "${c.name_ar}" نهائياً؟`)) return;
    try { await client.delete(`/fleet/vehicle-categories/${c.key}`); refetchVehicleCats(); refreshAll(); }
    catch (err) { window.alert(err?.response?.data?.error || 'حدث خطأ أثناء الحذف'); }
  };

  /* ══════════════ Expense line items (settings) ══════════════ */
  const { data: expenseCatsData, refetch: refetchExpenseCats } = useQuery({
    queryKey: ['fleet-expense-categories'],
    queryFn: () => client.get('/fleet/expense-categories').then(r => r.data),
    staleTime: 60 * 1000,
  });
  const expenseCategories = expenseCatsData?.categories || [];
  const [newExpenseCatName, setNewExpenseCatName] = useState('');
  const [expenseCatError, setExpenseCatError] = useState('');

  const handleAddExpenseCategory = async () => {
    if (!newExpenseCatName.trim()) { setExpenseCatError('اسم البند مطلوب'); return; }
    setExpenseCatError('');
    try {
      await client.post('/fleet/expense-categories', { name_ar: newExpenseCatName.trim() });
      setNewExpenseCatName('');
      refetchExpenseCats();
    } catch (err) {
      setExpenseCatError(err?.response?.data?.error || 'حدث خطأ أثناء إضافة البند');
    }
  };
  const handleUpdateExpenseCategory = async (key, patch) => {
    try { await client.put(`/fleet/expense-categories/${key}`, patch); refetchExpenseCats(); }
    catch (err) { window.alert(err?.response?.data?.error || 'حدث خطأ أثناء التعديل'); }
  };
  const handleDeleteExpenseCategory = async (c) => {
    if (!window.confirm(`حذف بند "${c.name_ar}" نهائياً؟`)) return;
    try { await client.delete(`/fleet/expense-categories/${c.key}`); refetchExpenseCats(); }
    catch (err) { window.alert(err?.response?.data?.error || 'حدث خطأ أثناء الحذف'); }
  };

  /* ══════════════ Spare parts catalog (settings) ══════════════
     Same add/edit shape as the two catalogs above, but ~250 rows instead
     of a handful — the settings list itself gets a search box too
     (the pickers' own search — MaintenancePartsPicker/ExpensePartsPicker —
     is for the LOGGING forms; this one is for finding a row to
     edit/deactivate/توريد here). */
  const { data: sparePartsData, refetch: refetchSpareParts } = useQuery({
    queryKey: ['fleet-spare-parts'],
    queryFn: () => client.get('/fleet/spare-parts').then(r => r.data),
    staleTime: 60 * 1000,
  });
  const spareParts = sparePartsData?.parts || [];
  const [newPartName, setNewPartName] = useState('');
  const [partError, setPartError] = useState('');
  const [partSettingsSearch, setPartSettingsSearch] = useState('');

  /* أرصدة قطع الغيار tab — recent supply movements across EVERY part, for
     the "جرد" (inventory) view's own audit trail (per-part history already
     exists via GET /spare-parts/:id/supplies, but a fleet coordinator
     reviewing the whole store needs the combined feed, not 249 separate
     lookups). */
  const { data: recentSuppliesData } = useQuery({
    queryKey: ['fleet-part-supplies'],
    queryFn: () => client.get('/fleet/part-supplies').then(r => r.data),
    enabled: activeTab === 'parts_inventory',
    staleTime: 30 * 1000,
  });
  const recentSupplies = recentSuppliesData?.supplies || [];

  // حذف سجل توريد بالكامل (e.g. مدخل خطأ/تجريبي) — يعكس أثره على الرصيد
  // الحالي تلقائيًا قبل حذفه، بخلاف "تصفير" اللي يصفّر الرصيد فقط ويُبقي
  // سجل التوريد نفسه كما هو.
  const [deletingSupplyId, setDeletingSupplyId] = useState(null);
  const handleDeleteSupply = async (s) => {
    const ok = window.confirm(`حذف سجل توريد "${s.part_name}" (${fmt(s.quantity)} × ${fmt(s.unit_cost, 2)} ر.س بتاريخ ${s.supply_date}) نهائياً؟ سيتم خصم هذه الكمية من الرصيد الحالي تلقائياً.`);
    if (!ok) return;
    setDeletingSupplyId(s.id);
    try {
      await client.delete(`/fleet/part-supplies/${s.id}`);
      refetchSpareParts();
      qc.invalidateQueries({ queryKey: ['fleet-part-supplies'] });
    } catch (err) {
      window.alert(err?.response?.data?.error || 'حدث خطأ أثناء حذف سجل التوريد');
    } finally {
      setDeletingSupplyId(null);
    }
  };

  const handleAddPart = async () => {
    if (!newPartName.trim()) { setPartError('اسم القطعة مطلوب'); return; }
    setPartError('');
    try {
      await client.post('/fleet/spare-parts', { name_ar: newPartName.trim() });
      setNewPartName('');
      refetchSpareParts();
    } catch (err) {
      setPartError(err?.response?.data?.error || 'حدث خطأ أثناء إضافة القطعة');
    }
  };
  const handleUpdatePart = async (id, patch) => {
    try { await client.put(`/fleet/spare-parts/${id}`, patch); refetchSpareParts(); }
    catch (err) { window.alert(err?.response?.data?.error || 'حدث خطأ أثناء التعديل'); }
  };
  const filteredSettingsParts = partSettingsSearch.trim()
    ? spareParts.filter(p => p.name_ar.toLowerCase().includes(partSettingsSearch.trim().toLowerCase()))
    : spareParts;

  // Exports exactly what's on screen (respects the active search box), same
  // columns/order as the الأصناف table — "نشط" and "الرصيد" as plain
  // Arabic/number values rather than a checkbox icon so the sheet reads
  // correctly on its own outside the app.
  const handleExportSpareParts = () => {
    const header = ['الاسم', 'نشط', 'الرصيد الحالي', 'آخر سعر توريد', 'قيمة الرصيد'];
    const rows = filteredSettingsParts.map(p => [
      p.name_ar,
      p.is_active ? 'نعم' : 'لا',
      Number(p.qty_on_hand) || 0,
      p.last_unit_cost != null ? Number(p.last_unit_cost) : '—',
      p.last_unit_cost != null ? Math.max(0, Number(p.qty_on_hand)) * Number(p.last_unit_cost) : '—',
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws['!cols'] = header.map((_, i) => ({ wch: i === 0 ? 28 : 16 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'أرصدة قطع الغيار');
    XLSX.writeFile(wb, `أرصدة_قطع_الغيار_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  /* ── أمر توريد أرصدة مخزون (per-part supply order) — inline form opened
     from that part's row in the settings table below. */
  const [supplyOpenId, setSupplyOpenId] = useState(null);
  const [supplyForm, setSupplyForm] = useState({ quantity: '', unit_cost: '', supply_date: '', notes: '' });
  const [supplySaving, setSupplySaving] = useState(false);
  const [supplyError, setSupplyError] = useState('');

  const openSupplyForm = (id) => {
    setSupplyOpenId(id);
    setSupplyForm({ quantity: '', unit_cost: '', supply_date: '', notes: '' });
    setSupplyError('');
  };
  const submitSupply = async () => {
    if (!supplyForm.quantity || Number(supplyForm.quantity) <= 0) { setSupplyError('الكمية الموردة مطلوبة ويجب أن تكون أكبر من صفر'); return; }
    setSupplySaving(true); setSupplyError('');
    try {
      await client.post(`/fleet/spare-parts/${supplyOpenId}/supply`, supplyForm);
      setSupplyOpenId(null);
      refetchSpareParts();
      qc.invalidateQueries({ queryKey: ['fleet-part-supplies'] });
    } catch (err) {
      setSupplyError(err?.response?.data?.error || 'حدث خطأ أثناء تسجيل أمر التوريد');
    } finally {
      setSupplySaving(false);
    }
  };

  // تصفير الرصيد — irreversible, admin-only (backend enforces this too;
  // the frontend gate here just keeps the button from being offered to
  // someone it would only 403 for).
  const [resettingPartId, setResettingPartId] = useState(null);
  const handleResetStock = async (part) => {
    const ok = window.confirm(`تصفير رصيد "${part.name_ar}" إلى 0؟ الرصيد الحالي: ${fmt(part.qty_on_hand)}. لا يمكن التراجع عن هذا الإجراء.`);
    if (!ok) return;
    setResettingPartId(part.id);
    try {
      await client.post(`/fleet/spare-parts/${part.id}/reset-stock`);
      refetchSpareParts();
    } catch (err) {
      window.alert(err?.response?.data?.error || 'حدث خطأ أثناء تصفير الرصيد');
    } finally {
      setResettingPartId(null);
    }
  };

  const CATEGORY_OPTIONS = toOptions(vehicleCategories);
  const EXPENSE_CATEGORY_OPTIONS = toOptions(expenseCategories);

  const vehicles = vehiclesData?.vehicles || [];

  return (
    <div className="flt-page">
      <div className="flt-header">
        <h1>🚚 إدارة أسطول السيارات</h1>
        <p className="flt-subtitle">بروفايل كل سيارة، قراءات العداد الأسبوعية، جدول الصيانة الدورية مع التنبيهات، وسجل المصاريف.</p>
      </div>

      <div className="flt-tabs">
        {[
          ['overview', 'نظرة عامة'],
          ['vehicles', 'قائمة السيارات'],
          ['reports', 'التقارير'],
          ['parts_inventory', 'أرصدة قطع الغيار'],
          ['settings', 'إعدادات الصيانة'],
        ].map(([k, l]) => (
          <button key={k} className={`flt-tab${activeTab === k ? ' flt-tab--active' : ''}`} onClick={() => setActiveTab(k)}>{l}</button>
        ))}
      </div>

      {/* ══════════════ TAB: Overview ══════════════ */}
      {activeTab === 'overview' && (
        <div className="flt-tab-content">
          {dashLoading && <div className="flt-loading">جاري التحميل…</div>}
          {dash && (
            <>
              <div className="flt-kpi-row">
                <div className="flt-kpi"><div className="flt-kpi__label">إجمالي السيارات</div><div className="flt-kpi__value">{fmt(dash.totals.total)}</div></div>
                <div className="flt-kpi"><div className="flt-kpi__label">نشطة</div><div className="flt-kpi__value">{fmt(dash.totals.active)}</div></div>
                <div className="flt-kpi"><div className="flt-kpi__label">في الصيانة</div><div className="flt-kpi__value">{fmt(dash.totals.in_maintenance)}</div></div>
                <div className="flt-kpi"><div className="flt-kpi__label">غير مصنّفة</div><div className="flt-kpi__value">{fmt(dash.totals.unclassified)}</div></div>
                <div className="flt-kpi flt-kpi--warn"><div className="flt-kpi__label">لم يُحدَّث عدادها &gt; 7 أيام</div><div className="flt-kpi__value">{fmt(dash.stale_odometer.length)}</div></div>
                <div className="flt-kpi flt-kpi--danger"><div className="flt-kpi__label">تنبيهات صيانة مستحقة</div><div className="flt-kpi__value">{fmt(dash.maintenance_alerts.length)}</div></div>
              </div>

              <div className="flt-card">
                <div className="flt-card__title">التوزيع حسب التصنيف</div>
                <div className="flt-bar-list">
                  {dash.by_category.map(c => (
                    <div className="flt-bar-row" key={c.category}>
                      <span className="flt-bar-label">{c.category === 'unclassified' ? 'غير مصنّفة' : labelOf(CATEGORY_OPTIONS, c.category)}</span>
                      <span className="flt-bar-value">{c.n}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flt-card flt-card--warn">
                <div className="flt-card__title">⚠️ سيارات لم يُحدَّث عدادها منذ أكثر من أسبوع</div>
                {!dash.stale_odometer.length ? <div className="flt-empty">كل السيارات محدَّثة ✅</div> : (
                  <div className="flt-table-wrap">
                    <table className="flt-table">
                      <thead><tr><th>رقم اللوحة</th><th>التصنيف</th><th>مخصصة لـ</th><th>آخر تحديث</th><th>عدد الأيام</th></tr></thead>
                      <tbody>
                        {dash.stale_odometer.map(v => (
                          <tr key={v.id}>
                            <td className="flt-td-bold">{v.plate_number}</td>
                            <td>{labelOf(CATEGORY_OPTIONS, v.category)}</td>
                            <td>{v.assigned_rep_name || v.assignment_label || '—'}</td>
                            <td>{v.odometer_updated_at || 'لم يُسجَّل بعد'}</td>
                            <td className="flt-td-num flt-danger-text">{v.days_since_update ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="flt-card flt-card--danger">
                <div className="flt-card__title">🔧 تنبيهات الصيانة (مستحقة أو قريبة الاستحقاق)</div>
                {!dash.maintenance_alerts.length ? <div className="flt-empty">لا توجد صيانات مستحقة حالياً ✅</div> : (
                  <div className="flt-table-wrap">
                    <table className="flt-table">
                      <thead><tr><th>رقم اللوحة</th><th>نوع الصيانة</th><th>الحالة</th><th>منذ آخر خدمة</th><th>الفترة</th><th>متأخر بـ</th></tr></thead>
                      <tbody>
                        {dash.maintenance_alerts.map((a, i) => (
                          <tr key={i}>
                            <td className="flt-td-bold">{a.plate_number}</td>
                            <td>{a.type_name}</td>
                            <td>{a.alert_level === 'overdue'
                              ? <span className="flt-badge flt-badge--danger">متأخرة</span>
                              : <span className="flt-badge flt-badge--warn">قريبة الاستحقاق</span>}</td>
                            <td className="flt-td-num">{fmt(a.km_since_service)} كم</td>
                            <td className="flt-td-num">{fmt(a.interval_km)} كم</td>
                            <td className="flt-td-num">{a.km_overdue_by > 0 ? `${fmt(a.km_overdue_by)} كم` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="flt-card">
                <div className="flt-card__title">مصاريف الشهر الحالي حسب التصنيف</div>
                {!dash.month_expenses.length ? <div className="flt-empty">لا توجد مصاريف مسجلة هذا الشهر</div> : (
                  <div className="flt-bar-list">
                    {dash.month_expenses.map(e => (
                      <div className="flt-bar-row" key={e.category}>
                        <span className="flt-bar-label">{labelOf(EXPENSE_CATEGORY_OPTIONS, e.category)}</span>
                        <span className="flt-bar-value">{fmt(e.total, 2)} ر.س</span>
                      </div>
                    ))}
                    <div className="flt-bar-row flt-bar-row--total">
                      <span className="flt-bar-label">الإجمالي</span>
                      <span className="flt-bar-value">{fmt(dash.month_expenses.reduce((s, e) => s + Number(e.total), 0), 2)} ر.س</span>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ══════════════ TAB: Vehicles ══════════════ */}
      {activeTab === 'vehicles' && (
        <div className="flt-tab-content">
          <div className="flt-card">
            <div className="flt-filters">
              <div className="flt-field">
                <label>بحث</label>
                <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="رقم اللوحة، المندوب، أو الجهة…" />
              </div>
              <div className="flt-field">
                <label>التصنيف</label>
                <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
                  <option value="">الكل</option>
                  {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="flt-field">
                <label>التخصيص</label>
                <select value={filterAssignment} onChange={e => setFilterAssignment(e.target.value)}>
                  <option value="">الكل</option>
                  {ASSIGNMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="flt-field">
                <label>الحالة</label>
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                  <option value="">الكل</option>
                  {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="flt-field">
                <label>المنطقة</label>
                <select value={filterRegion} onChange={e => setFilterRegion(e.target.value)}>
                  <option value="">الكل</option>
                  {regions.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
                </select>
              </div>
              <button type="button" className="flt-btn flt-btn--primary" onClick={() => setShowAddForm(s => !s)}>
                {showAddForm ? '✖️ إلغاء' : '➕ إضافة سيارة'}
              </button>
              <button type="button" className="flt-btn flt-btn--outline" onClick={handleDownloadTemplate}>
                ⬇️ تنزيل نموذج Excel
              </button>
              <button type="button" className="flt-btn flt-btn--outline" disabled={importing} onClick={() => fileInputRef.current?.click()}>
                {importing ? 'جارٍ الرفع…' : '⬆️ رفع ملف Excel'}
              </button>
              <input
                ref={fileInputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
                onChange={handleImportFile}
              />
            </div>

            {importResult && (
              <div className={`flt-import-result${importResult.error ? ' flt-import-result--error' : ''}`}>
                {importResult.error ? (
                  <div className="flt-error">{importResult.error}</div>
                ) : (
                  <>
                    <div className="flt-import-summary">
                      🚗 السيارات: {importResult.vehicles.created} سيارة جديدة، {importResult.vehicles.updated} تم تحديثها
                      {' · '}📏 قراءات العداد: {importResult.odometer.created} قراءة مسجّلة
                      <button type="button" className="flt-btn flt-btn--outline flt-btn--sm" onClick={() => setImportResult(null)}>إغلاق</button>
                    </div>
                    {(importResult.vehicles.errors.length > 0 || importResult.odometer.errors.length > 0) && (
                      <ul className="flt-import-errors">
                        {importResult.vehicles.errors.map((e, i) => <li key={`v${i}`}>{e}</li>)}
                        {importResult.odometer.errors.map((e, i) => <li key={`o${i}`}>{e}</li>)}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}

            {showAddForm && (
              <div className="flt-add-form">
                <div className="flt-filters">
                  <div className="flt-field"><label>رقم اللوحة *</label><input type="text" value={addForm.plate_number} onChange={e => setAddForm(f => ({ ...f, plate_number: e.target.value }))} /></div>
                  <div className="flt-field">
                    <label>التصنيف</label>
                    <select value={addForm.category} onChange={e => setAddForm(f => ({ ...f, category: e.target.value }))}>
                      <option value="">غير مصنّفة</option>
                      {pickableOptions(vehicleCategories).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div className="flt-field">
                    <label>التخصيص</label>
                    <select value={addForm.assignment_type} onChange={e => setAddForm(f => ({ ...f, assignment_type: e.target.value }))}>
                      {ASSIGNMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  {addForm.assignment_type === 'rep' ? (
                    <>
                      <div className="flt-field">
                        <label>المندوب *</label>
                        <select value={addForm.assigned_rep_id} onChange={e => setAddForm(f => ({ ...f, assigned_rep_id: e.target.value }))}>
                          <option value="">— اختر من القائمة المسجلة —</option>
                          {reps.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
                        </select>
                      </div>
                      <div className="flt-field">
                        <label>المنطقة</label>
                        <div className="flt-region-derived">تُحدَّد تلقائيًا حسب منطقة المندوب الحالية</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flt-field"><label>وصف الجهة</label><input type="text" value={addForm.assignment_label} onChange={e => setAddForm(f => ({ ...f, assignment_label: e.target.value }))} placeholder="مثال: نقل بضاعة - منطقة الرياض" /></div>
                      <div className="flt-field"><label>اسم السائق (اختياري)</label><input type="text" value={addForm.driver_name} onChange={e => setAddForm(f => ({ ...f, driver_name: e.target.value }))} /></div>
                      <div className="flt-field">
                        <label>المنطقة</label>
                        <select value={addForm.region_id} onChange={e => setAddForm(f => ({ ...f, region_id: e.target.value }))}>
                          <option value="">— بدون —</option>
                          {regions.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
                        </select>
                      </div>
                    </>
                  )}
                  <div className="flt-field"><label>النوع (الشركة المصنّعة)</label><input type="text" value={addForm.make} onChange={e => setAddForm(f => ({ ...f, make: e.target.value }))} placeholder="مثال: Isuzu" /></div>
                  <div className="flt-field"><label>الموديل</label><input type="text" value={addForm.model} onChange={e => setAddForm(f => ({ ...f, model: e.target.value }))} placeholder="مثال: NPR 2022" /></div>
                  <div className="flt-field"><label>قراءة العداد الحالية</label><input type="number" value={addForm.current_odometer_km} onChange={e => setAddForm(f => ({ ...f, current_odometer_km: e.target.value }))} /></div>
                  <button type="button" className="flt-btn flt-btn--primary" disabled={adding} onClick={handleAddVehicle}>{adding ? 'جارٍ الحفظ…' : '💾 حفظ'}</button>
                </div>
                {addError && <div className="flt-error">{addError}</div>}
              </div>
            )}
          </div>

          <div className="flt-card">
            {vehiclesLoading && <div className="flt-loading">جاري التحميل…</div>}
            {!vehiclesLoading && !vehicles.length && <div className="flt-empty">لا توجد سيارات مطابقة</div>}
            {!vehiclesLoading && vehicles.length > 0 && (
              <div className="flt-table-wrap flt-table-wrap--scroll-tall">
                <table className="flt-table">
                  <thead>
                    <tr>
                      <th></th><th>رقم اللوحة</th><th>التصنيف</th><th>مخصصة لـ</th><th>المنطقة</th><th>الحالة</th>
                      <th>العداد الحالي</th><th>آخر تحديث</th><th>تنبيهات صيانة</th><th>ملاحظات</th><th>إجراءات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vehicles.map(v => (
                      <React.Fragment key={v.id}>
                        <tr className="flt-row" onClick={() => toggleExpand(v.id)}>
                          <td className="flt-toggle">{expandedVehicleId === v.id ? '▾' : '▸'}</td>
                          <td className="flt-td-bold">{v.plate_number}</td>
                          <td onClick={e => e.stopPropagation()}>
                            <select
                              className="flt-inline-select"
                              value={v.category || ''}
                              disabled={savingCategoryId === v.id}
                              onChange={e => handleUpdateCategory(v, e.target.value)}
                            >
                              <option value="">غير مصنّفة</option>
                              {pickableOptions(vehicleCategories, v.category).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          </td>
                          <td>
                            {v.assigned_rep_name
                              || [v.assignment_label, v.driver_name && `السائق: ${v.driver_name}`].filter(Boolean).join(' — ')
                              || '—'}
                          </td>
                          <td>{v.region_name || '—'}</td>
                          <td><StatusLight status={v.status} /></td>
                          <td className="flt-td-num">{fmt(v.current_odometer_km)} كم</td>
                          <td>{v.odometer_updated_at || 'لم يُسجَّل'}</td>
                          <td>{v.overdue_maintenance_count > 0
                            ? <span className="flt-badge flt-badge--danger">{v.overdue_maintenance_count}</span>
                            : <span className="flt-badge flt-badge--ok">0</span>}</td>
                          <td className="flt-td-notes" title={v.notes || ''}>{v.notes || '—'}</td>
                          <td onClick={e => e.stopPropagation()}>
                            {isAdmin
                              ? <button type="button" className="flt-btn flt-btn--outline flt-btn--sm" onClick={() => handleDeleteVehicle(v)}>🗑️</button>
                              : '—'}
                          </td>
                        </tr>
                        {expandedVehicleId === v.id && (
                          <tr className="flt-detail-row">
                            <td colSpan={11}>
                              <VehicleProfile vehicleId={v.id} onChanged={refreshAll} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════ TAB: Reports ══════════════ */}
      {activeTab === 'reports' && (
        <FleetReportsTab regions={regions} vehicleCategories={vehicleCategories} />
      )}

      {/* ══════════════ TAB: Maintenance settings ══════════════ */}
      {activeTab === 'settings' && (
        <div className="flt-tab-content">
          <div className="flt-card">
            <div className="flt-card__title">أنواع الصيانة والفترات الافتراضية (بالكيلومتر)</div>
            <p className="flt-hint">هذه القيم افتراضية قابلة للتعديل — تُستخدم كنقطة بداية عند إضافة سيارة جديدة، ويمكن تخصيص الفترة لكل سيارة بشكل مستقل من بروفايلها.</p>
            <div className="flt-table-wrap">
              <table className="flt-table">
                <thead><tr><th>الاسم</th><th>التصنيف المستهدف</th><th>الفترة الافتراضية (كم)</th><th>نشط</th></tr></thead>
                <tbody>
                  {(typesData?.types || []).map(t => (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td>{t.category ? labelOf(CATEGORY_OPTIONS, t.category) : 'كل التصنيفات'}</td>
                      <td>
                        <input
                          type="number" className="flt-inline-input" defaultValue={t.default_interval_km}
                          onBlur={e => { const v = Number(e.target.value); if (v && v !== Number(t.default_interval_km)) handleUpdateType(t.id, { default_interval_km: v }); }}
                        /> كم
                      </td>
                      <td>
                        <input type="checkbox" checked={t.is_active} onChange={e => handleUpdateType(t.id, { is_active: e.target.checked })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flt-add-form">
              <div className="flt-filters">
                <div className="flt-field"><label>اسم نوع صيانة جديد</label><input type="text" value={newType.name} onChange={e => setNewType(f => ({ ...f, name: e.target.value }))} /></div>
                <div className="flt-field">
                  <label>التصنيف المستهدف</label>
                  <select value={newType.category} onChange={e => setNewType(f => ({ ...f, category: e.target.value }))}>
                    <option value="">كل التصنيفات</option>
                    {pickableOptions(vehicleCategories).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="flt-field"><label>الفترة الافتراضية (كم)</label><input type="number" value={newType.default_interval_km} onChange={e => setNewType(f => ({ ...f, default_interval_km: e.target.value }))} /></div>
                <button type="button" className="flt-btn flt-btn--primary" onClick={handleAddType}>➕ إضافة</button>
              </div>
              {typeError && <div className="flt-error">{typeError}</div>}
            </div>
          </div>

          <div className="flt-settings-grid">
            <div className="flt-card">
              <div className="flt-card__title">تصنيفات السيارات</div>
              <p className="flt-hint">تظهر هذه التصنيفات في كل قوائم اختيار التصنيف بالصفحة (إضافة/تعديل سيارة، الفلاتر، أنواع الصيانة). إلغاء تفعيل تصنيف لا يحذفه — يبقى ظاهراً للسيارات المصنَّفة به مسبقاً، لكنه يختفي من قوائم الاختيار عند إضافة تصنيف جديد.</p>
              <div className="flt-table-wrap">
                <table className="flt-table">
                  <thead><tr><th>الاسم</th><th>نشط</th><th></th></tr></thead>
                  <tbody>
                    {vehicleCategories.map(c => (
                      <tr key={c.key}>
                        <td>
                          <input
                            type="text" className="flt-inline-input" defaultValue={c.name_ar}
                            onBlur={e => { const v = e.target.value.trim(); if (v && v !== c.name_ar) handleUpdateVehicleCategory(c.key, { name_ar: v }); }}
                          />
                        </td>
                        <td>
                          <input type="checkbox" checked={c.is_active} onChange={e => handleUpdateVehicleCategory(c.key, { is_active: e.target.checked })} />
                        </td>
                        <td>
                          <button type="button" className="flt-btn flt-btn--outline flt-btn--sm flt-btn--danger" onClick={() => handleDeleteVehicleCategory(c)}>🗑️ حذف</button>
                        </td>
                      </tr>
                    ))}
                    {!vehicleCategories.length && <tr><td colSpan={3} className="flt-empty">لا توجد تصنيفات بعد</td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="flt-add-form">
                <div className="flt-filters">
                  <div className="flt-field"><label>اسم تصنيف جديد</label><input type="text" value={newVehicleCatName} onChange={e => setNewVehicleCatName(e.target.value)} placeholder="مثال: سيارة 7 طن" /></div>
                  <button type="button" className="flt-btn flt-btn--primary" onClick={handleAddVehicleCategory}>➕ إضافة</button>
                </div>
                {vehicleCatError && <div className="flt-error">{vehicleCatError}</div>}
              </div>
            </div>

            <div className="flt-card">
              <div className="flt-card__title">بنود المصروفات</div>
              <p className="flt-hint">تظهر هذه البنود في نموذج تسجيل مصروف جديد لأي سيارة. إلغاء تفعيل بند لا يحذفه — المصاريف المسجَّلة عليه سابقاً تبقى كما هي، لكنه يختفي من قائمة الاختيار عند تسجيل مصروف جديد.</p>
              <div className="flt-table-wrap">
                <table className="flt-table">
                  <thead><tr><th>الاسم</th><th>نشط</th><th></th></tr></thead>
                  <tbody>
                    {expenseCategories.map(c => (
                      <tr key={c.key}>
                        <td>
                          <input
                            type="text" className="flt-inline-input" defaultValue={c.name_ar}
                            onBlur={e => { const v = e.target.value.trim(); if (v && v !== c.name_ar) handleUpdateExpenseCategory(c.key, { name_ar: v }); }}
                          />
                        </td>
                        <td>
                          <input type="checkbox" checked={c.is_active} onChange={e => handleUpdateExpenseCategory(c.key, { is_active: e.target.checked })} />
                        </td>
                        <td>
                          <button type="button" className="flt-btn flt-btn--outline flt-btn--sm flt-btn--danger" onClick={() => handleDeleteExpenseCategory(c)}>🗑️ حذف</button>
                        </td>
                      </tr>
                    ))}
                    {!expenseCategories.length && <tr><td colSpan={3} className="flt-empty">لا توجد بنود بعد</td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="flt-add-form">
                <div className="flt-filters">
                  <div className="flt-field"><label>اسم بند مصروف جديد</label><input type="text" value={newExpenseCatName} onChange={e => setNewExpenseCatName(e.target.value)} placeholder="مثال: مخالفات مرورية" /></div>
                  <button type="button" className="flt-btn flt-btn--primary" onClick={handleAddExpenseCategory}>➕ إضافة</button>
                </div>
                {expenseCatError && <div className="flt-error">{expenseCatError}</div>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════ TAB: أرصدة قطع الغيار (جرد) ══════════════ */}
      {activeTab === 'parts_inventory' && (
        <div className="flt-tab-content">
          <div className="flt-kpi-row">
            <div className="flt-kpi"><div className="flt-kpi__label">عدد الأصناف</div><div className="flt-kpi__value">{fmt(spareParts.length)}</div></div>
            <div className="flt-kpi"><div className="flt-kpi__label">أصناف نشطة</div><div className="flt-kpi__value">{fmt(spareParts.filter(p => p.is_active).length)}</div></div>
            <div className="flt-kpi flt-kpi--warn"><div className="flt-kpi__label">أصناف بدون رصيد</div><div className="flt-kpi__value">{fmt(spareParts.filter(p => Number(p.qty_on_hand) === 0).length)}</div></div>
            <div className="flt-kpi flt-kpi--danger"><div className="flt-kpi__label">أصناف برصيد سالب</div><div className="flt-kpi__value">{fmt(spareParts.filter(p => Number(p.qty_on_hand) < 0).length)}</div></div>
            <div className="flt-kpi"><div className="flt-kpi__label">إجمالي الكميات بالمخزون</div><div className="flt-kpi__value">{fmt(spareParts.reduce((s, p) => s + Math.max(0, Number(p.qty_on_hand)), 0))}</div></div>
            <div className="flt-kpi flt-kpi--warn"><div className="flt-kpi__label">القيمة التقديرية للمخزون</div><div className="flt-kpi__value">{fmt(spareParts.reduce((s, p) => s + Math.max(0, Number(p.qty_on_hand)) * Number(p.last_unit_cost || 0), 0), 2)} ر.س</div></div>
          </div>
          <p className="flt-hint">القيمة التقديرية = مجموع (الرصيد الموجب × آخر سعر توريد مسجَّل لكل صنف) — الأصناف بدون سعر توريد مسجَّل تُحتسب بقيمة صفر.</p>

          <div className="flt-card">
            <div className="flt-card__title-row">
              <div className="flt-card__title">قطع الغيار ({fmt(spareParts.length)})</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  type="text" className="flt-inline-input" placeholder="بحث عن قطعة…"
                  value={partSettingsSearch} onChange={e => setPartSettingsSearch(e.target.value)}
                  style={{ maxWidth: 220 }}
                />
                <button type="button" className="flt-btn flt-btn--sm" onClick={handleExportSpareParts} disabled={!filteredSettingsParts.length}>
                  ⬇️ تصدير Excel
                </button>
              </div>
            </div>
            <p className="flt-hint">
              تظهر هذه القطع كاختيار متعدد قابل للبحث عند تسجيل صيانة أو مصروف لأي سيارة — اختيار قطعة
              الغيار اختياري دائماً. إلغاء تفعيل قطعة لا يحذفها — السجلات المرتبطة بها سابقاً تبقى كما
              هي، لكنها تختفي من قائمة الاختيار عند تسجيل جديد. "الرصيد الحالي" يزيد بأوامر التوريد
              ويقل تلقائياً عند اختيار القطعة ضمن صيانة منفَّذة أو مصروف لأي سيارة.
            </p>
            <div className="flt-table-wrap flt-table-wrap--scroll">
              <table className="flt-table">
                <thead><tr><th>الاسم</th><th>نشط</th><th>الرصيد الحالي</th><th>آخر سعر توريد</th><th>قيمة الرصيد</th><th></th></tr></thead>
                <tbody>
                  {filteredSettingsParts.map(p => (
                    <React.Fragment key={p.id}>
                      <tr>
                        <td>
                          <input
                            type="text" className="flt-inline-input" defaultValue={p.name_ar}
                            onBlur={e => { const v = e.target.value.trim(); if (v && v !== p.name_ar) handleUpdatePart(p.id, { name_ar: v }); }}
                          />
                        </td>
                        <td>
                          <input type="checkbox" checked={p.is_active} onChange={e => handleUpdatePart(p.id, { is_active: e.target.checked })} />
                        </td>
                        <td className={`flt-td-num${Number(p.qty_on_hand) < 0 ? ' flt-danger-text' : ''}`}>{fmt(p.qty_on_hand)}</td>
                        <td className="flt-td-num">{p.last_unit_cost != null ? `${fmt(p.last_unit_cost, 2)} ر.س` : '—'}</td>
                        <td className="flt-td-num">{p.last_unit_cost != null ? `${fmt(Math.max(0, Number(p.qty_on_hand)) * Number(p.last_unit_cost), 2)} ر.س` : '—'}</td>
                        <td>
                          <button type="button" className="flt-btn flt-btn--outline flt-btn--sm" onClick={() => openSupplyForm(supplyOpenId === p.id ? null : p.id)}>
                            📦 توريد
                          </button>
                          {isAdmin && (
                            <button
                              type="button" className="flt-btn flt-btn--outline flt-btn--sm flt-btn--danger"
                              disabled={resettingPartId === p.id || Number(p.qty_on_hand) === 0}
                              onClick={() => handleResetStock(p)}
                              title="تصفير الرصيد (أدمن فقط)"
                            >
                              {resettingPartId === p.id ? '⏳' : '🔄 تصفير'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {supplyOpenId === p.id && (
                        <tr>
                          <td colSpan={6}>
                            <div className="flt-add-form">
                              <div className="flt-filters">
                                <div className="flt-field"><label>الكمية الموردة</label><input type="number" step="1" min="1" value={supplyForm.quantity} onChange={e => setSupplyForm(f => ({ ...f, quantity: e.target.value }))} /></div>
                                <div className="flt-field"><label>سعر الوحدة (ر.س)</label><input type="number" step="0.01" value={supplyForm.unit_cost} onChange={e => setSupplyForm(f => ({ ...f, unit_cost: e.target.value }))} /></div>
                                <div className="flt-field"><label>تاريخ التوريد</label><input type="date" value={supplyForm.supply_date} onChange={e => setSupplyForm(f => ({ ...f, supply_date: e.target.value }))} /></div>
                                <div className="flt-field"><label>ملاحظات</label><input type="text" value={supplyForm.notes} onChange={e => setSupplyForm(f => ({ ...f, notes: e.target.value }))} /></div>
                                <button type="button" className="flt-btn flt-btn--primary" disabled={supplySaving} onClick={submitSupply}>{supplySaving ? '⏳' : '💾 حفظ أمر التوريد'}</button>
                                <button type="button" className="flt-btn flt-btn--outline" onClick={() => setSupplyOpenId(null)}>إلغاء</button>
                              </div>
                              {supplyError && <div className="flt-error">{supplyError}</div>}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                  {!filteredSettingsParts.length && <tr><td colSpan={6} className="flt-empty">{partSettingsSearch ? 'لا توجد نتائج' : 'لا توجد قطع بعد'}</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="flt-add-form">
              <div className="flt-filters">
                <div className="flt-field"><label>اسم قطعة غيار جديدة</label><input type="text" value={newPartName} onChange={e => setNewPartName(e.target.value)} placeholder="مثال: فلتر هواء" /></div>
                <button type="button" className="flt-btn flt-btn--primary" onClick={handleAddPart}>➕ إضافة</button>
              </div>
              {partError && <div className="flt-error">{partError}</div>}
            </div>
          </div>

          <div className="flt-card">
            <div className="flt-card__title">📜 آخر عمليات التوريد (كل الأصناف)</div>
            <div className="flt-table-wrap flt-table-wrap--scroll">
              <table className="flt-table">
                <thead><tr><th>التاريخ</th><th>القطعة</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th><th>ملاحظات</th><th>بواسطة</th><th></th></tr></thead>
                <tbody>
                  {!recentSupplies.length && <tr><td colSpan={8} className="flt-empty">لا توجد عمليات توريد مسجَّلة بعد</td></tr>}
                  {recentSupplies.map(s => (
                    <tr key={s.id}>
                      <td>{s.supply_date}</td><td>{s.part_name}</td>
                      <td className="flt-td-num">{fmt(s.quantity)}</td>
                      <td className="flt-td-num">{fmt(s.unit_cost, 2)} ر.س</td>
                      <td className="flt-td-num flt-td-bold">{fmt(s.total_cost, 2)} ر.س</td>
                      <td>{s.notes || '—'}</td><td>{s.created_by_name || '—'}</td>
                      <td>
                        <button
                          type="button" className="flt-btn flt-btn--outline flt-btn--sm flt-btn--danger"
                          disabled={deletingSupplyId === s.id}
                          onClick={() => handleDeleteSupply(s)}
                        >
                          {deletingSupplyId === s.id ? '⏳' : '🗑️ حذف'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   VehicleProfile — the expanded detail panel for one vehicle: its
   maintenance schedule (with due/overdue status), quick-entry forms for
   odometer/maintenance/expense, and recent history tables.
════════════════════════════════════════════════════════════ */
function VehicleProfile({ vehicleId, onChanged }) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['fleet-vehicle', vehicleId],
    queryFn: () => client.get(`/fleet/vehicles/${vehicleId}`).then(r => r.data),
  });

  /* Same query key as the "اختر مندوب" dropdown on the add-vehicle form —
     React Query dedupes/caches this, so opening several vehicle profiles
     doesn't re-fetch the reps list every time. */
  const { data: repsData } = useQuery({
    queryKey: ['fleet-reps'],
    queryFn: () => client.get('/fleet/reps').then(r => r.data),
    staleTime: 5 * 60 * 1000,
  });
  const reps = repsData?.reps || [];

  const { data: regionsData } = useQuery({
    queryKey: ['fleet-regions'],
    queryFn: () => client.get('/fleet/regions').then(r => r.data),
    staleTime: 10 * 60 * 1000,
  });
  const regions = regionsData?.regions || [];

  /* Same query keys as the settings tab's category tables — shared cache,
     so editing categories there is reflected here without a separate fetch. */
  const { data: vehicleCatsData } = useQuery({
    queryKey: ['fleet-vehicle-categories'],
    queryFn: () => client.get('/fleet/vehicle-categories').then(r => r.data),
    staleTime: 60 * 1000,
  });
  const vehicleCategories = vehicleCatsData?.categories || [];
  const CATEGORY_OPTIONS = toOptions(vehicleCategories);

  const { data: expenseCatsData } = useQuery({
    queryKey: ['fleet-expense-categories'],
    queryFn: () => client.get('/fleet/expense-categories').then(r => r.data),
    staleTime: 60 * 1000,
  });
  const expenseCategories = expenseCatsData?.categories || [];
  const EXPENSE_CATEGORY_OPTIONS = toOptions(expenseCategories);

  const { data: sparePartsData } = useQuery({
    queryKey: ['fleet-spare-parts'],
    queryFn: () => client.get('/fleet/spare-parts').then(r => r.data),
    staleTime: 60 * 1000,
  });
  const spareParts = sparePartsData?.parts || [];

  /* ── Edit vehicle master fields — this is the ONLY place the 35
     vehicles seeded (unclassified, no make/model, only a plate + rep
     link) from sales_reps.vehicle_number can get their full profile
     filled in: plate number, category, assignment (rep picker / driver
     name), make, model, status, notes. Reuses the same PUT the inline
     category dropdown uses, sending the full set of fields together —
     the partial-update backend only touches what's present, so this is
     safe even though it sends more keys than that single-field call. ── */
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const openEdit = () => {
    const v = data.vehicle;
    setEditForm({
      plate_number: v.plate_number || '',
      category: v.category || '',
      assignment_type: v.assignment_type || 'unassigned',
      assigned_rep_id: v.assigned_rep_id || '',
      assignment_label: v.assignment_label || '',
      driver_name: v.driver_name || '',
      region_id: v.region_id || '', // only meaningful when assignment_type !== 'rep' — see backend
      make: v.make || '',
      model: v.model || '',
      model_year: v.model_year || '',
      status: v.status || 'active',
      notes: v.notes || '',
    });
    setEditError('');
    setShowEdit(true);
  };

  const submitEdit = async () => {
    if (!editForm.plate_number.trim()) { setEditError('رقم اللوحة مطلوب'); return; }
    if (editForm.assignment_type === 'rep' && !editForm.assigned_rep_id) {
      setEditError('يجب اختيار المندوب من القائمة'); return;
    }
    setEditSaving(true); setEditError('');
    try {
      await client.put(`/fleet/vehicles/${vehicleId}`, editForm);
      setShowEdit(false);
      refetch(); onChanged?.();
    } catch (err) {
      setEditError(err?.response?.data?.error || 'حدث خطأ أثناء حفظ بيانات السيارة');
    } finally {
      setEditSaving(false);
    }
  };

  const [odoForm, setOdoForm] = useState({ reading_km: '', reading_date: '' });
  const [odoSaving, setOdoSaving] = useState(false);
  const [odoError, setOdoError] = useState('');
  const submitOdo = async () => {
    if (!odoForm.reading_km) { setOdoError('قراءة العداد مطلوبة'); return; }
    setOdoSaving(true); setOdoError('');
    try {
      await client.post(`/fleet/vehicles/${vehicleId}/odometer`, odoForm);
      setOdoForm({ reading_km: '', reading_date: '' });
      refetch(); onChanged?.();
    } catch (err) { setOdoError(err?.response?.data?.error || 'خطأ في تسجيل القراءة'); }
    finally { setOdoSaving(false); }
  };

  const [maintForm, setMaintForm] = useState({ maintenance_type_id: '', odometer_km: '', cost: '', vendor: '', notes: '', service_date: '', parts_used: [] });
  const [maintSaving, setMaintSaving] = useState(false);
  const [maintError, setMaintError] = useState('');
  const submitMaint = async () => {
    if (!maintForm.maintenance_type_id || !maintForm.odometer_km) { setMaintError('نوع الصيانة وقراءة العداد مطلوبان'); return; }
    setMaintSaving(true); setMaintError('');
    try {
      const res = await client.post(`/fleet/vehicles/${vehicleId}/maintenance`, maintForm);
      setMaintForm({ maintenance_type_id: '', odometer_km: '', cost: '', vendor: '', notes: '', service_date: '', parts_used: [] });
      refetch(); onChanged?.();
      if (res.data?.warnings?.length) window.alert(res.data.warnings.join('\n'));
    } catch (err) { setMaintError(err?.response?.data?.error || 'خطأ في تسجيل الصيانة'); }
    finally { setMaintSaving(false); }
  };

  const [expForm, setExpForm] = useState({ category: 'fuel', amount: '', notes: '', expense_date: '', parts_used: [] });
  const [expSaving, setExpSaving] = useState(false);
  const [expError, setExpError] = useState('');
  const submitExp = async () => {
    if (!expForm.amount) { setExpError('قيمة المصروف مطلوبة'); return; }
    setExpSaving(true); setExpError('');
    try {
      const res = await client.post(`/fleet/vehicles/${vehicleId}/expenses`, expForm);
      setExpForm({ category: 'fuel', amount: '', notes: '', expense_date: '', parts_used: [] });
      refetch(); onChanged?.();
      if (res.data?.warnings?.length) window.alert(res.data.warnings.join('\n'));
    } catch (err) { setExpError(err?.response?.data?.error || 'خطأ في تسجيل المصروف'); }
    finally { setExpSaving(false); }
  };

  /* ── Edit/delete an already-saved expense row — open to any user with
     the page's normal edit level (not admin-only, unlike vehicle delete/
     stock reset: correcting a logged expense is routine, not destructive
     in that same sense). Editing reuses ExpensePartsPicker exactly like
     the create form above, pre-filled from the row being edited. */
  const [editingExpenseId, setEditingExpenseId] = useState(null);
  const [editExpForm, setEditExpForm] = useState(null);
  const [editExpSaving, setEditExpSaving] = useState(false);
  const [editExpError, setEditExpError] = useState('');

  const startEditExpense = (e) => {
    setEditingExpenseId(e.id);
    setEditExpForm({
      category: e.category, amount: e.amount, notes: e.notes || '', expense_date: e.expense_date || '',
      parts_used: (e.parts_used || []).map(p => ({ part_id: p.part_id, qty: p.qty, unit_cost: p.unit_cost, deduct_stock: p.deduct_stock })),
    });
    setEditExpError('');
  };
  const cancelEditExpense = () => { setEditingExpenseId(null); setEditExpForm(null); };
  const submitEditExpense = async () => {
    if (!editExpForm.amount) { setEditExpError('قيمة المصروف مطلوبة'); return; }
    setEditExpSaving(true); setEditExpError('');
    try {
      const res = await client.put(`/fleet/expenses/${editingExpenseId}`, editExpForm);
      setEditingExpenseId(null); setEditExpForm(null);
      refetch(); onChanged?.();
      if (res.data?.warnings?.length) window.alert(res.data.warnings.join('\n'));
    } catch (err) { setEditExpError(err?.response?.data?.error || 'خطأ في تعديل المصروف'); }
    finally { setEditExpSaving(false); }
  };
  const deleteExpense = async (e) => {
    const ok = window.confirm(`حذف هذا المصروف (${labelOf(EXPENSE_CATEGORY_OPTIONS, e.category)} — ${fmt(e.amount, 2)} ر.س) نهائياً؟${e.parts_used?.some(p => p.deduct_stock) ? ' سيتم إرجاع كمية قطع الغيار المخصومة منه إلى المستودع.' : ''}`);
    if (!ok) return;
    try {
      await client.delete(`/fleet/expenses/${e.id}`);
      if (editingExpenseId === e.id) cancelEditExpense();
      refetch(); onChanged?.();
    } catch (err) { window.alert(err?.response?.data?.error || 'خطأ في حذف المصروف'); }
  };

  /* ── Edit/delete an already-logged maintenance row — ADMIN-ONLY (the
     backend enforces it with requireRoles; this just hides the buttons for
     everyone else). Unlike an expense, a maintenance row is what the due/
     overdue schedule is computed from, so the server recomputes that
     type's schedule and reverses/re-applies the parts stock on save. */
  const { user: profileUser } = useAuth();
  const canEditMaint = ADMIN_ROLES.includes(profileUser?.role);
  const [editingMaintId, setEditingMaintId] = useState(null);
  const [editMaintForm, setEditMaintForm] = useState(null);
  const [editMaintSaving, setEditMaintSaving] = useState(false);
  const [editMaintError, setEditMaintError] = useState('');

  const startEditMaint = (m) => {
    setEditingMaintId(m.id);
    setEditMaintForm({
      maintenance_type_id: m.maintenance_type_id, odometer_km: m.odometer_km, cost: m.cost ?? '',
      vendor: m.vendor || '', notes: m.notes || '', service_date: m.service_date || '',
      parts_used: (m.parts_used || []).map(p => ({ part_id: p.part_id, qty: p.qty })),
    });
    setEditMaintError('');
  };
  const cancelEditMaint = () => { setEditingMaintId(null); setEditMaintForm(null); };
  const submitEditMaint = async () => {
    if (!editMaintForm.maintenance_type_id || editMaintForm.odometer_km === '' || editMaintForm.odometer_km == null) {
      setEditMaintError('نوع الصيانة وقراءة العداد مطلوبان'); return;
    }
    setEditMaintSaving(true); setEditMaintError('');
    try {
      const res = await client.put(`/fleet/maintenance-log/${editingMaintId}`, editMaintForm);
      setEditingMaintId(null); setEditMaintForm(null);
      refetch(); onChanged?.();
      if (res.data?.warnings?.length) window.alert(res.data.warnings.join('\n'));
    } catch (err) { setEditMaintError(err?.response?.data?.error || 'خطأ في تعديل سجل الصيانة'); }
    finally { setEditMaintSaving(false); }
  };
  const deleteMaint = async (m) => {
    const ok = window.confirm(`حذف سجل الصيانة "${m.type_name}" (${m.service_date}) نهائياً؟ سيُعاد حساب موعد الصيانة القادمة لهذا النوع${m.parts_used?.length ? '، وستُرجَع قطع الغيار المخصومة منه إلى المستودع' : ''}.`);
    if (!ok) return;
    try {
      await client.delete(`/fleet/maintenance-log/${m.id}`);
      if (editingMaintId === m.id) cancelEditMaint();
      refetch(); onChanged?.();
    } catch (err) { window.alert(err?.response?.data?.error || 'خطأ في حذف سجل الصيانة'); }
  };

  if (isLoading || !data) return <div className="flt-loading">جاري تحميل بيانات السيارة…</div>;

  const expenseTotal = (data.expense_totals || []).reduce((s, e) => s + Number(e.total), 0);

  return (
    <div className="flt-profile">
      <div className="flt-profile__section flt-profile__section--edit">
        <div className="flt-profile__title-row">
          <div className="flt-profile__title">🚘 بيانات السيارة</div>
          {!showEdit && (
            <button type="button" className="flt-btn flt-btn--outline flt-btn--sm" onClick={openEdit}>✏️ تعديل بيانات السيارة</button>
          )}
        </div>

        {!showEdit ? (
          <div className="flt-vehicle-summary">
            <span><strong>رقم اللوحة:</strong> {data.vehicle.plate_number}</span>
            <span><strong>التصنيف:</strong> {data.vehicle.category ? labelOf(CATEGORY_OPTIONS, data.vehicle.category) : 'غير مصنّفة'}</span>
            <span><strong>مخصصة لـ:</strong> {data.vehicle.assigned_rep_name || [data.vehicle.assignment_label, data.vehicle.driver_name && `السائق: ${data.vehicle.driver_name}`].filter(Boolean).join(' — ') || '—'}</span>
            <span><strong>المنطقة:</strong> {data.vehicle.effective_region_name || '—'}</span>
            <span><strong>النوع/الموديل:</strong> {[data.vehicle.make, data.vehicle.model, data.vehicle.model_year].filter(Boolean).join(' ') || '—'}</span>
            <span><strong>الحالة:</strong> <StatusLight status={data.vehicle.status} /></span>
            {data.vehicle.notes && <span><strong>ملاحظات:</strong> {data.vehicle.notes}</span>}
          </div>
        ) : (
          <div className="flt-add-form">
            <div className="flt-filters">
              <div className="flt-field"><label>رقم اللوحة *</label><input type="text" value={editForm.plate_number} onChange={e => setEditForm(f => ({ ...f, plate_number: e.target.value }))} /></div>
              <div className="flt-field">
                <label>التصنيف</label>
                <select value={editForm.category} onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}>
                  <option value="">غير مصنّفة</option>
                  {pickableOptions(vehicleCategories, data.vehicle.category).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="flt-field">
                <label>التخصيص</label>
                <select value={editForm.assignment_type} onChange={e => setEditForm(f => ({ ...f, assignment_type: e.target.value }))}>
                  {ASSIGNMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              {editForm.assignment_type === 'rep' ? (
                <>
                  <div className="flt-field">
                    <label>المندوب *</label>
                    <select value={editForm.assigned_rep_id} onChange={e => setEditForm(f => ({ ...f, assigned_rep_id: e.target.value }))}>
                      <option value="">— اختر من القائمة المسجلة —</option>
                      {reps.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
                    </select>
                  </div>
                  <div className="flt-field">
                    <label>المنطقة</label>
                    <div className="flt-region-derived">تُحدَّد تلقائيًا حسب منطقة المندوب الحالية</div>
                  </div>
                </>
              ) : (
                <>
                  <div className="flt-field"><label>وصف الجهة</label><input type="text" value={editForm.assignment_label} onChange={e => setEditForm(f => ({ ...f, assignment_label: e.target.value }))} placeholder="مثال: نقل بضاعة - منطقة الرياض" /></div>
                  <div className="flt-field"><label>اسم السائق (اختياري)</label><input type="text" value={editForm.driver_name} onChange={e => setEditForm(f => ({ ...f, driver_name: e.target.value }))} /></div>
                  <div className="flt-field">
                    <label>المنطقة</label>
                    <select value={editForm.region_id} onChange={e => setEditForm(f => ({ ...f, region_id: e.target.value }))}>
                      <option value="">— بدون —</option>
                      {regions.map(r => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
                    </select>
                  </div>
                </>
              )}
              <div className="flt-field"><label>النوع (الشركة المصنّعة)</label><input type="text" value={editForm.make} onChange={e => setEditForm(f => ({ ...f, make: e.target.value }))} placeholder="مثال: Isuzu" /></div>
              <div className="flt-field"><label>الموديل</label><input type="text" value={editForm.model} onChange={e => setEditForm(f => ({ ...f, model: e.target.value }))} placeholder="مثال: NPR 2022" /></div>
              <div className="flt-field"><label>سنة الصنع</label><input type="number" value={editForm.model_year} onChange={e => setEditForm(f => ({ ...f, model_year: e.target.value }))} /></div>
              <div className="flt-field">
                <label>الحالة</label>
                <select value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}>
                  {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="flt-field"><label>ملاحظات</label><input type="text" value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} /></div>
              <button type="button" className="flt-btn flt-btn--primary" disabled={editSaving} onClick={submitEdit}>{editSaving ? 'جارٍ الحفظ…' : '💾 حفظ'}</button>
              <button type="button" className="flt-btn flt-btn--outline" disabled={editSaving} onClick={() => setShowEdit(false)}>إلغاء</button>
            </div>
            {editError && <div className="flt-error">{editError}</div>}
          </div>
        )}
      </div>

      <div className="flt-profile__grid">
        {/* Maintenance schedule */}
        <div className="flt-profile__section">
          <div className="flt-profile__title">📅 جدول الصيانة الدورية</div>
          <div className="flt-table-wrap">
            <table className="flt-table flt-table--nested">
              <thead><tr><th>النوع</th><th>آخر خدمة (كم/تاريخ)</th><th>الفترة</th><th>الحالة</th></tr></thead>
              <tbody>
                {data.schedule.map(s => {
                  const overdue = s.km_remaining <= 0;
                  const dueSoon = !overdue && s.km_remaining <= s.interval_km * 0.1;
                  return (
                    <tr key={s.id}>
                      <td>{s.type_name}</td>
                      <td>{fmt(s.last_service_km)} كم {s.last_service_date ? `— ${s.last_service_date}` : ''}</td>
                      <td>{fmt(s.interval_km)} كم</td>
                      <td>
                        {overdue
                          ? <span className="flt-badge flt-badge--danger">متأخرة {fmt(Math.abs(s.km_remaining))} كم</span>
                          : dueSoon
                            ? <span className="flt-badge flt-badge--warn">قريبة ({fmt(s.km_remaining)} كم متبقي)</span>
                            : <span className="flt-badge flt-badge--ok">{fmt(s.km_remaining)} كم متبقي</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Quick-entry forms */}
        <div className="flt-profile__section">
          <div className="flt-profile__title">✏️ تسجيل قراءة عداد</div>
          <div className="flt-inline-row">
            <input type="number" placeholder="القراءة (كم)" className="flt-inline-input" value={odoForm.reading_km} onChange={e => setOdoForm(f => ({ ...f, reading_km: e.target.value }))} />
            <input type="date" className="flt-inline-input" value={odoForm.reading_date} onChange={e => setOdoForm(f => ({ ...f, reading_date: e.target.value }))} />
            <button type="button" className="flt-btn flt-btn--primary flt-btn--sm" disabled={odoSaving} onClick={submitOdo}>{odoSaving ? '⏳' : '💾 حفظ'}</button>
          </div>
          {odoError && <div className="flt-error">{odoError}</div>}

          <div className="flt-profile__title" style={{ marginTop: 14 }}>🔧 تسجيل صيانة منفَّذة</div>
          <div className="flt-inline-row flt-inline-row--wrap">
            <select className="flt-inline-input" value={maintForm.maintenance_type_id} onChange={e => setMaintForm(f => ({ ...f, maintenance_type_id: e.target.value }))}>
              <option value="">— نوع الصيانة —</option>
              {data.schedule.map(s => <option key={s.maintenance_type_id} value={s.maintenance_type_id}>{s.type_name}</option>)}
            </select>
            <input type="number" placeholder="العداد وقت الصيانة" className="flt-inline-input" value={maintForm.odometer_km} onChange={e => setMaintForm(f => ({ ...f, odometer_km: e.target.value }))} />
            <input type="number" placeholder="التكلفة" className="flt-inline-input" value={maintForm.cost} onChange={e => setMaintForm(f => ({ ...f, cost: e.target.value }))} />
            <input type="text" placeholder="الورشة/المورّد" className="flt-inline-input" value={maintForm.vendor} onChange={e => setMaintForm(f => ({ ...f, vendor: e.target.value }))} />
            <input type="date" className="flt-inline-input" value={maintForm.service_date} onChange={e => setMaintForm(f => ({ ...f, service_date: e.target.value }))} />
            <input type="text" placeholder="ملاحظات" className="flt-inline-input" value={maintForm.notes} onChange={e => setMaintForm(f => ({ ...f, notes: e.target.value }))} />
            <MaintenancePartsPicker parts={spareParts} selectedParts={maintForm.parts_used} onChange={parts => setMaintForm(f => ({ ...f, parts_used: parts }))} />
            <button type="button" className="flt-btn flt-btn--primary flt-btn--sm" disabled={maintSaving} onClick={submitMaint}>{maintSaving ? '⏳' : '💾 حفظ'}</button>
          </div>
          {maintError && <div className="flt-error">{maintError}</div>}

          <div className="flt-profile__title" style={{ marginTop: 14 }}>💰 تسجيل مصروف</div>
          <div className="flt-inline-row flt-inline-row--wrap">
            <select className="flt-inline-input" value={expForm.category} onChange={e => setExpForm(f => ({ ...f, category: e.target.value }))}>
              {pickableOptions(expenseCategories, expForm.category).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input type="number" placeholder="القيمة (ر.س)" className="flt-inline-input" value={expForm.amount} onChange={e => setExpForm(f => ({ ...f, amount: e.target.value }))} />
            <input type="date" className="flt-inline-input" value={expForm.expense_date} onChange={e => setExpForm(f => ({ ...f, expense_date: e.target.value }))} />
            <input type="text" placeholder="ملاحظات" className="flt-inline-input" value={expForm.notes} onChange={e => setExpForm(f => ({ ...f, notes: e.target.value }))} />
            <button type="button" className="flt-btn flt-btn--primary flt-btn--sm" disabled={expSaving} onClick={submitExp}>{expSaving ? '⏳' : '💾 حفظ'}</button>
          </div>
          <ExpensePartsPicker parts={spareParts} selectedParts={expForm.parts_used} onChange={parts => setExpForm(f => ({ ...f, parts_used: parts }))} />
          {expError && <div className="flt-error">{expError}</div>}
        </div>
      </div>

      <div className="flt-profile__grid">
        <div className="flt-profile__section">
          <div className="flt-profile__title">📈 آخر قراءات العداد</div>
          <div className="flt-table-wrap">
            <table className="flt-table flt-table--nested">
              <thead><tr><th>التاريخ</th><th>القراءة</th><th>بواسطة</th></tr></thead>
              <tbody>
                {!data.odometer_history.length && <tr><td colSpan={3} className="flt-empty">لا توجد قراءات مسجلة</td></tr>}
                {data.odometer_history.map(r => (
                  <tr key={r.id}><td>{r.reading_date}</td><td className="flt-td-num">{fmt(r.reading_km)} كم</td><td>{r.recorded_by_name || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flt-profile__section">
          <div className="flt-profile__title">🧾 سجل الصيانة المنفَّذة</div>
          <div className="flt-table-wrap">
            <table className="flt-table flt-table--nested">
              <thead><tr><th>التاريخ</th><th>النوع</th><th>العداد</th><th>التكلفة</th><th>الورشة</th><th>قطع الغيار</th>{canEditMaint && <th>إجراءات</th>}</tr></thead>
              <tbody>
                {!data.maintenance_log.length && <tr><td colSpan={canEditMaint ? 7 : 6} className="flt-empty">لا يوجد سجل صيانة</td></tr>}
                {data.maintenance_log.map(m => (
                  <React.Fragment key={m.id}>
                    <tr>
                      <td>{m.service_date}</td><td>{m.type_name}</td><td className="flt-td-num">{fmt(m.odometer_km)} كم</td><td className="flt-td-num">{fmt(m.cost, 2)} ر.س</td><td>{m.vendor || '—'}</td>
                      <td>{m.parts_used?.length ? m.parts_used.map(p => `${p.name_ar} ×${fmt(p.qty)}`).join('، ') : '—'}</td>
                      {canEditMaint && (
                        <td>
                          <button type="button" className="flt-btn flt-btn--outline flt-btn--sm" onClick={() => editingMaintId === m.id ? cancelEditMaint() : startEditMaint(m)}>
                            {editingMaintId === m.id ? '✖️ إلغاء' : '✏️ تعديل'}
                          </button>
                          <button type="button" className="flt-btn flt-btn--outline flt-btn--sm flt-btn--danger" onClick={() => deleteMaint(m)}>🗑️ حذف</button>
                        </td>
                      )}
                    </tr>
                    {canEditMaint && editingMaintId === m.id && editMaintForm && (
                      <tr>
                        <td colSpan={7}>
                          <div className="flt-add-form">
                            <div className="flt-inline-row flt-inline-row--wrap">
                              <select className="flt-inline-input" value={editMaintForm.maintenance_type_id} onChange={ev => setEditMaintForm(f => ({ ...f, maintenance_type_id: ev.target.value }))}>
                                {data.schedule.map(sc => <option key={sc.maintenance_type_id} value={sc.maintenance_type_id}>{sc.type_name}</option>)}
                              </select>
                              <input type="number" placeholder="العداد وقت الصيانة" className="flt-inline-input" value={editMaintForm.odometer_km} onChange={ev => setEditMaintForm(f => ({ ...f, odometer_km: ev.target.value }))} />
                              <input type="number" placeholder="التكلفة" className="flt-inline-input" value={editMaintForm.cost} onChange={ev => setEditMaintForm(f => ({ ...f, cost: ev.target.value }))} />
                              <input type="text" placeholder="الورشة/المورّد" className="flt-inline-input" value={editMaintForm.vendor} onChange={ev => setEditMaintForm(f => ({ ...f, vendor: ev.target.value }))} />
                              <input type="date" className="flt-inline-input" value={editMaintForm.service_date} onChange={ev => setEditMaintForm(f => ({ ...f, service_date: ev.target.value }))} />
                              <input type="text" placeholder="ملاحظات" className="flt-inline-input" value={editMaintForm.notes} onChange={ev => setEditMaintForm(f => ({ ...f, notes: ev.target.value }))} />
                              <MaintenancePartsPicker parts={spareParts} selectedParts={editMaintForm.parts_used} onChange={parts => setEditMaintForm(f => ({ ...f, parts_used: parts }))} />
                              <button type="button" className="flt-btn flt-btn--primary flt-btn--sm" disabled={editMaintSaving} onClick={submitEditMaint}>{editMaintSaving ? '⏳' : '💾 حفظ التعديل'}</button>
                            </div>
                            {editMaintError && <div className="flt-error">{editMaintError}</div>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="flt-profile__section">
        <div className="flt-profile__title">💵 سجل المصاريف (إجمالي: {fmt(expenseTotal, 2)} ر.س)</div>
        <div className="flt-table-wrap">
          <table className="flt-table flt-table--nested">
            <thead><tr><th>التاريخ</th><th>التصنيف</th><th>القيمة</th><th>قطع الغيار</th><th>ملاحظات</th><th>بواسطة</th><th>إجراءات</th></tr></thead>
            <tbody>
              {!data.expenses.length && <tr><td colSpan={7} className="flt-empty">لا توجد مصاريف مسجلة</td></tr>}
              {data.expenses.map(e => (
                <React.Fragment key={e.id}>
                  <tr>
                    <td>{e.expense_date}</td><td>{labelOf(EXPENSE_CATEGORY_OPTIONS, e.category)}</td><td className="flt-td-num">{fmt(e.amount, 2)} ر.س</td>
                    <td>{e.parts_used?.length ? e.parts_used.map(p => `${p.name_ar} ×${fmt(p.qty)}${p.deduct_stock ? ' (مستودع)' : ''}`).join('، ') : '—'}</td><td>{e.notes || '—'}</td><td>{e.created_by_name || '—'}</td>
                    <td>
                      <button type="button" className="flt-btn flt-btn--outline flt-btn--sm" onClick={() => editingExpenseId === e.id ? cancelEditExpense() : startEditExpense(e)}>
                        {editingExpenseId === e.id ? '✖️ إلغاء' : '✏️ تعديل'}
                      </button>
                      <button type="button" className="flt-btn flt-btn--outline flt-btn--sm flt-btn--danger" onClick={() => deleteExpense(e)}>🗑️ حذف</button>
                    </td>
                  </tr>
                  {editingExpenseId === e.id && editExpForm && (
                    <tr>
                      <td colSpan={7}>
                        <div className="flt-add-form">
                          <div className="flt-inline-row flt-inline-row--wrap">
                            <select className="flt-inline-input" value={editExpForm.category} onChange={ev => setEditExpForm(f => ({ ...f, category: ev.target.value }))}>
                              {pickableOptions(expenseCategories, editExpForm.category).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                            <input type="number" placeholder="القيمة (ر.س)" className="flt-inline-input" value={editExpForm.amount} onChange={ev => setEditExpForm(f => ({ ...f, amount: ev.target.value }))} />
                            <input type="date" className="flt-inline-input" value={editExpForm.expense_date} onChange={ev => setEditExpForm(f => ({ ...f, expense_date: ev.target.value }))} />
                            <input type="text" placeholder="ملاحظات" className="flt-inline-input" value={editExpForm.notes} onChange={ev => setEditExpForm(f => ({ ...f, notes: ev.target.value }))} />
                            <button type="button" className="flt-btn flt-btn--primary flt-btn--sm" disabled={editExpSaving} onClick={submitEditExpense}>{editExpSaving ? '⏳' : '💾 حفظ التعديل'}</button>
                          </div>
                          <ExpensePartsPicker parts={spareParts} selectedParts={editExpForm.parts_used} onChange={parts => setEditExpForm(f => ({ ...f, parts_used: parts }))} />
                          {editExpError && <div className="flt-error">{editExpError}</div>}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   MultiSelectDropdown — a small checkbox-panel dropdown for the reports
   filter bar. `selected` follows the same three-state convention as the
   region/type chips on the fleet vehicles list and the current-stock
   matrix: null = الكل (default), a Set = a chosen subset, an EXPLICITLY
   empty Set = "لا شيء" (the caller decides what that renders as — here it
   blocks the report queries and shows a hint, rather than silently
   meaning "no filter" the way an absent param would).
════════════════════════════════════════════════════════════ */
function MultiSelectDropdown({ options, selected, onChange, placeholder }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const isAll = selected === null;
  const count = isAll ? options.length : selected.size;
  const label = isAll ? placeholder
    : count === 0 ? 'لا شيء'
    : count === 1 ? (options.find(o => o.value === [...selected][0])?.label || '')
    : `${count} محدد`;

  const toggle = v => onChange(prev => {
    const cur = prev === null ? new Set(options.map(o => o.value)) : new Set(prev);
    cur.has(v) ? cur.delete(v) : cur.add(v);
    return cur.size === options.length ? null : cur;
  });

  return (
    <div className="flt-msd" ref={ref}>
      <button type="button" className="flt-msd-btn" onClick={() => setOpen(o => !o)}>
        <span>{label}</span><span className="flt-msd-caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="flt-msd-panel">
          <div className="flt-msd-actions">
            <button type="button" onClick={() => onChange(null)}>الكل</button>
            <button type="button" onClick={() => onChange(new Set())}>لا شيء</button>
          </div>
          {options.map(o => {
            const checked = isAll || selected.has(o.value);
            return (
              <label key={o.value} className="flt-msd-item">
                <input type="checkbox" checked={checked} onChange={() => toggle(o.value)} />
                {o.label}
              </label>
            );
          })}
          {!options.length && <div className="flt-empty">لا توجد خيارات</div>}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   ExpensePartsPicker — optional "قطع الغيار" multi-select on "تسجيل
   مصروف", stock- and cost-aware. Per selected part the admin picks a
   quantity AND toggles "خصم من المستودع":
     • ON  — cost is pulled automatically from that part's last recorded
       supply price and shown read-only (server re-derives it anyway on
       submit — never trusted from here — so this is a preview, not the
       source of truth); the quantity will be deducted from stock.
     • OFF — cost is typed by hand; stock is untouched. Forced OFF (and
       disabled) when the part has no recorded cost at all, since there is
       nothing to auto-price it FROM.
   `selectedParts` is [{part_id, qty, unit_cost, deduct_stock}]. */
function ExpensePartsPicker({ parts, selectedParts, onChange }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const selectedIds = new Set(selectedParts.map(p => p.part_id));
  const byId = new Map(parts.map(p => [p.id, p]));
  const q = query.trim().toLowerCase();
  const matches = q
    ? parts.filter(p => p.is_active && !selectedIds.has(p.id) && p.name_ar.toLowerCase().includes(q)).slice(0, 30)
    : [];

  const add = id => {
    const part = byId.get(id);
    const hasCost = part && part.last_unit_cost != null;
    const hasStock = part && Number(part.qty_on_hand) > 0;
    onChange([...selectedParts, {
      part_id: id, qty: 1,
      deduct_stock: hasCost && hasStock,
      unit_cost: hasCost ? Number(part.last_unit_cost) : 0,
    }]);
    setQuery('');
  };
  const remove = id => onChange(selectedParts.filter(p => p.part_id !== id));
  const update = (id, patch) => onChange(selectedParts.map(p => p.part_id === id ? { ...p, ...patch } : p));
  const toggleDeduct = id => {
    const row = selectedParts.find(p => p.part_id === id);
    const part = byId.get(id);
    const nextDeduct = !row.deduct_stock;
    update(id, { deduct_stock: nextDeduct, unit_cost: nextDeduct ? Number(part?.last_unit_cost || 0) : row.unit_cost });
  };

  return (
    <div className="flt-eparts-picker" ref={ref}>
      <div className="flt-eparts-label">🔩 قطع الغيار المستخدمة (اختياري)</div>
      {selectedParts.length > 0 && (
        <div className="flt-eparts-rows">
          {selectedParts.map(row => {
            const part = byId.get(row.part_id);
            const hasCost = part?.last_unit_cost != null;
            return (
              <div key={row.part_id} className="flt-eparts-row">
                <span className="flt-eparts-row__name">{part?.name_ar || `#${row.part_id}`}</span>
                <input
                  type="number" min="1" step="1" className="flt-eparts-row__qty"
                  value={row.qty} title="الكمية"
                  onChange={e => update(row.part_id, { qty: Number(e.target.value) || 0 })}
                />
                <label className="flt-eparts-row__toggle" title={hasCost ? '' : 'لا يوجد سعر مسجل لهذه القطعة — أدخل السعر يدوياً'}>
                  <input type="checkbox" checked={row.deduct_stock} disabled={!hasCost} onChange={() => toggleDeduct(row.part_id)} />
                  من المستودع
                </label>
                {row.deduct_stock ? (
                  <span className="flt-eparts-row__cost">{fmt(row.unit_cost, 2)} ر.س/وحدة — الرصيد: {fmt(part?.qty_on_hand)}</span>
                ) : (
                  <input
                    type="number" min="0" step="0.01" className="flt-eparts-row__cost-input"
                    placeholder="سعر الوحدة (ر.س)" value={row.unit_cost}
                    onChange={e => update(row.part_id, { unit_cost: Number(e.target.value) || 0 })}
                  />
                )}
                <button type="button" className="flt-eparts-row__remove" onClick={() => remove(row.part_id)} title="إزالة">×</button>
              </div>
            );
          })}
        </div>
      )}
      <input
        type="text" className="flt-inline-input" placeholder="قطعة الغيار (اختياري) — اكتب للبحث…"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && q && (
        <div className="flt-parts-panel">
          {matches.map(p => (
            <div key={p.id} className="flt-parts-item flt-parts-item--stock" onClick={() => add(p.id)}>
              <span>{p.name_ar}</span>
              <span className={`flt-parts-item__stock${Number(p.qty_on_hand) <= 0 ? ' flt-parts-item__stock--empty' : ''}`}>
                المتاح: {fmt(p.qty_on_hand)}
              </span>
            </div>
          ))}
          {!matches.length && <div className="flt-empty">لا توجد نتائج</div>}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   MaintenancePartsPicker — used only on "تسجيل صيانة منفَّذة". Consuming a
   part here ALWAYS deducts from fleet_spare_parts.qty_on_hand at whatever
   its current recorded cost is (server-side, on submit) — unlike its
   sibling ExpensePartsPicker above, there's no per-part deduct/manual
   toggle here, since a maintenance job's parts are always real
   consumption. Each selection needs a QUANTITY; the search results show
   the part's current balance so the coordinator can see at a glance
   whether enough stock is on hand before picking it.
   `selectedParts` is an array of {part_id, qty}. */
function MaintenancePartsPicker({ parts, selectedParts, onChange }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const selectedIds = new Set(selectedParts.map(p => p.part_id));
  const byId = new Map(parts.map(p => [p.id, p]));
  const q = query.trim().toLowerCase();
  const matches = q
    ? parts.filter(p => p.is_active && !selectedIds.has(p.id) && p.name_ar.toLowerCase().includes(q)).slice(0, 30)
    : [];

  const add = id => { onChange([...selectedParts, { part_id: id, qty: 1 }]); setQuery(''); };
  const remove = id => onChange(selectedParts.filter(p => p.part_id !== id));
  const setQty = (id, qty) => onChange(selectedParts.map(p => p.part_id === id ? { ...p, qty } : p));

  return (
    <div className="flt-parts-picker" ref={ref}>
      {selectedParts.length > 0 && (
        <div className="flt-parts-chips">
          {selectedParts.map(({ part_id, qty }) => (
            <span key={part_id} className="flt-parts-chip flt-parts-chip--qty">
              {byId.get(part_id)?.name_ar || `#${part_id}`}
              <input
                type="number" min="1" step="1" className="flt-parts-chip__qty"
                value={qty}
                onChange={e => setQty(part_id, Number(e.target.value) || 0)}
                onClick={e => e.stopPropagation()}
              />
              <button type="button" onClick={() => remove(part_id)} title="إزالة">×</button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text" className="flt-inline-input" placeholder="قطعة الغيار (اختياري) — اكتب للبحث…"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && q && (
        <div className="flt-parts-panel">
          {matches.map(p => (
            <div key={p.id} className="flt-parts-item flt-parts-item--stock" onClick={() => add(p.id)}>
              <span>{p.name_ar}</span>
              <span className={`flt-parts-item__stock${Number(p.qty_on_hand) <= 0 ? ' flt-parts-item__stock--empty' : ''}`}>
                المتاح: {fmt(p.qty_on_hand)}
              </span>
            </div>
          ))}
          {!matches.length && <div className="flt-empty">لا توجد نتائج</div>}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   FleetReportsTab (التقارير) — filterable by an arbitrary date range plus
   region(s)/category(ies), unlike overview/vehicles which show current
   state only. Three sections fed by the three /fleet/reports/* endpoints:
   مؤشرات الأداء (KPIs), تقرير الصيانة (منفذة + قادمة), تقرير المصروفات.
════════════════════════════════════════════════════════════ */
function monthToDateBounds() {
  const now = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
}

function FleetReportsTab({ regions, vehicleCategories }) {
  const defaults = monthToDateBounds();
  const [dateFrom, setDateFrom] = useState(defaults.from);
  const [dateTo, setDateTo] = useState(defaults.to);
  const [selRegions, setSelRegions] = useState(null);     // null = كل المناطق
  const [selCategories, setSelCategories] = useState(null); // null = كل التصنيفات

  const regionOptions = regions.map(r => ({ value: String(r.id), label: r.name_ar }));
  const categoryOptions = toOptions(vehicleCategories);

  const rangeValid = !!dateFrom && !!dateTo && dateTo >= dateFrom;
  const noneRegions = selRegions !== null && selRegions.size === 0;
  const noneCategories = selCategories !== null && selCategories.size === 0;
  const blocked = noneRegions || noneCategories;
  const canQuery = rangeValid && !blocked;

  const filterKey = [
    dateFrom, dateTo,
    selRegions === null ? 'all' : [...selRegions].sort().join('|'),
    selCategories === null ? 'all' : [...selCategories].sort().join('|'),
  ];

  const buildQs = () => {
    const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    if (selRegions !== null) [...selRegions].forEach(v => params.append('region_id', v));
    if (selCategories !== null) [...selCategories].forEach(v => params.append('category', v));
    return params.toString();
  };

  const { data: summary, isLoading: sLoading, isError: sError } = useQuery({
    queryKey: ['fleet-report-summary', ...filterKey],
    queryFn: () => client.get(`/fleet/reports/summary?${buildQs()}`).then(r => r.data),
    enabled: canQuery,
    staleTime: 30 * 1000,
  });

  const { data: maintReport, isLoading: mLoading, isError: mError } = useQuery({
    queryKey: ['fleet-report-maintenance', ...filterKey],
    queryFn: () => client.get(`/fleet/reports/maintenance?${buildQs()}`).then(r => r.data),
    enabled: canQuery,
    staleTime: 30 * 1000,
  });

  const { data: expReport, isLoading: eLoading, isError: eError } = useQuery({
    queryKey: ['fleet-report-expenses', ...filterKey],
    queryFn: () => client.get(`/fleet/reports/expenses?${buildQs()}`).then(r => r.data),
    enabled: canQuery,
    staleTime: 30 * 1000,
  });

  const catLabel = (key) => labelOf(categoryOptions, key);

  const handleExportMaintenance = () => {
    if (!maintReport) return;
    const wb = XLSX.utils.book_new();
    const doneHeader = ['التاريخ', 'رقم اللوحة', 'التصنيف', 'نوع الصيانة', 'العداد وقتها', 'التكلفة', 'المورّد', 'ملاحظات'];
    const doneRows = maintReport.done.map(d => [
      d.service_date, d.plate_number, d.category ? catLabel(d.category) : '—', d.type_name,
      Number(d.odometer_km), Number(d.cost), d.vendor || '—', d.notes || '—',
    ]);
    const wsDone = XLSX.utils.aoa_to_sheet([doneHeader, ...doneRows]);
    XLSX.utils.book_append_sheet(wb, wsDone, 'الصيانات المنفذة');

    const upHeader = ['رقم اللوحة', 'التصنيف', 'نوع الصيانة', 'منذ آخر خدمة (كم)', 'الفترة (كم)', 'متأخر بـ (كم)', 'الحالة'];
    const upRows = maintReport.upcoming.map(u => [
      u.plate_number, u.category ? catLabel(u.category) : '—', u.type_name,
      Number(u.km_since_service), Number(u.interval_km),
      u.km_overdue_by > 0 ? Number(u.km_overdue_by) : 0,
      u.alert_level === 'overdue' ? 'متأخرة' : 'قريبة الاستحقاق',
    ]);
    const wsUp = XLSX.utils.aoa_to_sheet([upHeader, ...upRows]);
    XLSX.utils.book_append_sheet(wb, wsUp, 'الصيانات القادمة');

    XLSX.writeFile(wb, `تقرير_الصيانة_${dateFrom}_${dateTo}.xlsx`);
  };

  const handleExportExpenses = () => {
    if (!expReport) return;
    const header = ['التاريخ', 'رقم اللوحة', 'التصنيف', 'البند', 'القيمة', 'ملاحظات', 'بواسطة'];
    const rows = expReport.rows.map(e => [
      e.expense_date, e.plate_number, e.category ? catLabel(e.category) : '—',
      expReport.expense_category_labels?.[e.expense_category] || e.expense_category,
      Number(e.amount), e.notes || '—', e.created_by_name || '—',
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws['!cols'] = header.map((_, i) => ({ wch: i === 1 ? 14 : 18 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'المصروفات');
    XLSX.writeFile(wb, `تقرير_المصروفات_${dateFrom}_${dateTo}.xlsx`);
  };

  return (
    <div className="flt-tab-content">
      <div className="flt-card">
        <div className="flt-filters">
          <div className="flt-field flt-field--sm">
            <label>من</label>
            <input type="date" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div className="flt-field flt-field--sm">
            <label>إلى</label>
            <input type="date" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} />
          </div>
          <div className="flt-field">
            <label>المناطق</label>
            <MultiSelectDropdown options={regionOptions} selected={selRegions} onChange={setSelRegions} placeholder="كل المناطق" />
          </div>
          <div className="flt-field">
            <label>تصنيف السيارة</label>
            <MultiSelectDropdown options={categoryOptions} selected={selCategories} onChange={setSelCategories} placeholder="كل التصنيفات" />
          </div>
        </div>
        {!rangeValid && <div className="flt-error">حدد فترة صحيحة («إلى» بعد أو يساوي «من»)</div>}
        {blocked && rangeValid && <div className="flt-error">اختر منطقة واحدة على الأقل وتصنيفًا واحدًا على الأقل — أو "الكل"</div>}
      </div>

      {canQuery && (
        <>
          {/* ── مؤشرات الأداء ── */}
          <div className="flt-card">
            <div className="flt-card__title">📊 مؤشرات الأداء خلال الفترة</div>
            {sLoading ? <div className="flt-loading">جاري التحميل…</div>
              : sError ? <div className="flt-error">تعذّر جلب المؤشرات</div>
              : summary && (
              <div className="flt-kpi-row">
                <div className="flt-kpi"><div className="flt-kpi__label">عدد السيارات ضمن النطاق</div><div className="flt-kpi__value">{fmt(summary.vehicle_count)}</div></div>
                <div className="flt-kpi"><div className="flt-kpi__label">صيانات منفذة</div><div className="flt-kpi__value">{fmt(summary.maintenance_count)}</div></div>
                <div className="flt-kpi"><div className="flt-kpi__label">تكلفة الصيانة</div><div className="flt-kpi__value">{fmt(summary.maintenance_cost, 2)} ر.س</div></div>
                <div className="flt-kpi"><div className="flt-kpi__label">إجمالي المصروفات</div><div className="flt-kpi__value">{fmt(summary.expense_total, 2)} ر.س</div></div>
                <div className="flt-kpi flt-kpi--warn"><div className="flt-kpi__label">التكلفة الإجمالية</div><div className="flt-kpi__value">{fmt(summary.total_cost, 2)} ر.س</div></div>
                <div className="flt-kpi"><div className="flt-kpi__label">كم مقطوعة (من قراءات العداد)</div><div className="flt-kpi__value">{fmt(summary.total_km)}</div></div>
                <div className="flt-kpi"><div className="flt-kpi__label">تكلفة التشغيل/كم</div><div className="flt-kpi__value">{summary.cost_per_km != null ? `${fmt(summary.cost_per_km, 2)} ر.س` : '—'}</div></div>
                <div className="flt-kpi"><div className="flt-kpi__label">متوسط التكلفة/سيارة</div><div className="flt-kpi__value">{summary.avg_cost_per_vehicle != null ? `${fmt(summary.avg_cost_per_vehicle, 2)} ر.س` : '—'}</div></div>
                <div className="flt-kpi flt-kpi--danger"><div className="flt-kpi__label">صيانة متأخرة حالياً</div><div className="flt-kpi__value">{fmt(summary.overdue_count)}</div></div>
                <div className="flt-kpi flt-kpi--warn"><div className="flt-kpi__label">قريبة الاستحقاق حالياً</div><div className="flt-kpi__value">{fmt(summary.due_soon_count)}</div></div>
              </div>
            )}
            <p className="flt-hint">"كم مقطوعة" و"تكلفة التشغيل/كم" مبنية على فروقات قراءات العداد الفعلية المسجّلة داخل الفترة فقط (سيارة لها قراءة واحدة فقط في الفترة لا تُحتسب — لا يوجد فرق يُقاس). صيانة "متأخرة/قريبة الاستحقاق" حالة لحظية حسب قراءة العداد الحالية، وليست محسوبة على فترة تاريخية.</p>
          </div>

          {/* ── تقرير الصيانة ── */}
          <div className="flt-card">
            <div className="flt-card__title-row">
              <div className="flt-card__title">🔧 تقرير الصيانة</div>
              <button type="button" className="flt-btn flt-btn--sm" onClick={handleExportMaintenance} disabled={!maintReport}>⬇️ تصدير Excel</button>
            </div>
            {mLoading ? <div className="flt-loading">جاري التحميل…</div>
              : mError ? <div className="flt-error">تعذّر جلب تقرير الصيانة</div>
              : maintReport && (
              <>
                <div className="flt-profile__title">الصيانات المنفذة خلال الفترة ({maintReport.done.length})</div>
                <div className="flt-table-wrap">
                  <table className="flt-table">
                    <thead><tr><th>التاريخ</th><th>رقم اللوحة</th><th>التصنيف</th><th>المنطقة</th><th>نوع الصيانة</th><th>العداد وقتها</th><th>التكلفة</th><th>المورّد</th></tr></thead>
                    <tbody>
                      {!maintReport.done.length && <tr><td colSpan={8} className="flt-empty">لا توجد صيانات منفذة في هذه الفترة</td></tr>}
                      {maintReport.done.map(d => (
                        <tr key={d.id}>
                          <td>{d.service_date}</td><td className="flt-td-bold">{d.plate_number}</td>
                          <td>{d.category ? catLabel(d.category) : '—'}</td><td>{d.region_name || '—'}</td>
                          <td>{d.type_name}</td><td className="flt-td-num">{fmt(d.odometer_km)} كم</td>
                          <td className="flt-td-num">{fmt(d.cost, 2)} ر.س</td><td>{d.vendor || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flt-profile__title" style={{ marginTop: 14 }}>الصيانات القادمة/المستحقة حالياً ({maintReport.upcoming.length})</div>
                <div className="flt-table-wrap">
                  <table className="flt-table">
                    <thead><tr><th>رقم اللوحة</th><th>التصنيف</th><th>المنطقة</th><th>نوع الصيانة</th><th>منذ آخر خدمة</th><th>الفترة</th><th>الحالة</th></tr></thead>
                    <tbody>
                      {!maintReport.upcoming.length && <tr><td colSpan={7} className="flt-empty">لا توجد صيانات مستحقة أو قريبة الاستحقاق ضمن هذا الفلتر ✅</td></tr>}
                      {maintReport.upcoming.map((u, i) => (
                        <tr key={i}>
                          <td className="flt-td-bold">{u.plate_number}</td>
                          <td>{u.category ? catLabel(u.category) : '—'}</td><td>{u.region_name || '—'}</td>
                          <td>{u.type_name}</td><td className="flt-td-num">{fmt(u.km_since_service)} كم</td>
                          <td className="flt-td-num">{fmt(u.interval_km)} كم</td>
                          <td>{u.alert_level === 'overdue'
                            ? <span className="flt-badge flt-badge--danger">متأخرة ({fmt(u.km_overdue_by)} كم)</span>
                            : <span className="flt-badge flt-badge--warn">قريبة الاستحقاق</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {/* ── تقرير المصروفات ── */}
          <div className="flt-card">
            <div className="flt-card__title-row">
              <div className="flt-card__title">💰 تقرير المصروفات</div>
              <button type="button" className="flt-btn flt-btn--sm" onClick={handleExportExpenses} disabled={!expReport}>⬇️ تصدير Excel</button>
            </div>
            {eLoading ? <div className="flt-loading">جاري التحميل…</div>
              : eError ? <div className="flt-error">تعذّر جلب تقرير المصروفات</div>
              : expReport && (
              <>
                <div className="flt-bar-list">
                  {expReport.by_category.map(c => (
                    <div className="flt-bar-row" key={c.category}>
                      <span className="flt-bar-label">{expReport.expense_category_labels?.[c.category] || c.category} ({fmt(c.n)})</span>
                      <span className="flt-bar-value">{fmt(c.total, 2)} ر.س</span>
                    </div>
                  ))}
                  {!expReport.by_category.length && <div className="flt-empty">لا توجد مصروفات في هذه الفترة</div>}
                  {!!expReport.by_category.length && (
                    <div className="flt-bar-row flt-bar-row--total">
                      <span className="flt-bar-label">الإجمالي</span>
                      <span className="flt-bar-value">{fmt(expReport.by_category.reduce((s, c) => s + Number(c.total), 0), 2)} ر.س</span>
                    </div>
                  )}
                </div>

                {!!expReport.by_vehicle.length && (
                  <>
                    <div className="flt-profile__title" style={{ marginTop: 14 }}>أعلى 20 سيارة إنفاقًا</div>
                    <div className="flt-table-wrap">
                      <table className="flt-table">
                        <thead><tr><th>رقم اللوحة</th><th>التصنيف</th><th>عدد المصاريف</th><th>الإجمالي</th></tr></thead>
                        <tbody>
                          {expReport.by_vehicle.map(v => (
                            <tr key={v.vehicle_id}>
                              <td className="flt-td-bold">{v.plate_number}</td>
                              <td>{v.category ? catLabel(v.category) : '—'}</td>
                              <td className="flt-td-num">{fmt(v.n)}</td>
                              <td className="flt-td-num">{fmt(v.total, 2)} ر.س</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                <div className="flt-profile__title" style={{ marginTop: 14 }}>سجل المصروفات ({expReport.rows.length})</div>
                <div className="flt-table-wrap">
                  <table className="flt-table">
                    <thead><tr><th>التاريخ</th><th>رقم اللوحة</th><th>التصنيف</th><th>المنطقة</th><th>البند</th><th>القيمة</th><th>ملاحظات</th></tr></thead>
                    <tbody>
                      {!expReport.rows.length && <tr><td colSpan={7} className="flt-empty">لا توجد مصروفات مسجلة في هذه الفترة</td></tr>}
                      {expReport.rows.map(e => (
                        <tr key={e.id}>
                          <td>{e.expense_date}</td><td className="flt-td-bold">{e.plate_number}</td>
                          <td>{e.category ? catLabel(e.category) : '—'}</td><td>{e.region_name || '—'}</td>
                          <td>{expReport.expense_category_labels?.[e.expense_category] || e.expense_category}</td>
                          <td className="flt-td-num">{fmt(e.amount, 2)} ر.س</td><td>{e.notes || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
