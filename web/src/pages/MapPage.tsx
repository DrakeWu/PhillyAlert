import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Copy, ExternalLink, LocateFixed, Pause, Play, RotateCcw, SkipForward, X } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LineChart } from '@/components/LineChart';
import { Wordmark } from '@/components/Wordmark';
import { MapView } from '@/components/map/MapView';
import { PALETTE, R311_WINDOW, type Layers, type MapHandle, type Metric } from '@/components/map/palette';
import { cellDay, detect, incidentsAt, type Cell, type Incident, type Params } from '@/lib/detect';
import { reportsIn, use311, useCityData, type CityData } from '@/lib/data';
import { GROUP_LABEL, type Report } from '@/lib/phl311';
import { fmtDate, num, pct, place, pts, SEV_COLOR, SEV_LABEL, SEV_SWATCH, TYPE_LABEL } from '@/lib/format';
import { useDark } from '@/hooks/use-dark';
import { cn } from '@/lib/utils';

const PECO_OUTAGE_MAP = 'https://www.peco.com/outages/experiencing-an-outage/outage-map';

function useIsWide() {
  const [wide, setWide] = useState(() => matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    const mq = matchMedia('(min-width: 1024px)');
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export function MapPage() {
  const { data, error } = useCityData();
  if (error) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <Wordmark />
        <p className="mt-6">Couldn&rsquo;t load the dataset: {error}</p>
        <p className="mt-2 text-sm text-muted-foreground">Run <code>python pipeline/build_dataset.py</code>, then reload.</p>
      </div>
    );
  }
  if (!data) return <div className="grid h-dvh place-items-center font-mono text-sm text-muted-foreground">Loading the city grid…</div>;
  return <Desk data={data} />;
}

type Selection = { kind: 'incident'; id: number } | { kind: 'cell'; id: number } | null;

