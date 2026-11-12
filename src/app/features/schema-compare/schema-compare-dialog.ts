import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import {
  CompareApi,
  CompareItem,
  CompareKind,
  SchemaRename,
  SchemaSnapshot,
} from '../../core/compare/compare-api';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { SchemaApi } from '../../core/schema/schema-api';
import { SessionApi } from '../../core/session/session-api';
import { TabsStore } from '../tabs/tabs.store';
import {
  counts,
  filtered,
  inverted,
  itemLabel,
  lineDiff,
  readSnapshot,
  renameOf,
  reportMarkdown,
  snapshotLine,
} from './compare-logic';
import { COMPARE_TEXTS } from './compare-texts';

type SideName = 'left' | 'right';

interface Side {
  readonly connectionId: string;
  readonly schema: string;
  readonly schemas: readonly string[];
  /** A snapshot from a file: it is this side, whatever the selects say. */
  readonly file: SchemaSnapshot | null;
}

const EMPTY_SIDE: Side = { connectionId: '', schema: '', schemas: [], file: null };

/**
 * Two schemas side by side (prompt 038): what is only here, only there, or different – and a script
 * that would make one like the other, opened in a tab for the user to read and run. This dialog changes
 * no database. Definitions are shown as text.
 */
@Component({
  selector: 'app-schema-compare-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog aria-labelledby="sc-title" (cancel)="$event.preventDefault(); closed.emit()">
      <h2 id="sc-title">{{ t.title }}</h2>
      <div class="sides">
        @for (name of sideNames; track name) {
          <fieldset>
            <legend>{{ name === 'left' ? t.left : t.right }}</legend>
            @if (side(name).file; as file) {
              <p class="file">
                {{ fileLine(file) }}
                <button type="button" class="link" (click)="clearFile(name)">×</button>
              </p>
            } @else {
              <div class="grid">
                <label [for]="'sc-conn-' + name">{{ t.connection }}</label>
                <select #conn [id]="'sc-conn-' + name" (change)="setConnection(name, conn.value)">
                  <option value="">{{ t.chooseConnection }}</option>
                  @for (p of connections.profiles(); track p.id) {
                    <option [value]="p.id" [selected]="p.id === side(name).connectionId">
                      {{ p.name }}
                    </option>
                  }
                </select>
                <label [for]="'sc-schema-' + name">{{ t.schema }}</label>
                <select #sch [id]="'sc-schema-' + name" (change)="setSchema(name, sch.value)">
                  @for (s of side(name).schemas; track s) {
                    <option [value]="s" [selected]="s === side(name).schema">{{ s }}</option>
                  }
                </select>
              </div>
            }
            <div class="line">
              <button type="button" (click)="loadSnapshot(name)">{{ t.loadSnapshot }}</button>
              <button type="button" [disabled]="!snaps()" (click)="saveSnapshot(name)">
                {{ t.saveSnapshot }}
              </button>
            </div>
          </fieldset>
        }
      </div>
      <div class="bar">
        <button type="button" class="primary" [disabled]="!ready() || busy()" (click)="run()">
          {{ t.compare }}
        </button>
        <label>
          <input
            #od
            type="checkbox"
            [checked]="onlyDifferences()"
            (change)="onlyDifferences.set(od.checked)"
          />
          {{ t.onlyDifferences }}
        </label>
        <label>
          {{ t.kind }}
          <select #kd (change)="setKind(kd.value)">
            <option value="">{{ t.allKinds }}</option>
            @for (k of kinds; track k) {
              <option [value]="k" [selected]="kind() === k">{{ t.kinds[k] }}</option>
            }
          </select>
        </label>
        <input
          #fi
          type="search"
          spellcheck="false"
          [attr.aria-label]="t.find"
          [placeholder]="t.find"
          [value]="find()"
          (input)="find.set(fi.value)"
        />
        <span class="status" role="status">{{ status() }}</span>
      </div>
      <div class="body">
        <div class="list" role="group" [attr.aria-label]="t.items">
          @if (items().length > 0) {
            <p class="picks">
              <button type="button" class="link" (click)="pickAll(true)">{{ t.pickAll }}</button>
              <button type="button" class="link" (click)="pickAll(false)">{{ t.pickNone }}</button>
            </p>
          }
          <ul>
            @for (i of shown(); track i.id) {
              <li [class.part]="i.table" [class.current]="i.id === current()?.id">
                @if (i.state !== 'same') {
                  <input
                    type="checkbox"
                    [attr.aria-label]="t.pick(label(i))"
                    [checked]="picked().has(i.id)"
                    (change)="togglePick(i.id)"
                  />
                } @else {
                  <span class="nopick"></span>
                }
                <button type="button" class="row" (click)="select(i)">
                  <span class="kind">{{ t.kinds[i.kind] }}</span>
                  <span class="name">{{ label(i) }}</span>
                  <span class="state" [class]="'state ' + i.state">{{ t.states[i.state] }}</span>
                </button>
              </li>
            }
          </ul>
        </div>
        <div
          class="diff"
          tabindex="0"
          role="region"
          [attr.aria-label]="current() ? t.definitions(label(current()!)) : t.items"
        >
          @if (current(); as c) {
            <table>
              <thead>
                <tr>
                  <th scope="col">{{ t.left }}</th>
                  <th scope="col">{{ t.right }}</th>
                </tr>
              </thead>
              <tbody>
                @if (c.left === null && c.right === null) {
                  <tr>
                    <td class="dim">{{ t.nothingThere }}</td>
                    <td class="dim">{{ t.nothingThere }}</td>
                  </tr>
                }
                @for (row of diff(); track $index) {
                  <tr [class]="row.state">
                    <td>{{ row.left }}</td>
                    <td>{{ row.right }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </div>
      </div>
      @if (renames().length > 0) {
        <p class="renames">
          {{ t.renames }}:
          @for (r of renames(); track $index) {
            <span class="rename">
              {{ t.renameLine(r.table, r.from, r.to) }}
              <button
                type="button"
                class="link"
                [attr.aria-label]="t.removeRename(r.from)"
                (click)="removeRename($index)"
              >
                ×
              </button>
            </span>
          }
        </p>
      }
      <p class="dim">{{ t.scriptHint }}</p>
      <footer>
        <button type="button" [disabled]="!pair()" (click)="markRename()">
          {{ t.markRename }}
        </button>
        <span class="grow"></span>
        <button type="button" [disabled]="!hasDifferences()" (click)="script('right')">
          {{ t.scriptRight }}
        </button>
        <button type="button" [disabled]="!hasDifferences()" (click)="script('left')">
          {{ t.scriptLeft }}
        </button>
        <button type="button" [disabled]="items().length === 0" (click)="saveReport()">
          {{ t.report }}
        </button>
        <button type="button" (click)="closed.emit()">{{ t.close }}</button>
      </footer>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(1100px, calc(100vw - 32px));
      height: calc(100vh - 32px);
      max-height: none;
      padding: 14px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog[open] {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 35%);
    }
    h2 {
      margin: 0;
      font-size: 14px;
    }
    .sides {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    fieldset {
      margin: 0;
      padding: 6px 10px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      min-width: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 6px 10px;
      align-items: center;
    }
    .line,
    .bar,
    footer {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .line {
      margin-top: 6px;
    }
    label {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    select,
    input[type='search'] {
      padding: 3px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      color: var(--text);
      font: inherit;
      min-width: 0;
    }
    .status,
    .grow {
      flex: 1;
    }
    .status,
    .dim {
      color: var(--text-dim);
    }
    p {
      margin: 0;
    }
    .body {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(280px, 2fr) 3fr;
      gap: 8px;
    }
    .list,
    .diff {
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 6px;
    }
    li.part {
      padding-left: 22px;
    }
    li.current {
      background: var(--bg-panel);
    }
    .nopick {
      width: 13px;
      margin: 0 3px;
    }
    .row {
      flex: 1;
      display: flex;
      gap: 8px;
      min-width: 0;
      padding: 2px 0;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
    }
    .kind {
      flex: none;
      width: 96px;
      color: var(--text-dim);
    }
    .name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .state {
      flex: none;
      color: var(--text-dim);
    }
    .state.onlyLeft,
    .state.onlyRight,
    .state.different {
      color: var(--accent);
    }
    .picks {
      padding: 2px 8px;
    }
    .link {
      border: 0;
      padding: 0 4px;
      background: transparent;
      color: var(--accent);
      font: inherit;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    th {
      position: sticky;
      top: 0;
      padding: 2px 8px;
      background: var(--bg-panel);
      text-align: left;
      font-family: inherit;
    }
    td {
      padding: 0 8px;
      vertical-align: top;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border-left: 1px solid var(--border);
      user-select: text;
    }
    tr.changed td,
    tr.left td:first-child,
    tr.right td:last-child {
      background: var(--cell-changed-bg);
      color: var(--cell-changed-text);
    }
    .rename {
      margin-right: 10px;
    }
    .file {
      overflow-wrap: anywhere;
    }
  `,
})
export class SchemaCompareDialog {
  readonly closed = output<void>();

  private readonly api = inject(CompareApi);
  private readonly meta = inject(SchemaApi);
  private readonly files = inject(FileDialogApi);
  private readonly session = inject(SessionApi);
  private readonly tabs = inject(TabsStore);
  protected readonly connections = inject(ConnectionsStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly t = COMPARE_TEXTS;
  protected readonly sideNames: readonly SideName[] = ['left', 'right'];
  protected readonly kinds: readonly CompareKind[] = [
    'table',
    'column',
    'primaryKey',
    'index',
    'key',
    'check',
    'view',
    'routine',
    'trigger',
  ];

  private readonly sides = signal<Record<SideName, Side>>({
    left: { ...EMPTY_SIDE },
    right: { ...EMPTY_SIDE },
  });
  /** The snapshots of the last comparison. */
  protected readonly snaps = signal<Record<SideName, SchemaSnapshot> | null>(null);
  protected readonly items = signal<readonly CompareItem[]>([]);
  protected readonly renames = signal<readonly SchemaRename[]>([]);
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  protected readonly current = signal<CompareItem | null>(null);
  private readonly before = signal<CompareItem | null>(null);
  protected readonly onlyDifferences = signal(true);
  protected readonly kind = signal<CompareKind | ''>('');
  protected readonly find = signal('');
  protected readonly busy = signal(false);
  private readonly note = signal('');
  /** Counts the comparisons, so an older answer is dropped. */
  private runs = 0;

  protected readonly ready = computed(() =>
    this.sideNames.every((n) => {
      const s = this.sides()[n];
      return s.file !== null || (s.connectionId !== '' && s.schema !== '');
    }),
  );
  protected readonly shown = computed(() =>
    filtered(this.items(), {
      onlyDifferences: this.onlyDifferences(),
      kind: this.kind(),
      text: this.find(),
    }),
  );
  protected readonly hasDifferences = computed(() => this.items().some((i) => i.state !== 'same'));
  protected readonly diff = computed(() => {
    const c = this.current();
    return c ? lineDiff(c.left, c.right) : [];
  });
  /** The rename the last two chosen items would be. */
  protected readonly pair = computed(() => {
    const a = this.before();
    const b = this.current();
    return a && b ? renameOf(a, b, 'right') : null;
  });
  protected readonly status = computed(() => {
    if (this.busy()) return this.t.comparing;
    const note = this.note();
    if (note) return note;
    if (!this.snaps()) return this.ready() ? '' : this.t.needBoth;
    const c = counts(this.items());
    return this.t.summary(c.onlyLeft, c.onlyRight, c.different, c.same);
  });

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
    // the connection in front is a likely left side
    const active = this.connections.activeId();
    if (active) void this.setConnection('left', active);
  }

  protected side(name: SideName): Side {
    return this.sides()[name];
  }

  protected readonly label = itemLabel;
  protected readonly fileLine = snapshotLine;

  private patch(name: SideName, change: Partial<Side>): void {
    this.sides.update((s) => ({ ...s, [name]: { ...s[name], ...change } }));
  }

  protected async setConnection(name: SideName, id: string): Promise<void> {
    this.patch(name, { connectionId: id, schema: '', schemas: [] });
    this.note.set('');
    if (id === '') return;
    try {
      if (!(await this.connections.connect(id))) return;
      const all = await this.meta.schemas(id);
      if (this.side(name).connectionId !== id) return;
      const own = all.filter((s) => !s.system);
      const list = (own.length > 0 ? own : all).map((s) => s.name);
      this.patch(name, {
        schemas: list,
        schema: all.find((s) => s.current && list.includes(s.name))?.name ?? list[0] ?? '',
      });
    } catch (e) {
      this.note.set(describeError(toAppError(e)));
    }
  }

  protected setSchema(name: SideName, schema: string): void {
    this.patch(name, { schema });
  }

  protected setKind(value: string): void {
    this.kind.set(this.kinds.find((k) => k === value) ?? '');
  }

  protected clearFile(name: SideName): void {
    this.patch(name, { file: null });
  }

  protected async loadSnapshot(name: SideName): Promise<void> {
    try {
      const path = await this.files.openFile(this.t.loadSnapshot, [
        { name: this.t.snapshotFile, extensions: ['json'] },
      ]);
      if (!path) return;
      const snapshot = readSnapshot((await this.session.readFile(path)).text);
      if (!snapshot) {
        this.note.set(this.t.notASnapshot);
        return;
      }
      this.note.set('');
      this.patch(name, { file: snapshot });
    } catch {
      this.note.set(this.t.readFailed);
    }
  }

  protected async saveSnapshot(name: SideName): Promise<void> {
    const snapshot = this.snaps()?.[name];
    if (!snapshot) return;
    await this.write(`${snapshot.schema || 'schema'}.snapshot.json`, 'json', () =>
      JSON.stringify(snapshot, null, 1),
    );
  }

  private async write(file: string, extension: string, text: () => string): Promise<void> {
    try {
      const path = await this.files.saveFile(this.t.title, file, [
        { name: extension.toUpperCase(), extensions: [extension] },
      ]);
      if (!path) return;
      await this.session.writeFile(path, text(), 'utf-8');
      this.note.set(this.t.saved(path.split(/[\\/]/).pop() ?? path));
    } catch {
      this.note.set(this.t.saveFailed);
    }
  }

  /** Reads both sides and compares them. */
  protected async run(): Promise<void> {
    if (!this.ready() || this.busy()) return;
    const mine = ++this.runs;
    this.busy.set(true);
    this.note.set('');
    try {
      const read = (name: SideName) => {
        const s = this.side(name);
        return s.file ? Promise.resolve(s.file) : this.api.snapshot(s.connectionId, s.schema);
      };
      const left = await read('left');
      const right = await read('right');
      // renames belong to the schemas they were told for
      const renames = this.snaps() ? this.renames() : [];
      const items = await this.api.compare(left, right, renames);
      if (mine !== this.runs) return;
      this.snaps.set({ left, right });
      this.renames.set(renames);
      this.show(items);
    } catch (e) {
      if (mine === this.runs) this.note.set(this.t.failed(describeError(toAppError(e))));
    } finally {
      if (mine === this.runs) this.busy.set(false);
    }
  }

  private show(items: readonly CompareItem[]): void {
    this.items.set(items);
    this.picked.set(new Set(items.filter((i) => i.state !== 'same').map((i) => i.id)));
    this.current.set(items.find((i) => i.state !== 'same') ?? null);
    this.before.set(null);
  }

  protected select(item: CompareItem): void {
    if (item.id === this.current()?.id) return;
    this.before.set(this.current());
    this.current.set(item);
  }

  protected togglePick(id: string): void {
    this.picked.update((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected pickAll(on: boolean): void {
    this.picked.set(
      new Set(
        on
          ? this.items()
              .filter((i) => i.state !== 'same')
              .map((i) => i.id)
          : [],
      ),
    );
  }

  private async recompare(renames: readonly SchemaRename[]): Promise<void> {
    const snaps = this.snaps();
    if (!snaps) return;
    try {
      const items = await this.api.compare(snaps.left, snaps.right, renames);
      this.renames.set(renames);
      this.show(items);
    } catch (e) {
      this.note.set(this.t.failed(describeError(toAppError(e))));
    }
  }

  /** The two items chosen last are one thing under two names. */
  protected async markRename(): Promise<void> {
    const rename = this.pair();
    if (rename) await this.recompare([...this.renames(), rename]);
  }

  protected async removeRename(index: number): Promise<void> {
    await this.recompare(this.renames().filter((_, i) => i !== index));
  }

  /** Opens the script that would make `target` like the other side, in a tab. */
  protected async script(target: SideName): Promise<void> {
    const snaps = this.snaps();
    if (!snaps) return;
    const source: SideName = target === 'right' ? 'left' : 'right';
    const differing = this.items().filter((i) => i.state !== 'same');
    const picks = differing.filter((i) => this.picked().has(i.id)).map((i) => i.id);
    try {
      const sql = await this.api.script(
        snaps[source],
        snaps[target],
        picks.length === differing.length ? null : picks,
        target === 'right' ? this.renames() : inverted(this.renames()),
      );
      const side = this.side(target);
      this.closed.emit();
      this.tabs.newTab(sql, {
        title: this.t.scriptTitle(snaps[target].schema),
        customTitle: true,
        // a snapshot from a file has no connection: the one in front
        connection: side.file ? this.connections.activeId() : side.connectionId,
      });
    } catch (e) {
      this.note.set(this.t.failed(describeError(toAppError(e))));
    }
  }

  protected async saveReport(): Promise<void> {
    const snaps = this.snaps();
    if (!snaps) return;
    const name = (n: SideName) => {
      const s = this.side(n);
      const profile = this.connections.profiles().find((p) => p.id === s.connectionId);
      return s.file || !profile ? snaps[n].schema : `${profile.name} · ${snaps[n].schema}`;
    };
    await this.write('schema-comparison.md', 'md', () =>
      reportMarkdown(name('left'), name('right'), this.items()),
    );
  }
}
