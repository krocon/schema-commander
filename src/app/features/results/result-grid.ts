import { Component, OnDestroy, effect, inject, input, signal, untracked } from '@angular/core';
import { TableSignalComponent } from '@guiexpert/angular-table';
import { TableApi, TableModelIf } from '@guiexpert/table';
import { ResultRef, RowWindow } from '../../core/sql/query.models';
import { SettingsService } from '../../core/settings/settings.service';
import { CellFormat } from './cell-format';
import { selectionOf } from './copy-logic';
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

  protected readonly settings = inject(SettingsService);
  private readonly copier = inject(CopyService);
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
    return { groupDigits: s.groupDigits, nullText: s.nullText };
  }

  /** `Mod+C` in the grid: the selection, tab-separated. */
  protected onCopy(event: ClipboardEvent): void {
    event.preventDefault();
    void this.copier.copy();
  }

  protected onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    this.copier.openMenu(event.clientX, event.clientY);
  }

  ngOnDestroy(): void {
    this.unregister?.();
    this.generation++;
    this.body?.dispose();
  }

  private async show(result: ResultRef): Promise<void> {
    const generation = ++this.generation;
    this.unregister?.();
    const rowHeight = untracked(() => this.settings.settings().resultRowHeight);
    this.body?.dispose();
    this.body = null;
    this.model.set(null);
    this.options = resultOptions(rowHeight);
    const selection = this.options.getSelectionModel?.();
    selection?.clear();
    this.unregister = this.copier.register(result.resultId, () =>
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
    this.model.set(resultModel(result.columns, first, body, Math.max(rows, 1000), this.options));
  }
}
