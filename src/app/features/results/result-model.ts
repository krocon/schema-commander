import {
  AreaModel,
  CellRendererIf,
  ColumnDef,
  SelectionModel,
  Size,
  TableFactory,
  TableModelIf,
  TableOptions,
  TableOptionsIf,
} from '@guiexpert/table';
import { QueryColumn, RowWindow } from '../../core/sql/query.models';
import { CellFormat, PLAIN_FORMAT, showCell, typeLabel } from './cell-format';

/** Row heights in px; the line height of the cells follows them in `ge-table-theme.css`. */
export const HEADER_ROW_HEIGHT = 26;
export const BODY_ROW_HEIGHT = 22;

/** A fitted column (double click on its edge) is never wider than this. */
export const MAX_FIT_WIDTH = 800;

/**
 * The options of one result grid. Each grid has a selection of its own: cells, ranges, rows and columns by
 * mouse and keyboard (the ground for copying, prompt 009).
 */
export function resultOptions(rowHeight = BODY_ROW_HEIGHT): TableOptionsIf {
  const selection = new SelectionModel('range', 'multi');
  const base = new TableOptions();
  return {
    ...base,
    hoverColumnVisible: false,
    defaultRowHeights: { header: HEADER_ROW_HEIGHT, body: rowHeight, footer: 0 },
    getSelectionModel: () => selection,
    columnAutoWidth: {
      ...base.columnAutoWidth,
      doubleClick: true,
      getWidth: (ctx) => Math.min(MAX_FIT_WIDTH, ctx.getDefaultWidth()),
    },
  };
}

/** Rows asked for at once. */
export const PAGE_ROWS = 200;
/** Pages kept; the ones farthest from where the view is are dropped first. */
export const MAX_PAGES = 60;

const CHAR_PX = 8;
const MIN_WIDTH = 60;
const MAX_WIDTH = 420;
const NUMBER_MIN_WIDTH = 44;
/** Rows looked at for the widths. */
const WIDTH_SAMPLE = 100;

/** Column widths in px from the header and some rows. */
export function columnWidths(columns: readonly QueryColumn[], sample: RowWindow): number[] {
  return columns.map((column, c) => {
    const type = typeLabel(column.typeName);
    let chars = column.name.length + (type ? type.length + 1 : 0) + 2;
    for (const row of sample.slice(0, WIDTH_SAMPLE)) {
      chars = Math.max(chars, showCell(row[c], column.kind).text.length);
    }
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, chars * CHAR_PX + 16));
  });
}

