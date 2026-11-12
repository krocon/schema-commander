/** Copying tables between connections (prompt 045): what the dialog shows of a plan and a report. Pure. */
import { DbKind } from '../../core/connections/connection.models';
import {
  TransferPlan,
  TransferReport,
  TransferRequest,
  TransferTable,
  TransferTableReport,
} from '../../core/transfer/transfer-api';

export const DEFAULT_REQUEST: Omit<TransferRequest, 'sourceSchema' | 'tables' | 'targetSchema'> = {
  mode: 'append',
  withKeys: true,
  wholeTransaction: true,
  onError: 'abort',
};

/** The schema a transfer goes into unless the user says another one. */
export function defaultSchema(kind: DbKind, database: string): string {
  switch (kind) {
    case 'postgres':
      return 'public';
    case 'sqlserver':
      return 'dbo';
    case 'sqlite':
    case 'libsql':
    case 'd1':
    case 'duckdb':
      return 'main';
    case 'oracle':
      // a schema is a user: the caller fills in the one of the connection
      return '';
    case 'trino':
    case 'firebird':
      // the database of the profile is the catalog; its schemas have names of their own
      return '';
    default:
      // MySQL: a schema is a database
      return database;
  }
}

/** A request as the backend can take it: rows that are skipped cannot be all-or-nothing. */
export function fitted(request: TransferRequest): TransferRequest {
  return request.onError === 'skip' ? { ...request, wholeTransaction: false } : request;
}

/** Why a request cannot be planned; `null`: it can. */
export function requestProblem(
  request: TransferRequest,
  source: string,
  target: string | null,
): 'noTarget' | 'noTables' | 'noSchema' | 'sameTable' | null {
  if (!target) return 'noTarget';
  if (request.tables.length === 0) return 'noTables';
  if (request.targetSchema.trim() === '') return 'noSchema';
  // a table copied into itself would read what it writes
  if (source === target && request.sourceSchema === request.targetSchema.trim()) return 'sameTable';
  return null;
}

/** A loss of a column, for the list before the run. */
export interface Loss {
  readonly table: string;
  readonly column: string;
  readonly from: string;
  readonly to: string;
  readonly loss: string;
}

/** Everything a plan says will be lost. */
export function losses(plan: TransferPlan): Loss[] {
  return plan.tables.flatMap((t) =>
    t.columns
      .filter((c) => c.loss !== null && c.target !== null)
      .map((c) => ({
        table: t.table,
        column: c.name,
        from: c.sourceType,
        to: c.targetType ?? '',
        loss: c.loss as string,
      })),
  );
}

/** The columns of a table that the target has no place for. */
export const leftOut = (table: TransferTable): string[] =>
  table.columns.filter((c) => c.target === null).map((c) => c.name);

/** How far a run is: the table it is at, and the rows read of it. */
export interface Progress {
  readonly table: string;
  readonly index: number;
  readonly of: number;
  readonly read: number;
}

/** How a table ended, as one word for the report. */
export function outcomeOf(
  t: TransferTableReport,
): 'done' | 'skipped' | 'failed' | 'stopped' | 'withGaps' {
  if (t.skipped) return 'skipped';
  if (t.loaded.cancelled) return 'stopped';
  if (t.loaded.failed || t.error) return 'failed';
  return t.loaded.skipped > 0 ? 'withGaps' : 'done';
}

/** Whether everything of a report went well. */
export function allDone(report: TransferReport): boolean {
  return (
    !report.cancelled &&
    report.afterErrors.length === 0 &&
    report.tables.every((t) => outcomeOf(t) === 'done')
  );
}

/** The sum of the rows written. */
export const rowsWritten = (report: TransferReport): number =>
  report.tables.reduce((sum, t) => sum + t.loaded.written, 0);

/** `1,2 s`, `3 min 4 s`. */
export function durationText(ms: number, locale: string): string {
  if (ms < 60_000) {
    return `${(ms / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} s`;
  }
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
