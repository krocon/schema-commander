import {
  ColumnDef,
  Size,
  TableFactory,
  TableModelIf,
  TableOptions,
  TableOptionsIf,
  TrueFn,
} from '@guiexpert/table';
import { Cell, QueryResult } from '../../core/sql/query.models';

/** Row heights in px; the line height of the cells follows them in `ge-table-theme.css`. */
export const HEADER_ROW_HEIGHT = 26;
export const BODY_ROW_HEIGHT = 22;

/**
 * The options of the result grid. The factory needs them too when it builds the model: the row heights
 * only act there.
 */
export const RESULT_OPTIONS: TableOptionsIf = {
  ...new TableOptions(),
  hoverColumnVisible: false,
  defaultRowHeights: { header: HEADER_ROW_HEIGHT, body: BODY_ROW_HEIGHT, footer: 0 },
};

const CHAR_PX = 8;
const MIN_WIDTH = 60;
const MAX_WIDTH = 420;
/** Rows looked at for the column widths. */
const SAMPLE = 200;

/** A cell as text; `null` stays `null` (shown empty until prompt 007 brings a renderer for NULL). */
export function cellText(cell: Cell): string | null {
  if (cell === null) return null;
  if (typeof cell === 'object') {
    if ('unreadable' in cell) return `‹${cell.unreadable}›`;
    return `0x${cell.hex}${cell.bytes * 2 > cell.hex.length ? '…' : ''} (${cell.bytes} B)`;
  }
  return String(cell);
}

/**
 * The rows as the table shows them: numbers and text as they are, everything else as text. Rows are only
 * copied when the result has cells that need it.
 */
export function displayRows(result: QueryResult): readonly (readonly (string | number | null)[])[] {
  const plain = (cell: Cell) =>
    cell === null || typeof cell === 'string' || typeof cell === 'number';
  if (result.rows.every((row) => row.every(plain))) {
    return result.rows as readonly (readonly (string | number | null)[])[];
  }
  return result.rows.map((row) =>
    row.map((cell) => (plain(cell) ? (cell as string | number | null) : cellText(cell))),
  );
}

/** Column widths in px from the header and the first rows. */
export function columnWidths(result: QueryResult): number[] {
  return result.columns.map((column, c) => {
    let chars = column.name.length + 2;
    const n = Math.min(result.rows.length, SAMPLE);
    for (let r = 0; r < n; r++) {
      chars = Math.max(chars, (cellText(result.rows[r][c]) ?? 'NULL').length);
    }
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, chars * CHAR_PX + 16));
  });
}

/**
 * Numbers are right-aligned: by the kind of the column, and for a column of unknown kind (an expression in
 * SQLite) by its first value.
 */
export function isNumeric(result: QueryResult, c: number): boolean {
  const kind = result.columns[c].kind;
  if (kind === 'int' || kind === 'float' || kind === 'decimal') return true;
  if (kind !== 'other') return false;
  const first = result.rows.find((row) => row[c] !== null)?.[c];
  return typeof first === 'number';
}

/** The table model of a result: one column per result column, rows as they came (arrays). */
export function resultModel(result: QueryResult): TableModelIf {
  const widths = columnWidths(result);
  const columnDefs = result.columns.map((column, c) =>
    ColumnDef.create({
      property: String(c),
      headerLabel: column.name,
      width: new Size(widths[c], 'px'),
      sortable: TrueFn,
      // the table centres cells by default
      headerClasses: ['ge-table-text-align-left'],
      bodyClasses: isNumeric(result, c) ? ['sc-num'] : ['ge-table-text-align-left'],
    }),
  );
  return TableFactory.createTableModel({
    rows: displayRows(result) as unknown[] as never[],
    columnDefs,
    tableOptions: RESULT_OPTIONS,
    rowNumbersVisible: true,
  });
}
