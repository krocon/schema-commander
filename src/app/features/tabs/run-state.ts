/** The outcome of the last statement of a tab (prompt 004; from the query session of the skeleton). */
import { QueryResult } from '../../core/sql/query.models';

export type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly sql: string }
  | { readonly kind: 'done'; readonly sql: string; readonly result: QueryResult }
  | { readonly kind: 'cancelled'; readonly sql: string }
  | { readonly kind: 'failed'; readonly sql: string; readonly message: string };

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
        return `${r.rowsAffected} ${r.rowsAffected === 1 ? 'Zeile' : 'Zeilen'} geändert · ${r.elapsedMs} ms`;
      }
      const rows = `${r.rows.length} ${r.rows.length === 1 ? 'Zeile' : 'Zeilen'}`;
      return `${rows}${r.truncated ? ' (abgeschnitten)' : ''} · ${r.elapsedMs} ms`;
    }
  }
}
