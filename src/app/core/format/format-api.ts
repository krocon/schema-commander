import { Injectable } from '@angular/core';
import { call } from '../backend/call';

/** Mirrors `Dialect` in src-tauri/src/format.rs. */
export type FormatDialect =
  | 'postgres'
  | 'mysql'
  | 'sqlserver'
  | 'sqlite'
  | 'oracle'
  | 'duckdb'
  | 'clickhouse'
  | 'trino'
  | 'firebird'
  | 'bigquery'
  | 'snowflake'
  | 'db2';

/**
 * Mirrors `Mode`: lay the text out, pull it into one line, or only write its keywords in upper or lower
 * case (no blank changes).
 */
export type FormatMode = 'format' | 'oneline' | 'upper' | 'lower';

/** Mirrors `Style`. */
export interface FormatStyle {
  readonly keywordCase: 'upper' | 'lower' | 'preserve';
  /** Blanks per level, 1–8. */
  readonly indent: number;
  /** Where the comma stands when a list is broken. */
  readonly comma: 'leading' | 'trailing';
  /** Characters a line may have before lists and brackets are broken, 40–400. */
  readonly width: number;
  readonly andOr: 'leading' | 'trailing';
  /** Empty lines between two statements, 0–3. */
  readonly blankLines: number;
}

/**
 * Formats SQL in the backend (prompt 023). The result has the tokens of the text – the backend checks that
 * on every call and rejects with `format_unsafe` instead of returning anything else. Other rejections:
 * `format_incomplete` (the text ends inside a string, a quoted name or a comment), `format_too_deep`,
 * `too_large`, `cancelled` (after `cancel(jobId)`). Job ids share the numbers of the exports: use
 * `FORMAT_JOB_BASE` and up.
 */
export abstract class FormatApi {
  abstract format(
    jobId: number,
    sql: string,
    dialect: FormatDialect,
    mode: FormatMode,
    style: FormatStyle,
    /** The lines of the document end in `\r\n` (a piece of one line cannot tell). */
    crlf: boolean,
  ): Promise<string>;
  abstract cancel(jobId: number): Promise<void>;
}

/** Ids of formatting jobs start here, far from the ids the exports count up from 1. */
export const FORMAT_JOB_BASE = 1_000_000_000;

@Injectable()
export class TauriFormatApi extends FormatApi {
  format(
    jobId: number,
    sql: string,
    dialect: FormatDialect,
    mode: FormatMode,
    style: FormatStyle,
    crlf: boolean,
  ): Promise<string> {
    return call('format_sql', { jobId, sql, dialect, mode, style, crlf });
  }

  cancel(jobId: number): Promise<void> {
    return call('cancel_job', { jobId });
  }
}
