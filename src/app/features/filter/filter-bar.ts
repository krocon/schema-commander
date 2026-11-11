import { Component, computed, effect, input, signal, untracked } from '@angular/core';
import { language } from '../../core/i18n/i18n';
import { FilterOp, QueryColumn } from '../../core/sql/query.models';
import { QueryTab } from '../tabs/query-tab';
import {
  ConditionDraft,
  EMPTY_SPEC,
  LIMITS,
  OPS,
  conditionOf,
  draftOf,
  isFiltered,
  valuesOf,
} from './filter-logic';
import { FILTER_TEXTS } from './filter-texts';

const EMPTY_DRAFT: ConditionDraft = { column: '', op: 'eq', text: '', upper: '' };
/** A pause in typing after which the local filter is applied. */
const LOCAL_DELAY_MS = 350;

/**
 * The rows above a result for narrowing it (prompt 027). For the view of a table: conditions of column,
 * operator and value, a free condition, the limit – applied on the server (`Enter` or „Apply“). For any
 * result: a text filter over one or all columns, done in the store of the backend. Everything is a form
 * control with a name: the bar is used with the keyboard alone.
 */
@Component({
  selector: 'app-filter-bar',
  template: `
    @if (tab().tableView(); as view) {
      <form
        class="server"
        role="group"
        [attr.aria-label]="t.tableBar"
        (submit)="$event.preventDefault(); apply()"
      >
        @for (draft of drafts(); track $index) {
          @let n = $index + 1;
          <span class="condition">
            <select
              [attr.aria-label]="t.column(n)"
              (change)="edit($index, { column: $any($event.target).value })"
            >
              <option value="" [selected]="draft.column === ''">{{ t.chooseColumn }}</option>
              @for (column of columns(); track column.name) {
                <option [value]="column.name" [selected]="column.name === draft.column">
                  {{ column.name }}
                </option>
              }
            </select>
            <select
              [attr.aria-label]="t.operator(n)"
              (change)="edit($index, { op: $any($event.target).value })"
            >
              @for (o of ops; track o.op) {
                <option [value]="o.op" [selected]="o.op === draft.op">{{ t.ops[o.op] }}</option>
              }
            </select>
            @if (wants(draft.op) !== 0) {
              <input
                type="text"
                autocomplete="off"
                spellcheck="false"
                [attr.aria-label]="t.value(n)"
                [placeholder]="wants(draft.op) === 'many' ? t.listHint : ''"
                [value]="draft.text"
                (input)="edit($index, { text: $any($event.target).value })"
              />
            }
            @if (wants(draft.op) === 2) {
              <span class="word">{{ t.and }}</span>
              <input
                type="text"
                autocomplete="off"
                spellcheck="false"
                [attr.aria-label]="t.upper(n)"
                [value]="draft.upper"
                (input)="edit($index, { upper: $any($event.target).value })"
              />
            }
            <button
              type="button"
              class="x"
              [attr.aria-label]="t.remove(n)"
              (click)="remove($index)"
            >
              ×
            </button>
          </span>
        }
        <button type="button" (click)="add()">+ {{ t.add }}</button>
        @if (drafts().length > 1) {
          <select
            [attr.aria-label]="t.join"
            (change)="any.set($any($event.target).value === 'any')"
          >
            <option value="all" [selected]="!any()">{{ t.all }}</option>
            <option value="any" [selected]="any()">{{ t.any }}</option>
          </select>
        }
        <input
          type="text"
          class="where"
          autocomplete="off"
          spellcheck="false"
          [attr.aria-label]="t.where"
          [placeholder]="t.wherePlaceholder"
          [value]="where()"
          (input)="where.set($any($event.target).value)"
        />
        <select [attr.aria-label]="t.limit" (change)="setLimit($any($event.target).value)">
          @for (l of limits; track l) {
            <option [value]="l ?? 'all'" [selected]="l === limit()">
              {{ l === null ? t.allRows : t.rows(format(l)) }}
            </option>
          }
        </select>
        <button type="submit" class="primary">{{ t.apply }}</button>
        <button type="button" [disabled]="!filtered()" (click)="reset()">{{ t.reset }}</button>
        @if (filtered()) {
          <strong class="badge">{{ t.filtered }}</strong>
        }
      </form>
    }
    @if (showLocal()) {
      <div class="local" role="group" [attr.aria-label]="t.localBar">
        <select
          [attr.aria-label]="t.localColumn"
          (change)="setLocalColumn($any($event.target).value)"
        >
          <option value="" [selected]="tab().localSpec().column === null">
            {{ t.allColumns }}
          </option>
          @for (column of columns(); track $index) {
            <option [value]="$index" [selected]="$index === tab().localSpec().column">
              {{ column.name }}
            </option>
          }
        </select>
        <input
          type="search"
          autocomplete="off"
          spellcheck="false"
          [attr.aria-label]="t.localText"
          [placeholder]="t.localText"
          aria-describedby="filter-local-hint"
          [value]="localText()"
          (input)="onLocalText($any($event.target).value)"
          (keydown.enter)="applyLocalNow()"
        />
        <span class="count" role="status">
          @if (tab().viewBusy()) {
            {{ t.localWorking }}
          } @else if (tab().localView(); as v) {
            {{ t.localCount(format(v.rows), format(total())) }}
          }
        </span>
        @if (tab().localSpec().sort.length > 0) {
          <span class="word">{{ t.sortedLocally }}</span>
        }
        <button type="button" [disabled]="!localActive()" (click)="resetLocal()">
          {{ t.reset }}
        </button>
        @if (tab().viewProblem(); as p) {
          <span class="problem" role="alert">{{ p }}</span>
        }
        <span class="hint" id="filter-local-hint" [title]="t.localHint">ⓘ</span>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      flex: none;
    }
    :host:empty {
      display: none;
    }
    .server,
    .local {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 6px;
      padding: 4px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-panel);
      font-size: 12px;
    }
    .condition {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 2px 1px 4px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    input[type='text'] {
      width: 11em;
    }
    .where {
      flex: 1 1 12em;
      min-width: 8em;
      font-family: var(--font-mono);
    }
    input[type='search'] {
      flex: 0 1 18em;
    }
    .x {
      padding: 0 5px;
      border: none;
      background: transparent;
    }
    .word,
    .count,
    .hint {
      color: var(--text-dim);
    }
    .badge {
      color: var(--accent);
    }
    .problem {
      color: var(--error-fg);
    }
    .hint {
      cursor: help;
    }
  `,
})
export class FilterBar {
  protected readonly t = FILTER_TEXTS;
  protected readonly ops = OPS;
  protected readonly limits = LIMITS;
  protected readonly wants = valuesOf;

