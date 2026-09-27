import { useMemo, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { HexMap } from '@/components/HexMap';
import { LineChart } from '@/components/LineChart';
import { REPO_URL, Wordmark } from '@/components/Wordmark';
import { detect, incidentsAt, type Incident } from '@/lib/detect';
import { useCityData, type CityData } from '@/lib/data';
import { fmtDate, num, pct } from '@/lib/format';

const PARAMS = { minDrop: 0.08, zThr: 4, kMin: 25 };

function OpenMap({ large = false }: { large?: boolean }) {
  return (
    <a href="#/map" className={`btn-ink ${large ? 'px-5 py-3 text-base' : ''}`}>
      {large ? 'Open the live map' : 'Open the map'} <ArrowRight className="h-4 w-4" aria-hidden />
    </a>
  );
}

function SectionHead({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <header className="mb-9 max-w-[46em]">
      <p className="kicker mb-3">{kicker}</p>
      <h2 className="font-serif text-[clamp(30px,3.6vw,42px)] font-normal leading-[1.1] tracking-[-0.015em]">{title}</h2>
      {children && <p className="mt-3.5 text-[17.5px] text-ink-2">{children}</p>}
    </header>
  );
}

function Ref() {
  return <sup><a href="#ref-1" className="font-mono text-[0.75em] text-signal no-underline">1</a></sup>;
}

export function Landing() {
  const { data, error } = useCityData();

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-[1180px] items-center justify-between gap-6 px-4 pb-3.5 pt-[18px] sm:px-7">
        <Wordmark />
        <nav aria-label="Primary" className="flex items-center gap-[22px] text-[15px]">
          {[['#signals', 'Signals'], ['#method', 'Method'], ['#privacy', 'Privacy'], [REPO_URL, 'Source']].map(([href, label]) => (
            <a key={href} href={href} className="text-ink-2 no-underline underline-offset-4 hover:text-ink hover:underline max-sm:hidden">{label}</a>
          ))}
          <OpenMap />
        </nav>
      </header>
      <Ticker data={data} error={error} />

      <main>
        <section className="mx-auto grid max-w-[1180px] gap-10 px-4 pb-16 pt-12 sm:px-7 lg:grid-cols-[5fr_7fr]">
          <div>
            <p className="kicker mb-3.5">Philadelphia &middot; neighborhood outage monitor</p>
            <h1 className="font-serif text-[clamp(38px,5.2vw,62px)] font-normal leading-[1.04] tracking-[-0.02em]">
              When a block&rsquo;s Wi&#8209;Fi goes dark, something happened there.
            </h1>
            <p className="mt-6 max-w-[34em] text-[18.5px] leading-relaxed text-ink-2">
              About a week after a router loses power, or burns, it drops out of the databases phones use to find their location.
              PhillyAlert counts those disappearances in every 450&#8209;meter hexagon of the city. It flags the neighborhoods that
              fall behind the rest of Philadelphia, then checks each flag against live 311 reports.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-6">
              <OpenMap large />
              <a href="#method" className="font-medium underline-offset-4 hover:text-signal">How it works</a>
            </div>
            <p className="mt-9 max-w-[30em] border-l-2 border-rule pl-3 text-sm leading-normal text-muted-foreground">
              The Wi&#8209;Fi counts on this site are simulated for the demo. The 311 reports are real and load live from the City.
            </p>
          </div>
          <figure className="m-0 self-start">
            {data ? <Hero data={data} /> : <div className="aspect-[720/660] animate-pulse bg-paper-2" />}
          </figure>
        </section>

        <section id="signals" className="border-y border-rule bg-paper-2 pb-[72px] pt-16">
          <div className="mx-auto max-w-[1180px] px-4 sm:px-7">
            <SectionHead kicker="Signals" title="What the map picks up">
              Every incident is measured the same way: the share of an area&rsquo;s routers still visible, drawn against the median
              Philadelphia hexagon. The shaded span is when the area was flagged.
            </SectionHead>
            {data && <Multiples data={data} />}
          </div>
        </section>

        <Method />
        <Privacy />
      </main>

      <footer className="mx-auto max-w-[1180px] px-4 pb-12 pt-14 sm:px-7">
        <div className="flex flex-wrap items-center justify-between gap-5 border-b border-t-2 border-b-rule border-t-ink py-[22px]">
          <p className="font-serif text-[22px] leading-tight sm:text-[26px]">See what the map is showing today.</p>
          <OpenMap large />
        </div>
        <ol className="mt-7 pl-5 text-sm text-ink-2">
          <li id="ref-1">
            Erik Rye and Dave Levin, &ldquo;Surveilling the Masses with Wi&#8209;Fi&#8209;Based Positioning Systems,&rdquo; IEEE Symposium
            on Security and Privacy, 2024. <a href="https://arxiv.org/abs/2405.14975" className="underline-offset-2">arXiv:2405.14975</a>
          </li>
        </ol>
        <p className="mt-3.5 text-[13.5px] text-muted-foreground">
          Boundaries and 311 data: City of Philadelphia via <a href="https://opendataphilly.org">OpenDataPhilly</a>. Basemap &copy; CARTO,
          &copy; OpenStreetMap contributors. Code on <a href={REPO_URL}>GitHub</a>.
        </p>
      </footer>
    </div>
  );
}

