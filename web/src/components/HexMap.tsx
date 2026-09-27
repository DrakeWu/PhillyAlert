import { useMemo } from 'react';
import type { Position } from 'geojson';
import { cellDay, type Detection, type Incident } from '@/lib/detect';
import type { CityData } from '@/lib/data';
import { fmtDate, place, statLine } from '@/lib/format';

type Props = { data: CityData; det: Detection; day: number; incidents: Incident[] };

const W = 720, H = 660, M = { l: 180, r: 170, t: 16, b: 16 };

/** Static SVG of every hex cell on one day, with newspaper-style margin callouts. */
export function HexMap({ data, det, day, incidents }: Props) {
  const { model, city } = data;

  const geo = useMemo(() => {
    const g = city.geometry;
    const ring = (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0]) as Position[];
    const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons), minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
    const s = Math.min((W - M.l - M.r) / ((maxLon - minLon) * k), (H - M.t - M.b) / (maxLat - minLat));
    const ox = M.l + (W - M.l - M.r - (maxLon - minLon) * k * s) / 2;
    const oy = M.t + (H - M.t - M.b - (maxLat - minLat) * s) / 2;
    const P = (p: Position): [number, number] => [ox + (p[0] - minLon) * k * s, oy + (maxLat - p[1]) * s];
    const path = (pts: Position[]) => `M${pts.map((p) => P(p).map((v) => v.toFixed(1)).join(',')).join('L')}Z`;
    // Philadelphia's west side is narrow; anything east of ~1/3 of its width gets a right-hand label.
    const splitX = ox + ((maxLon - minLon) * k * s) * 0.35;
    return { ring, P, path, splitX };
  }, [city]);

  const cells = useMemo(() => {
    const sorted = model.cells.map((c) => c.baseline).sort((a, b) => a - b);
    const q = (f: number) => sorted[Math.floor(f * (sorted.length - 1))];
    const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
    return model.cells.map((c) => {
      const st = cellDay(c, day, det.city);
      const flag = det.flags[day][c.id];
      let cls: string;
      if (flag < 0) cls = st.excess < -0.2 ? 'fill-signal' : 'fill-signal-2';
      else if (flag > 0) cls = 'fill-gain';
      else if (st.excess < -0.08) cls = 'fill-signal-3';
      else if (st.gain > 0.12) cls = 'fill-gain-2';
      else cls = c.baseline < q1 ? 'fill-paper-2' : c.baseline < q2 ? 'fill-paper-3/60' : c.baseline < q3 ? 'fill-paper-3' : 'fill-rule';
      return { id: c.id, d: geo.path(c.poly.slice(0, 6)), cls };
    });
  }, [model, det, day, geo]);

  const notes = useMemo(() => {
    const list = incidents.filter((i) => i.active).slice(0, 4).map((inc) => ({ inc, at: geo.P(inc.center), y: 0, left: true }));
    for (const left of [true, false]) {
      let lastY = -Infinity;
      for (const n of list.filter((n) => (n.at[0] <= geo.splitX) === left).sort((a, b) => a.at[1] - b.at[1])) {
        n.y = Math.max(n.at[1], lastY + 64);
        n.left = left;
        lastY = n.y;
      }
    }
    return list;
  }, [incidents, geo]);

  const label = `Map of Philadelphia on ${fmtDate(model.dates[day])}. ` +
    notes.map(({ inc }) => `${place(inc)}: ${statLine(inc, day)}`).join('. ');

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={label}>
        <g className="stroke-paper" strokeWidth={0.6}>
          {cells.map((c) => <path key={c.id} d={c.d} className={c.cls} />)}
        </g>
        <path d={geo.path(geo.ring)} fill="none" className="stroke-ink" strokeWidth={1.2} />
        <g aria-hidden className="max-sm:hidden">
          {notes.map(({ inc, at, y, left }) => {
            const x = left ? M.l - 22 : W - M.r + 22;
            const anchor = left ? 'end' : 'start';
            const elbow = left ? x + 10 : x - 10;
            const gain = inc.kind > 0;
            return (
              <g key={inc.id}>
                <polyline points={`${at[0]},${at[1]} ${elbow},${y} ${x + (left ? 4 : -4)},${y}`} fill="none" className="stroke-ink" strokeWidth={1} />
                <circle cx={at[0]} cy={at[1]} r={4} className="fill-paper stroke-ink" strokeWidth={1.5} />
                <text x={x} y={y - 4 - (inc.hoods.length > 1 && place(inc).length > 18 ? 16 : 0)} textAnchor={anchor} className="fill-ink font-sans text-[14px] font-semibold">
                  {place(inc).length > 18 && inc.hoods.length > 1
                    ? <><tspan x={x}>{inc.hoods[0]} &amp;</tspan><tspan x={x} dy={16}>{inc.hoods[1]}</tspan></>
                    : place(inc)}
                </text>
                <text x={x} y={y + 13} textAnchor={anchor} className={`font-mono text-[12.5px] font-medium ${gain ? 'fill-gain' : 'fill-signal'}`}>{statLine(inc, day)}</text>
                <text x={x} y={y + 29} textAnchor={anchor} className="fill-muted-foreground font-mono text-[12px]">since {fmtDate(model.dates[inc.onset])}</text>
              </g>
            );
          })}
        </g>
      </svg>
      <ol className="mt-3 hidden list-none p-0 text-[14.5px] max-sm:block">
        {notes.map(({ inc }) => (
          <li key={inc.id} className="flex justify-between gap-3 border-t border-rule py-2">
            <span><b className="font-semibold">{place(inc)}</b> since {fmtDate(model.dates[inc.onset])}</span>
            <span className={`whitespace-nowrap font-mono text-[12.5px] ${inc.kind > 0 ? 'text-gain' : 'text-signal'}`}>{statLine(inc, day)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
