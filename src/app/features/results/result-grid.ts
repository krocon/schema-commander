import { Component, OnDestroy, effect, input, signal, untracked } from '@angular/core';
import { TableSignalComponent } from '@guiexpert/angular-table';
import { TableApi, TableModelIf } from '@guiexpert/table';
import { ResultRef, RowWindow } from '../../core/sql/query.models';
import { PAGE_ROWS, RESULT_OPTIONS, WindowAreaModel, resultModel } from './result-model';

/**
 * The rows of a result in a GuiExpert Table (prompt 006). The rows live in the backend: the grid fetches the
 * pages it shows and follows the row count while the statement still reads.
 */
@Component({
  selector: 'app-result-grid',
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
      <p class="message">Zeilen werden geladen …</p>
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
  /** The result to show. */
  readonly result = input.required<ResultRef>();
  /** How many rows it has by now (it grows while the statement runs). */
  readonly rows = input.required<number>();
  /** Fetches rows `from..from + count` of a result. */
  readonly fetch =
    input.required<(resultId: number, from: number, count: number) => Promise<RowWindow>>();

  protected readonly options = RESULT_OPTIONS;
  /** A new result is a new model: the table starts over. `null` while its first rows are read. */
  protected readonly model = signal<TableModelIf | null>(null);
  protected readonly api = signal<TableApi | undefined>(undefined);
  private body: WindowAreaModel | null = null;
  /** Counts the results shown, so the first rows of an older one are dropped. */
  private generation = 0;

  constructor() {
    effect(() => {
      const result = this.result();
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
  }

  ngOnDestroy(): void {
    this.generation++;
    this.body?.dispose();
  }

  private async show(result: ResultRef): Promise<void> {
    const generation = ++this.generation;
    this.body?.dispose();
    this.body = null;
    this.model.set(null);
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
    );
    const rows = untracked(() => this.rows());
    body.setRowCount(Math.max(rows, first.length));
    this.body = body;
    this.model.set(resultModel(result.columns, first, body, Math.max(rows, 1000)));
  }
}
