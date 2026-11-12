import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { ClipboardApi } from '../../core/backend/clipboard-api';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SettingsService } from '../../core/settings/settings.service';
import { QueryApi } from '../../core/sql/query-api';
import { Cell, ResultRef } from '../../core/sql/query.models';
import { EditMarks } from '../edit/edit-buffer';
import { EditService } from '../edit/edit.service';
import { CopyService } from '../results/copy.service';
import { QueryTab } from '../tabs/query-tab';
import { ActiveCell } from '../value/value.service';
import {
  FieldFilter,
  NO_FILTER,
  filterFields,
  formFields,
  rowAsJson,
  rowAsList,
  rowFromText,
  selectedRows,
  stepRow,
  transposed,
} from './row-form-logic';
import { ROW_FORM_TEXTS } from './row-form-texts';

/**
 * One row of a result as a form (prompt 040): every column a line „name – value“. It follows the cursor
 * of the grid and moves it; marked rows can stand side by side with what differs between them. Editing
 * goes through the grid's cell and its buffer. Values are text, never markup.
 */
@Component({
  selector: 'app-row-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'region', '[attr.aria-label]': 't.title' },
  template: `
    <header>
      <div class="nav">
        <button
          type="button"
          [attr.aria-label]="t.first"
          [disabled]="!canStep()"
          (click)="step('first')"
        >
          ⏮
        </button>
        <button
          type="button"
          [attr.aria-label]="t.previous"
          [disabled]="!canStep()"
          (click)="step('prev')"
        >
          ◀
        </button>
        <span class="count" role="status">{{ heading() }}</span>
        <button
          type="button"
          [attr.aria-label]="t.next"
          [disabled]="!canStep()"
          (click)="step('next')"
        >
          ▶
        </button>
        <button
          type="button"
          [attr.aria-label]="t.last"
          [disabled]="!canStep()"
          (click)="step('last')"
        >
          ⏭
        </button>
        <input
          #go
          class="goto"
          type="text"
          inputmode="numeric"
          [attr.aria-label]="t.goTo"
          [placeholder]="t.goTo"
          (keydown.enter)="goTo(go.value); go.value = ''"
        />
      </div>
      <input
        #find
        type="search"
        spellcheck="false"
        [attr.aria-label]="t.filter"
        [placeholder]="t.filter"
        [value]="filter().text"
        (input)="setFilter({ text: find.value })"
      />
      <div class="checks">
        <label>
          <input
            #nn
            type="checkbox"
            [checked]="filter().nonNull"
            (change)="setFilter({ nonNull: nn.checked })"
          />
          {{ t.nonNull }}
        </label>
        <label>
          <input
            #ch
            type="checkbox"
            [checked]="filter().changed"
            (change)="setFilter({ changed: ch.checked })"
          />
          {{ t.changed }}
        </label>
        <label>
          <input
            #cmp
            type="checkbox"
            [checked]="compare()"
            [disabled]="marked().length < 2"
            (change)="compare.set(cmp.checked)"
          />
          {{ t.compare }}
        </label>
      </div>
    </header>
    @if (problem(); as p) {
      <p class="problem" role="alert">{{ p }}</p>
    } @else if (!cell()) {
      <p class="dim">{{ t.noRow }}</p>
    } @else if (comparing()) {
      <div class="body">
        <table>
          <thead>
            <tr>
              <th scope="col">{{ t.column }}</th>
              @for (row of comparedRows(); track row) {
                <th scope="col">{{ t.rowN(row + 1) }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (f of comparedShown(); track f.index) {
              <tr [class.differs]="f.differs">
                <th scope="row" [title]="f.typeName">{{ f.name }}</th>
                @for (v of f.values; track $index) {
                  <td [class]="v.cls">{{ v.text }}</td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <div class="body">
        <table>
          <thead>
            <tr>
              <th scope="col">{{ t.column }}</th>
              <th scope="col">{{ t.type }}</th>
              <th scope="col">{{ t.value }}</th>
            </tr>
          </thead>
          <tbody>
            @for (f of shown(); track f.index) {
              <tr [class.current]="f.index === cell()?.col" [class.changed]="f.changed">
                <th scope="row">
                  <button type="button" class="name" (click)="focusField(f.index)">
                    {{ f.name }}
                  </button>
                </th>
                <td class="type">{{ f.typeName }}</td>
                <td>
                  <span class="value" [class]="'value ' + f.shown.cls">{{ f.shown.text }}</span>
                  <span class="tools">
                    @if (f.long) {
                      <button
                        type="button"
                        class="link"
                        [attr.aria-label]="t.moreOf(f.name)"
                        (click)="more(f.index)"
                      >
                        {{ t.more }}
                      </button>
                    }
                    @if (editable()) {
                      <button
                        type="button"
                        class="link"
                        [attr.aria-label]="t.editOf(f.name)"
                        (click)="editField(f.index)"
                      >
                        {{ t.edit }}
                      </button>
                    }
                    <button
                      type="button"
                      class="link"
                      [attr.aria-label]="t.copyFieldOf(f.name)"
                      (click)="copyField(f.index)"
                    >
                      {{ t.copyField }}
                    </button>
                  </span>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
    <footer>
      <span class="status" role="status">{{ status() }}</span>
      <button type="button" [disabled]="!row()" (click)="copyRow('list')">{{ t.copyList }}</button>
      <button type="button" [disabled]="!row()" (click)="copyRow('json')">{{ t.copyJson }}</button>
    </footer>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      background: var(--bg-panel);
      border-left: 1px solid var(--border);
    }
    header {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
    }
    .nav,
    .checks,
    footer {
      display: flex;
      align-items: center;
      gap: 4px 8px;
      flex-wrap: wrap;
    }
    .count {
      flex: 1;
      text-align: center;
      white-space: nowrap;
    }
    .goto {
      width: 96px;
    }
    input[type='text'],
    input[type='search'] {
      padding: 2px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      color: var(--text);
      font: inherit;
      min-width: 0;
    }
    label {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      background: var(--bg-app);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    thead th {
      position: sticky;
      top: 0;
      padding: 2px 8px;
      background: var(--bg-panel);
      text-align: left;
    }
    tbody th,
    td {
      padding: 2px 8px;
      border-top: 1px solid var(--border);
      vertical-align: top;
      text-align: left;
      font-weight: normal;
    }
    tbody th {
      white-space: nowrap;
    }
    .name {
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--text);
      font: inherit;
      font-weight: 600;
    }
    .type {
      color: var(--text-dim);
      white-space: nowrap;
    }
    .value {
      display: block;
      max-height: 5.2em;
      overflow: hidden;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: var(--font-mono);
      user-select: text;
    }
    .sc-null,
    .sc-empty {
      color: var(--text-dim);
      font-style: italic;
    }
    .tools {
      display: flex;
      gap: 8px;
    }
    .link {
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--accent);
      font: inherit;
      font-size: 11px;
    }
    tr.current th .name {
      color: var(--accent);
    }
    tr.changed td,
    tr.differs td {
      background: var(--cell-changed-bg);
      color: var(--cell-changed-text);
    }
    td {
      font-family: var(--font-mono);
      overflow-wrap: anywhere;
    }
    .dim,
    .status {
      color: var(--text-dim);
    }
    .dim,
    .problem {
      margin: 0;
      padding: 8px;
    }
    .problem {
      color: var(--danger);
    }
    footer {
      padding: 4px 8px;
      border-top: 1px solid var(--border);
    }
    .status {
      flex: 1;
    }
  `,
})
export class RowForm {
  /** The cell the cursor of the grid is on. */
  readonly cell = input.required<ActiveCell | null>();
  readonly result = input.required<ResultRef>();
  /** Rows of the result. */
  readonly rows = input.required<number>();
  readonly tab = input.required<QueryTab>();
  /** What the edit buffer holds, where the result can be edited. */
  readonly edits = input<EditMarks | null>(null);

