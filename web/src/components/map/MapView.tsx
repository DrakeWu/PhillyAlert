import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 finds its worker next to its own module, which doesn't survive bundling.
// Let Vite build the worker as its own chunk and hand MapLibre the URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { HEX_AREA_KM2, PALETTE, R311_WINDOW, type Layers, type MapHandle, type Metric } from './palette';
import type { Position } from 'geojson';
import { cellDay, type Detection, type Incident } from '@/lib/detect';
import type { CityData } from '@/lib/data';
import type { Report } from '@/lib/phl311';
import { fmtDate, num, pct, pts, SEV_COLOR, SEV_LABEL } from '@/lib/format';
import { useDark } from '@/hooks/use-dark';

maplibregl.setWorkerUrl(workerUrl);

const STYLE_URL = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};

/** CARTO's basemap, re-inked to sit on the site's paper instead of stock gray. */
async function loadBasemap(dark: boolean): Promise<StyleSpecification | string> {
  const url = dark ? STYLE_URL.dark : STYLE_URL.light;
  try {
    const style: StyleSpecification = await fetch(url).then((r) => r.json());
    const c = (dark ? PALETTE.dark : PALETTE.light).base;
    for (const l of style.layers) {
      if (l.type === 'background') l.paint = { ...l.paint, 'background-color': c.bg };
      else if (l.type === 'fill') {
        const color = /water/.test(l.id) ? c.water
          : /park|wood|grass|landcover|nature/.test(l.id) ? c.park
          : /building/.test(l.id) ? c.building
          : /landuse|residential/.test(l.id) ? c.landuse : null;
        if (color) l.paint = { ...l.paint, 'fill-color': color };
      }
    }
    return style;
  } catch {
    return url;
  }
}

type Props = {
  ref?: Ref<MapHandle>;
  data: CityData;
  det: Detection;
  day: number;
  metric: Metric;
  layers: Layers;
  kMin: number;
  incidents: Incident[];
  openIncident: number | null;
  selectedCell: number | null;
  reports: Report[] | null;
  padding: maplibregl.PaddingOptions;
  onSelectCell: (id: number | null) => void;
  onSelectIncident: (id: number) => void;
};

