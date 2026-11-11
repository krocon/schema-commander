import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RESULT_MENU } from '../menus/menu-model';
import { MenuService } from '../menus/menu.service';
import { TableSignalComponent } from '@guiexpert/angular-table';
import {
  CellRange,
  GeColumnMoveEvent,
  GeColumnResizeEvent,
  TableApi,
  TableModelIf,
} from '@guiexpert/table';
import { CopySelection } from '../../core/backend/clipboard-api';
import { EditMarks } from '../edit/edit-buffer';
import { EDIT_TEXTS } from '../edit/edit-texts';
import { ResultRef, RowWindow } from '../../core/sql/query.models';
import { SettingsService } from '../../core/settings/settings.service';
import { CellFormat } from './cell-format';
import {
  ColumnLayout,
  EMPTY_LAYOUT,
  ResolvedLayout,
  ResultGridHandle,
  columnKeys,
  reorder,
  resolveLayout,
  setWidth,
} from './column-layout';
import { localTsv, selectionOf } from './copy-logic';
import { CopyService } from './copy.service';
import { StatsService } from '../stats/stats.service';
import { HitMarks, PAGE_ROWS, WindowAreaModel, resultModel, resultOptions } from './result-model';
import { RESULTS_TEXTS } from './results-texts';

/**
 * The rows of a result in a GuiExpert Table (prompt 006). The rows live in the backend: the grid fetches the
 * pages it shows and follows the row count while the statement still reads.
 */
@Component({
  selector: 'app-result-grid',
  host: {
    '(copy)': 'onCopy($event)',
    '(contextmenu)': 'onContextMenu($event)',
    '(keydown)': 'onKey($event)',
    '(dblclick)': 'onDoubleClick($event)',
    '(paste)': 'onPaste($event)',
    // font size and row height are settings (prompt 017); `ge-table-theme.css` reads them
    '[style.--result-font-size.px]': 'settings.settings().resultFontSize',
    '[style.--result-row-height.px]': 'settings.settings().resultRowHeight',
  },
  imports: [TableSignalComponent],
  template: `
    @if (model(); as m) {
      <guiexpert-table-signal
        class="sc-result"
        [tableModel]="m"
        [tableOptions]="options"
        [debounceMouseClickDelay]="0"
        [(tableApi)]="api"
        (focusChanged)="onFocus()"
        (selectionChanged)="onSelection()"
        (columnResizeEnd)="onResized($event)"
        (columnMoveEnd)="onMoved($event)"
        (mouseClicked)="onMouse($event)"
      />
    } @else {
      <p class="message">{{ t.loadingRows }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
      min-height: 0;
      height: 100%;
    }
    guiexpert-table-signal {
      display: block;
      height: 100%;
    }
    .message {
      margin: 0;
      padding: 12px 16px;
      color: var(--text-dim);
    }
  `,
})
export class ResultGrid implements OnDestroy, ResultGridHandle {
  protected readonly t = RESULTS_TEXTS;
  /** The result to show. */
  readonly result = input.required<ResultRef>();
  /** How many rows it has by now (it grows while the statement runs). */
  readonly rows = input.required<number>();
  /** Fetches rows `from..from + count` of a result. */
  readonly fetch =
    input.required<(resultId: number, from: number, count: number) => Promise<RowWindow>>();

  /**
   * Rows that live in the page instead of the result store (the lists of the object details): the grid
   * copies its selection itself, and the actions for results leave it alone.
   */
  readonly local = input<RowWindow | null>(null);
  /** The sort keys to mark in the heads; read when a result is shown (prompt 027). */
  readonly marks = input<readonly { column: number; desc: boolean; rank: number }[]>([]);
  /** A head was clicked: the column of the result, and whether a modifier asks to add it to the keys. */
  readonly headClick = output<{ readonly column: number; readonly additive: boolean }>();
  /** The cell the cursor is on: `[row, column]`; `null` when a new result has none yet (prompt 026). */
  readonly active = output<readonly [number, number] | null>();
  /** Which columns are shown, where, and how wide (prompt 029). */
  readonly layout = input<ColumnLayout>(EMPTY_LAYOUT);
  /** The user dragged a column or its edge. */
  readonly layoutChange = output<ColumnLayout>();
  /** The cells a search found. */
  readonly hits = input<HitMarks | null>(null);
  /** Changes to cells that are not written yet: shown instead of what was read (prompt 031). */
  readonly edits = input<EditMarks | null>(null);
  /** A cell was double-clicked: edit it. */
  readonly editCell = output<void>();
  /** Text was pasted into the grid (`Mod+V`): a block of cells for the table (prompt 032). */
  readonly pasted = output<string>();
  /** The columns of the result whose cells are links to another table (prompt 030). */
  readonly links = input<ReadonlySet<number> | null>(null);
  /** A link was clicked with `Ctrl`/`Cmd`: follow it. */
  readonly follow = output<void>();

