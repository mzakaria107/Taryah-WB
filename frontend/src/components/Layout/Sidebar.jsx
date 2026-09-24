import React, { useState, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { UserSearch, ChevronRight, ChevronLeft, ChevronDown, GripVertical, Settings2, X, Check, FolderPlus, Folder, Trash2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { usePermissions } from '../../context/PermissionsContext';
import { useSidebarOrder } from '../../context/SidebarOrderContext';
import { useLanguage } from '../../context/LanguageContext';
import { ALL_NAV, NAV_BY_KEY, buildSidebarLayout } from '../../data/navConfig';

const ADMIN_ROLES = ['super_admin', 'it_admin'];

/* Per-browser (not per-user-account) memory of which groups the viewer
   collapsed — this is a personal viewing preference, distinct from the
   admin-defined GROUPING itself (which is shared/server-persisted via
   sidebar_order, same as plain reordering always was). */
function loadCollapsedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem('sidebar_collapsed_groups') || '[]')); }
  catch { return new Set(); }
}
function saveCollapsedGroups(set) {
  try { localStorage.setItem('sidebar_collapsed_groups', JSON.stringify([...set])); } catch {}
}

/* ── draftOrder helpers (reorder modal) ───────────────────────────
   draftOrder is a flat array whose entries are either a pageKey string
   (ungrouped item) or a group node { type:'group', id, label, keys:[] }.
   Top-level drag-and-drop (existing onDragStart/onDragOver below)
   reorders this array directly — a group is just another entry in it.
   Moving an item INTO/OUT OF a group is done via a per-item "move to"
   select instead of nested drag-and-drop, to keep the interaction model
   simple. ── */
