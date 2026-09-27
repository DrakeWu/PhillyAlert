// Live Philly311 service requests from OpenDataPhilly's public Carto SQL API.
// Only infrastructure categories that can corroborate a Wi-Fi-derived signal are fetched.

const API = 'https://phl.carto.com/api/v2/sql';

export const CATEGORY_GROUP = {
  'Street Light Outage': 'power',
  'Alley Light Outage': 'power',
  'Traffic Signal Emergency': 'power',
  'Dangerous Building Complaint': 'structural',
  'Fire Safety Complaint': 'structural',
  'Inlet Cleaning': 'water',
  'Hydrant Request': 'water',
  'Manhole Cover': 'water',
};

export const GROUP_LABEL = {
  power: 'Power & lighting',
  structural: 'Buildings & fire',
  water: 'Water & drainage',
};

/** @returns {Promise<{rows: object[]}>} rows with {id, service, group, date: Date, address, status, lon, lat} */
export async function fetch311(startISO, endISO) {
  const names = Object.keys(CATEGORY_GROUP).map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  const q = `SELECT service_request_id, service_name, requested_datetime, address, status, lat, lon
    FROM public_cases_fc
    WHERE requested_datetime >= '${startISO}' AND requested_datetime < '${endISO}'
      AND lat IS NOT NULL AND lon IS NOT NULL AND service_name IN (${names})
    ORDER BY requested_datetime DESC LIMIT 10000`;
  const res = await fetch(`${API}?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`311 API ${res.status}`);
  const json = await res.json();
  return {
    rows: json.rows.map((r) => ({
      id: r.service_request_id,
      service: r.service_name,
      group: CATEGORY_GROUP[r.service_name],
      date: new Date(r.requested_datetime),
      address: r.address,
      status: r.status,
      lon: r.lon,
      lat: r.lat,
    })),
  };
}
