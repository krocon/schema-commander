import { ExportFormat, ExportSpec, Exported } from '../../core/backend/export-api';
import { DbKind } from '../../core/connections/connection.models';

/** The formats in the order of the dialog. */
export const EXPORT_FORMATS: readonly {
  id: ExportFormat;
  label: string;
  extension: string;
}[] = [
  { id: 'csv', label: 'CSV', extension: 'csv' },
  { id: 'tsv', label: 'TSV (Tabulator)', extension: 'tsv' },
  { id: 'xlsx', label: 'Excel (.xlsx)', extension: 'xlsx' },
  { id: 'json', label: 'JSON', extension: 'json' },
  { id: 'ndjson', label: 'NDJSON (ein Objekt je Zeile)', extension: 'ndjson' },
  { id: 'insert', label: 'INSERT-Skript', extension: 'sql' },
  { id: 'markdown', label: 'Markdown-Tabelle', extension: 'md' },
  { id: 'html', label: 'HTML-Tabelle', extension: 'html' },
];

export const isExportFormat = (id: unknown): id is ExportFormat =>
  EXPORT_FORMATS.some((f) => f.id === id);

/** What a format can be told. */
export function formatHas(format: ExportFormat): {
  header: boolean;
  nullAs: boolean;
  delimiter: boolean;
  text: boolean;
  insert: boolean;
} {
  const text = format !== 'xlsx';
  return {
    header: format === 'csv' || format === 'tsv' || format === 'html',
    nullAs: format === 'csv' || format === 'tsv' || format === 'markdown' || format === 'html',
    delimiter: format === 'csv',
    text,
    insert: format === 'insert',
  };
}

/** The choices of the dialog; stored per format in the settings. */
export interface ExportChoices {
  readonly header: boolean;
  readonly nullAs: string;
  readonly delimiter: string;
  readonly crlf: boolean;
  readonly bom: boolean;
  readonly gzip: boolean;
  /** Rows per `INSERT`. */
  readonly batch: number;
}

export const DEFAULT_CHOICES: ExportChoices = {
  header: true,
  nullAs: '',
  delimiter: ',',
  crlf: false,
  bom: false,
  gzip: false,
  batch: 500,
};

/** Stored choices, forgiving: what is missing or broken has its default. */
export function mergeChoices(saved: unknown): ExportChoices {
  const s = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {};
  const flag = (key: keyof ExportChoices) =>
    typeof s[key] === 'boolean' ? (s[key] as boolean) : (DEFAULT_CHOICES[key] as boolean);
  return {
    header: flag('header'),
    nullAs: ['', 'NULL', '\\N'].includes(s['nullAs'] as string) ? (s['nullAs'] as string) : '',
    delimiter: [',', ';', '\t', '|'].includes(s['delimiter'] as string)
      ? (s['delimiter'] as string)
      : ',',
    crlf: flag('crlf'),
    bom: flag('bom'),
    gzip: flag('gzip'),
    batch:
      typeof s['batch'] === 'number' && Number.isInteger(s['batch']) && s['batch'] >= 1
        ? Math.min(10_000, s['batch'])
        : DEFAULT_CHOICES.batch,
  };
}

/** The spec the backend gets for the choices of the dialog. */
export function specOf(
  format: ExportFormat,
  choices: ExportChoices,
  columns: readonly number[],
  table: string,
  dialect: DbKind,
): ExportSpec {
  const has = formatHas(format);
  return {
    format,
    options: {
      header: has.header ? choices.header : true,
      nullAs: has.nullAs ? choices.nullAs : '',
      delimiter: choices.delimiter,
      crlf: format === 'csv' && choices.crlf,
      table,
      dialect,
      batch: has.insert ? choices.batch : 1,
    },
    bom: has.text && (format === 'csv' || format === 'tsv') && choices.bom,
    gzip: has.text && choices.gzip,
    columns,
  };
}

/** A file name for what is exported: letters, digits, `-`, `_` and `.` of `base`, with the extension. */
export function fileName(base: string, format: ExportFormat, gzip: boolean): string {
  const clean =
    base
      .normalize('NFC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '_')
      .replace(/^[_.]+|[_.]+$/g, '')
      .slice(0, 80) || 'export';
  const extension = EXPORT_FORMATS.find((f) => f.id === format)?.extension ?? 'txt';
  return `${clean}.${extension}${gzip && format !== 'xlsx' ? '.gz' : ''}`;
}

/** The last part of a path, for both kinds of separators. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

const count = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, '\u202f');

/** A size in bytes, short. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1).replace('.', ',') : Math.round(value)} ${units[unit]}`;
}

/** What the status line says while a file is written. */
export function progressMessage(name: string, rows: number): string {
  return `Export nach ${name}: ${count(rows)} Zeilen …`;
}

/** What the status line says when a file is there. */
export function doneMessage(name: string, done: Exported): string {
  const rows = done.rows === 1 ? '1 Zeile' : `${count(done.rows)} Zeilen`;
  let text = `${rows} nach ${name} exportiert (${sizeLabel(done.bytes)})`;
  if (done.truncated) text += ' – mehr Zeilen nimmt Excel nicht, der Rest fehlt';
  if (done.cutCells > 0) {
    text += ` – ${count(done.cutCells)} ${done.cutCells === 1 ? 'Zelle' : 'Zellen'} gekürzt`;
  }
  return text;
}
