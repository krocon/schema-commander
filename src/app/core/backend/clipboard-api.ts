import { Injectable } from '@angular/core';
import { DbKind } from '../connections/connection.models';
import { call } from './call';

/** Mirrors `Format` in src-tauri/src/extract.rs. */
export type CopyFormat =
  'tsv' | 'csv' | 'json' | 'markdown' | 'insert' | 'inlist' | 'where' | 'html' | 'values';

/** Mirrors `Options` in src-tauri/src/extract.rs; what is left out has the default of the backend. */
export interface CopyOptions {
  readonly header?: boolean;
  /** NULL as text: `''`, `NULL`, `\N`. */
  readonly nullAs?: string;
  /** One character: the separator of CSV. */
  readonly delimiter?: string;
  readonly crlf?: boolean;
  /** The table of `INSERT`, as written in SQL. */
  readonly table?: string;
  readonly dialect?: DbKind;
}

/** Mirrors `Selection` in src-tauri/src/copy.rs: nothing named means everything. */
export interface CopySelection {
  /** Ranges of rows: first and last, both included. */
  readonly rows: readonly (readonly [number, number])[];
  /** Indices of result columns. */
  readonly columns: readonly number[];
}

/** Mirrors `Copied`. */
export interface Copied {
  readonly rows: number;
  readonly columns: number;
  readonly chars: number;
}

/**
 * The clipboard of the OS (prompt 009). Rows of a result are written by the backend – they never pass the
 * window. Rejects with an `AppError`: `too_large` (more text than a clipboard should hold), `cancelled`,
 * `unknown_result`, `io` (no clipboard).
 */
export abstract class ClipboardApi {
  abstract copyText(text: string): Promise<void>;
  abstract copyResult(
    resultId: number,
    selection: CopySelection,
    format: CopyFormat,
    options: CopyOptions,
  ): Promise<Copied>;
  /** Stops the copy that runs. */
  abstract cancelCopy(): Promise<void>;
}

@Injectable()
export class TauriClipboardApi extends ClipboardApi {
  copyText(text: string): Promise<void> {
    return call('copy_text', { text });
  }

  copyResult(
    resultId: number,
    selection: CopySelection,
    format: CopyFormat,
    options: CopyOptions,
  ): Promise<Copied> {
    return call('copy_result', { resultId, selection, format, options });
  }

  cancelCopy(): Promise<void> {
    return call('cancel_copy');
  }
}
