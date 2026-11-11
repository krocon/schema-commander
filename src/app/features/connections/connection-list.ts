import { Component, computed, inject, output, signal } from '@angular/core';
import { ActionService } from '../../core/actions/action.service';
import { DEMO_ID, Profile, kindLabel, whereLabel } from '../../core/connections/connection.models';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { groupProfiles } from './connection-logic';

/**
 * The connections in the sidebar (prompt 003): by folder, each with its colour and state. A click makes a
 * connection the active one (statements run there), a double click or Enter connects.
 */
@Component({
  selector: 'app-connection-list',
  template: `
    <div class="head">
      <h2 id="connections-title">Verbindungen</h2>
      <button
        type="button"
        aria-label="Neue Verbindung"
        [title]="'Neue Verbindung' + actions.hint('NEW_CONNECTION')"
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
        aria-label="Verbindungen filtern"
        placeholder="Filter"
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
      <ul [attr.aria-label]="group.folder || 'Verbindungen'">
        @for (p of group.profiles; track p.id) {
          @let state = store.state(p.id);
          <li [class]="'conn-' + p.color" [class.active]="p.id === store.activeId()">
            <button
              type="button"
              class="item"
              [attr.aria-current]="p.id === store.activeId() ? 'true' : null"
              [title]="title(p)"
              (click)="store.activate(p.id)"
              (dblclick)="connect(p.id)"
              (keydown.enter)="$event.preventDefault(); connect(p.id)"
            >
              <i class="dot" [class.open]="state.kind === 'open'"></i>
              <span class="name">{{ p.name }}</span>
              <span class="state">
                @switch (state.kind) {
                  @case ('open') {
                    verbunden
                  }
                  @case ('connecting') {
                    verbindet …
                  }
                  @case ('failed') {
                    Fehler
                  }
                }
              </span>
            </button>
            @if (state.kind === 'open') {
              <button
                type="button"
                class="tool"
                [attr.aria-label]="p.name + ' trennen'"
                title="Trennen"
                (click)="store.disconnect(p.id)"
              >
                ⏏
              </button>
            } @else {
              <button
                type="button"
                class="tool"
                [attr.aria-label]="p.name + ' verbinden'"
                title="Verbinden"
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
                [attr.aria-label]="p.name + ' bearbeiten'"
                title="Bearbeiten"
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
      <p class="note" role="status">Keine Verbindung passt zum Filter.</p>
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

  /** Asks for the dialog of a profile. */
  readonly edit = output<Profile>();

  protected readonly demoId = DEMO_ID;
  protected readonly filter = signal('');
  protected readonly groups = computed(() => groupProfiles(this.store.profiles(), this.filter()));

  protected title(p: Profile): string {
    const state = this.store.state(p.id);
    const version = state.kind === 'open' ? `\n${state.serverVersion}` : '';
    return `${kindLabel(p.kind)} · ${whereLabel(p)}${version}`;
  }

  protected connect(id: string): void {
    this.store.activate(id);
    void this.store.connect(id);
  }
}
