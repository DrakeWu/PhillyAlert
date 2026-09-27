import { hydrateIcons, icon } from './icons.js';
import { buildModel, cellAt, cellDay, detect, incidentsAt } from './detect.js';
import { lineChart } from './chart.js';
import { fetch311, GROUP_LABEL } from './phl311.js';

const maplibregl = window.maplibregl;
const $ = (id) => document.getElementById(id);

const LINKS = {
  peco: 'https://www.peco.com/outages/experiencing-an-outage/outage-map',
  philly311: 'https://www.phila.gov/departments/philly311/',
};
const STYLE = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
// Diverging blue <-> red with a neutral gray midpoint; sequential blue (dataviz reference palette).
const RED = ['#a62b2b', '#e34948', '#ec8b82', '#f5c4be'];
const BLUE = ['#b7d3f6', '#6da7ec', '#2a78d6', '#184f95'];
const SEQ = ['#cde2fb', '#9ec5f4', '#5598e7', '#2a78d6', '#184f95'];
const MID = { light: '#f0efec', dark: '#383835' };
const HEX_AREA_KM2 = (km) => (3 * Math.sqrt(3) / 2) * (km / 1000) ** 2;
const R311_WINDOW = 14;

const SEV = {
  critical: { label: 'Critical', icon: 'alert-triangle' },
  serious: { label: 'Serious', icon: 'alert-triangle' },
  warning: { label: 'Watch', icon: 'alert-circle' },
  info: { label: 'Info', icon: 'users' },
  resolved: { label: 'Restored', icon: 'check-circle' },
};
const TYPE_LABEL = { outage: 'Widespread outage', localized: 'Localized loss', influx: 'Population influx' };

const state = {
  day: 0,
  metric: 'excess',
  layers: { cells: true, flags: true, markers: true, r311: false, hoods: false },
  params: { minDrop: 0.08, zThr: 4, kMin: 25 },
  selectedCell: null,
  openIncident: null,
  dismissed: new Set(),
  playing: null,
};

let model, det, hoods, cityLimits, r311 = null, r311Error = null;
let map, hoverPopup;
const markers = new Map();

// ------------------------------------------------------------------ formatting

const fmtDate = (d, opts = { month: 'short', day: 'numeric' }) => d.toLocaleDateString(undefined, opts);
const pct = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;
const pts = (v) => `${v > 0.0005 ? '+' : v < -0.0005 ? '−' : ''}${Math.abs(v * 100).toFixed(0)} pts`;
const num = (v) => v.toLocaleString();
const isDark = () => document.documentElement.dataset.theme === 'dark' ||
  (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const placeName = (inc) => inc.hoods.slice(0, 2).join(' & ');

// ------------------------------------------------------------------ boot

async function boot() {
  hydrateIcons();
  let data;
  try {
    [data, hoods, cityLimits] = await Promise.all(
      ['data/wifi_churn.json', 'data/neighborhoods.geojson', 'data/city_limits.geojson'].map((u) =>
        fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); })),
    );
  } catch (err) {
    const box = $('load-error');
    box.hidden = false;
    box.innerHTML = `<b>Couldn't load the dataset.</b><br>${esc(err.message)}<br><br>` +
      'Serve the folder over HTTP (for example <code>python -m http.server</code>), and run <code>python pipeline/build_dataset.py</code> first if <code>data/</code> is empty.';
    return;
  }
  model = buildModel(data);
  state.day = model.meta.days - 1;
  det = detect(model, state.params);

  initControls();
  initMap();
  load311();
}

// ------------------------------------------------------------------ map

function fitPadding(forIncident = false) {
  // Philadelphia runs NE-SW, so the insights card (bottom right) and the alert (top right)
  // mostly sit over New Jersey / Montgomery County; only the left panel needs real padding.
  if (innerWidth <= 900) return { top: 90, bottom: Math.round(innerHeight * 0.4) + 20, left: 20, right: 20 };
  const left = innerWidth > 1100 ? 430 : 40;
  // When zooming to an incident, keep it clear of the insights card as well.
  const right = forIncident && !$('insights').classList.contains('collapsed') && innerWidth > 1100 ? 480 : 60;
  return { top: 30, bottom: 30, left, right };
}

