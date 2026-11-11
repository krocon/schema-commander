import { Component, ElementRef, computed, effect, inject, input, signal } from '@angular/core';
import { ActionService } from '../../core/actions/action.service';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { COMMON_TEXTS } from '../../core/i18n/common-texts';
import { Group } from './layout-logic';
import { TAB_MENU } from '../menus/menu-model';
import { MenuService } from '../menus/menu.service';
import { TAB_BAR_TEXTS } from './tab-bar-texts';
import { QueryTab } from './query-tab';
import { TabsStore } from './tabs.store';

/**
 * The tab strip (prompt 004), after the APG tabs pattern: arrows move between tabs and show them at once,
 * `Delete` closes, `F2` or a double click renames, dragging reorders, the middle button closes. The colour of
 * a tab is that of its connection. In a split view (prompt 016) every group has its own strip; a tab dragged
 * onto the other strip moves to that group.
 */
@Component({
  selector: 'app-tab-bar',
  template: `
    <div class="tabs" role="tablist" [attr.aria-label]="label()">
      @for (tab of tabs(); track tab.id; let i = $index) {
        @let active = tab.id === shownId();
        <div
          role="tab"
          draggable="true"
          [id]="'tab-' + tab.id"
          [class]="'tab conn-' + color(tab)"
          [class.active]="active"
          [class.drop]="dropAt() === i"
          [attr.aria-selected]="active"
          [attr.aria-controls]="'pane-' + tab.id"
          [attr.data-id]="tab.id"
          [tabindex]="active ? 0 : -1"
          [title]="tooltip(tab)"
          (click)="store.activate(tab.id)"
          (keydown)="onKey($event)"
          (auxclick)="onAux($event, tab.id)"
          (dblclick)="startRename(tab)"
          (contextmenu)="openMenu($event, tab.id)"
          (dragstart)="onDragStart($event, tab.id)"
          (dragover)="onDragOver($event, i)"
          (dragleave)="dropAt.set(null)"
          (drop)="onDrop($event, i)"
          (dragend)="dropAt.set(null); store.dragged = null"
        >
          <i class="mark" [class.running]="tab.running()"></i>
          @if (renaming() === tab.id) {
            <input
              #rename
              class="rename"
              type="text"
              [attr.aria-label]="t.tabName"
              autocomplete="off"
              spellcheck="false"
              [value]="tab.title()"
              (click)="$event.stopPropagation()"
              (dblclick)="$event.stopPropagation()"
              (keydown)="onRenameKey($event, tab.id, rename.value)"
              (blur)="finishRename(tab.id, rename.value)"
            />
          } @else {
            <span class="title">{{ tab.title() }}</span>
            @if (tab.tx() === 'active' || tab.tx() === 'failed') {
              <span
                class="tx-mark"
                [class.failed]="tab.tx() === 'failed'"
                [title]="t.openTransaction"
                >TX</span
              >
            }
            @if (mark(tab); as m) {
              <span class="guard-mark">{{ m }}</span>
            }
            @if (tab.filePath() && tab.dirty()) {
              <span class="dirty" [title]="t.changedSinceSave" [attr.aria-label]="t.changed"
                >●</span
              >
            }
          }
          <button
            type="button"
            class="close"
            tabindex="-1"
            [attr.aria-label]="t.closeTab(tab.title())"
            [title]="common.close"
            (click)="$event.stopPropagation(); store.close(tab.id)"
          >
            ×
          </button>
        </div>
      }
    </div>
    <button
      type="button"
      class="new"
      [attr.aria-label]="t.newTab"
      [title]="t.newTab + actions.hint('NEW_TAB')"
      (click)="newTab()"
    >
      +
    </button>
  `,
  styleUrl: './tab-bar.css',
  host: {
    '[class.focused]': 'store.isSplit() && focused()',
    '[class.unfocused]': '!focused()',
    // a drop behind the last tab puts the dragged tab at the end of this group
    '(dragover)': 'onDragOver($event, tabs().length)',
    '(drop)': 'onDrop($event, tabs().length)',
  },
})
export class TabBar {
  protected readonly t = TAB_BAR_TEXTS;
  protected readonly common = COMMON_TEXTS;
  protected readonly store = inject(TabsStore);
  protected readonly actions = inject(ActionService);
  private readonly menus = inject(MenuService);
  private readonly connections = inject(ConnectionsStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The group whose tabs this strip shows. */
  readonly group = input<Group>(0);
  protected readonly tabs = computed(() => this.store.groups()[this.group()]);
  protected readonly shownId = computed(() => this.store.shownIds()[this.group()]);
  /** This strip belongs to the group that has the focus (always, while the view is not split). */
  protected readonly focused = computed(
    () => !this.store.isSplit() || this.store.focusedGroup() === this.group(),
  );
  protected readonly label = computed(() =>
    this.store.isSplit() ? this.t.queriesOfGroup(this.group() + 1) : this.t.queries,
  );

  /** The tab whose name is being edited (also asked for by the action `RENAME_TAB`). */
  protected readonly renaming = this.store.renaming;
  /** The index a dragged tab would land on. */
  protected readonly dropAt = signal<number | null>(null);

  private readonly colors = computed(
    () => new Map(this.connections.profiles().map((p) => [p.id, p.color])),
  );

  /** The mark of the tab's connection when it is protected or labelled. */
  protected mark(tab: QueryTab): string | null {
    const profile = this.connections.profiles().find((p) => p.id === tab.connectionId());
    if (!profile) return null;
    return profile.label.trim() || (profile.protection === 'free' ? null : '🔒');
  }

  protected color(tab: QueryTab): number {
    return this.colors().get(tab.connectionId()) ?? 1;
  }

  protected tooltip(tab: QueryTab): string {
    const name = this.connections.profiles().find((p) => p.id === tab.connectionId())?.name ?? '';
    return [tab.title(), name, tab.filePath()].filter(Boolean).join('\n');
  }

  /** A new tab in this group. */
  protected newTab(): void {
    const shown = this.shownId();
    if (shown) this.store.activate(shown);
    this.actions.run('NEW_TAB');
  }

  /** Arrows, Home and End move and show; Delete closes; F2 renames. */
  protected onKey(event: KeyboardEvent): void {
    if (this.renaming() !== null) return;
    const tabs = this.tabs();
    const index = tabs.findIndex((t) => t.id === this.shownId());
    const go = (to: number) => {
      event.preventDefault();
      const tab = tabs[(to + tabs.length) % tabs.length];
      if (!tab) return;
      this.store.activate(tab.id);
      this.focusTab(tab.id);
    };
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      if (tabs[index]) this.openMenuByKey(tabs[index].id);
      return;
    }
    switch (event.key) {
      case 'ArrowRight':
        return go(index + 1);
      case 'ArrowLeft':
        return go(index - 1);
      case 'Home':
        return go(0);
      case 'End':
        return go(tabs.length - 1);
      case 'Delete': {
        event.preventDefault();
        const id = this.shownId();
        if (id) void this.store.close(id).then(() => this.focusTab(this.store.activeId()));
        return;
      }
      case 'F2':
        event.preventDefault();
        if (tabs[index]) this.startRename(tabs[index]);
        return;
      case 'Enter':
      case ' ':
        // into the editor of the tab
        event.preventDefault();
        if (tabs[index]) this.store.activate(tabs[index].id);
        this.store.active()?.focus();
        return;
    }
  }