  private readonly api = inject(QueryApi);
  private readonly clipboard = inject(ClipboardApi);
  private readonly copier = inject(CopyService);
  private readonly edit = inject(EditService);
  private readonly settings = inject(SettingsService);

  protected readonly t = ROW_FORM_TEXTS;
  protected readonly filter = signal<FieldFilter>(NO_FILTER);
  protected readonly compare = signal(false);
  protected readonly row = signal<readonly Cell[] | null>(null);
  private readonly others = signal<readonly (readonly Cell[])[]>([]);
  protected readonly problem = signal<string | null>(null);
  private readonly note = signal('');
  /** Counts what was asked of the backend, so an older answer is dropped. */
  private asked = 0;

  private readonly format = computed(() => ({
    groupDigits: this.settings.settings().groupDigits,
  }));
  /** The rows marked in the grid, when there are several. */
  protected readonly marked = computed(() => {
    void this.cell();
    return selectedRows(this.copier.selection().rows);
  });
  protected readonly comparing = computed(() => this.compare() && this.marked().length >= 2);
  protected readonly comparedRows = computed(() => (this.comparing() ? this.marked() : []));
  protected readonly fields = computed(() => {
    const cell = this.cell();
    const edits = this.edits();
    return formFields(
      this.result().columns,
      this.row(),
      (column) => (cell && edits ? edits.at(cell.row, column) : null),
      this.format(),
    );
  });
  protected readonly shown = computed(() => filterFields(this.fields(), this.filter(), (f) => f));
  protected readonly comparedShown = computed(() =>
    filterFields(
      transposed(this.result().columns, this.others(), this.format()),
      this.filter(),
      (f) => ({
        isNull: f.isNull,
        // side by side, „changed“ means: not the same in every row
        changed: f.differs,
      }),
    ),
  );
  protected readonly editable = computed(() => this.edits() !== null);
  protected readonly canStep = computed(() => this.cell() !== null && this.rows() > 0);
  protected readonly heading = computed(() => {
    const cell = this.cell();
    if (this.comparing()) return this.t.comparing(this.marked().length);
    return cell ? this.t.rowOf(cell.row + 1, this.rows()) : '';
  });
  protected readonly status = computed(() => {
    const note = this.note();
    if (note) return note;
    const all = this.result().columns.length;
    const shown = this.comparing() ? this.comparedShown().length : this.shown().length;
    return this.row() && shown !== all ? this.t.shown(shown, all) : '';
  });

