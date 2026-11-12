/**
 * Drawing the chart of a result (prompt 042): scales, ticks, the shapes of lines, bars and points, the
 * point under the pointer, and the chart as an SVG file. Pure – the points come thinned from the backend.
 */
import { ChartData, ChartSeries, ChartSpec, ChartXKind } from '../../core/chart/chart-api';
import { QueryColumn } from '../../core/sql/query.models';

/** How the chart is drawn, beyond what the backend is asked for. */
export interface ChartOptions {
  /** A logarithmic value axis (values ≤ 0 are not drawn). */
  readonly log: boolean;
  /** Bars of a category stand on each other. */
  readonly stacked: boolean;
}

export const DEFAULT_OPTIONS: ChartOptions = { log: false, stacked: false };

/** The inner area of the chart, in px of its SVG. */
export interface Plot {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export const MARGIN = { left: 64, right: 16, top: 10, bottom: 46 };
export const SERIES_COLORS = 8;
/** Dash patterns of lines, so series differ not only by colour. */
export const DASHES = ['', '6 3', '2 3', '8 3 2 3', '1 4', '10 4', '4 2 1 2', '12 3 2 3 2 3'];
/** Marker shapes, in the order of the series. */
export const MARKERS = ['circle', 'square', 'triangle', 'diamond', 'cross', 'plus'] as const;
export type Marker = (typeof MARKERS)[number];
/** Points of a scatter series up to which each gets its marker shape; beyond, plain dots. */
export const MARKER_POINTS = 3000;

export function plotOf(width: number, height: number): Plot {
  return {
    left: MARGIN.left,
    top: MARGIN.top,
    width: Math.max(10, width - MARGIN.left - MARGIN.right),
    height: Math.max(10, height - MARGIN.top - MARGIN.bottom),
  };
}

/** A domain that is not empty: a single value gets room on both sides. */
export function domain(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    return [min - pad, max + pad];
  }
  return [min, max];
}

/** `count` or so round values between `min` and `max` (1, 2 or 5 times a power of ten apart). */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!(max > min) || count < 1) return [min];
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  // the round step nearest to the raw one
  const ratio = raw / power;
  const unit = ratio < 1.5 ? 1 : ratio < 3.5 ? 2 : ratio < 7.5 ? 5 : 10;
  const step = unit * power;
  const ticks: number[] = [];
  for (let i = Math.ceil(min / step); i * step <= max + step * 1e-9; i++) {
    // no -0, and no 0.30000000000000004
    ticks.push(Number((i * step).toPrecision(12)) || 0);
  }
  return ticks;
}

/** The powers of ten between `min` and `max` (both > 0); with few of them, 2 and 5 times each as well. */
export function logTicks(min: number, max: number): number[] {
  if (!(min > 0) || !(max >= min)) return [];
  const from = Math.floor(Math.log10(min));
  const to = Math.ceil(Math.log10(max));
  const few = to - from <= 3;
  const ticks: number[] = [];
  for (let e = from; e <= to; e++) {
    for (const m of few ? [1, 2, 5] : [1]) {
      const v = m * 10 ** e;
      if (v >= min * 0.999 && v <= max * 1.001) ticks.push(Number(v.toPrecision(12)));
    }
  }
  return ticks;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Steps of a time axis, in ms; months and years are counted by the calendar. */
const TIME_STEPS = [
  1,
  10,
  100,
  SECOND,
  5 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
];

/** What a tick of a time axis shows. */
export type TimeUnit = 'ms' | 'second' | 'minute' | 'day' | 'month' | 'year';

/** Ticks of a time axis (ms since 1970, UTC) at round times, and the unit their labels need. */
export function timeTicks(
  min: number,
  max: number,
  count: number,
): { ticks: number[]; unit: TimeUnit } {
  if (!(max > min)) return { ticks: [min], unit: 'day' };
  const raw = (max - min) / Math.max(1, count);
  const step = TIME_STEPS.find((s) => s >= raw);
  if (step !== undefined) {
    const ticks: number[] = [];
    for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t);
    const unit: TimeUnit =
      step < SECOND ? 'ms' : step < MINUTE ? 'second' : step < DAY ? 'minute' : 'day';
    return { ticks, unit };
  }
  // months or years: by the calendar
  const months = raw / (30 * DAY);
  // the step of the calendar nearest to what was asked for
  const steps = [1, 2, 3, 6, 12, 24, 60, 120, 240, 600, 1200];
  const every =
    months > 1200
      ? 1200 * Math.ceil(months / 1200)
      : steps.reduce((best, m) =>
          Math.abs(Math.log(m / months)) < Math.abs(Math.log(best / months)) ? m : best,
        );
  const first = new Date(min);
  let year = first.getUTCFullYear();
  let month = first.getUTCMonth();
  // back to a multiple of the step
  const index = year * 12 + month;
  const start = Math.floor(index / every) * every;
  year = Math.floor(start / 12);
  month = start - year * 12;
  const ticks: number[] = [];
  for (let i = 0; i < 400; i++) {
    const t = Date.UTC(year, month + i * every, 1);
    if (t > max) break;
    if (t >= min) ticks.push(t);
  }
  return { ticks, unit: every >= 12 ? 'year' : 'month' };
}