  protected onAux(event: MouseEvent, id: string): void {
    if (event.button !== 1) return;
    event.preventDefault();
    void this.store.close(id);
  }

  constructor() {
    // the field of a tab that is being renamed gets the focus, whoever asked for it
    effect(() => {
      const id = this.renaming();
      if (id === null || !this.tabs().some((t) => t.id === id)) return;
      setTimeout(() => {
        const field = this.host.nativeElement.querySelector<HTMLInputElement>('.rename');
        if (field && document.activeElement !== field) {
          field.focus();
          field.select();
        }
      });
    });
  }

  protected startRename(tab: QueryTab): void {
    this.renaming.set(tab.id);
    setTimeout(() => {
      const field = this.host.nativeElement.querySelector<HTMLInputElement>('.rename');
      field?.focus();
      field?.select();
    });
  }

  protected onRenameKey(event: KeyboardEvent, id: string, value: string): void {
    // the keys of the field are its own (arrows must not switch tabs)
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      this.finishRename(id, value);
      this.focusTab(id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.renaming.set(null);
      this.focusTab(id);
    }
  }

  protected finishRename(id: string, value: string): void {
    if (this.renaming() !== id) return;
    this.renaming.set(null);
    this.store.rename(id, value);
  }

  /** The menu of a tab: the tab comes to the front, so the actions of the menu mean it. */
  protected openMenu(event: MouseEvent, id: string): void {
    event.preventDefault();
    this.store.activate(id);
    this.menus.openContext(
      TAB_MENU,
      event.clientX,
      event.clientY,
      () => this.focusTab(id),
      this.t.menu,
    );
  }

  /** `Shift+F10` or the menu key on a tab: its menu, under the tab. */
  private openMenuByKey(id: string): void {
    const rect = this.host.nativeElement
      .querySelector(`[role=tab][data-id="${CSS.escape(id)}"]`)
      ?.getBoundingClientRect();
    this.store.activate(id);
    this.menus.openContext(
      TAB_MENU,
      rect ? rect.left + 12 : 0,
      rect ? rect.bottom : 0,
      () => this.focusTab(id),
      this.t.menu,
    );
  }

  protected onDragStart(event: DragEvent, id: string): void {
    this.store.dragged = id;
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected onDragOver(event: DragEvent, index: number): void {
    if (this.store.dragged === null) return;
    event.preventDefault();
    // the strip itself is asked too (a drop behind the last tab): the tab under the pointer answers first
    event.stopPropagation();
    this.dropAt.set(index);
  }

  protected onDrop(event: DragEvent, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    this.dropAt.set(null);
    if (this.store.dragged !== null) this.store.move(this.store.dragged, index, this.group());
    this.store.dragged = null;
  }

  private focusTab(id: string | null): void {
    if (!id) return;
    setTimeout(() =>
      this.host.nativeElement
        .querySelector<HTMLElement>(`[role=tab][data-id="${CSS.escape(id)}"]`)
        ?.focus(),
    );
  }
}
