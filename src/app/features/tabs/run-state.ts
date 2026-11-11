/** The outcome of statements in a tab (prompts 004 and 005). */
import { QueryResult } from '../../core/sql/query.models';

/** What the result area shows for one statement. */
export type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly sql: string }
  | { readonly kind: 'done'; readonly sql: string; readonly result: QueryResult }
  | { readonly kind: 'cancelled'; readonly sql: string }
  | { readonly kind: 'failed'; readonly sql: string; readonly message: string };

/** One statement of a run (a single statement, a selection or a whole script). */
export interface StatementRun {
  readonly sql: string;
  readonly kind: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';
  /** The rows; `null` also when a result was not kept (see `MAX_KEPT_RESULTS`). */
  readonly result: QueryResult | null;
  /** Rows of a result that was not kept, or changed rows. */
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

/** Results with rows a run keeps; later ones are only counted (until prompt 006 stores results in Rust). */
export const MAX_KEPT_RESULTS = 20;
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
      return { kind: 'running', sql: run.sql };
    case 'failed':
      return { kind: 'failed', sql: run.sql, message: run.message ?? '' };
    case 'cancelled':
    case 'skipped':
      return { kind: 'cancelled', sql: run.sql };
    case 'done':
      return run.result
        ? { kind: 'done', sql: run.sql, result: run.result }
        : {
            kind: 'failed',
            sql: run.sql,
            message: `Dieses Ergebnis (${run.rows ?? 0} Zeilen) wurde nicht behalten: Ein Lauf behält die ersten ${MAX_KEPT_RESULTS} Ergebnisse. Die Anweisung einzeln ausführen zeigt es.`,
          };
  }
}

const seconds = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1).replace('.', ',')} s`;

/** `1 Zeile`, `2 Zeilen`. */
const rowsText = (n: number) => `${n} ${n === 1 ? 'Zeile' : 'Zeilen'}`;

/** What a finished statement says in the messages. */
export function outcomeText(run: StatementRun): string {
  switch (run.kind) {
    case 'done':
      if (run.rowsAffected !== null) return `${rowsText(run.rowsAffected)} geändert`;
      return `${rowsText(run.rows ?? 0)}${run.truncated ? ' (abgeschnitten)' : ''}`;
    case 'failed':
      return run.message ?? 'Fehler';
    case 'cancelled':
      return 'Abgebrochen';
    case 'skipped':
      return 'Nicht ausgeführt';
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
      return 'Bereit';
    case 'running':
      return 'Läuft …';
    case 'failed':
      return 'Fehler';
    case 'cancelled':
      return 'Abgebrochen';
    case 'done': {
      const r = state.result;
      if (r.rowsAffected !== null) {
        return `${rowsText(r.rowsAffected)} geändert · ${seconds(r.elapsedMs)}`;
      }
      return `${rowsText(r.rows.length)}${r.truncated ? ' (abgeschnitten)' : ''} · ${seconds(r.elapsedMs)}`;
    }
  }
}

/**
 * The status line of a whole run: what runs (with the time so far), or how it went.
 * `elapsedMs` is the time of the run so far.
 */
export function runStatus(runs: readonly StatementRun[], elapsedMs: number): string {
  if (runs.length === 0) return 'Bereit';
  const at = runs.findIndex((r) => r.kind === 'running');
  const of = runs.length > 1 ? ` (${at + 1} von ${runs.length})` : '';
  if (at >= 0) return `Läuft … ${seconds(elapsedMs)}${of}`;
  if (runs.length === 1) return statusText(stateOf(runs[0]));
  const count = (kind: StatementRun['kind']) => runs.filter((r) => r.kind === kind).length;
  const parts = [`${runs.length} Anweisungen`, `${count('done')} ausgeführt`];
  if (count('failed')) parts.push(`${count('failed')} mit Fehler`);
  if (count('cancelled')) parts.push(`${count('cancelled')} abgebrochen`);
  if (count('skipped')) parts.push(`${count('skipped')} nicht ausgeführt`);
  const total = runs.reduce((sum, r) => sum + (r.elapsedMs ?? 0), 0);
  return `${parts.join(' · ')} · ${seconds(total)}`;
}

/** `HH:MM:SS` of a time, for the messages. */
export function clock(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
