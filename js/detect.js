// Anomaly detection over aggregated Wi-Fi churn.
//
// For every hex cell and day we compare the share of its baseline access points that are
// still present in the positioning database against the citywide share (the "control",
// like the paper's Tel Aviv comparison group for Gaza). A cell is flagged when it falls
// below the control by at least `minDrop` AND the gap is statistically significant under a
// binomial model for that cell's size. The same test on newly-seen APs flags influxes.
// Adjacent flagged cells form components; components are linked day-to-day into tracks.

const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const key = (q, r) => `${q},${r}`;

export function buildModel(data) {
  const { meta, cells } = data;
  const byKey = new Map(cells.map((c) => [key(c.q, c.r), c]));
  for (const c of cells) {
    c.neighbors = DIRS.map(([dq, dr]) => byKey.get(key(c.q + dq, c.r + dr))).filter(Boolean).map((n) => n.id);
  }
  const [y, m, d] = meta.start.split('-').map(Number);
  const dates = Array.from({ length: meta.days }, (_, i) => new Date(y, m - 1, d + i));
  return { meta, cells, byKey, dates };
}

/** Same pointy-top axial projection the pipeline uses, so we can bin 311 points into cells. */
export function cellAt(model, lon, lat) {
  const { origin, mPerDeg, hexSizeM } = model.meta;
  const x = (lon - origin[0]) * mPerDeg[0];
  const y = (lat - origin[1]) * mPerDeg[1];
  const qf = ((Math.sqrt(3) / 3) * x - y / 3) / hexSizeM;
  const rf = ((2 / 3) * y) / hexSizeM;
  const sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return model.byKey.get(key(q, r)) ?? null;
}

function weightedMedian(pairs) {
  pairs.sort((a, b) => a[0] - b[0]);
  const half = pairs.reduce((a, p) => a + p[1], 0) / 2;
  let acc = 0;
  for (const [v, w] of pairs) { acc += w; if (acc >= half) return v; }
  return pairs.length ? pairs[pairs.length - 1][0] : 0;
}

/**
 * The control. The paper compared Gaza against a separate Tel Aviv group; inside one city we
 * use the baseline-weighted MEDIAN cell instead, so a large outage can't drag the control down
 * and make every unaffected neighborhood look "better than the city".
 * `total` is the plain citywide share, kept for display.
 */
export function citySeries(model, kMin) {
  const n = model.meta.days;
  const cells = model.cells.filter((c) => c.baseline >= kMin);
  const surv = new Float64Array(n), fresh = new Float64Array(n), total = new Float64Array(n);
  const baseline = cells.reduce((a, c) => a + c.baseline, 0);
  for (let i = 0; i < n; i++) {
    surv[i] = weightedMedian(cells.map((c) => [c.alive[i] / c.baseline, c.baseline]));
    fresh[i] = weightedMedian(cells.map((c) => [c.new[i] / c.baseline, c.baseline]));
    total[i] = cells.reduce((a, c) => a + c.alive[i], 0) / baseline;
  }
  return { surv, fresh, total, baseline };
}

const clampP = (p) => Math.min(Math.max(p, 0.01), 0.99);

export function cellDay(c, d, city) {
  const B = c.baseline;
  const surv = c.alive[d] / B;
  const excess = surv - city.surv[d];
  const p = clampP(city.surv[d]);
  const z = excess / Math.max(Math.sqrt((p * (1 - p)) / B), 0.004);
  // New APs are rare arrivals, so test them as Poisson counts (+1 keeps tiny cells honest).
  const fresh = c.new[d] / B;
  const gain = fresh - city.fresh[d];
  const expected = city.fresh[d] * B;
  const zg = (c.new[d] - expected) / Math.sqrt(expected + 1);
  return { surv, excess, z, fresh, gain, zg };
}

// With ~1,700 cells x 60 days we run ~100k tests; requiring a minimum absolute change keeps
// small cells from producing one-off flags on a handful of APs.
export const MIN_APS = 8;

