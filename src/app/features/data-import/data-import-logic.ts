import {
  Guess,
  ImportEncoding,
  ImportFormat,
  LoadMapping,
  LoadPlan,
  Loaded,
  SourceOptions,
  TargetKind,
} from '../../core/import/data-import-api';
import { ColumnInfo } from '../../core/schema/schema.models';
import { DATA_IMPORT_TEXTS } from './data-import-texts';

/** Job ids of imports: apart from exports (1 …), formatting, views, statistics and searches. */
export const IMPORT_JOB_BASE = 5_000_000_000;
/** Rows of the file the dialog shows. */
export const PREVIEW_SHOWN = 20;

/** What the user chose in the dialog; `''` and `'auto'` mean: find out. */
export interface ImportChoices {
  readonly format: ImportFormat;
  readonly delimiter: string;
  readonly encoding: ImportEncoding | '';
  readonly header: 'auto' | 'yes' | 'no';
  readonly skipLines: number;
  /** Texts that mean „no value“, separated by commas. */
  readonly nullTexts: string;
  readonly emptyIsNull: boolean;
  readonly trim: boolean;
  readonly decimalComma: boolean;
  readonly dateOrder: '' | 'dmy' | 'mdy';
  readonly clearFirst: boolean;
  readonly onError: 'abort' | 'skip';
  readonly wholeTransaction: boolean;
}

export const DEFAULT_CHOICES: ImportChoices = {
  format: 'auto',
  delimiter: '',
  encoding: '',
  header: 'auto',
  skipLines: 0,
  nullTexts: 'NULL, \\N',
  emptyIsNull: true,
  trim: false,
  decimalComma: false,
  dateOrder: '',
  clearFirst: false,
  onError: 'abort',
  wholeTransaction: true,
};

/** How the backend reads the file. */
export function sourceOptions(c: ImportChoices): SourceOptions {
  return {
    format: c.format,
    delimiter: c.delimiter === '' ? null : c.delimiter,
    quote: null,
    encoding: c.encoding === '' ? null : c.encoding,
    header: c.header === 'auto' ? null : c.header === 'yes',
    skipLines: Math.max(0, Math.min(1_000_000, Math.floor(c.skipLines) || 0)),
  };
}

/** The texts that mean NULL, from what was typed. */
export const nullTexts = (typed: string): string[] => [
  ...new Set(
    typed
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== ''),
  ),
];

/** How a value of a column of the table is bound, from the name of its type. */
export function targetKind(typeName: string): TargetKind {
  const t = typeName.trim().toLowerCase();
  // MySQL's `tinyint(1)` is its boolean: results show true/false, and so does an export
  if (/^(bool|boolean|bit|tinyint\(1\))$/.test(t)) return 'bool';
  if (
    /^(tiny|small|medium|big)?(int|integer|serial)\d*\b/.test(t) ||
    /^(numeric|decimal|number|real|float|double|money|smallmoney|dec)\b/.test(t)
  ) {
    return 'number';
  }
  return 'text';
}

/** Whether a type holds a day or a moment. */
export const isDateType = (typeName: string): boolean => /date|time/i.test(typeName);

/** One row of the mapping: a column of the table and where its value comes from. */
export interface MapRow {
  readonly target: Pick<ColumnInfo, 'name' | 'typeName' | 'nullable' | 'default' | 'key'>;
  /** A column of the file, a fixed value, or nothing (the column is left to its default). */
  readonly source: number | 'fixed' | 'none';
  readonly fixed: string;
}

const plain = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Columns of the file to columns of the table: by name (case and punctuation do not count). When not
 * one name fits – a file without a header – by position.
 */
