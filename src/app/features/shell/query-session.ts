import { Injectable, inject, signal } from '@angular/core';
import { toAppError } from '../../core/errors/app-error';
import { QueryApi } from '../../core/sql/query-api';
import { QueryResult } from '../../core/sql/query.models';

export type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly sql: string }
  | { readonly kind: 'done'; readonly sql: string; readonly result: QueryResult }
  | { readonly kind: 'failed'; readonly sql: string; readonly message: string };

/**
 * What the one query tab of the walking skeleton shows: the last statement and its outcome. A statement
 * started while another runs wins; the answer of the older one is dropped.
 */
@Injectable({ providedIn: 'root' })
export class QuerySession {
  private readonly api = inject(QueryApi);
  private runId = 0;

  readonly state = signal<RunState>({ kind: 'idle' });

  async run(sql: string): Promise<void> {
    const id = ++this.runId;
    this.state.set({ kind: 'running', sql });
    try {
      const result = await this.api.runDemoQuery(sql);
      if (id === this.runId) this.state.set({ kind: 'done', sql, result });
    } catch (e) {
      if (id === this.runId)
        this.state.set({ kind: 'failed', sql, message: toAppError(e).message });
    }
  }
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