function components(ids, flags, kind, cells) {
  const seen = new Set();
  const out = [];
  for (const start of ids) {
    if (seen.has(start)) continue;
    const comp = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const id = stack.pop();
      comp.push(id);
      for (const n of cells[id].neighbors) {
        if (!seen.has(n) && flags[n] === kind) { seen.add(n); stack.push(n); }
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * @returns {{city, flags: Int8Array[], tracks: object[]}}
 *   flags[d][cellId] is -1 (loss), +1 (influx) or 0.
 *   Each track: {id, kind, onset, last, firstSeen: Map<cellId, day>}
 */
export function detect(model, { minDrop, zThr, kMin }) {
  const { cells } = model;
  const days = model.meta.days;
  const city = citySeries(model, kMin);
  const eligible = cells.filter((c) => c.baseline >= kMin);
  const flags = [];
  const tracks = [];

  for (let d = 0; d < days; d++) {
    const f = new Int8Array(cells.length);
    const lossIds = [], gainIds = [];
    for (const c of eligible) {
      const s = cellDay(c, d, city);
      if (s.excess <= -minDrop && s.z <= -zThr && -s.excess * c.baseline >= MIN_APS) { f[c.id] = -1; lossIds.push(c.id); }
      else if (s.gain >= minDrop && s.zg >= zThr && s.gain * c.baseline >= MIN_APS) { f[c.id] = 1; gainIds.push(c.id); }
    }
    flags.push(f);

    for (const [kind, ids] of [[-1, lossIds], [1, gainIds]]) {
      for (const comp of components(ids, f, kind, cells)) {
        // Link to every recent track of the same kind that shares a cell (or touches one).
        const touching = tracks.filter((t) => t.kind === kind && t.last >= d - 2 &&
          comp.some((id) => t.firstSeen.has(id) || cells[id].neighbors.some((n) => t.firstSeen.has(n))));
        let t = touching[0];
        if (!t) {
          t = { id: tracks.length, kind, onset: d, last: d, firstSeen: new Map() };
          tracks.push(t);
        }
        for (const other of touching.slice(1)) {  // two incidents grew together: merge
          for (const [id, day] of other.firstSeen) if (!t.firstSeen.has(id) || t.firstSeen.get(id) > day) t.firstSeen.set(id, day);
          t.onset = Math.min(t.onset, other.onset);
          other.mergedInto = t.id;
        }
        t.last = d;
        for (const id of comp) if (!t.firstSeen.has(id)) t.firstSeen.set(id, d);
      }
    }
  }
  // Short blips are noise unless they're still happening on the latest day.
  const kept = tracks.filter((t) => t.mergedInto === undefined && (t.last - t.onset >= 2 || t.last === days - 1));
  return { city, flags, tracks: kept };
}

// Districts that make poor incident names ("outage in Industrial"); used only as a last resort.
const NON_RESIDENTIAL = /^(Industrial|Airport|Navy Yard|Stadium District|East Park|West Park|Wissahickon Park|Pennypack Park|Northeast Phila Airport)$/;

const SEV_RANK = { critical: 0, serious: 1, warning: 2, info: 3, resolved: 4 };
export const sevRank = (s) => SEV_RANK[s] ?? 9;

/** Describe a track as it looked on day `d` (no peeking at later days). */
export function trackAt(model, det, t, d) {
  if (t.onset > d) return null;
  const ids = [...t.firstSeen].filter(([, day]) => day <= d).map(([id]) => id);
  const cells = ids.map((id) => model.cells[id]);
  const B = cells.reduce((a, c) => a + c.baseline, 0);
  const n = model.meta.days;
  const surv = new Float64Array(n), fresh = new Float64Array(n);
  for (const c of cells) for (let i = 0; i < n; i++) { surv[i] += c.alive[i] / B; fresh[i] += c.new[i] / B; }

  const active = t.last >= d;
  const end = Math.min(d, t.last);
  let peak = 0;
  for (let i = t.onset; i <= end; i++) {
    const v = t.kind < 0 ? det.city.surv[i] - surv[i] : fresh[i] - det.city.fresh[i];
    peak = Math.max(peak, v);
  }
  const now = t.kind < 0 ? det.city.surv[d] - surv[d] : fresh[d] - det.city.fresh[d];
  const apsNow = Math.round(Math.max(now, 0) * B);
  const apsPeak = Math.round(peak * B);

  // Name after the neighborhoods holding most of the affected APs.
  const byHood = new Map();
  for (const c of cells) byHood.set(c.hood, (byHood.get(c.hood) ?? 0) + c.baseline);
  const hoods = [...byHood]
    .sort((a, b) => NON_RESIDENTIAL.test(a[0]) - NON_RESIDENTIAL.test(b[0]) || b[1] - a[1])
    .map(([h]) => h);

  let type, severity;
  if (t.kind > 0) {
    type = 'influx';
    severity = 'info';
  } else {
    type = cells.length >= 4 ? 'outage' : 'localized';
    if (!active) severity = 'resolved';
    else if (apsNow >= 1000 || (now >= 0.35 && apsNow >= 250)) severity = 'critical';
    else if (apsNow >= 150 || now >= 0.2) severity = 'serious';
    else severity = 'warning';
  }
  const status = !active ? 'Restored' : d - t.onset < 3 ? 'Emerging' : 'Active';

  const lons = cells.flatMap((c) => c.poly.map((p) => p[0]));
  const lats = cells.flatMap((c) => c.poly.map((p) => p[1]));
  const cx = cells.reduce((a, c) => a + c.center[0] * c.baseline, 0) / B;
  const cy = cells.reduce((a, c) => a + c.center[1] * c.baseline, 0) / B;

  return {
    track: t, id: t.id, kind: t.kind, type, severity, status, active,
    onset: t.onset, last: t.last, cellIds: ids, baseline: B,
    now, peak, apsNow, apsPeak, hoods, surv, fresh,
    center: [cx, cy],
    bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
  };
}

export function incidentsAt(model, det, d) {
  return det.tracks
    .map((t) => trackAt(model, det, t, d))
    .filter(Boolean)
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || b.apsNow - a.apsNow || b.apsPeak - a.apsPeak);
}
