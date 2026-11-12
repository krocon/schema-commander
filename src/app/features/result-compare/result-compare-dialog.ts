import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { describeError } from '../../core/errors/app-error';
import { locale } from '../../core/i18n/i18n';
import { QueryApi } from '../../core/sql/query-api';
import { ColumnPairing } from '../../core/sql/query.models';
import { Shown } from '../tabs/result-tabs-logic';
import { CompareChoice, MAX_DECIMALS, choiceProblem } from './compare-view-logic';
import { COMPARE_TEXTS } from './compare-texts';
import { CompareRequest, ResultCompareService } from './result-compare.service';

/**
 * Which two results of a tab to compare, and how (prompt 041): the key columns or the position, columns
 * to leave out, and what counts as equal. The comparison runs in the backend; while it does, the dialog
 * shows how far it is and can stop it.
 */
@Component({
  selector: 'app-result-compare-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="rc-title" (cancel)="$event.preventDefault(); close()">
      <h2 id="rc-title">{{ t.title }}</h2>
      <form (submit)="$event.preventDefault(); go()">
        <div class="sides">
          <label for="rc-left">{{ t.left }}</label>
          <select #l id="rc-left" [disabled]="busy()" (change)="left.set(pick(l.value))">
            @for (c of results(); track c.target) {
              <option [value]="c.target" [selected]="c.target === left()">
                {{ c.title }} – {{ t.rowsOf(number(c.rows)) }}
              </option>
            }
          </select>
          <label for="rc-right">{{ t.right }}</label>
          <select #r id="rc-right" [disabled]="busy()" (change)="right.set(pick(r.value))">
            @for (c of results(); track c.target) {
              <option [value]="c.target" [selected]="c.target === right()">
                {{ c.title }} – {{ t.rowsOf(number(c.rows)) }}
              </option>
            }
          </select>
        </div>
        <fieldset [disabled]="busy()">
          <legend>{{ t.match }}</legend>
          <label>
            <input
              type="radio"
              name="rc-match"
              [checked]="choice().byKey"
              (change)="set({ byKey: true })"
            />
            {{ t.byKey }}
          </label>
          <label>
            <input
              type="radio"
              name="rc-match"
              [checked]="!choice().byKey"
              (change)="set({ byKey: false })"
            />
            {{ t.byPosition }}
          </label>
        </fieldset>
        <div class="columns" [attr.aria-busy]="pairing() === null">
          <table>
            <caption class="sr">
              {{
                t.columns
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">{{ t.column }}</th>
                <th scope="col">{{ t.keys }}</th>
                <th scope="col">{{ t.ignore }}</th>
              </tr>
            </thead>
            <tbody>
              @for (c of columns(); track c.index) {
                <tr>
                  <th scope="row">{{ c.name }}</th>
                  <td>
                    <input
                      type="checkbox"
                      [attr.aria-label]="t.keys + ': ' + c.name"
                      [disabled]="busy() || !choice().byKey"
                      [checked]="choice().byKey && choice().keys.includes(c.index)"
                      (change)="toggle('keys', c.index)"
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      [attr.aria-label]="t.ignore + ': ' + c.name"
                      [disabled]="busy() || (choice().byKey && choice().keys.includes(c.index))"
                      [checked]="choice().ignore.includes(c.index)"
                      (change)="toggle('ignore', c.index)"
                    />
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (pairing(); as p) {
          @if (p.byPosition) {
            <p class="note">{{ t.pairedByPosition }}</p>
          }
          @if (p.leftOnly.length > 0) {
            <p class="note">{{ t.leftColumnsOnly(p.leftOnly.join(', ')) }}</p>
          }
          @if (p.rightOnly.length > 0) {
            <p class="note">{{ t.rightColumnsOnly(p.rightOnly.join(', ')) }}</p>
          }
        }
        <fieldset [disabled]="busy()">
          <legend>{{ t.tolerances }}</legend>
          <label>
            <input
              #trim
              type="checkbox"
              [checked]="choice().trim"
              (change)="set({ trim: trim.checked })"
            />
            {{ t.trim }}
          </label>
          <label>
            <input
              #ic
              type="checkbox"
              [checked]="choice().ignoreCase"
              (change)="set({ ignoreCase: ic.checked })"
            />
            {{ t.ignoreCase }}
          </label>
          <label>
            <input
              #round
              type="checkbox"
              [checked]="choice().round"
              (change)="set({ round: round.checked })"
            />
            {{ t.round }}
            <input
              #dec
              class="decimals"
              type="number"
              min="0"
              [max]="maxDecimals"
              [attr.aria-label]="t.decimalsLabel"
              [disabled]="!choice().round"
              [value]="choice().decimals"
              (input)="set({ decimals: +dec.value })"
            />
            {{ t.decimals }}
          </label>
        </fieldset>
        <p class="status" role="status">
          @if (progress(); as p) {
            {{ p }}
          } @else if (failure()) {
            <span class="error">{{ failure() }}</span>
          } @else if (problem(); as why) {
            {{ t.problems[why] }}
          }
        </p>
        <div class="buttons">
          @if (busy()) {
            <button type="button" (click)="request().tab.cancelCompare()">{{ t.stop }}</button>
          } @else {
            <button type="button" (click)="close()">{{ t.cancel }}</button>
            <button type="submit" class="primary" [disabled]="problem() !== null">
              {{ t.compare }}
            </button>
          }
        </div>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(620px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      padding: 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog[open] {
      display: flex;
      flex-direction: column;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 35%);
    }
    h2 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    form {
      display: flex;
      flex-direction: column;
      min-height: 0;
      gap: 8px;
    }
    .sides {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 6px 12px;
      align-items: center;
    }
    fieldset {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin: 0;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    legend {
      padding: 0 4px;
      color: var(--text-dim);
      font-size: 12px;
    }
    label {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .columns {
      flex: 1;
      min-height: 80px;
      max-height: 220px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th,
    td {
      padding: 2px 8px;
      text-align: left;
      font-weight: normal;
    }
    thead th {
      position: sticky;
      top: 0;
      background: var(--bg-panel);
      color: var(--text-dim);
    }
    td {
      width: 90px;
    }
    .decimals {
      width: 56px;
    }
    .note,
    .status {
      margin: 0;
      color: var(--text-dim);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .status {
      min-height: 16px;
    }
    .error {
      color: var(--danger);
    }
    .buttons {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    button {
      padding: 4px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-text);
    }
    button:disabled {
      opacity: 0.5;
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class ResultCompareDialog {
  readonly request = input.required<CompareRequest>();
  readonly closed = output<void>();

  private readonly service = inject(ResultCompareService);
  private readonly api = inject(QueryApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly t = COMPARE_TEXTS;
  protected readonly maxDecimals = MAX_DECIMALS;

  /** The results of the tab that can be compared, as they were when the dialog opened. */
  protected readonly results = computed(() => this.request().tab.comparable());
  protected readonly left = signal<Shown | null>(null);
  protected readonly right = signal<Shown | null>(null);
  /** Which columns go together; `null` while that is asked. */
  protected readonly pairing = signal<ColumnPairing | null>(null);
  protected readonly failure = signal('');
  protected readonly choice = signal<CompareChoice>({
    byKey: true,
    keys: [],
    ignore: [],
    trim: false,
    ignoreCase: false,
    round: false,
    decimals: 2,
  });
  private asked = 0;

  private readonly sides = computed(() => {
    const all = this.results();
    const l = all.find((c) => c.target === this.left());
    const r = all.find((c) => c.target === this.right());
    return l && r ? { l, r } : null;
  });
  /** The columns of the left result that have a partner on the right. */
  protected readonly columns = computed(() => {
    const sides = this.sides();
    const pairing = this.pairing();
    if (!sides || !pairing) return [];
    return pairing.pairs.map(([index]) => ({
      index,
      name: sides.l.result.columns[index]?.name ?? '',
    }));
  });
  protected readonly busy = computed(() => this.request().tab.comparing() !== null);
  protected readonly progress = computed(() => {
    const p = this.request().tab.comparing();
    if (!p) return '';
    return this.t.progress(p.of > 0 ? Math.min(100, Math.floor((p.done * 100) / p.of)) : 0);
  });
  protected readonly problem = computed(() => {
    const sides = this.sides();
    return choiceProblem(
      this.choice(),
      this.pairing(),
      !sides || sides.l.result.resultId === sides.r.result.resultId,
    );
  });

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    effect(() => {
      const request = this.request();
      untracked(() => {
        this.left.set(request.left);
        this.right.set(request.right);
        const before = this.service.recalled(request.tab);
        if (before) {
          this.choice.update((c) => ({
            ...c,
            byKey: before.byKey,
            trim: before.trim,
            ignoreCase: before.ignoreCase,
            round: before.round,
            decimals: before.decimals,
          }));
        }
      });
    });
    effect(() => {
      // two other results: which of their columns go together is asked anew
      const sides = this.sides();
      untracked(() => void this.pair(sides));
    });
  }

  private async pair(sides: ReturnType<typeof this.sides>): Promise<void> {
    const asked = ++this.asked;
    this.pairing.set(null);
    this.failure.set('');
    if (!sides) return;
    try {
      const pairing = await this.api.compareColumns(
        sides.l.result.resultId,
        sides.r.result.resultId,
      );
      if (asked !== this.asked) return;
      this.pairing.set(pairing);
      const columns = sides.l.result.columns;
      const before = this.service.recalled(this.request().tab);
      const keys = this.service.suggest(pairing, columns, before?.keys ?? []);
      const ignore = pairing.pairs
        .map((p) => p[0])
        .filter((c) => before?.ignore.includes(columns[c]?.name.toLowerCase() ?? ''));
      this.choice.update((c) => ({ ...c, keys, ignore }));
    } catch (e) {
      if (asked === this.asked) this.failure.set(describeError(e));
    }
  }

  protected pick(value: string): Shown {
    return /^\d+$/.test(value) ? Number(value) : (value as Shown);
  }

  protected number(n: number): string {
    return n.toLocaleString(locale());
  }

  protected set(change: Partial<CompareChoice>): void {
    this.choice.update((c) => ({ ...c, ...change }));
  }

  protected toggle(list: 'keys' | 'ignore', column: number): void {
    this.choice.update((c) => {
      const now = c[list];
      const next = now.includes(column) ? now.filter((x) => x !== column) : [...now, column];
      return { ...c, [list]: next };
    });
  }

  protected async go(): Promise<void> {
    const sides = this.sides();
    if (!sides || this.problem() !== null || this.busy()) return;
    this.failure.set('');
    const tab = this.request().tab;
    const done = await this.service.run(
      tab,
      sides.l.target,
      sides.r.target,
      this.choice(),
      sides.l.result.columns.map((c) => c.name),
    );
    if (done) this.closed.emit();
    else this.failure.set(tab.compareProblem() ?? '');
  }

  protected close(): void {
    this.request().tab.cancelCompare();
    this.closed.emit();
  }
}