function cityBounds() {
  const ring = cityLimits.geometry.type === 'Polygon' ? cityLimits.geometry.coordinates[0] : cityLimits.geometry.coordinates[0][0];
  const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
  return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
}

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: isDark() ? STYLE.dark : STYLE.light,
    bounds: cityBounds(),
    fitBoundsOptions: { padding: fitPadding() },
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: '260px' });

  map.on('style.load', () => { addLayers(); render(); });

  // Keep the canvas matched to its container (e.g. a window that starts hidden or tiny), and
  // re-frame the city on resize until the user has panned or zoomed themselves.
  let userMoved = false;
  map.on('movestart', (e) => { if (e.originalEvent) userMoved = true; });
  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      map.resize();
      if (!userMoved) map.fitBounds(cityBounds(), { padding: fitPadding(), animate: false });
    }, 100);
  }).observe($('map'));
  map.on('mousemove', onHover);
  map.on('mouseout', () => hoverPopup.remove());
  map.on('click', onClick);

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    map.setStyle(isDark() ? STYLE.dark : STYLE.light);
  });
}

function firstSymbolLayer() {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}

function addLayers() {
  const before = firstSymbolLayer();
  const dark = isDark();
  const ink = dark ? '#e7e6e1' : '#1f2328';

  map.addSource('cells', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: model.cells.map((c) => ({ type: 'Feature', id: c.id, properties: { id: c.id }, geometry: { type: 'Polygon', coordinates: [c.poly] } })),
    },
  });
  map.addSource('hoods', { type: 'geojson', data: hoods });
  map.addSource('city', { type: 'geojson', data: cityLimits });
  map.addSource('r311', { type: 'geojson', data: r311Geojson() });

  const hidden = ['boolean', ['feature-state', 'hidden'], false];
  map.addLayer({ id: 'cells-fill', type: 'fill', source: 'cells', paint: { 'fill-color': MID.light, 'fill-opacity': 0 } }, before);
  map.addLayer({
    id: 'cells-edge', type: 'line', source: 'cells',
    paint: { 'line-color': dark ? '#0d0d0d' : '#ffffff', 'line-width': 0.5, 'line-opacity': ['case', hidden, 0, 0.45] },
  }, before);
  map.addLayer({
    id: 'hoods-line', type: 'line', source: 'hoods',
    layout: { visibility: state.layers.hoods ? 'visible' : 'none' },
    paint: { 'line-color': ink, 'line-width': 0.8, 'line-opacity': 0.45 },
  }, before);
  map.addLayer({
    id: 'city-line', type: 'line', source: 'city',
    paint: { 'line-color': ink, 'line-width': 1.4, 'line-opacity': 0.55 },
  }, before);
  const flag = ['coalesce', ['feature-state', 'flag'], 0];
  map.addLayer({
    id: 'cells-flag', type: 'line', source: 'cells',
    paint: {
      'line-color': ['case', ['==', flag, 1], BLUE[3], cssVar('--status-critical') || '#d03b3b'],
      'line-width': 1.6,
      'line-opacity': ['case', ['!=', flag, 0], 0.95, 0],
    },
  });
  map.addLayer({
    id: 'cells-selected', type: 'line', source: 'cells',
    paint: { 'line-color': ink, 'line-width': 2.6, 'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0] },
  });
  map.addLayer({
    id: 'r311-pts', type: 'circle', source: 'r311',
    layout: { visibility: state.layers.r311 ? 'visible' : 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.8, 12, 3, 15, 5.5],
      'circle-color': ink,
      'circle-stroke-color': dark ? '#1a1a19' : '#fcfcfb',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 13, 1.5],
      'circle-opacity': 0.85,
    },
  });
  applyMetricPaint();
  applyLayerVisibility();
}

function applyMetricPaint() {
  if (!map?.getLayer('cells-fill')) return;
  const v = ['coalesce', ['feature-state', 'v'], 0];
  const hidden = ['boolean', ['feature-state', 'hidden'], false];
  const mid = isDark() ? MID.dark : MID.light;
  let color, opacity;
  if (state.metric === 'density') {
    color = ['interpolate', ['linear'], v, 0, SEQ[0], 400, SEQ[1], 900, SEQ[2], 1600, SEQ[3], 2400, SEQ[4]];
    opacity = ['case', hidden, 0, 0.58];
  } else {
    color = ['interpolate', ['linear'], v,
      -0.45, RED[0], -0.25, RED[1], -0.12, RED[2], -0.04, RED[3], 0, mid, 0.04, BLUE[0], 0.12, BLUE[1], 0.25, BLUE[2], 0.45, BLUE[3]];
    opacity = ['case', hidden, 0, ['interpolate', ['linear'], ['abs', v], 0, 0.04, 0.03, 0.08, 0.08, 0.4, 0.15, 0.6, 0.3, 0.8]];
  }
  map.setPaintProperty('cells-fill', 'fill-color', color);
  map.setPaintProperty('cells-fill', 'fill-opacity', opacity);
  renderLegend();
}

