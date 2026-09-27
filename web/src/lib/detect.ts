// Anomaly detection over aggregated Wi-Fi churn.
//
// For every hex cell and day we compare the share of its baseline access points still present
// in the positioning database against a control: the baseline-weighted median cell (the paper's
// Tel Aviv comparison group, adapted to one city). A cell is flagged when it falls below the
// control by at least `minDrop`, the gap is significant under a binomial model for its size, and
// at least MIN_APS routers are involved. Newly seen APs get the same test with a Poisson model.
// Adjacent flagged cells form components; components are linked day to day into tracks.

export type Cell = {
  id: number;
  q: number;
  r: number;
  center: [number, number];
  poly: [number, number][];
  hood: string;
  baseline: number;
  alive: number[];
  new: number[];
  neighbors: number[];
};

export type Meta = {
  simulated: boolean;
  start: string;
  days: number;
  hexSizeM: number;
  origin: [number, number];
  mPerDeg: [number, number];
  kMin: number;
  suppressedCells: number;
  wpsLagDays: number;
  generated: string;
};

export type Dataset = { meta: Meta; cells: Omit<Cell, 'neighbors'>[] };

export type Model = { meta: Meta; cells: Cell[]; byKey: Map<string, Cell>; dates: Date[] };

export type Params = { minDrop: number; zThr: number; kMin: number };

export type CitySeries = { surv: Float64Array; fresh: Float64Array; total: Float64Array; baseline: number };

export type Track = { id: number; kind: -1 | 1; onset: number; last: number; firstSeen: Map<number, number>; mergedInto?: number };

export type Detection = { city: CitySeries; flags: Int8Array[]; tracks: Track[] };

export type Severity = 'critical' | 'serious' | 'warning' | 'info' | 'resolved';
export type IncidentType = 'outage' | 'localized' | 'influx';

export type Incident = {
  id: number;
  kind: -1 | 1;
  type: IncidentType;
  severity: Severity;
  status: 'Active' | 'Emerging' | 'Restored';
  active: boolean;
  onset: number;
  last: number;
  cellIds: number[];
  baseline: number;
  now: number;
  peak: number;
  apsNow: number;
  apsPeak: number;
  hoods: string[];
  surv: Float64Array;
  fresh: Float64Array;
  center: [number, number];
  bounds: [[number, number], [number, number]];
};

const DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const key = (q: number, r: number) => `${q},${r}`;

export const MIN_APS = 8;

export function buildModel(data: Dataset): Model {
  const { meta } = data;
  const cells = data.cells as Cell[];
  const byKey = new Map(cells.map((c) => [key(c.q, c.r), c]));
  for (const c of cells) {
    c.neighbors = DIRS.map(([dq, dr]) => byKey.get(key(c.q + dq, c.r + dr))).filter((n): n is Cell => !!n).map((n) => n.id);
  }
  const [y, m, d] = meta.start.split('-').map(Number);
  const dates = Array.from({ length: meta.days }, (_, i) => new Date(y, m - 1, d + i));
  return { meta, cells, byKey, dates };
}

/** Same pointy-top axial projection the pipeline uses, so points can be binned into cells. */
export function cellAt(model: Model, lon: number, lat: number): Cell | null {
  const { origin, mPerDeg, hexSizeM } = model.meta;
  const x = (lon - origin[0]) * mPerDeg[0];
  const y = (lat - origin[1]) * mPerDeg[1];
  const qf = ((Math.sqrt(3) / 3) * x - y / 3) / hexSizeM;
  const rf = ((2 / 3) * y) / hexSizeM;
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return model.byKey.get(key(q, r)) ?? null;
}

function weightedMedian(pairs: [number, number][]): number {
  pairs.sort((a, b) => a[0] - b[0]);
  const half = pairs.reduce((a, p) => a + p[1], 0) / 2;
  let acc = 0;
  for (const [v, w] of pairs) {
    acc += w;
    if (acc >= half) return v;
  }
  return pairs.length ? pairs[pairs.length - 1][0] : 0;
}

