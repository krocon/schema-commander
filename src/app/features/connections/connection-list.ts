import { Component, computed, inject, output, signal } from '@angular/core';
import { ActionService } from '../../core/actions/action.service';
import { DEMO_ID, Profile, whereLabel } from '../../core/connections/connection.models';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { CONNECTION_MENU } from '../menus/menu-model';
import { MenuService } from '../menus/menu.service';
import { groupProfiles, kindName } from './connection-logic';
import { CONNECTION_TEXTS } from './connection-texts';

/**
 * The connections in the sidebar (prompt 003): by folder, each with its colour and state. A click makes a
 * connection the active one (statements run there), a double click or Enter connects.
 */
@Component({
  selector: 'app-connection-list',
  template: `
    <div class="head">
      <h2 id="connections-title">{{ t.title }}</h2>
      <button
        type="button"
        [attr.aria-label]="t.newConnection"
        [title]="t.newConnection + actions.hint('NEW_CONNECTION')"
        (click)="actions.run('NEW_CONNECTION')"
      >
        +
      </button>
    </div>
    @if (store.profiles().length > 6) {
      <input
        #filterInput
        type="search"
        class="filter"
        [attr.aria-label]="t.filterLabel"
        [placeholder]="t.filter"
        autocomplete="off"
        spellcheck="false"
        [value]="filter()"
        (input)="filter.set(filterInput.value)"
      />
    }
    @if (store.notice(); as notice) {
      <p class="note" role="note">{{ notice }}</p>
    }
    @for (group of groups(); track group.folder) {
      @if (group.folder) {
        <h3>{{ group.folder }}</h3>
      }
      <ul [attr.aria-label]="group.folder || t.title">
        @for (p of group.profiles; track p.id) {
          @let state = store.state(p.id);
          <li [class]="'conn-' + p.color" [class.active]="p.id === store.activeId()">
            <button
              type="button"
              class="item"
              [attr.aria-current]="p.id === store.activeId() ? 'true' : null"
              [title]="title(p)"
              (click)="store.activate(p.id)"
              (contextmenu)="openMenu($event, p.id)"
              (keydown)="onItemKey($event, p.id)"
              (dblclick)="connect(p.id)"
              (keydown.enter)="$event.preventDefault(); connect(p.id)"
            >
              <i class="dot" [class.open]="state.kind === 'open'"></i>
              <span class="name">{{ p.name }}</span>
              <span class="state">
                @switch (state.kind) {
                  @case ('open') {
                    {{ t.stateOpen }}
                  }
                  @case ('connecting') {
                    {{ t.stateConnecting }}
                  }
                  @case ('failed') {
                    {{ t.stateFailed }}
                  }
                }
              </span>
            </button>
            @if (state.kind === 'open') {
              <button
                type="button"
                class="tool"
                [attr.aria-label]="t.disconnectName(p.name)"
                [title]="t.disconnect"
                (click)="store.disconnect(p.id)"
              >
                ⏏
              </button>
            } @else {
              <button
                type="button"
                class="tool"
                [attr.aria-label]="t.connectName(p.name)"
                [title]="t.connect"
                [disabled]="state.kind === 'connecting'"
                (click)="connect(p.id)"
              >
                ⏻
              </button>
            }
            @if (p.id !== demoId) {
              <button
                type="button"
                class="tool"
                [attr.aria-label]="t.editName(p.name)"
                [title]="t.edit"
                (click)="edit.emit(p)"
              >
                ✎
              </button>
            }
          </li>
          @if (state.kind === 'failed') {
            <li class="error" role="alert">{{ state.message }}</li>
          }
        }
      </ul>
    }
    @if (groups().length === 0) {
      <p class="note" role="status">{{ t.noMatch }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    h2,
    h3 {
      margin: 0 0 4px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-dim);
    }
    h3 {
      margin-top: 10px;
      text-transform: none;
      letter-spacing: 0;
      font-size: 12px;
    }
    .filter {
      width: 100%;
      margin: 4px 0 6px;
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      align-items: center;
      border-radius: var(--radius);
      border-left: 3px solid transparent;
    }
    li.active {
      background: var(--row-selected);
      border-left-color: var(--conn);
    }
    .item {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      text-align: left;
      padding: 3px 6px;
    }
    .dot {
      flex: none;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      border: 2px solid var(--conn);
    }
    .dot.open {
      background: var(--conn);
    }
    .name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .state {
      color: var(--text-dim);
      font-size: 11px;
    }
    .tool {
      flex: none;
      padding: 2px 5px;
      color: var(--text-dim);
    }
    .error {
      display: block;
      margin: 2px 0 6px 12px;
      padding: 4px 8px;
      border-left: 3px solid var(--error-edge);
      background: var(--error-bg);
      color: var(--error-fg);
      font-size: 12px;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .note {
      margin: 6px 0;
      color: var(--text-dim);
      font-size: 12px;
    }
  `,
})
export class ConnectionList {
  protected readonly store = inject(ConnectionsStore);
  protected readonly actions = inject(ActionService);
  private readonly menus = inject(MenuService);

  /** The menu of a connection: it becomes the active one, so the actions of the menu mean it. */
  protected openMenu(event: MouseEvent, id: string): void {
    event.preventDefault();
    this.showMenu(event.currentTarget as HTMLElement, id, event.clientX, event.clientY);
  }

  /** `Shift+F10` or the menu key on a connection. */
  protected onItemKey(event: KeyboardEvent, id: string): void {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    const item = event.currentTarget as HTMLElement;
    const rect = item.getBoundingClientRect();
    this.showMenu(item, id, rect.left + 16, rect.bottom);
  }

  private showMenu(item: HTMLElement, id: string, x: number, y: number): void {
    this.store.activate(id);
    this.menus.openContext(CONNECTION_MENU, x, y, () => item.focus());
  }
  protected readonly t = CONNECTION_TEXTS;

  /** Asks for the dialog of a profile. */
  readonly edit = output<Profile>();

  protected readonly demoId = DEMO_ID;
  protected readonly filter = signal('');
  protected readonly groups = computed(() => groupProfiles(this.store.profiles(), this.filter()));

  protected title(p: Profile): string {
    const state = this.store.state(p.id);
    const version = state.kind === 'open' ? `\n${state.serverVersion}` : '';
    return `${kindName(p.kind)} · ${whereLabel(p)}${version}`;
  }

  protected connect(id: string): void {
    this.store.activate(id);
    void this.store.connect(id);
  }
}
