import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from '../backend/call';
import { RowWindow, RunEvent, RunOutcome } from './query.models';

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
  ): Promise<RunOutcome>;
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
  ): Promise<RunOutcome> {
    const channel = new Channel<RunEvent>();
    if (onEvent) channel.onmessage = onEvent;
    return call('run_query', {
      id: connectionId,
      sql,
      timeoutMs: timeoutMs > 0 ? timeoutMs : null,
      onEvent: channel,
    });
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
