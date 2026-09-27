// Live Philly311 service requests from OpenDataPhilly's public Carto SQL API.
// Only infrastructure categories that can corroborate a Wi-Fi signal are fetched.

const API = 'https://phl.carto.com/api/v2/sql';

export type Group = 'power' | 'structural' | 'water';

export const CATEGORY_GROUP: Record<string, Group> = {
  'Street Light Outage': 'power',
  'Alley Light Outage': 'power',
  'Traffic Signal Emergency': 'power',
  'Dangerous Building Complaint': 'structural',
  'Fire Safety Complaint': 'structural',
  'Inlet Cleaning': 'water',
  'Hydrant Request': 'water',
  'Manhole Cover': 'water',
};

export const GROUP_LABEL: Record<Group, string> = {
  power: 'Power & lighting',
  structural: 'Buildings & fire',
  water: 'Water & drainage',
};

export type Report = {
  id: string;
  service: string;
  group: Group;
  date: Date;
  address: string | null;
  status: string;
  lon: number;
  lat: number;
  day: number;
  cell: number | null;
};

type Row = {
  service_request_id: string;
  service_name: string;
  requested_datetime: string;
  address: string | null;
  status: string;
  lat: number;
  lon: number;
};

export async function fetch311(startISO: string, endISO: string, signal?: AbortSignal): Promise<Omit<Report, 'day' | 'cell'>[]> {
  const names = Object.keys(CATEGORY_GROUP).map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  const q = `SELECT service_request_id, service_name, requested_datetime, address, status, lat, lon
    FROM public_cases_fc
    WHERE requested_datetime >= '${startISO}' AND requested_datetime < '${endISO}'
      AND lat IS NOT NULL AND lon IS NOT NULL AND service_name IN (${names})
    ORDER BY requested_datetime DESC LIMIT 10000`;
  const res = await fetch(`${API}?q=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) throw new Error(`311 API returned ${res.status}`);
  const json: { rows: Row[] } = await res.json();
  return json.rows.map((r) => ({
    id: r.service_request_id,
    service: r.service_name,
    group: CATEGORY_GROUP[r.service_name],
    date: new Date(r.requested_datetime),
    address: r.address,
    status: r.status,
    lon: r.lon,
    lat: r.lat,
  }));
}
