import { useContext } from 'react';
import { ToastContext } from '../components/UI/Toast';

/**
 * Returns the `push(toast)` function from ToastContext.
 * Usage:  const toast = useToast();
 *         toast({ kind: 'success', title: 'Done', message: 'All good' });
 */
export default function useToast() {
  return useContext(ToastContext);
}
