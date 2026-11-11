import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActionService } from '../../core/actions/action.service';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { SavedEntry } from '../../core/saved/saved-api';
import { ConfirmService } from '../../shared/confirm';
import { SavedRow, previewOf, savedRows } from './saved-logic';
import { SavedStore } from './saved.store';
import { SAVED_TEXTS } from './saved-texts';

const SEARCH_DELAY_MS = 200;

/**
 * The saved queries as a view of the sidebar (prompt 024): the folders as a tree (APG tree: one stop in the
 * tab order, arrows move, right and left open and close), a search over names and texts, a preview of the
 * query under the cursor and what can be done with it. The listing follows the folder while the view is on
 * screen – also what is changed outside the app.
 */
@Component({
  selector: 'app-saved-panel',
  template: `
    <input
      type="search"
      class="search"
      [attr.aria-label]="t.search"
      [placeholder]="t.search"
      autocomplete="off"
      spellcheck="false"
      [value]="text()"
      (input)="onSearch($any($event.target).value)"
      (keydown.arrowdown)="$event.preventDefault(); focusTree()"
    />
    @if (store.problem(); as p) {
      <p class="message" role="alert">{{ p }}</p>
    } @else if (rows().length === 0) {
      <p class="message">
        {{ store.listing() === null ? t.reading : found() ? t.nothingFound : t.empty }}
      </p>
    }
    <ul
      #tree
      class="tree"
      role="tree"
      tabindex="0"
      [attr.aria-label]="t.tree"
      [attr.aria-activedescendant]="active() ? domId(active()!.key) : null"
      (keydown)="onKey($event)"
      (click)="onClick($event)"
      (dblclick)="onClick($event, true)"
    >
      @for (row of rows(); track row.key) {
        <li
          role="treeitem"
          [id]="domId(row.key)"
          [attr.data-key]="row.key"
          [attr.aria-level]="row.level + 1"
          [attr.aria-selected]="row.key === activeKey()"
          [attr.aria-expanded]="row.kind === 'folder' ? row.open : null"
          [style.padding-left.px]="6 + row.level * 14"
          [title]="row.kind === 'query' ? row.entry.description || row.entry.name : row.folder"
        >
          @if (row.kind === 'folder') {
            <span class="twisty" aria-hidden="true">{{ row.open ? '▾' : '▸' }}</span>
            <span class="name folder">{{ row.label }}</span>
            <small [attr.aria-label]="t.folderCount(row.count)">{{ row.count }}</small>
          } @else {
            <span class="twisty" aria-hidden="true"></span>
            <span class="name">{{ row.entry.name }}</span>
            @if (row.entry.tags.length > 0) {
              <small>{{ row.entry.tags.join(', ') }}</small>
            }
          }
        </li>
      }
    </ul>
    @if (store.listing()?.truncated) {
      <p class="message">{{ t.truncated }}</p>
    }
    @if (selected(); as entry) {
      <section class="preview" [attr.aria-label]="t.preview">
        @if (entry.description) {
          <p class="description">{{ entry.description }}</p>
        }
        @if (boundName(entry); as name) {
          <p class="description">{{ t.boundTo(name) }}</p>
        }
        <pre>{{ preview() }}</pre>
        <div class="buttons">
          <button type="button" class="primary" [title]="t.openHint" (click)="store.open(entry)">
            {{ t.open }}
          </button>
          <button type="button" [title]="t.insertHint" (click)="store.insert(entry)">
            {{ t.insert }}
          </button>
          <button type="button" [title]="t.runHint" (click)="store.run(entry)">{{ t.run }}</button>
          <button type="button" (click)="edit(entry)">{{ t.edit }}</button>
          <button type="button" (click)="remove(entry)">{{ t.delete }}</button>
        </div>
      </section>
    }
    <footer class="folder" [title]="store.listing()?.root ?? ''">
      <span class="path" [attr.aria-label]="t.folder">{{ rootTail() }}</span>
      <button type="button" (click)="actions.run('SAVED_FOLDER')">{{ t.chooseFolder }}</button>
    </footer>
  `,
  styles: `
    :host {
      flex: 1 1 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .search {
      flex: none;
      width: 100%;
    }
    .tree {
      flex: 1 1 0;
      min-height: 60px;
      margin: 0;
      padding: 0;
      list-style: none;
      overflow: auto;
    }
    li {
      display: flex;
      align-items: baseline;
      gap: 4px;
      padding: 3px 6px;
      border-radius: var(--radius);
      cursor: default;
      white-space: nowrap;
    }
    li:hover {
      background: var(--bg-hover);
    }
    li[aria-selected='true'] {
      background: var(--row-selected);
    }
    .tree:focus-visible li[aria-selected='true'] {
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    .twisty {
      flex: none;
      width: 10px;
      color: var(--text-dim);
    }
    .name {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .folder {
      font-weight: 600;
    }
    small {
      color: var(--text-dim);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .message {
      margin: 0;
      color: var(--text-dim);
      font-size: 12px;
    }
    .preview {
      flex: none;
      display: flex;
      flex-direction: column;
      gap: 4px;
      border-top: 1px solid var(--border);
      padding-top: 6px;
    }
    .description {
      margin: 0;
      color: var(--text-dim);
      font-size: 12px;
    }
    pre {
      margin: 0;
      max-height: 140px;
      overflow: auto;
      padding: 6px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg-app);
      font-family: var(--font-mono);
      font-size: 12px;
      white-space: pre;
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .folder {
      flex: none;
    }
    footer.folder {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 400;
    }
    .path {
      flex: 1 1 0;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-dim);
      font-size: 11px;
    }
  `,
})
export class SavedPanel {
  protected readonly t = SAVED_TEXTS;
  protected readonly store = inject(SavedStore);
  protected readonly actions = inject(ActionService);
  private readonly confirm = inject(ConfirmService);
  private readonly connections = inject(ConnectionsStore);
  private readonly tree = viewChild.required<ElementRef<HTMLElement>>('tree');

