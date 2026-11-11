import { signal } from '@angular/core';
import { describeError, toAppError } from '../../core/errors/app-error';
import { QueryApi } from '../../core/sql/query-api';
import { SearchSpec, SeekKind } from '../../core/sql/query.models';
import { HitMarks } from '../results/result-model';
import { FIND_TEXTS } from './find-texts';

export const EMPTY_SEARCH: SearchSpec = {
  text: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  columns: [],
};

/** Rows of the first stretch: small, so the first hits are there at once. */
export const FIRST_STRETCH_ROWS = 5_000;
/** Rows of every further stretch. */
export const STRETCH_ROWS = 100_000;
/** Hits taken from one stretch. */
export const STRETCH_HITS = 5_000;
/** Places of hits kept for marking and jumping; beyond, hits are only counted. */
export const MAX_KEPT_HITS = 100_000;
/** Ids of these jobs: apart from exports, formatting, local views and figures. */
let nextJob = 4_000_000_000;

export type Hit = readonly [number, number];

const key = (row: number, column: number) => row * 65_536 + column;
const before = (a: Hit, b: Hit) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/**
 * The search in the result of a tab (prompt 029). The backend looks through the result store a stretch
 * of rows at a time: the first hits show at once, the count goes on while the user reads, and a new
 * search (or closing) stops the old one. The places of the hits are kept here for marking them in the
 * grid and for jumping from hit to hit. One per tab; no Angular but signals.
 */
export class ResultFind {
  /** The search row is on screen. */
  readonly open = signal(false);
  /** Counts the requests to put the keyboard into the search field (`'text'`) or the row field. */
  readonly focus = signal<{ readonly field: 'text' | 'row'; readonly n: number }>({
    field: 'text',
    n: 0,
  });
  readonly spec = signal<SearchSpec>(EMPTY_SEARCH);
  /** Hits so far. */
  readonly count = signal(0);
  /** More rows are still looked through. */
  readonly searching = signal(false);
  /** What is wrong about the pattern, for the field. */
  readonly problem = signal<string | null>(null);
  /** The hit the cursor was put on. */
  readonly current = signal<Hit | null>(null);
  /** Changes whenever the kept hits do: the grid paints again. */
  readonly version = signal(0);

  private hits: Hit[] = [];
  private keys = new Set<number>();
  private turn = 0;
  private job: number | null = null;

  constructor(private readonly api: QueryApi) {}

  /** For the grid: is this cell a hit? */
  readonly marks: HitMarks = {
    at: (row, column) => {
      const current = this.current();
      if (current && current[0] === row && current[1] === column) return 'current';
      return this.keys.has(key(row, column)) ? 'hit' : null;
    },
  };

  /** Shows the search row and puts the keyboard into one of its fields. */
  show(field: 'text' | 'row' = 'text'): void {
    this.open.set(true);
    this.focus.update((f) => ({ field, n: f.n + 1 }));
  }

  /** Closes the search row; the marks go, what was typed stays for the next time. */
  close(): void {
    this.open.set(false);
    this.reset();
  }

  /** Stops the search that runs and forgets its hits. */
  reset(): void {
    this.turn++;
    this.cancel();
    this.hits = [];
    this.keys = new Set();
    this.count.set(0);
    this.current.set(null);
    this.searching.set(false);
    this.problem.set(null);
    this.version.update((v) => v + 1);
  }

  private cancel(): void {
    if (this.job === null) return;
    void this.api.cancelSearch(this.job).catch(() => undefined);
    this.job = null;
  }

  /** Looks for `spec` in a result, from its first row to its last. */
  async search(resultId: number, spec: SearchSpec): Promise<void> {
    this.spec.set(spec);
    this.reset();
    if (spec.text === '') return;
    const turn = this.turn;
    this.searching.set(true);
    let from = 0;
    let rows = FIRST_STRETCH_ROWS;
    try {
      for (;;) {
        const job = nextJob++;
        this.job = job;
        const found = await this.api.resultSearch(job, resultId, spec, from, rows, STRETCH_HITS);
        if (turn !== this.turn) return;
        this.job = null;
        if (found.hits.length > 0) {
          for (const hit of found.hits) {
            if (this.hits.length >= MAX_KEPT_HITS) break;
            this.hits.push(hit);
            this.keys.add(key(hit[0], hit[1]));
          }
          this.count.update((n) => n + found.hits.length);
          this.version.update((v) => v + 1);
        }
        if (found.done || found.next <= from) break;
        from = found.next;
        rows = STRETCH_ROWS;
      }
    } catch (e) {
      if (turn !== this.turn) return;
      const error = toAppError(e);
      if (error.code === 'invalid_query') this.problem.set(FIND_TEXTS.badPattern(error.message));
      else if (error.code !== 'cancelled') this.problem.set(describeError(error));
    } finally {
      if (turn === this.turn) {
        this.job = null;
        this.searching.set(false);
      }
    }
  }

  /**
   * The hit behind (`1`) or before (`-1`) a cell, around the ends; `null` without hits. It becomes the
   * current one.
   */
  step(from: Hit | null, direction: 1 | -1): Hit | null {
    const hits = this.hits;
    if (hits.length === 0) return null;
    const at = from ?? this.current() ?? ([-1, -1] as Hit);
    // the first hit that is not before `at`
    let lo = 0;
    let hi = hits.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(hits[mid], at)) lo = mid + 1;
      else hi = mid;
    }
    const on = lo < hits.length && hits[lo][0] === at[0] && hits[lo][1] === at[1];
    const index =
      direction === 1 ? (on ? lo + 1 : lo) % hits.length : (lo - 1 + hits.length) % hits.length;
    const hit = hits[index];
    this.current.set(hit);
    this.version.update((v) => v + 1);
    return hit;
  }

  /** Which hit the current one is, counted from 1; `0` = none. */
  position(): number {
    const current = this.current();
    if (!current) return 0;
    return this.hits.findIndex((h) => h[0] === current[0] && h[1] === current[1]) + 1;
  }

  /** Hits beyond those whose places are kept. */
  beyond(): boolean {
    return this.count() > this.hits.length;
  }

  /** The next row of a column with another value, or with NULL; `null` = none (or stopped). */
  async seek(
    resultId: number,
    column: number,
    from: number,
    kind: SeekKind,
  ): Promise<number | null> {
    const job = nextJob++;
    try {
      return await this.api.resultSeek(job, resultId, column, from, kind);
    } catch {
      return null;
    }
  }
}
