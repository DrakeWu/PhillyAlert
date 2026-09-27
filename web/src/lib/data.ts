import { useEffect, useState } from 'react';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { buildModel, cellAt, type Dataset, type Model } from './detect';
import { fetch311, type Report } from './phl311';

export type CityData = {
  id: DatasetId;
  model: Model;
  hoods: FeatureCollection<Polygon | MultiPolygon, { name: string }>;
  city: Feature<Polygon | MultiPolygon>;
};

/** Datasets the map can switch between. Both share the same hex grid and boundaries. */
export const DATASETS = {
  demo: { file: 'data/wifi_churn.json', label: 'Demo scenarios', hint: 'Five staged incidents, last 60 days' },
  'ida-2021': { file: 'data/ida_2021.json', label: 'Ida flood, 2021', hint: 'Schuylkill flood, real river data' },
} as const;
export type DatasetId = keyof typeof DATASETS;
export const isDatasetId = (v: string | null): v is DatasetId => !!v && v in DATASETS;

const url = (path: string) => `${import.meta.env.BASE_URL}${path}`;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

let boundaries: Promise<[CityData['hoods'], CityData['city']]> | null = null;
const datasets = new Map<DatasetId, Promise<CityData>>();

export function loadCityData(id: DatasetId = 'demo'): Promise<CityData> {
  boundaries ??= Promise.all([getJson<CityData['hoods']>('data/neighborhoods.geojson'), getJson<CityData['city']>('data/city_limits.geojson')]);
  boundaries.catch(() => { boundaries = null; });
  let p = datasets.get(id);
  if (!p) {
    p = Promise.all([getJson<Dataset>(DATASETS[id].file), boundaries]).then(([raw, [hoods, city]]) => ({ id, model: buildModel(raw), hoods, city }));
    p.catch(() => datasets.delete(id));
    datasets.set(id, p);
  }
  return p;
}

/** Loads a dataset. While a different one loads, the previous data stays available (`loading` is true). */
export function useCityData(id: DatasetId = 'demo') {
  const [state, setState] = useState<{ data?: CityData; error?: string }>({});
  useEffect(() => {
    let live = true;
    loadCityData(id).then(
      (data) => live && setState({ data }),
      (err: Error) => live && setState((s) => ({ ...s, error: err.message })),
    );
    return () => { live = false; };
  }, [id]);
  return { ...state, loading: state.data?.id !== id && !state.error };
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const reportCache = new WeakMap<Model, Promise<Report[]>>();
function load311(model: Model): Promise<Report[]> {
  let p = reportCache.get(model);
  if (!p) {
    const start = model.dates[0];
    const end = new Date(model.dates[model.meta.days - 1].getTime() + 86_400_000);
    const t0 = start.getTime();
    p = fetch311(iso(start), iso(end)).then((rows) =>
      rows.map((r) => ({ ...r, day: Math.floor((r.date.getTime() - t0) / 86_400_000), cell: cellAt(model, r.lon, r.lat)?.id ?? null })),
    );
    p.catch(() => reportCache.delete(model));
    reportCache.set(model, p);
  }
  return p;
}

/** Philly311 infrastructure reports for the dataset's window (live, or historical for a replay), binned into cells. */
export function use311(model: Model | undefined) {
  const [state, setState] = useState<{ reports: Report[] | null; error: string | null }>({ reports: null, error: null });
  useEffect(() => {
    if (!model) return;
    let live = true;
    load311(model).then(
      (reports) => live && setState({ reports, error: null }),
      (err: Error) => live && setState({ reports: null, error: err.message }),
    );
    return () => { live = false; };
  }, [model]);
  return state;
}

export function reportsIn(reports: Report[] | null, cellIds: number[], from: number, to: number): Report[] | null {
  if (!reports) return null;
  const set = new Set(cellIds);
  return reports.filter((r) => r.cell !== null && set.has(r.cell) && r.day >= from && r.day <= to);
}