function removeKeyFromOrder(order, key) {
  return order
    .filter(e => e !== key)
    .map(e => (e && e.type === 'group') ? { ...e, keys: e.keys.filter(k => k !== key) } : e);
}
function moveKeyToGroup(order, key, groupId) {
  const without = removeKeyFromOrder(order, key);
  if (!groupId) return [...without, key];
  return without.map(e => (e && e.type === 'group' && e.id === groupId)
    ? { ...e, keys: [...e.keys, key] }
    : e);
}
export default function Sidebar({ collapsed, onToggle }) {
  const { user }            = useAuth();
  const { canAccess }       = usePermissions();
  const { order, saveOrder, resetOrder } = useSidebarOrder();
  const { lang, t }         = useLanguage();
  const location            = useLocation();
  const isAdmin             = user && ADMIN_ROLES.includes(user.role);
  const navLabel            = n => (lang === 'en' ? (n.labelEn || n.label) : n.label);

  /* ── Reorder modal state ──────────────────────────── */
  const [showReorder, setShowReorder] = useState(false);
  const [draftOrder, setDraftOrder]   = useState([]);
  const [saving, setSaving]           = useState(false);
  const dragIdx = useRef(null);

  /* ── Collapsed-group viewing state (sidebar itself, not the modal) ── */
  const [collapsedGroups, setCollapsedGroups] = useState(loadCollapsedGroups);
  const toggleGroupCollapsed = (id) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      saveCollapsedGroups(next);
      return next;
    });
  };

  /* ── Derived nav ──────────────────────────────────── */
  const layout = buildSidebarLayout(ALL_NAV, order)
    .map(node => node.type === 'group'
      ? { ...node, items: node.items.filter(nav => user && canAccess(user.role, nav.pageKey)) }
      : node)
    .filter(node => node.type === 'group' ? node.items.length > 0 : (user && canAccess(user.role, node.nav.pageKey)));
  const onCustomerPage = location.pathname.startsWith('/customers/');

  /* ── Modal controls ───────────────────────────────── */
  function normalizeOrder(raw) {
    const base = raw && raw.length ? [...raw] : ALL_NAV.map(n => n.pageKey);
    const covered = new Set();
    base.forEach(e => {
      if (typeof e === 'string') covered.add(e);
      else if (e && e.type === 'group') (e.keys || []).forEach(k => covered.add(k));
    });
    ALL_NAV.forEach(n => { if (!covered.has(n.pageKey)) base.push(n.pageKey); });
    return base;
  }
  function openReorder() {
    setDraftOrder(normalizeOrder(order));
    setShowReorder(true);
  }
  async function handleSave() {
    setSaving(true);
    try { await saveOrder(draftOrder); } finally { setSaving(false); }
    setShowReorder(false);
  }
  async function handleReset() {
    setSaving(true);
    try { await resetOrder(); } finally { setSaving(false); }
    setDraftOrder(ALL_NAV.map(n => n.pageKey));
    setShowReorder(false);
  }
  function handleCancel() { setShowReorder(false); }

  function handleCreateGroup() {
    const name = window.prompt(t('newGroupPrompt'));
    if (!name || !name.trim()) return;
    const id = `grp_${Date.now()}`;
    setDraftOrder(prev => [...prev, { type: 'group', id, label: name.trim(), keys: [] }]);
  }
  function handleRenameGroup(id, label) {
    setDraftOrder(prev => prev.map(e => (e && e.type === 'group' && e.id === id) ? { ...e, label } : e));
  }
  function handleDeleteGroup(id) {
    setDraftOrder(prev => {
      const idx = prev.findIndex(e => e && e.type === 'group' && e.id === id);
      if (idx === -1) return prev;
      const grp = prev[idx];
      const without = prev.filter((_, i) => i !== idx);
      without.splice(idx, 0, ...grp.keys);
      return without;
    });
  }
  function handleMoveToGroup(key, groupId) {
    setDraftOrder(prev => moveKeyToGroup(prev, key, groupId || null));
  }

  /* ── HTML5 Drag-and-drop (top-level entries only — items OR whole
       group boxes; reordering WITHIN a group is not supported, use the
       "move to" select to relocate an item instead) ── */
  function onDragStart(e, idx) {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  }
  function onDragOver(e, idx) {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === idx) return;
    const updated = [...draftOrder];
    const [moved] = updated.splice(dragIdx.current, 1);
    updated.splice(idx, 0, moved);
    dragIdx.current = idx;
    setDraftOrder(updated);
  }
  function onDragEnd() { dragIdx.current = null; }

  const groupOptions = draftOrder.filter(e => e && e.type === 'group');

  return (
    <>
      {/* ── Sidebar ─────────────────────────────────── */}
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        <button
          className="sidebar-collapse-btn"
          onClick={onToggle}
          aria-label={collapsed ? t('expandMenu') : t('collapseMenu')}
        >
          {collapsed ? <ChevronLeft size={16}/> : <ChevronRight size={16}/>}
        </button>

        <nav className="sidebar-nav" aria-label={t('mainNav')}>
          <div className="sidebar-section">{t('menu')}</div>

          {layout.map(node => node.type === 'item' ? (
            <NavLink
              key={node.nav.to}
              to={node.nav.to}
              end={node.nav.to === '/'}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              title={collapsed ? navLabel(node.nav) : undefined}
            >
              {node.nav.icon(18)}
              <span className="sidebar-link-label">{navLabel(node.nav)}</span>
            </NavLink>
          ) : (
            <div key={node.id} className="sidebar-group">
              <button
                type="button"
                className="sidebar-group-header"
                onClick={() => toggleGroupCollapsed(node.id)}
                title={collapsed ? node.label : undefined}
              >
                <Folder size={16} className="sidebar-group-icon"/>
                <span className="sidebar-link-label sidebar-group-label">{node.label}</span>
                {!collapsed && (
                  <ChevronDown
                    size={14}
                    className={`sidebar-group-chevron${collapsedGroups.has(node.id) ? ' collapsed' : ''}`}
                  />
                )}
              </button>
              {!collapsedGroups.has(node.id) && node.items.map(nav => (
                <NavLink
                  key={nav.to}
                  to={nav.to}
                  className={({ isActive }) => `sidebar-link sidebar-link--nested${isActive ? ' active' : ''}`}
                  title={collapsed ? navLabel(nav) : undefined}
                >
                  {nav.icon(18)}
                  <span className="sidebar-link-label">{navLabel(nav)}</span>
                </NavLink>
              ))}
            </div>
          ))}

          {onCustomerPage && (
            <>
              <div className="sidebar-section" style={{ marginTop: 8 }}>{t('customerData')}</div>
              <div className="sidebar-link active" style={{ pointerEvents: 'none' }}>
                <UserSearch size={18}/>
                <span className="sidebar-link-label">{t('customerProfile')}</span>
              </div>
            </>
          )}
        </nav>

        {/* ── Admin reorder button ─────────────────── */}
        {isAdmin && (
          <button
            className={`sidebar-reorder-btn${collapsed ? ' sidebar-reorder-btn--icon' : ''}`}
            onClick={openReorder}
            title={t('reorderMenu')}
          >
            <Settings2 size={15}/>
            {!collapsed && <span>{t('reorderMenu')}</span>}
          </button>
        )}
      </aside>

      {/* ── Reorder modal ───────────────────────────── */}
      {showReorder && (
        <div className="sro-overlay" onClick={handleCancel}>
          <div className="sro-modal" onClick={e => e.stopPropagation()}>

            <div className="sro-header">
              <Settings2 size={17}/>
              <span>{t('reorderTitle')}</span>
              <button className="sro-close" onClick={handleCancel} aria-label={t('close')}>
                <X size={16}/>
              </button>
            </div>

            <p className="sro-hint">{t('reorderHint')}</p>

            <button type="button" className="sro-new-group-btn" onClick={handleCreateGroup}>
              <FolderPlus size={15}/> {t('newGroup')}
            </button>

            <ul className="sro-list">
              {draftOrder.map((entry, idx) => {
                if (typeof entry === 'string') {
                  const item = NAV_BY_KEY[entry];
                  if (!item) return null;
                  return (
                    <li
                      key={entry}
                      className="sro-item"
                      draggable
                      onDragStart={e => onDragStart(e, idx)}
                      onDragOver={e  => onDragOver(e, idx)}
                      onDragEnd={onDragEnd}
                    >
                      <GripVertical size={16} className="sro-grip"/>
                      <span className="sro-item-icon">{item.icon(18)}</span>
                      <span className="sro-item-label">{navLabel(item)}</span>
                      {groupOptions.length > 0 && (
                        <select
                          className="sro-move-select"
                          value=""
                          onChange={e => handleMoveToGroup(entry, e.target.value)}
                        >
                          <option value="" disabled>{t('moveToGroup')}…</option>
                          {groupOptions.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
                        </select>
                      )}
                    </li>
                  );
                }
                // Group node
                return (
                  <li
                    key={entry.id}
                    className="sro-group"
                    draggable
                    onDragStart={e => onDragStart(e, idx)}
                    onDragOver={e  => onDragOver(e, idx)}
                    onDragEnd={onDragEnd}
                  >
                    <div className="sro-group-header">
                      <GripVertical size={16} className="sro-grip"/>
                      <Folder size={16} className="sro-item-icon"/>
                      <input
                        type="text" className="sro-group-name-input"
                        value={entry.label}
                        placeholder={t('groupNamePlaceholder')}
                        onChange={e => handleRenameGroup(entry.id, e.target.value)}
                      />
                      <button type="button" className="sro-group-delete" title={t('deleteGroup')} onClick={() => handleDeleteGroup(entry.id)}>
                        <Trash2 size={14}/>
                      </button>
                    </div>
                    {entry.keys.length === 0 ? (
                      <div className="sro-group-empty">—</div>
                    ) : entry.keys.map(key => {
                      const item = NAV_BY_KEY[key];
                      if (!item) return null;
                      return (
                        <div key={key} className="sro-item sro-item--nested">
                          <span className="sro-item-icon">{item.icon(16)}</span>
                          <span className="sro-item-label">{navLabel(item)}</span>
                          <select
                            className="sro-move-select"
                            value={entry.id}
                            onChange={e => handleMoveToGroup(key, e.target.value)}
                          >
                            <option value="">{t('ungrouped')}</option>
                            {groupOptions.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
                          </select>
                        </div>
                      );
                    })}
                  </li>
                );
              })}
            </ul>

            <div className="sro-footer">
              <button className="sro-btn sro-btn--save" onClick={handleSave} disabled={saving}>
                <Check size={15}/> {saving ? t('saving') : t('saveOrder')}
              </button>
              <button className="sro-btn sro-btn--reset" onClick={handleReset} disabled={saving} title={t('resetTitle')}>
                {t('reset')}
              </button>
              <button className="sro-btn sro-btn--cancel" onClick={handleCancel} disabled={saving}>
                {t('cancel')}
              </button>
            </div>

          </div>
        </div>
      )}
    </>
  );
}
