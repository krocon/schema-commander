import { Injectable, inject, signal } from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { QueryApi } from '../../core/sql/query-api';
import { QueryResult } from '../../core/sql/query.models';

export type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly sql: string }
  | { readonly kind: 'done'; readonly sql: string; readonly result: QueryResult }
  | { readonly kind: 'cancelled'; readonly sql: string }
  | { readonly kind: 'failed'; readonly sql: string; readonly message: string };

/**
 * What the one query tab shows: the last statement and its outcome, on the active connection (opened first
 * when it is closed). A statement started while another runs wins; the answer of the older one is dropped.
 */
@Injectable({ providedIn: 'root' })
export class QuerySession {
  private readonly api = inject(QueryApi);
  private readonly connections = inject(ConnectionsStore);
  private runId = 0;
  /** The connection the running statement is on. */
  private runningOn: string | null = null;

  readonly state = signal<RunState>({ kind: 'idle' });

  async run(sql: string): Promise<void> {
    const id = ++this.runId;
    const connection = this.connections.activeId();
    const latest = () => id === this.runId;
    this.state.set({ kind: 'running', sql });
    this.runningOn = connection;
    try {
      if (!(await this.connections.connect(connection))) {
        if (latest()) this.fail(sql, connection);
        return;
      }
      const result = await this.runOnce(connection, sql);
      if (latest()) this.state.set({ kind: 'done', sql, result });
    } catch (e) {
      const error = toAppError(e);
      // cancelled, timed out or broken: the backend dropped the connection
      if (error.code !== 'invalid_query' && error.code !== 'permission_denied') {
        this.connections.markClosed(connection);
      }
      if (!latest()) return;
      this.state.set(
        error.code === 'cancelled'
          ? { kind: 'cancelled', sql }
          : { kind: 'failed', sql, message: describeError(error) },
      );
    } finally {
      if (latest()) this.runningOn = null;
    }
  }

  /** Asks the backend to stop the statement that runs. */
  cancel(): void {
    if (this.runningOn !== null) void this.api.cancel(this.runningOn).catch(() => undefined);
  }

  /** The connection was open in the store but the backend lost it: open it again, once. */
  private async runOnce(connection: string, sql: string): Promise<QueryResult> {
    try {
      return await this.api.run(connection, sql);
    } catch (e) {
      if (toAppError(e).code !== 'not_connected') throw e;
      this.connections.markClosed(connection);
      if (!(await this.connections.connect(connection))) throw e;
      return this.api.run(connection, sql);
    }
  }

  private fail(sql: string, connection: string): void {
    const state = this.connections.state(connection);
    this.state.set(
      state.kind === 'failed'
        ? { kind: 'failed', sql, message: state.message }
        : // the password dialog was dismissed
          { kind: 'cancelled', sql },
    );
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
