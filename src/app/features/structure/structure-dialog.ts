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
import { describeError } from '../../core/errors/app-error';
import {
  StructPlan,
  StructRequest,
  StructureApi,
  TableDef,
} from '../../core/structure/structure-api';
import { TabsStore } from '../tabs/tabs.store';
import {
  EditedIndex,
  EditedTable,
  addCheck,
  addColumn,
  addIndex,
  addKey,
  emptyTable,
  fromTable,
  hasDanger,
  moveColumn,
  operations,
  problemOf,
  removeRow,
  requestOf,
  setColumn,
  statementsOf,
  typeSuggestions,
} from './structure-logic';
import { STRUCTURE_TEXTS } from './structure-texts';
import { RunOutcome, StructTarget, StructureService } from './structure.service';

/**
 * The structure of a table as a form (prompt 043): columns, indexes, foreign keys and checks in tables to
 * edit; then the statements the backend would run, with the steps that may lose data marked – and only
 * then, on a word of the user, they run. The same dialog asks before a table is dropped, emptied or
 * copied. Nothing of the database is set into the page as markup.
 */
@Component({
  selector: 'app-structure-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="st-title" (cancel)="$event.preventDefault(); close()">
      <h2 id="st-title">{{ title() }}</h2>
      @if (!writable()) {
        <p class="warn" role="alert">{{ t.readOnly }}</p>
      }
      @if (loading()) {
        <p class="note" role="status">{{ t.loading }}</p>
      } @else if (loadError()) {
        <p class="warn" role="alert">{{ loadError() }}</p>
      } @else if (plan(); as p) {
        <div class="scroll">
          @if (ops().length > 0) {
            <h3>{{ t.changes }}</h3>
            <ul class="ops">
              @for (op of ops(); track $index) {
                <li>
                  <b>{{ t.ops[op.kind] }}</b> {{ op.name }}
                  @if (op.detail) {
                    <span class="detail">{{ op.detail }}</span>
                  }
                </li>
              }
            </ul>
          }
          <h3>{{ t.statements }}</h3>
          @if (statements().length === 0) {
            <p class="note">{{ t.nothing }}</p>
          }
          <ol class="steps">
            @for (step of p.steps; track $index) {
              <li [class.danger]="step.danger" [class.remark]="!step.sql">
                @if (step.danger) {
                  <p class="why">
                    <span class="badge">{{ t.danger }}</span> {{ step.danger }}
                  </p>
                }
                @if (step.note) {
                  <p class="why">
                    @if (!step.sql) {
                      <span class="badge quiet">{{ t.remark }}</span>
                    }
                    {{ step.note }}
                  </p>
                }
                @if (step.sql) {
                  <pre>{{ step.sql }}</pre>
                }
              </li>
            }
          </ol>
          @if (statements().length > 0) {
            <p class="note">{{ p.transactional ? t.transactional : t.notTransactional }}</p>
          }
          @if (p.incomplete) {
            <p class="warn" role="alert">{{ t.incomplete }}</p>
          }
          @if (dangerous() && !p.incomplete) {
            <label class="understood">
              <input
                #ok
                type="checkbox"
                [checked]="understood()"
                (change)="understood.set(ok.checked)"
              />
              {{ t.understood }}
            </label>
          }
          @if (outcome(); as o) {
            <div class="outcome" role="alert">
              @switch (o.kind) {
                @case ('failed') {
                  <p class="warn">{{ t.failedAt((o.ran.failed ?? 0) + 1, o.of) }}</p>
                  <pre>{{ failedMessage() }}</pre>
                  <p>
                    {{
                      o.ran.rolledBack ? t.rolledBack : o.ran.done > 0 ? t.partly(o.ran.done) : ''
                    }}
                  </p>
                }
                @case ('error') {
                  <p class="warn">{{ o.message }}</p>
                }
              }
            </div>
          }
        </div>
        <div class="buttons">
          @if (form()) {
            <button type="button" [disabled]="running()" (click)="back()">{{ t.back }}</button>
          }
          <span class="grow"></span>
          <button
            type="button"
            [disabled]="running() || statements().length === 0"
            [title]="t.toEditorHint"
            (click)="toEditor()"
          >
            {{ t.toEditor }}
          </button>
          <button type="button" [disabled]="running()" (click)="close()">{{ t.cancel }}</button>
          <button
            type="button"
            class="primary"
            [class.destructive]="dangerous()"
            [disabled]="!canRun()"
            (click)="run()"
          >
            {{ running() ? t.running : t.run }}
          </button>
        </div>
      } @else if (target().mode === 'duplicate') {
        <form class="copy" (submit)="$event.preventDefault(); preview()">
          <label for="st-copy">{{ t.copyName }}</label>
          <input
            #copy
            id="st-copy"
            type="text"
            maxlength="120"
            autocomplete="off"
            spellcheck="false"
            [value]="copyName()"
            (input)="copyName.set(copy.value)"
          />
          <label class="check">
            <input
              #data
              type="checkbox"
              [checked]="copyData()"
              (change)="copyData.set(data.checked)"
            />
            {{ t.withData }}
          </label>
        </form>
        @if (planError()) {
          <p class="warn" role="alert">{{ planError() }}</p>
        }
        <div class="buttons">
          <span class="grow"></span>
          <button type="button" (click)="close()">{{ t.cancel }}</button>
          <button
            type="button"
            class="primary"
            [disabled]="!writable() || copyName().trim() === ''"
            (click)="preview()"
          >
            {{ t.preview }}
          </button>
        </div>
      } @else if (edited(); as e) {
        <div class="scroll">
          <label class="table-name">
            {{ t.tableName }}
            <input
              #tname
              type="text"
              maxlength="120"
              autocomplete="off"
              spellcheck="false"
              [value]="e.name"
              (input)="patch({ name: tname.value })"
            />
          </label>
          <h3 id="st-columns">{{ t.columns }}</h3>
          <table aria-labelledby="st-columns">
            <thead>
              <tr>
                <th scope="col">{{ t.name }}</th>
                <th scope="col">{{ t.type }}</th>
                <th scope="col">{{ t.notNull }}</th>
                <th scope="col">{{ t.default }}</th>
                <th scope="col">{{ t.primaryKey }}</th>
                <th scope="col"><span class="sr">…</span></th>
              </tr>
            </thead>
            <tbody>
              @for (c of e.columns; track c.id) {
                <tr>
                  <td>
                    <input
                      #cn
                      type="text"
                      spellcheck="false"
                      autocomplete="off"
                      [attr.aria-label]="t.name"
                      [value]="c.name"
                      (input)="column(c.id, { name: cn.value })"
                    />
                  </td>
                  <td>
                    <input
                      #ct
                      type="text"
                      spellcheck="false"
                      autocomplete="off"
                      [attr.list]="uid + '-types'"
                      [attr.aria-label]="t.type"
                      [value]="c.typeName"
                      (input)="column(c.id, { typeName: ct.value })"
                    />
                  </td>
                  <td class="box">
                    <input
                      #nn
                      type="checkbox"
                      [attr.aria-label]="t.notNull + ': ' + (c.name || t.unnamed)"
                      [checked]="!c.nullable || c.pk"
                      [disabled]="c.pk"
                      (change)="column(c.id, { nullable: !nn.checked })"
                    />
                  </td>
                  <td>
                    <input
                      #cd
                      type="text"
                      spellcheck="false"
                      autocomplete="off"
                      [attr.aria-label]="t.default"
                      [value]="c.default"
                      (input)="column(c.id, { default: cd.value })"
                    />
                  </td>
                  <td class="box">
                    <input
                      #pk
                      type="checkbox"
                      [attr.aria-label]="t.primaryKey + ': ' + (c.name || t.unnamed)"
                      [checked]="c.pk"
                      (change)="column(c.id, { pk: pk.checked })"
                    />
                  </td>
                  <td class="tools">
                    @if (!loaded()) {
                      <button
                        type="button"
                        [attr.aria-label]="t.moveUp(c.name || t.unnamed)"
                        [title]="t.moveUp(c.name || t.unnamed)"
                        [disabled]="$first"
                        (click)="move(c.id, -1)"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        [attr.aria-label]="t.moveDown(c.name || t.unnamed)"
                        [title]="t.moveDown(c.name || t.unnamed)"
                        [disabled]="$last"
                        (click)="move(c.id, 1)"
                      >
                        ↓
                      </button>
                    }
                    <button
                      type="button"
                      [attr.aria-label]="t.remove(c.name || t.unnamed)"
                      [title]="t.remove(c.name || t.unnamed)"
                      (click)="remove(c.id)"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
          <button type="button" class="add" (click)="add('column')">+ {{ t.addColumn }}</button>

          <h3 id="st-indexes">{{ t.indexes }}</h3>
          @if (e.indexes.length > 0) {
            <table aria-labelledby="st-indexes">
              <thead>
                <tr>
                  <th scope="col">{{ t.name }}</th>
                  <th scope="col">{{ t.indexColumns }}</th>
                  <th scope="col">{{ t.unique }}</th>
                  <th scope="col"><span class="sr">…</span></th>
                </tr>
              </thead>
              <tbody>
                @for (i of e.indexes; track i.id) {
                  <tr>
                    <td>
                      <input
                        #iname
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        [attr.aria-label]="t.name"
                        [value]="i.name"
                        (input)="index(i.id, { name: iname.value })"
                      />
                    </td>
                    <td>
                      @if (statementOnly(i)) {
                        <span class="fixed" [title]="statementOnly(i)">
                          {{ t.statementOnly }}
                        </span>
                      } @else {
                        <input
                          #icols
                          type="text"
                          spellcheck="false"
                          autocomplete="off"
                          [attr.aria-label]="t.indexColumns"
                          [value]="i.columns"
                          (input)="index(i.id, { columns: icols.value })"
                        />
                      }
                    </td>
                    <td class="box">
                      <input
                        #iu
                        type="checkbox"
                        [attr.aria-label]="t.unique + ': ' + (i.name || t.unnamed)"
                        [checked]="i.unique"
                        (change)="index(i.id, { unique: iu.checked })"
                      />
                    </td>
                    <td class="tools">
                      <button
                        type="button"
                        [attr.aria-label]="t.remove(i.name || t.unnamed)"
                        [title]="t.remove(i.name || t.unnamed)"
                        (click)="remove(i.id)"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
          <button type="button" class="add" (click)="add('index')">+ {{ t.addIndex }}</button>

          <h3 id="st-keys">{{ t.foreignKeys }}</h3>
          @if (e.keys.length > 0) {
            <table aria-labelledby="st-keys">
              <thead>
                <tr>
                  <th scope="col">{{ t.name }}</th>
                  <th scope="col">{{ t.indexColumns }}</th>
                  <th scope="col">{{ t.refTable }}</th>
                  <th scope="col">{{ t.refColumns }}</th>
                  <th scope="col"><span class="sr">…</span></th>
                </tr>
              </thead>
              <tbody>
                @for (k of e.keys; track k.id) {
                  <tr>
                    <td>
                      <input
                        #kn
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        [attr.aria-label]="t.name"
                        [value]="k.name"
                        (input)="key(k.id, { name: kn.value })"
                      />
                    </td>
                    <td>
                      <input
                        #kc
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        [attr.aria-label]="t.indexColumns"
                        [value]="k.columns"
                        (input)="key(k.id, { columns: kc.value })"
                      />
                    </td>
                    <td>
                      <input
                        #kt
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        [attr.aria-label]="t.refTable"
                        [value]="k.refTable"
                        (input)="key(k.id, { refTable: kt.value })"
                      />
                    </td>
                    <td>
                      <input
                        #kr
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        [attr.aria-label]="t.refColumns"
                        [value]="k.refColumns"
                        (input)="key(k.id, { refColumns: kr.value })"
                      />
                    </td>
                    <td class="tools">
                      <button
                        type="button"
                        [attr.aria-label]="t.remove(k.name || t.unnamed)"
                        [title]="t.remove(k.name || t.unnamed)"
                        (click)="remove(k.id)"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
          <button type="button" class="add" (click)="add('key')">+ {{ t.addKey }}</button>

          <h3 id="st-checks">{{ t.checks }}</h3>
          @if (e.checks.length > 0) {
            <table aria-labelledby="st-checks">
              <thead>
                <tr>
                  <th scope="col">{{ t.name }}</th>
                  <th scope="col">{{ t.expression }}</th>
                  <th scope="col"><span class="sr">…</span></th>
                </tr>
              </thead>
              <tbody>
                @for (c of e.checks; track c.id) {
                  <tr>
                    <td>
                      <input
                        #chn
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        [attr.aria-label]="t.name"
                        [value]="c.name"
                        (input)="check(c.id, { name: chn.value })"
                      />
                    </td>
                    <td>
                      <input
                        #cht
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        [attr.aria-label]="t.expression"
                        [value]="c.text"
                        (input)="check(c.id, { text: cht.value })"
                      />
                    </td>
                    <td class="tools">
                      <button
                        type="button"
                        [attr.aria-label]="t.remove(c.name || t.unnamed)"
                        [title]="t.remove(c.name || t.unnamed)"
                        (click)="remove(c.id)"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
          <button type="button" class="add" (click)="add('check')">+ {{ t.addCheck }}</button>
          <datalist [id]="uid + '-types'">
            @for (type of types(); track type) {
              <option [value]="type"></option>
            }
          </datalist>
        </div>
        <p class="status" role="status">
          @if (planError()) {
            <span class="warn">{{ planError() }}</span>
          } @else if (problem(); as why) {
            {{ t.problems[why] }}
          }
        </p>
        <div class="buttons">
          <span class="grow"></span>
          <button type="button" (click)="close()">{{ t.cancel }}</button>
          <button
            type="button"
            class="primary"
            [disabled]="!writable() || problem() !== null || planning()"
            (click)="preview()"
          >
            {{ t.preview }}
          </button>
        </div>
      }
    </dialog>
  `,
  styles: `
    dialog {
      width: min(920px, calc(100vw - 32px));
      height: min(760px, calc(100vh - 32px));
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
      margin: 14px 0 4px;
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding-right: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      padding: 2px 4px;
      text-align: left;
      font-weight: normal;
      font-size: 12px;
      color: var(--text-dim);
    }
    td {
      padding: 1px 4px 1px 0;
    }
    td input[type='text'] {
      width: 100%;
      min-width: 60px;
    }
    td.box {
      width: 70px;
      text-align: center;
    }
    td.tools {
      width: 1%;
      white-space: nowrap;
    }
    td.tools button {
      padding: 0 6px;
      color: var(--text-dim);
    }
    td.tools button:hover:not(:disabled) {
      color: var(--text);
    }
    .fixed {
      color: var(--text-dim);
      font-size: 12px;
    }
    .table-name,
    .copy {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .table-name input {
      flex: 1;
      max-width: 320px;
    }
    .copy {
      flex-wrap: wrap;
      margin: 8px 0;
    }
    .copy .check {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-basis: 100%;
    }
    .add {
      margin-top: 4px;
      padding: 1px 8px;
      color: var(--text-dim);
      font-size: 12px;
    }
    .add:hover {
      color: var(--text);
    }
    .ops,
    .steps {
      margin: 0;
      padding-left: 22px;
    }
    .ops li {
      margin: 1px 0;
    }
    .ops .detail {
      margin-left: 6px;
      color: var(--text-dim);
      overflow-wrap: anywhere;
    }
    .steps li {
      margin: 4px 0;
      padding: 2px 6px;
      border-left: 3px solid transparent;
    }
    .steps li.danger {
      border-left-color: var(--danger);
    }
    .steps li.remark {
      color: var(--text-dim);
    }
    .why {
      margin: 0 0 2px;
      font-size: 12px;
    }
    .badge {
      padding: 0 6px;
      border-radius: var(--radius);
      background: var(--danger);
      color: var(--bg-app);
      font-weight: 600;
    }
    .badge.quiet {
      background: var(--border);
      color: var(--text);
    }
    pre {
      margin: 0;
      font-family: var(--font-mono, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .note,
    .status {
      margin: 6px 0;
      color: var(--text-dim);
      font-size: 12px;
    }
    .status {
      flex: none;
      min-height: 16px;
    }
    .warn {
      color: var(--danger);
    }
    .understood {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 8px 0;
    }
    .outcome {
      margin-top: 8px;
      padding: 6px 8px;
      border: 1px solid var(--danger);
      border-radius: var(--radius);
    }
    .outcome p {
      margin: 2px 0;
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
    .buttons button {
      padding: 4px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-text);
    }
    button.primary.destructive {
      background: var(--danger);
      border-color: var(--danger);
      color: var(--bg-app);
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
export class StructureDialog {
  readonly target = input.required<StructTarget>();
  readonly closed = output<void>();

  private readonly api = inject(StructureApi);
  private readonly service = inject(StructureService);
  private readonly connections = inject(ConnectionsStore);
  private readonly tabs = inject(TabsStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly t = STRUCTURE_TEXTS;
  protected readonly uid = `st-${Math.random().toString(36).slice(2, 8)}`;

  /** The table as it was read; `null` for a new one. */
  protected readonly loaded = signal<TableDef | null>(null);
  protected readonly edited = signal<EditedTable | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadError = signal('');
  /** The statements of what is asked for; `null`: the form is shown. */
  protected readonly plan = signal<StructPlan | null>(null);
  private request: StructRequest | null = null;
  protected readonly planning = signal(false);
  protected readonly planError = signal('');
  protected readonly understood = signal(false);
  protected readonly running = signal(false);
  protected readonly outcome = signal<RunOutcome | null>(null);
  protected readonly copyName = signal('');
  protected readonly copyData = signal(false);
  private asked = 0;

  protected readonly writable = computed(() => this.service.canWrite(this.target().connectionId));
  private readonly kind = computed(
    () =>
      this.connections.profiles().find((p) => p.id === this.target().connectionId)?.kind ??
      'sqlite',
  );
  protected readonly types = computed(() => typeSuggestions(this.kind()));
  protected readonly title = computed(() => {
    const target = this.target();
    const table = target.table ?? '';
    switch (target.mode) {
      case 'drop':
        return this.t.dropTitle(table);
      case 'truncate':
        return this.t.truncateTitle(table);
      case 'duplicate':
        return this.t.duplicateTitle(table);
      default:
        return target.table === null ? this.t.newTitle(target.schema) : this.t.editTitle(table);
    }
  });
  /** There is a form to go back to (editing, copying) – not when a table is dropped or emptied. */
  protected readonly form = computed(
    () => this.target().mode === 'edit' || this.target().mode === 'duplicate',
  );
  protected readonly problem = computed(() => {
    const e = this.edited();
    return e ? problemOf(e) : null;
  });
  protected readonly ops = computed(() => {
    const e = this.edited();
    return this.target().mode === 'edit' && e ? operations(this.loaded(), e) : [];
  });
  protected readonly statements = computed(() => {
    const p = this.plan();
    return p ? statementsOf(p) : [];
  });
  protected readonly dangerous = computed(() => {
    const p = this.plan();
    return !!p && hasDanger(p);
  });
  protected readonly canRun = computed(
    () =>
      this.writable() &&
      !this.running() &&
      !this.plan()?.incomplete &&
      this.statements().length > 0 &&
      (!this.dangerous() || this.understood()),
  );
  protected readonly failedMessage = computed(() => {
    const o = this.outcome();
    return o?.kind === 'failed' && o.ran.error ? describeError(o.ran.error) : '';
  });

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    effect(() => {
      const target = this.target();
      untracked(() => void this.start(target));
    });
  }

  private async start(target: StructTarget): Promise<void> {
    const asked = ++this.asked;
    this.plan.set(null);
    this.outcome.set(null);
    this.loadError.set('');
    this.planError.set('');
    this.understood.set(false);
    if (target.mode === 'drop' || target.mode === 'truncate') {
      this.loading.set(true);
      await this.ask({ kind: target.mode, schema: target.schema, table: target.table ?? '' });
      if (asked === this.asked) {
        this.loading.set(false);
        if (this.planError()) this.loadError.set(this.planError());
      }
      return;
    }
    if (target.table === null) {
      this.loaded.set(null);
      this.edited.set(emptyTable(this.kind()));
      return;
    }
    this.loading.set(true);
    try {
      const table = await this.api.load(target.connectionId, target.schema, target.table);
      if (asked !== this.asked) return;
      this.loaded.set(table);
      this.edited.set(fromTable(table));
      this.copyName.set(`${table.name}_copy`);
    } catch (e) {
      if (asked === this.asked) this.loadError.set(describeError(e));
    } finally {
      if (asked === this.asked) this.loading.set(false);
    }
  }

  /** Asks the backend for the statements of a request and shows them. */
  private async ask(request: StructRequest): Promise<void> {
    const asked = this.asked;
    this.planning.set(true);
    this.planError.set('');
    try {
      const plan = await this.api.plan(this.target().connectionId, request);
      if (asked !== this.asked) return;
      this.request = request;
      this.understood.set(false);
      this.outcome.set(null);
      this.plan.set(plan);
    } catch (e) {
      if (asked === this.asked) this.planError.set(describeError(e));
    } finally {
      if (asked === this.asked) this.planning.set(false);
    }
  }

  protected preview(): void {
    const target = this.target();
    const loaded = this.loaded();
    if (target.mode === 'duplicate') {
      if (!loaded) return;
      void this.ask({
        kind: 'duplicate',
        schema: target.schema,
        table: loaded,
        name: this.copyName().trim(),
        data: this.copyData(),
      });
      return;
    }
    const edited = this.edited();
    if (!edited || problemOf(edited) !== null) return;
    void this.ask(requestOf(target.schema, loaded, edited));
  }

  protected back(): void {
    this.plan.set(null);
    this.outcome.set(null);
  }

  /** The statement of an index that is only its statement (not a list of columns); `''`: it is none. */
  protected statementOnly(index: EditedIndex): string {
    return index.columns === '' ? (index.was?.definition ?? '') : '';
  }

  protected patch(change: Partial<EditedTable>): void {
    this.edited.update((e) => (e ? { ...e, ...change } : e));
  }

  protected column(id: number, change: Parameters<typeof setColumn>[2]): void {
    this.edited.update((e) => (e ? setColumn(e, id, change) : e));
  }

  protected index(id: number, change: { name?: string; columns?: string; unique?: boolean }) {
    this.edited.update((e) =>
      e ? { ...e, indexes: e.indexes.map((i) => (i.id === id ? { ...i, ...change } : i)) } : e,
    );
  }

  protected key(
    id: number,
    change: { name?: string; columns?: string; refTable?: string; refColumns?: string },
  ): void {
    this.edited.update((e) =>
      e ? { ...e, keys: e.keys.map((k) => (k.id === id ? { ...k, ...change } : k)) } : e,
    );
  }

  protected check(id: number, change: { name?: string; text?: string }): void {
    this.edited.update((e) =>
      e ? { ...e, checks: e.checks.map((c) => (c.id === id ? { ...c, ...change } : c)) } : e,
    );
  }

  protected add(what: 'column' | 'index' | 'key' | 'check'): void {
    const make = { column: addColumn, index: addIndex, key: addKey, check: addCheck }[what];
    this.edited.update((e) => (e ? make(e) : e));
  }

  protected remove(id: number): void {
    this.edited.update((e) => (e ? removeRow(e, id) : e));
  }

  protected move(id: number, step: 1 | -1): void {
    this.edited.update((e) => (e ? moveColumn(e, id, step) : e));
  }

  protected async run(): Promise<void> {
    const plan = this.plan();
    const request = this.request;
    if (!plan || !request || !this.canRun()) return;
    this.running.set(true);
    this.outcome.set(null);
    const outcome = await this.service.run(this.target().connectionId, request, plan);
    this.running.set(false);
    if (outcome.kind === 'done') {
      this.tabs.notice.set(this.t.done(outcome.statements));
      this.closed.emit();
      return;
    }
    if (outcome.kind !== 'declined') this.outcome.set(outcome);
  }

  protected toEditor(): void {
    const plan = this.plan();
    if (!plan) return;
    this.service.openScript(this.target().connectionId, plan, this.t.scriptHeader(this.title()));
    this.closed.emit();
  }

  protected close(): void {
    if (this.running()) return;
    this.asked++;
    this.closed.emit();
  }
}
