import {
  Component,
  ElementRef,
  OnInit,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ACTIONS, ActionId } from '../../core/actions/action-catalog';
import { ActionService } from '../../core/actions/action.service';
import { actionLabel, groupLabel } from '../../core/actions/action-texts';
import { MAX_RECENT_ACTIONS } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { PaletteEntry, markedParts, paletteHits, pushRecent } from './palette-logic';
import { PALETTE_TEXTS } from './palette-texts';

/**
 * The command palette (prompt 002): one field, fuzzy search over all actions with their shortcuts, the
 * recently used ones first. Enter runs the chosen action – after the dialog is closed, so the action finds
 * the focus where it was.
 */
@Component({
  selector: 'app-command-palette',
  template: `
    <dialog
      #dialog
      [attr.aria-label]="t.title"
      (cancel)="$event.preventDefault(); close()"
      (close)="onClosed()"
    >
      <input
        #field
        type="text"
        role="combobox"
        aria-controls="palette-list"
        aria-autocomplete="list"
        autocomplete="off"
        spellcheck="false"
        [attr.aria-label]="t.search"
        [placeholder]="t.placeholder"
        [attr.aria-expanded]="hits().length > 0"
        [attr.aria-activedescendant]="activeId()"
        [value]="query()"
        (input)="setQuery(field.value)"
        (keydown)="onKey($event)"
      />
      <ul #list id="palette-list" role="listbox" [attr.aria-label]="t.commands">
        @for (hit of hits(); track hit.entry.id; let i = $index) {
          <li
            role="option"
            tabindex="-1"
            [id]="'palette-option-' + hit.entry.id"
            [attr.aria-selected]="i === index()"
            [attr.aria-disabled]="!hit.entry.enabled"
            [class.active]="i === index()"
            [class.off]="!hit.entry.enabled"
            (click)="run(i)"
            (keydown.enter)="run(i)"
            (pointermove)="index.set(i)"
          >
            <span class="label">
              @for (part of parts(hit); track $index) {
                <span [class.hit]="part[1]">{{ part[0] }}</span>
              }
            </span>
            <span class="group">{{ hit.entry.group }}</span>
            @if (hit.entry.keys) {
              <kbd>{{ hit.entry.keys }}</kbd>
            }
          </li>
        }
      </ul>
      <p class="status" role="status">
        {{ hits().length === 0 ? t.none : t.count(hits().length) }}
      </p>
    </dialog>
  `,
  styles: `
    dialog {
      top: 12vh;
      margin: 0 auto;
      width: min(620px, calc(100vw - 32px));
      max-height: 70vh;
      padding: 0;
      background: var(--bg-panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 16px 40px rgb(0 0 0 / 35%);
    }
    dialog[open] {
      display: flex;
      flex-direction: column;
    }
    dialog::backdrop {
      background: rgb(0 0 0 / 20%);
    }
    input {
      flex: none;
      margin: 10px;
      padding: 6px 10px;
      font-size: 14px;
    }
    ul {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      margin: 0;
      padding: 0 6px;
      list-style: none;
    }
    li {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 5px 8px;
      border-radius: var(--radius);
      cursor: pointer;
    }
    li.active {
      background: var(--row-selected);
    }
    li.off {
      color: var(--text-dim);
      cursor: default;
    }
    .label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .hit {
      color: var(--accent);
      font-weight: 600;
    }
    .group,
    .status {
      color: var(--text-dim);
      font-size: 11.5px;
    }
    kbd {
      padding: 1px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-raised);
      font: 11.5px var(--font-ui);
      white-space: nowrap;
    }
    .status {
      flex: none;
      margin: 0;
      padding: 6px 14px 8px;
    }
  `,
})
export class CommandPalette implements OnInit {
  protected readonly t = PALETTE_TEXTS;
  private readonly actions = inject(ActionService);
  private readonly settings = inject(SettingsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  private readonly list = viewChild.required<ElementRef<HTMLElement>>('list');

  readonly closed = output<void>();

  protected readonly query = signal('');
  protected readonly index = signal(0);
  /** The action to run once the dialog is gone. */
  private chosen: ActionId | null = null;

  private readonly entries = computed<PaletteEntry[]>(() => {
    const engine = this.actions.engine();
    const platform = this.actions.platform();
    return ACTIONS.filter((a) => !('hidden' in a && a.hidden)).map((a) => {
      const first = this.actions.shortcuts(a.id)[0];
      return {
        id: a.id,
        label: actionLabel(a.id),
        group: groupLabel(a.group),
        keys: first && engine ? engine.formatShortcut(first, platform) : '',
        enabled: this.actions.isRegistered(a.id) && this.actions.canRun(a.id),
      };
    });
  });
  protected readonly hits = computed(() =>
    paletteHits(this.entries(), this.query(), this.settings.settings().recentActions),
  );
  protected readonly activeId = computed(() => {
    const hit = this.hits()[this.index()];
    return hit ? `palette-option-${hit.entry.id}` : null;
  });

  protected readonly parts = (hit: { entry: PaletteEntry; marks: readonly number[] }) =>
    markedParts(hit.entry.label, hit.marks);

  ngOnInit(): void {
    this.dialog().nativeElement.showModal();
    this.field().nativeElement.focus();
  }

  protected setQuery(value: string): void {
    this.query.set(value);
    this.index.set(0);
  }

  protected onKey(event: KeyboardEvent): void {
    const count = this.hits().length;
    const move = (to: number) => {
      event.preventDefault();
      if (count === 0) return;
      this.index.set((to + count) % count);
      this.scrollToActive();
    };
    switch (event.key) {
      case 'ArrowDown':
        return move(this.index() + 1);
      case 'ArrowUp':
        return move(this.index() - 1);
      case 'PageDown':
        return move(Math.min(count - 1, this.index() + 8));
      case 'PageUp':
        return move(Math.max(0, this.index() - 8));
      case 'Home':
        if (event.ctrlKey || event.metaKey) move(0);
        return;
      case 'End':
        if (event.ctrlKey || event.metaKey) move(count - 1);
        return;
      case 'Enter':
        event.preventDefault();
        if (!event.repeat) this.run(this.index());
        return;
    }
  }

  protected run(i: number): void {
    const hit = this.hits()[i];
    if (!hit || !hit.entry.enabled) return;
    this.chosen = hit.entry.id as ActionId;
    this.close();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  /** The dialog is gone and the focus is back where it was: now the action runs. */
  protected onClosed(): void {
    const id = this.chosen;
    this.chosen = null;
    this.closed.emit();
    if (!id) return;
    this.settings.update({
      recentActions: pushRecent(this.settings.settings().recentActions, id, MAX_RECENT_ACTIONS),
    });
    this.actions.run(id, 'other');
  }

  private scrollToActive(): void {
    const id = this.activeId();
    if (id)
      this.list().nativeElement.querySelector(`#${id}`)?.scrollIntoView?.({ block: 'nearest' });
  }
}