  /** The end of the folder's path: that is the part that tells folders apart. */
  protected readonly rootTail = computed(() => {
    const root = this.store.listing()?.root ?? '';
    const parts = root.split(/[\\/]/).filter((p) => p !== '');
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : root;
  });
  protected readonly text = signal('');
  /** The ids a search found; `null` = no search. */
  private readonly hits = signal<ReadonlySet<string> | null>(null);
  protected readonly found = computed(() => this.hits() !== null);
  private readonly closed = signal<ReadonlySet<string>>(new Set());
  protected readonly rows = computed<SavedRow[]>(() => {
    const listing = this.store.listing();
    return listing ? savedRows(listing.entries, listing.folders, this.closed(), this.hits()) : [];
  });
  protected readonly activeKey = signal<string | null>(null);
  protected readonly active = computed(
    () => this.rows().find((r) => r.key === this.activeKey()) ?? null,
  );
  protected readonly selected = computed<SavedEntry | null>(() => {
    const row = this.active();
    return row?.kind === 'query' ? row.entry : null;
  });
  protected readonly preview = signal('');
  private asked = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const stop = this.store.watch();
    inject(DestroyRef).onDestroy(() => {
      stop();
      if (this.timer) clearTimeout(this.timer);
    });
    // the preview of the query under the cursor; read again when its file changed
    effect(() => {
      const entry = this.selected();
      const key = entry ? `${entry.id}:${entry.modified}:${entry.size}` : '';
      untracked(() => void this.loadPreview(entry, key));
    });
    // a listing that changed under a search: search again
    effect(() => {
      const stamp = this.store.listing()?.stamp;
      if (stamp === undefined) return;
      untracked(() => {
        if (this.text().trim() !== '') void this.search(this.text());
      });
    });
  }

  protected domId(key: string): string {
    // ids of DOM nodes: nothing but letters, digits and dashes
    return `sv-${Array.from(key, (c) => c.codePointAt(0)!.toString(36)).join('-')}`;
  }

  protected boundName(entry: SavedEntry): string | null {
    if (!entry.connection) return null;
    return this.connections.profiles().find((p) => p.id === entry.connection)?.name ?? null;
  }

  private async loadPreview(entry: SavedEntry | null, key: string): Promise<void> {
    const mine = ++this.asked;
    if (!entry) {
      this.preview.set('');
      return;
    }
    try {
      const saved = await this.store.read(entry.id);
      if (mine === this.asked && key !== '') this.preview.set(previewOf(saved.text));
    } catch {
      if (mine === this.asked) this.preview.set('');
    }
  }

  protected onSearch(value: string): void {
    this.text.set(value);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.search(value), SEARCH_DELAY_MS);
  }

  private async search(value: string): Promise<void> {
    if (value.trim() === '') {
      this.hits.set(null);
      return;
    }
    try {
      const ids = await this.store.search(value);
      // an answer for a text that is no longer in the field is dropped
      if (this.text() === value) this.hits.set(new Set(ids));
    } catch {
      if (this.text() === value) this.hits.set(new Set());
    }
  }

  protected focusTree(): void {
    this.tree().nativeElement.focus();
    if (!this.active() && this.rows().length > 0) this.activeKey.set(this.rows()[0].key);
  }

  private toggle(folder: string, open?: boolean): void {
    this.closed.update((closed) => {
      const next = new Set(closed);
      const makeOpen = open ?? next.has(folder);
      if (makeOpen) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  private move(to: number): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    const row = rows[Math.max(0, Math.min(rows.length - 1, to))];
    this.activeKey.set(row.key);
    setTimeout(() =>
      document.getElementById(this.domId(row.key))?.scrollIntoView?.({ block: 'nearest' }),
    );
  }

  protected onKey(event: KeyboardEvent): void {
    const rows = this.rows();
    const at = rows.findIndex((r) => r.key === this.activeKey());
    const row = at >= 0 ? rows[at] : null;
    const mod = event.ctrlKey || event.metaKey;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case 'ArrowDown':
        handled();
        return this.move(at + 1);
      case 'ArrowUp':
        handled();
        return this.move(at < 0 ? 0 : at - 1);
      case 'Home':
        handled();
        return this.move(0);
      case 'End':
        handled();
        return this.move(rows.length - 1);
      case 'ArrowRight':
        if (row?.kind !== 'folder') return;
        handled();
        if (!row.open) this.toggle(row.folder, true);
        else this.move(at + 1);
        return;
      case 'ArrowLeft': {
        if (!row) return;
        handled();
        if (row.kind === 'folder' && row.open) return this.toggle(row.folder, false);
        // to the folder it is in
        for (let i = at - 1; i >= 0; i--) {
          if (rows[i].kind === 'folder' && rows[i].level < row.level) return this.move(i);
        }
        return;
      }
      case 'Enter':
        if (!row) return;
        handled();
        if (row.kind === 'folder') return this.toggle(row.folder);
        if (mod) void this.store.run(row.entry);
        else if (event.altKey) void this.store.insert(row.entry);
        else void this.store.open(row.entry);
        return;
      case 'F2':
        if (row?.kind !== 'query') return;
        handled();
        return this.edit(row.entry);
      case 'Delete':
      case 'Backspace':
        if (row?.kind !== 'query' || (event.key === 'Backspace' && !mod)) return;
        handled();
        return void this.remove(row.entry);
    }
  }

  protected onClick(event: MouseEvent, double = false): void {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-key]');
    const row = this.rows().find((r) => r.key === item?.dataset['key']);
    if (!row) return;
    this.activeKey.set(row.key);
    if (row.kind === 'folder') {
      if (!double) this.toggle(row.folder);
    } else if (double) {
      void this.store.open(row.entry);
    }
  }

  protected edit(entry: SavedEntry): void {
    this.store.request.set({ kind: 'edit', entry });
  }

  protected async remove(entry: SavedEntry): Promise<void> {
    const yes = await this.confirm.ask({
      title: this.t.deleteTitle,
      message: this.t.deleteQuestion(entry.name),
      confirm: this.t.delete,
    });
    if (yes) await this.store.remove(entry);
  }
}