  readonly tab = input.required<QueryTab>();
  /** The columns of the result on screen. */
  readonly columns = input<readonly QueryColumn[]>([]);
  /** Rows of the result as the database gave it (for „12 of 3 400“). */
  readonly total = input(0);
  /** The row for the local filter is wanted (the setting), also while it filters nothing. */
  readonly local = input(false);

  protected readonly drafts = signal<readonly ConditionDraft[]>([]);
  protected readonly any = signal(false);
  protected readonly where = signal('');
  protected readonly limit = signal<number | null>(EMPTY_SPEC.limit);
  protected readonly localText = signal('');
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected readonly filtered = computed(() => {
    const view = this.tab().tableView();
    return !!view && isFiltered(view.spec);
  });
  protected readonly localActive = computed(
    () => this.tab().localView() !== null || this.tab().localSpec().sort.length > 0,
  );
  protected readonly showLocal = computed(
    () =>
      this.columns().length > 0 && (this.local() || this.localActive() || this.tab().viewBusy()),
  );

  constructor() {
    // the bar shows what the view is: also after a click on a head or a quick filter from a cell
    effect(() => {
      const spec = this.tab().tableView()?.spec;
      untracked(() => {
        if (!spec) return;
        this.drafts.set(spec.conditions.map(draftOf));
        this.any.set(spec.any);
        this.where.set(spec.whereSql);
        this.limit.set(spec.limit);
      });
    });
    effect(() => {
      const text = this.tab().localSpec().text;
      untracked(() => this.localText.set(text));
    });
  }

  protected format(n: number): string {
    return n.toLocaleString(language());
  }

  protected add(): void {
    this.drafts.update((all) => [...all, EMPTY_DRAFT]);
  }

  protected edit(index: number, change: Partial<ConditionDraft> & { op?: FilterOp }): void {
    this.drafts.update((all) => all.map((d, i) => (i === index ? { ...d, ...change } : d)));
  }

  protected remove(index: number): void {
    this.drafts.update((all) => all.filter((_, i) => i !== index));
    // a condition that is gone is gone from the result too
    this.apply();
  }

  protected setLimit(value: string): void {
    this.limit.set(value === 'all' ? null : Number(value));
    this.apply();
  }

  /** Reads the table again with what the bar holds; rows that are not complete are left out. */
  protected apply(): void {
    const view = this.tab().tableView();
    if (!view) return;
    const columns = this.columns();
    const conditions = this.drafts()
      .map((d) => conditionOf(d, columns))
      .filter((c) => c !== null);
    void this.tab().applyTable({
      conditions,
      any: this.any(),
      whereSql: this.where(),
      order: view.spec.order,
      limit: this.limit(),
    });
  }

  protected reset(): void {
    const view = this.tab().tableView();
    if (view) void this.tab().applyTable({ ...EMPTY_SPEC, limit: view.spec.limit });
  }

  protected setLocalColumn(value: string): void {
    const column = value === '' ? null : Number(value);
    void this.tab().setLocal({ ...this.tab().localSpec(), column });
  }

  protected onLocalText(text: string): void {
    this.localText.set(text);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.applyLocalNow(), LOCAL_DELAY_MS);
  }

  protected applyLocalNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const spec = this.tab().localSpec();
    if (spec.text === this.localText()) return;
    void this.tab().setLocal({ ...spec, text: this.localText() });
  }

  protected resetLocal(): void {
    if (this.timer) clearTimeout(this.timer);
    this.tab().dropLocal();
  }
}
