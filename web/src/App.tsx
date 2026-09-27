import { lazy, Suspense, useEffect, useState } from 'react';
import { Landing } from '@/pages/Landing';

// The map page pulls in MapLibre (~1 MB); load it only when someone opens the map.
const MapPage = lazy(() => import('@/pages/MapPage').then((m) => ({ default: m.MapPage })));

// Hash routing keeps the build deployable as static files (GitHub Pages, any folder).
const isMap = () => window.location.hash.startsWith('#/map');

export default function App() {
  const [map, setMap] = useState(isMap);
  useEffect(() => {
    const on = () => {
      const next = isMap();
      setMap((prev) => {
        if (prev !== next) window.scrollTo(0, 0);
        return next;
      });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    document.title = map ? 'Map · PhillyAlert' : 'PhillyAlert';
  }, [map]);
  if (!map) return <Landing />;
  return (
    <Suspense fallback={<div className="grid h-dvh place-items-center font-mono text-sm text-muted-foreground">Loading the map…</div>}>
      <MapPage />
    </Suspense>
  );
}
