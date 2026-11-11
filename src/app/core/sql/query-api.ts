import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from '../backend/call';
import { RowWindow, RunEvent, RunOutcome, Verdict } from './query.models';

/** What lets a guarded statement run (prompt 012). */
export interface RunGuard {
  /** The token `confirm` gave for exactly this statement. */
  readonly confirmation?: string | null;
  /** The user's setting: dangerous statements on free connections need no confirmation. */
  readonly allowDangerous?: boolean;
}

/**
 * Running statements on an open connection (prompts 003, 006). The rows of a statement stay in the backend;
 * the window asks for the slice it shows.
 */
export abstract class QueryApi {
  /**
   * Runs one statement and resolves when it has ended. While it runs, `onEvent` says when a result is there
   * (`started`) and how many rows it has by now (`rows`) – they can be asked for at once. Rejects with an
   * `AppError`: `invalid_query` carries the server's message, `cancelled` follows `cancel`, `timeout` the
   * time limit (`timeoutMs`, 0 = none), `not_connected` means the connection must be opened (again). A
   * statement that fails leaves no result behind.
   */
  abstract run(
    connectionId: string,
    sql: string,
    timeoutMs?: number,
    onEvent?: (event: RunEvent) => void,
    guard?: RunGuard,
  ): Promise<RunOutcome>;
  /**
   * What statements are and what they need on a connection: `refused` never runs there, `confirm` and
   * `type_name` need a token of `confirm`. The backend decides; `run` rejects with `confirmation_required`
   * or `permission_denied` whatever the window thinks.
   */
  abstract check(
    connectionId: string,
    sqls: readonly string[],
    allowDangerous: boolean,
  ): Promise<Verdict[]>;
  /**
   * The user said yes: a token for each statement that needs one (`null` for the others). Statements with
   * `type_name` need the name of the connection as the user typed it; a wrong one rejects.
   */
  abstract confirm(
    connectionId: string,
    sqls: readonly string[],
    typedName: string | null,
    allowDangerous: boolean,
  ): Promise<(string | null)[]>;
  /** Stops the statement that runs on a connection. */
  abstract cancel(connectionId: string): Promise<void>;
  /** Rows `from..from + count` of a result (fewer at its end; long texts cut). */
  abstract window(resultId: number, from: number, count: number): Promise<RowWindow>;
  /** Forgets results that are no longer shown. */
  abstract free(resultIds: readonly number[]): Promise<void>;
}

@Injectable()
export class TauriQueryApi extends QueryApi {
  run(
    connectionId: string,
    sql: string,
    timeoutMs = 0,
    onEvent?: (event: RunEvent) => void,
    guard: RunGuard = {},
  ): Promise<RunOutcome> {
    const channel = new Channel<RunEvent>();
    if (onEvent) channel.onmessage = onEvent;
    return call('run_query', {
      id: connectionId,
      sql,
      timeoutMs: timeoutMs > 0 ? timeoutMs : null,
      confirmation: guard.confirmation ?? null,
      allowDangerous: guard.allowDangerous ?? false,
      onEvent: channel,
    });
  }

  check(
    connectionId: string,
    sqls: readonly string[],
    allowDangerous: boolean,
  ): Promise<Verdict[]> {
    return call('check_statements', { id: connectionId, sqls, allowDangerous });
  }

  confirm(
    connectionId: string,
    sqls: readonly string[],
    typedName: string | null,
    allowDangerous: boolean,
  ): Promise<(string | null)[]> {
    return call('confirm_statements', { id: connectionId, sqls, typedName, allowDangerous });
  }

  cancel(connectionId: string): Promise<void> {
    return call('cancel_query', { id: connectionId });
  }

  window(resultId: number, from: number, count: number): Promise<RowWindow> {
    return call('result_window', { resultId, from, count });
  }

  free(resultIds: readonly number[]): Promise<void> {
    return call('free_results', { resultIds });
  }
}
