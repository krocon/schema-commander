/** The outcome of statements in a tab (prompts 004 and 005). */
import { locale } from '../../core/i18n/i18n';
import { ResultRef } from '../../core/sql/query.models';
import { TABS_TEXTS } from './tabs-texts';

/** What the result area shows for one statement. */
export type RunState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly sql: string;
      /** Rows are there already while the rest is still read. */
      readonly result: ResultRef | null;
      readonly rows: number;
    }
  | {
      readonly kind: 'done';
      readonly sql: string;
      /** `null` for a statement without a result (see `rowsAffected`). */
      readonly result: ResultRef | null;
      readonly rows: number;
      readonly rowsAffected: number | null;
      readonly truncated: boolean;
      readonly elapsedMs: number;
    }
  | { readonly kind: 'cancelled'; readonly sql: string }
  | { readonly kind: 'failed'; readonly sql: string; readonly message: string };

/** One statement of a run (a single statement, a selection or a whole script). */
export interface StatementRun {
  readonly sql: string;
  readonly kind: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';
  /** Where the rows are; `null` also when a result was not kept (see `MAX_KEPT_RESULTS`). */
  readonly result: ResultRef | null;
  /** Rows of the result so far (it grows while the statement runs); `null` without a result. */
  readonly rows: number | null;
  readonly rowsAffected: number | null;
  readonly truncated: boolean;
  readonly message: string | null;
  readonly elapsedMs: number | null;
}

/** A line of the messages of a tab. */
export interface LogEntry {
  /** Milliseconds since the epoch. */
  readonly at: number;
  readonly kind: 'ok' | 'error' | 'cancelled' | 'info';
  /** The statement, shortened to its first line. */
  readonly sql: string;
  readonly text: string;
  readonly elapsedMs: number | null;
}

/** Results with rows a run keeps (in the store of the backend); later ones are only counted. */
export const MAX_KEPT_RESULTS = 50;
export const MAX_LOG = 500;

export function pending(sql: string): StatementRun {
  return {
    sql,
    kind: 'pending',
    result: null,
    rows: null,
    rowsAffected: null,
    truncated: false,
    message: null,
    elapsedMs: null,
  };
}

/** What the result area shows for a statement of a run. */
export function stateOf(run: StatementRun | undefined): RunState {
  if (!run) return { kind: 'idle' };
  switch (run.kind) {
    case 'running':
    case 'pending':
      return { kind: 'running', sql: run.sql, result: run.result, rows: run.rows ?? 0 };
    case 'failed':
      return { kind: 'failed', sql: run.sql, message: run.message ?? '' };
    case 'cancelled':
    case 'skipped':
      return { kind: 'cancelled', sql: run.sql };
    case 'done':
      return run.result || run.rowsAffected !== null
        ? {
            kind: 'done',
            sql: run.sql,
            result: run.result,
            rows: run.rows ?? 0,
            rowsAffected: run.rowsAffected,
            truncated: run.truncated,
            elapsedMs: run.elapsedMs ?? 0,
          }
        : {
            kind: 'failed',
            sql: run.sql,
            message: TABS_TEXTS.resultNotKept(run.rows ?? 0, MAX_KEPT_RESULTS),
          };
  }
}

/** `12 ms`, `1.23 s`, `12.3 s` with the decimal sign of the language. */
const seconds = (ms: number) => {
  if (ms < 1000) return `${ms} ms`;
  const digits = ms < 10_000 ? 2 : 1;
  const value = (ms / 1000).toLocaleString(locale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
  return `${value} s`;
};

/** `1 234 567` (a thin space every three digits). */
export const count = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');

/** `1 row`, `2 rows`. */
const rowsText = (n: number) => TABS_TEXTS.rows(n, count(n));
const changedText = (n: number) => TABS_TEXTS.rowsChanged(n, count(n));

/** What a finished statement says in the messages. */
export function outcomeText(run: StatementRun): string {
  switch (run.kind) {
    case 'done':
      if (run.rowsAffected !== null) return changedText(run.rowsAffected);
      return `${rowsText(run.rows ?? 0)}${run.truncated ? TABS_TEXTS.truncated : ''}`;
    case 'failed':
      return run.message ?? TABS_TEXTS.error;
    case 'cancelled':
      return TABS_TEXTS.cancelled;
    case 'skipped':
      return TABS_TEXTS.notRun;
    default:
      return '';
  }
}

/** The first line of a statement that is no comment, for lists. */
export function firstLine(sql: string): string {
  const line =
    sql
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('--')) ?? sql.trim();
  const chars = [...line];
  return chars.length > 120 ? `${chars.slice(0, 119).join('')}…` : line;
}

/** The status line of an outcome. */
export function statusText(state: RunState): string {
  switch (state.kind) {
    case 'idle':
      return TABS_TEXTS.ready;
    case 'running':
      return TABS_TEXTS.runningNow;
    case 'failed':
      return TABS_TEXTS.error;
    case 'cancelled':
      return TABS_TEXTS.cancelled;
    case 'done': {
      if (state.rowsAffected !== null) {
        return `${changedText(state.rowsAffected)} · ${seconds(state.elapsedMs)}`;
      }
      return `${rowsText(state.rows)}${state.truncated ? TABS_TEXTS.truncated : ''} · ${seconds(state.elapsedMs)}`;
    }
  }
}

/**
 * The status line of a whole run: what runs (with the time so far), or how it went.
 * `elapsedMs` is the time of the run so far.
 */
export function runStatus(runs: readonly StatementRun[], elapsedMs: number): string {
  if (runs.length === 0) return TABS_TEXTS.ready;
  const at = runs.findIndex((r) => r.kind === 'running');
  const of = runs.length > 1 ? TABS_TEXTS.position(at + 1, runs.length) : '';
  if (at >= 0) {
    const rows = runs[at].rows;
    const read = rows ? TABS_TEXTS.rowsRead(count(rows)) : '';
    return `${TABS_TEXTS.runningNow} ${seconds(elapsedMs)}${of}${read}`;
  }
  if (runs.length === 1) return statusText(stateOf(runs[0]));
  const of_ = (kind: StatementRun['kind']) => runs.filter((r) => r.kind === kind).length;
  const parts = [TABS_TEXTS.statements(runs.length), TABS_TEXTS.executed(of_('done'))];
  if (of_('failed')) parts.push(TABS_TEXTS.withError(of_('failed')));
  if (of_('cancelled')) parts.push(TABS_TEXTS.someCancelled(of_('cancelled')));
  if (of_('skipped')) parts.push(TABS_TEXTS.someNotRun(of_('skipped')));
  const total = runs.reduce((sum, r) => sum + (r.elapsedMs ?? 0), 0);
  return `${parts.join(' · ')} · ${seconds(total)}`;
}

/** `HH:MM:SS` of a time, for the messages. */
export function clock(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
