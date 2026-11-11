import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from '../backend/call';

/** Mirrors `Format` in src-tauri/src/data_import.rs. */
export type ImportFormat = 'auto' | 'csv' | 'json' | 'ndjson';
/** Mirrors `Encoding`. */
export type ImportEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/** Mirrors `SourceOptions`: how a file is read; what is `null` is detected. */
export interface SourceOptions {
  readonly format: ImportFormat;
  readonly delimiter: string | null;
  readonly quote: string | null;
  readonly encoding: ImportEncoding | null;
  readonly header: boolean | null;
  readonly skipLines: number;
}

/** Mirrors `Detected`. */
export interface Detected {
  readonly format: ImportFormat;
  readonly delimiter: string;
  readonly encoding: ImportEncoding;
  readonly header: boolean;
  readonly gzip: boolean;
}

/** Mirrors `GuessKind`. */
export type GuessKind = 'int' | 'decimal' | 'bool' | 'date' | 'dateTime' | 'text';

/** Mirrors `Guess`: what the values of a column look like. */
export interface Guess {
  readonly kind: GuessKind;
  readonly maxLen: number;
  readonly nullable: boolean;
}

/** Mirrors `Preview`: the start of a file. */
export interface FilePreview {
  readonly detected: Detected;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  readonly types: readonly Guess[];
  /** Records among the first that could not be read. */
  readonly broken: number;
}

/** Mirrors `ValueKind` in src-tauri/src/db/filter.rs. */
export type TargetKind = 'number' | 'bool' | 'text';

/** Mirrors `Mapping` in src-tauri/src/db/load.rs: where the value of a column of the table comes from. */
export interface LoadMapping {
  /** The column of the file (from 0); `null`: the fixed value. */
  readonly source: number | null;
  readonly fixed: string | null;
  readonly target: { readonly name: string; readonly kind: TargetKind; readonly typeName: string };
  readonly trim: boolean;
  readonly decimalComma: boolean;
  readonly dateOrder: 'dmy' | 'mdy' | null;
}

/** Mirrors `LoadPlan`. The backend builds every statement from it: names quoted, values bound. */
export interface LoadPlan {
  readonly schema: string | null;
  readonly table: string;
  readonly mappings: readonly LoadMapping[];
  readonly nullTexts: readonly string[];
  readonly emptyIsNull: boolean;
  readonly clearFirst: boolean;
  readonly onError: 'abort' | 'skip';
  readonly wholeTransaction: boolean;
}

/** Mirrors `Loaded`: how an import ended. */
export interface Loaded {
  readonly read: number;
  readonly written: number;
  readonly skipped: number;
  readonly errors: readonly { readonly line: number; readonly reason: string }[];
  readonly cancelled: boolean;
  readonly failed: boolean;
  readonly rolledBack: boolean;
  readonly errorFile: boolean;
  /** The rows that were in the table before are gone. */
  readonly cleared: boolean;
}

/**
 * A file into a table (prompt 033), read and written by the backend. `path` must come from the open
 * dialog, `errorPath` from the save dialog. Rejects with an `AppError`.
 */
export abstract class DataImportApi {
  /** The start of a file as `options` read it. Nothing is written. */
  abstract preview(
    path: string,
    options: SourceOptions,
    nulls: readonly string[],
  ): Promise<FilePreview>;
  /** A `CREATE TABLE` proposed for columns of a file. */
  abstract tableDdl(
    connectionId: string,
    schema: string | null,
    table: string,
    columns: readonly (readonly [string, Guess])[],
  ): Promise<string>;
  /** Runs the `CREATE TABLE` as the user left it; anything else, or anything more, is refused. */
  abstract createTable(
    connectionId: string,
    sql: string,
    confirmation: string | null,
    timeoutMs: number,
  ): Promise<void>;
  /** The statements an import stands for: what the guard of the connection is asked about. */
  abstract statements(connectionId: string, plan: LoadPlan): Promise<string[]>;
  abstract run(
    jobId: number,
    connectionId: string,
    path: string,
    options: SourceOptions,
    plan: LoadPlan,
    errorPath: string | null,
    confirmations: readonly (string | null)[],
    allowDangerous: boolean,
    timeoutMs: number,
    onProgress: (records: number) => void,
  ): Promise<Loaded>;
  abstract cancel(jobId: number): Promise<void>;
  /** Shows the error file of an import in the file manager of the OS. */
  abstract reveal(path: string): Promise<void>;
}

@Injectable()
export class TauriDataImportApi extends DataImportApi {
  preview(path: string, options: SourceOptions, nulls: readonly string[]): Promise<FilePreview> {
    return call('load_preview', { path, options, nulls });
  }

  tableDdl(
    connectionId: string,
    schema: string | null,
    table: string,
    columns: readonly (readonly [string, Guess])[],
  ): Promise<string> {
    return call('load_table_ddl', { id: connectionId, schema, table, columns });
  }

  createTable(
    connectionId: string,
    sql: string,
    confirmation: string | null,
    timeoutMs: number,
  ): Promise<void> {
    return call('load_create_table', { id: connectionId, sql, confirmation, timeoutMs });
  }

  statements(connectionId: string, plan: LoadPlan): Promise<string[]> {
    return call('load_statements', { id: connectionId, plan });
  }

  run(
    jobId: number,
    connectionId: string,
    path: string,
    options: SourceOptions,
    plan: LoadPlan,
    errorPath: string | null,
    confirmations: readonly (string | null)[],
    allowDangerous: boolean,
    timeoutMs: number,
    onProgress: (records: number) => void,
  ): Promise<Loaded> {
    const channel = new Channel<number>();
    channel.onmessage = onProgress;
    return call('load_run', {
      jobId,
      id: connectionId,
      path,
      options,
      plan,
      errorPath,
      confirmations,
      allowDangerous,
      timeoutMs,
      onProgress: channel,
    });
  }

  cancel(jobId: number): Promise<void> {
    return call('cancel_job', { jobId });
  }

  reveal(path: string): Promise<void> {
    return call('reveal_export', { path });
  }
}
