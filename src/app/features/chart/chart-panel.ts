import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import {
  ChartAgg,
  ChartApi,
  ChartData,
  ChartKind,
  ChartSort,
  ChartSpec,
} from '../../core/chart/chart-api';
import { describeError, toAppError } from '../../core/errors/app-error';
import { locale } from '../../core/i18n/i18n';
import { SessionApi } from '../../core/session/session-api';
import { ResultRef } from '../../core/sql/query.models';
import { QueryTab } from '../tabs/query-tab';
import {
  DASHES,
  Hover,
  SERIES_COLORS,
  describe,
  dragRange,
  geometry,
  hoverAt,
  isNumeric,
  isOpenMarker,
  markerOf,
  markerPath,
  numberLabel,
  specFits,
  stepRange,
  toSvg,
  xLabel,
} from './chart-logic';
import { CHART_TEXTS } from './chart-texts';

/** Ids of the jobs that read a result into a chart: far from those of the other jobs. */
let nextChartJob = 8_000_000_000;
const MAX_SERIES = 12;

/**
 * The result of a tab as a chart (prompt 042). The backend reads the result and thins the points to the
 * width of the chart; here they are drawn as SVG, in the colours of the scheme (`--chart-1…8`). Zooming
 * asks the backend for the points of the range. Names of series and categories are text of the result:
 * they are only ever set as text.
 */
