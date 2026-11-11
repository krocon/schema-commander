import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from './call';
import { CopyOptions } from './clipboard-api';

/** Mirrors `FileFormat` in src-tauri/src/export.rs. */
export type ExportFormat =
  'csv' | 'tsv' | 'json' | 'ndjson' | 'insert' | 'markdown' | 'html' | 'xlsx';

/** Mirrors `Options` of the extractor, with what only files have. */
export interface ExportTextOptions extends CopyOptions {
  /** Rows per `INSERT` statement. */
  readonly batch?: number;
}

/** Mirrors `Spec`: what to write and how. */
export interface ExportSpec {
  readonly format: ExportFormat;
  readonly options: ExportTextOptions;
  /** Byte order mark at the start of a text file. */
  readonly bom: boolean;
  readonly gzip: boolean;
  /** Indices of the columns to write; none = all. */
  readonly columns: readonly number[];
}

/** Mirrors `Exported`. */
export interface Exported {
  readonly rows: number;
  readonly bytes: number;
  /** Rows were left out: Excel takes no more. */
  readonly truncated: boolean;
  /** Cells whose text was cut to what Excel takes. */
  readonly cutCells: number;
}

/**
 * Rows into a file (prompt 011), written by the backend: from the result store or straight from the server.
 * `path` must come from the save dialog. A job is stopped by its id (`cancel`); then, and after any failure,
 * no file is left and an existing target is as it was. Rejects with an `AppError`.
 */
export abstract class ExportApi {
  abstract exportResult(
    jobId: number,
    resultId: number,
    rows: readonly (readonly [number, number])[],
    path: string,
    spec: ExportSpec,
    onProgress: (rows: number) => void,
  ): Promise<Exported>;
  /** Runs a statement and writes its rows into the file; nothing is kept or shown. */
  abstract exportQuery(
    jobId: number,
    connectionId: string,
    sql: string,
    path: string,
    spec: ExportSpec,
    onProgress: (rows: number) => void,
  ): Promise<Exported>;
  abstract cancel(jobId: number): Promise<void>;
  /** The first rows of a result as the export would write them. */
  abstract preview(resultId: number, spec: ExportSpec): Promise<string>;
  /** Shows a file the app wrote in the file manager of the OS. */
  abstract reveal(path: string): Promise<void>;
}

@Injectable()
export class TauriExportApi extends ExportApi {
  exportResult(
    jobId: number,
    resultId: number,
    rows: readonly (readonly [number, number])[],
    path: string,
    spec: ExportSpec,
    onProgress: (rows: number) => void,
  ): Promise<Exported> {
    const channel = new Channel<number>();
    channel.onmessage = onProgress;
    return call('export_result', { jobId, resultId, rows, path, spec, onProgress: channel });
  }

  exportQuery(
    jobId: number,
    connectionId: string,
    sql: string,
    path: string,
    spec: ExportSpec,
    onProgress: (rows: number) => void,
  ): Promise<Exported> {
    const channel = new Channel<number>();
    channel.onmessage = onProgress;
    return call('export_query', {
      jobId,
      id: connectionId,
      sql,
      path,
      spec,
      onProgress: channel,
    });
  }

  cancel(jobId: number): Promise<void> {
    return call('cancel_job', { jobId });
  }

  preview(resultId: number, spec: ExportSpec): Promise<string> {
    return call('export_preview', { resultId, spec });
  }

  reveal(path: string): Promise<void> {
    return call('reveal_export', { path });
  }
}
