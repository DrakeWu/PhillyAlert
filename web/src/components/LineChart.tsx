import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { fmtDate } from '@/lib/format';

export type Series = { name: string; color: string; values: ArrayLike<number> };

type Props = {
  dates: Date[];
  /** Last day drawn; the chart never shows data after the selected day. */
  upTo: number;
  series: Series[];
  format: (v: number) => string;
  caption: string;
  band?: [number, number];
  bandColor?: string;
  height?: number;
  /** Fixed y axis instead of the automatic 0-100% one (e.g. river stage in feet). */
  yScale?: { lo: number; hi: number; step: number };
  /** Labeled horizontal reference lines, such as flood stage. */
  refs?: { value: number; label: string }[];
};

/** An area vs. the city median, in the style of the paper's Gaza / Tel Aviv comparison (Fig. 12). */
export function LineChart({ dates, upTo, series, format, caption, band, bandColor = 'hsl(var(--signal))', height = 132, yScale, refs = [] }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = width, H = height;
  const m = { l: 34, r: 40, t: 6, b: 18 };
  const n = dates.length;
  const iw = W - m.l - m.r, ih = H - m.t - m.b;

  const { lo, hi, step } = useMemo(() => {
    if (yScale) return yScale;
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (let i = 0; i <= upTo; i++) { lo = Math.min(lo, s.values[i]); hi = Math.max(hi, s.values[i]); }
    const step = hi - lo > 0.3 ? 0.1 : 0.05;
    const capAtOne = hi <= 1;
    lo = Math.max(0, Math.floor((lo - 0.005) / step) * step);
    hi = Math.ceil((hi + 0.005) / step) * step;
    if (capAtOne) hi = Math.min(hi, 1);
    if (hi - lo < step * 2) lo = Math.max(0, hi - step * 2);
    return { lo, hi, step };
  }, [series, upTo, yScale]);

  const x = (i: number) => m.l + (i / (n - 1)) * iw;
  const y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * ih;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);
  const xTicks = [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];
  const pathFor = (vals: ArrayLike<number>) => {
    let d = '';
    for (let i = 0; i <= upTo; i++) d += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`;
    return d;
  };

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    setHover(Math.max(0, Math.min(upTo, Math.round(((px - m.l) / iw) * (n - 1)))));
  };

  const rows: number[] = [];
  for (let i = 0; i <= upTo; i += 7) rows.push(i);
  if (rows[rows.length - 1] !== upTo) rows.push(upTo);

  return (
    <div ref={hostRef} className="relative">
      <div className="mb-1.5 flex gap-4 font-mono text-[11.5px] text-ink-2">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-0.5 w-3.5" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={caption} className="block overflow-visible">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={m.l} x2={m.l + iw} y1={y(v)} y2={y(v)} style={{ stroke: 'hsl(var(--rule) / 0.6)' }} strokeWidth={1} />
            <text x={m.l - 6} y={y(v) + 3.5} textAnchor="end" className="fill-muted-foreground font-mono text-[10.5px]">{format(v)}</text>
          </g>
        ))}
        <line x1={m.l} x2={m.l + iw} y1={m.t + ih} y2={m.t + ih} style={{ stroke: 'hsl(var(--rule))' }} strokeWidth={1} />
        {xTicks.map((i) => (
          <text key={i} x={x(i)} y={H - 3} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="fill-muted-foreground font-mono text-[10.5px]">
            {fmtDate(dates[i])}
          </text>
        ))}
        {refs.map((r) => (
          <g key={r.label}>
            <line x1={m.l} x2={m.l + iw} y1={y(r.value)} y2={y(r.value)} style={{ stroke: 'hsl(var(--signal))' }} strokeWidth={1} strokeDasharray="3 3" />
            <text x={m.l + 4} y={y(r.value) - 3} className="fill-signal font-mono text-[10px]">{r.label}</text>
          </g>
        ))}
        {band && band[0] <= upTo && (
          <rect x={x(band[0])} y={m.t} width={Math.max(x(Math.min(band[1], upTo)) - x(band[0]), 2)} height={ih} style={{ fill: bandColor }} opacity={0.12} />
        )}
        {series.map((s, si) => (
          <g key={s.name}>
            <path d={pathFor(s.values)} fill="none" style={{ stroke: s.color }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {si === 0 && (
              <>
                <circle cx={x(upTo)} cy={y(s.values[upTo])} r={4} style={{ fill: s.color, stroke: 'hsl(var(--paper))' }} strokeWidth={2} />
                <text x={x(upTo) + 7} y={y(s.values[upTo]) + 3.5} className="fill-foreground font-mono text-[11px] font-medium">{format(s.values[upTo])}</text>
              </>
            )}
          </g>
        ))}
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} style={{ stroke: 'hsl(var(--ink-2))' }} strokeWidth={1} />
            {series.map((s) => (
              <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r={4} style={{ fill: s.color, stroke: 'hsl(var(--paper))' }} strokeWidth={2} />
            ))}
          </g>
        )}
        <rect x={m.l - 6} y={0} width={iw + 12} height={H} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute z-10 min-w-[150px] border border-rule bg-popover px-2 py-1.5 text-xs shadow-md"
          style={{ left: Math.min(Math.max((x(hover) / W) * width - 75, 0), width - 160), top: -28 }}
        >
          <div className="mb-0.5 font-semibold">{fmtDate(dates[hover])}</div>
          {series.map((s) => (
            <div key={s.name} className="flex justify-between gap-3 text-ink-2">
              <span><i className="mr-1.5 inline-block h-0.5 w-2.5 align-middle" style={{ background: s.color }} />{s.name}</span>
              <b className="font-mono font-medium text-foreground">{format(s.values[hover])}</b>
            </div>
          ))}
        </div>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer font-mono text-[11.5px] text-muted-foreground">View as table</summary>
        <table className="mt-1 w-full border-collapse font-mono text-[11.5px]">
          <thead>
            <tr>
              <th className="border-b border-rule py-0.5 text-left font-medium">Date</th>
              {series.map((s) => <th key={s.name} className="border-b border-rule py-0.5 text-right font-medium">{s.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i}>
                <td className="border-b border-rule/50 py-0.5">{fmtDate(dates[i])}</td>
                {series.map((s) => <td key={s.name} className="border-b border-rule/50 py-0.5 text-right">{format(s.values[i])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