function applyLayerVisibility() {
  if (!map?.getLayer('cells-fill')) return;
  const vis = (on) => (on ? 'visible' : 'none');
  map.setLayoutProperty('cells-fill', 'visibility', vis(state.layers.cells));
  map.setLayoutProperty('cells-edge', 'visibility', vis(state.layers.cells));
  map.setLayoutProperty('cells-flag', 'visibility', vis(state.layers.flags));
  map.setLayoutProperty('hoods-line', 'visibility', vis(state.layers.hoods));
  map.setLayoutProperty('r311-pts', 'visibility', vis(state.layers.r311));
  for (const m of markers.values()) m.getElement().style.display = state.layers.markers ? '' : 'none';
}

function r311Geojson() {
  if (!r311) return { type: 'FeatureCollection', features: [] };
  const t0 = model.dates[0].getTime();
  return {
    type: 'FeatureCollection',
    features: r311.map((r, i) => ({
      type: 'Feature', id: i,
      properties: { i, day: Math.floor((r.date.getTime() - t0) / 86400000) },
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
    })),
  };
}

// ------------------------------------------------------------------ 311

async function load311() {
  const start = model.dates[0];
  const end = new Date(model.dates[model.meta.days - 1].getTime() + 86400000);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  $('status-311').textContent = '311 feed: loading live infrastructure reports…';
  try {
    const { rows } = await fetch311(iso(start), iso(end));
    r311 = rows;
    const t0 = start.getTime();
    for (const r of r311) {
      r.day = Math.floor((r.date.getTime() - t0) / 86400000);
      r.cell = cellAt(model, r.lon, r.lat)?.id ?? null;
    }
    map?.getSource('r311')?.setData(r311Geojson());
    $('status-311').textContent = `311 feed: ${num(r311.length)} infrastructure reports since ${fmtDate(start)} (live, phl.carto.com)`;
  } catch (err) {
    r311Error = err.message;
    $('status-311').textContent = `311 feed unavailable (${err.message}). Wi‑Fi signals still work.`;
  }
  render();
}

function reportsIn(cellIds, fromDay, toDay) {
  if (!r311) return null;
  const set = new Set(cellIds);
  return r311.filter((r) => r.cell !== null && set.has(r.cell) && r.day >= fromDay && r.day <= toDay);
}

// ------------------------------------------------------------------ rendering

function render() {
  if (!model) return;
  const d = state.day;
  const incidents = incidentsAt(model, det, d);
  // If the incident the user had open doesn't exist on this day, follow the most severe one.
  if (state.openIncident !== null && !incidents.some((i) => i.id === state.openIncident)) {
    state.openIncident = incidents.find((i) => i.active)?.id ?? null;
  }

  // map state
  if (map?.getSource('cells')) {
    const areaKm2 = HEX_AREA_KM2(model.meta.hexSizeM);
    const flags = det.flags[d];
    for (const c of model.cells) {
      const hidden = c.baseline < state.params.kMin;
      const s = cellDay(c, d, det.city);
      const v = state.metric === 'excess' ? s.excess : state.metric === 'gain' ? s.gain : c.baseline / areaKm2;
      map.setFeatureState({ source: 'cells', id: c.id }, { v, hidden, flag: hidden ? 0 : flags[c.id], selected: c.id === state.selectedCell });
    }
    map.setFilter('r311-pts', ['all', ['>=', ['get', 'day'], d - R311_WINDOW + 1], ['<=', ['get', 'day'], d]]);
  }

  // header + timeline
  const date = model.dates[d];
  $('day-label').textContent = fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  $('day-count').textContent = `Day ${d + 1} of ${model.meta.days}`;
  $('day').value = d;

  // tiles
  const active = incidents.filter((i) => i.active && i.severity !== 'info');
  $('t-surv').textContent = pct(det.city.total[d]);
  $('t-flag').textContent = num(det.flags[d].reduce((a, f) => a + (f !== 0 ? 1 : 0), 0));
  $('t-inc').textContent = num(active.length);

  renderMarkers(incidents);
  renderAlert(incidents);
  renderInsights(incidents);
}

function renderLegend() {
  const bar = $('legend-bar'), labels = $('legend-labels'), cap = $('legend-caption');
  const mid = isDark() ? MID.dark : MID.light;
  if (state.metric === 'density') {
    bar.style.background = `linear-gradient(90deg, ${SEQ.join(', ')})`;
    labels.innerHTML = '<span>0</span><span>1,200</span><span>2,400+ APs/km²</span>';
    cap.textContent = 'Baseline access points per km². The sparse areas are parks, rail yards and the airport.';
  } else {
    bar.style.background = `linear-gradient(90deg, ${[...RED, mid, ...BLUE].join(', ')})`;
    labels.innerHTML = '<span>−45 pts</span><span>same as city</span><span>+45 pts</span>';
    cap.textContent = state.metric === 'excess'
      ? 'Share of baseline APs still visible, compared with the citywide control. Red means an area lost more APs than the city as a whole.'
      : 'Newly seen APs as a share of baseline, minus the citywide rate. Blue means an unusual influx, like move-in week.';
  }
}

