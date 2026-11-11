import { translatable } from '../../core/i18n/i18n';
import { EXPORT_DE } from './export-texts.de';

/** Texts of the export into files (prompt 011). English is the source. */
export const EXPORT_EN = {
  title: 'Export',
  format: 'Format',
  delimiter: 'Delimiter',
  comma: 'Comma',
  semicolon: 'Semicolon',
  tab: 'Tab',
  pipe: 'Vertical bar',
  nullAs: 'NULL as',
  empty: 'empty',
  rowsPerInsert: 'Rows per INSERT',
  table: 'Table',
  header: 'Header row',
  crlf: 'Line ending CR LF',
  bom: 'UTF-8 with BOM (for Excel)',
  gzip: 'gzip',
  rerun: 'Run the statement again (all rows, straight from the server)',
  columns: 'Columns',
  all: 'all',
  none: 'none',
  preview: 'Preview of the first rows',
  saveAs: 'Save as …',
  whatQuery: (name: string) => `${name}: all rows, straight from the server`,
  whatSelected: (name: string) => `${name}: the selected rows of the result`,
  whatRows: (name: string, rows: number) =>
    `${name}: ${rows === 1 ? '1 row' : `${rows} rows`} of the result`,
  /** The table of an INSERT script when nothing names one. */
  defaultTable: 'table_name',
  saveDialogFailed: 'The save dialog could not be opened.',
  /** The formats, by `ExportFormat`. */
  formats: {
    csv: 'CSV',
    tsv: 'TSV (tab)',
    xlsx: 'Excel (.xlsx)',
    json: 'JSON',
    ndjson: 'NDJSON (one object per line)',
    insert: 'INSERT script',
    markdown: 'Markdown table',
    html: 'HTML table',
  },
  /** Status line; `rows` and `cells` are the formatted numbers, `n` the number itself. */
  progress: (name: string, rows: string) => `Export to ${name}: ${rows} rows …`,
  done: (name: string, n: number, rows: string, size: string) =>
    `${n === 1 ? '1 row' : `${rows} rows`} exported to ${name} (${size})`,
  truncated: ' – Excel takes no more rows, the rest is missing',
  cutCells: (n: number, cells: string) => ` – ${cells} ${n === 1 ? 'cell' : 'cells'} shortened`,
  cancelled: (name: string) => `Export to ${name} cancelled; no file was written.`,
  failed: (name: string, why: string) => `Export to ${name} failed: ${why}`,
};

export const EXPORT_TEXTS = translatable('export', EXPORT_EN, { de: EXPORT_DE });
