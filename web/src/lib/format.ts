import type { Incident, IncidentType, Severity } from './detect';

export const fmtDate = (d: Date, o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) =>
  d.toLocaleDateString(undefined, o);
export const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;
export const pts = (v: number) => `${v > 0.0005 ? '+' : v < -0.0005 ? '−' : ''}${Math.abs(v * 100).toFixed(0)} pts`;
export const num = (v: number) => v.toLocaleString();
export const place = (inc: Incident, n = 2) => inc.hoods.slice(0, n).join(' & ');

export const TYPE_LABEL: Record<IncidentType, string> = {
  outage: 'Widespread outage',
  localized: 'Localized loss',
  influx: 'Population influx',
};

export const SEV_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  serious: 'Serious',
  warning: 'Watch',
  info: 'Notice',
  resolved: 'Restored',
};

/** Background class for the small square that marks severity; always shown next to its label. */
export const SEV_SWATCH: Record<Severity, string> = {
  critical: 'bg-signal',
  serious: 'bg-signal-2',
  warning: 'bg-amber',
  info: 'bg-gain',
  resolved: 'bg-good',
};

export const SEV_COLOR: Record<Severity, string> = {
  critical: 'hsl(var(--signal))',
  serious: 'hsl(var(--signal-2))',
  warning: 'hsl(var(--amber))',
  info: 'hsl(var(--gain))',
  resolved: 'hsl(var(--good))',
};

export function statLine(inc: Incident, day: number): string {
  if (inc.type === 'influx') return `new routers +${Math.round(inc.now * 100)} pts`;
  if (inc.type === 'localized') return `${num(inc.apsNow)} routers gone`;
  return `${pct(1 - inc.surv[day])} of routers dark`;
}
