import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { SettingsService } from '../../core/settings/settings.service';
import { showCell } from '../results/cell-format';
import { suggestTargets } from './relation-logic';
import { RELATION_TEXTS } from './relation-texts';
import { RelationItem, RelationsService } from './relations.service';

/**
 * What following a foreign key shows in a dialog (prompt 030): the list of keys to choose from (forward
 * when a cell belongs to several, backward always), a look at the row a key points to, and the form for
 * relations of the user's own. Values of the database are shown as text, never as markup.
 */
@Component({
  selector: 'app-relations-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      aria-labelledby="relations-title"
      (cancel)="$event.preventDefault(); relations.close()"
    >
      @if (relations.dialog(); as d) {
        @switch (d.kind) {
          @case ('list') {
            <h2 id="relations-title">
              {{ d.direction === 'forward' ? t.forwardTitle(d.table) : t.backwardTitle(d.table) }}
            </h2>
            <ul [attr.aria-label]="t.listLabel">
              @for (item of d.items; track $index) {
                <li>
                  <button
                    type="button"
                    class="target"
                    [disabled]="!item.view"
                    (click)="open(item, $event)"
                  >
                    {{ item.label }}
                    @if (item.key.name === '') {
                      <span class="tag">{{ t.own }}</span>
                    }
                  </button>
                  @if (!item.view) {
                    <span class="dim">{{ t.nothingThere }}</span>
                  } @else if (item.count === null) {
                    <button type="button" class="small" (click)="relations.count($index)">
                      {{ t.count }}
                    </button>
                  } @else {
                    <span class="dim" role="status">{{ countText(item) }}</span>
                  }
                </li>
              }
            </ul>
            <footer>
              <button type="button" (click)="relations.countAll()">{{ t.countAll }}</button>
              <span class="spacer"></span>
              <button type="button" (click)="relations.close()">{{ t.close }}</button>
            </footer>
          }
          @case ('peek') {
            <h2 id="relations-title">{{ t.peekTitle(d.title) }}</h2>
            @for (row of d.rows; track $index) {
              @if (d.rows.length > 1) {
                <h3>{{ t.rowN($index + 1) }}</h3>
              }
              <table>
                <tbody>
                  @for (c of d.columns; track $index) {
                    <tr>
                      <th scope="row">{{ c.name }}</th>
                      <td [class.dim]="row[$index] === null">
                        {{ cellText(row[$index], c.kind) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @empty {
              <p class="dim">{{ t.peekNone }}</p>
            }
            @if (d.more) {
              <p class="dim">{{ t.peekMore(d.rows.length) }}</p>
            }
            <footer>
              <button #first type="button" (click)="relations.openPeek('here')">
                {{ t.openHere }}
              </button>
              <button type="button" (click)="relations.openPeek('tab')">{{ t.openTab }}</button>
              <span class="spacer"></span>
              <button type="button" (click)="relations.close()">{{ t.close }}</button>
            </footer>
          }
          @case ('define') {
            <h2 id="relations-title">{{ t.defineTitle(d.table) }}</h2>
            <p class="dim">{{ t.defineIntro }}</p>
            <form class="define" (submit)="$event.preventDefault(); add()">
              <label for="rel-from">{{ t.fromColumn }}</label>
              <select id="rel-from" #from (change)="column.set(from.value)">
                @for (c of d.columns; track c) {
                  <option [value]="c" [selected]="c === (column() ?? d.column)">{{ c }}</option>
                }
              </select>
              <label for="rel-schema">{{ t.toSchema }}</label>
              <input
                id="rel-schema"
                #schema
                type="text"
                autocomplete="off"
                [placeholder]="d.schema"
              />
              <label for="rel-table">{{ t.toTable }}</label>
              <input id="rel-table" #table type="text" autocomplete="off" spellcheck="false" />
              <label for="rel-column">{{ t.toColumn }}</label>
              <input id="rel-column" #target type="text" autocomplete="off" spellcheck="false" />
              <span></span>
              <button type="submit">{{ t.add }}</button>
            </form>
            @if (problem()) {
              <p class="problem" role="alert">{{ t.missing }}</p>
            }
            @if (offers().length > 0) {
              <p class="offers">
                <span class="dim">{{ t.offers }}</span>
                @for (o of offers(); track $index) {
                  <button
                    type="button"
                    class="small"
                    (click)="table.value = o.table; target.value = o.column"
                  >
                    {{ o.table }}.{{ o.column }}
                  </button>
                }
              </p>
            }
            <h3>{{ t.yours }}</h3>
            <ul>
              @for (k of own(); track $index) {
                <li>
                  <span class="mono">{{ text(k) }}</span>
                  <button
                    type="button"
                    class="small"
                    [attr.aria-label]="t.remove(text(k))"
                    (click)="relations.removeVirtual(d.tab.connectionId(), k)"
                  >
                    ×
                  </button>
                </li>
              } @empty {
                <li class="dim">{{ t.noneYet }}</li>
              }
            </ul>
            <footer>
              <span class="spacer"></span>
              <button type="button" (click)="relations.close()">{{ t.close }}</button>
            </footer>
          }
        }
      }
    </dialog>
  `,
  styles: `
    dialog {
      width: min(520px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      padding: 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: auto;
      font-size: 12px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 45%);
    }
    h2 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    h3 {
      margin: 12px 0 4px;
      font-size: 12px;
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 2px 0;
    }
    .target {
      flex: 1;
      min-width: 0;
      padding: 3px 6px;
      border: 0;
      background: transparent;
      color: var(--text);
      font: inherit;
      font-family: var(--font-mono);
      text-align: left;
      overflow-wrap: anywhere;
    }
    .target:hover:not(:disabled),
    .target:focus-visible {
      background: var(--bg-hover);
    }
    .target:disabled {
      color: var(--text-dim);
    }
    .tag {
      margin-left: 6px;
      color: var(--text-dim);
      font-family: var(--font-ui, inherit);
      font-size: 11px;
    }
    .dim {
      color: var(--text-dim);
    }
    .small {
      padding: 1px 8px;
      font-size: 11px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      padding: 2px 10px 2px 0;
      text-align: left;
      vertical-align: baseline;
      border-bottom: 1px solid var(--border);
    }
    th {
      width: 35%;
      color: var(--text-dim);
      font-weight: 400;
    }
    td,
    .mono {
      font-family: var(--font-mono);
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .mono {
      flex: 1;
    }
    .define {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 6px 10px;
      align-items: center;
      margin: 10px 0 6px;
    }
    .define button {
      justify-self: start;
    }
    .offers {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin: 6px 0 0;
    }
    .problem {
      margin: 4px 0 0;
      color: var(--danger);
    }
    footer {
      display: flex;
      gap: 6px;
      margin-top: 14px;
    }
    .spacer {
      flex: 1;
    }
  `,
})
export class RelationsDialog {
  protected readonly t = RELATION_TEXTS;
  protected readonly relations = inject(RelationsService);
  private readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly fromEl = viewChild<ElementRef<HTMLSelectElement>>('from');
  private readonly schemaEl = viewChild<ElementRef<HTMLInputElement>>('schema');
  private readonly tableEl = viewChild<ElementRef<HTMLInputElement>>('table');
  private readonly targetEl = viewChild<ElementRef<HTMLInputElement>>('target');

  /** The column chosen in the form (`null`: the one it opened with). */
  protected readonly column = signal<string | null>(null);
  protected readonly problem = signal(false);
  protected readonly offers = computed(() => {
    const d = this.relations.dialog();
    return d?.kind === 'define' ? suggestTargets(this.column() ?? d.column) : [];
  });
  protected readonly own = computed(() => {
    const d = this.relations.dialog();
    // read the setting, so the list follows what is added and removed
    void this.settings.settings().virtualRelations;
    return d?.kind === 'define'
      ? this.relations.ownOf(d.tab.connectionId(), d.schema, d.table)
      : [];
  });

  constructor() {
    afterNextRender(() => {
      const el = this.dialog().nativeElement;
      el.showModal();
      // the first thing to act on: the first key of a list, the first button of a look, the form
      el.querySelector<HTMLElement>('.target:not(:disabled), footer button, select')?.focus();
    });
  }

  /** A click opens where the list was asked to; with a modifier in a new tab. */
  protected open(item: RelationItem, event: MouseEvent): void {
    const d = this.relations.dialog();
    if (d?.kind !== 'list') return;
    const how = event.metaKey || event.ctrlKey || event.shiftKey ? 'tab' : d.how;
    void this.relations.open(d.tab, item, how);
  }

  protected countText(item: RelationItem): string {
    if (item.count === 'busy') return this.t.counting;
    if (item.count === 'failed' || item.count === null) return this.t.countFailed;
    return this.t.rows(String(item.count));
  }

  protected cellText(cell: unknown, kind: string): string {
    if (cell === null || cell === undefined) return this.t.nullValue;
    return showCell(cell as never, kind as never).text;
  }

  protected text(k: {
    columns: readonly string[];
    refSchema: string;
    refTable: string;
    refColumns: readonly string[];
  }): string {
    return `${k.columns.join(', ')} → ${k.refSchema ? `${k.refSchema}.` : ''}${k.refTable} (${k.refColumns.join(', ')})`;
  }

  protected add(): void {
    const d = this.relations.dialog();
    if (d?.kind !== 'define') return;
    const ok = this.relations.addVirtual(
      d.tab.connectionId(),
      { schema: d.schema, table: d.table, column: this.fromEl()?.nativeElement.value ?? d.column },
      {
        schema: this.schemaEl()?.nativeElement.value ?? '',
        table: this.tableEl()?.nativeElement.value ?? '',
        column: this.targetEl()?.nativeElement.value ?? '',
      },
    );
    this.problem.set(!ok);
    if (ok) {
      const table = this.tableEl()?.nativeElement;
      const target = this.targetEl()?.nativeElement;
      if (table) table.value = '';
      if (target) target.value = '';
    }
  }
}
