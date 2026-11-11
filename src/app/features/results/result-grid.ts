import {
  Component,
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
import { TableApi, TableModelIf } from '@guiexpert/table';
import { ResultRef, RowWindow } from '../../core/sql/query.models';
import { SettingsService } from '../../core/settings/settings.service';
import { CellFormat } from './cell-format';
import { localTsv, selectionOf } from './copy-logic';
import { CopyService } from './copy.service';
import { PAGE_ROWS, WindowAreaModel, resultModel, resultOptions } from './result-model';
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
export class ResultGrid implements OnDestroy {
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

  protected readonly settings = inject(SettingsService);
  private readonly copier = inject(CopyService);
  private readonly menus = inject(MenuService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** Ends telling the copy service what is selected here. */
  private unregister: (() => void) | null = null;
  /** The options of the table on screen; a new result (or row height) gets new ones. */
  protected options = resultOptions();
  /** A new result is a new model: the table starts over. `null` while its first rows are read. */
  protected readonly model = signal<TableModelIf | null>(null);
  protected readonly api = signal<TableApi | undefined>(undefined);
  private body: WindowAreaModel | null = null;
  /** Counts the results shown, so the first rows of an older one are dropped. */
  private generation = 0;

  constructor() {
    effect(() => {
      const result = this.result();
      // the row height is part of the table: another one builds it again
      void this.settings.settings().resultRowHeight;
      untracked(() => void this.show(result));
    });
    effect(() => {
      const rows = this.rows();
      const api = this.api();
      const body = this.body;
      if (!body || !this.model()) return;
      if (rows === body.getRowCount()) return;
      body.setRowCount(rows);
      // the row count changed: the scroll bar and the visible rows follow, the position stays
      api?.repaintHard();
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
    this.generation++;
    this.body?.dispose();
  }

  /** A click on a head sorts (grid column 0 is the row number: it sorts nothing). */
  protected onMouse(event: {
    areaIdent?: string;
    columnIndex: number;
    originalEvent?: MouseEvent;
  }): void {
    if (event.areaIdent !== 'header' || event.columnIndex < 1 || this.local()) return;
    const e = event.originalEvent;
    this.headClick.emit({
      column: event.columnIndex - 1,
      additive: !!e && (e.shiftKey || e.metaKey || e.ctrlKey),
    });
  }

  /** The cursor of the table moved (the table says so outside of Angular's turn: only an output here). */
  protected onFocus(): void {
    const cell = this.api()?.getActiveCell();
    // grid column 0 is the row number: it has no value of the result
    this.active.emit(cell && cell[1] >= 1 ? [cell[0], cell[1] - 1] : null);
  }

  private async show(result: ResultRef): Promise<void> {
    const generation = ++this.generation;
    this.active.emit(null);
    this.unregister?.();
    const rowHeight = untracked(() => this.settings.settings().resultRowHeight);
    this.body?.dispose();
    this.body = null;
    this.model.set(null);
    this.options = resultOptions(rowHeight);
    const selection = this.options.getSelectionModel?.();
    selection?.clear();
    // rows in the page are no result of the store: the copy actions do not know them
    this.unregister = untracked(() => this.local())
      ? null
      : this.copier.register(result.resultId, () =>
          selectionOf(
            selection?.getRanges() ?? [],
            selection?.isAllSelected() ?? false,
            result.columns.length,
          ),
        );
    const fetch = this.fetch();
    let first: RowWindow = [];
    try {
      // the first rows decide the column widths; a statement that just started may have none yet
      first = await fetch(result.resultId, 0, PAGE_ROWS);
    } catch {
      // the result is gone already: an empty table with its header
    }
    if (generation !== this.generation) return;
    const body = new WindowAreaModel(
      (from, count) => fetch(result.resultId, from, count),
      () => this.api()?.repaint(),
      // a short first page is read again when more rows arrive
      first,
      result.columns,
    );
    body.rowHeight = rowHeight;
    body.setFormat(untracked(() => this.format()));
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
      ),
    );
  }
}