function Desk({ data }: { data: CityData }) {
  const { model } = data;
  const last = model.meta.days - 1;
  const [day, setDay] = useState(last);
  const [playing, setPlaying] = useState(false);
  const [metric, setMetric] = useState<Metric>('excess');
  const [layers, setLayers] = useState<Layers>({ cells: true, flags: true, markers: true, r311: false, hoods: false });
  const [params, setParams] = useState<Params>({ minDrop: 0.08, zThr: 4, kMin: 25 });
  const [debounced, setDebounced] = useState(params);
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState('incidents');
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const mapRef = useRef<MapHandle>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => { feedRef.current?.scrollTo(0, 0); }, [selection]);
  const wide = useIsWide();
  const { reports, error: reportsError } = use311(model);

  useEffect(() => { const t = setTimeout(() => setDebounced(params), 120); return () => clearTimeout(t); }, [params]);
  const det = useMemo(() => detect(model, debounced), [model, debounced]);
  const incidents = useMemo(() => incidentsAt(model, det, day), [model, det, day]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setDay((d) => { if (d >= last) { setPlaying(false); return d; } return d + 1; }), 380);
    return () => clearInterval(t);
  }, [playing, last]);

  const openIncident = selection?.kind === 'incident' ? incidents.find((i) => i.id === selection.id) ?? null : null;
  const selectedCell = selection?.kind === 'cell' ? model.cells[selection.id] : null;
  // The alert is for what you're *not* already looking at.
  const alert = incidents.find((i) => i.active && i.severity !== 'info' && !dismissed.has(i.id) && i.id !== openIncident?.id);
  const padding = wide ? { top: alert ? 190 : 50, bottom: 50, left: 50, right: 50 } : { top: 30, bottom: 30, left: 20, right: 20 };

  const focusIncident = (id: number, fly = true) => {
    setSelection({ kind: 'incident', id });
    setTab('incidents');
    const inc = incidents.find((i) => i.id === id);
    if (fly && inc) mapRef.current?.fitBounds(inc.bounds);
  };
  const selectCell = (id: number | null) => {
    setSelection(id === null ? null : { kind: 'cell', id });
    if (id !== null) setTab('incidents');
  };
  const setLayer = (k: keyof Layers, v: boolean) => setLayers((l) => ({ ...l, [k]: v }));

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:flex-row lg:overflow-hidden">
      <Toaster position="bottom-center" toastOptions={{ className: 'font-sans !rounded-sm !border-rule !bg-popover !text-foreground' }} />

      {/* phones: branding above the map (the sidebar header is desktop-only) */}
      <header className="order-0 flex items-center justify-between border-b-2 border-ink bg-paper px-4 py-2.5 lg:hidden">
        <Wordmark className="text-[21px]" />
        <a href="#/" className="text-sm text-ink-2 underline-offset-4 hover:underline">About</a>
      </header>

      {/* ------------------------------------------------ sidebar */}
      <aside className="order-2 flex flex-col border-rule bg-paper lg:order-1 lg:h-full lg:w-[420px] lg:shrink-0 lg:border-r">
        <header className="hidden items-center justify-between border-b-2 border-ink px-5 pb-3 pt-4 lg:flex">
          <Wordmark className="text-[23px]" />
          <a href="#/" className="text-sm text-ink-2 underline-offset-4 hover:text-ink hover:underline">About the project</a>
        </header>
        <p className="border-b border-rule px-5 py-2 font-mono text-[11.5px] text-ink-2">
          {num(model.cells.length)} hexagons · {num(det.city.baseline)} routers ·{' '}
          {reports ? `${num(reports.length)} live 311 reports` : reportsError ? '311 unavailable' : 'loading 311…'}
          {model.meta.simulated && <span className="text-signal"> · Wi‑Fi simulated</span>}
        </p>

        <Timeline day={day} last={last} dates={model.dates} playing={playing}
          onDay={(d) => { setPlaying(false); setDay(d); }} onPlay={() => { if (day >= last) setDay(0); setPlaying((p) => !p); }} />

        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="h-auto w-full justify-start gap-5 rounded-none border-b border-rule bg-transparent p-0 px-5">
            {[['incidents', `Incidents (${incidents.filter((i) => i.active).length})`], ['layers', 'Map layers'], ['detection', 'Detection']].map(([v, label]) => (
              <TabsTrigger key={v} value={v}
                className="rounded-none border-b-2 border-transparent px-0 pb-2 pt-3 text-[13.5px] text-muted-foreground data-[state=active]:border-ink data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent ref={feedRef} value="incidents" className="mt-0 min-h-0 flex-1 overflow-y-auto">
            {openIncident ? (
              <IncidentDetail inc={openIncident} data={data} det={det} day={day} reports={reports} reportsError={reportsError}
                onBack={() => setSelection(null)} onZoom={() => mapRef.current?.fitBounds(openIncident.bounds)}
                onShow311={() => setLayer('r311', true)} />
            ) : selectedCell ? (
              <CellDetail cell={selectedCell} data={data} det={det} day={day} reports={reports} onBack={() => setSelection(null)} />
            ) : (
              <IncidentFeed incidents={incidents} data={data} det={det} day={day} onOpen={(id) => focusIncident(id)} />
            )}
          </TabsContent>

          <TabsContent value="layers" className="mt-0 min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <LayersPanel data={data} metric={metric} setMetric={setMetric} layers={layers} setLayer={setLayer}
              onJump={(b) => { setLayer('hoods', true); mapRef.current?.fitBounds(b, 15); }} onReset={() => mapRef.current?.fitCity()} />
          </TabsContent>

          <TabsContent value="detection" className="mt-0 min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <DetectionPanel params={params} setParams={setParams} />
          </TabsContent>
        </Tabs>
      </aside>

      {/* ------------------------------------------------ map */}
      <section className="relative order-1 h-[58dvh] min-h-[360px] lg:order-2 lg:h-full lg:flex-1">
        <MapView ref={mapRef} data={data} det={det} day={day} metric={metric} layers={layers} kMin={debounced.kMin}
          incidents={incidents} openIncident={openIncident?.id ?? null} selectedCell={selectedCell?.id ?? null}
          reports={reports} padding={padding}
          onSelectCell={selectCell} onSelectIncident={(id) => focusIncident(id)} />
        {alert && <AlertStrip inc={alert} data={data} det={det} day={day}
          onOpen={() => focusIncident(alert.id)} onDismiss={() => setDismissed((s) => new Set(s).add(alert.id))} />}
        <Legend metric={metric} r311={layers.r311} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- timeline

function Timeline({ day, last, dates, playing, onDay, onPlay }:
  { day: number; last: number; dates: Date[]; playing: boolean; onDay: (d: number) => void; onPlay: () => void }) {
  return (
    <div className="border-b border-rule px-5 pb-3 pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-serif text-[22px] leading-none">{fmtDate(dates[day], { weekday: 'long', month: 'long', day: 'numeric' })}</span>
        <span className="font-mono text-[11.5px] text-muted-foreground">day {day + 1}/{last + 1}</span>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={onPlay} aria-label={playing ? 'Pause' : 'Play the last 60 days'}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <Slider value={[day]} min={0} max={last} step={1} onValueChange={([d]) => onDay(d)} aria-label="Day" />
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" disabled={day === last} onClick={() => onDay(last)} aria-label="Jump to the latest day">
          <SkipForward />
        </Button>
      </div>
      <p className="mt-2 text-xs leading-snug text-muted-foreground">
        Signals trail real events by about a week: that&rsquo;s how long a powered-off router stays listed.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- incident feed

function SevTag({ inc, children }: { inc: Incident; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-2">
      <span className={cn('h-2 w-2', SEV_SWATCH[inc.severity])} aria-hidden />
      {SEV_LABEL[inc.severity]}
      {children}
    </span>
  );
}

function headline(inc: Incident) {
  return `${TYPE_LABEL[inc.type]} in ${place(inc)}`;
}

function summary(inc: Incident, data: CityData, day: number, city: number) {
  const since = fmtDate(data.model.dates[inc.onset]);
  if (inc.type === 'influx') return `Newly seen routers are ${pts(inc.now).replace('+', '')} above the city rate since ${since}, consistent with move-in week or new housing.`;
  if (inc.type === 'localized') return `${num(inc.apsNow)} routers in a small cluster vanished around ${since} and haven’t come back, consistent with a fire, collapse or demolition.`;
  if (!inc.active) return `${num(inc.apsPeak)} routers went dark at the peak. They’ve since come back, and the area is in line with the rest of the city.`;
  return `${pct(1 - inc.surv[day])} of the routers in ${inc.cellIds.length} hexagons are dark. The median Philadelphia hexagon still shows ${pct(city)}.`;
}

function IncidentFeed({ incidents, data, det, day, onOpen }:
  { incidents: Incident[]; data: CityData; det: ReturnType<typeof detect>; day: number; onOpen: (id: number) => void }) {
  const active = incidents.filter((i) => i.active);
  const earlier = incidents.filter((i) => !i.active);
  const flagged = det.flags[day].reduce((a, f) => a + (f ? 1 : 0), 0);
  const row = (inc: Incident) => (
    <li key={inc.id}>
      <button type="button" onClick={() => onOpen(inc.id)}
        className="grid w-full grid-cols-[1fr_auto] gap-3 border-b border-rule px-5 py-3.5 text-left transition-colors hover:bg-paper-2">
        <div className="min-w-0">
          <SevTag inc={inc}><span className="normal-case tracking-normal text-muted-foreground">
            {inc.active ? ` · ${inc.status.toLowerCase()} since ${fmtDate(data.model.dates[inc.onset])}` : ` · ${fmtDate(data.model.dates[inc.onset])} to ${fmtDate(data.model.dates[inc.last])}`}
          </span></SevTag>
          <div className="mt-1 font-serif text-[19px] leading-snug">{headline(inc)}</div>
          <div className="mt-0.5 text-[13px] text-muted-foreground">{inc.cellIds.length} {inc.cellIds.length === 1 ? 'hexagon' : 'hexagons'} · {num(inc.baseline)} routers</div>
        </div>
        <div className={cn('pt-5 font-mono text-[15px]', inc.kind > 0 ? 'text-gain' : inc.active ? 'text-signal' : 'text-muted-foreground')}>
          {inc.active ? pts(inc.kind < 0 ? -inc.now : inc.now) : `peak ${pts(-inc.peak)}`}
        </div>
      </button>
    </li>
  );
  return (
    <div>
      <dl className="grid grid-cols-3 border-b border-rule">
        {[
          ['Routers visible', pct(det.city.total[day], 1)],
          ['Cells flagged', num(flagged)],
          ['Active', num(active.filter((i) => i.severity !== 'info').length)],
        ].map(([k, v], i) => (
          <div key={k} className={cn('px-5 py-3', i && 'border-l border-rule')}>
            <dt className="text-[11.5px] text-muted-foreground">{k}</dt>
            <dd className="m-0 font-mono text-lg">{v}</dd>
          </div>
        ))}
      </dl>
      {active.length === 0 && (
        <p className="px-5 py-6 text-sm text-muted-foreground">Nothing flagged on {fmtDate(data.model.dates[day])} at these thresholds. Scrub the timeline back, or loosen the detection settings.</p>
      )}
      <ul className="m-0 list-none p-0">{active.map(row)}</ul>
      {earlier.length > 0 && (
        <>
          <h3 className="border-b border-rule bg-paper-2 px-5 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Earlier in this window</h3>
          <ul className="m-0 list-none p-0">{earlier.map(row)}</ul>
        </>
      )}
      <p className="px-5 py-4 text-xs text-muted-foreground">Click any hexagon on the map to see its own numbers.</p>
    </div>
  );
}

// ---------------------------------------------------------------- detail views

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 border-t border-rule">
      {items.map(([k, v], i) => (
        <div key={k} className={cn('border-b border-rule py-2', i % 2 ? 'pl-4' : 'border-r pr-4')}>
          <dt className="text-[11.5px] text-muted-foreground">{k}</dt>
          <dd className="m-0 text-[14px] font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Reports311({ reports, error, from, to, data, title }:
  { reports: Report[] | null; error?: string | null; from: number; to: number; data: CityData; title: string }) {
  const range = `${fmtDate(data.model.dates[from])} – ${fmtDate(data.model.dates[to])}`;
  let body: ReactNode;
  if (error) body = <p className="text-muted-foreground">The 311 feed is unavailable right now ({error}).</p>;
  else if (!reports) body = <p className="text-muted-foreground">Loading 311 reports…</p>;
  else if (!reports.length) body = <p className="text-muted-foreground">None filed {range}.</p>;
  else {
    const by = new Map<string, number>();
    for (const r of reports) by.set(r.service, (by.get(r.service) ?? 0) + 1);
    const groups = new Map<string, number>();
    for (const r of reports) groups.set(GROUP_LABEL[r.group], (groups.get(GROUP_LABEL[r.group]) ?? 0) + 1);
    body = (
      <>
        <p className="mb-1.5 text-muted-foreground">{reports.length} filed {range}: {[...groups].map(([g, n]) => `${g.toLowerCase()} ${n}`).join(', ')}.</p>
        <ul className="m-0 list-none p-0">
          {[...by].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, n]) => (
            <li key={s} className="flex justify-between border-b border-rule/60 py-1"><span>{s}</span><b className="font-mono font-medium">{n}</b></li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <div className="text-[13.5px]">
      <h4 className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">{title}</h4>
      {body}
    </div>
  );
}

function BackLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink">
      <ArrowLeft className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function brief(inc: Incident, data: CityData, det: ReturnType<typeof detect>, day: number, reports: Report[] | null) {
  const { model } = data;
  const lagStart = Math.max(0, inc.onset - model.meta.wpsLagDays);
  const near = reportsIn(reports, inc.cellIds, lagStart, day);
  return [
    `PhillyAlert: ${headline(inc)}`,
    `${SEV_LABEL[inc.severity]}, ${inc.status.toLowerCase()} as of ${fmtDate(model.dates[day], { month: 'long', day: 'numeric', year: 'numeric' })}.`,
    summary(inc, data, day, det.city.surv[day]),
    `Wi-Fi signal first flagged ${fmtDate(model.dates[inc.onset])}; the event itself likely began around ${fmtDate(model.dates[lagStart])}.`,
    `Area: ${inc.hoods.slice(0, 4).join(', ')} (${inc.cellIds.length} hexagons, ${num(inc.baseline)} routers).`,
    near ? `311 infrastructure reports in these hexagons since then: ${near.length}.` : '311 reports: unavailable.',
    model.meta.simulated ? 'Note: Wi-Fi counts are simulated demo data; 311 reports are real.' : '',
  ].filter(Boolean).join('\n');
}

function IncidentDetail({ inc, data, det, day, reports, reportsError, onBack, onZoom, onShow311 }: {
  inc: Incident; data: CityData; det: ReturnType<typeof detect>; day: number; reports: Report[] | null; reportsError: string | null;
  onBack: () => void; onZoom: () => void; onShow311: () => void;
}) {
  const { model } = data;
  const influx = inc.kind > 0;
  const color = SEV_COLOR[inc.severity];
  const lagStart = Math.max(0, inc.onset - model.meta.wpsLagDays);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(brief(inc, data, det, day, reports));
    setCopied(true);
    toast('Incident brief copied', { description: 'Paste it into an email, a ticket or a group chat.' });
    setTimeout(() => setCopied(false), 2000);
  };
  const facts: [string, ReactNode][] = influx
    ? [
        ['New routers', `${pct(inc.fresh[day], 1)} of baseline`],
        ['City median', pct(det.city.fresh[day], 1)],
        ['First flagged', fmtDate(model.dates[inc.onset])],
        ['Area', `${inc.cellIds.length} hexagons · ${num(inc.baseline)} routers`],
      ]
    : [
        ['Still visible', pct(inc.surv[day], 1)],
        ['City median', pct(det.city.surv[day], 1)],
        ['Routers dark (now / peak)', `${num(inc.apsNow)} / ${num(inc.apsPeak)}`],
        ['Area', `${inc.cellIds.length} hexagons · ${num(inc.baseline)} routers`],
        ['First flagged', fmtDate(model.dates[inc.onset])],
        ['Likely began', `≈ ${fmtDate(model.dates[lagStart])}`],
      ];
  return (
    <article className="space-y-5 px-5 py-4">
      <BackLink onClick={onBack} label="All incidents" />
      <header>
        <SevTag inc={inc}><span className="normal-case tracking-normal text-muted-foreground"> · {inc.status.toLowerCase()}</span></SevTag>
        <h2 className="mt-1.5 font-serif text-[27px] leading-[1.1]">{headline(inc)}</h2>
        <p className="mt-2 text-[14.5px] text-ink-2">{summary(inc, data, day, det.city.surv[day])}</p>
        <p className="mt-1 text-[13px] text-muted-foreground">Also covers {inc.hoods.slice(2, 5).join(', ') || 'no other neighborhoods'}.</p>
      </header>
      <LineChart
        dates={model.dates} upTo={day} band={[inc.onset, Math.min(day, inc.last)]} bandColor={color}
        format={(v) => pct(v)}
        caption={influx ? 'New routers as a share of baseline, area vs. city median' : 'Share of baseline routers still visible, area vs. city median'}
        series={[
          { name: influx ? 'New routers here' : 'This area', color: influx ? 'hsl(var(--gain))' : 'hsl(var(--signal))', values: influx ? inc.fresh : inc.surv },
          { name: 'City median', color: 'hsl(var(--muted-foreground))', values: influx ? det.city.fresh : det.city.surv },
        ]}
      />
      <Facts items={facts} />
      <Reports311 reports={reportsIn(reports, inc.cellIds, lagStart, day)} error={reportsError} from={lagStart} to={day} data={data}
        title="Live 311 reports in these hexagons" />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onZoom}><LocateFixed /> Zoom to area</Button>
        <Button size="sm" variant="outline" onClick={onShow311}>Show 311 on map</Button>
        <Button size="sm" variant="outline" onClick={copy}>{copied ? <Check /> : <Copy />} Copy brief</Button>
        {!influx && (
          <Button size="sm" variant="link" asChild className="px-1 text-ink-2">
            <a href={PECO_OUTAGE_MAP} target="_blank" rel="noreferrer">PECO outage map <ExternalLink /></a>
          </Button>
        )}
      </div>
    </article>
  );
}

function CellDetail({ cell, data, det, day, reports, onBack }:
  { cell: Cell; data: CityData; det: ReturnType<typeof detect>; day: number; reports: Report[] | null; onBack: () => void }) {
  const { model } = data;
  const st = cellDay(cell, day, det.city);
  const surv = useMemo(() => cell.alive.map((a) => a / cell.baseline), [cell]);
  const from = Math.max(0, day - R311_WINDOW + 1);
  const area = ((3 * Math.sqrt(3)) / 2) * (model.meta.hexSizeM / 1000) ** 2;
  return (
    <article className="space-y-5 px-5 py-4">
      <BackLink onClick={onBack} label="All incidents" />
      <header>
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-2">One hexagon</span>
        <h2 className="mt-1.5 font-serif text-[27px] leading-[1.1]">{cell.hood}</h2>
        <p className="mt-2 text-[14.5px] text-ink-2">
          {pct(st.surv)} of this hexagon&rsquo;s {num(cell.baseline)} baseline routers are still visible, {pts(st.excess)} against the city median.
        </p>
      </header>
      <LineChart dates={model.dates} upTo={day} format={(v) => pct(v)} caption="Share of baseline routers still visible, this hexagon vs. city median"
        series={[
          { name: 'This hexagon', color: 'hsl(var(--signal))', values: surv },
          { name: 'City median', color: 'hsl(var(--muted-foreground))', values: det.city.surv },
        ]} />
      <Facts items={[
        ['Significance', `z = ${st.z.toFixed(1)}`],
        ['New routers', `${pct(st.fresh, 1)} of baseline`],
        ['Density', `${num(Math.round(cell.baseline / area))} routers/km²`],
        ['Status', det.flags[day][cell.id] < 0 ? 'Flagged: loss' : det.flags[day][cell.id] > 0 ? 'Flagged: influx' : 'Not flagged'],
      ]} />
      <Reports311 reports={reportsIn(reports, [cell.id], from, day)} from={from} to={day} data={data} title="Live 311 reports, last 14 days" />
    </article>
  );
}

// ---------------------------------------------------------------- map overlays

function AlertStrip({ inc, data, det, day, onOpen, onDismiss }:
  { inc: Incident; data: CityData; det: ReturnType<typeof detect>; day: number; onOpen: () => void; onDismiss: () => void }) {
  return (
    <div role="status" className="absolute left-3 right-3 top-3 z-10 flex gap-3 border border-l-4 border-rule bg-paper px-4 py-3 shadow-[0_6px_20px_rgb(0_0_0/0.14)] sm:right-auto sm:max-w-[560px]"
      style={{ borderLeftColor: SEV_COLOR[inc.severity] }}>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[11px] uppercase tracking-[0.08em]" style={{ color: SEV_COLOR[inc.severity] }}>
          Alert · {SEV_LABEL[inc.severity]} · since {fmtDate(data.model.dates[inc.onset])}
        </p>
        <p className="mt-1 font-serif text-[21px] leading-tight">{headline(inc)}</p>
        <p className="mt-1 text-[13.5px] text-ink-2 max-sm:hidden">{summary(inc, data, day, det.city.surv[day])}</p>
        <div className="mt-2 flex gap-4 text-[13.5px] font-medium">
          <button type="button" className="underline decoration-rule underline-offset-4 hover:decoration-ink" onClick={onOpen}>Details and zoom</button>
          {inc.kind < 0 && <a href={PECO_OUTAGE_MAP} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline decoration-rule underline-offset-4 hover:decoration-ink">PECO outage map <ExternalLink className="h-3.5 w-3.5" /></a>}
        </div>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss alert" className="-mr-1 -mt-1 h-7 w-7 shrink-0 text-muted-foreground hover:text-ink">
        <X className="mx-auto h-4 w-4" />
      </button>
    </div>
  );
}

function Legend({ metric, r311 }: { metric: Metric; r311: boolean }) {
  const dark = useDark();
  const p = dark ? PALETTE.dark : PALETTE.light;
  const diverging = [...p.red, p.mid, ...p.blue];
  const cfg = metric === 'density'
    ? { title: 'Routers per km²', stops: p.seq, labels: ['0', '1,200', '2,400+'] }
    : metric === 'excess'
      ? { title: 'Routers still visible vs. city median', stops: diverging, labels: ['−45 pts', 'same', '+45 pts'] }
      : { title: 'New routers vs. city rate', stops: diverging, labels: ['−45 pts', 'same', '+45 pts'] };
  return (
    <div className="absolute bottom-3 left-3 z-10 w-[230px] border border-rule bg-paper/95 px-3 py-2.5 max-sm:w-[190px]">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-2">{cfg.title}</p>
      <div className="mt-1.5 h-2" style={{ background: `linear-gradient(90deg, ${cfg.stops.join(',')})` }} />
      <div className="mt-1 flex justify-between font-mono text-[10.5px] text-muted-foreground">{cfg.labels.map((l) => <span key={l}>{l}</span>)}</div>
      {r311 && (
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-ink-2">
          <span className="inline-block h-2 w-2 rounded-full bg-ink ring-2 ring-paper" /> 311 report, last {R311_WINDOW} days
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings panels

function LayersPanel({ data, metric, setMetric, layers, setLayer, onJump, onReset }: {
  data: CityData; metric: Metric; setMetric: (m: Metric) => void; layers: Layers; setLayer: (k: keyof Layers, v: boolean) => void;
  onJump: (b: [[number, number], [number, number]]) => void; onReset: () => void;
}) {
  const names = useMemo(() => data.hoods.features.map((f) => f.properties.name).sort(), [data]);
  const jump = (q: string) => {
    const f = data.hoods.features.find((h) => h.properties.name.toLowerCase() === q.trim().toLowerCase());
    if (!f) return;
    const coords = (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.flat(2) : f.geometry.coordinates.flat(1)) as number[][];
    const lons = coords.map((c) => c[0]), lats = coords.map((c) => c[1]);
    onJump([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]]);
  };
  const metrics: [Metric, string, string][] = [
    ['excess', 'Loss', 'Routers still visible, against the city median. Red: fewer than the city.'],
    ['gain', 'New routers', 'Routers seen for the first time, against the city rate. Blue: an unusual influx.'],
    ['density', 'Density', 'How many routers each hexagon had in the baseline week.'],
  ];
  const toggles: [keyof Layers, string][] = [
    ['cells', 'Hexagons'], ['flags', 'Outline flagged hexagons'], ['markers', 'Incident labels'],
    ['r311', `311 infrastructure reports (last ${R311_WINDOW} days)`], ['hoods', 'Neighborhood boundaries'],
  ];
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">Color the map by</h3>
        <div role="radiogroup" className="border-t border-rule">
          {metrics.map(([m, label, help]) => (
            <label key={m} className="flex cursor-pointer gap-3 border-b border-rule py-2.5">
              <input type="radio" name="metric" checked={metric === m} onChange={() => setMetric(m)} className="mt-1 accent-[hsl(var(--ink))]" />
              <span><span className="block text-[14px] font-medium">{label}</span><span className="block text-[12.5px] text-muted-foreground">{help}</span></span>
            </label>
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">Show</h3>
        <div className="border-t border-rule">
          {toggles.map(([k, label]) => (
            <label key={k} className="flex cursor-pointer items-center justify-between gap-4 border-b border-rule py-2.5 text-[14px]">
              {label}
              <Switch checked={layers[k]} onCheckedChange={(v) => setLayer(k, v)} />
            </label>
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">Go to a neighborhood</h3>
        <div className="flex gap-2">
          <Input list="hood-names" placeholder="Kensington, Eastwick…" className="h-9" onChange={(e) => jump(e.target.value)} />
          <datalist id="hood-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
          <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={onReset} aria-label="Show all of Philadelphia"><RotateCcw /></Button>
        </div>
      </section>
    </div>
  );
}

function DetectionPanel({ params, setParams }: { params: Params; setParams: (p: Params) => void }) {
  const rows: { key: keyof Params; label: string; help: string; min: number; max: number; step: number; show: (v: number) => string; scale?: number }[] = [
    { key: 'minDrop', label: 'Minimum gap from the city', help: 'How far below the median hexagon a cell must fall.', min: 3, max: 30, step: 1, scale: 100, show: (v) => `${v} pts` },
    { key: 'zThr', label: 'Significance', help: 'How unlikely the gap must be by chance, as a z-score. Higher means fewer, surer flags.', min: 2, max: 8, step: 0.5, show: (v) => v.toFixed(1) },
    { key: 'kMin', label: 'Smallest hexagon counted', help: 'Hexagons with fewer baseline routers are ignored.', min: 25, max: 150, step: 5, show: (v) => `${v} routers` },
  ];
  return (
    <div className="space-y-6">
      {rows.map((r) => {
        const value = params[r.key] * (r.scale ?? 1);
        return (
          <div key={r.key}>
            <div className="flex items-baseline justify-between">
              <span className="text-[14px] font-medium">{r.label}</span>
              <span className="font-mono text-[13px]">{r.show(Math.round(value * 10) / 10)}</span>
            </div>
            <Slider className="mt-3" value={[value]} min={r.min} max={r.max} step={r.step} aria-label={r.label}
              onValueChange={([v]) => setParams({ ...params, [r.key]: v / (r.scale ?? 1) })} />
            <p className="mt-2 text-[12.5px] text-muted-foreground">{r.help}</p>
          </div>
        );
      })}
      <p className="border-t border-rule pt-4 text-[12.5px] leading-relaxed text-muted-foreground">
        Every flag also needs at least 8 routers to be involved, and an incident has to last 3 days (or still be happening) to be listed.
        Loosen the settings to see how noisy single hexagons are.
      </p>
    </div>
  );
}
