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
import { AccessDanger, Principal, Who } from '../../core/access/access-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { SchemaApi } from '../../core/schema/schema-api';
import {
  MatrixCell,
  MatrixRow,
  cellChange,
  levelsOf,
  listed,
  matrix,
  nameProblem,
  objectName,
  privilegesOf,
  sameWho,
  sortedGrants,
  travelAsVerifier,
} from './access-logic';
import { ACCESS_TEXTS } from './access-texts';
import { AccessService } from './access.service';

/** The small form that is open inside the dialog. */
type Form = 'user' | 'role' | 'password' | 'grant' | null;

/**
 * Users, roles and their rights (prompt 047): on the left who there is, on the right what the chosen one
 * is and may do – as a matrix of the tables of a schema and as the list of all its rights with where each
 * comes from –, below the changes that wait as the statements the backend writes for them. Names of
 * users, roles and objects are text of the server and shown as text. A password is typed here, handed to
 * the service with its change and never shown again.
 */
@Component({
  selector: 'app-access-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="ac-title" (cancel)="$event.preventDefault(); closed.emit()">
      <h2 id="ac-title">{{ t.title(connectionName()) }}</h2>
      @if (access.problem()) {
        <p class="warn" role="alert">{{ access.problem() }}</p>
      }
      @if (list(); as a) {
        @if (!a.canManage) {
          <p class="note">{{ t.readOnly }}</p>
        } @else if (!access.canChange()) {
          <p class="note">{{ t.protectedConnection }}</p>
        }
        @for (m of a.missing; track $index) {
          <p class="warn">{{ t.missing(partName(m.part), m.reason) }}</p>
        }
      }
      <div class="main">
        <div class="who">
          <input
            #filter
            type="search"
            spellcheck="false"
            autocomplete="off"
            [attr.aria-label]="t.filter"
            [placeholder]="t.filter"
            (input)="text.set(filter.value)"
          />
          <ul role="listbox" [attr.aria-label]="t.principals">
            @for (p of principals(); track p.label) {
              <li
                role="option"
                tabindex="0"
                [class.chosen]="isSelected(p)"
                [attr.aria-selected]="isSelected(p)"
                (click)="access.select(p.who)"
                (keydown.enter)="access.select(p.who)"
                (keydown.space)="$event.preventDefault(); access.select(p.who)"
              >
                <span class="name">{{ p.label }}</span>
                <span class="tag">{{ p.login ? t.user : t.role }}</span>
                @if (p.me) {
                  <span class="tag">{{ t.you }}</span>
                }
                @if (p.superuser) {
                  <span class="tag danger">{{ t.superuser }}</span>
                }
              </li>
            }
          </ul>
          <div class="row">
            <button type="button" [disabled]="access.busy()" (click)="access.reload()">
              {{ t.reload }}
            </button>
            @if (access.canChange()) {
              <button type="button" (click)="open('user')">{{ t.newUser }}</button>
              <button type="button" (click)="open('role')">{{ t.newRole }}</button>
            }
          </div>
        </div>
        <div class="what">
          @if (chosen(); as p) {
            <div class="head">
              <strong>{{ p.label }}</strong>
              <span class="tag">{{ p.login ? t.user : t.role }}</span>
              @for (a of plainAttributes(p); track a) {
                <span class="tag">{{ a }}</span>
              }
              <span class="grow"></span>
              <button type="button" (click)="access.script(p.who)">{{ t.script }}</button>
              @if (access.canChange()) {
                <select
                  #like
                  [attr.aria-label]="t.like"
                  (change)="likeOf(like.value); like.value = ''"
                >
                  <option value="">{{ t.like }}</option>
                  @for (o of others(); track o.label) {
                    <option [value]="o.label">{{ o.label }}</option>
                  }
                </select>
                @if (p.login) {
                  <button type="button" (click)="open('password')">{{ t.setPassword }}</button>
                }
                <button type="button" class="destructive" (click)="drop(p)">{{ t.drop }}</button>
              }
            </div>
            @if (kind() === 'postgres') {
              <div class="row" role="group" [attr.aria-label]="t.attributes">
                @for (a of attributes; track a) {
                  <label>
                    <input
                      #box
                      type="checkbox"
                      [checked]="hasAttribute(p, a)"
                      [disabled]="!access.canChange()"
                      (change)="setAttribute(p, a, box.checked)"
                    />
                    {{ t.attributeNames[a] }}
                  </label>
                }
              </div>
            }
            <div class="row">
              <span class="dim">{{ t.memberOf }}</span>
              @for (r of p.memberOf; track r) {
                <span class="tag">
                  {{ r }}
                  @if (access.canChange()) {
                    <button
                      type="button"
                      class="x"
                      [title]="t.leaveRole(r)"
                      [attr.aria-label]="t.leaveRole(r)"
                      (click)="member(p, r, false)"
                    >
                      ×
                    </button>
                  }
                </span>
              } @empty {
                <span class="dim">{{ t.noRoles }}</span>
              }
              @if (access.canChange()) {
                <select
                  #role
                  [attr.aria-label]="t.addRole"
                  (change)="member(p, role.value, true); role.value = ''"
                >
                  <option value="">{{ t.addRole }}</option>
                  @for (o of joinable(); track o.label) {
                    <option [value]="o.label">{{ o.label }}</option>
                  }
                </select>
              }
            </div>
            @if (form(); as f) {
              @if (f === 'password') {
                <form class="form" (submit)="$event.preventDefault(); submitPassword(p, pw.value)">
                  <label>
                    {{ t.password }}
                    <input #pw type="password" autocomplete="new-password" />
                  </label>
                  <button type="submit">{{ t.add }}</button>
                  <button type="button" (click)="form.set(null)">{{ t.cancel }}</button>
                  <span class="dim">{{ t.passwordHint }}</span>
                </form>
              }
              @if (f === 'grant') {
                <form
                  class="form"
                  (submit)="
                    $event.preventDefault();
                    submitGrant(p, gs.value, go.value, gc.value, gp.value, gg.checked)
                  "
                >
                  <label>
                    {{ t.level }}
                    <select #gl (change)="grantLevel.set(gl.value)">
                      @for (l of levels(); track l) {
                        <option [value]="l" [selected]="grantLevel() === l">
                          {{ levelName(l) }}
                        </option>
                      }
                    </select>
                  </label>
                  <label [hidden]="!needs('schema')">
                    {{ t.schema }}
                    <input #gs type="text" spellcheck="false" autocomplete="off" />
                  </label>
                  <label [hidden]="!needs('object')">
                    {{ t.object }}
                    <input #go type="text" spellcheck="false" autocomplete="off" />
                  </label>
                  <label [hidden]="!needs('column')">
                    {{ t.levels.column }}
                    <input #gc type="text" spellcheck="false" autocomplete="off" />
                  </label>
                  <label>
                    {{ t.privilege }}
                    <select #gp>
                      @for (x of grantPrivileges(); track x) {
                        <option [value]="x">{{ x }}</option>
                      }
                    </select>
                  </label>
                  <label><input #gg type="checkbox" /> {{ t.withGrantOption }}</label>
                  <button type="submit">{{ t.add }}</button>
                  <button type="button" (click)="form.set(null)">{{ t.cancel }}</button>
                </form>
              }
            }
            <div class="row" role="tablist">
              <button
                type="button"
                role="tab"
                [attr.aria-selected]="tab() === 'matrix'"
                [class.on]="tab() === 'matrix'"
                (click)="tab.set('matrix')"
              >
                {{ t.tabs.matrix }}
              </button>
              <button
                type="button"
                role="tab"
                [attr.aria-selected]="tab() === 'all'"
                [class.on]="tab() === 'all'"
                (click)="tab.set('all')"
              >
                {{ t.tabs.all }}
              </button>
              @if (tab() === 'matrix') {
                <label>
                  {{ t.schema }}
                  <select #sc (change)="schema.set(sc.value)">
                    @for (s of schemas(); track s) {
                      <option [value]="s" [selected]="schema() === s">{{ s }}</option>
                    }
                  </select>
                </label>
              } @else {
                <input
                  #gf
                  type="search"
                  spellcheck="false"
                  autocomplete="off"
                  [attr.aria-label]="t.filterGrants"
                  [placeholder]="t.filterGrants"
                  (input)="grantText.set(gf.value)"
                />
                <span class="dim">{{ t.grantCount(grants().length) }}</span>
              }
              <span class="grow"></span>
              @if (access.canChange()) {
                <button type="button" (click)="open('grant')">{{ t.addGrant }}</button>
              }
            </div>
            @if (kind() === 'mysql' && p.memberOf.length > 0) {
              <p class="note">{{ t.roleNote }}</p>
            }
            @for (m of access.grants()?.missing ?? []; track $index) {
              <p class="warn">{{ t.missing(partName(m.part), m.reason) }}</p>
            }
            <div class="table">
              @if (access.grants() === null) {
                <p class="note">{{ t.reading }}</p>
              } @else if (tab() === 'matrix') {
                @if (rows().length === 0) {
                  <p class="note">{{ t.noTables }}</p>
                } @else {
                  <table class="matrix">
                    <thead>
                      <tr>
                        <th scope="col">{{ t.object }}</th>
                        @for (x of tablePrivileges(); track x) {
                          <th scope="col" class="p">{{ x }}</th>
                        }
                      </tr>
                    </thead>
                    <tbody>
                      @for (r of rows(); track r.object) {
                        <tr>
                          <th scope="row">
                            {{ r.object }}
                            @if (r.owner) {
                              <span class="tag">{{ t.owner }}</span>
                            }
                          </th>
                          @for (c of r.cells; track c.privilege) {
                            <td
                              class="p"
                              [class.changed]="c.planned !== null"
                              [class.inherited]="c.via.length > 0"
                              [title]="cellTitle(c)"
                            >
                              <input
                                #cell
                                type="checkbox"
                                [checked]="c.planned ?? c.direct"
                                [disabled]="!access.canChange()"
                                [attr.aria-label]="t.cellLabel(c.privilege, r.object)"
                                (change)="toggle(p, r, c)"
                              />
                              @if (c.via.length > 0) {
                                <span class="via" aria-hidden="true">↑</span>
                              }
                            </td>
                          }
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              } @else {
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{{ t.level }}</th>
                      <th scope="col">{{ t.object }}</th>
                      <th scope="col">{{ t.privilege }}</th>
                      <th scope="col">{{ t.origin }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (g of grants(); track $index) {
                      <tr [class.inherited]="g.via !== ''">
                        <td>{{ levelName(g.level) }}</td>
                        <td>{{ nameOf(g) }}</td>
                        <td>
                          {{ g.privilege }}
                          @if (g.grantable && g.privilege !== 'OWNER') {
                            <span class="tag">{{ t.grantable }}</span>
                          }
                        </td>
                        <td>{{ g.via === '' ? t.own : g.via }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
                @if (access.grants()?.cut) {
                  <p class="note">{{ t.cut }}</p>
                }
              }
            </div>
          } @else {
            <p class="note">{{ access.busy() ? t.reading : t.noSelection }}</p>
          }
          @if (form() === 'user' || form() === 'role') {
            <form
              class="form"
              (submit)="$event.preventDefault(); submitNew(nn.value, nh.value, np.value)"
            >
              <label>
                {{ t.name }}
                <input #nn type="text" spellcheck="false" autocomplete="off" />
              </label>
              <label [hidden]="kind() !== 'mysql'">
                {{ t.host }}
                <input
                  #nh
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                  [value]="defaultHost()"
                />
              </label>
              <label [hidden]="form() !== 'user'">
                {{ t.password }}
                <input #np type="password" autocomplete="new-password" />
              </label>
              <button type="submit">{{ t.add }}</button>
              <button type="button" (click)="form.set(null)">{{ t.cancel }}</button>
              @if (formProblem()) {
                <span class="warn" role="alert">{{ formProblem() }}</span>
              }
            </form>
          }
        </div>
      </div>
      <section class="changes" [attr.aria-label]="t.changes">
        <h3>{{ t.changes }}</h3>
        @if (access.planProblem()) {
          <p class="warn" role="alert">{{ access.planProblem() }}</p>
        }
        @if (access.plan(); as plan) {
          <ol>
            @for (s of plan.steps; track $index) {
              <li>
                <code>{{ s.sql }}</code>
                @for (d of s.dangers; track d) {
                  <span class="tag danger">{{ dangerName(d) }}</span>
                }
                @if (isLast(plan.steps, $index)) {
                  <button
                    type="button"
                    class="x"
                    [title]="t.remove"
                    [attr.aria-label]="t.remove"
                    [disabled]="access.running()"
                    (click)="access.unqueue(s.change)"
                  >
                    ×
                  </button>
                }
              </li>
            }
          </ol>
          <p class="note">
            {{ plan.transactional ? t.inTransaction : t.notInTransaction }}
            @if (hasSecret()) {
              {{ plan.hidesPassword && asVerifier() ? t.notLogged : t.logged }}
            }
          </p>
        } @else if (access.pending().length === 0) {
          <p class="note">{{ t.noChanges }}</p>
        }
        @if (access.note()) {
          <p class="note" role="status">{{ access.note() }}</p>
        }
      </section>
      <div class="buttons">
        @if (access.pending().length > 0) {
          <button type="button" [disabled]="access.running()" (click)="access.clear()">
            {{ t.clear }}
          </button>
        }
        <span class="grow"></span>
        @if (access.plan(); as plan) {
          <button
            type="button"
            class="primary"
            [disabled]="access.running() || access.planning() || !access.canChange()"
            (click)="access.apply()"
          >
            {{ t.apply(plan.steps.length) }}
          </button>
        }
        <button type="button" (click)="closed.emit()">{{ t.close }}</button>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(1180px, calc(100vw - 32px));
      height: min(800px, calc(100vh - 32px));
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
    h2,
    h3 {
      flex: none;
      margin: 0;
      font-size: 14px;
    }
    h3 {
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .main {
      flex: 1;
      min-height: 0;
      display: flex;
      gap: 12px;
    }
    .who {
      flex: none;
      width: 270px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .who ul {
      flex: 1;
      min-height: 0;
      margin: 0;
      padding: 0;
      overflow: auto;
      list-style: none;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    .who li {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      cursor: default;
    }
    .who li.chosen {
      background: var(--bg-selected, var(--border));
    }
    .name {
      overflow-wrap: anywhere;
    }
    .what {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .head,
    .row,
    .form,
    .buttons {
      flex: none;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 10px;
    }
    .form {
      padding: 6px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    label {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    label[hidden] {
      display: none;
    }
    .grow {
      flex: 1;
    }
    .dim {
      color: var(--text-dim);
      font-size: 12px;
    }
    .tag {
      padding: 0 5px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text-dim);
      font-size: 11px;
      white-space: nowrap;
    }
    .tag.danger {
      border-color: var(--danger);
      color: var(--danger);
    }
    .table {
      flex: 1;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    table {
      border-collapse: collapse;
      font-size: 12px;
    }
    table:not(.matrix) {
      width: 100%;
    }
    thead th {
      position: sticky;
      top: 0;
      background: var(--bg-panel);
      color: var(--text-dim);
      font-weight: normal;
      white-space: nowrap;
    }
    th,
    td {
      padding: 1px 8px;
      text-align: left;
      vertical-align: top;
    }
    tbody th {
      font-weight: normal;
      white-space: nowrap;
    }
    .p {
      text-align: center;
      white-space: nowrap;
    }
    td.changed {
      background: color-mix(in srgb, var(--accent) 22%, transparent);
    }
    .via {
      color: var(--text-dim);
    }
    tr.inherited td {
      color: var(--text-dim);
    }
    .changes {
      flex: none;
      max-height: 190px;
      overflow: auto;
    }
    ol {
      margin: 2px 0;
      padding-left: 24px;
    }
    ol li {
      margin: 1px 0;
    }
    code {
      font-family: var(--font-mono, monospace);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .note,
    .warn {
      flex: none;
      margin: 0;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .note {
      color: var(--text-dim);
    }
    .warn {
      color: var(--danger);
    }
    .table .note {
      padding: 6px 8px;
    }
    button:not(.x) {
      padding: 3px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    button.x {
      padding: 0 4px;
      color: var(--text-dim);
    }
    button.on {
      border-color: var(--accent);
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-text);
    }
    button.destructive {
      border-color: var(--danger);
      color: var(--danger);
    }
    button:disabled {
      opacity: 0.5;
    }
    .who input[type='search'] {
      width: 100%;
    }
  `,
})
export class AccessDialog {
  readonly connectionId = input.required<string>();
  readonly closed = output<void>();

  protected readonly access = inject(AccessService);
  private readonly store = inject(ConnectionsStore);
  private readonly schemaApi = inject(SchemaApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly t = ACCESS_TEXTS;
  protected readonly attributes = [
    'login',
    'createdb',
    'createrole',
    'replication',
    'superuser',
  ] as const;
  protected readonly text = signal('');
  protected readonly grantText = signal('');
  protected readonly tab = signal<'matrix' | 'all'>('matrix');
  protected readonly form = signal<Form>(null);
  protected readonly formProblem = signal('');
  protected readonly grantLevel = signal('table');
  protected readonly schema = signal('');
  protected readonly schemas = signal<readonly string[]>([]);
  private readonly tables = signal<readonly string[]>([]);

  protected readonly list = this.access.access;
  protected readonly profile = computed(
    () => this.store.profiles().find((p) => p.id === this.connectionId()) ?? null,
  );
  protected readonly connectionName = computed(() => this.profile()?.name ?? '');
  protected readonly kind = computed(() => this.profile()?.kind ?? 'postgres');
  protected readonly principals = computed(() =>
    listed(this.list()?.principals ?? [], this.text()),
  );
  protected readonly chosen = computed(() => {
    const who = this.access.selected();
    return (who && this.list()?.principals.find((p) => sameWho(p.who, who))) || null;
  });
  protected readonly others = computed(() => {
    const me = this.chosen();
    return (this.list()?.principals ?? []).filter((p) => p !== me);
  });
  /** The roles the chosen one can be put into: roles it is not in, and not itself. */
  protected readonly joinable = computed(() => {
    const me = this.chosen();
    return this.others().filter((p) => !p.login && !me?.memberOf.includes(p.label));
  });
  protected readonly tablePrivileges = computed(() => privilegesOf(this.kind(), 'table'));
  protected readonly rows = computed<MatrixRow[]>(() => {
    const who = this.access.selected();
    const grants = this.access.grants();
    if (!who || !grants) return [];
    return matrix(
      who,
      this.schema(),
      this.tables(),
      this.tablePrivileges(),
      grants.grants,
      this.access.pending(),
    );
  });
  protected readonly grants = computed(() =>
    sortedGrants(this.access.grants()?.grants ?? [], this.grantText()),
  );
  protected readonly levels = computed(() => levelsOf(this.kind()));
  protected readonly grantPrivileges = computed(() => privilegesOf(this.kind(), this.grantLevel()));
  protected readonly asVerifier = computed(() => travelAsVerifier(this.access.pending()));
  protected readonly hasSecret = computed(
    () => this.access.plan()?.steps.some((s) => s.secret) ?? false,
  );

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    effect(() => {
      const id = this.connectionId();
      untracked(() => void this.loadSchemas(id));
    });
    effect(() => {
      const id = this.connectionId();
      const schema = this.schema();
      untracked(() => void this.loadTables(id, schema));
    });
  }

  private async loadSchemas(id: string): Promise<void> {
    try {
      const all = await this.schemaApi.schemas(id);
      const own = all.filter((s) => !s.system);
      this.schemas.set(own.map((s) => s.name));
      this.schema.set((own.find((s) => s.current) ?? own[0])?.name ?? '');
    } catch {
      this.schemas.set([]);
    }
  }

  private async loadTables(id: string, schema: string): Promise<void> {
    this.tables.set([]);
    if (schema === '') return;
    try {
      const objects = await this.schemaApi.objects(id, schema);
      if (this.schema() !== schema) return;
      this.tables.set(
        objects.filter((o) => o.kind === 'table' || o.kind === 'view').map((o) => o.name),
      );
    } catch {
      this.tables.set([]);
    }
  }

  protected isSelected(p: Principal): boolean {
    const who = this.access.selected();
    return who !== null && sameWho(p.who, who);
  }

  protected partName(part: string): string {
    return (this.t.parts as Record<string, string>)[part] ?? part;
  }

  protected levelName(level: string): string {
    return (this.t.levels as Record<string, string>)[level] ?? level;
  }

  protected dangerName(danger: AccessDanger): string {
    return this.t.dangers[danger] ?? danger;
  }

  protected nameOf = objectName;

  /** The attributes that have no checkbox of their own. */
  protected plainAttributes(p: Principal): string[] {
    const boxes: readonly string[] = this.attributes;
    return p.attributes.filter((a) => this.kind() !== 'postgres' || !boxes.includes(a));
  }

  protected hasAttribute(p: Principal, attribute: string): boolean {
    return attribute === 'login' ? p.login : p.attributes.includes(attribute);
  }

  protected cellTitle(c: MatrixCell): string {
    return c.via.length > 0 ? this.t.viaHint(c.via.join(', ')) : '';
  }

  /** Whether a step is the last one of its change: there the change can be taken back. */
  protected isLast(steps: readonly { change: number }[], index: number): boolean {
    return steps[index + 1]?.change !== steps[index].change;
  }

  protected needs(field: 'schema' | 'object' | 'column'): boolean {
    const level = this.grantLevel();
    if (field === 'column') return level === 'column';
    if (field === 'schema') return ['table', 'column', 'sequence'].includes(level);
    return level !== 'server' && !(level === 'database' && this.kind() === 'sqlserver');
  }

  protected defaultHost(): string {
    const product = this.store.capabilities(this.connectionId()).product;
    // a role of MariaDB has no host
    return this.form() === 'role' && product === 'MariaDB' ? '' : '%';
  }

  protected open(form: Form): void {
    this.formProblem.set('');
    this.form.set(this.form() === form ? null : form);
  }

  protected toggle(p: Principal, row: MatrixRow, cell: MatrixCell): void {
    this.access.queue(cellChange(p.who, row, cell));
  }

  protected setAttribute(p: Principal, attribute: string, on: boolean): void {
    this.access.queue({ op: 'attribute', who: p.who, attribute, on });
  }

  protected member(p: Principal, roleLabel: string, add: boolean): void {
    const role = this.list()?.principals.find((x) => x.label === roleLabel);
    if (role) this.access.queue({ op: 'member', role: role.who, member: p.who, add });
  }

  protected likeOf(label: string): void {
    const source = this.list()?.principals.find((x) => x.label === label);
    if (source) void this.access.like(source.who);
  }

  protected drop(p: Principal): void {
    this.access.queue({ op: 'drop', who: p.who, role: !p.login });
  }

  protected submitPassword(p: Principal, password: string): void {
    if (password === '') return;
    this.access.queue({ op: 'password', who: p.who }, password);
    this.form.set(null);
  }

  protected submitNew(name: string, host: string, password: string): void {
    const problem = nameProblem(name);
    if (problem) {
      this.formProblem.set(problem === 'empty' ? this.t.nameEmpty : this.t.nameControl);
      return;
    }
    const login = this.form() === 'user';
    const who: Who = { name: name.trim(), host: this.kind() === 'mysql' ? host.trim() : '' };
    const withPassword = login && password !== '';
    // SQL Server makes a login only with a password; elsewhere a user may have none
    this.access.queue(
      { op: 'create', who, login, password: withPassword },
      withPassword ? password : null,
    );
    this.form.set(null);
  }

  protected submitGrant(
    p: Principal,
    schema: string,
    object: string,
    column: string,
    privilege: string,
    grantable: boolean,
  ): void {
    const level = this.grantLevel();
    this.access.queue({
      op: 'grant',
      who: p.who,
      level,
      schema: this.needs('schema') ? schema.trim() : '',
      object: this.needs('object') ? object.trim() : '',
      column: this.needs('column') ? column.trim() : '',
      privilege,
      grantable,
      add: true,
    });
    this.form.set(null);
  }
}