const two = (n: number) => String(n).padStart(2, '0');

/** A time as text, as fine as `unit` asks (UTC: the times of the result as they are written). */
export function timeLabel(ms: number, unit: TimeUnit): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const date = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  const clock = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  switch (unit) {
    case 'year':
      return String(d.getUTCFullYear());
    case 'month':
      return date.slice(0, 7);
    case 'day':
      return date;
    case 'minute':
      return `${date} ${clock}`;
    case 'second':
      return `${date} ${clock}:${two(d.getUTCSeconds())}`;
    case 'ms':
      return `${date} ${clock}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
  }
}

/** A time of day (ms since midnight) as `HH:MM:SS`. */
export function clockLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  const text = `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
  const rest = Math.round(ms % 1000);
  return rest ? `${text}.${String(rest).padStart(3, '0')}` : text;
}

/** A number for an axis or a tooltip: short, in the way of `locale`. */
export function numberLabel(value: number, locale: string, precise = false): string {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (!precise && abs >= 1e6) {
    return value.toLocaleString(locale, { notation: 'compact', maximumFractionDigits: 2 });
  }
  if (abs !== 0 && abs < 1e-4) return value.toExponential(2);
  return value.toLocaleString(locale, { maximumFractionDigits: precise ? 6 : 4 });
}

/** X as text: for a tick (`unit` of the axis) or for a tooltip (as fine as it goes). */
export function xLabel(
  x: number,
  kind: ChartXKind,
  categories: readonly string[],
  locale: string,
  unit: TimeUnit = 'second',
): string {
  switch (kind) {
    case 'time':
      return timeLabel(x, unit);
    case 'clock':
      return clockLabel(x);
    case 'category':
      return categories[Math.round(x)] ?? '';
    default:
      return numberLabel(x, locale, true);
  }
}

/** A label that fits: cut with `…`. */
export function fit(label: string, chars: number): string {
  return label.length > chars ? `${label.slice(0, Math.max(1, chars - 1))}…` : label;
}

/** The series that are drawn, with the place among all (its colour and dash follow that). */
export interface Shown {
  readonly index: number;
  readonly series: ChartSeries;
}

export function shownSeries(data: ChartData, hidden: ReadonlySet<number>): Shown[] {
  return data.series
    .map((series, index) => ({ index, series }))
    .filter((s) => !hidden.has(s.index));
}

/** Whether bars stand on each other: asked for, and there is more than one series of bars. */
export function isStacked(data: ChartData, options: ChartOptions, shown: number): boolean {
  return options.stacked && data.kind === 'bar' && shown > 1;
}

/**
 * The smallest and the largest value that is drawn: bars start at zero, stacked bars reach as far as
 * their sums, a logarithmic axis knows only values above zero.
 */
