import { Copied, CopyFormat, CopySelection } from '../../core/backend/clipboard-api';
import { RESULTS_TEXTS } from './results-texts';

/** A format whose label is read when it is asked for: it follows the language. */
const format = (id: CopyFormat): { readonly id: CopyFormat; readonly label: string } => ({
  id,
  get label() {
    return RESULTS_TEXTS.formats[id];
  },
});

/** The formats in the order of the menu. */
export const COPY_FORMATS: readonly { readonly id: CopyFormat; readonly label: string }[] = (
  ['tsv', 'csv', 'json', 'markdown', 'html', 'insert', 'inlist', 'where', 'values'] as const
).map(format);

export const isCopyFormat = (id: unknown): id is CopyFormat =>
  COPY_FORMATS.some((f) => f.id === id);

/** The formats with the one used last on top. */
export function orderedFormats(
  last: CopyFormat | null,
): readonly { readonly id: CopyFormat; readonly label: string }[] {
  const first = COPY_FORMATS.find((f) => f.id === last);
  return first ? [first, ...COPY_FORMATS.filter((f) => f !== first)] : COPY_FORMATS;
}

/** A selected range of the grid: rows and grid columns, both ends included. */
export interface GridRange {
  readonly r1: number;
  readonly c1: number;
  readonly r2: number;
  readonly c2: number;
}

/**
 * What a selection of the grid means for the result. Grid column 0 is the row number: a range that touches it
 * means whole rows. Nothing selected means the whole result.
 */
export function selectionOf(
  ranges: readonly GridRange[],
  allSelected: boolean,
  columnCount: number,
): CopySelection {
  if (allSelected || ranges.length === 0) return { rows: [], columns: [] };
  const rows: [number, number][] = [];
  const columns = new Set<number>();
  let wholeRows = false;
  for (const range of ranges) {
    const r1 = Math.max(0, Math.min(range.r1, range.r2));
    const r2 = Math.max(range.r1, range.r2);
    rows.push([r1, r2]);
    const c1 = Math.min(range.c1, range.c2);
    const c2 = Math.min(Math.max(range.c1, range.c2), columnCount);
    if (c1 <= 0) wholeRows = true;
    for (let c = Math.max(1, c1); c <= c2; c++) columns.add(c - 1);
  }
  return {
    rows,
    columns: wholeRows ? [] : [...columns].sort((a, b) => a - b),
  };
}

/** How many rows and cells a selection has (ranges that overlap count twice: an upper bound). */
export function selectionSize(
  selection: CopySelection,
  rowCount: number,
  columnCount: number,
): { rows: number; cells: number } {
  const rows =
    selection.rows.length === 0
      ? rowCount
      : Math.min(
          rowCount,
          selection.rows.reduce((sum, [a, b]) => sum + (Math.min(b, rowCount - 1) - a + 1), 0),
        );
  const columns = selection.columns.length === 0 ? columnCount : selection.columns.length;
  return { rows: Math.max(0, rows), cells: Math.max(0, rows) * columns };
}

/** From so many cells on, copying asks first. */
export const ASK_FROM_CELLS = 1_000_000;

/** Thin spaces between groups of three digits. */
const count = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, ' ');

/** The question before a big copy. */
export function bigCopyQuestion(rows: number, cells: number): string {
  return RESULTS_TEXTS.bigCopyQuestion(count(rows), count(cells));
}

/** What the status line says after a copy. */
export function copiedMessage(copied: Copied, format: CopyFormat): string {
  const label = COPY_FORMATS.find((f) => f.id === format)?.label.replace(/ \(.*$/, '') ?? format;
  return RESULTS_TEXTS.copied(copied.rows, count(copied.rows), label);
}

/**
 * The table a statement reads, as it is written there – when it reads exactly one. For `INSERT` statements
 * made from a result; everything else gets a placeholder.
 */
export function tableOf(sql: string): string | null {
  const text = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  const name = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[\\p{L}_][\\p{L}\\p{N}_$]*)';
  const from = new RegExp('\\bfrom\\s+(' + name + '(?:\\s*\\.\\s*' + name + '){0,2})', 'giu');
  const found = [...text.matchAll(from)];
  if (found.length !== 1) return null;
  // a join or a second table: no single table to insert into
  const rest = text.slice((found[0].index ?? 0) + found[0][0].length);
  if (/^\s*,|\bjoin\b/i.test(rest)) return null;
  return found[0][1].replace(/\s*\.\s*/g, '.');
}

/** The placeholder for the table of `INSERT` when the statement names none (in the current language). */
export const tablePlaceholder = (): string => RESULTS_TEXTS.tablePlaceholder;
