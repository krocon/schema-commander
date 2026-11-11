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
import { ImportItem, ImportSource, whereLabel } from '../../core/connections/connection.models';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError } from '../../core/errors/app-error';
import { COMMON_TEXTS } from '../../core/i18n/common-texts';
import { kindName } from './connection-logic';
import { IMPORT_TEXTS } from './import-texts';
import {
  IMPORT_SOURCES,
  Tick,
  importSummary,
  initialTicks,
  picksOf,
  problemText,
} from './import-logic';

/**
 * Takes connections over from other tools and files (prompt 015): pick a source, look at what is there,
 * tick what to store. A password is only taken where it stands in clear text and its box is ticked; it
 * goes from the file to the keychain inside the backend and is never shown here.
 */
@Component({
  selector: 'app-import-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      aria-labelledby="import-title"
      (cancel)="$event.preventDefault(); closed.emit()"
    >
      <form (submit)="$event.preventDefault(); run()">
        <header>
          <h2 id="import-title">{{ t.title }}</h2>
          <button
            type="button"
            class="close"
            [attr.aria-label]="common.close"
            (click)="closed.emit()"
          >
            ×
          </button>
        </header>
        <div class="source">
          <label for="import-source">{{ t.source }}</label>
          <select id="import-source" #src (change)="setSource(src.value)">
            @for (s of sources; track s.id) {
              <option [value]="s.id" [selected]="s.id === source()">{{ s.label }}</option>
            }
          </select>
          @if (info().file !== 'none') {
            <button type="button" (click)="chooseFile()">{{ t.chooseFile }}</button>
          }
          @if (info().file !== 'pick') {
            <button type="button" [disabled]="busy()" (click)="load(null)">{{ t.read }}</button>
          }
        </div>
        @if (info().hint) {
          <p class="hint">{{ info().hint }}</p>
        }
        @if (path(); as p) {
          <p class="path">{{ p }}</p>
        }
        @if (problem(); as p) {
          <p class="problem" role="alert">{{ p }}</p>
        }
        @if (items(); as list) {
          <ul class="list" [attr.aria-label]="t.found">
            @for (item of list; track item.index; let i = $index) {
              <li [class.broken]="item.problem !== null">
                <label class="take">
                  <input
                    type="checkbox"
                    [checked]="ticks()[i]?.take"
                    [disabled]="item.problem !== null"
                    (change)="toggle(i, 'take')"
                  />
                  <span class="name">{{ item.profile.name }}</span>
                </label>
                <span class="where">{{ kind(item) }} · {{ where(item) }}</span>
                @if (item.profile.ssh) {
                  <span class="tag">SSH</span>
                }
                @if (item.nameTaken) {
                  <span class="tag" [title]="t.nameTakenHint">{{ t.nameTaken }}</span>
                }
                @if (item.hasPassword && item.problem === null) {
                  <label class="pw">
                    <input
                      type="checkbox"
                      [checked]="ticks()[i]?.withPassword"
                      [disabled]="!ticks()[i]?.take"
                      (change)="toggle(i, 'withPassword')"
                    />
                    {{ t.takePassword }}
                  </label>
                }
                @if (item.problem; as why) {
                  <span class="why">{{ explain(why) }}</span>
                }
              </li>
            }
          </ul>
          <p class="summary" role="status">{{ summary() }}</p>
        }
        @if (done(); as n) {
          <p class="ok" role="status">
            {{ t.imported(n) }}
          </p>
        }
        <footer>
          <button type="button" [disabled]="busy()" (click)="exportOwn()">
            {{ t.exportOwn }}
          </button>
          <span class="spacer"></span>
          <button type="button" (click)="closed.emit()">{{ common.close }}</button>
          <button type="submit" class="primary" [disabled]="busy() || picks().length === 0">
            {{ t.run }}
          </button>
        </footer>
      </form>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(720px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      padding: 16px;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 35%);
    }
    header {
      display: flex;
      align-items: center;
      margin-bottom: 10px;
    }
    h2 {
      flex: 1;
      margin: 0;
      font-size: 14px;
    }
    .close {
      border: 0;
      background: transparent;
      color: var(--text-dim);
      font-size: 16px;
    }
    .source {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    select {
      flex: 1;
      padding: 3px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      color: var(--text);
      font: inherit;
    }
    .hint,
    .path,
    .summary {
      margin: 6px 0 0;
      color: var(--text-dim);
      font-size: 12px;
    }
    .path {
      font-family: var(--font-mono);
      overflow-wrap: anywhere;
    }
    .problem {
      margin: 8px 0 0;
      color: var(--danger);
    }
    .ok {
      margin: 8px 0 0;
      color: var(--ok);
    }
    .list {
      margin: 10px 0 0;
      padding: 0;
      list-style: none;
      max-height: 320px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-app);
    }
    li {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 4px 10px;
      padding: 4px 10px;
    }
    li + li {
      border-top: 1px solid var(--border);
    }
    .take,
    .pw {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .name {
      font-weight: 600;
    }
    li.broken .name {
      color: var(--text-dim);
    }
    .where {
      flex: 1;
      color: var(--text-dim);
      font-size: 12px;
    }
    .tag {
      padding: 0 6px;
      border-radius: 8px;
      box-shadow: inset 0 0 0 1px var(--border);
      font-size: 11px;
    }
    .why {
      flex-basis: 100%;
      color: var(--danger);
      font-size: 12px;
    }
    footer {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }
    .spacer {
      flex: 1;
    }
  `,
})
export class ImportDialog {
  readonly closed = output<void>();

  private readonly store = inject(ConnectionsStore);
  private readonly files = inject(FileDialogApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly t = IMPORT_TEXTS;
  protected readonly common = COMMON_TEXTS;
  protected readonly sources = IMPORT_SOURCES;
  protected readonly source = signal<ImportSource>('pgpass');
  protected readonly info = computed(
    () => IMPORT_SOURCES.find((s) => s.id === this.source()) ?? IMPORT_SOURCES[0],
  );
  /** The file that was read, as the backend names it. */
  protected readonly path = signal<string | null>(null);
  /** The file the user picked (`null` = the usual place of the source). */
  private picked: string | null = null;
  protected readonly items = signal<readonly ImportItem[] | null>(null);
  protected readonly ticks = signal<readonly Tick[]>([]);
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);
  protected readonly done = signal<number | null>(null);
  protected readonly picks = computed(() => picksOf(this.items() ?? [], this.ticks()));
  protected readonly summary = computed(() => importSummary(this.items() ?? [], this.ticks()));
  /** Counts the previews asked for, so an older answer is dropped. */
  private asked = 0;

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }

  protected kind(item: ImportItem): string {
    return kindName(item.profile.kind);
  }

  protected where(item: ImportItem): string {
    return whereLabel(item.profile);
  }

  protected explain(problem: string): string {
    return problemText(problem);
  }

  protected setSource(id: string): void {
    const known = IMPORT_SOURCES.find((s) => s.id === id);
    if (!known) return;
    this.source.set(known.id);
    this.asked++;
    this.picked = null;
    this.path.set(null);
    this.items.set(null);
    this.problem.set(null);
    this.done.set(null);
  }

  protected async chooseFile(): Promise<void> {
    const path = await this.files.openFile(this.t.chooseFileTitle, [
      { name: this.t.allFiles, extensions: ['*'] },
    ]);
    if (path !== null) await this.load(path);
  }

  /** Reads the source: the picked file, or its usual place. */
  protected async load(path: string | null): Promise<void> {
    const mine = ++this.asked;
    this.picked = path;
    this.busy.set(true);
    this.problem.set(null);
    this.done.set(null);
    try {
      const preview = await this.store.importPreview(this.source(), path);
      if (mine !== this.asked) return;
      this.path.set(preview.path);
      this.items.set(preview.items);
      this.ticks.set(initialTicks(preview.items));
    } catch (e) {
      if (mine !== this.asked) return;
      this.items.set(null);
      this.problem.set(describeError(e));
    } finally {
      if (mine === this.asked) this.busy.set(false);
    }
  }

  protected toggle(index: number, what: keyof Tick): void {
    this.ticks.update((all) => all.map((t, i) => (i === index ? { ...t, [what]: !t[what] } : t)));
  }

  protected async run(): Promise<void> {
    const picks = this.picks();
    if (picks.length === 0 || this.busy()) return;
    this.busy.set(true);
    this.problem.set(null);
    try {
      const stored = await this.store.importConnections(this.source(), this.picked, picks);
      this.done.set(stored.length);
      // what is stored now has its name taken: read again
      this.busy.set(false);
      await this.load(this.picked);
      this.done.set(stored.length);
    } catch (e) {
      this.problem.set(describeError(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async exportOwn(): Promise<void> {
    const path = await this.files.saveFile(this.t.exportTitle, this.t.exportFileName, [
      { name: 'JSON', extensions: ['json'] },
    ]);
    if (path === null) return;
    try {
      await this.store.exportConnections(path);
      this.problem.set(null);
      this.done.set(null);
      this.path.set(path);
    } catch (e) {
      this.problem.set(describeError(e));
    }
  }
}