export function citySeries(model: Model, kMin: number): CitySeries {
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

export type CellDay = { surv: number; excess: number; z: number; fresh: number; gain: number; zg: number };

export function cellDay(c: Cell, d: number, city: CitySeries): CellDay {
  const B = c.baseline;
  const surv = c.alive[d] / B;
  const excess = surv - city.surv[d];
  const p = Math.min(Math.max(city.surv[d], 0.01), 0.99);
  const z = excess / Math.max(Math.sqrt((p * (1 - p)) / B), 0.004);
  const fresh = c.new[d] / B;
  const gain = fresh - city.fresh[d];
  const expected = city.fresh[d] * B;
  const zg = (c.new[d] - expected) / Math.sqrt(expected + 1);
  return { surv, excess, z, fresh, gain, zg };
}

function components(ids: number[], flags: Int8Array, kind: number, cells: Cell[]): number[][] {
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const start of ids) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      for (const n of cells[id].neighbors) {
        if (!seen.has(n) && flags[n] === kind) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

export function detect(model: Model, { minDrop, zThr, kMin }: Params): Detection {
  const { cells } = model;
  const days = model.meta.days;
  const city = citySeries(model, kMin);
  const eligible = cells.filter((c) => c.baseline >= kMin);
  const flags: Int8Array[] = [];
  const tracks: Track[] = [];

  for (let d = 0; d < days; d++) {
    const f = new Int8Array(cells.length);
    const lossIds: number[] = [], gainIds: number[] = [];
    for (const c of eligible) {
      const s = cellDay(c, d, city);
      if (s.excess <= -minDrop && s.z <= -zThr && -s.excess * c.baseline >= MIN_APS) { f[c.id] = -1; lossIds.push(c.id); }
      else if (s.gain >= minDrop && s.zg >= zThr && s.gain * c.baseline >= MIN_APS) { f[c.id] = 1; gainIds.push(c.id); }
    }
    flags.push(f);

    for (const [kind, ids] of [[-1, lossIds], [1, gainIds]] as const) {
      for (const comp of components(ids, f, kind, cells)) {
        const touching = tracks.filter((t) => t.mergedInto === undefined && t.kind === kind && t.last >= d - 2 &&
          comp.some((id) => t.firstSeen.has(id) || cells[id].neighbors.some((n) => t.firstSeen.has(n))));
        let t = touching[0];
        if (!t) {
          t = { id: tracks.length, kind, onset: d, last: d, firstSeen: new Map() };
          tracks.push(t);
        }
        for (const other of touching.slice(1)) {
          for (const [id, day] of other.firstSeen) if (!t.firstSeen.has(id) || t.firstSeen.get(id)! > day) t.firstSeen.set(id, day);
          t.onset = Math.min(t.onset, other.onset);
          other.mergedInto = t.id;
        }
        t.last = d;
        for (const id of comp) if (!t.firstSeen.has(id)) t.firstSeen.set(id, d);
      }
    }
  }
  const kept = tracks.filter((t) => t.mergedInto === undefined && (t.last - t.onset >= 2 || t.last === days - 1));
  return { city, flags, tracks: kept };
}

const NON_RESIDENTIAL = /^(Industrial|Airport|Navy Yard|Stadium District|East Park|West Park|Wissahickon Park|Pennypack Park|Northeast Phila Airport)$/;
const SEV_RANK: Record<Severity, number> = { critical: 0, serious: 1, warning: 2, info: 3, resolved: 4 };

/** Describe a track as it looked on day `d` (no peeking at later days). */
export function trackAt(model: Model, det: Detection, t: Track, d: number): Incident | null {
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
    peak = Math.max(peak, t.kind < 0 ? det.city.surv[i] - surv[i] : fresh[i] - det.city.fresh[i]);
  }
  const now = t.kind < 0 ? det.city.surv[d] - surv[d] : fresh[d] - det.city.fresh[d];
  const apsNow = Math.round(Math.max(now, 0) * B);
  const apsPeak = Math.round(peak * B);

  const byHood = new Map<string, number>();
  for (const c of cells) byHood.set(c.hood, (byHood.get(c.hood) ?? 0) + c.baseline);
  const hoods = [...byHood]
    .sort((a, b) => Number(NON_RESIDENTIAL.test(a[0])) - Number(NON_RESIDENTIAL.test(b[0])) || b[1] - a[1])
    .map(([h]) => h);

  let type: IncidentType, severity: Severity;
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
    id: t.id, kind: t.kind, type, severity, status, active,
    onset: t.onset, last: t.last, cellIds: ids, baseline: B,
    now, peak, apsNow, apsPeak, hoods, surv, fresh,
    center: [cx, cy],
    bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
  };
}

export function incidentsAt(model: Model, det: Detection, d: number): Incident[] {
  return det.tracks
    .map((t) => trackAt(model, det, t, d))
    .filter((i): i is Incident => !!i)
    .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.apsNow - a.apsNow || b.apsPeak - a.apsPeak);
}
