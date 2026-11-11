import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError, toAppError } from '../../core/errors/app-error';
import { HistoryApi, HistoryEntry } from '../../core/history/history-api';
import { COMMON_TEXTS } from '../../core/i18n/common-texts';
import { ConfirmService } from '../../shared/confirm';
import { SqlEditor } from '../editor/sql-editor';
import { CopyService } from '../results/copy.service';
import { TabsStore } from '../tabs/tabs.store';
import { HISTORY_PAGE, durationLabel, oneLine, outcomeLabel, whenLabel } from './history-logic';
import { HistoryService } from './history.service';
import { HISTORY_TEXTS } from './history-texts';

/** Wait this long after the last key before the history is searched. */
export const HISTORY_SEARCH_DELAY_MS = 200;

/**
 * The history of statements (prompt 010): search, filter, look at a statement, bring it back. A list box
 * with the keys of APG; the whole text of the chosen entry in a read-only editor.
 */
@Component({
  selector: 'app-history-dialog',
  imports: [SqlEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      aria-labelledby="history-title"
      (cancel)="$event.preventDefault(); closed.emit()"
    >
      <header>
        <h2 id="history-title">{{ t.title }}</h2>
        <span class="count">{{ countLabel() }}</span>
        <button
          type="button"
          class="close"
          [attr.aria-label]="common.close"
          (click)="closed.emit()"
        >
          ×
        </button>
      </header>
      <div class="filters">
        <input
          #search
          type="search"
          [placeholder]="t.searchPlaceholder"
          [attr.aria-label]="t.searchLabel"
          autocomplete="off"
          spellcheck="false"
          [value]="text()"
          (input)="onSearch(search.value)"
          (keydown.arrowdown)="$event.preventDefault(); focusList()"
        />
        <select
          #which
          [attr.aria-label]="t.connection"
          (change)="connection.set(which.value || null)"
        >
          <option value="">{{ t.allConnections }}</option>
          @for (p of connections.profiles(); track p.id) {
            <option [value]="p.id" [selected]="p.id === connection()">{{ p.name }}</option>
          }
        </select>
        <label>
          <input
            #failed
            type="checkbox"
            [checked]="failedOnly()"
            (change)="failedOnly.set(failed.checked)"
          />
          {{ t.failedOnly }}
        </label>
        <label>
          <input #own type="checkbox" [checked]="userOnly()" (change)="userOnly.set(own.checked)" />
          {{ t.ownOnly }}
        </label>
      </div>
      @if (problem(); as p) {
        <p class="problem" role="alert">{{ p }}</p>
      }
      <div
        #list
        class="list"
        role="listbox"
        tabindex="0"
        [attr.aria-label]="t.listLabel"
        [attr.aria-activedescendant]="selected() ? 'hist-' + selected()!.id : null"
        (keydown)="onKey($event)"
        (click)="onClick($event)"
        (dblclick)="insert()"
      >
        @for (e of entries(); track e.id) {
          <div
            class="entry"
            role="option"
            [id]="'hist-' + e.id"
            [attr.data-id]="e.id"
            [attr.aria-selected]="e.id === selected()?.id"
            [class.active]="e.id === selected()?.id"
            [class.failed]="e.outcome === 'failed'"
          >
            <span class="when">{{ when(e.at) }}</span>
            <span class="conn">{{ e.connectionName }}</span>
            <span class="sql">{{ line(e.preview) }}</span>
            @if (e.count > 1) {
              <span class="times">×{{ e.count }}</span>
            }
            <span class="out">{{ outcome(e) }}</span>
            <span class="dur">{{ duration(e.elapsedMs) }}</span>
          </div>
        } @empty {
          <p class="empty">{{ loading() ? t.loading : t.nothingFound }}</p>
        }
        @if (entries().length < total()) {
          <button type="button" class="more" (click)="more()">{{ t.loadMore }}</button>
        }
      </div>
      <div class="preview">
        @if (selected(); as e) {
          @if (e.message) {
            <p class="message" role="note">{{ e.message }}</p>
          }
        }
        <app-sql-editor class="editor" [label]="t.previewLabel" [readonly]="true" />
      </div>
      <footer>
        <button type="button" [disabled]="!selected()" (click)="remove()">
          {{ t.deleteEntry }}
        </button>
        <button type="button" (click)="clear()">{{ t.clear }}</button>
        <span class="spacer"></span>
        <button type="button" [disabled]="!selected()" (click)="copy()">{{ t.copy }}</button>
        <button type="button" [disabled]="!selected()" (click)="newTab(false)">
          {{ t.inNewTab }}
        </button>
        <button type="button" [disabled]="!selected()" (click)="newTab(true)">
          {{ t.runAgain }}
        </button>
        <button type="button" class="primary" [disabled]="!selected()" (click)="insert()">
          {{ t.insert }}
        </button>
      </footer>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(960px, calc(100vw - 32px));
      height: min(680px, calc(100vh - 32px));
      padding: 0;
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
    header,
    .filters,
    footer {
      flex: none;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
    }
    h2 {
      margin: 0;
      font-size: 14px;
    }
    .count {
      flex: 1;
      color: var(--text-dim);
      font-size: 12px;
    }
    .close {
      border: 0;
      background: transparent;
      color: var(--text-dim);
      font-size: 16px;
    }
    .filters input[type='search'] {
      flex: 1;
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      color: var(--text);
      font: inherit;
    }
    .filters select {
      max-width: 200px;
      padding: 3px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-app);
      color: var(--text);
      font: inherit;
    }
    .filters label {
      display: flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    .problem {
      margin: 0 12px 6px;
      color: var(--danger);
    }
    .list {
      flex: 1 1 50%;
      min-height: 80px;
      overflow: auto;
      border-block: 1px solid var(--border);
      background: var(--bg-app);
      outline: none;
    }
    .list:focus-visible {
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    .entry {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 3px 12px;
      white-space: nowrap;
      cursor: default;
    }
    .entry:hover {
      background: var(--bg-hover);
    }
    .entry.active {
      background: var(--row-selected);
    }
    .when,
    .conn,
    .out,
    .dur,
    .times {
      flex: none;
      color: var(--text-dim);
      font-size: 12px;
    }
    .when {
      width: 130px;
      font-family: var(--font-mono);
    }
    .conn {
      width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sql {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .out {
      width: 90px;
      text-align: end;
    }
    .dur {
      width: 70px;
      text-align: end;
    }
    .entry.failed .out {
      color: var(--danger);
    }
    .empty {
      margin: 0;
      padding: 12px;
      color: var(--text-dim);
    }
    .more {
      margin: 6px 12px;
    }
    .preview {
      flex: 1 1 35%;
      min-height: 90px;
      display: flex;
      flex-direction: column;
    }
    .message {
      flex: none;
      margin: 0;
      padding: 4px 12px;
      color: var(--danger);
      font-size: 12px;
    }
    .editor {
      flex: 1;
      min-height: 0;
    }
    footer {
      border-top: 1px solid var(--border);
    }
    .spacer {
      flex: 1;
    }
  `,
})
export class HistoryDialog {
  protected readonly t = HISTORY_TEXTS;
  protected readonly common = COMMON_TEXTS;
  readonly closed = output<void>();

  private readonly api = inject(HistoryApi);
  private readonly history = inject(HistoryService);
  private readonly tabs = inject(TabsStore);
  private readonly copier = inject(CopyService);
  private readonly confirm = inject(ConfirmService);
  protected readonly connections = inject(ConnectionsStore);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly searchField = viewChild.required<ElementRef<HTMLInputElement>>('search');
  private readonly listEl = viewChild.required<ElementRef<HTMLElement>>('list');
  private readonly editor = viewChild(SqlEditor);

  protected readonly text = signal('');
  /** The text the list was searched with (a little behind what is typed). */
  private readonly searched = signal('');
  protected readonly connection = signal<string | null>(null);
  protected readonly failedOnly = signal(false);
  protected readonly userOnly = signal(false);
  protected readonly entries = signal<readonly HistoryEntry[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly problem = signal<string | null>(null);
  private readonly selectedId = signal<number | null>(null);
  protected readonly selected = computed(
    () => this.entries().find((e) => e.id === this.selectedId()) ?? null,
  );
  protected readonly countLabel = computed(() => HISTORY_TEXTS.entries(this.total()));

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Counts the searches, so an older answer is dropped. */
  private generation = 0;
  private shownText = 0;

  protected readonly when = (at: number) => whenLabel(at);
  protected readonly line = (text: string) => oneLine(text);
  protected readonly outcome = outcomeLabel;
  protected readonly duration = durationLabel;

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.searchField().nativeElement.focus();
    });
    effect(() => {
      this.searched();
      this.connection();
      this.failedOnly();
      this.userOnly();
      this.history.changed();
      untracked(() => void this.load(0));
    });
    effect(() => {
      const entry = this.selected();
      const editor = this.editor();
      untracked(() => void this.show(entry, editor));
    });
  }

  protected onSearch(text: string): void {
    this.text.set(text);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.searched.set(text), HISTORY_SEARCH_DELAY_MS);
  }

  private async load(offset: number): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    try {
      const page = await this.api.list({
        text: this.searched(),
        connectionId: this.connection(),
        failedOnly: this.failedOnly(),
        userOnly: this.userOnly(),
        limit: HISTORY_PAGE,
        offset,
      });
      if (generation !== this.generation) return;
      const entries = offset === 0 ? page.entries : [...this.entries(), ...page.entries];
      this.entries.set(entries);
      this.total.set(page.total);
      this.problem.set(page.notice);
      if (!entries.some((e) => e.id === this.selectedId())) {
        this.selectedId.set(entries[0]?.id ?? null);
      }
    } catch (e) {
      if (generation === this.generation) this.problem.set(describeError(toAppError(e)));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  protected more(): void {
    void this.load(this.entries().length);
  }

  /** The whole text of the chosen entry in the preview. */
  private async show(entry: HistoryEntry | null, editor: SqlEditor | undefined): Promise<void> {
    const mine = ++this.shownText;
    if (!editor) return;
    let text = '';
    if (entry) {
      try {
        text = await this.api.text(entry.id);
      } catch {
        text = entry.preview;
      }
    }
    if (mine === this.shownText) await editor.setText(text);
  }

  private async fullText(): Promise<string | null> {
    const entry = this.selected();
    if (!entry) return null;
    try {
      return await this.api.text(entry.id);
    } catch (e) {
      this.problem.set(describeError(toAppError(e)));
      return null;
    }
  }

  protected focusList(): void {
    this.listEl().nativeElement.focus();
  }

  protected onClick(event: MouseEvent): void {
    const el = (event.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (el) this.selectedId.set(Number(el.dataset['id']));
  }

  protected onKey(event: KeyboardEvent): void {
    const entries = this.entries();
    if (entries.length === 0) return;
    const at = entries.findIndex((e) => e.id === this.selectedId());
    let to: number;
    if (event.key === 'ArrowDown') to = Math.min(entries.length - 1, at + 1);
    else if (event.key === 'ArrowUp') to = Math.max(0, at - 1);
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = entries.length - 1;
    else if (event.key === 'PageDown') to = Math.min(entries.length - 1, at + 10);
    else if (event.key === 'PageUp') to = Math.max(0, at - 10);
    else if (event.key === 'Enter') {
      event.preventDefault();
      void this.insert();
      return;
    } else if (event.key === 'Delete') {
      event.preventDefault();
      void this.remove();
      return;
    } else return;
    event.preventDefault();
    this.selectedId.set(entries[to].id);
    this.listEl()
      .nativeElement.querySelector(`#hist-${entries[to].id}`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  /** Into the editor of the tab in front, at the caret. */
  protected async insert(): Promise<void> {
    const text = await this.fullText();
    if (text === null) return;
    this.closed.emit();
    // the dialog gives the focus back first
    setTimeout(() => this.tabs.active()?.insert(text));
  }

  protected async newTab(run: boolean): Promise<void> {
    const entry = this.selected();
    const text = await this.fullText();
    if (text === null || !entry) return;
    this.closed.emit();
    const known = this.connections.profiles().some((p) => p.id === entry.connectionId);
    const tab = this.tabs.newTab(text, known ? { connection: entry.connectionId } : {});
    if (run) void tab.run(text);
  }

  protected async copy(): Promise<void> {
    const text = await this.fullText();
    if (text !== null) await this.copier.copyText(text);
  }

  protected async remove(): Promise<void> {
    const entry = this.selected();
    if (!entry) return;
    const entries = this.entries();
    const at = entries.indexOf(entry);
    await this.api.delete({ kind: 'entry', id: entry.id });
    this.selectedId.set((entries[at + 1] ?? entries[at - 1])?.id ?? null);
    this.history.changed.update((n) => n + 1);
  }

  /** Deletes the history: of the connection chosen in the filter, or all of it. */
  protected async clear(): Promise<void> {
    const id = this.connection();
    const name = this.connections.profiles().find((p) => p.id === id)?.name ?? id;
    // the dialog of the question opens above this one
    const yes = await this.confirm.ask({
      title: HISTORY_TEXTS.clearTitle,
      message: id ? HISTORY_TEXTS.clearConnection(name ?? id) : HISTORY_TEXTS.clearAll,
      confirm: COMMON_TEXTS.delete,
    });
    if (!yes) return;
    try {
      await this.api.delete(id ? { kind: 'connection', id } : { kind: 'all' });
      this.history.changed.update((n) => n + 1);
    } catch (e) {
      this.problem.set(describeError(toAppError(e)));
    }
  }
}
