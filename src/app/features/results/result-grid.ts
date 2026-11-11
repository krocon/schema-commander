import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { TableSignalComponent } from '@guiexpert/angular-table';
import { TableApi } from '@guiexpert/table';
import { QueryResult } from '../../core/sql/query.models';
import { RESULT_OPTIONS, resultModel } from './result-model';

/** The rows of a statement in a GuiExpert Table: virtual scrolling, sortable and resizable columns. */
@Component({
  selector: 'app-result-grid',
  imports: [TableSignalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <guiexpert-table-signal
      class="sc-result"
      [tableModel]="model()"
      [tableOptions]="options"
      [debounceMouseClickDelay]="0"
      [(tableApi)]="api"
    />
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
  `,
})
export class ResultGrid {
  readonly result = input.required<QueryResult>();

  protected readonly options = RESULT_OPTIONS;
  /** A new result is a new model: the table starts over (scroll position, sorting). */
  protected readonly model = computed(() => resultModel(this.result()));
  protected readonly api = signal<TableApi | undefined>(undefined);
}