  protected readonly settings = inject(SettingsService);
  private readonly copier = inject(CopyService);
  private readonly stats = inject(StatsService);
  private readonly menus = inject(MenuService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /**
   * The height of a row. Read on its own: the table is built anew for another height, and must not be for
   * any other setting (cursor and scroll position would be gone).
   */
  private readonly rowHeight = computed(() => this.settings.settings().resultRowHeight);
  /** Ends telling the copy service what is selected here. */
  private unregister: (() => void) | null = null;
  /** The options of the table on screen; a new result (or row height) gets new ones. */
  protected options = resultOptions();
  /** A new result is a new model: the table starts over. `null` while its first rows are read. */
  protected readonly model = signal<TableModelIf | null>(null);
  protected readonly api = signal<TableApi | undefined>(undefined);
  private body: WindowAreaModel | null = null;
  /** The result whose figures the status line may show. */
  private shownId = -1;
  /** Counts the results shown, so the first rows of an older one are dropped. */
  private generation = 0;

  constructor() {
    effect(() => {
      const result = this.result();
      // the row height is part of the table: another one builds it again
      void this.rowHeight();
      untracked(() => void this.show(result));
    });
    effect(() => {
      const rows = this.rows();
      const api = this.api();
      const body = this.body;
      if (!body || !this.model()) return;
      if (rows === body.resultRows()) return;
      body.setRowCount(rows);
      // the row count changed: the scroll bar and the visible rows follow, the position stays
      api?.repaintHard();
    });
    effect(() => {
      // another layout for the result on screen: the same rows in a new table
      const layout = this.layout();
      if (!this.model() || !this.body) return;
      untracked(() => this.relayout(layout));
    });
    effect(() => {
      const hits = this.hits();
      if (!this.model()) return;
      this.body?.setHits(hits);
      this.api()?.repaint();
    });
    effect(() => {
      const edits = this.edits();
      const body = this.body;
      if (!this.model() || !body) return;
      const before = body.getRowCount();
      body.setEdits(edits, EDIT_TEXTS.marked);
      // new rows below the table (or fewer of them): the scroll bar follows
      if (body.getRowCount() === before) this.api()?.repaint();
      else this.api()?.repaintHard();
    });
    effect(() => {
      const links = this.links();
      if (!this.model()) return;
      this.body?.setLinks(links);
      this.api()?.repaint();
    });
    effect(() => {
      // a table built for a new layout starts at the top: back to the row that was first
      const api = this.api();
      const row = this.backTo;
      if (!api || row === null || !this.model()) return;
      this.backTo = null;
      setTimeout(() => {
        if (this.api() === api) api.scrollToIndex(-1, row);
      });
    });
    effect(() => {
      const format = this.format();
      if (!this.model()) return;
      this.body?.setFormat(format);
      this.api()?.repaint();
    });
  }

  private format(): CellFormat {
    const s = this.settings.settings();
    if (this.local()) return { groupDigits: false, plain: true };
    return { groupDigits: s.groupDigits, nullText: s.nullText };
  }

  /** `Mod+C` in the grid: the selection, tab-separated. */
  protected onCopy(event: ClipboardEvent): void {
    event.preventDefault();
    const local = this.local();
    if (local) {
      const selection = this.options.getSelectionModel?.();
      const chosen = selectionOf(
        selection?.getRanges() ?? [],
        selection?.isAllSelected() ?? false,
        this.result().columns.length,
      );
      void this.copier.copyText(localTsv(local, chosen));
      return;
    }
    void this.copier.copy();
  }

  /** `Mod+V` in the grid: what is on the clipboard goes to the table as a block of cells. */
  protected onPaste(event: ClipboardEvent): void {
    if (this.local()) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    event.preventDefault();
    if (text !== '') this.pasted.emit(text);
  }

  /** A double click on a cell of the body edits it (the click before it has put the cursor there). */
  protected onDoubleClick(event: MouseEvent): void {
    // not on a head (that fits the width) and not on a row number
    if (this.local() || (event.target as HTMLElement).closest('.sc-head, .sc-rownum')) return;
    if (this.cursor()) this.editCell.emit();
  }

  /** What can be done with the selection and the result (prompt 018). */
  protected onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    if (this.local()) return;
    this.openMenu(event.clientX, event.clientY);
  }