function renderMarkers(incidents) {
  const shown = new Set();
  for (const inc of incidents) {
    if (!inc.active) continue;
    shown.add(inc.id);
    let m = markers.get(inc.id);
    if (!m) {
      const el = document.createElement('button');
      el.type = 'button';
      el.addEventListener('click', (e) => { e.stopPropagation(); openIncident(el._incId, true); });
      m = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -4] }).setLngLat(inc.center).addTo(map);
      markers.set(inc.id, m);
    }
    const el = m.getElement();
    el._incId = inc.id;
    // Only touch our own classes; MapLibre's `maplibregl-marker` class positions the element.
    el.classList.remove(...[...el.classList].filter((c) => c.startsWith('sev-')));
    el.classList.add('inc-marker', `sev-${inc.severity}`);
    el.classList.toggle('active', state.openIncident === inc.id);
    el.innerHTML = `${icon(SEV[inc.severity].icon)}<span>${esc(inc.hoods[0])}</span>`;
    el.title = `${SEV[inc.severity].label}: ${TYPE_LABEL[inc.type]}, ${placeName(inc)}`;
    el.setAttribute('aria-label', el.title);
    el.style.display = state.layers.markers ? '' : 'none';
    m.setLngLat(inc.center);
  }
  for (const [id, m] of markers) if (!shown.has(id)) { m.remove(); markers.delete(id); }
}

function headline(inc) {
  const place = placeName(inc);
  const since = fmtDate(model.dates[inc.onset]);
  const cityNow = pct(det.city.surv[state.day], 0);
  if (inc.type === 'influx') {
    return {
      title: `It looks like a lot of people just moved into ${place}.`,
      sub: `Newly seen Wi‑Fi access points are up ${pts(inc.now).replace('+', '')} over the citywide rate since ${since}, consistent with move-in week or new housing.`,
    };
  }
  if (inc.type === 'localized') {
    return {
      title: `It looks like there's localized damage in ${place}.`,
      sub: `${num(inc.apsNow)} access points in a small cluster vanished around ${since} and haven't come back. That's consistent with a fire, collapse or demolition.`,
    };
  }
  return {
    title: `It looks like there's a widespread outage in ${place}.`,
    sub: `${pct(1 - inc.surv[state.day], 0)} of baseline Wi‑Fi access points in ${inc.cellIds.length} cells have gone dark since ${since}. In the median Philadelphia cell, ${cityNow} are still visible.`,
  };
}

function renderAlert(incidents) {
  const box = $('alert');
  const top = incidents.find((i) => i.active && i.severity !== 'info' && !state.dismissed.has(i.id)) ??
    incidents.find((i) => i.active && !state.dismissed.has(i.id));
  if (!top) { box.hidden = true; box.dataset.id = ''; return; }
  if (box.dataset.id === String(top.id) && box.dataset.day === String(state.day) && !box.hidden) return;
  box.dataset.id = top.id;
  box.dataset.day = state.day;
  box.className = `alert sev-${top.severity}`;
  const { title, sub } = headline(top);
  const actions = [
    { id: 'zoom', label: 'Zoom to area', icon: 'map-pin' },
    { id: 'r311', label: 'Show 311 reports', icon: 'message' },
    top.kind < 0 ? { id: 'peco', label: 'PECO outage map', icon: 'external-link' } : null,
    { id: 'copy', label: 'Copy brief', icon: 'copy' },
  ].filter(Boolean);
  box.innerHTML = `
    <div class="alert-icon sev-tint">${icon(SEV[top.severity].icon)}</div>
    <div class="alert-body">
      <span class="sev-chip">${icon(SEV[top.severity].icon)}${SEV[top.severity].label} · ${top.status}</span>
      <div class="alert-title" style="margin-top:6px">${esc(title)}</div>
      <div class="alert-sub">${esc(sub)}</div>
      <div class="alert-actions-label">Suggested actions</div>
      <div class="alert-actions">
        ${actions.map((a) => `<button type="button" class="btn btn-sm" data-action="${a.id}"><span class="state">${icon(a.icon)}</span><span>${a.label}</span></button>`).join('')}
      </div>
    </div>
    <button type="button" class="icon-btn" data-action="dismiss" aria-label="Dismiss alert">${icon('x')}</button>`;
  box.hidden = false;
  box.querySelectorAll('[data-action]').forEach((btn) => btn.addEventListener('click', () => runAction(btn, top)));
  // On phones the actions are hidden; tapping the callout zooms to the incident instead.
  box.onclick = (e) => { if (innerWidth <= 900 && !e.target.closest('[data-action]')) openIncident(top.id, true); };
}

