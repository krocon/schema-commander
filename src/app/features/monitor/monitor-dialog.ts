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
import { ConnectionsStore } from '../../core/connections/connections.store';
import { locale } from '../../core/i18n/i18n';
import { ServerSession } from '../../core/monitor/monitor-api';
import { SettingsService } from '../../core/settings/settings.service';
import {
  BlockNode,
  INTERVALS,
  Sort,
  SortKey,
  blockTree,
  bytesText,
  durationText,
  filtered,
  firstLine,
  mark,
  sorted,
  stillThere,
  toggled,
} from './monitor-logic';
import { MONITOR_TEXTS } from './monitor-texts';
import { MonitorService } from './monitor.service';

/**
 * What happens on the server (prompt 046): a few figures, the sessions in a table that can be ordered
 * and filtered, who blocks whom, and the statement of the session that is chosen – with the ways to
 * cancel it or end the session. A new reading keeps the rows (by the id of their session), the order and
 * the choice. Everything the server says – names, statements – is shown as text.
 */
@Component({
  selector: 'app-monitor-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="mo-title" (cancel)="$event.preventDefault(); closed.emit()">
      <h2 id="mo-title">{{ t.title(connectionName()) }}</h2>
      <div class="bar">
        <button type="button" [disabled]="monitor.busy()" (click)="monitor.refresh()">
          {{ t.refresh }}
        </button>
        <label>
          {{ t.interval }}
          <select #every (change)="setInterval(+every.value)">
            @for (s of intervals; track s) {
              <option [value]="s" [selected]="interval() === s">
                {{ s === 0 ? t.byHand : t.seconds(s) }}
              </option>
            }
          </select>
        </label>
        <span class="read" role="status">
          @if (monitor.busy()) {
            {{ t.reading }}
          } @else if (readAt()) {
            {{ t.readAt(readAt()) }}
          }
        </span>
        <span class="grow"></span>
        <input
          #filter
          type="search"
          spellcheck="false"
          autocomplete="off"
          [attr.aria-label]="t.filter"
          [placeholder]="t.filter"
          [value]="text()"
          (input)="text.set(filter.value)"
        />
        <label>
          <input
            #active
            type="checkbox"
            [checked]="activeOnly()"
            (change)="activeOnly.set(active.checked)"
          />
          {{ t.activeOnly }}
        </label>
      </div>
      @if (monitor.problem()) {
        <p class="warn" role="alert">{{ monitor.problem() }}</p>
      }
      @if (monitor.note()) {
        <p class="note" role="status">{{ monitor.note() }}</p>
      }
      @if (activity(); as a) {
        <dl class="figures">
          <div>
            <dt>{{ t.figures.connections }}</dt>
            <dd>{{ connections() }}</dd>
          </div>
          <div>
            <dt>{{ t.figures.transactions }}</dt>
            <dd>{{ rate() }}</dd>
          </div>
          <div>
            <dt>{{ t.figures.size }}</dt>
            <dd>{{ size() }}</dd>
          </div>
          <div>
            <dt>{{ t.figures.uptime }}</dt>
            <dd>{{ uptime() }}</dd>
          </div>
          <div class="version">
            <dd>{{ a.figures.version }}</dd>
          </div>
        </dl>
        @for (m of a.missing; track $index) {
          <p class="warn">{{ t.missing(partName(m.part), m.reason) }}</p>
        }
        <div class="main">
          <div class="list">
            <table [attr.aria-label]="t.sessions">
              <caption>
                {{
                  t.sessionCount(t.shown(rows().length, a.sessions.length))
                }}
                @if (a.cut) {
                  {{ t.cut }}
                }
              </caption>
              <thead>
                <tr>
                  @for (c of sortable; track c) {
                    <th scope="col" [attr.aria-sort]="ariaSort(c)" [class.num]="isNumber(c)">
                      <button type="button" [title]="t.sortBy(t.columns[c])" (click)="sortBy(c)">
                        {{ t.columns[c] }}{{ arrow(c) }}
                      </button>
                    </th>
                  }
                  <th scope="col">{{ t.columns.wait }}</th>
                  <th scope="col">{{ t.columns.statement }}</th>
                </tr>
              </thead>
              <tbody>
                @for (s of rows(); track s.id) {
                  <tr
                    tabindex="0"
                    [class]="rowClass(s)"
                    [class.chosen]="selectedId() === s.id"
                    [attr.aria-selected]="selectedId() === s.id"
                    (click)="selectedId.set(s.id)"
                    (keydown.enter)="selectedId.set(s.id)"
                    (keydown.space)="$event.preventDefault(); selectedId.set(s.id)"
                  >
                    <td class="num">{{ s.id }}</td>
                    <td>{{ s.user }}</td>
                    <td>{{ s.database }}</td>
                    <td>
                      {{ s.application }}
                      @if (s.own) {
                        <span class="own" [title]="t.ownHint">{{ t.own }}</span>
                      }
                    </td>
                    <td>
                      {{ s.state }}
                      @if (markOf(s); as m) {
                        <span class="sr">{{ m === 'blocked' ? t.blocked : t.long }}</span>
                      }
                    </td>
                    <td class="num">{{ duration(s.queryMs) }}</td>
                    <td class="num">{{ duration(s.txMs) }}</td>
                    <td>
                      {{ s.wait }}
                      @if (s.blockedBy.length > 0) {
                        <span class="by">{{ t.blockedBy(s.blockedBy.join(', ')) }}</span>
                      }
                    </td>
                    <td class="stmt">{{ line(s.statement) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="side">
            <section>
              <h3>{{ t.blocking }}</h3>
              @if (tree().length === 0) {
                <p class="note">{{ t.noBlocking }}</p>
              } @else {
                <ul class="tree">
                  @for (n of flat(); track n.key) {
                    <li [style.padding-left.px]="n.depth * 16">
                      <button type="button" (click)="selectedId.set(n.node.session.id)">
                        {{ n.label }}
                      </button>
                      @if (n.node.waiting.length > 0) {
                        <span class="by">{{ t.holds(n.node.waiting.length) }}</span>
                      }
                    </li>
                  }
                </ul>
              }
            </section>
            <section class="detail">
              @if (selected(); as s) {
                <h3>{{ t.selected(s.id) }}</h3>
                <p class="note">{{ who(s) }}</p>
                <pre tabindex="0">{{ s.statement || t.noStatement }}</pre>
                @if (s.this) {
                  <p class="note">{{ t.cannotEndThis }}</p>
                } @else if (readOnly()) {
                  <p class="note">{{ t.readOnly }}</p>
                } @else {
                  <div class="actions">
                    @if (a.canCancel) {
                      <button
                        type="button"
                        [disabled]="s.queryMs === null"
                        (click)="monitor.end(s, false)"
                      >
                        {{ t.cancelQuery }}
                      </button>
                    }
                    <button type="button" class="destructive" (click)="monitor.end(s, true)">
                      {{ t.terminate }}
                    </button>
                  </div>
                }
              } @else {
                <p class="note">{{ t.noSelection }}</p>
              }
            </section>
          </div>
        </div>
      }
      <div class="buttons">
        <span class="grow"></span>
        <button type="button" (click)="closed.emit()">{{ t.close }}</button>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(1180px, calc(100vw - 32px));
      height: min(780px, calc(100vh - 32px));
      padding: 14px 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog[open] {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 35%);
    }
    h2 {
      flex: none;
      margin: 0;
      font-size: 14px;
    }
    h3 {
      margin: 0 0 4px;
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .bar {
      flex: none;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 12px;
    }
    .bar label {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .bar input[type='search'] {
      width: 200px;
    }
    .read {
      color: var(--text-dim);
      font-size: 12px;
      min-width: 130px;
    }
    .grow {
      flex: 1;
    }
    .figures {
      flex: none;
      display: flex;
      flex-wrap: wrap;
      gap: 4px 22px;
      margin: 0;
    }
    .figures dt {
      color: var(--text-dim);
      font-size: 11px;
    }
    .figures dd {
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
    .figures .version {
      flex: 1;
      align-self: flex-end;
      text-align: right;
      color: var(--text-dim);
      font-size: 12px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .main {
      flex: 1;
      min-height: 0;
      display: flex;
      gap: 10px;
    }
    .list {
      flex: 1;
      min-width: 0;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    caption {
      caption-side: top;
      padding: 2px 6px;
      text-align: left;
      color: var(--text-dim);
    }
    th {
      position: sticky;
      top: 0;
      padding: 0;
      background: var(--bg-panel);
      text-align: left;
      font-weight: normal;
      white-space: nowrap;
      color: var(--text-dim);
    }
    th:not(:has(button)) {
      padding: 2px 6px;
    }
    th button {
      width: 100%;
      padding: 2px 6px;
      text-align: inherit;
      color: inherit;
    }
    td {
      padding: 1px 6px;
      vertical-align: top;
      white-space: nowrap;
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    tbody tr {
      cursor: default;
    }
    tbody tr.chosen {
      background: var(--bg-selected, var(--border));
    }
    tbody tr.blocked td:first-child {
      box-shadow: inset 3px 0 0 var(--danger);
    }
    tbody tr.long td:first-child {
      box-shadow: inset 3px 0 0 var(--warn, var(--accent));
    }
    .stmt {
      max-width: 340px;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--font-mono, monospace);
    }
    .own {
      margin-left: 4px;
      padding: 0 5px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text-dim);
      font-size: 11px;
    }
    .by {
      margin-left: 4px;
      color: var(--danger);
    }
    .side {
      flex: none;
      width: 340px;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .side section {
      min-height: 0;
      overflow: auto;
    }
    .detail {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .tree {
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: 12px;
    }
    .tree button {
      padding: 1px 4px;
      text-align: left;
    }
    pre {
      flex: 1;
      min-height: 60px;
      margin: 4px 0;
      padding: 6px 8px;
      overflow: auto;
      background: var(--bg-app);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      font-family: var(--font-mono, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .actions,
    .buttons {
      flex: none;
      display: flex;
      gap: 8px;
    }
    .note {
      margin: 0;
      color: var(--text-dim);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .warn {
      margin: 0;
      color: var(--danger);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .bar button,
    .actions button,
    .buttons button {
      padding: 3px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    button.destructive {
      border-color: var(--danger);
      color: var(--danger);
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
export class MonitorDialog {
  readonly connectionId = input.required<string>();
  readonly closed = output<void>();

  protected readonly monitor = inject(MonitorService);
  private readonly store = inject(ConnectionsStore);
  private readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly t = MONITOR_TEXTS;
  protected readonly intervals = INTERVALS;
  protected readonly sortable: readonly SortKey[] = [
    'id',
    'user',
    'database',
    'application',
    'state',
    'queryMs',
    'txMs',
  ];
  protected readonly activity = this.monitor.activity;
  protected readonly text = signal('');
  protected readonly activeOnly = signal(false);
  protected readonly sort = signal<Sort>({ key: 'id', desc: false });
  /** The session that is chosen, by its id: a new reading keeps the choice. */
  protected readonly selectedId = signal<string | null>(null);

  protected readonly connectionName = computed(
    () => this.store.profiles().find((p) => p.id === this.connectionId())?.name ?? '',
  );
  /** A connection that only reads ends nothing (the backend refuses it, too). */
  protected readonly readOnly = computed(
    () =>
      this.store.profiles().find((p) => p.id === this.connectionId())?.protection === 'readonly',
  );
  protected readonly interval = computed(() => this.settings.settings().monitorIntervalSec);
  protected readonly rows = computed(() =>
    sorted(filtered(this.activity()?.sessions ?? [], this.text(), this.activeOnly()), this.sort()),
  );
  protected readonly tree = computed(() => blockTree(this.activity()?.sessions ?? []));
  /** The tree as lines with their depth. */
  protected readonly flat = computed(() => {
    const out: { key: string; depth: number; label: string; node: BlockNode }[] = [];
    const walk = (nodes: readonly BlockNode[], depth: number, path: string) => {
      for (const node of nodes) {
        const key = `${path}/${node.session.id}`;
        const label = `${depth > 0 ? '↳ ' : ''}${node.session.id} ${node.session.user}`;
        out.push({ key, depth, label, node });
        walk(node.waiting, depth + 1, key);
      }
    };
    walk(this.tree(), 0, '');
    return out;
  });
  protected readonly selected = computed(() => stillThere(this.activity(), this.selectedId()));
  protected readonly readAt = computed(() => {
    const at = this.monitor.readAt();
    return at === null ? '' : new Date(at).toLocaleTimeString(locale());
  });

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    effect(() => {
      // the beat of the setting; it stops with the dialog (the service is closed by the app)
      const seconds = this.interval();
      untracked(() => this.monitor.every(seconds));
    });
  }

  protected setInterval(seconds: number): void {
    this.settings.update({ monitorIntervalSec: seconds });
  }

  protected sortBy(key: SortKey): void {
    this.sort.update((s) => toggled(s, key));
  }

  protected isNumber(key: SortKey): boolean {
    return key === 'id' || key === 'queryMs' || key === 'txMs';
  }

  protected ariaSort(key: SortKey): 'ascending' | 'descending' | null {
    const s = this.sort();
    return s.key === key ? (s.desc ? 'descending' : 'ascending') : null;
  }

  protected arrow(key: SortKey): string {
    const s = this.sort();
    return s.key === key ? (s.desc ? ' ↓' : ' ↑') : '';
  }

  protected markOf = mark;
  protected duration = durationText;

  protected rowClass(s: ServerSession): string {
    return mark(s) ?? '';
  }

  protected line(statement: string): string {
    return firstLine(statement);
  }

  protected who(s: ServerSession): string {
    return [s.user, s.database, s.client, s.state].filter((x) => x !== '').join(' · ');
  }

  protected partName(part: string): string {
    return (this.t.parts as Record<string, string>)[part] ?? part;
  }

  private count(n: number | null): string {
    return n === null ? '–' : n.toLocaleString(locale());
  }

  protected connections(): string {
    const f = this.activity()?.figures;
    if (!f) return '–';
    return f.maxConnections === null
      ? this.count(f.connections)
      : this.t.ofMax(this.count(f.connections), this.count(f.maxConnections));
  }

  protected rate(): string {
    const rate = this.monitor.rate();
    return rate === null ? '–' : rate.toLocaleString(locale(), { maximumFractionDigits: 1 });
  }

  protected size(): string {
    const bytes = this.activity()?.figures.databaseBytes ?? null;
    return bytes === null ? '–' : bytesText(bytes, locale());
  }

  protected uptime(): string {
    const s = this.activity()?.figures.uptimeS ?? null;
    return s === null ? '–' : durationText(s * 1000);
  }
}
