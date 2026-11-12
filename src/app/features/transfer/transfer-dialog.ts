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
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError } from '../../core/errors/app-error';
import { locale } from '../../core/i18n/i18n';
import { SchemaApi } from '../../core/schema/schema-api';
import {
  TransferPlan,
  TransferReport,
  TransferRequest,
  TransferTable,
  TransferTableReport,
} from '../../core/transfer/transfer-api';
import {
  DEFAULT_REQUEST,
  allDone,
  defaultSchema,
  durationText,
  fitted,
  leftOut,
  losses,
  outcomeOf,
  requestProblem,
  rowsWritten,
} from './transfer-logic';
import { TRANSFER_TEXTS } from './transfer-texts';
import { TransferService, TransferSource } from './transfer.service';

/**
 * Copying tables from one connection to another (prompt 045): which tables, where to, how – then what
 * will happen (tables created, types mapped, what gets lost), and only then the run, with its progress
 * and a report per table. Names and messages of the databases are shown as text.
 */
@Component({
  selector: 'app-transfer-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="tr-title" (cancel)="$event.preventDefault(); close()">
      <h2 id="tr-title">{{ t.title }}</h2>
      <div class="scroll">
        @if (report(); as r) {
          <p class="status" role="status" [class.warn]="!done()">
            {{ done() ? t.allDone(number(written())) : t.notAllDone }}
          </p>
          <table>
            <caption class="sr">
              {{
                t.report
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">{{ t.table }}</th>
                <th scope="col">{{ t.report }}</th>
                <th scope="col" class="num">{{ t.rows }}</th>
                <th scope="col" class="num">{{ t.time }}</th>
              </tr>
            </thead>
            <tbody>
              @for (row of r.tables; track row.table) {
                <tr>
                  <th scope="row">{{ row.table }}</th>
                  <td [class.warn]="outcome(row) !== 'done'">
                    {{ t.outcomes[outcome(row)] }}
                    @if (detail(row)) {
                      <span class="detail">– {{ detail(row) }}</span>
                    }
                  </td>
                  <td class="num">
                    {{ t.rowsOf(number(row.loaded.written), number(row.loaded.read)) }}
                  </td>
                  <td class="num">{{ row.skipped ? '' : duration(row.elapsedMs) }}</td>
                </tr>
              }
            </tbody>
          </table>
          @if (r.afterErrors.length > 0) {
            <p class="warn">{{ t.afterErrors }}</p>
            <ul class="plain">
              @for (e of r.afterErrors; track $index) {
                <li>{{ e }}</li>
              }
            </ul>
          }
        } @else if (plan(); as p) {
          <h3>{{ t.plan }}</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">{{ t.table }}</th>
                <th scope="col">{{ t.inTarget }}</th>
                <th scope="col">{{ t.columnsHead }}</th>
              </tr>
            </thead>
            <tbody>
              @for (table of p.tables; track table.table) {
                <tr>
                  <th scope="row">{{ table.table }}</th>
                  <td>{{ table.exists ? t.exists : t.created }}</td>
                  <td>
                    {{ t.columnsCopied(copied(table), table.columns.length) }}
                    @if (missing(table)) {
                      <div class="detail">{{ t.leftOut(missing(table)) }}</div>
                    }
                    @for (note of table.notes; track $index) {
                      <div class="detail">{{ note }}</div>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
          <h3>{{ t.losses }}</h3>
          @if (lost().length === 0) {
            <p class="note">{{ t.noLosses }}</p>
          } @else {
            <ul class="plain">
              @for (l of lost(); track $index) {
                <li>
                  <b>{{ t.lossLine(l.table, l.column, l.from, l.to) }}</b
                  >: {{ l.loss }}
                </li>
              }
            </ul>
          }
          @if (p.cycle.length > 0) {
            <p class="warn" role="alert">{{ t.cycle(p.cycle.join(', ')) }}</p>
          }
          <details>
            <summary>{{ t.statements(p.statements.length) }}</summary>
            <pre>{{
              p.statements.join(
                '

'
              )
            }}</pre>
          </details>
          <p class="status" role="status">
            @if (progress(); as pr) {
              {{ t.progress(pr.table, pr.index + 1, pr.of, number(pr.read)) }}
            } @else if (failure()) {
              <span class="warn">{{ failure() }}</span>
            }
          </p>
        } @else {
          <fieldset>
            <legend>{{ t.source }}</legend>
            <p class="note">{{ t.sourceOf(sourceName(), source().schema) }}</p>
            @if (tables() === null) {
              <p class="note" role="status">{{ t.loadingTables }}</p>
            } @else {
              <div class="row">
                <button type="button" (click)="tick(true)">{{ t.all }}</button>
                <button type="button" (click)="tick(false)">{{ t.none }}</button>
              </div>
              <ul class="tables" [attr.aria-label]="t.tables">
                @for (name of tables(); track name) {
                  <li>
                    <label>
                      <input
                        type="checkbox"
                        [checked]="chosen().has(name)"
                        (change)="toggle(name)"
                      />
                      {{ name }}
                    </label>
                  </li>
                }
              </ul>
            }
          </fieldset>
          <fieldset>
            <legend>{{ t.target }}</legend>
            <label>
              {{ t.targetConnection }}
              <select #conn (change)="setTarget(conn.value)">
                <option value="" [selected]="target() === null">{{ t.noConnection }}</option>
                @for (c of targets(); track c.id) {
                  <option [value]="c.id" [selected]="target() === c.id">{{ c.name }}</option>
                }
              </select>
            </label>
            <label>
              {{ t.targetSchema }}
              <input
                #schema
                type="text"
                spellcheck="false"
                autocomplete="off"
                [value]="targetSchema()"
                (input)="targetSchema.set(schema.value)"
              />
            </label>
          </fieldset>
          <fieldset>
            <legend>{{ t.options }}</legend>
            <label>
              <input
                type="radio"
                name="tr-mode"
                [checked]="options().mode === 'append'"
                (change)="set({ mode: 'append' })"
              />
              {{ t.modes.append }}
            </label>
            <label>
              <input
                type="radio"
                name="tr-mode"
                [checked]="options().mode === 'clear'"
                (change)="set({ mode: 'clear' })"
              />
              {{ t.modes.clear }}
            </label>
            <label>
              <input
                #keys
                type="checkbox"
                [checked]="options().withKeys"
                (change)="set({ withKeys: keys.checked })"
              />
              {{ t.withKeys }}
            </label>
            <label>
              <input
                type="radio"
                name="tr-error"
                [checked]="options().onError === 'abort'"
                (change)="set({ onError: 'abort' })"
              />
              {{ t.onErrors.abort }}
            </label>
            <label>
              <input
                type="radio"
                name="tr-error"
                [checked]="options().onError === 'skip'"
                (change)="set({ onError: 'skip' })"
              />
              {{ t.onErrors.skip }}
            </label>
            <label>
              <input
                #tx
                type="checkbox"
                [checked]="options().wholeTransaction && options().onError === 'abort'"
                [disabled]="options().onError === 'skip'"
                (change)="set({ wholeTransaction: tx.checked })"
              />
              {{ t.wholeTransaction }}
            </label>
          </fieldset>
          <p class="status" role="status">
            @if (failure()) {
              <span class="warn">{{ failure() }}</span>
            } @else if (problem(); as why) {
              {{ t.problems[why] }}
            }
          </p>
        }
      </div>
      <div class="buttons">
        @if (plan() && !report() && !progress()) {
          <button type="button" (click)="back()">{{ t.back }}</button>
        }
        <span class="grow"></span>
        @if (progress()) {
          <button type="button" (click)="service.cancel()">{{ t.stop }}</button>
        } @else if (report()) {
          <button type="button" class="primary" (click)="close()">{{ t.close }}</button>
        } @else {
          <button type="button" (click)="close()">{{ t.cancel }}</button>
          @if (plan()) {
            <button type="button" class="primary" [disabled]="busy()" (click)="run()">
              {{ busy() ? t.running : t.run }}
            </button>
          } @else {
            <button
              type="button"
              class="primary"
              [disabled]="problem() !== null || busy()"
              (click)="preview()"
            >
              {{ t.preview }}
            </button>
          }
        }
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(760px, calc(100vw - 32px));
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
      flex: none;
      margin: 0 0 10px;
      font-size: 14px;
    }
    h3 {
      margin: 10px 0 4px;
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    fieldset {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      margin: 0;
      padding: 6px 10px 8px;
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
      gap: 6px;
    }
    .row {
      display: flex;
      gap: 6px;
    }
    .tables {
      align-self: stretch;
      max-height: 180px;
      overflow: auto;
      margin: 0;
      padding: 4px 8px;
      list-style: none;
      columns: 2;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      padding: 2px 8px 2px 0;
      text-align: left;
      vertical-align: top;
      font-weight: normal;
    }
    thead th {
      color: var(--text-dim);
      font-size: 12px;
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .detail,
    .note {
      margin: 0;
      color: var(--text-dim);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .plain {
      margin: 0;
      padding-left: 18px;
      overflow-wrap: anywhere;
    }
    .status {
      margin: 0;
      min-height: 18px;
    }
    .warn {
      color: var(--danger);
    }
    pre {
      margin: 4px 0 0;
      max-height: 200px;
      overflow: auto;
      font-family: var(--font-mono, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    summary {
      cursor: pointer;
      color: var(--text-dim);
      font-size: 12px;
    }
    .buttons {
      flex: none;
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .grow {
      flex: 1;
    }
    button {
      padding: 3px 12px;
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
export class TransferDialog {
  readonly source = input.required<TransferSource>();
  readonly closed = output<void>();

  protected readonly service = inject(TransferService);
  private readonly schemas = inject(SchemaApi);
  private readonly connections = inject(ConnectionsStore);
  private readonly files = inject(FileDialogApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly t = TRANSFER_TEXTS;

  /** The tables of the source schema; `null` while they are read. */
  protected readonly tables = signal<readonly string[] | null>(null);
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());
  protected readonly target = signal<string | null>(null);
  protected readonly targetSchema = signal('');
  protected readonly options = signal(DEFAULT_REQUEST);
  protected readonly plan = signal<TransferPlan | null>(null);
  protected readonly report = signal<TransferReport | null>(null);
  protected readonly failure = signal('');
  protected readonly busy = signal(false);
  protected readonly progress = this.service.progress;
  private asked = 0;

  protected readonly sourceName = computed(
    () => this.connections.profiles().find((p) => p.id === this.source().connectionId)?.name ?? '',
  );
  /** Where tables can go: every connection that is connected. */
  protected readonly targets = computed(() =>
    this.connections
      .profiles()
      .filter((p) => this.connections.state(p.id).kind === 'open')
      .map((p) => ({ id: p.id, name: p.name })),
  );
  private readonly request = computed<TransferRequest>(() =>
    fitted({
      ...this.options(),
      sourceSchema: this.source().schema,
      // in the order of the list, whatever order they were ticked in
      tables: (this.tables() ?? []).filter((name) => this.chosen().has(name)),
      targetSchema: this.targetSchema().trim(),
    }),
  );
  protected readonly problem = computed(() =>
    requestProblem(this.request(), this.source().connectionId, this.target()),
  );
  protected readonly lost = computed(() => {
    const plan = this.plan();
    return plan ? losses(plan) : [];
  });
  protected readonly done = computed(() => {
    const report = this.report();
    return !!report && allDone(report);
  });
  protected readonly written = computed(() => {
    const report = this.report();
    return report ? rowsWritten(report) : 0;
  });

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    effect(() => {
      const source = this.source();
      untracked(() => void this.start(source));
    });
  }

  private async start(source: TransferSource): Promise<void> {
    const asked = ++this.asked;
    this.tables.set(null);
    this.chosen.set(new Set(source.table ? [source.table] : []));
    try {
      const objects = await this.schemas.objects(source.connectionId, source.schema);
      if (asked !== this.asked) return;
      this.tables.set(objects.filter((o) => o.kind === 'table').map((o) => o.name));
    } catch (e) {
      if (asked !== this.asked) return;
      this.tables.set(source.table ? [source.table] : []);
      this.failure.set(describeError(e));
    }
  }

  protected setTarget(id: string): void {
    this.target.set(id === '' ? null : id);
    const profile = this.connections.profiles().find((p) => p.id === id);
    if (profile) this.targetSchema.set(defaultSchema(profile.kind, profile.database));
  }

  protected set(change: Partial<typeof DEFAULT_REQUEST>): void {
    this.options.update((o) => ({ ...o, ...change }));
  }

  protected toggle(name: string): void {
    this.chosen.update((now) => {
      const next = new Set(now);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  protected tick(all: boolean): void {
    this.chosen.set(new Set(all ? (this.tables() ?? []) : []));
  }

  protected number(n: number): string {
    return n.toLocaleString(locale());
  }

  protected duration(ms: number): string {
    return durationText(ms, locale());
  }

  protected copied(table: TransferTable): number {
    return table.columns.filter((c) => c.target !== null).length;
  }

  protected missing(table: TransferTable): string {
    return leftOut(table).join(', ');
  }

  protected outcome = outcomeOf;

  /** What the report says beside the outcome of a table: why, and what stays. */
  protected detail(row: TransferTableReport): string {
    const parts: string[] = [];
    const reason = row.error ?? row.loaded.errors[0]?.reason;
    if (reason) parts.push(reason);
    if (row.loaded.failed || row.loaded.cancelled || row.error) {
      parts.push(row.loaded.rolledBack || row.error ? this.t.rolledBack : this.t.partly);
      // what stays although the rows did not arrive
      if (row.created) parts.push(this.t.createdStays);
      if (row.loaded.cleared) parts.push(this.t.clearedStays);
    }
    if (row.loaded.errorFile) parts.push(this.t.errorFile);
    return parts.join(' · ');
  }

  protected async preview(): Promise<void> {
    const target = this.target();
    if (!target || this.problem() !== null) return;
    this.busy.set(true);
    this.failure.set('');
    try {
      this.plan.set(await this.service.plan(this.source().connectionId, target, this.request()));
    } catch (e) {
      this.failure.set(describeError(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected back(): void {
    this.plan.set(null);
    this.failure.set('');
  }

  protected async run(): Promise<void> {
    const target = this.target();
    const plan = this.plan();
    if (!target || !plan || this.busy()) return;
    const request = this.request();
    let errorPath: string | null = null;
    if (request.onError === 'skip') {
      // where the rows that are left out are noted; without a file they are only counted
      errorPath = await this.files.saveFile(this.t.errorFileTitle, 'transfer-errors.csv', [
        { name: 'CSV', extensions: ['csv'] },
      ]);
    }
    this.busy.set(true);
    this.failure.set('');
    const outcome = await this.service.run(
      this.source().connectionId,
      target,
      request,
      plan,
      errorPath,
    );
    this.busy.set(false);
    if (outcome.kind === 'report') this.report.set(outcome.report);
    else if (outcome.kind === 'error') this.failure.set(outcome.message);
  }

  protected close(): void {
    if (this.progress()) return;
    this.asked++;
    this.closed.emit();
  }
}
