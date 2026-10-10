import { replaceOnce } from './frontend-overlay.mjs';

// Apply only to the copied desktop reader. The shared web source remains intact.
export function overlayDesktopShortcuts(file, source) {
  if (file !== 'screens/reader.js') return source;
  return replaceOnce(source, `    if (e.defaultPrevented) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ($('#modalRoot .modal-backdrop')) return;`, `    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const keyTargets = e.composedPath ? e.composedPath() : [e.target];
    if (keyTargets.some(node => node && (['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) || node.isContentEditable))) return;
    if ($('#modalRoot .modal-backdrop')) return;`, 'desktop reader shortcut boundaries');
}
