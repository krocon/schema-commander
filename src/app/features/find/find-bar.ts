import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { QueryColumn, SearchSpec } from '../../core/sql/query.models';
import { FIND_TEXTS } from './find-texts';
import { Hit, MAX_KEPT_HITS, ResultFind } from './result-find';

/** Typing searches this long after the last key. */
export const FIND_TYPING_MS = 200;

/** What stands on the three switches: signs, the same in every language. */
const SIGNS = { caseSensitive: 'Aa', wholeWord: '␣ab␣', regex: '.*' } as const;

/**
 * The search row above a result (prompt 029): a text, how it is compared, where – and the hits, one
 * after the other. Beside it the field for „go to row“. The search itself is the tab's (`ResultFind`);
 * this row only asks and shows. `Enter` goes to the next hit, `Shift+Enter` to the one before, `Esc` closes.
 */
@Component({
  selector: 'app-find-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form
      class="find"
      role="search"
      [attr.aria-label]="t.bar"
      (submit)="$event.preventDefault(); step(1)"
      (keydown)="onKey($event)"
    >
      <input
        #text
        type="search"
        class="text"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        [attr.aria-label]="t.field"
        [placeholder]="t.placeholder"
        [value]="find().spec().text"
        [attr.aria-invalid]="find().problem() ? 'true' : null"
        [attr.aria-describedby]="find().problem() ? 'find-problem' : null"
        (input)="typed(text.value)"
      />
      @for (s of switches; track s) {
        <button
          type="button"
          class="switch"
          [attr.aria-pressed]="find().spec()[s]"
          [attr.aria-label]="t[s]"
          [title]="t[s]"
          (click)="toggle(s)"
        >
          {{ signs[s] }}
        </button>
      }
      <select class="where" [attr.aria-label]="t.inColumn" (change)="inColumn(where.value)" #where>
        <option value="" [selected]="find().spec().columns.length === 0">{{ t.allColumns }}</option>
        @for (c of columns(); track $index) {
          <option [value]="$index" [selected]="find().spec().columns[0] === $index">
            {{ c.name }}
          </option>
        }
      </select>
      <span class="count" role="status">{{ count() }}</span>
      <button
        type="button"
        class="step"
        [attr.aria-label]="t.previous"
        [title]="t.previous"
        [disabled]="find().count() === 0"
        (click)="step(-1)"
      >
        ↑
      </button>
      <button
        type="submit"
        class="step"
        [attr.aria-label]="t.next"
        [title]="t.next"
        [disabled]="find().count() === 0"
      >
        ↓
      </button>
    </form>
    <form
      class="row"
      (submit)="$event.preventDefault(); toRow(row.value)"
      (keydown)="onKey($event)"
    >
      <label for="find-row">{{ t.row }}</label>
      <input
        #row
        id="find-row"
        type="number"
        min="1"
        step="1"
        [max]="rows()"
        [attr.aria-label]="t.goToRow"
      />
      <button type="submit">{{ t.go }}</button>
    </form>
    <button
      type="button"
      class="close"
      [attr.aria-label]="t.close"
      [title]="t.close"
      (click)="close()"
    >
      ×
    </button>
    @if (find().problem(); as p) {
      <p id="find-problem" class="problem">{{ p }}</p>
    } @else if (find().beyond() && !find().searching()) {
      <p class="note">{{ t.manyHits(kept) }}</p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 12px;
      padding: 4px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-panel);
      font-size: 12px;
    }
    form {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    .find {
      flex: 1 1 320px;
    }
    .text {
      flex: 1 1 140px;
      min-width: 80px;
    }
    .text[aria-invalid='true'] {
      border-color: var(--danger);
    }
    .switch,
    .step,
    .close {
      flex: none;
      min-width: 26px;
      padding: 1px 6px;
      font-family: var(--font-mono);
    }
    .switch[aria-pressed='true'] {
      background: var(--accent);
      color: var(--accent-text);
    }
    .where {
      flex: 0 1 140px;
      min-width: 60px;
    }
    .count {
      flex: none;
      min-width: 70px;
      color: var(--text-dim);
      white-space: nowrap;
    }
    .row input {
      width: 90px;
    }
    .close {
      margin-left: auto;
    }
    .problem,
    .note {
      flex-basis: 100%;
      margin: 0;
    }
    .problem {
      color: var(--danger);
    }
    .note {
      color: var(--text-dim);
    }
  `,
})
export class FindBar implements OnDestroy {
  protected readonly t = FIND_TEXTS;
  protected readonly signs = SIGNS;
  protected readonly switches = ['caseSensitive', 'wholeWord', 'regex'] as const;
  protected readonly kept = String(MAX_KEPT_HITS);

  readonly find = input.required<ResultFind>();
  /** The result on screen (a local view has an id of its own); `null` = none. */
  readonly resultId = input.required<number | null>();
  readonly rows = input.required<number>();
  readonly columns = input.required<readonly QueryColumn[]>();
  /** Where the cursor of the grid is: hits are counted from there. */
  readonly cursor = input.required<() => Hit | null>();
  /** Put the cursor on this cell. */
  readonly go = output<Hit>();
  /** Put the cursor into this row (counted from 0). */
  readonly goRow = output<number>();
  /** The row was closed: the keyboard goes back to the grid. */
  readonly closed = output<void>();

  private readonly text = viewChild.required<ElementRef<HTMLInputElement>>('text');
  private readonly row = viewChild.required<ElementRef<HTMLInputElement>>('row');
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected readonly count = computed(() => {
    const find = this.find();
    void find.version();
    if (find.problem() || find.spec().text === '') return '';
    const n = String(find.count());
    if (find.searching()) return this.t.counting(n);
    if (find.count() === 0) return this.t.none;
    const at = find.position();
    return at > 0 ? this.t.hitOf(String(at), n) : this.t.hits(n);
  });

  constructor() {
    effect(() => {
      const { field, n } = this.find().focus();
      if (n === 0) return;
      const el = (field === 'row' ? this.row() : this.text()).nativeElement;
      el.focus();
      el.select();
    });
    effect(() => {
      // another result (a new run, a local filter): the same search in it
      const id = this.resultId();
      const find = this.find();
      untracked(() => {
        if (id === null) find.reset();
        else if (find.spec().text !== '') void find.search(id, find.spec());
      });
    });
  }

  ngOnDestroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
  }

  private search(spec: SearchSpec, wait = 0): void {
    if (this.timer !== null) clearTimeout(this.timer);
    const find = this.find();
    find.spec.set(spec);
    this.timer = setTimeout(() => {
      this.timer = null;
      const id = this.resultId();
      if (id !== null) void find.search(id, spec);
    }, wait);
  }

  protected typed(text: string): void {
    this.search({ ...this.find().spec(), text }, FIND_TYPING_MS);
  }

  protected toggle(which: 'caseSensitive' | 'wholeWord' | 'regex'): void {
    const spec = this.find().spec();
    this.search({ ...spec, [which]: !spec[which] });
  }

  protected inColumn(value: string): void {
    this.search({ ...this.find().spec(), columns: value === '' ? [] : [Number(value)] });
  }

  protected step(direction: 1 | -1): void {
    const hit = this.find().step(this.cursor()(), direction);
    if (hit) this.go.emit(hit);
  }

  protected toRow(value: string): void {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) return;
    this.goRow.emit(Math.min(n, Math.max(1, this.rows())) - 1);
  }

  protected close(): void {
    this.find().close();
    this.closed.emit();
  }

  /** Keys of the search row (a widget of its own): `Esc` closes, `Shift+Enter` goes back a hit. */
  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    } else if (
      event.key === 'Enter' &&
      event.shiftKey &&
      (event.target as HTMLElement).classList.contains('text')
    ) {
      event.preventDefault();
      this.step(-1);
    }
  }
}