export function valueExtent(
  data: ChartData,
  shown: readonly Shown[],
  options: ChartOptions,
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  const take = (v: number) => {
    if (options.log && !(v > 0)) return;
    if (v < min) min = v;
    if (v > max) max = v;
  };
  if (isStacked(data, options, shown.length)) {
    const count = Math.max(0, ...shown.map((s) => s.series.y.length));
    for (let i = 0; i < count; i++) {
      let up = 0;
      let down = 0;
      for (const s of shown) {
        const v = s.series.y[i];
        if (v === null || v === undefined) continue;
        if (v >= 0) up += v;
        else down += v;
      }
      take(up);
      take(down);
    }
  } else {
    for (const s of shown) for (const v of s.series.y) if (v !== null) take(v);
  }
  if (min === Infinity) return options.log ? [1, 10] : [0, 1];
  if (data.kind === 'bar' && !options.log) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (options.log) return min === max ? [min / 10, max * 10] : [min, max];
  if (min === max) return domain(min, max);
  // a little room above and below, so a line does not run along the frame
  const pad = data.kind === 'bar' ? 0 : (max - min) * 0.04;
  return [min - (min === 0 ? 0 : pad), max + pad];
}

/** A value → its place on an axis; `null` for what a logarithmic axis cannot show. */
export type Scale = (value: number) => number | null;

export function linearScale(d: readonly [number, number], from: number, to: number): Scale {
  const span = d[1] - d[0] || 1;
  return (v) => from + ((v - d[0]) / span) * (to - from);
}

export function logScale(d: readonly [number, number], from: number, to: number): Scale {
  const a = Math.log10(d[0]);
  const span = Math.log10(d[1]) - a || 1;
  return (v) => (v > 0 ? from + ((Math.log10(v) - a) / span) * (to - from) : null);
}

const px = (n: number) => String(Math.round(n * 10) / 10);

/** A line through the points; a gap (a NULL, or a value the axis cannot show) starts a new stretch. */
export function linePath(series: ChartSeries, sx: Scale, sy: Scale): string {
  let d = '';
  let pen = false;
  let lone: [number, number] | null = null;
  const flushLone = () => {
    // a single point between two gaps is a line of no length: drawn as a dot by a round cap
    if (lone) d += `h0`;
    lone = null;
  };
  for (let i = 0; i < series.x.length; i++) {
    const v = series.y[i];
    const x = sx(series.x[i]);
    const y = v === null || v === undefined ? null : sy(v);
    if (x === null || y === null) {
      flushLone();
      pen = false;
      continue;
    }
    if (pen) {
      d += `L${px(x)} ${px(y)}`;
      lone = null;
    } else {
      d += `M${px(x)} ${px(y)}`;
      lone = [x, y];
      pen = true;
    }
  }
  flushLone();
  return d;
}

/** The outline of a marker around a point. */
export function markerPath(marker: Marker, x: number, y: number, r: number): string {
  const X = px(x);
  const Y = px(y);
  const R = px(r);
  switch (marker) {
    case 'circle':
      return `M${px(x - r)} ${Y}a${R} ${R} 0 1 0 ${px(2 * r)} 0a${R} ${R} 0 1 0 ${px(-2 * r)} 0Z`;
    case 'square':
      return `M${px(x - r)} ${px(y - r)}h${px(2 * r)}v${px(2 * r)}h${px(-2 * r)}Z`;
    case 'triangle':
      return `M${X} ${px(y - r)}L${px(x + r)} ${px(y + r)}L${px(x - r)} ${px(y + r)}Z`;
    case 'diamond':
      return `M${X} ${px(y - r)}L${px(x + r)} ${Y}L${X} ${px(y + r)}L${px(x - r)} ${Y}Z`;
    case 'cross':
      return `M${px(x - r)} ${px(y - r)}L${px(x + r)} ${px(y + r)}M${px(x + r)} ${px(y - r)}L${px(x - r)} ${px(y + r)}`;
    case 'plus':
      return `M${px(x - r)} ${Y}H${px(x + r)}M${X} ${px(y - r)}V${px(y + r)}`;
  }
}