async function runAction(btn, inc) {
  const act = btn.dataset.action;
  if (act === 'dismiss') { state.dismissed.add(inc.id); $('alert').dataset.id = ''; render(); return; }
  const slot = btn.querySelector('.state');
  const original = slot.innerHTML;
  slot.innerHTML = '<span class="spinner"></span>';
  if (act === 'zoom') { openIncident(inc.id, true); await sleep(450); }
  if (act === 'r311') { setLayer('r311', true); openIncident(inc.id, true); await sleep(350); }
  if (act === 'peco') { window.open(LINKS.peco, '_blank', 'noopener'); await sleep(200); }
  if (act === 'copy') { await copyText(brief(inc)); await sleep(300); }
  slot.innerHTML = `<span class="done">${icon('check')}</span>`;
  setTimeout(() => { if (slot.isConnected) slot.innerHTML = original; }, 2200);
}

function brief(inc) {
  const d = state.day;
  const reports = reportsIn(inc.cellIds, Math.max(0, inc.onset - model.meta.wpsLagDays), d);
  const lines = [
    `PhillyPulse incident brief: ${TYPE_LABEL[inc.type]}, ${inc.hoods.slice(0, 3).join(', ')}`,
    `Status: ${inc.status} (${SEV[inc.severity].label}) as of ${fmtDate(model.dates[d], { month: 'long', day: 'numeric', year: 'numeric' })}`,
    `Wi-Fi signal onset: ${fmtDate(model.dates[inc.onset])} (the underlying event probably started around ${fmtDate(model.dates[Math.max(0, inc.onset - model.meta.wpsLagDays)])}, given the positioning-database lag)`,
    inc.kind < 0
      ? `Affected: ${inc.cellIds.length} cells, ${num(inc.baseline)} baseline APs. ${pct(inc.surv[d])} still visible vs ${pct(det.city.surv[d])} citywide (${num(inc.apsNow)} APs dark beyond normal churn; peak ${num(inc.apsPeak)}).`
      : `Affected: ${inc.cellIds.length} cells. New APs at ${pct(inc.fresh[d])} of baseline vs ${pct(det.city.fresh[d])} citywide.`,
    reports ? `311 infrastructure reports in these cells since then: ${reports.length}${reports.length ? ` (${summarize311(reports).map(([g, n]) => `${GROUP_LABEL[g]}: ${n}`).join(', ')})` : ''}` : '311 reports: feed unavailable',
    model.meta.simulated ? 'NOTE: Wi-Fi counts are SIMULATED demo data. 311 reports are real.' : '',
    'Aggregate-only data. No individual devices or access points are identified.',
  ];
  return lines.filter(Boolean).join('\n');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

function summarize311(reports) {
  const g = new Map();
  for (const r of reports) g.set(r.group, (g.get(r.group) ?? 0) + 1);
  return [...g].sort((a, b) => b[1] - a[1]);
}

// ------------------------------------------------------------------ insights card

function renderInsights(incidents) {
  const d = state.day;
  const body = $('insights-body');
  $('insights-desc').textContent = `Detected from Wi‑Fi churn as of ${fmtDate(model.dates[d])}. Click a hexagon to inspect it.`;
  const rows = [];

  if (state.selectedCell !== null) rows.push(cellRow(model.cells[state.selectedCell]));
  if (!incidents.length) {
    rows.push(`<div class="empty">No anomalies at these thresholds on ${fmtDate(model.dates[d])}. Try scrubbing the timeline or lowering the minimum drop.</div>`);
  }
  for (const inc of incidents) rows.push(incidentRow(inc));
  body.innerHTML = rows.join('');

  // wire up + draw charts for the open rows
  body.querySelectorAll('.inc-head').forEach((h) => h.addEventListener('click', () => {
    const id = h.dataset.inc;
    if (id === 'cell') { state.selectedCell = null; render(); return; }
    openIncident(Number(id) === state.openIncident ? null : Number(id), false);
  }));
  body.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    const inc = incidents.find((i) => i.id === Number(b.dataset.zoom));
    if (inc) map.fitBounds(inc.bounds, { padding: fitPadding(true), maxZoom: 14.5 });
  }));
  body.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const inc = incidents.find((i) => i.id === Number(b.dataset.copy));
    if (!inc) return;
    await copyText(brief(inc));
    b.innerHTML = `${icon('check')} Copied`;
  }));

  const series1 = cssVar('--series-1') || '#2a78d6';
  const control = cssVar('--control') || '#898781';
  const open = incidents.find((i) => i.id === state.openIncident);
  if (open) {
    const host = body.querySelector(`[data-chart="${open.id}"]`);
    host.style.setProperty('--sev', `var(--status-${open.severity === 'info' ? 'info' : open.severity === 'resolved' ? 'good' : open.severity})`);
    const influx = open.kind > 0;
    lineChart(host, {
      dates: model.dates, upTo: d, band: [open.onset, Math.min(d, open.last)], format: (v) => pct(v, 0),
      caption: influx ? 'New access points as a share of baseline, area vs. city' : 'Share of baseline access points still visible, area vs. city',
      series: [
        { name: influx ? 'New APs, this area' : 'This area', color: series1, values: influx ? open.fresh : open.surv },
        { name: 'City median (control)', color: control, values: influx ? det.city.fresh : det.city.surv },
      ],
    });
  }
  if (state.selectedCell !== null) {
    const c = model.cells[state.selectedCell];
    const surv = c.alive.map((a) => a / c.baseline);
    lineChart(body.querySelector('[data-chart="cell"]'), {
      dates: model.dates, upTo: d, format: (v) => pct(v, 0),
      caption: 'Share of baseline access points still visible, cell vs. city',
      series: [
        { name: 'This cell', color: series1, values: surv },
        { name: 'City median (control)', color: control, values: det.city.surv },
      ],
    });
  }
}

