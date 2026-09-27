import { useEffect, useState } from 'react';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { buildModel, cellAt, type Dataset, type Model } from './detect';
import { fetch311, type Report } from './phl311';

export type CityData = {
  model: Model;
  hoods: FeatureCollection<Polygon | MultiPolygon, { name: string }>;
  city: Feature<Polygon | MultiPolygon>;
};

const url = (path: string) => `${import.meta.env.BASE_URL}${path}`;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

let dataPromise: Promise<CityData> | null = null;
export function loadCityData(): Promise<CityData> {
  dataPromise ??= Promise.all([
    getJson<Dataset>('data/wifi_churn.json'),
    getJson<CityData['hoods']>('data/neighborhoods.geojson'),
    getJson<CityData['city']>('data/city_limits.geojson'),
  ]).then(([raw, hoods, city]) => ({ model: buildModel(raw), hoods, city }));
  dataPromise.catch(() => { dataPromise = null; });
  return dataPromise;
}

export function useCityData() {
  const [state, setState] = useState<{ data?: CityData; error?: string }>({});
  useEffect(() => {
    let live = true;
    loadCityData().then(
      (data) => live && setState({ data }),
      (err: Error) => live && setState({ error: err.message }),
    );
    return () => { live = false; };
  }, []);
  return state;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

let reportsPromise: Promise<Report[]> | null = null;
function load311(model: Model): Promise<Report[]> {
  if (!reportsPromise) {
    const start = model.dates[0];
    const end = new Date(model.dates[model.meta.days - 1].getTime() + 86_400_000);
    const t0 = start.getTime();
    reportsPromise = fetch311(iso(start), iso(end)).then((rows) =>
      rows.map((r) => ({ ...r, day: Math.floor((r.date.getTime() - t0) / 86_400_000), cell: cellAt(model, r.lon, r.lat)?.id ?? null })),
    );
    reportsPromise.catch(() => { reportsPromise = null; });
  }
  return reportsPromise;
}

/** Live 311 infrastructure reports for the dataset's window, binned into cells. */
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