@Component({
  selector: 'app-chart-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar" role="group" [attr.aria-label]="t.settings">
      <label>
        {{ t.kind }}
        <select #kind [attr.aria-label]="t.kind" (change)="patch({ kind: asKind(kind.value) })">
          @for (k of kinds; track k) {
            <option [value]="k" [selected]="spec()?.kind === k">{{ t.kinds[k] }}</option>
          }
        </select>
      </label>
      <label>
        {{ t.x }}
        <select #x [attr.aria-label]="t.x" (change)="patch({ x: column(x.value) })">
          <option value="" [selected]="spec()?.x === null">{{ t.rowNumber }}</option>
          @for (c of result().columns; track $index) {
            <option [value]="$index" [selected]="spec()?.x === $index">{{ c.name }}</option>
          }
        </select>
      </label>
      <details class="values">
        <summary>{{ t.values }}: {{ t.valuesChosen(spec()?.ys?.length ?? 0) }}</summary>
        <ul>
          @for (c of valueColumns(); track c.index) {
            <li>
              <label>
                <input
                  type="checkbox"
                  [checked]="spec()?.ys?.includes(c.index) ?? false"
                  (change)="toggleValue(c.index)"
                />
                {{ c.name }}
              </label>
            </li>
          }
        </ul>
      </details>
      <label>
        {{ t.group }}
        <select #group [attr.aria-label]="t.group" (change)="patch({ group: column(group.value) })">
          <option value="" [selected]="spec()?.group === null">{{ t.none }}</option>
          @for (c of result().columns; track $index) {
            <option [value]="$index" [selected]="spec()?.group === $index">{{ c.name }}</option>
          }
        </select>
      </label>
      @if (spec()?.kind !== 'scatter') {
        <label>
          {{ t.agg }}
          <select #agg [attr.aria-label]="t.agg" (change)="patch({ agg: asAgg(agg.value) })">
            @for (a of aggs; track a) {
              <option [value]="a" [selected]="spec()?.agg === a">{{ t.aggs[a] }}</option>
            }
          </select>
        </label>
      }
      @if (data()?.xKind === 'category') {
        <label>
          {{ t.sort }}
          <select #sort [attr.aria-label]="t.sort" (change)="patch({ sort: asSort(sort.value) })">
            @for (s of sorts; track s) {
              <option [value]="s" [selected]="spec()?.sort === s">{{ t.sorts[s] }}</option>
            }
          </select>
        </label>
      }
      <label class="check">
        <input
          #log
          type="checkbox"
          [checked]="tab().chartOptions().log"
          (change)="option({ log: log.checked })"
        />
        {{ t.log }}
      </label>
      @if (spec()?.kind === 'bar') {
        <label class="check">
          <input
            #stacked
            type="checkbox"
            [checked]="tab().chartOptions().stacked"
            (change)="option({ stacked: stacked.checked })"
          />
          {{ t.stacked }}
        </label>
      }
      <span class="grow"></span>
      @if (zoomable()) {
        <span class="zoom" [title]="t.zoomHint">
          <button
            type="button"
            [attr.aria-label]="t.zoomIn"
            [title]="t.zoomIn"
            (click)="step(0.5, 0)"
          >
            +
          </button>
          <button
            type="button"
            [attr.aria-label]="t.zoomOut"
            [title]="t.zoomOut"
            [disabled]="!zoom()"
            (click)="step(2, 0)"
          >
            −
          </button>
          <button
            type="button"
            [attr.aria-label]="t.left"
            [title]="t.left"
            [disabled]="!zoom()"
            (click)="step(1, -0.25)"
          >
            ←
          </button>
          <button
            type="button"
            [attr.aria-label]="t.right"
            [title]="t.right"
            [disabled]="!zoom()"
            (click)="step(1, 0.25)"
          >
            →
          </button>
          <button type="button" [disabled]="!zoom()" (click)="setZoom(null)">{{ t.reset }}</button>
        </span>
      }
      <button type="button" [disabled]="!drawn()" (click)="saveSvg()">{{ t.saveSvg }}</button>
      <button type="button" [disabled]="!drawn()" (click)="copySvg()">{{ t.copySvg }}</button>
    </div>
    <p class="notes" role="status">
      @if (problem()) {
        <span class="error">{{ problem() }}</span>
      } @else if (!settled()) {
        {{ t.waiting }}
      } @else if (busy() && !data()) {
        {{ t.working }}
      } @else if (nothing()) {
        {{ t.nothing }}
      } @else if (noValues()) {
        {{ t.chooseValues }}
      } @else {
        {{ notes() }}
      }
      @if (note()) {
        <span class="done">{{ note() }}</span>
      }
    </p>
    <div
      #plot
      class="plot"
      [class.busy]="busy()"
      (pointerdown)="onDown($event)"
      (pointermove)="onMove($event)"
      (pointerup)="onUp($event)"
      (pointerleave)="hover.set(null)"
      (dblclick)="setZoom(null)"
    >
      @if (drawn(); as g) {
        <svg
          role="img"
          [attr.aria-label]="description()"
          [attr.width]="g.width"
          [attr.height]="g.height"
          [attr.viewBox]="'0 0 ' + g.width + ' ' + g.height"
        >
          <defs>
            <clipPath [attr.id]="uid + '-clip'">
              <rect
                [attr.x]="g.plot.left"
                [attr.y]="g.plot.top - 4"
                [attr.width]="g.plot.width"
                [attr.height]="g.plot.height + 8"
              />
            </clipPath>
            @for (s of g.shapes; track s.index) {
              @if (s.kind === 'bars') {
                <pattern
                  [attr.id]="uid + '-p' + s.index"
                  width="6"
                  height="6"
                  patternUnits="userSpaceOnUse"
                  [attr.patternTransform]="hatch(s.index)"
                >
                  <rect width="6" height="6" [style.fill]="color(s.index)" />
                  @if (s.index % 4 !== 0) {
                    <path d="M0 0V6" class="hatch" />
                  }
                  @if (s.index % 4 === 3) {
                    <path d="M0 0H6" class="hatch" />
                  }
                </pattern>
              }
            }
          </defs>
          @for (tick of g.yTicks; track $index) {
            <path
              class="grid"
              [attr.d]="'M' + g.plot.left + ' ' + tick.at + 'H' + (g.plot.left + g.plot.width)"
            />
            <text class="axis" text-anchor="end" [attr.x]="g.plot.left - 6" [attr.y]="tick.at + 4">
              {{ tick.label }}
            </text>
          }
          @for (tick of g.xTicks; track $index) {
            <path
              class="tick"
              [attr.d]="'M' + tick.at + ' ' + (g.plot.top + g.plot.height) + 'v4'"
            />
            <text
              class="axis"
              text-anchor="middle"
              [attr.x]="tick.at"
              [attr.y]="g.plot.top + g.plot.height + 16"
            >
              {{ tick.label }}
            </text>
          }
          <path
            class="frame"
            [attr.d]="
              'M' +
              g.plot.left +
              ' ' +
              g.plot.top +
              'V' +
              (g.plot.top + g.plot.height) +
              'H' +
              (g.plot.left + g.plot.width)
            "
          />
          <g [attr.clip-path]="'url(#' + uid + '-clip)'">
            @for (s of g.shapes; track s.index) {
              @switch (s.kind) {
                @case ('bars') {
                  <path [attr.d]="s.d" [attr.fill]="'url(#' + uid + '-p' + s.index + ')'" />
                }
                @case ('line') {
                  <path
                    class="line"
                    [attr.d]="s.d"
                    [style.stroke]="color(s.index)"
                    [attr.stroke-dasharray]="dash(s.index)"
                  />
                }
                @default {
                  @if (s.dots || open(s.index)) {
                    <path
                      class="dots"
                      [class.fine]="!s.dots"
                      [attr.d]="s.d"
                      [style.stroke]="color(s.index)"
                    />
                  } @else {
                    <path [attr.d]="s.d" [style.fill]="color(s.index)" />
                  }
                }
              }
            }
          </g>
          @if (hover(); as h) {
            <path
              class="cursor"
              [attr.d]="'M' + h.at + ' ' + g.plot.top + 'V' + (g.plot.top + g.plot.height)"
            />
          }
          @if (dragging(); as d) {
            <rect
              class="selection"
              [attr.x]="d.from < d.to ? d.from : d.to"
              [attr.y]="g.plot.top"
              [attr.width]="d.from < d.to ? d.to - d.from : d.from - d.to"
              [attr.height]="g.plot.height"
            />
          }
        </svg>
        @if (hover(); as h) {
          <div
            class="tip"
            [style.left.px]="tipLeft(h.at, g.width)"
            [style.top.px]="g.plot.top + 4"
            aria-hidden="true"
          >
            <div class="tip-x">{{ hoverX(h) }}</div>
            @for (v of h.values; track v.index) {
              <div>
                <span class="swatch" [style.background]="color(v.index)"></span>
                {{ name(v.index) }}: <b>{{ value(v.value) }}</b>
              </div>
            }
          </div>
        }
      }
    </div>
    @if (data(); as d) {
      <ul class="legend" [attr.aria-label]="t.legend">
        @for (s of d.series; track $index) {
          <li>
            <button
              type="button"
              [attr.aria-pressed]="!hidden().has($index)"
              [title]="hidden().has($index) ? t.show(s.name) : t.hide(s.name)"
              (click)="toggleSeries($index)"
            >
              <svg width="26" height="10" aria-hidden="true">
                @if (d.kind === 'line') {
                  <path
                    class="line"
                    d="M1 5H25"
                    [style.stroke]="color($index)"
                    [attr.stroke-dasharray]="dash($index)"
                  />
                } @else if (d.kind === 'scatter') {
                  <path
                    [attr.d]="legendMarker($index)"
                    [style.stroke]="color($index)"
                    [style.fill]="open($index) ? 'none' : color($index)"
                  />
                } @else {
                  <rect
                    x="6"
                    width="14"
                    height="10"
                    [attr.fill]="drawn() ? 'url(#' + uid + '-p' + $index + ')' : null"
                    [style.stroke]="color($index)"
                  />
                }
              </svg>
              {{ s.name }}
            </button>
          </li>
        }
      </ul>
      <p class="sr">{{ t.tableHint }}</p>
    }
  `,
  styles: `
    :host {
      height: 100%;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: var(--bg-app);
      font-size: 12px;
    }
    .bar {
      flex: none;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 12px;
      padding: 4px 8px;
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
    }
    label {
      display: flex;
      align-items: center;
      gap: 5px;
      color: var(--text-dim);
    }
    label.check,
    .values label {
      color: var(--text);
    }
    select {
      max-width: 16ch;
    }
    .grow {
      flex: 1;
    }
    button {
      padding: 1px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    button:disabled {
      color: var(--text-dim);
    }
    .zoom {
      display: flex;
      gap: 2px;
    }
    .values {
      position: relative;
    }
    .values summary {
      cursor: pointer;
      color: var(--text-dim);
    }
    .values ul {
      position: absolute;
      z-index: 5;
      top: 100%;
      left: 0;
      min-width: 180px;
      max-height: 240px;
      overflow: auto;
      margin: 2px 0 0;
      padding: 6px 10px;
      list-style: none;
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    .notes {
      flex: none;
      min-height: 16px;
      margin: 0;
      padding: 2px 8px;
      color: var(--text-dim);
      overflow-wrap: anywhere;
    }
    .error {
      color: var(--danger);
    }
    .done {
      margin-left: 10px;
      color: var(--ok);
    }
    .plot {
      position: relative;
      flex: 1;
      min-height: 60px;
      overflow: hidden;
      touch-action: none;
      cursor: crosshair;
    }
    .plot.busy {
      opacity: 0.6;
    }
    svg {
      display: block;
    }
    .grid {
      stroke: var(--chart-grid);
    }
    .tick,
    .frame {
      fill: none;
      stroke: var(--text-dim);
    }
    .axis {
      fill: var(--text-dim);
      font-size: 11px;
    }
    .line {
      fill: none;
      stroke-width: 1.5;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .dots {
      fill: none;
      stroke-width: 3;
      stroke-linecap: round;
    }
    .dots.fine {
      stroke-width: 1.5;
    }
    .hatch {
      stroke: var(--bg-app);
      stroke-width: 2;
    }
    .cursor {
      stroke: var(--text-dim);
      stroke-dasharray: 2 2;
    }
    .selection {
      fill: var(--accent);
      fill-opacity: 0.2;
      stroke: var(--accent);
    }
    .tip {
      position: absolute;
      z-index: 4;
      max-width: 260px;
      padding: 4px 8px;
      pointer-events: none;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tip-x {
      color: var(--text-dim);
    }
    .swatch {
      display: inline-block;
      width: 8px;
      height: 8px;
      margin-right: 4px;
    }
    .legend {
      flex: none;
      display: flex;
      flex-wrap: wrap;
      gap: 2px 6px;
      max-height: 64px;
      overflow: auto;
      margin: 0;
      padding: 3px 8px;
      list-style: none;
      border-top: 1px solid var(--border);
    }
    .legend button {
      display: flex;
      align-items: center;
      gap: 5px;
      border-color: transparent;
    }
    /* a series that is shown is the normal case: no look of a pressed button */
    .legend button[aria-pressed='true'] {
      background: none;
      color: var(--text);
    }
    .legend button[aria-pressed='false'] {
      color: var(--text-dim);
      text-decoration: line-through;
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class ChartPanel {
  readonly tab = input.required<QueryTab>();
  readonly result = input.required<ResultRef>();
  /** Rows of the result; a result that grew is read again. */
  readonly rows = input.required<number>();
  /** The statement has ended: only then is the result read into a chart. */
  readonly settled = input(true);

  private readonly api = inject(ChartApi);
  private readonly files = inject(FileDialogApi);
  private readonly session = inject(SessionApi);
  private readonly clipboard = inject(ClipboardApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly plot = viewChild.required<ElementRef<HTMLElement>>('plot');

  protected readonly t = CHART_TEXTS;
  protected readonly kinds: readonly ChartKind[] = ['line', 'bar', 'scatter'];
  protected readonly aggs: readonly ChartAgg[] = ['sum', 'avg', 'count', 'min', 'max'];
  protected readonly sorts: readonly ChartSort[] = ['none', 'label', 'valueDesc', 'valueAsc'];
  /** Ids in the page must be unique: every panel has its own prefix. */
  protected readonly uid = `chart-${Math.random().toString(36).slice(2, 8)}`;

  protected readonly spec = computed(() => this.tab().chartSpec());
  protected readonly data = signal<ChartData | null>(null);
  protected readonly busy = signal(false);
  protected readonly problem = signal('');
  /** The result has nothing a chart could show. */
  protected readonly nothing = signal(false);
  protected readonly note = signal('');
  protected readonly zoom = signal<readonly [number, number] | null>(null);
  protected readonly hidden = signal<ReadonlySet<number>>(new Set());
  protected readonly hover = signal<Hover | null>(null);
  protected readonly dragging = signal<{ from: number; to: number } | null>(null);
  private readonly size = signal<{ width: number; height: number }>({ width: 0, height: 0 });
  private asked = 0;
  private job: number | null = null;
  private chartId: number | null = null;
  /** What the points on screen were asked for: nothing is asked twice. */
  private drawnFor = '';

  /** The columns values can come from: numbers first. */
  protected readonly valueColumns = computed(() => {
    const all = this.result().columns.map((c, index) => ({ index, name: c.name, n: isNumeric(c) }));
    return [...all.filter((c) => c.n), ...all.filter((c) => !c.n)];
  });
  protected readonly noValues = computed(() => (this.spec()?.ys.length ?? 0) === 0);
  protected readonly zoomable = computed(() => {
    const d = this.data();
    return !!d && d.xKind !== 'category' && d.xMin !== null && d.xMax !== null && d.xMax > d.xMin;
  });
  /** The chart laid out for the size of its area; `null` while there is nothing to draw. */
  protected readonly drawn = computed(() => {
    const data = this.data();
    const { width, height } = this.size();
    if (!data || width < 120 || height < 60 || data.series.length === 0) return null;
    return geometry(
      data,
      this.hidden(),
      this.tab().chartOptions(),
      this.zoom(),
      width,
      height,
      locale(),
    );
  });
  protected readonly description = computed(() => {
    const g = this.drawn();
    const data = this.data();
    return g && data ? describe(data, g.shown, locale(), this.t) : '';
  });
  protected readonly notes = computed(() => {
    const d = this.data();
    if (!d) return '';
    const n = (v: number) => v.toLocaleString(locale());
    const drawn = d.series.reduce((sum, s) => sum + s.x.length, 0);
    const points = d.series.reduce((sum, s) => sum + s.points, 0);
    const parts: string[] = [];
    if (points === 0) parts.push(this.t.noPoints);
    if (d.thinned) parts.push(this.t.thinned(n(drawn), n(points)));
    if (d.nulls > 0) parts.push(this.t.nulls(n(d.nulls)));
    if (d.skipped > 0) parts.push(this.t.skipped(n(d.skipped)));
    if (d.cutGroups > 0) parts.push(this.t.cutGroups(n(d.cutGroups), MAX_SERIES));
    if (d.cutCategories > 0) parts.push(this.t.cutCategories(n(d.cutCategories)));
    return parts.join(' · ');
  });

  constructor() {
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            const now = this.size();
            if (Math.abs(now.width - width) >= 1 || Math.abs(now.height - height) >= 1) {
              this.size.set({ width: Math.floor(width), height: Math.floor(height) });
            }
          });
    effect((onCleanup) => {
      const element = this.plot().nativeElement;
      observer?.observe(element);
      const box = element.getBoundingClientRect();
      if (box.width > 0) {
        untracked(() =>
          this.size.set({ width: Math.floor(box.width), height: Math.floor(box.height) }),
        );
      }
      onCleanup(() => observer?.unobserve(element));
    });
    // another result, or one that grew: read it (again); with no spec that fits, ask for one first
    effect(() => {
      const result = this.result();
      const rows = this.rows();
      const settled = this.settled();
      const spec = this.spec();
      const width = this.size().width;
      const zoom = this.zoom();
      if (!settled || width < 120) return;
      untracked(() => void this.load(result, rows, spec, zoom, width));
    });
    inject(DestroyRef).onDestroy(() => {
      observer?.disconnect();
      this.asked++;
      if (this.job !== null) void this.api.cancel(this.job).catch(() => undefined);
      if (this.chartId !== null) void this.api.free(this.chartId).catch(() => undefined);
    });
  }

  private async load(
    result: ResultRef,
    rows: number,
    spec: ChartSpec | null,
    zoom: readonly [number, number] | null,
    width: number,
  ): Promise<void> {
    const asked = ++this.asked;
    const stale = () => asked !== this.asked;
    const tab = this.tab();
    this.problem.set('');
    try {
      if (!spec || !specFits(spec, result.columns)) {
        const suggested = await this.api.suggest(result.resultId);
        if (stale()) return;
        this.nothing.set(suggested === null);
        if (suggested) {
          // the effect runs again with the spec
          tab.chartSpec.set(suggested);
        } else {
          this.clear();
        }
        return;
      }
      this.nothing.set(false);
      if (spec.ys.length === 0) {
        this.clear();
        return;
      }
      const prepared = `${result.resultId}/${rows}/${JSON.stringify(spec)}`;
      const wanted = `${prepared}/${zoom?.join(':') ?? ''}/${width}`;
      if (wanted === this.drawnFor) return;
      this.busy.set(true);
      let data: ChartData | null = null;
      if (this.chartId !== null && this.drawnFor.startsWith(`${prepared}/`)) {
        // the same chart, another range or width: the backend has it ready
        try {
          data = await this.api.zoom(this.chartId, zoom, width);
        } catch (e) {
          if (toAppError(e).code !== 'unknown_result') throw e;
        }
      }
      if (stale()) return;
      if (!data) {
        if (this.job !== null) void this.api.cancel(this.job).catch(() => undefined);
        const job = nextChartJob++;
        this.job = job;
        const before = this.chartId;
        try {
          data = await this.api.prepare(job, result.resultId, spec, width);
        } finally {
          if (this.job === job) this.job = null;
        }
        if (stale()) {
          void this.api.free(data.chartId).catch(() => undefined);
          return;
        }
        if (before !== null) void this.api.free(before).catch(() => undefined);
        this.chartId = data.chartId;
        // another chart: series that were hidden mean nothing in it
        this.hidden.set(new Set());
        if (zoom) {
          // the range asked for is of the chart before: start with everything
          this.drawnFor = `${prepared}//${width}`;
          this.data.set(data);
          this.zoom.set(null);
          return;
        }
      }
      this.drawnFor = wanted;
      this.data.set(data);
    } catch (e) {
      if (stale()) return;
      if (toAppError(e).code !== 'cancelled') {
        // `too_large` is about a file elsewhere: here it is about points
        this.problem.set(toAppError(e).code === 'too_large' ? this.t.tooMany : describeError(e));
        this.clear();
      }
    } finally {
      if (!stale()) this.busy.set(false);
    }
  }

  private clear(): void {
    this.data.set(null);
    this.drawnFor = '';
    this.hover.set(null);
  }

  protected asKind = (v: string) => v as ChartKind;
  protected asAgg = (v: string) => v as ChartAgg;
  protected asSort = (v: string) => v as ChartSort;
  protected column = (v: string) => (v === '' ? null : Number(v));

  /** Changes the chart; another chart starts with everything in view. */
  protected patch(change: Partial<ChartSpec>): void {
    const now = this.spec() ?? {
      kind: 'line' as const,
      x: null,
      ys: [],
      group: null,
      agg: 'sum' as const,
      sort: 'none' as const,
    };
    this.zoom.set(null);
    this.tab().chartSpec.set({ ...now, ...change });
  }

  protected toggleValue(column: number): void {
    const ys = this.spec()?.ys ?? [];
    const next = ys.includes(column) ? ys.filter((c) => c !== column) : [...ys, column];
    this.patch({ ys: next.slice(0, MAX_SERIES) });
  }

  protected option(change: { log?: boolean; stacked?: boolean }): void {
    this.tab().chartOptions.update((o) => ({ ...o, ...change }));
  }

  protected toggleSeries(index: number): void {
    this.hidden.update((now) => {
      const next = new Set(now);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  }

  protected setZoom(range: readonly [number, number] | null): void {
    if (range === null && this.zoom() === null) return;
    this.hover.set(null);
    this.zoom.set(range);
  }

  /** Zooms (`factor`) or moves (`shift`) the range in view. */
  protected step(factor: number, shift: number): void {
    const d = this.data();
    const g = this.drawn();
    if (!d || !g || d.xMin === null || d.xMax === null) return;
    this.setZoom(stepRange(g.range, [d.xMin, d.xMax], factor, shift));
  }

  private at(event: PointerEvent): { x: number; y: number } {
    const box = this.plot().nativeElement.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  protected onDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.zoomable() || !this.drawn()) return;
    const { x } = this.at(event);
    this.dragging.set({ from: x, to: x });
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  protected onMove(event: PointerEvent): void {
    const g = this.drawn();
    const data = this.data();
    if (!g || !data) return;
    const at = this.at(event);
    const drag = this.dragging();
    if (drag) {
      this.dragging.set({ from: drag.from, to: at.x });
      this.hover.set(null);
      return;
    }
    const inside =
      at.x >= g.plot.left &&
      at.x <= g.plot.left + g.plot.width &&
      at.y >= g.plot.top &&
      at.y <= g.plot.top + g.plot.height;
    this.hover.set(inside ? hoverAt(data, g.shown, at, g.range, g.plot, g.sx, g.sy) : null);
  }

  protected onUp(event: PointerEvent): void {
    const drag = this.dragging();
    const g = this.drawn();
    this.dragging.set(null);
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    if (!drag || !g) return;
    const range = dragRange(drag.from, drag.to, g.range, g.plot);
    if (range) this.setZoom(range);
  }

  protected color(index: number): string {
    return `var(--chart-${(index % SERIES_COLORS) + 1})`;
  }

  protected dash(index: number): string | null {
    return DASHES[index % DASHES.length] || null;
  }

  protected open(index: number): boolean {
    return isOpenMarker(markerOf(index));
  }

  /** How the bars of a series are hatched: plain, or lines in one of three directions, or crossed. */
  protected hatch(index: number): string {
    return `rotate(${[0, 45, -45, 0][index % 4]})`;
  }

  protected legendMarker(index: number): string {
    return markerPath(markerOf(index), 13, 5, 4);
  }

  protected name(index: number): string {
    return this.data()?.series[index]?.name ?? '';
  }

  protected value(v: number | null): string {
    return v === null ? 'NULL' : numberLabel(v, locale(), true);
  }

  protected hoverX(h: Hover): string {
    const d = this.data();
    // as fine as the value is: a date without a time of day, a time without milliseconds
    return d
      ? xLabel(h.x, d.xKind, d.categories, locale(), 'ms')
          .replace(/\.000$/, '')
          .replace(/ 00:00:00$/, '')
      : '';
  }

  protected tipLeft(at: number, width: number): number {
    return at > width / 2 ? Math.max(0, at - 270) : at + 12;
  }

  private svg(): string | null {
    const g = this.drawn();
    if (!g) return null;
    const style = getComputedStyle(this.host.nativeElement);
    const of = (token: string, fallback: string) =>
      style.getPropertyValue(token).trim() || fallback;
    return toSvg(
      g,
      {
        background: of('--bg-app', '#14171c'),
        text: of('--text', '#e6edf3'),
        grid: of('--chart-grid', '#2e343f'),
        series: Array.from({ length: SERIES_COLORS }, (_, i) => of(`--chart-${i + 1}`, '#5aa2f7')),
      },
      this.description(),
    );
  }

  protected async saveSvg(): Promise<void> {
    const svg = this.svg();
    if (!svg) return;
    try {
      const path = await this.files.saveFile(this.t.saveSvg, `${this.t.fileName}.svg`, [
        { name: 'SVG', extensions: ['svg'] },
      ]);
      if (!path) return;
      await this.session.writeFile(path, svg, 'utf-8');
      this.note.set(this.t.saved(path.split(/[\\/]/).pop() ?? path));
    } catch {
      this.note.set(this.t.saveFailed);
    }
  }

  protected async copySvg(): Promise<void> {
    const svg = this.svg();
    if (!svg) return;
    try {
      await this.clipboard.copyText(svg);
      this.note.set(this.t.copied);
    } catch {
      this.note.set(this.t.saveFailed);
    }
  }
}
