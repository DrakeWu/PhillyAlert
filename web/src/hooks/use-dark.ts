import { useSyncExternalStore } from 'react';

// index.html toggles the `dark` class on <html> from the OS setting; this hook follows that class.
function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => mo.disconnect();
}

export function useDark() {
  return useSyncExternalStore(subscribe, () => document.documentElement.classList.contains('dark'));
}
