import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  ContextMenu,
  MenuCloseReason,
  isTypeahead,
  typeaheadIndex,
} from '../../shared/context-menu';
import { MENU_TEXTS } from './menu-texts';
import { MenuService } from './menu.service';

/**
 * The menu bar in the window (Windows, Linux; prompt 018, after files-and-folders-tauri) after the APG
 * menubar pattern: one stop in the tab order, ←/→ move (also while a menu is open), ↓ / Enter / Space open,
 * Esc closes (focus back to the entry), a letter jumps to the menu starting with it, Tab in a drop-down
 * leaves the bar. The drop-downs are the `ContextMenu`.
 */
@Component({
  selector: 'app-menu-bar',
  imports: [ContextMenu],
  template: `
    @if (menus.mode() === 'html') {
      <div
        class="bar"
        role="menubar"
        [attr.aria-label]="t.menuBar"
        [attr.inert]="menus.dialogOpen() ? '' : null"
      >
        @for (m of menus.menuBar(); track m.id; let i = $index) {
          <button
            type="button"
            role="menuitem"
            class="top"
            aria-haspopup="menu"
            [attr.aria-expanded]="openIndex() === i"
            [attr.tabindex]="i === roving() ? 0 : -1"
            [attr.data-index]="i"
            (click)="toggle(i)"
            (mouseenter)="onHover(i)"
            (keydown)="onKey($event, i)"
          >
            {{ m.label }}
          </button>
        }
      </div>
      @for (d of dropdown(); track d.key) {
        <app-context-menu
          [items]="d.items"
          [x]="d.x"
          [y]="d.y"
          [label]="d.label"
          [autofocus]="d.focus"
          [anchor]="d.anchor"
          (picked)="onPicked($event)"
          (closed)="onClosed($event)"
          (sideways)="move($event, true)"
        />
      }
    }
  `,
  styleUrl: './menu-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MenuBar {
  protected readonly menus = inject(MenuService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly t = MENU_TEXTS;

  protected readonly roving = signal(0);
  protected readonly openIndex = signal<number | null>(null);
  private readonly openFocus = signal(true);
  /** A new key per opening: a fresh menu (focus, position, fit into the window). */
  private readonly openKey = signal(0);
  /** What had the focus before the bar took it: it gets it back. */
  private before: HTMLElement | null = null;

  protected readonly dropdown = computed(() => {
    const i = this.openIndex();
    const menu = i === null ? undefined : this.menus.menuBar()[i];
    if (i === null || !menu) return [];
    const button = this.button(i);
    const rect = button?.getBoundingClientRect();
    return [
      {
        key: this.openKey(),
        items: menu.items,
        label: menu.label,
        x: rect?.left ?? 0,
        y: rect?.bottom ?? 0,
        focus: this.openFocus(),
        anchor: button,
      },
    ];
  });

  protected toggle(i: number): void {
    if (this.openIndex() === i) {
      this.openIndex.set(null);
      return;
    }
    this.openAt(i, true);
  }

  protected onHover(i: number): void {
    if (this.openIndex() !== null && this.openIndex() !== i) this.openAt(i, false);
  }

  protected onKey(event: KeyboardEvent, i: number): void {
    const count = this.menus.menuBar().length;
    switch (event.key) {
      case 'ArrowRight':
        this.focusTop((i + 1) % count);
        break;
      case 'ArrowLeft':
        this.focusTop((i - 1 + count) % count);
        break;
      case 'Home':
        this.focusTop(0);
        break;
      case 'End':
        this.focusTop(count - 1);
        break;
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        this.openAt(i, true);
        break;
      case 'Escape':
        this.giveBack();
        break;
      default: {
        const labels = this.menus.menuBar().map((m) => m.label);
        const next = isTypeahead(event) ? typeaheadIndex(labels, i, event.key) : -1;
        if (next < 0) return;
        this.focusTop(next);
      }
    }
    event.preventDefault();
    event.stopPropagation();
  }

  /** ←/→ inside an open menu: the neighbour opens. */
  protected move(delta: -1 | 1, focus: boolean): void {
    const i = this.openIndex();
    if (i === null) return;
    const count = this.menus.menuBar().length;
    this.openAt((i + delta + count) % count, focus);
  }

  protected onPicked(id: string): void {
    this.openIndex.set(null);
    // the action acts where the user was (the editor, the grid), not in the menu bar
    this.giveBack();
    setTimeout(() => this.menus.run(id));
  }

  protected onClosed(reason: MenuCloseReason): void {
    const i = this.openIndex();
    this.openIndex.set(null);
    if (reason === 'tab') this.giveBack();
    else if (reason === 'key' && i !== null) this.focusTop(i);
  }

  private openAt(i: number, focus: boolean): void {
    const active = document.activeElement as HTMLElement | null;
    if (active && !this.host.nativeElement.contains(active)) this.before = active;
    this.roving.set(i);
    this.openFocus.set(focus);
    this.openKey.update((k) => k + 1);
    this.openIndex.set(i);
    if (!focus) {
      this.button(i)?.focus();
      return;
    }
    // the focus may sit in the menu that was just replaced (←/→): it must land in the new one
    setTimeout(() => {
      const menu = this.host.nativeElement.querySelector('app-context-menu');
      if (menu && !menu.contains(document.activeElement)) {
        (
          menu.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ??
          menu.querySelector<HTMLElement>('[role^="menuitem"]')
        )?.focus();
      }
    });
  }

  private giveBack(): void {
    const before = this.before;
    this.before = null;
    if (before?.isConnected) before.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }

  private focusTop(i: number): void {
    this.roving.set(i);
    this.button(i)?.focus();
  }

  private button(i: number): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(`[data-index="${i}"]`);
  }
}