function r311Block(cellIds, fromDay, toDay) {
  if (r311Error) return `<div class="r311 muted">311 feed unavailable: ${esc(r311Error)}</div>`;
  const reports = reportsIn(cellIds, fromDay, toDay);
  if (!reports) return '<div class="r311 muted">Loading 311 reports…</div>';
  const range = `${fmtDate(model.dates[fromDay])} – ${fmtDate(model.dates[toDay])}`;
  if (!reports.length) return `<div class="r311"><div class="r311-title">Live 311 infrastructure reports here</div><div class="muted">None filed ${range}.</div></div>`;
  const byService = new Map();
  for (const r of reports) byService.set(r.service, (byService.get(r.service) ?? 0) + 1);
  const top = [...byService].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return `<div class="r311"><div class="r311-title">Live 311 infrastructure reports here, ${range}</div><ul>${
    top.map(([s, n]) => `<li><span>${esc(s)}</span><b>${n}</b></li>`).join('')}</ul></div>`;
}

function incidentRow(inc) {
  const d = state.day;
  const open = state.openIncident === inc.id;
  const s = SEV[inc.severity];
  const value = inc.kind < 0 ? pts(-inc.now) : pts(inc.now);
  const since = inc.active ? `${inc.status} since ${fmtDate(model.dates[inc.onset])}` : `Restored ${fmtDate(model.dates[inc.last + 1] ?? model.dates[inc.last])}`;
  const lagStart = Math.max(0, inc.onset - model.meta.wpsLagDays);
  const facts = inc.kind < 0
    ? [
        ['Still visible', `${pct(inc.surv[d])} (city ${pct(det.city.surv[d])})`],
        ['APs dark vs. city', `${num(inc.apsNow)} now · ${num(inc.apsPeak)} peak`],
        ['Signal onset', fmtDate(model.dates[inc.onset])],
        ['Likely event start', `≈ ${fmtDate(model.dates[lagStart])}`],
        ['Cells / baseline APs', `${inc.cellIds.length} / ${num(inc.baseline)}`],
        ['Neighborhoods', esc(inc.hoods.slice(0, 3).join(', '))],
      ]
    : [
        ['New APs', `${pct(inc.fresh[d])} of baseline (city ${pct(det.city.fresh[d])})`],
        ['Signal onset', fmtDate(model.dates[inc.onset])],
        ['Cells / baseline APs', `${inc.cellIds.length} / ${num(inc.baseline)}`],
        ['Neighborhoods', esc(inc.hoods.slice(0, 3).join(', '))],
      ];
  return `
    <div class="inc sev-${inc.severity}${open ? ' open' : ''}">
      <button type="button" class="inc-head" data-inc="${inc.id}" aria-expanded="${open}">
        <div class="inc-main">
          <div class="inc-title">${TYPE_LABEL[inc.type]} · ${esc(placeName(inc))}</div>
          <div class="inc-meta"><span class="sev-chip">${icon(s.icon)}${s.label}</span><span>${since}</span></div>
        </div>
        <div class="inc-value">${value}</div>
        <span class="chev">${icon('chevron-down')}</span>
      </button>
      ${open ? `
      <div class="inc-body">
        <div data-chart="${inc.id}"></div>
        <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
        ${r311Block(inc.cellIds, lagStart, d)}
        <div class="inc-actions">
          <button type="button" class="btn btn-sm" data-zoom="${inc.id}">${icon('map-pin')} Zoom</button>
          <button type="button" class="btn btn-sm" data-copy="${inc.id}">${icon('copy')} Copy brief</button>
        </div>
      </div>` : ''}
    </div>`;
}

