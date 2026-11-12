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
import {
  BackupApi,
  BackupFileKind,
  BackupInfo,
  BackupTool,
  DumpContent,
  DumpFormat,
  DumpSpec,
  RestoreSpec,
} from '../../core/backup/backup-api';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError } from '../../core/errors/app-error';
import { locale } from '../../core/i18n/i18n';
import {
  DEFAULT_DUMP,
  DEFAULT_RESTORE,
  TOOL_NAMES,
  dumpTool,
  fileName,
  fitted,
  formatsOf,
  olderThanServer,
  restoreGate,
  restoreTool,
  saveFilters,
  sizeText,
  tool,
} from './backup-logic';
import { BACKUP_TEXTS } from './backup-texts';
import { BackupService, BackupTarget } from './backup.service';

/**
 * Backing up a database and restoring one (prompt 044), with the tools of the database: says whether
 * they are there (and where to get them), asks what to write, and shows what the tool says while it runs.
 * Paths come from the native dialogs. What the tool says is text of another program: shown as text.
 */
@Component({
  selector: 'app-backup-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="bk-title" (cancel)="$event.preventDefault(); close()">
      <h2 id="bk-title">{{ title() }}</h2>
      <div class="scroll">
        @if (job(); as j) {
          <h3 id="bk-out">{{ t.output }}</h3>
          <pre class="log" role="log" aria-labelledby="bk-out" tabindex="0">{{
            j.lines.join(
              '
'
            )
          }}</pre>
          <p class="status" role="status">
            @switch (j.state) {
              @case ('running') {
                {{ t.running }}
              }
              @case ('done') {
                <span [class.warn]="j.done?.warnings">
                  {{ j.done?.warnings ? t.doneWarnings : t.done(size(j.done?.bytes ?? 0)) }}
                </span>
              }
              @case ('stopped') {
                {{ t.stopped }}
              }
              @case ('failed') {
                <span class="warn">{{ t.failed }} {{ j.error }}</span>
              }
            }
          </p>
        } @else {
          @if (needed(); as which) {
            <section class="tool" [attr.aria-busy]="info() === null">
              @if (info() === null) {
                <p class="note">{{ t.checking }}</p>
              } @else if (found(); as f) {
                <p class="note">{{ names[which] }} – {{ t.found(f.version ?? '') }}</p>
                <!-- the program that will run, always: a version is only what it says of itself -->
                <p class="note program">{{ f.path }}</p>
                @if (older()) {
                  <p class="warn" role="alert">
                    {{ t.older(f.major ?? 0, info()?.serverMajor ?? 0) }}
                  </p>
                }
              } @else {
                <p class="warn" role="alert">{{ t.notFound(names[which]) }}</p>
                <p class="note">{{ hint() }}</p>
              }
              @if (info() !== null) {
                <label class="path">
                  {{ t.path(names[which]) }}
                  <input
                    #path
                    type="text"
                    spellcheck="false"
                    autocomplete="off"
                    [attr.aria-describedby]="'bk-path-hint'"
                    [value]="pathOf(which)"
                    (change)="setPath(which, path.value)"
                  />
                  <button type="button" (click)="check()">{{ t.checkAgain }}</button>
                </label>
                <p id="bk-path-hint" class="note">{{ t.pathHint }}</p>
              }
            </section>
          } @else if (noToolNote()) {
            <p class="note">{{ noToolNote() }}</p>
          }
          @if (problem()) {
            <p class="warn" role="alert">{{ problem() }}</p>
          }
          @if (target().mode === 'backup') {
            @if (needed()) {
              <fieldset [disabled]="!found()">
                <legend>{{ t.scope }}</legend>
                <p class="note">{{ scope() }}</p>
                <label>
                  {{ t.content }}
                  <select #content (change)="set({ content: asContent(content.value) })">
                    @for (c of contents; track c) {
                      <option [value]="c" [selected]="spec().content === c">
                        {{ t.contents[c] }}
                      </option>
                    }
                  </select>
                </label>
                <label>
                  {{ t.format }}
                  <select #format (change)="set({ format: asFormat(format.value) })">
                    @for (f of formats(); track f) {
                      <option [value]="f" [selected]="spec().format === f">
                        {{ t.formats[f] }}
                      </option>
                    }
                  </select>
                </label>
                @if (spec().format === 'sql') {
                  <label class="check">
                    <input
                      #gz
                      type="checkbox"
                      [checked]="spec().gzip"
                      (change)="set({ gzip: gz.checked })"
                    />
                    {{ t.gzip }}
                  </label>
                }
                @if (kind() === 'postgres') {
                  <label class="check">
                    <input
                      #no
                      type="checkbox"
                      [checked]="spec().noOwner"
                      (change)="set({ noOwner: no.checked })"
                    />
                    {{ t.noOwner }}
                  </label>
                }
                <label class="check">
                  <input
                    #ins
                    type="checkbox"
                    [checked]="spec().inserts"
                    (change)="set({ inserts: ins.checked })"
                  />
                  {{ t.inserts }}
                </label>
                <button type="button" class="primary" (click)="dump()">{{ t.start }}</button>
              </fieldset>
            }
            @if (kind() === 'sqlite') {
              <fieldset>
                <legend>{{ t.file }}</legend>
                <button type="button" class="primary" (click)="sqliteCopy()">
                  {{ t.sqliteCopy }}
                </button>
                @if (copied()) {
                  <p class="note" role="status">{{ copied() }}</p>
                }
              </fieldset>
            }
            <fieldset>
              <legend>{{ t.simple }}</legend>
              <p class="note">{{ t.simpleHint }}</p>
              @if (kind() !== 'sqlite') {
                <label>
                  {{ t.simpleSchema }}
                  <input
                    #schema
                    type="text"
                    spellcheck="false"
                    autocomplete="off"
                    [value]="simpleSchema()"
                    (input)="simpleSchema.set(schema.value)"
                  />
                </label>
              }
              <label class="check">
                <input
                  #sd
                  type="checkbox"
                  [checked]="simpleData()"
                  (change)="simpleData.set(sd.checked)"
                />
                {{ t.simpleData }}
              </label>
              <button type="button" (click)="simple()">{{ t.simpleStart }}</button>
            </fieldset>
          } @else {
            <fieldset [disabled]="gate() === 'readOnly'">
              <legend>{{ t.file }}</legend>
              <div class="row">
                <button type="button" (click)="choose(false)">{{ t.chooseFile }}</button>
                @if (kind() === 'postgres') {
                  <button type="button" (click)="choose(true)">{{ t.chooseFolder }}</button>
                }
              </div>
              @if (file(); as f) {
                <p class="note file">{{ f.path }} – {{ t.kinds[f.kind] }}</p>
                @if (!restoreWith()) {
                  <p class="warn" role="alert">{{ t.notForThis }}</p>
                }
              }
            </fieldset>
            @if (restoreWith()) {
              <fieldset [disabled]="gate() === 'readOnly' || !found()">
                <legend>{{ t.options }}</legend>
                @if (restoreWith() === 'pgRestore') {
                  <label class="check">
                    <input
                      #cl
                      type="checkbox"
                      [checked]="back().clean"
                      (change)="setBack({ clean: cl.checked })"
                    />
                    {{ t.clean }}
                  </label>
                  <label class="check">
                    <input
                      #ro
                      type="checkbox"
                      [checked]="back().noOwner"
                      (change)="setBack({ noOwner: ro.checked })"
                    />
                    {{ t.noOwner }}
                  </label>
                }
                @if (kind() === 'postgres') {
                  <label class="check">
                    <input
                      #tx
                      type="checkbox"
                      [checked]="back().singleTransaction"
                      (change)="setBack({ singleTransaction: tx.checked })"
                    />
                    {{ t.singleTransaction }}
                  </label>
                }
                <label class="check">
                  <input
                    #se
                    type="checkbox"
                    [checked]="back().stopOnError"
                    (change)="setBack({ stopOnError: se.checked })"
                  />
                  {{ t.stopOnError }}
                </label>
              </fieldset>
              <p class="warn">{{ t.writesInto(database(), connectionName()) }}</p>
              <p class="warn">{{ t.trustFile }}</p>
              @switch (protection()) {
                @case ('readonly') {
                  <p class="warn" role="alert">{{ t.readOnly }}</p>
                }
                @case ('ask') {
                  <label class="path">
                    {{ t.typeName(connectionName()) }}
                    <input
                      #typed
                      type="text"
                      autocomplete="off"
                      spellcheck="false"
                      [attr.aria-label]="t.typedName"
                      [value]="typedName()"
                      (input)="typedName.set(typed.value)"
                    />
                  </label>
                }
                @default {
                  <label class="check">
                    <input
                      #un
                      type="checkbox"
                      [checked]="understood()"
                      (change)="understood.set(un.checked)"
                    />
                    {{ t.understood }}
                  </label>
                }
              }
            }
          }
        }
      </div>
      <div class="buttons">
        <span class="grow"></span>
        @if (job()?.state === 'running') {
          <button type="button" (click)="service.cancel()">{{ t.stop }}</button>
        } @else {
          @if (target().mode === 'restore' && !job()) {
            <button
              type="button"
              class="primary destructive"
              [disabled]="!canRestore()"
              (click)="restore()"
            >
              {{ t.restore }}
            </button>
          }
          <button type="button" (click)="close()">{{ job() ? t.close : t.cancel }}</button>
        }
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(680px, calc(100vw - 32px));
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
      margin: 0 0 4px;
      font-size: 12px;
      color: var(--text-dim);
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
      gap: 5px;
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
    .path {
      flex-wrap: wrap;
    }
    .path input {
      flex: 1;
      min-width: 220px;
    }
    .row {
      display: flex;
      gap: 6px;
    }
    .note {
      margin: 0;
      color: var(--text-dim);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .file,
    .program {
      color: var(--text);
    }
    .warn {
      margin: 0;
      color: var(--danger);
      overflow-wrap: anywhere;
    }
    .log {
      flex: 1;
      min-height: 160px;
      max-height: 360px;
      margin: 0;
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
    .status {
      margin: 0;
      min-height: 18px;
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
    button.primary.destructive {
      background: var(--danger);
      border-color: var(--danger);
      color: var(--bg-app);
    }
    button:disabled,
    fieldset:disabled {
      opacity: 0.5;
    }
  `,
})
export class BackupDialog {
  readonly target = input.required<BackupTarget>();
  readonly closed = output<void>();

  private readonly api = inject(BackupApi);
  private readonly files = inject(FileDialogApi);
  private readonly connections = inject(ConnectionsStore);
  protected readonly service = inject(BackupService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly t = BACKUP_TEXTS;
  protected readonly names = TOOL_NAMES;
  protected readonly contents: readonly DumpContent[] = ['all', 'structure', 'data'];

  protected readonly job = this.service.job;
  /** What the backend found; `null` while it looks. */
  protected readonly info = signal<BackupInfo | null>(null);
  protected readonly problem = signal('');
  protected readonly spec = signal<DumpSpec>(DEFAULT_DUMP);
  protected readonly back = signal<RestoreSpec>(DEFAULT_RESTORE);
  protected readonly file = signal<{ path: string; kind: BackupFileKind } | null>(null);
  protected readonly typedName = signal('');
  protected readonly understood = signal(false);
  protected readonly simpleSchema = signal('');
  protected readonly simpleData = signal(true);
  protected readonly copied = signal('');
  private asked = 0;

  private readonly profile = computed(() =>
    this.connections.profiles().find((p) => p.id === this.target().connectionId),
  );
  protected readonly kind = computed(() => this.profile()?.kind ?? 'sqlite');
  protected readonly connectionName = computed(() => this.profile()?.name ?? '');
  protected readonly database = computed(() => this.profile()?.database ?? '');
  protected readonly protection = computed(() => this.profile()?.protection ?? 'free');
  protected readonly title = computed(() =>
    this.target().mode === 'backup'
      ? this.t.backupTitle(this.connectionName())
      : this.t.restoreTitle(this.connectionName()),
  );
  protected readonly formats = computed(() => formatsOf(this.kind()));
  /** The tool a restore of the chosen file needs; `null`: no file, or none fits. */
  protected readonly restoreWith = computed(() => {
    const file = this.file();
    return file ? restoreTool(this.kind(), file.kind) : null;
  });
  /** The tool this dialog is about right now. */
  protected readonly needed = computed<BackupTool | null>(() => {
    const kind = this.kind();
    if (this.target().mode === 'backup') return dumpTool(kind);
    // before a file is chosen: the tool that restores text
    return this.restoreWith() ?? (kind === 'postgres' ? 'psql' : kind === 'mysql' ? 'mysql' : null);
  });
  protected readonly found = computed(() => {
    const found = tool(this.info(), this.needed());
    return found?.path ? found : null;
  });
  protected readonly older = computed(() => olderThanServer(this.info(), this.needed()));
  protected readonly hint = computed(() =>
    this.kind() === 'mysql' ? this.t.whereToGet.mysql : this.t.whereToGet.postgres,
  );
  protected readonly noToolNote = computed(() => {
    const kind = this.kind();
    return kind === 'sqlserver'
      ? this.t.noTool.sqlserver
      : kind === 'sqlite'
        ? this.t.noTool.sqlite
        : '';
  });
  protected readonly scope = computed(() => {
    const s = this.spec();
    if (s.tables.length > 0) return this.t.onlyTables(s.tables.map((x) => x.table).join(', '));
    if (s.schemas.length > 0) return this.t.onlySchemas(s.schemas.join(', '));
    return this.t.wholeDatabase;
  });
  protected readonly gate = computed(() =>
    restoreGate(this.protection(), this.connectionName(), this.typedName(), this.understood()),
  );
  protected readonly canRestore = computed(
    () => !!this.file() && !!this.restoreWith() && !!this.found() && this.gate() === null,
  );

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    effect(() => {
      const target = this.target();
      untracked(() => {
        const kind = this.kind();
        // what was chosen in the tree: a table, or a schema (PostgreSQL has schemas inside a database)
        const tables = target.table ? [{ schema: target.schema ?? '', table: target.table }] : [];
        const schemas =
          !target.table && target.schema && kind === 'postgres' ? [target.schema] : [];
        this.spec.set(fitted(kind, { ...DEFAULT_DUMP, tables, schemas }));
        this.simpleSchema.set(target.schema ?? (kind === 'postgres' ? 'public' : this.database()));
        void this.check();
      });
    });
  }

  /** Asks the backend where the tools are. */
  protected async check(): Promise<void> {
    const asked = ++this.asked;
    this.info.set(null);
    this.problem.set('');
    try {
      const info = await this.api.tools(this.target().connectionId, this.service.paths());
      if (asked === this.asked) this.info.set(info);
    } catch (e) {
      if (asked !== this.asked) return;
      this.info.set({ tools: [], serverMajor: null });
      this.problem.set(describeError(e));
    }
  }

  protected pathOf(which: BackupTool): string {
    return this.service.paths()[which] ?? '';
  }

  protected setPath(which: BackupTool, path: string): void {
    this.service.setPath(which, path);
    void this.check();
  }

  protected asContent = (v: string) => v as DumpContent;
  protected asFormat = (v: string) => v as DumpFormat;

  protected set(change: Partial<DumpSpec>): void {
    this.spec.update((s) => fitted(this.kind(), { ...s, ...change }));
  }

  protected setBack(change: Partial<RestoreSpec>): void {
    this.back.update((s) => ({ ...s, ...change }));
  }

  protected size(bytes: number): string {
    return sizeText(bytes, locale());
  }

  private base(): string {
    const spec = this.spec();
    return spec.tables[0]?.table ?? spec.schemas[0] ?? (this.database() || this.connectionName());
  }

  protected async dump(): Promise<void> {
    const spec = this.spec();
    const path = await this.files.saveFile(
      this.t.saveTitle,
      fileName(this.base(), spec, new Date()),
      saveFilters(spec),
    );
    if (!path) return;
    await this.service.dump(this.target().connectionId, spec, path);
  }

  protected async simple(): Promise<void> {
    const schema = this.kind() === 'sqlite' ? 'main' : this.simpleSchema().trim();
    const path = await this.files.saveFile(
      this.t.saveTitle,
      fileName(schema || this.base(), { format: 'sql', gzip: false }, new Date()),
      [{ name: 'SQL', extensions: ['sql'] }],
    );
    if (!path) return;
    await this.service.simple(this.target().connectionId, schema, this.simpleData(), path);
  }

  protected async sqliteCopy(): Promise<void> {
    this.copied.set('');
    this.problem.set('');
    const path = await this.files.saveFile(this.t.saveTitle, `${this.base()}-copy.sqlite`, [
      { name: 'SQLite', extensions: ['sqlite', 'db'] },
    ]);
    if (!path) return;
    try {
      const bytes = await this.api.sqliteCopy(this.target().connectionId, path);
      this.copied.set(this.t.copied(this.size(bytes)));
    } catch (e) {
      this.problem.set(describeError(e));
    }
  }

  /** The file (or, for `pg_dump`'s folder format, the folder) to restore from. */
  protected async choose(folder: boolean): Promise<void> {
    this.problem.set('');
    const path = folder
      ? await this.files.openFolder(this.t.openTitle)
      : await this.files.openFile(this.t.openTitle, []);
    if (!path) return;
    try {
      this.file.set({ path, kind: await this.api.fileKind(path) });
    } catch (e) {
      this.file.set(null);
      this.problem.set(describeError(e));
    }
  }

  protected async restore(): Promise<void> {
    const file = this.file();
    if (!file || !this.canRestore()) return;
    await this.service.restore(
      this.target().connectionId,
      this.back(),
      file.path,
      this.protection() === 'ask' ? this.typedName() : null,
    );
  }

  protected close(): void {
    this.asked++;
    this.closed.emit();
  }
}