function useLatest(data: CityData) {
  return useMemo(() => {
    const det = detect(data.model, PARAMS);
    const day = data.model.meta.days - 1;
    return { det, day, incidents: incidentsAt(data.model, det, day) };
  }, [data]);
}

function Ticker({ data, error }: { data?: CityData; error?: string }) {
  const content = useMemo(() => {
    if (error) return <>Couldn&rsquo;t load the dataset ({error}).</>;
    if (!data) return <>Loading the latest counts…</>;
    const { model } = data;
    const det = detect(model, PARAMS);
    const day = model.meta.days - 1;
    const alerts = incidentsAt(model, det, day).filter((i) => i.active && i.kind < 0).length;
    const routers = model.cells.reduce((a, c) => a + c.baseline, 0);
    return (
      <>
        Data through {fmtDate(model.dates[day], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
        <Sep />{num(model.cells.length)} hexagons<Sep />{num(routers)} routers in the baseline
        <Sep /><b className="font-medium text-signal">{alerts} active {alerts === 1 ? 'alert' : 'alerts'}</b>
        <Sep />{model.meta.simulated ? 'Wi‑Fi counts simulated, 311 live' : '311 live'}
      </>
    );
  }, [data, error]);
  return (
    <div className="mx-auto max-w-[1180px] px-4 sm:px-7">
      <p className="border-b border-t-2 border-b-rule border-t-ink py-2 font-mono text-[12.5px] text-ink-2">{content}</p>
    </div>
  );
}

const Sep = () => <span className="px-2 text-rule">·</span>;

function Hero({ data }: { data: CityData }) {
  const { det, day, incidents } = useLatest(data);
  return (
    <>
      <HexMap data={data} det={det} day={day} incidents={incidents} />
      <figcaption className="mt-1 border-t border-rule pt-2.5 text-[13.5px] leading-normal text-muted-foreground">
        <span className="mr-1.5 font-mono text-ink-2">{fmtDate(data.model.dates[day], { month: 'long', day: 'numeric', year: 'numeric' })}.</span>
        Each hexagon is one ~450&nbsp;m cell. <span className="inline-block h-2.5 w-2.5 bg-signal align-[-1px]" /> Red cells kept fewer of their
        routers than the city median. <span className="inline-block h-2.5 w-2.5 bg-gain align-[-1px]" /> Blue cells saw an unusual number of new
        ones. Gray shows how dense each area&rsquo;s Wi&#8209;Fi is.
      </figcaption>
    </>
  );
}

function Multiples({ data }: { data: CityData }) {
  const { det, day, incidents } = useLatest(data);
  const { model } = data;
  const outage = incidents.find((i) => i.type === 'outage' && !i.active) ?? incidents.find((i) => i.type === 'outage');
  const local = incidents.find((i) => i.type === 'localized');
  const influx = incidents.find((i) => i.type === 'influx');
  const restoredOn = (i: Incident) => fmtDate(model.dates[Math.min(i.last + 1, model.meta.days - 1)]);

  const items: { title: string; inc?: Incident; note: (i: Incident) => string }[] = [
    {
      title: 'A storm outage, and the recovery',
      inc: outage,
      note: (i) => `${num(i.apsPeak)} routers went dark across ${i.cellIds.length} hexagons. When power came back they reappeared about a week later, and the area rejoined the city line${i.active ? '' : ` by ${restoredOn(i)}`}.`,
    },
    {
      title: 'A fire on one block',
      inc: local,
      note: (i) => `A single hexagon lost ${num(i.apsNow)} of its ${num(i.baseline)} routers and they never came back: the shape of a fire, a collapse or a demolition, not a power cut.`,
    },
    {
      title: 'Move-in week',
      inc: influx,
      note: (i) => `New routers across ${i.cellIds.length} hexagons around ${i.hoods[0]} jumped starting ${fmtDate(model.dates[i.onset])}. The same test, run in reverse, spots new housing or crowds.`,
    },
  ];

  return (
    <div className="grid border-t-2 border-ink md:grid-cols-3">
      {items.filter((it) => it.inc).map(({ title, inc, note }, idx) => {
        const i = inc!;
        const gain = i.kind > 0;
        const color = gain ? 'hsl(var(--gain))' : 'hsl(var(--signal))';
        return (
          <article key={title} className={`py-5 md:pr-6 ${idx ? 'max-md:border-t md:border-l md:pl-6' : ''} border-rule`}>
            <h3 className="text-lg font-semibold">{title}</h3>
            <p className="mb-3 mt-1 font-mono text-[12.5px] text-muted-foreground">{i.hoods.slice(0, 3).join(' · ')}</p>
            <LineChart
              dates={model.dates}
              upTo={day}
              band={[i.onset, Math.min(day, i.last)]}
              bandColor={color}
              format={(v) => pct(v)}
              caption={gain ? 'New routers as a share of baseline, area vs. city median' : 'Share of baseline routers still visible, area vs. city median'}
              series={[
                { name: gain ? 'New routers here' : 'This area', color, values: gain ? i.fresh : i.surv },
                { name: 'City median', color: 'hsl(var(--muted-foreground))', values: gain ? det.city.fresh : det.city.surv },
              ]}
            />
            <p className="mt-2.5 text-[15px] text-ink-2">{note(i)}</p>
          </article>
        );
      })}
    </div>
  );
}

function Method() {
  const steps = [
    ['Take a baseline.', 'Record which routers each hexagon has during a normal week. Cells with fewer than 25 are left off the map entirely.'],
    ['Count what’s still there.', 'Every day, count how many of those baseline routers are still listed, and how many new ones showed up. Those two numbers per cell are all the website ever receives.'],
    ['Compare with the rest of the city.', 'Routers disappear all the time, about 8% a month. A cell is flagged only when it falls well behind the median hexagon, by more than chance would explain for a cell its size.'],
    ['Check the street.', 'Neighboring flagged cells are grouped into one incident and followed day by day. Street-light, traffic-signal, building and drainage requests to 311 in the same cells serve as a second opinion.'],
  ];
  return (
    <section id="method" className="mx-auto max-w-[1180px] px-4 pb-20 pt-[72px] sm:px-7">
      <SectionHead kicker="Method" title="How a flag gets raised" />
      <div className="grid items-start gap-14 lg:grid-cols-[6fr_5fr]">
        <ol className="m-0 list-none p-0">
          {steps.map(([title, body], i) => (
            <li key={title} className={`grid grid-cols-[44px_1fr] gap-x-2 py-[18px] ${i ? 'border-t border-rule' : 'border-t-2 border-ink'}`}>
              <span className="row-span-2 font-serif text-[34px] leading-none text-signal">{i + 1}</span>
              <h3 className="text-lg font-semibold">{title}</h3>
              <p className="mt-1.5 text-ink-2">{body}</p>
            </li>
          ))}
        </ol>
        <figure className="m-0 lg:sticky lg:top-6">
          <LagDiagram />
          <figcaption className="mt-1.5 border-t border-rule pt-3 text-[15px] text-ink-2">
            The catch: it&rsquo;s slow. Researchers found it takes about a week for a powered-off router to drop out of Apple&rsquo;s
            location database.<Ref /> This is a tool for multi-day outages and damage, not for the first hour of an emergency.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function LagDiagram() {
  const label = 'fill-ink font-sans text-[13px] font-semibold';
  const small = 'fill-muted-foreground font-mono text-[12px]';
  return (
    <svg viewBox="0 0 520 176" className="block h-auto w-full" role="img" aria-label="Timeline: power goes out on day 0; the router stays listed until about day 7, when it drops out of the database; once enough neighbors follow, the cell is flagged.">
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" className="stroke-muted-foreground" strokeWidth={1.2} />
        </pattern>
      </defs>
      <text x="20" y="28" className={label}>Power goes out</text>
      <circle cx="20" cy="48" r="5" className="fill-signal" />
      <rect x="26" y="42" width="234" height="12" fill="url(#hatch)" />
      <text x="143" y="72" textAnchor="middle" className={small}>still listed as if nothing happened</text>
      <line x1="260" y1="36" x2="260" y2="140" className="stroke-ink" />
      <text x="268" y="28" className={label}>Router drops out of the database</text>
      <text x="268" y="88" className={label}>Enough neighbors follow → cell flagged</text>
      <rect x="268" y="96" width="232" height="12" className="fill-signal" />
      <line x1="20" y1="140" x2="500" y2="140" className="stroke-ink" />
      {[[20, 'day 0', 'start'], [260, '~day 7', 'middle'], [500, 'day 14', 'end']].map(([x, t, a]) => (
        <g key={t as string}>
          <line x1={x} y1="140" x2={x} y2="146" className="stroke-ink" />
          <text x={x} y="162" textAnchor={a as 'start'} className={small}>{t}</text>
        </g>
      ))}
    </svg>
  );
}

function Privacy() {
  return (
    <section id="privacy" className="bg-ink py-16 pb-[72px] text-paper">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-7">
        <header className="mb-9 max-w-[46em]">
          <p className="kicker mb-3 !text-signal-3">Privacy</p>
          <h2 className="font-serif text-[clamp(30px,3.6vw,42px)] font-normal leading-[1.1] tracking-[-0.015em]">Built from a warning</h2>
          <p className="mt-3.5 text-[17.5px] text-paper/80">
            The research behind this<Ref /> collected the locations of more than two billion routers and showed they could be used to
            follow travel routers across borders. We kept the part that shows neighborhoods in trouble and designed out the part that
            follows people.
          </p>
        </header>
        <div className="grid border-t border-paper/35 md:grid-cols-2">
          <Ledger title="What it does">
            <li>Counts routers per 450&nbsp;m hexagon, per day. That&rsquo;s the only Wi&#8209;Fi data that reaches your browser.</li>
            <li>Drops any network named <code className="bg-paper/15">_nomap</code> or <code className="bg-paper/15">_optout</code>, plus phone hotspots, before counting.</li>
            <li>Hides cells with fewer than 25 routers, so no single household stands out.</li>
          </Ledger>
          <Ledger title="What it won’t do" divided>
            <li>Show, store or publish any individual router, network name or address.</li>
            <li>Link a router from one day or place to another. Identifiers are scrambled with a key that is thrown away after each run.</li>
            <li>Scrape Apple&rsquo;s or Google&rsquo;s location services. Real deployments use data the operator is allowed to collect, such as city and campus networks or volunteer surveys.</li>
          </Ledger>
        </div>
      </div>
    </section>
  );
}

function Ledger({ title, divided, children }: { title: string; divided?: boolean; children: ReactNode }) {
  return (
    <div className={`pt-5 md:pr-7 ${divided ? 'max-md:mt-3 max-md:border-t md:border-l md:pl-7 border-paper/25' : ''}`}>
      <h3 className="text-lg font-semibold">{title}</h3>
      <ul className="mt-3 pl-[18px] text-paper/80 [&>li]:mb-2.5">{children}</ul>
    </div>
  );
}