export const markerOf = (index: number): Marker => MARKERS[index % MARKERS.length];
/** Markers that are lines: drawn with a stroke, not filled. */
export const isOpenMarker = (marker: Marker) => marker === 'cross' || marker === 'plus';

/** The points of a scatter series as one path: markers, or dots (lines of no length) when there are many. */
export function pointsPath(series: ChartSeries, index: number, sx: Scale, sy: Scale): string {
  const dots = series.x.length > MARKER_POINTS;
  const marker = markerOf(index);
  let d = '';
  for (let i = 0; i < series.x.length; i++) {
    const v = series.y[i];
    if (v === null || v === undefined) continue;
    const x = sx(series.x[i]);
    const y = sy(v);
    if (x === null || y === null) continue;
    d += dots ? `M${px(x)} ${px(y)}h0` : markerPath(marker, x, y, 3);
  }
  return d;
}

/** The bars of every series as one path each: side by side in a category, or on each other. */
export function barPaths(
  data: ChartData,
  shown: readonly Shown[],
  options: ChartOptions,
  plot: Plot,
  sy: Scale,
): string[] {
  const categories = Math.max(1, data.categories.length);
  const band = plot.width / categories;
  const stacked = isStacked(data, options, shown.length);
  const inner = band * 0.8;
  const width = stacked ? inner : inner / Math.max(1, shown.length);
  const zero = sy(options.log ? Number.MIN_VALUE : 0) ?? plot.top + plot.height;
  const base = options.log ? plot.top + plot.height : zero;
  const up = new Array<number>(categories).fill(0);
  const down = new Array<number>(categories).fill(0);
  return shown.map((s, place) => {
    let d = '';
    for (let i = 0; i < s.series.x.length; i++) {
      const v = s.series.y[i];
      if (v === null || v === undefined) continue;
      const c = Math.round(s.series.x[i]);
      const left = plot.left + c * band + band * 0.1 + (stacked ? 0 : place * width);
      let from = base;
      let to: number | null;
      if (stacked) {
        const start = v >= 0 ? up[c] : down[c];
        if (v >= 0) up[c] += v;
        else down[c] += v;
        from = (options.log && start <= 0 ? base : sy(start)) ?? base;
        to = sy(start + v);
      } else {
        to = sy(v);
      }
      if (to === null) continue;
      const top = Math.min(from, to);
      const height = Math.max(Math.abs(from - to), 0.5);
      d += `M${px(left)} ${px(top)}h${px(Math.max(width - 1, 0.5))}v${px(height)}h${px(-Math.max(width - 1, 0.5))}Z`;
    }
    return d;
  });
}

/** A tick of an axis: where it is, and what it says. */
export interface Tick {
  readonly at: number;
  readonly label: string;
}

/** The ticks of the value axis. */
export function valueTicks(
  extent: readonly [number, number],
  options: ChartOptions,
  sy: Scale,
  height: number,
  locale: string,
): Tick[] {
  const values = options.log
    ? logTicks(extent[0], extent[1])
    : niceTicks(extent[0], extent[1], Math.max(2, Math.floor(height / 44)));
  return values.flatMap((v) => {
    const at = sy(v);
    return at === null ? [] : [{ at, label: numberLabel(v, locale) }];
  });
}