function cellRow(c) {
  const d = state.day;
  const s = cellDay(c, d, det.city);
  const hidden = c.baseline < state.params.kMin;
  return `
    <div class="inc open">
      <button type="button" class="inc-head" data-inc="cell" title="Clear selection">
        <div class="inc-main">
          <div class="inc-title">Selected cell · ${esc(c.hood)}</div>
          <div class="inc-meta"><span>${num(c.baseline)} baseline APs${hidden ? ' · below the minimum-APs threshold' : ''}</span></div>
        </div>
        <div class="inc-value">${pts(s.excess)}</div>
        <span class="chev">${icon('x')}</span>
      </button>
      <div class="inc-body">
        <div data-chart="cell"></div>
        <dl class="facts">
          <div><dt>Still visible</dt><dd>${pct(s.surv)} (city ${pct(det.city.surv[d])})</dd></div>
          <div><dt>Significance</dt><dd>z = ${s.z.toFixed(1)}</dd></div>
          <div><dt>New APs</dt><dd>${pct(s.fresh)} of baseline</dd></div>
          <div><dt>Density</dt><dd>${num(Math.round(c.baseline / HEX_AREA_KM2(model.meta.hexSizeM)))} APs/km²</dd></div>
        </dl>
        ${r311Block([c.id], Math.max(0, d - R311_WINDOW + 1), d)}
      </div>
    </div>`;
}

function openIncident(id, fly) {
  state.openIncident = id;
  if (id !== null) {
    $('insights').classList.remove('collapsed');
    $('insights-toggle').setAttribute('aria-expanded', 'true');
  }
  render();
  if (fly && id !== null) {
    const inc = incidentsAt(model, det, state.day).find((i) => i.id === id);
    if (inc) map.fitBounds(inc.bounds, { padding: fitPadding(true), maxZoom: 14.5 });
  }
}

// ------------------------------------------------------------------ map interaction

function onHover(e) {
  const f311 = state.layers.r311 ? map.queryRenderedFeatures(e.point, { layers: ['r311-pts'] })[0] : null;
  if (f311 && r311) {
    const r = r311[f311.properties.i];
    hoverPopup.setLngLat(e.lngLat).setHTML(
      `<div class="pop-title">${esc(r.service)}</div>
       <div class="pop-row">Filed <b>${fmtDate(r.date, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</b></div>
       <div class="pop-row">Status <b>${esc(r.status)}</b></div>
       ${r.address ? `<div class="pop-row">${esc(r.address)}</div>` : ''}`).addTo(map);
    map.getCanvas().style.cursor = 'pointer';
    return;
  }
  const f = state.layers.cells ? map.queryRenderedFeatures(e.point, { layers: ['cells-fill'] })[0] : null;
  const c = f ? model.cells[f.properties.id] : null;
  if (!c || c.baseline < state.params.kMin) { hoverPopup.remove(); map.getCanvas().style.cursor = ''; return; }
  const s = cellDay(c, state.day, det.city);
  hoverPopup.setLngLat(e.lngLat).setHTML(
    `<div class="pop-title">${esc(c.hood)}</div>
     <div class="pop-row">Baseline APs <b>${num(c.baseline)}</b></div>
     <div class="pop-row">Still visible <b>${pct(s.surv)}</b></div>
     <div class="pop-row">City median <b>${pct(det.city.surv[state.day])}</b></div>
     <div class="pop-row">Difference <b>${pts(s.excess)} (z ${s.z.toFixed(1)})</b></div>
     <div class="pop-row">New APs <b>${pct(s.fresh)}</b></div>`).addTo(map);
  map.getCanvas().style.cursor = 'pointer';
}

