import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { QueryColumn } from '../../core/sql/query.models';
import { typeLabel } from '../results/cell-format';
import {
  ColumnLayout,
  ColumnRow,
  EMPTY_LAYOUT,
  columnRows,
  moveColumn,
  resolveLayout,
  setHidden,
  setPinned,
  showAll,
} from '../results/column-layout';
import { FIND_TEXTS } from './find-texts';

/**
 * The columns of a result as a list (prompt 029): show and hide them, keep them at the left, move them,
 * and go to one by its name – with 500 columns the only way to find one. Type a part of the name and
 * press `Enter`: the cursor of the grid is in that column. Every change shows at once.
 */
@Component({
  selector: 'app-columns-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // the keys of the list (a widget of its own): Alt+↑/↓ on a row moves its column
  host: { '(keydown)': 'onKey($event)' },
  template: `
    <dialog
      #dialog
      aria-labelledby="columns-title"
      (cancel)="$event.preventDefault(); closed.emit()"
    >
      <h2 id="columns-title">{{ t.columnsTitle }}</h2>
      <form class="filter" (submit)="$event.preventDefault(); jumpFirst()">
        <input
          #filter
          type="search"
          autocomplete="off"
          spellcheck="false"
          [attr.aria-label]="t.columnFilter"
          [placeholder]="t.columnFilter"
          (input)="needle.set(filter.value)"
        />
        <span class="count" role="status">{{ t.columnCount(shownCount(), columns().length) }}</span>
      </form>
      <p class="hint">{{ t.hint }}</p>
      <table [attr.aria-label]="t.columnList">
        <thead>
          <tr>
            <th scope="col">{{ t.columns }}</th>
            <th scope="col">{{ t.shown }}</th>
            <th scope="col">{{ t.pinned }}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.key) {
            <tr [attr.data-key]="row.key" [class.hidden]="row.hidden">
              <th scope="row">
                <button type="button" class="name" [title]="t.jump" (click)="jump.emit(row.index)">
                  {{ row.name }} <span class="type">{{ type(row.typeName) }}</span>
                </button>
              </th>
              <td>
                <input
                  type="checkbox"
                  [checked]="!row.hidden"
                  [attr.aria-label]="t.showColumn(row.name)"
                  (change)="change(hide(row, $any($event.target).checked))"
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  [checked]="row.pinned"
                  [attr.aria-label]="t.pinColumn(row.name)"
                  (change)="change(pin(row, $any($event.target).checked))"
                />
              </td>
              <td class="moves">
                <button
                  type="button"
                  [attr.aria-label]="t.moveUp(row.name)"
                  [title]="t.moveUp(row.name)"
                  (click)="move(row, -1)"
                >
                  ↑
                </button>
                <button
                  type="button"
                  [attr.aria-label]="t.moveDown(row.name)"
                  [title]="t.moveDown(row.name)"
                  (click)="move(row, 1)"
                >
                  ↓
                </button>
              </td>
            </tr>
          } @empty {
            <tr>
              <td colspan="4" class="none">{{ t.noColumns }}</td>
            </tr>
          }
        </tbody>
      </table>
      <footer>
        <button type="button" (click)="change(all())">{{ t.showAll }}</button>
        <button type="button" (click)="fit.emit()">{{ t.fit }}</button>
        <button type="button" (click)="change(empty)">{{ t.reset }}</button>
        <span class="spacer"></span>
        <button type="button" (click)="closed.emit()">{{ t.done }}</button>
      </footer>
    </dialog>
  `,
  styles: `
    dialog {
      display: flex;
      flex-direction: column;
      width: min(520px, calc(100vw - 32px));
      max-height: min(640px, calc(100vh - 32px));
      padding: 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog:not([open]) {
      display: none;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    h2 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    .filter {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .filter input {
      flex: 1;
    }
    .count,
    .hint,
    .type,
    .none {
      color: var(--text-dim);
      font-size: 12px;
    }
    .hint {
      margin: 6px 0;
    }
    table {
      display: block;
      flex: 1;
      min-height: 0;
      overflow: auto;
      border-collapse: collapse;
      font-size: 12px;
    }
    thead th {
      position: sticky;
      top: 0;
      background: var(--bg-panel);
      color: var(--text-dim);
      font-weight: 400;
    }
    th,
    td {
      padding: 2px 10px 2px 0;
      text-align: left;
      white-space: nowrap;
    }
    tbody th {
      width: 100%;
      font-weight: 400;
    }
    tr.hidden .name {
      color: var(--text-dim);
    }
    .name {
      max-width: 300px;
      padding: 1px 4px;
      border: 0;
      background: transparent;
      color: var(--text);
      font: inherit;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .name:hover {
      background: var(--bg-hover);
    }
    .moves button {
      padding: 0 6px;
    }
    footer {
      display: flex;
      gap: 6px;
      margin-top: 12px;
    }
    .spacer {
      flex: 1;
    }
  `,
})
export class ColumnsPopover {
  protected readonly t = FIND_TEXTS;
  protected readonly type = typeLabel;
  protected readonly empty = EMPTY_LAYOUT;

  readonly columns = input.required<readonly QueryColumn[]>();
  readonly layout = input.required<ColumnLayout>();
  readonly layoutChange = output<ColumnLayout>();
  /** Go to this column of the result (and close). */
  readonly jump = output<number>();
  readonly fit = output<void>();
  readonly closed = output<void>();

  protected readonly needle = signal('');
  protected readonly rows = computed(() =>
    columnRows(this.layout(), this.columns(), this.needle()),
  );
  protected readonly shownCount = computed(
    () => resolveLayout(this.layout(), this.columns()).shown.length,
  );
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly filter = viewChild.required<ElementRef<HTMLInputElement>>('filter');

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.filter().nativeElement.focus();
    });
  }

  protected change(layout: ColumnLayout): void {
    this.layoutChange.emit(layout);
  }

  protected hide(row: ColumnRow, shown: boolean): ColumnLayout {
    return setHidden(this.layout(), this.columns(), row.key, !shown);
  }

  protected pin(row: ColumnRow, pinned: boolean): ColumnLayout {
    return setPinned(this.layout(), this.columns(), row.key, pinned);
  }

  protected all(): ColumnLayout {
    return showAll(this.layout(), this.columns());
  }

  protected move(row: ColumnRow, step: -1 | 1): void {
    // a hidden column has no place among the shown ones: it shows up where it is moved
    const base = row.hidden
      ? setHidden(this.layout(), this.columns(), row.key, false)
      : this.layout();
    this.change(moveColumn(base, this.columns(), row.key, step));
  }

  /** `Enter` in the filter: the first column that matches. */
  protected jumpFirst(): void {
    const first = this.rows()[0];
    if (first) this.jump.emit(first.index);
  }

  /** `Alt+↑/↓` on a row moves its column; the keyboard stays on the control it was on. */
  protected onKey(event: KeyboardEvent): void {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    const target = event.target as HTMLElement;
    const tr = target.closest('tr');
    const key = tr?.getAttribute('data-key');
    const row = this.rows().find((r) => r.key === key);
    if (!row || !tr) return;
    event.preventDefault();
    const at = [...tr.querySelectorAll('button, input')].indexOf(target);
    this.move(row, event.key === 'ArrowUp' ? -1 : 1);
    setTimeout(() => {
      const again = this.dialog().nativeElement.querySelector(
        `tr[data-key="${CSS.escape(row.key)}"]`,
      );
      (again?.querySelectorAll<HTMLElement>('button, input')[at] ?? null)?.focus();
    });
  }
}
