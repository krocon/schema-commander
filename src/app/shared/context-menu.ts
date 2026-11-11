import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
} from '@angular/core';

/** An entry of a context menu; `separator` draws a line above it. */
export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly separator?: boolean;
}

/** Where a menu opens so that it stays inside the window. */
export function menuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  windowWidth: number,
  windowHeight: number,
): { left: number; top: number } {
  return {
    left: Math.max(4, Math.min(x, windowWidth - width - 4)),
    top: Math.max(4, Math.min(y, windowHeight - height - 4)),
  };
}

/**
 * A context menu (APG menu): arrow keys, Home/End, Enter, Escape; a click outside closes it. The owner
 * shows it while it has something to offer and takes the focus back when it closes.
 */
@Component({
  selector: 'app-context-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="backdrop"
      tabindex="-1"
      aria-label="Menü schließen"
      (click)="closed.emit()"
      (contextmenu)="$event.preventDefault(); closed.emit()"
    ></button>
    <div
      class="menu"
      role="menu"
      tabindex="-1"
      [attr.aria-label]="label()"
      [style.left.px]="left"
      [style.top.px]="top"
      (keydown)="onKey($event)"
    >
      @for (item of items(); track item.id) {
        @if (item.separator) {
          <div class="line" role="separator"></div>
        }
        <button
          type="button"
          role="menuitem"
          [disabled]="item.disabled"
          (click)="picked.emit(item.id)"
        >
          {{ item.label }}
        </button>
      }
    </div>
  `,
  styles: `
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 40;
      border: 0;
      padding: 0;
      background: transparent;
    }
    .menu button {
      text-align: left;
      padding: 4px 10px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--text);
      font: inherit;
    }
    .menu {
      position: fixed;
      z-index: 41;
      min-width: 200px;
      max-width: 320px;
      padding: 4px;
      display: flex;
      flex-direction: column;
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .menu button:hover:not(:disabled),
    .menu button:focus-visible {
      background: var(--bg-hover);
      outline: none;
    }
    .menu button:disabled {
      color: var(--text-dim);
    }
    .line {
      height: 1px;
      margin: 4px 2px;
      background: var(--border);
    }
  `,
})
export class ContextMenu {
  readonly items = input.required<readonly MenuItem[]>();
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  readonly label = input('Kontextmenü');
  readonly picked = output<string>();
  readonly closed = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected left = 0;
  protected top = 0;

  constructor() {
    afterNextRender(() => {
      const menu = this.host.nativeElement.querySelector<HTMLElement>('.menu');
      if (!menu) return;
      const at = menuPosition(
        this.x(),
        this.y(),
        menu.offsetWidth,
        menu.offsetHeight,
        window.innerWidth,
        window.innerHeight,
      );
      menu.style.left = `${at.left}px`;
      menu.style.top = `${at.top}px`;
      this.entries()[0]?.focus();
    });
  }

  private entries(): HTMLElement[] {
    return [
      ...this.host.nativeElement.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)'),
    ];
  }

  protected onKey(event: KeyboardEvent): void {
    const entries = this.entries();
    const at = entries.indexOf(document.activeElement as HTMLElement);
    let to: number;
    if (event.key === 'ArrowDown') to = (at + 1) % entries.length;
    else if (event.key === 'ArrowUp') to = (at - 1 + entries.length) % entries.length;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = entries.length - 1;
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      this.closed.emit();
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    entries[to]?.focus();
  }
}