export function MapView(props: Props) {
  const { ref, data, det, day, metric, layers, kMin, incidents, openIncident, selectedCell, reports, padding } = props;
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef(new Map<number, maplibregl.Marker>());
  const latest = useRef(props);
  latest.current = props;
  const [styleVersion, setStyleVersion] = useState(0);
  const dark = useDark();
  const pal = dark ? PALETTE.dark : PALETTE.light;

  const cityBounds = (): [[number, number], [number, number]] => {
    const g = data.city.geometry;
    const ring = (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0]) as Position[];
    const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
    return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
  };

  // Once anyone (user or app) has moved the camera, stop re-fitting the city on resize.
  const userMoved = useRef(false);
  useImperativeHandle(ref, () => ({
    fitBounds: (b, maxZoom = 14) => {
      userMoved.current = true;
      mapRef.current?.fitBounds(b, { padding: latest.current.padding, maxZoom });
    },
    fitCity: () => {
      userMoved.current = false;
      mapRef.current?.fitBounds(cityBounds(), { padding: latest.current.padding });
    },
  }));

  // ---- create the map once
  useEffect(() => {
    let cancelled = false;
    let map: maplibregl.Map | null = null;
    const ro = new ResizeObserver(() => {
      map?.resize();
      if (map && !userMoved.current) map.fitBounds(cityBounds(), { padding: latest.current.padding, animate: false });
    });
    const markerMap = markers.current;
    loadBasemap(document.documentElement.classList.contains('dark')).then((style) => {
      if (cancelled || !container.current) return;
      map = new maplibregl.Map({
        container: container.current,
        style,
        bounds: cityBounds(),
        fitBoundsOptions: { padding: latest.current.padding },
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
      });
      mapRef.current = map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
      map.on('style.load', () => { addLayers(map!); setStyleVersion((v) => v + 1); });
      map.on('movestart', (e) => { if ((e as { originalEvent?: Event }).originalEvent) userMoved.current = true; });
      wireInteraction(map);
      ro.observe(container.current);
    });
    return () => {
      cancelled = true;
      ro.disconnect();
      markerMap.forEach((m) => m.remove());
      markerMap.clear();
      map?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- theme switch: re-ink the basemap (layers are re-added on style.load)
  const firstTheme = useRef(dark);
  useEffect(() => {
    if (firstTheme.current === dark) return;
    firstTheme.current = dark;
    loadBasemap(dark).then((style) => mapRef.current?.setStyle(style));
  }, [dark]);

  function addLayers(map: maplibregl.Map) {
    const p = document.documentElement.classList.contains('dark') ? PALETTE.dark : PALETTE.light;
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    map.addSource('cells', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: data.model.cells.map((c) => ({ type: 'Feature', id: c.id, properties: { id: c.id }, geometry: { type: 'Polygon', coordinates: [c.poly] } })),
      },
    });
    map.addSource('hoods', { type: 'geojson', data: data.hoods });
    map.addSource('city', { type: 'geojson', data: data.city });
    map.addSource('r311', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const sc = data.model.meta.scenario;
    map.addSource('flood', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: (sc?.flood.points ?? []).map(([lon, lat]) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } })) },
    });
    map.addSource('hwm', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: (sc?.hwms ?? []).map((h, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: [h.lon, h.lat] } })) },
    });
    const hidden: ExpressionSpecification = ['boolean', ['feature-state', 'hidden'], false];
    const flag: ExpressionSpecification = ['coalesce', ['feature-state', 'flag'], 0];
    map.addLayer({ id: 'cells-fill', type: 'fill', source: 'cells', paint: { 'fill-color': p.mid, 'fill-opacity': 0 } }, before);
    // Flooded ground is sampled every ~30 m; at street zoom the dots grow into a continuous sheet.
    map.addLayer({
      id: 'flood-pts', type: 'circle', source: 'flood',
      paint: {
        'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, 1, 13, 1.6, 15, 4.8, 17, 19],
        'circle-color': p.flood, 'circle-opacity': 0.5, 'circle-blur': 0.4,
      },
    }, before);
    map.addLayer({ id: 'cells-edge', type: 'line', source: 'cells', paint: { 'line-color': p.paper, 'line-width': 0.5, 'line-opacity': ['case', hidden, 0, 0.55] } }, before);
    map.addLayer({ id: 'hoods-line', type: 'line', source: 'hoods', paint: { 'line-color': p.ink, 'line-width': 0.8, 'line-opacity': 0.4 } }, before);
    map.addLayer({ id: 'city-line', type: 'line', source: 'city', paint: { 'line-color': p.ink, 'line-width': 1.4, 'line-opacity': 0.7 } }, before);
    map.addLayer({
      id: 'cells-flag', type: 'line', source: 'cells',
      paint: { 'line-color': ['case', ['==', flag, 1], p.gain, p.loss], 'line-width': 1.6, 'line-opacity': ['case', ['!=', flag, 0], 1, 0] },
    });
    map.addLayer({
      id: 'cells-selected', type: 'line', source: 'cells',
      paint: { 'line-color': p.ink, 'line-width': 2.6, 'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0] },
    });
    map.addLayer({
      id: 'r311-pts', type: 'circle', source: 'r311',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.8, 12, 3, 15, 5.5],
        'circle-color': p.ink,
        'circle-stroke-color': p.paper,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 13, 1.5],
      },
    });
    map.addLayer({
      id: 'hwm-pts', type: 'circle', source: 'hwm',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.6, 13, 4, 16, 6],
        'circle-color': p.paper,
        'circle-stroke-color': p.flood,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1.6, 13, 2.4],
      },
    });
  }

  function wireInteraction(map: maplibregl.Map) {
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: '260px' });
    const row = (k: string, v: string) => `<div style="display:flex;justify-content:space-between;gap:14px;color:hsl(var(--ink-2))">${k}<b style="color:hsl(var(--ink));font-family:'IBM Plex Mono',monospace;font-weight:500">${v}</b></div>`;
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    map.on('mousemove', (e) => {
      const s = latest.current;
      const hwm = s.layers.hwm ? map.queryRenderedFeatures(e.point, { layers: ['hwm-pts'] })[0] : undefined;
      const mark = hwm ? s.data.model.meta.scenario?.hwms[hwm.properties.i as number] : undefined;
      if (mark) {
        popup.setLngLat(e.lngLat).setHTML(
          `<div style="font-weight:600;margin-bottom:3px">USGS high-water mark${mark.label ? ` · ${esc(mark.label)}` : ''}</div>` +
          row('Water above ground', mark.depthFt != null ? `${mark.depthFt} ft` : 'not measured') +
          (mark.note ? `<div style="color:hsl(var(--ink-2));margin-top:2px">${esc(mark.note)}</div>` : '')).addTo(map);
        map.getCanvas().style.cursor = 'default';
        return;
      }
      const f311 = s.layers.r311 && s.reports ? map.queryRenderedFeatures(e.point, { layers: ['r311-pts'] })[0] : undefined;
      if (f311 && s.reports) {
        const r = s.reports[f311.properties.i as number];
        popup.setLngLat(e.lngLat).setHTML(
          `<div style="font-weight:600;margin-bottom:3px">${esc(r.service)}</div>` +
          row('Filed', fmtDate(r.date, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) +
          row('Status', esc(r.status)) + (r.address ? `<div style="color:hsl(var(--ink-2));margin-top:2px">${esc(r.address)}</div>` : '')).addTo(map);
        map.getCanvas().style.cursor = 'pointer';
        return;
      }
      const f = s.layers.cells ? map.queryRenderedFeatures(e.point, { layers: ['cells-fill'] })[0] : undefined;
      const c = f ? s.data.model.cells[f.properties.id as number] : undefined;
      if (!c || c.baseline < s.kMin) { popup.remove(); map.getCanvas().style.cursor = ''; return; }
      const st = cellDay(c, s.day, s.det.city);
      popup.setLngLat(e.lngLat).setHTML(
        `<div style="font-weight:600;margin-bottom:3px">${esc(c.hood)}</div>` +
        row('Routers in baseline', num(c.baseline)) + row('Still visible', pct(st.surv, 1)) +
        row('City median', pct(s.det.city.surv[s.day], 1)) + row('Difference', `${pts(st.excess)} (z ${st.z.toFixed(1)})`) +
        row('New routers', pct(st.fresh, 1))).addTo(map);
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseout', () => popup.remove());
    map.on('click', (e) => {
      const s = latest.current;
      const f = s.layers.cells ? map.queryRenderedFeatures(e.point, { layers: ['cells-fill'] })[0] : undefined;
      const c = f ? s.data.model.cells[f.properties.id as number] : undefined;
      s.onSelectCell(c && c.baseline >= s.kMin && s.selectedCell !== c.id ? c.id : null);
    });
  }

  // ---- metric paint
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('cells-fill')) return;
    const v: ExpressionSpecification = ['coalesce', ['feature-state', 'v'], 0];
    const hidden: ExpressionSpecification = ['boolean', ['feature-state', 'hidden'], false];
    if (metric === 'density') {
      const [a, b, c, d, e] = pal.seq;
      map.setPaintProperty('cells-fill', 'fill-color', ['interpolate', ['linear'], v, 0, a, 400, b, 900, c, 1600, d, 2400, e]);
      map.setPaintProperty('cells-fill', 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 12, ['case', hidden, 0, 0.7], 15, ['case', hidden, 0, 0.4]]);
    } else {
      const [r0, r1, r2, r3] = pal.red, [b0, b1, b2, b3] = pal.blue;
      map.setPaintProperty('cells-fill', 'fill-color', ['interpolate', ['linear'], v,
        -0.45, r0, -0.25, r1, -0.12, r2, -0.04, r3, 0, pal.mid, 0.04, b0, 0.12, b1, 0.25, b2, 0.45, b3]);
      // Strong at city scale; thinner at street level so the streets underneath stay readable.
      const byValue: ExpressionSpecification = ['case', hidden, 0,
        ['interpolate', ['linear'], ['abs', v], 0, 0.04, 0.03, 0.1, 0.08, 0.45, 0.15, 0.7, 0.3, 0.88]];
      map.setPaintProperty('cells-fill', 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 12, byValue, 15, ['*', 0.55, byValue]]);
    }
  }, [metric, pal, styleVersion]);

  // ---- per-cell state for the selected day
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getSource('cells')) return;
    const area = HEX_AREA_KM2(data.model.meta.hexSizeM);
    const flags = det.flags[day];
    for (const c of data.model.cells) {
      const hidden = c.baseline < kMin;
      const st = cellDay(c, day, det.city);
      const v = metric === 'excess' ? st.excess : metric === 'gain' ? st.gain : c.baseline / area;
      map.setFeatureState({ source: 'cells', id: c.id }, { v, hidden, flag: hidden ? 0 : flags[c.id], selected: c.id === selectedCell });
    }
    map.setFilter('r311-pts', ['all', ['>=', ['get', 'day'], day - R311_WINDOW + 1], ['<=', ['get', 'day'], day]]);
  }, [data, det, day, metric, kMin, selectedCell, styleVersion]);

  // ---- layer visibility
  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('cells-fill')) return;
    const vis = (on: boolean) => (on ? 'visible' : 'none');
    map.setLayoutProperty('cells-fill', 'visibility', vis(layers.cells));
    map.setLayoutProperty('cells-edge', 'visibility', vis(layers.cells));
    map.setLayoutProperty('cells-flag', 'visibility', vis(layers.flags));
    map.setLayoutProperty('hoods-line', 'visibility', vis(layers.hoods));
    map.setLayoutProperty('r311-pts', 'visibility', vis(layers.r311));
    map.setLayoutProperty('flood-pts', 'visibility', vis(layers.flood));
    map.setLayoutProperty('hwm-pts', 'visibility', vis(layers.hwm));
  }, [layers, styleVersion]);

  // ---- 311 points
  useEffect(() => {
    const src = mapRef.current?.getSource('r311') as maplibregl.GeoJSONSource | undefined;
    if (!src || !reports) return;
    src.setData({
      type: 'FeatureCollection',
      features: reports.map((r, i) => ({ type: 'Feature', id: i, properties: { i, day: r.day }, geometry: { type: 'Point', coordinates: [r.lon, r.lat] } })),
    });
  }, [reports, styleVersion]);

  // ---- incident markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shown = new Set<number>();
    for (const inc of incidents) {
      if (!inc.active || !layers.markers) continue;
      shown.add(inc.id);
      let m = markers.current.get(inc.id);
      if (!m) {
        const el = document.createElement('button');
        el.type = 'button';
        el.addEventListener('click', (e) => { e.stopPropagation(); latest.current.onSelectIncident(Number(el.dataset.id)); });
        m = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat(inc.center).addTo(map);
        markers.current.set(inc.id, m);
      }
      const el = m.getElement();
      el.dataset.id = String(inc.id);
      // Add to (never replace) MapLibre's classes and inline transform, which position the marker.
      el.classList.add('pp-marker');
      el.classList.toggle('is-open', openIncident === inc.id);
      el.style.setProperty('--sev', SEV_COLOR[inc.severity]);
      const sq = document.createElement('span');
      sq.className = 'pp-marker-sq';
      el.replaceChildren(sq, inc.hoods[0]);
      el.title = `${SEV_LABEL[inc.severity]}: ${inc.hoods.slice(0, 2).join(' & ')}`;
      el.setAttribute('aria-label', el.title);
      m.setLngLat(inc.center);
    }
    for (const [id, m] of markers.current) if (!shown.has(id)) { m.remove(); markers.current.delete(id); }
  }, [incidents, openIncident, layers.markers, pal, styleVersion]);

  // re-fit when the padding changes (e.g. layout switches between phone and desktop)
  const padKey = JSON.stringify(padding);
  useEffect(() => { mapRef.current?.resize(); }, [padKey]);

  // MapLibre's CSS forces `position: relative` on its container, so the sizing lives on a wrapper.
  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" aria-label="Map of Philadelphia" role="region" />
    </div>
  );
}
