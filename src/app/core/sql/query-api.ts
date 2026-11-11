import { Injectable } from '@angular/core';
import { call } from '../backend/call';
import { QueryResult } from './query.models';

/** Running statements on an open connection (prompt 003). */
export abstract class QueryApi {
  /**
   * Runs one statement; rejects with an `AppError`: `invalid_query` carries the server's message,
   * `cancelled` follows `cancel`, `timeout` the time limit (`timeoutMs`, 0 = none), `not_connected` means
   * the connection must be opened (again).
   */
  abstract run(connectionId: string, sql: string, timeoutMs?: number): Promise<QueryResult>;
  /** Stops the statement that runs on a connection. */
  abstract cancel(connectionId: string): Promise<void>;
}

@Injectable()
export class TauriQueryApi extends QueryApi {
  run(connectionId: string, sql: string, timeoutMs = 0): Promise<QueryResult> {
    return call('run_query', {
      id: connectionId,
      sql,
      timeoutMs: timeoutMs > 0 ? timeoutMs : null,
    });
  }

  cancel(connectionId: string): Promise<void> {
    return call('cancel_query', { id: connectionId });
  }
}
