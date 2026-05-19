import React from 'react';
import './Skeleton.css';

/**
 * Shimmer skeleton block.
 * @param {number|string} width   CSS width  (default: '100%')
 * @param {number|string} height  CSS height (default: 16)
 * @param {number|string} radius  border-radius (default: var(--radius-sm))
 * @param {string}        className extra classes
 */
export default function Skeleton({
  width = '100%',
  height = 16,
  radius,
  className = '',
  style = {},
}) {
  return (
    <div
      className={`skeleton ${className}`}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: radius ?? 'var(--radius-sm)',
        ...style,
      }}
      aria-hidden="true"
    />
  );
}

/** Pre-made skeleton row for the invoice table */
export function SkeletonRow() {
  return (
    <tr className="skeleton-row">
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Skeleton width={36} height={36} radius="50%" />
          <Skeleton width={140} height={13} />
        </div>
      </td>
      <td><Skeleton width={80} height={12} /></td>
      <td><Skeleton width={90} height={12} /></td>
      <td><Skeleton width={90} height={12} /></td>
      <td><Skeleton width={90} height={12} /></td>
      <td><Skeleton width={120} height={12} /></td>
      <td><Skeleton width={64} height={20} radius={999} /></td>
      <td><Skeleton width={140} height={28} /></td>
    </tr>
  );
}
