import { ChartData, ChartSeries } from '../../core/chart/chart-api';
import {
  DEFAULT_OPTIONS,
  MARKER_POINTS,
  barPaths,
  clockLabel,
  describe as describeChart,
  domain,
  dragRange,
  fit,
  geometry,
  hoverAt,
  linePath,
  linearScale,
  logScale,
  logTicks,
  nearestIndex,
  niceTicks,
  numberLabel,
  plotOf,
  pointsPath,
  shownSeries,
  specFits,
  stepRange,
  timeLabel,
  timeTicks,
  toSvg,
  valueExtent,
  xLabel,
  xRange,
} from './chart-logic';

const series = (name: string, x: number[], y: (number | null)[]): ChartSeries => ({
  name,
  x,
  y,
  points: x.length,
});

const chart = (over: Partial<ChartData> = {}): ChartData => ({
  chartId: 1,
  kind: 'line',
  xKind: 'number',
  categories: [],
  series: [series('a', [0, 1, 2, 3], [1, 4, null, 2])],
  xMin: 0,
  xMax: 3,
  rows: 4,
  nulls: 1,
  skipped: 0,
  cutGroups: 0,
  cutCategories: 0,
  thinned: false,
  ...over,
});

const DAY = 86_400_000;

describe('chart logic', () => {
  it('finds round ticks', () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(0.1, 0.9, 4)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(niceTicks(-3, 3, 3)).toEqual([-2, 0, 2]);
    expect(niceTicks(1234, 98765, 4)).toEqual([20000, 40000, 60000, 80000]);
    expect(niceTicks(5, 5, 4)).toEqual([5]);
    // no -0 and no 0.30000000000000004
    expect(niceTicks(-0.1, 0.3, 4).map(String)).toEqual(['-0.1', '0', '0.1', '0.2', '0.3']);
  });

  it('finds the ticks of a logarithmic axis', () => {
    expect(logTicks(1, 1000)).toEqual([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]);
    expect(logTicks(1, 1e6)).toEqual([1, 10, 100, 1000, 1e4, 1e5, 1e6]);
    expect(logTicks(0, 10)).toEqual([]);
    expect(logTicks(3, 40)).toEqual([5, 10, 20]);
  });

  it('puts the ticks of a time axis on round times', () => {
    const start = Date.UTC(2024, 0, 1);
    const hours = timeTicks(start + 1, start + 5 * 3_600_000, 5);
    expect(hours.unit).toBe('minute');
    expect(hours.ticks.map((t) => timeLabel(t, hours.unit))).toEqual([
      '2024-01-01 01:00',
      '2024-01-01 02:00',
      '2024-01-01 03:00',
      '2024-01-01 04:00',
      '2024-01-01 05:00',
    ]);
    const days = timeTicks(start, start + 10 * DAY, 5);
    expect(days.unit).toBe('day');
    // every second day, counted from 1970: five of them lie in ten days from an odd one
    expect(days.ticks.length).toBe(5);
    const months = timeTicks(start, Date.UTC(2024, 11, 31), 6);
    expect(months.unit).toBe('month');
    expect(months.ticks.map((t) => timeLabel(t, 'month'))).toEqual([
      '2024-01',
      '2024-03',
      '2024-05',
      '2024-07',
      '2024-09',
      '2024-11',
    ]);
    const years = timeTicks(Date.UTC(1990, 5, 1), Date.UTC(2024, 0, 1), 6);
    expect(years.unit).toBe('year');
    expect(years.ticks.map((t) => timeLabel(t, 'year'))).toEqual([
      '1995',
      '2000',
      '2005',
      '2010',
      '2015',
      '2020',
    ]);
    const ms = timeTicks(start, start + 40, 4);
    expect(ms.unit).toBe('ms');
    expect(timeLabel(ms.ticks[1], 'ms')).toBe('2024-01-01 00:00:00.010');
    expect(timeTicks(5, 5, 4).ticks).toEqual([5]);
  });

  it('writes labels', () => {
    expect(clockLabel(3_723_000)).toBe('01:02:03');
    expect(clockLabel(3_723_250)).toBe('01:02:03.250');
    expect(numberLabel(1234.5678, 'de')).toBe('1.234,5678');
    expect(numberLabel(12_500_000, 'en')).toBe('12.5M');
    expect(numberLabel(12_500_000, 'en', true)).toBe('12,500,000');
    expect(numberLabel(0.00001234, 'en')).toBe('1.23e-5');
    expect(numberLabel(NaN, 'en')).toBe('');
    expect(xLabel(1, 'category', ['a', 'b'], 'en')).toBe('b');
    expect(xLabel(9, 'category', ['a', 'b'], 'en')).toBe('');
    expect(xLabel(Date.UTC(2024, 1, 29, 12), 'time', [], 'en', 'minute')).toBe('2024-02-29 12:00');
    expect(xLabel(1.5, 'number', [], 'de')).toBe('1,5');
    expect(fit('abcdefgh', 5)).toBe('abcd…');
    expect(fit('abc', 5)).toBe('abc');
    expect(timeLabel(NaN, 'day')).toBe('');
  });

  it('scales values, also logarithmically', () => {
    const s = linearScale([0, 10], 100, 200);
    expect(s(5)).toBe(150);
    const log = logScale([1, 100], 200, 0);
    expect(log(10)).toBe(100);
    expect(log(0)).toBeNull();
    expect(log(-5)).toBeNull();
    expect(domain(5, 5)).toEqual([4.5, 5.5]);
    expect(domain(0, 0)).toEqual([-1, 1]);
    expect(domain(NaN, 1)).toEqual([0, 1]);
  });

  it('draws a line with a gap where a value is NULL', () => {
    const sx = linearScale([0, 3], 0, 300);
    const sy = linearScale([0, 4], 100, 0);
    const d = linePath(series('a', [0, 1, 2, 3], [1, 4, null, 2]), sx, sy);
    // two stretches; the last point stands alone and is drawn as a dot
    expect(d).toBe('M0 75L100 0M300 50h0');
    expect(linePath(series('a', [], []), sx, sy)).toBe('');
    // what a logarithmic axis cannot show is a gap too
    const log = logScale([1, 100], 100, 0);
    expect(linePath(series('a', [0, 1, 2], [1, 0, 100]), sx, log)).toBe('M0 100h0M200 0h0');
  });

  it('knows how far the values reach', () => {
    const data = chart();
    expect(valueExtent(data, shownSeries(data, new Set()), DEFAULT_OPTIONS)).toEqual([0.88, 4.12]);
    const bars = chart({ kind: 'bar', xKind: 'category', categories: ['x', 'y'] });
    const two = {
      ...bars,
      series: [series('a', [0, 1], [3, 5]), series('b', [0, 1], [4, -2])],
    };
    const all = shownSeries(two, new Set());
    // bars start at zero
    expect(valueExtent(two, all, DEFAULT_OPTIONS)).toEqual([-2, 5]);
    expect(valueExtent(two, all, { log: false, stacked: true })).toEqual([-2, 7]);
    // nothing above zero on a logarithmic axis
    expect(valueExtent(two, all, { log: true, stacked: false })).toEqual([3, 5]);
    expect(valueExtent(data, [], DEFAULT_OPTIONS)).toEqual([0, 1]);
    const flat = chart({ series: [series('a', [0, 1], [7, 7])] });
    expect(valueExtent(flat, shownSeries(flat, new Set()), DEFAULT_OPTIONS)).toEqual([6.3, 7.7]);
  });

  it('lays bars side by side or on each other, and leaves a gap for NULL', () => {
    const data = chart({
      kind: 'bar',
      xKind: 'category',
      categories: ['x', 'y'],
      series: [series('a', [0, 1], [2, null]), series('b', [0, 1], [1, 3])],
    });
    const plot = { left: 0, top: 0, width: 200, height: 100 };
    const sy = linearScale([0, 4], 100, 0);
    const all = shownSeries(data, new Set());
    const side = barPaths(data, all, DEFAULT_OPTIONS, plot, sy);
    // series a has one bar (its second value is NULL), series b two
    expect(side[0].match(/M/g)?.length).toBe(1);
    expect(side[1].match(/M/g)?.length).toBe(2);
    expect(side[0]).toBe('M10 50h39v50h-39Z');
    expect(side[1].startsWith('M50 75h39v25h-39Z')).toBe(true);
    const stacked = barPaths(data, all, { log: false, stacked: true }, plot, sy);
    // b stands on a: from 2 to 3
    expect(stacked[1].startsWith('M10 25h79v25h-79Z')).toBe(true);
  });

  it('draws few points with their marker and many as dots', () => {
    const sx = linearScale([0, 10], 0, 100);
    const sy = linearScale([0, 10], 100, 0);
    const few = pointsPath(series('a', [1, 2], [1, null]), 1, sx, sy);
    expect(few).toBe('M7 87h6v6h-6Z');
    const many = Array.from({ length: MARKER_POINTS + 1 }, (_, i) => i % 10);
    const dots = pointsPath(series('a', many, many), 0, sx, sy);
    expect(dots.startsWith('M0 100h0M10 90h0')).toBe(true);
  });

  it('finds the point under the pointer', () => {
    expect(nearestIndex([0, 10, 20], 14)).toBe(1);
    expect(nearestIndex([0, 10, 20], 16)).toBe(2);
    expect(nearestIndex([0, 10, 20], -5)).toBe(0);
    expect(nearestIndex([], 1)).toBe(-1);
    const data = chart({
      series: [series('a', [0, 1, 2, 3], [1, 4, null, 2]), series('b', [1, 3], [9, 8])],
    });
    const g = geometry(data, new Set(), DEFAULT_OPTIONS, null, 480, 300, 'en');
    const at = (x: number) => ({ x: g.sx(x) ?? 0, y: 100 });
    const hover = hoverAt(data, g.shown, at(1.1), g.range, g.plot, g.sx, g.sy);
    expect(hover?.x).toBe(1);
    expect(hover?.values).toEqual([
      { index: 0, value: 4 },
      { index: 1, value: 9 },
    ]);
    // a series without a point at that X shows none; a NULL is a NULL
    const two = hoverAt(data, g.shown, at(2), g.range, g.plot, g.sx, g.sy);
    expect(two?.values).toEqual([
      { index: 0, value: null },
      { index: 1, value: null },
    ]);
    expect(hoverAt(data, [], at(1), g.range, g.plot, g.sx, g.sy)).toBeNull();
    const scatter = chart({ kind: 'scatter', series: [series('a', [0, 3], [1, 2])] });
    const s = geometry(scatter, new Set(), DEFAULT_OPTIONS, null, 480, 300, 'en');
    const near = { x: (s.sx(3) ?? 0) - 4, y: (s.sy(2) ?? 0) + 3 };
    expect(hoverAt(scatter, s.shown, near, s.range, s.plot, s.sx, s.sy)?.values).toEqual([
      { index: 0, value: 2 },
    ]);
    const far = { x: (s.sx(1.5) ?? 0) + 0, y: s.plot.top };
    expect(hoverAt(scatter, s.shown, far, s.range, s.plot, s.sx, s.sy)).toBeNull();
  });

  it('turns a drag into a range, and steps through the data', () => {
    const plot = plotOf(464 + 16, 300);
    expect(plot.width).toBe(400);
    expect(dragRange(plot.left + 100, plot.left + 300, [0, 100], plot)).toEqual([25, 75]);
    expect(dragRange(plot.left + 300, plot.left + 100, [0, 100], plot)).toEqual([25, 75]);
    expect(dragRange(plot.left + 100, plot.left + 102, [0, 100], plot)).toBeNull();
    // outside of the plot: its edge
    expect(dragRange(0, plot.left + 200, [0, 100], plot)).toEqual([0, 50]);
    expect(stepRange([0, 100], [0, 100], 0.5, 0)).toEqual([25, 75]);
    expect(stepRange([25, 75], [0, 100], 2, 0)).toBeNull();
    expect(stepRange([25, 75], [0, 100], 1, 0.25)).toEqual([37.5, 87.5]);
    // not beyond what there is
    expect(stepRange([60, 100], [0, 100], 1, 0.25)).toEqual([60, 100]);
    expect(stepRange([0, 40], [0, 100], 1, -0.25)).toEqual([0, 40]);
  });

  it('shows the range asked for, and categories from edge to edge', () => {
    expect(xRange(chart(), null)).toEqual([0, 3]);
    expect(xRange(chart(), [1, 2])).toEqual([1, 2]);
    expect(xRange(chart({ xKind: 'category', categories: ['a', 'b', 'c'] }), [1, 2])).toEqual([
      -0.5, 2.5,
    ]);
    expect(xRange(chart({ xMin: null, xMax: null }), null)).toEqual([0, 1]);
  });

  it('lays a chart out, without the series that are hidden', () => {
    const data = chart({
      series: [series('a', [0, 1, 2, 3], [1, 4, null, 2]), series('b', [0, 3], [2, 2])],
    });
    const g = geometry(data, new Set([1]), DEFAULT_OPTIONS, null, 480, 300, 'en');
    expect(g.shapes.map((s) => [s.index, s.name, s.kind])).toEqual([[0, 'a', 'line']]);
    expect(g.xTicks.map((t) => t.label)).toEqual(['0', '1', '2', '3']);
    expect(g.yTicks.length).toBeGreaterThan(2);
    const bars = chart({
      kind: 'bar',
      xKind: 'category',
      categories: ['Deutschland', 'Frankreich'],
      series: [series('a', [0, 1], [1, 2])],
    });
    const b = geometry(bars, new Set(), DEFAULT_OPTIONS, null, 480, 300, 'en');
    expect(b.xTicks.map((t) => t.label)).toEqual(['Deutschland', 'Frankreich']);
    expect(b.shapes[0].kind).toBe('bars');
    const many = chart({
      kind: 'bar',
      xKind: 'category',
      categories: Array.from({ length: 200 }, (_, i) => `Kategorie ${i}`),
      series: [series('a', [0], [1])],
    });
    // not every category has room for its name
    expect(
      geometry(many, new Set(), DEFAULT_OPTIONS, null, 480, 300, 'en').xTicks.length,
    ).toBeLessThan(10);
  });

  it('says what a chart shows, for those who do not see it', () => {
    const data = chart({ series: [series('Umsatz', [0, 1], [1, 4]), series('leer', [0], [null])] });
    const text = describeChart(data, shownSeries(data, new Set()), 'de', {
      kinds: { line: 'Linie', bar: 'Balken', scatter: 'Punktwolke' },
      described: (kind, names, points) => `${kind}: ${names}; ${points} Punkte.`,
      range: (name, min, max) => `${name} von ${min} bis ${max}.`,
    });
    expect(text).toBe('Linie: Umsatz, leer; 3 Punkte. Umsatz von 1 bis 4.');
  });

  it('writes the chart as SVG, with names as text', () => {
    const data = chart({ series: [series('<script>alert(1)</script>', [0, 1], [1, 2])] });
    const g = geometry(data, new Set(), DEFAULT_OPTIONS, null, 480, 300, 'en');
    const svg = toSvg(
      g,
      { background: '#000', text: '#fff', grid: '#333', series: ['#f00', '#0f0'] },
      'a "title" & more',
    );
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).not.toContain('<script');
    expect(svg).toContain('&#60;script&#62;');
    expect(svg).toContain('<title>a &#34;title&#34; &#38; more</title>');
    expect(svg).toContain('stroke="#f00"');
    expect(svg).not.toContain('var(--');
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
  });

  it('checks a spec against the columns', () => {
    const columns = [
      { name: 'a', kind: 'int' as const, typeName: '' },
      { name: 'b', kind: 'text' as const, typeName: '' },
    ];
    const spec = {
      kind: 'line' as const,
      x: 0,
      ys: [1],
      group: null,
      agg: 'sum' as const,
      sort: 'none' as const,
    };
    expect(specFits(spec, columns)).toBe(true);
    expect(specFits({ ...spec, ys: [2] }, columns)).toBe(false);
    expect(specFits({ ...spec, ys: [] }, columns)).toBe(false);
    expect(specFits({ ...spec, x: null, group: 5 }, columns)).toBe(false);
  });
});
