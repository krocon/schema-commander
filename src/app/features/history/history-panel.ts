import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { ActionService } from '../../core/actions/action.service';
import { describeError, toAppError } from '../../core/errors/app-error';
import { HistoryApi, HistoryEntry } from '../../core/history/history-api';
import { TabsStore } from '../tabs/tabs.store';
import { oneLine, whenLabel } from './history-logic';
import { HistoryService } from './history.service';

const PANEL_ENTRIES = 100;
const SEARCH_DELAY_MS = 200;

/**
 * The history as a view of the sidebar (prompt 016): the latest statements, a search, `Enter` or a double
 * click puts one into the editor in front. The dialog (prompt 010) stays the place for everything else.
 * The list is a listbox after the APG pattern: one stop in the tab order, arrows move.
 */
@Component({
  selector: 'app-history-panel',
  template: `
    <input
      type="search"
      class="search"
      aria-label="Verlauf durchsuchen"
      placeholder="Verlauf durchsuchen"
      autocomplete="off"
      spellcheck="false"
      [value]="text()"
      (input)="onSearch($any($event.target).value)"
      (keydown.arrowdown)="$event.preventDefault(); focusList()"
    />
    @if (problem(); as p) {
      <p class="message" role="alert">{{ p }}</p>
    } @else if (entries().length === 0) {
      <p class="message">{{ loading() ? 'Verlauf wird gelesen …' : 'Keine Einträge.' }}</p>
    }
    <ul
      #list
      class="list"
      role="listbox"
      aria-label="Zuletzt ausgeführt"
      tabindex="0"
      [attr.aria-activedescendant]="selected() ? 'hp-' + selected()!.id : null"
      (keydown)="onKey($event)"
      (click)="onClick($event)"
      (dblclick)="onClick($event, true)"
    >
      @for (entry of entries(); track entry.id) {
        <li
          role="option"
          [id]="'hp-' + entry.id"
          [class.failed]="entry.outcome === 'failed'"
          [attr.aria-selected]="entry.id === selectedId()"
          [attr.data-id]="entry.id"
          [title]="entry.connectionName + ' · ' + when(entry.at)"
        >
          <code>{{ line(entry.preview) }}</code>
          <small>{{ when(entry.at) }} · {{ entry.connectionName }}</small>
        </li>
      }
    </ul>
    <button type="button" class="all" (click)="actions.run('OPEN_HISTORY')">
      Ganzer Verlauf …{{ actions.hint('OPEN_HISTORY') }}
    </button>
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
    .list {
      flex: 1 1 0;
      min-height: 0;
      margin: 0;
      padding: 0;
      list-style: none;
      overflow: auto;
    }
    li {
      display: flex;
      flex-direction: column;
      padding: 3px 6px;
      border-left: 3px solid transparent;
      border-radius: var(--radius);
      cursor: default;
    }
    li:hover {
      background: var(--bg-hover);
    }
    li[aria-selected='true'] {
      background: var(--row-selected);
    }
    .list:focus-visible li[aria-selected='true'] {
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    li.failed {
      border-left-color: var(--error-edge);
    }
    code {
      font-family: var(--font-mono);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    small {
      color: var(--text-dim);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .message {
      margin: 0;
      color: var(--text-dim);
      font-size: 12px;
    }
    .all {
      flex: none;
    }
  `,
})
export class HistoryPanel {
  private readonly api = inject(HistoryApi);
  private readonly history = inject(HistoryService);
  private readonly tabs = inject(TabsStore);
  protected readonly actions = inject(ActionService);
  private readonly listEl = viewChild.required<ElementRef<HTMLElement>>('list');

  protected readonly text = signal('');
  private readonly searched = signal('');
  protected readonly entries = signal<readonly HistoryEntry[]>([]);
  protected readonly loading = signal(true);
  protected readonly problem = signal<string | null>(null);
  protected readonly selectedId = signal<number | null>(null);
  protected readonly selected = computed(
    () => this.entries().find((e) => e.id === this.selectedId()) ?? null,
  );
  protected readonly when = (at: number) => whenLabel(at);
  protected readonly line = (text: string) => oneLine(text, 120);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private asked = 0;

  constructor() {
    // read again when the search changes or a statement was noted
    effect(() => {
      this.history.changed();
      void this.load(this.searched());
    });
  }

  protected onSearch(text: string): void {
    this.text.set(text);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.searched.set(text), SEARCH_DELAY_MS);
  }

  private async load(text: string): Promise<void> {
    const mine = ++this.asked;
    try {
      const page = await this.api.list({ text, userOnly: true, limit: PANEL_ENTRIES });
      // an answer to an older question
      if (mine !== this.asked) return;
      this.entries.set(page.entries);
      this.problem.set(null);
    } catch (e) {
      if (mine !== this.asked) return;
      this.entries.set([]);
      this.problem.set(describeError(toAppError(e)));
    } finally {
      if (mine === this.asked) this.loading.set(false);
    }
  }

  protected focusList(): void {
    if (this.selectedId() === null) this.selectedId.set(this.entries()[0]?.id ?? null);
    this.listEl().nativeElement.focus();
  }

  /** A click chooses, a double click inserts (the list has the focus and the keys, not its options). */
  protected onClick(event: MouseEvent, insert = false): void {
    const id = Number((event.target as HTMLElement).closest<HTMLElement>('li')?.dataset['id']);
    const entry = this.entries().find((e) => e.id === id);
    if (!entry) return;
    this.selectedId.set(entry.id);
    if (insert) void this.insert(entry);
  }

  protected onKey(event: KeyboardEvent): void {
    const entries = this.entries();
    if (entries.length === 0) return;
    const at = entries.findIndex((e) => e.id === this.selectedId());
    const go = (to: number) => {
      event.preventDefault();
      const entry = entries[Math.max(0, Math.min(entries.length - 1, to))];
      this.selectedId.set(entry.id);
      setTimeout(() =>
        this.listEl()
          .nativeElement.querySelector(`#hp-${entry.id}`)
          ?.scrollIntoView?.({ block: 'nearest' }),
      );
    };
    switch (event.key) {
      case 'ArrowDown':
        return go(at + 1);
      case 'ArrowUp':
        return go(at - 1);
      case 'Home':
        return go(0);
      case 'End':
        return go(entries.length - 1);
      case 'Enter': {
        event.preventDefault();
        const entry = this.selected();
        if (entry) void this.insert(entry);
        return;
      }
    }
  }

  /** Into the editor of the tab in front, at the caret. */
  protected async insert(entry: HistoryEntry): Promise<void> {
    try {
      const text = await this.api.text(entry.id);
      this.tabs.active()?.insert(text);
    } catch (e) {
      this.problem.set(describeError(toAppError(e)));
    }
  }
}
