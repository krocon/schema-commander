import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from '../backend/call';
import { Loaded } from '../import/data-import-api';

/** Mirrors `Gen` in src-tauri/src/testdata.rs (prompt 049): how the values of a column are made. */
export type Gen =
  | { readonly kind: 'skip' }
  | { readonly kind: 'fixed'; readonly value: string }
  | { readonly kind: 'sequence'; readonly start: number; readonly step: number }
  | { readonly kind: 'int'; readonly min: number; readonly max: number; readonly normal: boolean }
  | { readonly kind: 'decimal'; readonly min: number; readonly max: number; readonly scale: number }
  | { readonly kind: 'bool'; readonly trueShare: number }
  | { readonly kind: 'date'; readonly from: string; readonly to: string }
  | {
      readonly kind: 'dateTime';
      readonly from: string;
      readonly to: string;
      /** A date-time column of the row this one is never earlier than. */
      readonly notBefore: string | null;
    }
  | { readonly kind: 'time' }
  | { readonly kind: 'uuid' }
  | { readonly kind: 'text'; readonly min: number; readonly max: number }
  | { readonly kind: 'pattern'; readonly pattern: string }
  | {
      readonly kind: 'choice';
      readonly values: readonly { readonly value: string; readonly weight: number }[];
    }
  | { readonly kind: 'firstName' }
  | { readonly kind: 'lastName' }
  | { readonly kind: 'fullName' }
  | { readonly kind: 'email' }
  | { readonly kind: 'phone' }
  | { readonly kind: 'street' }
  | { readonly kind: 'city' }
  | { readonly kind: 'zip' }
  | { readonly kind: 'country' }
  | { readonly kind: 'company' }
  | { readonly kind: 'lorem'; readonly words: number }
  | { readonly kind: 'json'; readonly template: string }
  | { readonly kind: 'foreignKey'; readonly perParent: readonly [number, number] | null };

export type GenKind = Gen['kind'];

/** Mirrors `ColumnSpec`. */
export interface ColumnSpec {
  readonly name: string;
  readonly typeName: string;
  readonly valueKind: 'number' | 'bool' | 'text' | 'bytes';
  readonly gen: Gen;
  /** The share of rows without a value, 0 to 1. */
  readonly nullShare: number;
  readonly unique: boolean;
  readonly maxLen: number | null;
}

/** Mirrors `Spec`. */
export interface TestdataSpec {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly ColumnSpec[];
  readonly rows: number;
  readonly seed: number;
  readonly locale: string;
}

export interface TestdataReference {
  readonly column: string;
  readonly refSchema: string;
  readonly refTable: string;
  readonly refColumn: string;
}

export interface TestdataSuggestion {
  readonly columns: readonly ColumnSpec[];
  readonly references: readonly TestdataReference[];
}

export interface TestdataPreview {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  /** The rows there would be. */
  readonly total: number;
}

/** Test data (prompt 049): rows the backend makes up, the same again for the same seed. */
export abstract class TestdataApi {
  /** A generator for every column, proposed from types, keys and names. */
  abstract suggest(
    connectionId: string,
    schema: string,
    table: string,
  ): Promise<TestdataSuggestion>;
  abstract preview(
    connectionId: string,
    spec: TestdataSpec,
    rows: number,
  ): Promise<TestdataPreview>;
  /** The statements a run sends, for the guard. */
  abstract statements(
    connectionId: string,
    spec: TestdataSpec,
    clearFirst: boolean,
  ): Promise<string[]>;
  /** Fills the table as a job; refused on a protected connection. */
  abstract run(
    jobId: number,
    connectionId: string,
    spec: TestdataSpec,
    options: { readonly clearFirst: boolean; readonly wholeTransaction: boolean },
    confirmations: readonly (string | null)[],
    allowDangerous: boolean,
    onProgress: (rows: number) => void,
  ): Promise<Loaded>;
  /** The same rows into a file: `csv` or `insert`. Returns the rows written. */
  abstract export(
    jobId: number,
    connectionId: string,
    spec: TestdataSpec,
    path: string,
    format: 'csv' | 'insert',
  ): Promise<number>;
  abstract cancel(jobId: number): Promise<void>;
}

@Injectable()
export class TauriTestdataApi extends TestdataApi {
  suggest(connectionId: string, schema: string, table: string): Promise<TestdataSuggestion> {
    return call('testdata_suggest', { id: connectionId, schema, table });
  }

  preview(connectionId: string, spec: TestdataSpec, rows: number): Promise<TestdataPreview> {
    return call('testdata_preview', { id: connectionId, spec, rows });
  }

  statements(connectionId: string, spec: TestdataSpec, clearFirst: boolean): Promise<string[]> {
    return call('testdata_statements', { id: connectionId, spec, clearFirst });
  }

  run(
    jobId: number,
    connectionId: string,
    spec: TestdataSpec,
    options: { readonly clearFirst: boolean; readonly wholeTransaction: boolean },
    confirmations: readonly (string | null)[],
    allowDangerous: boolean,
    onProgress: (rows: number) => void,
  ): Promise<Loaded> {
    const channel = new Channel<number>();
    channel.onmessage = onProgress;
    return call('testdata_run', {
      jobId,
      id: connectionId,
      spec,
      clearFirst: options.clearFirst,
      wholeTransaction: options.wholeTransaction,
      confirmations,
      allowDangerous,
      onProgress: channel,
    });
  }

  export(
    jobId: number,
    connectionId: string,
    spec: TestdataSpec,
    path: string,
    format: 'csv' | 'insert',
  ): Promise<number> {
    return call('testdata_export', { jobId, id: connectionId, spec, path, format });
  }

  cancel(jobId: number): Promise<void> {
    return call('cancel_job', { jobId });
  }
}