  /** `Shift+F10` or the menu key: the same menu, at the top left of the grid. */
  protected onKey(event: KeyboardEvent): void {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    if (this.local()) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = this.host.nativeElement.getBoundingClientRect();
    this.openMenu(rect.left + 48, rect.top + 32);
  }

  private openMenu(x: number, y: number): void {
    const before = document.activeElement as HTMLElement | null;
    this.menus.openContext(RESULT_MENU, x, y, () => {
      if (before?.isConnected) before.focus();
    });
  }

  ngOnDestroy(): void {
    this.unregister?.();
    this.stats.forget(this.shownId);
    this.generation++;
    this.body?.dispose();
  }

  /** A click on a head sorts (grid column 0 is the row number: it sorts nothing). */
  protected onMouse(event: {
    areaIdent?: string;
    columnIndex: number;
    originalEvent?: MouseEvent;
  }): void {
    if (event.columnIndex < 1 || this.local()) return;
    const column = this.body?.resultColumn(event.columnIndex) ?? -1;
    if (column < 0) return;
    const e = event.originalEvent;
    if (event.areaIdent === 'body') {
      // Ctrl/Cmd+click on a cell of a foreign key follows it (the click has put the cursor there)
      if (e && (e.metaKey || e.ctrlKey) && this.links()?.has(column)) {
        setTimeout(() => this.follow.emit());
      }
      return;
    }
    if (event.areaIdent !== 'header') return;
    this.headClick.emit({
      column,
      additive: !!e && (e.shiftKey || e.metaKey || e.ctrlKey),
    });
  }

  /** The cursor of the table moved (the table says so outside of Angular's turn: only an output here). */
  protected onFocus(): void {
    const cell = this.api()?.getActiveCell();
    if (cell && cell[1] >= 1) this.lastColumn = cell[1];
    this.active.emit(this.cursor());
  }

  /** The grid column the cursor was in last: where it goes back to when only a row is asked for. */
  private lastColumn = 1;

  /** The cell the cursor is on: its row and its column of the result. */
  cursor(): readonly [number, number] | null {
    const cell = this.api()?.getActiveCell();
    // grid column 0 is the row number: it has no value of the result
    const column = cell ? (this.body?.resultColumn(cell[1]) ?? -1) : -1;
    return cell && column >= 0 ? [cell[0], column] : null;
  }

  /**
   * Puts the cursor on a cell and brings it into view (prompt 029). `column`: of the result; a hidden one
   * or `null` keeps the column the cursor is in.
   */
  goTo(row: number, column: number | null): void {
    const api = this.api();
    const body = this.body;
    if (!api || !body || body.getRowCount() === 0) return;
    const at = column === null ? -1 : this.resolved.shown.indexOf(column);
    const col = at >= 0 ? at + 1 : Math.max(1, api.getActiveCell()?.[1] ?? this.lastColumn);
    const r = Math.max(0, Math.min(row, body.getRowCount() - 1));
    this.options.getFocusModel?.()?.setFocus(r, col);
    const selection = this.options.getSelectionModel?.();
    selection?.clear();
    selection?.addSelection(CellRange.singleCell(r, col));
    api.ensureRowIsVisible(r);
    api.ensureColumnIsVisible(col);
    api.repaint();
    this.onFocus();
    this.onSelection();
  }

  /** Gives the keyboard to the grid. */
  focusGrid(): void {
    this.host.nativeElement.querySelector<HTMLElement>('.ge-table')?.focus();
  }

  /** Fits every column to what it shows and remembers the widths. */
  fitWidths(): void {
    const api = this.api();
    if (!api) return;
    const keys = columnKeys(this.result().columns);
    let layout = this.layout();
    this.resolved.shown.forEach((c, i) => {
      const width = api.autoResizeColumn(i + 1);
      if (width !== undefined) layout = setWidth(layout, keys[c], width);
    });
    this.keep(layout);
  }

  /** A layout the table shows already (the user dragged): told, but not built again. */
  private keep(layout: ColumnLayout): void {
    this.resolved = resolveLayout(layout, this.result().columns);
    this.layoutChange.emit(layout);
  }

  protected onResized(event: GeColumnResizeEvent): void {
    if (event.type !== 'end' || this.local()) return;
    const column = this.body?.resultColumn(event.columnIndex) ?? -1;
    if (column < 0) return;
    this.keep(setWidth(this.layout(), columnKeys(this.result().columns)[column], event.newWidth));
  }