/** The width of the row number column for so many rows. */
export function numberWidth(rows: number): number {
  return Math.max(NUMBER_MIN_WIDTH, String(Math.max(1, rows)).length * CHAR_PX + 18);
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
 * there yet is empty until it arrives (`onLoaded` repaints). Column 0 is the row number. The pages hold the
 * cells as they came; what the grid shows is made from them when it asks (`showCell`).
 */
export class WindowAreaModel extends AreaModel {
  private count = 0;
  private readonly pages = new Map<number, RowWindow>();
  private format: CellFormat = PLAIN_FORMAT;
  private readonly pending = new Set<number>();
  /**
   * Pages that came back with fewer rows than the result claims, and the row count they were asked at: they
   * are not asked for again until the result grows – else every repaint would fetch, and every answer repaint.
   */
  private readonly short = new Map<number, number>();
  private disposed = false;

  constructor(
    private readonly fetch: (from: number, count: number) => Promise<RowWindow>,
    private readonly onLoaded: () => void,
    first: RowWindow,
    private readonly columns: readonly QueryColumn[] = [],
  ) {
    super();
    this.areaIdent = 'body';
    if (first.length > 0) this.pages.set(0, first);
  }

  /** How cells are shown from now on (the caller repaints). */
  setFormat(format: CellFormat): void {
    this.format = format;
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
    this.short.clear();
  }

  override getRowCount(): number {
    return this.count;
  }

  /** The height of every row in px (a setting; a new height needs a new table). */
  rowHeight = BODY_ROW_HEIGHT;

  override getRowHeight(): number {
    return this.rowHeight;
  }

  override getConstantRowHeight(): number {
    return this.rowHeight;
  }

  override getValueAt(row: number, col: number): string | number {
    if (col === 0) return row + 1;
    return this.shown(row, col)?.text ?? '';
  }

  override getTextValueAt(row: number, col: number): string {
    return String(this.getValueAt(row, col));
  }

  override getCustomClassesAt(row: number, col: number): string[] {
    if (col === 0) return [];
    const cls = this.shown(row, col)?.cls;
    return cls ? [cls] : [];
  }

  /** The cell as it came from the backend; `undefined` while its page is not there. */
  cellAt(row: number, col: number): RowWindow[number][number] | undefined {
    const page = pageOf(row);
    const cells = this.pages.get(page)?.[row - page * PAGE_ROWS];
    if (!cells) {
      // not read yet, or read before the result had this row
      this.request(page);
      return undefined;
    }
    return cells[col - 1] ?? null;
  }

  private shown(row: number, col: number) {
    const cell = this.cellAt(row, col);
    if (cell === undefined) return undefined;
    return showCell(cell, this.columns[col - 1]?.kind ?? 'other', this.format);
  }

  /** Whether a page is there (for tests). */
  has(page: number): boolean {
    return this.pages.has(page);
  }

  private request(page: number): void {
    if (this.pending.has(page) || this.disposed) return;
    if (this.short.get(page) === this.count) return;
    this.pending.add(page);
    this.fetch(page * PAGE_ROWS, PAGE_ROWS).then(
      (rows) => {
        this.pending.delete(page);
        if (this.disposed) return;
        this.pages.set(page, rows);
        const wanted = Math.min(PAGE_ROWS, this.count - page * PAGE_ROWS);
        if (rows.length < wanted) this.short.set(page, this.count);
        else this.short.delete(page);
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
 * The header of a result column: its name and, small, its type. Built from text nodes only.
 */
export class HeaderRenderer implements CellRendererIf {
  constructor(private readonly column: QueryColumn) {}

  render(cellDiv: HTMLDivElement): undefined {
    const doc = cellDiv.ownerDocument;
    const type = typeLabel(this.column.typeName);
    const name = doc.createElement('span');
    name.className = 'sc-head-name';
    name.textContent = this.column.name;
    cellDiv.appendChild(name);
    if (type) {
      const small = doc.createElement('span');
      small.className = 'sc-head-type';
      small.textContent = type;
      cellDiv.appendChild(small);
    }
    cellDiv.title = this.column.typeName
      ? `${this.column.name} · ${this.column.typeName}`
      : this.column.name;
    return undefined;
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
  options: TableOptionsIf,
): TableModelIf {
  const widths = columnWidths(columns, first);
  const columnDefs = [
    ColumnDef.create({
      property: '#',
      headerLabel: '#',
      width: new Size(numberWidth(rows), 'px'),
      headerClasses: ['sc-rownum'],
      bodyClasses: ['sc-rownum'],
      resizable: false,
      movable: false,
    }),
    ...columns.map((column, c) =>
      ColumnDef.create({
        property: `c${c}`,
        headerLabel: column.name,
        width: new Size(widths[c], 'px'),
        headerRenderer: new HeaderRenderer(column),
        // the table centres cells by default; numbers move to the right by the class of the cell
        headerClasses: ['ge-table-text-align-left', 'sc-head'],
        bodyClasses: ['ge-table-text-align-left'],
        // sorting comes with prompt 027: it cannot be done on the rows that happen to be here
        sortable: () => false,
        movable: false,
      }),
    ),
  ];
  return TableFactory.createTableModel({
    bodyAreaModel: body,
    columnDefs,
    tableOptions: options,
    fixedLeftColumnCount: 1,
  });
}
