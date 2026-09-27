// Small SVG line chart: an area's surviving share of baseline APs vs. the citywide control,
// in the style of the paper's Gaza / Tel Aviv comparison (Fig. 12). Crosshair + tooltip on hover.

const NS = 'http://www.w3.org/2000/svg';
const fmtDate = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}

/**
 * @param {HTMLElement} host
 * @param {{dates: Date[], upTo: number, band?: [number, number], format: (v:number)=>string,
 *          series: {name: string, color: string, values: ArrayLike<number>}[], caption?: string}} opts
 */
export function lineChart(host, { dates, upTo, band, series, format, caption }) {
  host.innerHTML = '';
  host.classList.add('chart');

  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  legend.innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('');
  host.appendChild(legend);

  const W = Math.max(host.clientWidth || 380, 240);
  const H = 132;
  const m = { l: 34, r: 40, t: 6, b: 18 };
  const n = dates.length;
  const iw = W - m.l - m.r, ih = H - m.t - m.b;

  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (let i = 0; i <= upTo; i++) { lo = Math.min(lo, s.values[i]); hi = Math.max(hi, s.values[i]); }
  const step = hi - lo > 0.3 ? 0.1 : 0.05;
  const capAtOne = hi <= 1;
  lo = Math.max(0, Math.floor((lo - 0.005) / step) * step);
  hi = Math.ceil((hi + 0.005) / step) * step;
  if (capAtOne) hi = Math.min(hi, 1);
  if (hi - lo < step * 2) lo = hi - step * 2;

  const x = (i) => m.l + (i / (n - 1)) * iw;
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': caption ?? 'Line chart' }, host);

  // recessive grid + y ticks
  for (let v = lo; v <= hi + 1e-9; v += step) {
    el('line', { x1: m.l, x2: m.l + iw, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    el('text', { x: m.l - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, svg).textContent = format(v);
  }
  el('line', { x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih, stroke: 'var(--axis)', 'stroke-width': 1 }, svg);
  for (const i of [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1]) {
    el('text', { x: x(i), y: H - 3, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, svg).textContent = fmtDate(dates[i]);
  }

  if (band) {
    const [a, b] = band;
    el('rect', { x: x(a), y: m.t, width: Math.max(x(b) - x(a), 2), height: ih, fill: 'var(--sev, var(--status-critical))', opacity: 0.1 }, svg);
  }

  // series (only up to the selected day, so the chart never shows the "future")
  series.forEach((s, si) => {
    let dAttr = '';
    for (let i = 0; i <= upTo; i++) dAttr += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.values[i]).toFixed(1)}`;
    el('path', { d: dAttr, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    if (si === 0) {
      el('circle', { cx: x(upTo), cy: y(s.values[upTo]), r: 4, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
      el('text', { x: x(upTo) + 7, y: y(s.values[upTo]) + 3.5, class: 'end-label' }, svg).textContent = format(s.values[upTo]);
    }
  });

  // hover layer
  const cross = el('line', { y1: m.t, y2: m.t + ih, stroke: 'var(--ink-muted)', 'stroke-width': 1, visibility: 'hidden' }, svg);
  const dots = series.map((s) => el('circle', { r: 4, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' }, svg));
  const hit = el('rect', { x: m.l - 6, y: 0, width: iw + 12, height: H, fill: 'transparent' }, svg);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  host.appendChild(tip);

  const show = (evt) => {
    const box = svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(upTo, Math.round(((px - m.l) / iw) * (n - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    series.forEach((s, si) => {
      dots[si].setAttribute('cx', x(i)); dots[si].setAttribute('cy', y(s.values[i])); dots[si].setAttribute('visibility', 'visible');
    });
    tip.innerHTML = `<div class="d">${fmtDate(dates[i])}</div>` +
      series.map((s) => `<div class="r"><span><i style="background:${s.color}"></i>${s.name}</span><b>${format(s.values[i])}</b></div>`).join('');
    tip.hidden = false;
    const left = (x(i) / W) * box.width;
    tip.style.left = `${Math.min(Math.max(left - tip.offsetWidth / 2, 0), box.width - tip.offsetWidth)}px`;
    tip.style.top = `${legend.offsetHeight - tip.offsetHeight - 4}px`;
  };
  const hide = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((dt) => dt.setAttribute('visibility', 'hidden'));
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerleave', hide);

  // table view: the accessible alternative to the plot
  const det = document.createElement('details');
  det.className = 'chart-table';
  const rows = [];
  for (let i = 0; i <= upTo; i += 7) rows.push(i);
  if (rows[rows.length - 1] !== upTo) rows.push(upTo);
  det.innerHTML = `<summary>View as table</summary><table><thead><tr><th>Date</th>${series.map((s) => `<th>${s.name}</th>`).join('')}</tr></thead><tbody>` +
    rows.map((i) => `<tr><td>${fmtDate(dates[i])}</td>${series.map((s) => `<td>${format(s.values[i])}</td>`).join('')}</tr>`).join('') +
    '</tbody></table>';
  host.appendChild(det);
}