function onClick(e) {
  const f = state.layers.cells ? map.queryRenderedFeatures(e.point, { layers: ['cells-fill'] })[0] : null;
  const c = f ? model.cells[f.properties.id] : null;
  state.selectedCell = c && c.baseline >= state.params.kMin && state.selectedCell !== c.id ? c.id : null;
  if (state.selectedCell !== null) {
    $('insights').classList.remove('collapsed');
    $('insights-toggle').setAttribute('aria-expanded', 'true');
  }
  render();
}

// ------------------------------------------------------------------ controls

function setLayer(name, on) {
  state.layers[name] = on;
  const input = document.querySelector(`[data-layer="${name}"]`);
  if (input) input.checked = on;
  applyLayerVisibility();
}

function initControls() {
  const { meta } = model;
  const total = model.cells.reduce((a, c) => a + c.baseline, 0);
  $('status-grid').textContent =
    `Wi‑Fi grid: ${num(model.cells.length)} cells · ${num(total)} baseline APs · ${num(meta.suppressedCells)} cells suppressed (<${meta.kMin} APs)`;
  $('data-badge').hidden = !meta.simulated;

  // neighborhoods
  const names = hoods.features.map((f) => f.properties.name).sort();
  $('hood-list').innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
  $('hood-search').addEventListener('change', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const f = hoods.features.find((h) => h.properties.name.toLowerCase() === q) ??
      hoods.features.find((h) => h.properties.name.toLowerCase().includes(q));
    if (!f) return;
    const coords = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.flat(2) : f.geometry.coordinates.flat(1);
    const lons = coords.map((p) => p[0]), lats = coords.map((p) => p[1]);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: fitPadding(), maxZoom: 15 });
    setLayer('hoods', true);
  });
  $('reset-view').addEventListener('click', () => {
    $('hood-search').value = '';
    map.fitBounds(cityBounds(), { padding: fitPadding() });
  });

  // timeline
  const slider = $('day');
  slider.max = meta.days - 1;
  slider.addEventListener('input', () => { stopPlay(); state.day = Number(slider.value); render(); });
  $('play').addEventListener('click', () => (state.playing ? stopPlay() : startPlay()));

  // metric
  document.querySelectorAll('#metric [data-metric]').forEach((b) => b.addEventListener('click', () => {
    state.metric = b.dataset.metric;
    document.querySelectorAll('#metric [data-metric]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    applyMetricPaint();
    render();
  }));

  // layers
  document.querySelectorAll('[data-layer]').forEach((inp) => inp.addEventListener('change', () => setLayer(inp.dataset.layer, inp.checked)));

  // detection params
  const params = [
    ['p-drop', 'out-drop', (v) => (state.params.minDrop = v / 100), (v) => `${v} pts`],
    ['p-z', 'out-z', (v) => (state.params.zThr = v), (v) => v.toFixed(1)],
    ['p-k', 'out-k', (v) => (state.params.kMin = v), (v) => `${v}`],
  ];
  let timer;
  for (const [inputId, outId, apply, show] of params) {
    const inp = $(inputId);
    $(outId).textContent = show(Number(inp.value));
    inp.addEventListener('input', () => {
      const v = Number(inp.value);
      $(outId).textContent = show(v);
      apply(v);
      clearTimeout(timer);
      timer = setTimeout(() => { det = detect(model, state.params); $('alert').dataset.id = ''; render(); }, 120);
    });
  }

  // collapsible cards
  const collapse = (btnId, cardId) => $(btnId).addEventListener('click', () => {
    const card = $(cardId);
    const collapsed = card.classList.toggle('collapsed');
    $(btnId).setAttribute('aria-expanded', String(!collapsed));
  });
  collapse('panel-toggle', 'panel');
  collapse('insights-toggle', 'insights');
  if (innerWidth > 0 && innerWidth <= 900) {  // phones: start with the map visible
    for (const [card, btn] of [['panel', 'panel-toggle'], ['insights', 'insights-toggle']]) {
      $(card).classList.add('collapsed');
      $(btn).setAttribute('aria-expanded', 'false');
    }
  }

  // open the most severe active incident by default
  const first = incidentsAt(model, det, state.day).find((i) => i.active);
  state.openIncident = first?.id ?? null;
  renderLegend();
}

function startPlay() {
  if (state.day >= model.meta.days - 1) state.day = 0;
  $('play').innerHTML = icon('pause');
  $('play').setAttribute('aria-label', 'Pause timeline');
  state.playing = setInterval(() => {
    if (state.day >= model.meta.days - 1) { stopPlay(); return; }
    state.day += 1;
    render();
  }, 380);
  render();
}

function stopPlay() {
  if (!state.playing) return;
  clearInterval(state.playing);
  state.playing = null;
  $('play').innerHTML = icon('play');
  $('play').setAttribute('aria-label', 'Play timeline');
}

boot();