  protected onMoved(event: GeColumnMoveEvent): void {
    if (!event.moved || this.local()) return;
    const keys = columnKeys(this.result().columns);
    const order = event.columnOrder
      .map((p) => /^c(\d+)$/.exec(p)?.[1])
      .filter((c): c is string => c !== undefined)
      .map((c) => keys[Number(c)]);
    // the table moved its columns itself; the new table is built from the layout
    this.layoutChange.emit(reorder(this.layout(), this.result().columns, order));
  }

  /** What the table on screen was built for. */
  private resolved: ResolvedLayout = { shown: [], pinned: 0, widths: [] };
  /** The first rows of the result: the widths are measured on them. */
  private first: RowWindow = [];
  /** The row to scroll back to once the next table stands. */
  private backTo: number | null = null;

  private relayout(layout: ColumnLayout): void {
    const result = this.result();
    const next = resolveLayout(layout, result.columns);
    if (JSON.stringify(next) === JSON.stringify(this.resolved)) return;
    const body = this.body;
    if (!body) return;
    this.backTo = this.api()?.getFirstVisibleRowIndex() ?? null;
    this.resolved = next;
    body.setShown(next.shown);
    this.options.getSelectionModel?.()?.clear();
    this.stats.forget(this.shownId);
    this.active.emit(null);
    this.model.set(
      resultModel(
        result.columns,
        this.first,
        body,
        Math.max(this.rows(), 1000),
        this.options,
        this.marks(),
        next,
      ),
    );
  }

  /** The selection of the table as columns of the result: what is shown, in the order shown. */
  private chosen(): CopySelection {
    const selection = this.options.getSelectionModel?.();
    const shown = this.resolved.shown;
    const raw = selectionOf(
      selection?.getRanges() ?? [],
      selection?.isAllSelected() ?? false,
      shown.length,
    );
    const plain = shown.length === this.result().columns.length && shown.every((c, i) => c === i);
    return {
      rows: raw.rows,
      columns: raw.columns.length > 0 ? raw.columns.map((c) => shown[c]) : plain ? [] : [...shown],
    };
  }

  /** What is marked changed: the status line shows its figures (prompt 028). */
  protected onSelection(): void {
    if (this.local()) return;
    const result = this.result();
    const selection = this.options.getSelectionModel?.();
    const ranges = selection?.getRanges() ?? [];
    const all = selection?.isAllSelected() ?? false;
    this.stats.selectionChanged(
      result.resultId,
      this.chosen(),
      this.rows(),
      result.columns.length,
      all || ranges.length > 0,
    );
  }

  private async show(result: ResultRef): Promise<void> {
    const generation = ++this.generation;
    this.stats.forget(this.shownId);
    this.shownId = result.resultId;
    this.active.emit(null);
    this.unregister?.();
    const rowHeight = untracked(() => this.rowHeight());
    this.body?.dispose();
    this.body = null;
    this.model.set(null);
    this.options = resultOptions(rowHeight);
    const selection = this.options.getSelectionModel?.();
    selection?.clear();
    // rows in the page are no result of the store: the copy actions do not know them
    this.unregister = untracked(() => this.local())
      ? null
      : this.copier.register(result.resultId, () => this.chosen());
    const fetch = this.fetch();
    let first: RowWindow = [];
    try {
      // the first rows decide the column widths; a statement that just started may have none yet
      first = await fetch(result.resultId, 0, PAGE_ROWS);
    } catch {
      // the result is gone already: an empty table with its header
    }
    if (generation !== this.generation) return;
    this.first = first;
    this.backTo = null;
    this.resolved = resolveLayout(
      untracked(() => this.layout()),
      result.columns,
    );
    const body = new WindowAreaModel(
      (from, count) => fetch(result.resultId, from, count),
      () => this.api()?.repaint(),
      // a short first page is read again when more rows arrive
      first,
      result.columns,
    );
    body.rowHeight = rowHeight;
    body.setFormat(untracked(() => this.format()));
    body.setShown(this.resolved.shown);
    body.setHits(untracked(() => this.hits()));
    body.setLinks(untracked(() => this.links()));
    body.setEdits(
      untracked(() => this.edits()),
      EDIT_TEXTS.marked,
    );
    const rows = untracked(() => this.rows());
    body.setRowCount(Math.max(rows, first.length));
    this.body = body;
    this.model.set(
      resultModel(
        result.columns,
        first,
        body,
        Math.max(rows, 1000),
        this.options,
        untracked(() => this.marks()),
        this.resolved,
      ),
    );
  }
}
