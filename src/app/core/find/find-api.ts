import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from '../backend/call';

/** Mirrors `Mode` in src-tauri/src/db/find.rs. */
export type FindMode = 'contains' | 'exact' | 'regex';
/** Mirrors `Columns`: which columns are searched. */
export type FindColumns = 'text' | 'numbers' | 'all';

/** Mirrors `FindSpec`. The backend builds every statement; the text is bound. */
export interface FindSpec {
  readonly text: string;
  readonly mode: FindMode;
  readonly caseSensitive: boolean;
  readonly columns: FindColumns;
  /** None = all schemas that are not the system's. */
  readonly schemas: readonly string[];
  /** Only these tables (`[schema, table]`); none = all of the schemas. */
  readonly tables: readonly (readonly [string, string])[];
  readonly data: boolean;
  readonly sources: boolean;
  readonly names: boolean;
  readonly maxHits: number;
  readonly tableTimeoutMs: number;
  /** Tables estimated larger are left out; 0 = none is. */
  readonly skipRowsOver: number;
}

/** Mirrors `RowHit`. */
export interface RowHit {
  /** Empty when only the database saw where. */
  readonly column: string;
  readonly preview: string;
}

/** Mirrors `SourceHit`. */
export interface SourceHit {
  /** `view`, `matview`, `routine`, `trigger`, `check`, `default`, `comment`, `table`, `name`. */
  readonly kind: string;
  readonly schema: string;
  readonly name: string;
  readonly line: number;
  readonly preview: string;
}

/** Mirrors `Skip`. */
export type SkipReason = 'large' | 'noColumns' | 'timeout' | 'refused';

/** Mirrors `FindEvent`. */
export type FindEvent =
  | { readonly type: 'start'; readonly tables: number }
  | {
      readonly type: 'table';
      readonly done: number;
      readonly schema: string;
      readonly table: string;
    }
  | {
      readonly type: 'rows';
      readonly schema: string;
      readonly table: string;
      readonly hits: readonly RowHit[];
      readonly more: boolean;
    }
  | {
      readonly type: 'skipped';
      readonly schema: string;
      readonly name: string;
      readonly reason: SkipReason;
      readonly message: string;
    }
  | { readonly type: 'source'; readonly hit: SourceHit };

/** Mirrors `FindReport`. */
export interface FindReport {
  readonly tables: number;
  readonly searched: number;
  readonly skipped: number;
  readonly rows: number;
  readonly sources: number;
  readonly cancelled: boolean;
  readonly lost: boolean;
}

/**
 * Search on the server (prompt 036): a job of the backend that only reads. Hits arrive as events while
 * it runs; what arrived stays when it is stopped. Rejects with an `AppError`.
 */
export abstract class FindApi {
  abstract run(
    jobId: number,
    connectionId: string,
    spec: FindSpec,
    onEvent: (event: FindEvent) => void,
  ): Promise<FindReport>;
  abstract cancel(jobId: number): Promise<void>;
}

@Injectable()
export class TauriFindApi extends FindApi {
  run(
    jobId: number,
    connectionId: string,
    spec: FindSpec,
    onEvent: (event: FindEvent) => void,
  ): Promise<FindReport> {
    const channel = new Channel<FindEvent>();
    channel.onmessage = onEvent;
    return call('find_on_server', { jobId, id: connectionId, spec, onEvent: channel });
  }

  cancel(jobId: number): Promise<void> {
    return call('cancel_job', { jobId });
  }
}