/** The ticks of X: round values, round times, or (some of) the categories. */
export function xTicks(
  data: ChartData,
  range: readonly [number, number],
  plot: Plot,
  sx: Scale,
  locale: string,
): { ticks: Tick[]; unit: TimeUnit } {
  const room = Math.max(2, Math.floor(plot.width / 110));
  if (data.xKind === 'category') {
    const n = data.categories.length;
    const band = plot.width / Math.max(1, n);
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plot.width / 70))));
    const chars = Math.max(4, Math.floor((band * every) / 7));
    const ticks: Tick[] = [];
    for (let c = 0; c < n; c += every) {
      ticks.push({ at: plot.left + (c + 0.5) * band, label: fit(data.categories[c], chars) });
    }
    return { ticks, unit: 'day' };
  }
  if (data.xKind === 'time') {
    const { ticks, unit } = timeTicks(range[0], range[1], room);
    return {
      ticks: ticks.flatMap((t) => {
        const at = sx(t);
        return at === null ? [] : [{ at, label: timeLabel(t, unit) }];
      }),
      unit,
    };
  }
  const values =
    data.xKind === 'clock'
      ? timeTicks(range[0], range[1], room).ticks
      : niceTicks(range[0], range[1], room);
  return {
    ticks: values.flatMap((v) => {
      const at = sx(v);
      if (at === null) return [];
      const label = data.xKind === 'clock' ? clockLabel(v) : numberLabel(v, locale);
      return [{ at, label }];
    }),
    unit: 'second',
  };
}

/** The range of X that is drawn: what was asked for, else all of it; categories from -0.5. */
export function xRange(data: ChartData, zoom: readonly [number, number] | null): [number, number] {
  if (data.xKind === 'category') return [-0.5, Math.max(0, data.categories.length - 1) + 0.5];
  if (zoom) return [zoom[0], zoom[1]];
  return domain(data.xMin ?? 0, data.xMax ?? 1);
}

/** What the pointer is over: an X, and the value of each shown series there. */
export interface Hover {
  readonly x: number;
  /** Where X is on screen. */
  readonly at: number;
  readonly values: readonly { readonly index: number; readonly value: number | null }[];
}

/** The index of the point of a series (in the order of X) that is nearest to `x`; `-1` without points. */
export function nearestIndex(xs: readonly number[], x: number): number {
  if (xs.length === 0) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x) ? lo - 1 : lo;
}

/**
 * The points under a place of the screen: of lines and bars the X nearest to the pointer and what every
 * series has there; of a scatter plot the one point nearest to the pointer.
 */
export function hoverAt(
  data: ChartData,
  shown: readonly Shown[],
  pointer: { readonly x: number; readonly y: number },
  range: readonly [number, number],
  plot: Plot,
  sx: Scale,
  sy: Scale,
): Hover | null {
  if (shown.length === 0) return null;
  const value = range[0] + ((pointer.x - plot.left) / plot.width) * (range[1] - range[0]);
  if (data.kind === 'scatter') {
    let best: { d: number; x: number; index: number; value: number } | null = null;
    for (const s of shown) {
      for (let i = 0; i < s.series.x.length; i++) {
        const v = s.series.y[i];
        if (v === null) continue;
        const X = sx(s.series.x[i]);
        const Y = sy(v);
        if (X === null || Y === null) continue;
        const d = (X - pointer.x) ** 2 + (Y - pointer.y) ** 2;
        if (!best || d < best.d) best = { d, x: s.series.x[i], index: s.index, value: v };
      }
    }
    if (!best || best.d > 30 ** 2) return null;
    return {
      x: best.x,
      at: sx(best.x) ?? pointer.x,
      values: [{ index: best.index, value: best.value }],
    };
  }
  // the X of the series whose point is nearest
  let x: number | null = null;
  for (const s of shown) {
    const i = nearestIndex(s.series.x, value);
    if (i < 0) continue;
    const candidate = s.series.x[i];
    if (x === null || Math.abs(candidate - value) < Math.abs(x - value)) x = candidate;
  }
  if (x === null) return null;
  const at = sx(x);
  if (at === null) return null;
  const values = shown.map((s) => {
    const i = nearestIndex(s.series.x, x);
    return { index: s.index, value: i >= 0 && s.series.x[i] === x ? s.series.y[i] : null };
  });
  return { x, at, values };
}

/** A range of X from a drag on the plot (px); `null` for a drag too short to mean anything. */
export function dragRange(
  from: number,
  to: number,
  range: readonly [number, number],
  plot: Plot,
): [number, number] | null {
  if (Math.abs(to - from) < 5) return null;
  const at = (p: number) =>
    range[0] +
    (Math.min(Math.max(p - plot.left, 0), plot.width) / plot.width) * (range[1] - range[0]);
  const a = at(Math.min(from, to));
  const b = at(Math.max(from, to));
  return b > a ? [a, b] : null;
}

