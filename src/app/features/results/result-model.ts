import {
  AreaModel,
  ColumnDef,
  Size,
  TableFactory,
  TableModelIf,
  TableOptions,
  TableOptionsIf,
} from '@guiexpert/table';
import { Cell, QueryColumn, RowWindow } from '../../core/sql/query.models';

/** Row heights in px; the line height of the cells follows them in `ge-table-theme.css`. */
export const HEADER_ROW_HEIGHT = 26;
export const BODY_ROW_HEIGHT = 22;

/** The options of the result grid. */
export const RESULT_OPTIONS: TableOptionsIf = {
  ...new TableOptions(),
  hoverColumnVisible: false,
  defaultRowHeights: { header: HEADER_ROW_HEIGHT, body: BODY_ROW_HEIGHT, footer: 0 },
};

/** Rows asked for at once. */
export const PAGE_ROWS = 200;
/** Pages kept; the ones farthest from where the view is are dropped first. */
export const MAX_PAGES = 60;

const CHAR_PX = 8;
const MIN_WIDTH = 60;
const MAX_WIDTH = 420;
const NUMBER_MIN_WIDTH = 44;

/** A cell as the table shows it. */
export type Shown = string | number | null;

/** A cell as text; `null` stays `null` (shown empty until prompt 007 brings a renderer for NULL). */
export function cellText(cell: Cell): string | null {
  if (cell === null) return null;
  if (typeof cell === 'object') {
    if ('unreadable' in cell) return `‹${cell.unreadable}›`;
    return `0x${cell.hex}${cell.bytes * 2 > cell.hex.length ? '…' : ''} (${cell.bytes} B)`;
  }
  return String(cell);
}

/** A window as the table shows it: numbers and text as they are, everything else as text. */
export function shownRows(rows: RowWindow): Shown[][] {
  return rows.map((row) =>
    row.map((cell) =>
      cell === null || typeof cell === 'string' || typeof cell === 'number' ? cell : cellText(cell),
    ),
  );
}

/** Column widths in px from the header and some rows. */
export function columnWidths(columns: readonly QueryColumn[], sample: RowWindow): number[] {
  return columns.map((column, c) => {
    let chars = column.name.length + 2;
    for (const row of sample) chars = Math.max(chars, (cellText(row[c]) ?? 'NULL').length);
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, chars * CHAR_PX + 16));
  });
}

/** The width of the row number column for so many rows. */
export function numberWidth(rows: number): number {
  return Math.max(NUMBER_MIN_WIDTH, String(Math.max(1, rows)).length * CHAR_PX + 18);
}

/**
 * Numbers are right-aligned: by the kind of the column, and for a column of unknown kind (an expression in
 * SQLite) by its first value.
 */
export function isNumeric(columns: readonly QueryColumn[], c: number, sample: RowWindow): boolean {
  const kind = columns[c].kind;
  if (kind === 'int' || kind === 'float' || kind === 'decimal') return true;
  if (kind !== 'other') return false;
  const first = sample.find((row) => row[c] !== null)?.[c];
  return typeof first === 'number';
}

/** The page a row is on, and the pages a cache keeps when it is full. */
export const pageOf = (row: number) => Math.floor(row / PAGE_ROWS);

/** The pages to drop from `pages` so that `max` remain: the ones farthest from `around`. */
export function pagesToDrop(pages: readonly number[], around: number, max: number): number[] {
  if (pages.length <= max) return [];
  return [...pages]
    .sort((a, b) => Math.abs(b - around) - Math.abs(a - around))
    .slice(0, pages.length - max);
}

/**
 * The rows of a result in the store of the backend, as the body of the table (prompt 006): the table asks
 * for cells, this model answers from the pages it has and fetches the others. A cell of a page that is not
 * there yet is empty until it arrives (`onLoaded` repaints). Column 0 is the row number.
 */
export class WindowAreaModel extends AreaModel {
  private count = 0;
  private readonly pages = new Map<number, Shown[][]>();
  private readonly pending = new Set<number>();
  private disposed = false;

  constructor(
    private readonly fetch: (from: number, count: number) => Promise<RowWindow>,
    private readonly onLoaded: () => void,
    first: RowWindow,
  ) {
    super();
    this.areaIdent = 'body';
    if (first.length > 0) this.pages.set(0, shownRows(first));
  }

  /** The result has so many rows by now. */
  setRowCount(count: number): void {
    // a page read while the result was shorter misses rows now: it is read again when asked for
    for (const [page, rows] of this.pages) {
      const wanted = Math.min(PAGE_ROWS, count - page * PAGE_ROWS);
      if (rows.length < wanted) this.pages.delete(page);
    }
    this.count = count;
  }

  dispose(): void {
    this.disposed = true;
    this.pages.clear();
  }

  override getRowCount(): number {
    return this.count;
  }

  override getRowHeight(): number {
    return BODY_ROW_HEIGHT;
  }

  override getConstantRowHeight(): number {
    return BODY_ROW_HEIGHT;
  }

  override getValueAt(row: number, col: number): Shown {
    if (col === 0) return row + 1;
    const page = pageOf(row);
    const rows = this.pages.get(page);
    if (!rows) {
      this.request(page);
      return '';
    }
    const cells = rows[row - page * PAGE_ROWS];
    if (!cells) {
      // the page was read before the result had this row
      this.request(page);
      return '';
    }
    return cells[col - 1] ?? null;
  }

  /** Whether a page is there (for tests). */
  has(page: number): boolean {
    return this.pages.has(page);
  }

  private request(page: number): void {
    if (this.pending.has(page) || this.disposed) return;
    this.pending.add(page);
    this.fetch(page * PAGE_ROWS, PAGE_ROWS).then(
      (rows) => {
        this.pending.delete(page);
        if (this.disposed) return;
        this.pages.set(page, shownRows(rows));
        for (const old of pagesToDrop([...this.pages.keys()], page, MAX_PAGES)) {
          this.pages.delete(old);
        }
        this.onLoaded();
      },
      () => {
        // the result is gone (tab closed, new run): nothing to show
        this.pending.delete(page);
      },
    );
  }
}

/**
 * The table model of a result: the row number, then one column per result column. `first` are its first
 * rows (for the widths; they are shown without another fetch).
 */
export function resultModel(
  columns: readonly QueryColumn[],
  first: RowWindow,
  body: WindowAreaModel,
  rows: number,
): TableModelIf {
  const widths = columnWidths(columns, first);
  const columnDefs = [
    ColumnDef.create({
      property: '#',
      headerLabel: '#',
      width: new Size(numberWidth(rows), 'px'),
      headerClasses: ['sc-rownum'],
      bodyClasses: ['sc-rownum'],
    }),
    ...columns.map((column, c) =>
      ColumnDef.create({
        property: `c${c}`,
        headerLabel: column.name,
        width: new Size(widths[c], 'px'),
        // the table centres cells by default
        headerClasses: ['ge-table-text-align-left'],
        bodyClasses: isNumeric(columns, c, first) ? ['sc-num'] : ['ge-table-text-align-left'],
      }),
    ),
  ];
  return TableFactory.createTableModel({
    bodyAreaModel: body,
    columnDefs,
    tableOptions: RESULT_OPTIONS,
    fixedLeftColumnCount: 1,
  });
}
