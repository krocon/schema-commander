import { QueryApi } from '../app/core/sql/query-api';
import { QueryResult } from '../app/core/sql/query.models';
import { WindowApi } from '../app/core/backend/window-api';

/** Records the frames it was asked for. */
export class FakeWindowApi extends WindowApi {
  readonly calls: { color: string; dark: boolean | null }[] = [];

  setWindowChrome(color: string, dark: boolean | null): Promise<void> {
    this.calls.push({ color, dark });
    return Promise.resolve();
  }
}

/** Answers every statement with `result`, or rejects with `error` when set. */
export class FakeQueryApi extends QueryApi {
  readonly statements: string[] = [];
  error: unknown = null;
  result: QueryResult = {
    columns: [
      { name: 'id', declType: 'INTEGER' },
      { name: 'name', declType: 'TEXT' },
    ],
    rows: [
      [1, 'Ada'],
      [2, null],
    ],
    truncated: false,
    rowsAffected: null,
    elapsedMs: 3,
  };

  runDemoQuery(sql: string): Promise<QueryResult> {
    this.statements.push(sql);
    return this.error ? Promise.reject(this.error) : Promise.resolve(this.result);
  }
}