/**
 * A range of X after a step of zooming or moving, inside of all there is; `null` = all of it.
 * `factor` < 1 zooms in around the middle; `shift` moves by that share of the range.
 */
export function stepRange(
  range: readonly [number, number],
  all: readonly [number, number],
  factor: number,
  shift: number,
): [number, number] | null {
  const span = (range[1] - range[0]) * factor;
  const whole = all[1] - all[0];
  if (!(span > 0) || span >= whole) return null;
  const middle = (range[0] + range[1]) / 2 + (range[1] - range[0]) * shift;
  let from = middle - span / 2;
  from = Math.min(Math.max(from, all[0]), all[1] - span);
  return [from, from + span];
}

/** Whether a spec can be drawn from these columns. */
export function specFits(spec: ChartSpec, columns: readonly QueryColumn[]): boolean {
  const has = (c: number | null) => c === null || (c >= 0 && c < columns.length);
  return spec.ys.length > 0 && spec.ys.every(has) && has(spec.x) && has(spec.group);
}

/** The column kinds that are numbers. */
export const isNumeric = (c: QueryColumn) =>
  c.kind === 'int' || c.kind === 'float' || c.kind === 'decimal';

/** What a screen reader hears about the chart. */
export function describe(
  data: ChartData,
  shown: readonly Shown[],
  locale: string,
  t: {
    readonly kinds: Readonly<Record<ChartData['kind'], string>>;
    readonly described: (kind: string, series: string, points: string) => string;
    readonly range: (name: string, min: string, max: string) => string;
  },
): string {
  const points = shown.reduce((sum, s) => sum + s.series.points, 0);
  const parts = [
    t.described(
      t.kinds[data.kind],
      shown.map((s) => s.series.name).join(', '),
      points.toLocaleString(locale),
    ),
  ];
  for (const s of shown) {
    let min = Infinity;
    let max = -Infinity;
    for (const v of s.series.y) {
      if (v === null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min !== Infinity) {
      parts.push(
        t.range(s.series.name, numberLabel(min, locale, true), numberLabel(max, locale, true)),
      );
    }
  }
  return parts.join(' ');
}

/** Text for an XML file: markup characters as references, control characters (not allowed there) as blanks. */
const escapeXml = (text: string) =>
  Array.from(text, (c) => {
    if ('<>&"\''.includes(c)) return `&#${c.charCodeAt(0)};`;
    return c.charCodeAt(0) < 32 ? ' ' : c;
  }).join('');

/** Everything of a chart that is drawn, in px of its SVG. */
export interface Geometry {
  readonly width: number;
  readonly height: number;
  readonly plot: Plot;
  readonly xTicks: readonly Tick[];
  readonly yTicks: readonly Tick[];
  readonly shapes: readonly {
    readonly index: number;
    readonly name: string;
    readonly d: string;
    /** `line`: stroked with its dash; `bars`: filled; `points`: markers or dots. */
    readonly kind: 'line' | 'bars' | 'points';
    readonly dots: boolean;
  }[];
}

/** Lays a chart out for a size in px. */
export function geometry(
  data: ChartData,
  hidden: ReadonlySet<number>,
  options: ChartOptions,
  zoom: readonly [number, number] | null,
  width: number,
  height: number,
  locale: string,
): Geometry & {
  readonly range: [number, number];
  readonly sx: Scale;
  readonly sy: Scale;
  readonly unit: TimeUnit;
  readonly shown: Shown[];
} {
  const plot = plotOf(width, height);
  const shown = shownSeries(data, hidden);
  const range = xRange(data, zoom);
  const sx = linearScale(range, plot.left, plot.left + plot.width);
  const extent = valueExtent(data, shown, options);
  const bottom = plot.top + plot.height;
  const sy = options.log
    ? logScale(extent, bottom, plot.top)
    : linearScale(extent, bottom, plot.top);
  const x = xTicks(data, range, plot, sx, locale);
  let shapes: Geometry['shapes'];
  if (data.kind === 'bar') {
    const paths = barPaths(data, shown, options, plot, sy);
    shapes = shown.map((s, i) => ({
      index: s.index,
      name: s.series.name,
      d: paths[i],
      kind: 'bars' as const,
      dots: false,
    }));
  } else if (data.kind === 'scatter') {
    shapes = shown.map((s) => ({
      index: s.index,
      name: s.series.name,
      d: pointsPath(s.series, s.index, sx, sy),
      kind: 'points' as const,
      dots: s.series.x.length > MARKER_POINTS,
    }));
  } else {
    shapes = shown.map((s) => ({
      index: s.index,
      name: s.series.name,
      d: linePath(s.series, sx, sy),
      kind: 'line' as const,
      dots: false,
    }));
  }
  return {
    width,
    height,
    plot,
    xTicks: x.ticks,
    yTicks: valueTicks(extent, options, sy, plot.height, locale),
    shapes,
    range,
    sx,
    sy,
    unit: x.unit,
    shown,
  };
}

/** The colours a chart is written with into a file (resolved: a file knows no tokens). */
export interface Palette {
  readonly background: string;
  readonly text: string;
  readonly grid: string;
  readonly series: readonly string[];
}

/** The chart as an SVG document. Names of series are text of the result: escaped. */
export function toSvg(g: Geometry, palette: Palette, title: string): string {
  const { plot } = g;
  const bottom = plot.top + plot.height;
  const color = (index: number) => palette.series[index % palette.series.length] ?? palette.text;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${g.width}" height="${g.height + 22 * Math.ceil(g.shapes.length / 4)}" viewBox="0 0 ${g.width} ${g.height + 22 * Math.ceil(g.shapes.length / 4)}" font-family="sans-serif" font-size="11">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect width="100%" height="100%" fill="${palette.background}"/>`,
  ];
  for (const t of g.yTicks) {
    out.push(
      `<path d="M${plot.left} ${px(t.at)}H${plot.left + plot.width}" stroke="${palette.grid}"/>`,
      `<text x="${plot.left - 6}" y="${px(t.at + 4)}" text-anchor="end" fill="${palette.text}">${escapeXml(t.label)}</text>`,
    );
  }
  for (const t of g.xTicks) {
    out.push(
      `<path d="M${px(t.at)} ${bottom}v4" stroke="${palette.text}"/>`,
      `<text x="${px(t.at)}" y="${bottom + 16}" text-anchor="middle" fill="${palette.text}">${escapeXml(t.label)}</text>`,
    );
  }
  out.push(
    `<path d="M${plot.left} ${plot.top}V${bottom}H${plot.left + plot.width}" fill="none" stroke="${palette.text}"/>`,
  );
  for (const s of g.shapes) {
    const c = color(s.index);
    if (s.kind === 'bars') {
      out.push(`<path d="${s.d}" fill="${c}"/>`);
    } else if (s.kind === 'line') {
      const dash = DASHES[s.index % DASHES.length];
      out.push(
        `<path d="${s.d}" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
      );
    } else if (s.dots || isOpenMarker(markerOf(s.index))) {
      out.push(
        `<path d="${s.d}" fill="none" stroke="${c}" stroke-width="${s.dots ? 3 : 1.5}" stroke-linecap="round"/>`,
      );
    } else {
      out.push(`<path d="${s.d}" fill="${c}"/>`);
    }
  }
  g.shapes.forEach((s, i) => {
    const x = plot.left + (i % 4) * Math.floor(plot.width / 4);
    const y = g.height + 14 + 22 * Math.floor(i / 4);
    out.push(
      `<rect x="${x}" y="${y - 9}" width="10" height="10" fill="${color(s.index)}"/>`,
      `<text x="${x + 15}" y="${y}" fill="${palette.text}">${escapeXml(fit(s.name, 28))}</text>`,
    );
  });
  out.push('</svg>');
  return out.join('\n');
}