export function autoMap(
  fileColumns: readonly string[],
  tableColumns: readonly MapRow['target'][],
): MapRow[] {
  const byName = new Map<string, number>();
  fileColumns.forEach((c, i) => {
    const key = plain(c);
    if (key !== '' && !byName.has(key)) byName.set(key, i);
  });
  const named = tableColumns.map((c) => byName.get(plain(c.name)));
  const any = named.some((n) => n !== undefined);
  return tableColumns.map((target, i) => ({
    target,
    source: any ? (named[i] ?? 'none') : i < fileColumns.length ? i : 'none',
    fixed: '',
  }));
}

/** Keeps what the user mapped when the file is read again with other options. */
export function remap(old: readonly MapRow[], fileColumns: number): MapRow[] {
  return old.map((row) =>
    typeof row.source === 'number' && row.source >= fileColumns ? { ...row, source: 'none' } : row,
  );
}

/** What the backend gets. Columns mapped to nothing are not part of the `INSERT`. */
export function planOf(
  schema: string | null,
  table: string,
  rows: readonly MapRow[],
  c: ImportChoices,
): LoadPlan {
  const mappings: LoadMapping[] = rows
    .filter((row) => row.source !== 'none')
    .map((row) => {
      const kind = targetKind(row.target.typeName);
      return {
        source: typeof row.source === 'number' ? row.source : null,
        fixed: row.source === 'fixed' ? row.fixed : null,
        target: { name: row.target.name, kind, typeName: row.target.typeName },
        trim: c.trim,
        decimalComma: c.decimalComma && kind === 'number',
        dateOrder: c.dateOrder !== '' && isDateType(row.target.typeName) ? c.dateOrder : null,
      };
    });
  return {
    schema: schema === '' ? null : schema,
    table,
    mappings,
    nullTexts: nullTexts(c.nullTexts),
    emptyIsNull: c.emptyIsNull,
    clearFirst: c.clearFirst,
    onError: c.onError,
    wholeTransaction: c.onError === 'abort' && c.wholeTransaction,
  };
}

/** Columns of the table that must have a value and get none. */
export const unfilled = (rows: readonly MapRow[]): string[] =>
  rows
    .filter((r) => r.source === 'none' && !r.target.nullable && r.target.default === null)
    .map((r) => r.target.name);

/** A name for a new table from the name of the file: `Orders 2026.csv.gz` → `orders_2026`. */
export function tableNameOf(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? '';
  const base = file.replace(/(\.gz)$/i, '').replace(/\.[^.]*$/, '');
  const name = base
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return (/^\p{N}/u.test(name) ? `t_${name}` : name).slice(0, 60) || 'imported';
}

/** The name of a file without its folders. */
export const fileOf = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** The columns of a new table: the names of the file with the types guessed. */
export const ddlColumns = (
  columns: readonly string[],
  types: readonly Guess[],
): (readonly [string, Guess])[] =>
  columns.map(
    (name, i) => [name, types[i] ?? { kind: 'text', maxLen: 0, nullable: true }] as const,
  );

/** What was detected, in a line. */
export function detectedLine(d: {
  format: ImportFormat;
  delimiter: string;
  encoding: string;
  header: boolean;
  gzip: boolean;
}): string {
  const t = DATA_IMPORT_TEXTS;
  const parts: string[] = [t.formats[d.format]];
  if (d.format === 'csv') {
    parts.push(t.delimiterIs(d.delimiter === '\t' ? t.tab : d.delimiter));
    parts.push(d.header ? t.withHeader : t.withoutHeader);
  }
  parts.push(d.encoding.toUpperCase());
  if (d.gzip) parts.push('gzip');
  return parts.join(' · ');
}

/** How an import ended, in a line. */
export function reportLine(done: Loaded): string {
  const t = DATA_IMPORT_TEXTS;
  if (done.cancelled) {
    return done.rolledBack ? t.cancelledNothing : t.cancelledSome(done.written);
  }
  if (done.failed) {
    return done.rolledBack ? t.failedNothing : t.failedSome(done.written);
  }
  return done.skipped > 0 ? t.doneSkipped(done.written, done.skipped) : t.done(done.written);
}