  constructor() {
    // the row under the cursor, again whenever the cursor moves to another row or result
    effect(() => {
      const cell = this.cell();
      const key = cell ? `${cell.resultId}:${cell.row}` : '';
      untracked(() => void this.load(key, cell));
    });
    effect(() => {
      const rows = this.comparedRows();
      const result = this.result().resultId;
      untracked(() => void this.loadOthers(result, rows));
    });
  }

  private lastKey = '';

  private async load(key: string, cell: ActiveCell | null): Promise<void> {
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.note.set('');
    const mine = ++this.asked;
    if (!cell) {
      this.row.set(null);
      return;
    }
    try {
      const window = await this.api.window(cell.resultId, cell.row, 1);
      if (mine !== this.asked) return;
      this.row.set(window[0] ?? null);
      this.problem.set(null);
    } catch (e) {
      if (mine !== this.asked) return;
      this.row.set(null);
      this.problem.set(this.t.failed(describeError(toAppError(e))));
    }
  }

  private async loadOthers(resultId: number, rows: readonly number[]): Promise<void> {
    if (rows.length === 0) {
      this.others.set([]);
      return;
    }
    try {
      const loaded = await Promise.all(rows.map((row) => this.api.window(resultId, row, 1)));
      if (this.comparedRows() === rows) this.others.set(loaded.map((w) => w[0] ?? []));
    } catch (e) {
      this.problem.set(this.t.failed(describeError(toAppError(e))));
    }
  }

  protected setFilter(change: Partial<FieldFilter>): void {
    this.filter.update((f) => ({ ...f, ...change }));
  }

  /** Moves the cursor of the grid to another row; the field stays. */
  protected step(to: 'first' | 'prev' | 'next' | 'last'): void {
    const cell = this.cell();
    if (cell) this.tab().grid?.goTo(stepRow(cell.row, to, this.rows()), cell.col);
  }

  protected goTo(text: string): void {
    const row = rowFromText(text, this.rows());
    if (row !== null) this.tab().grid?.goTo(row, this.cell()?.col ?? null);
  }

  protected focusField(column: number): void {
    const cell = this.cell();
    if (cell) this.tab().grid?.goTo(cell.row, column);
  }

  /** Shows all of a long value: the value panel takes the place of the form. */
  protected more(column: number): void {
    this.focusField(column);
    this.settings.update({ rowFormVisible: false, valuePanelVisible: true });
  }

  /** Edits the field as the grid edits its cell: one buffer for both. */
  protected editField(column: number): void {
    this.focusField(column);
    void this.edit.begin(this.tab());
  }

  private async copy(text: string): Promise<void> {
    try {
      await this.clipboard.copyText(text);
      this.note.set(this.t.copied);
    } catch (e) {
      this.note.set(describeError(toAppError(e)));
    }
  }

  protected async copyField(column: number): Promise<void> {
    const row = this.row();
    const name = this.result().columns[column];
    if (!row || !name) return;
    // the value alone, as text
    await this.copy(rowAsList([name], [row[column] ?? null]).slice(name.name.length + 2, -1));
  }

  protected async copyRow(as: 'list' | 'json'): Promise<void> {
    const row = this.row();
    if (!row) return;
    const columns = this.result().columns;
    await this.copy(as === 'json' ? rowAsJson(columns, row) : rowAsList(columns, row));
  }
}
