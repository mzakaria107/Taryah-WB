import React from 'react';
import './EmptyState.css';

/**
 * Centered empty state with icon, title, and optional subtitle.
 */
export default function EmptyState({ icon, title, sub }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state__icon">{icon}</div>}
      <div className="empty-state__title">{title}</div>
      {sub && <div className="empty-state__sub">{sub}</div>}
    </div>
  );
}
