import { Injectable } from '@angular/core';
import { call } from '../backend/call';

/** Mirrors `Kind`, `Agg`, `Sort` in src-tauri/src/chart.rs (prompt 042). */
export type ChartKind = 'line' | 'bar' | 'scatter';
export type ChartAgg = 'sum' | 'avg' | 'count' | 'min' | 'max';
export type ChartSort = 'none' | 'label' | 'valueDesc' | 'valueAsc';

/** Mirrors `ChartSpec`: which columns of a result become what of its chart. */
export interface ChartSpec {
  readonly kind: ChartKind;
  /** The column of X; `null` = the number of the row. */
  readonly x: number | null;
  readonly ys: readonly number[];
  /** A column whose values split every series. */
  readonly group: number | null;
  readonly agg: ChartAgg;
  readonly sort: ChartSort;
}

/** Mirrors `XKind`: `time` and `clock` are milliseconds, `category` an index into `categories`. */
export type ChartXKind = 'time' | 'clock' | 'number' | 'category' | 'row';

/** Mirrors `SeriesData`. */
export interface ChartSeries {
  readonly name: string;
  readonly x: readonly number[];
  /** `null` is a gap (a NULL). */
  readonly y: readonly (number | null)[];
  /** Points in the range before thinning. */
  readonly points: number;
}

/** Mirrors `Chart` (the id) and `ChartData`: the points to draw. */
export interface ChartData {
  readonly chartId: number;
  readonly kind: ChartKind;
  readonly xKind: ChartXKind;
  readonly categories: readonly string[];
  readonly series: readonly ChartSeries[];
  /** The whole extent of X, whatever range was asked for. */
  readonly xMin: number | null;
  readonly xMax: number | null;
  readonly rows: number;
  readonly nulls: number;
  readonly skipped: number;
  readonly cutGroups: number;
  readonly cutCategories: number;
  readonly thinned: boolean;
}

/** Charts of results (prompt 042): the backend reads the result store and hands out the points drawn. */
export abstract class ChartApi {
  /** The chart the types of the columns suggest; `null`: nothing to draw. */
  abstract suggest(resultId: number): Promise<ChartSpec | null>;
  /**
   * Reads the result into a chart; resolves with the points for `width` pixels. A job: `cancel` stops it
   * (`cancelled`). `unsupported`: the spec names what the result does not have; `too_large`: too many points.
   */
  abstract prepare(
    jobId: number,
    resultId: number,
    spec: ChartSpec,
    width: number,
  ): Promise<ChartData>;
  abstract cancel(jobId: number): Promise<void>;
  /**
   * The points of a prepared chart in a range of X (`null` = all). Rejects with `unknown_result` when the
   * chart is not kept any more: prepare it again.
   */
  abstract zoom(
    chartId: number,
    range: readonly [number, number] | null,
    width: number,
  ): Promise<ChartData>;
  abstract free(chartId: number): Promise<void>;
}

@Injectable()
export class TauriChartApi extends ChartApi {
  suggest(resultId: number): Promise<ChartSpec | null> {
    return call('chart_suggest', { resultId });
  }

  prepare(jobId: number, resultId: number, spec: ChartSpec, width: number): Promise<ChartData> {
    return call('chart_prepare', { jobId, resultId, spec, width });
  }

  cancel(jobId: number): Promise<void> {
    return call('cancel_job', { jobId });
  }

  zoom(
    chartId: number,
    range: readonly [number, number] | null,
    width: number,
  ): Promise<ChartData> {
    return call('chart_zoom', { chartId, range, width });
  }

  free(chartId: number): Promise<void> {
    return call('chart_free', { chartId });
  }
}
