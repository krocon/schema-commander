import { Injectable } from '@angular/core';
import { call } from '../backend/call';
import { QueryResult } from './query.models';

/** Running statements. Walking skeleton: the in-memory demo database of the backend. */
export abstract class QueryApi {
  /** Runs one statement; rejects with an `AppError` (`invalid_query` carries the engine's message). */
  abstract runDemoQuery(sql: string): Promise<QueryResult>;
}

@Injectable()
export class TauriQueryApi extends QueryApi {
  runDemoQuery(sql: string): Promise<QueryResult> {
    return call('run_demo_query', { sql });
  }
}
