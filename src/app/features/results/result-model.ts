import {
  AreaModel,
  CellRendererIf,
  ColumnDef,
  FocusModel,
  SelectionModel,
  Size,
  TableFactory,
  TableModelIf,
  TableOptions,
  TableOptionsIf,
} from '@guiexpert/table';
import { QueryColumn, RowWindow } from '../../core/sql/query.models';
import { CellFormat, PLAIN_FORMAT, showCell, typeLabel } from './cell-format';
import { ResolvedLayout } from './column-layout';

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
  // a focus model of our own: the cursor is moved from outside too (a hit, a row number; prompt 029)
  const focus = new FocusModel('cell');
  const base = new TableOptions();
  return {
    ...base,
    hoverColumnVisible: false,
    defaultRowHeights: { header: HEADER_ROW_HEIGHT, body: rowHeight, footer: 0 },
    getSelectionModel: () => selection,
    getFocusModel: () => focus,
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
  /** Grid column − 1 → column of the result (the layout hides and moves columns); `null` = as they come. */
  private map: readonly number[] | null = null;
  /** The cells a search found, and the one it stands on (prompt 029). */
  private hits: HitMarks | null = null;
  private links: ReadonlySet<number> | null = null;

  /** Which result column each grid column shows (the caller builds a new table model). */
  setShown(shown: readonly number[] | null): void {
    this.map = shown;
  }

  /** The columns of the result whose cells lead to another table (prompt 030; the caller repaints). */
  setLinks(links: ReadonlySet<number> | null): void {
    this.links = links;
  }

  /** The hits to mark from now on (the caller repaints). */
  setHits(hits: HitMarks | null): void {
    this.hits = hits;
  }

  /** The column of the result a grid column shows; `-1` for the row number. */
  resultColumn(col: number): number {
    if (col < 1) return -1;
    return this.map ? (this.map[col - 1] ?? -1) : col - 1;
  }

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
    const out: string[] = cls ? [cls] : [];
    // a cell of a foreign key that holds a value is a link
    if (this.links?.has(this.resultColumn(col)) && cls !== 'sc-null') out.push('sc-fk');
    const mark = this.hits?.at(row, this.resultColumn(col));
    if (mark) out.push(mark === 'current' ? 'sc-hit-current' : 'sc-hit');
    return out;
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
    return cells[this.resultColumn(col)] ?? null;
  }

  private shown(row: number, col: number) {
    const cell = this.cellAt(row, col);
    if (cell === undefined) return undefined;
    return showCell(cell, this.columns[this.resultColumn(col)]?.kind ?? 'other', this.format);
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

/** The cells a search found: what the grid asks while it paints. Columns are those of the result. */
export interface HitMarks {
  at(row: number, column: number): 'hit' | 'current' | null;
}

/**
 * The header of a result column: its name and, small, its type. Built from text nodes only.
 */
export class HeaderRenderer implements CellRendererIf {
  /** `mark`: the column is a sort key – its direction and, among several, its rank (`▲2`). */
  constructor(
    private readonly column: QueryColumn,
    private readonly mark = '',
  ) {}

  render(cellDiv: HTMLDivElement): undefined {
    const doc = cellDiv.ownerDocument;
    const type = typeLabel(this.column.typeName);
    const name = doc.createElement('span');
    name.className = 'sc-head-name';
    name.textContent = this.column.name;
    cellDiv.appendChild(name);
    if (this.mark) {
      const sort = doc.createElement('span');
      sort.className = 'sc-head-sort';
      sort.textContent = this.mark;
      cellDiv.appendChild(sort);
    }
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
  /** The sort keys to mark in the heads (prompt 027). */
  marks: readonly { column: number; desc: boolean; rank: number }[] = [],
  /** Which columns are shown, in which order, how many stay at the left, and widths the user set. */
  layout: ResolvedLayout | null = null,
): TableModelIf {
  const markOf = (c: number) => {
    const m = marks.find((k) => k.column === c);
    return m ? `${m.desc ? '▼' : '▲'}${m.rank > 0 ? m.rank : ''}` : '';
  };
  const widths = columnWidths(columns, first);
  const shown = layout?.shown ?? columns.map((_, c) => c);
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
    ...shown.map((c, i) =>
      ColumnDef.create({
        // the property names the column of the result: a drag reports the new order in these
        property: `c${c}`,
        headerLabel: columns[c].name,
        width: new Size(layout?.widths[i] ?? widths[c], 'px'),
        headerRenderer: new HeaderRenderer(columns[c], markOf(c)),
        // the table centres cells by default; numbers move to the right by the class of the cell
        headerClasses: ['ge-table-text-align-left', 'sc-head'],
        bodyClasses: ['ge-table-text-align-left'],
        // the table itself sorts nothing: a click on a head asks the server or the store (prompt 027)
        sortable: () => false,
      }),
    ),
  ];
  return TableFactory.createTableModel({
    bodyAreaModel: body,
    columnDefs,
    tableOptions: options,
    fixedLeftColumnCount: 1 + (layout?.pinned ?? 0),
  });
}
