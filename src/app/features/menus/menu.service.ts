import { Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActionId, isActionId } from '../../core/actions/action-catalog';
import { ActionService } from '../../core/actions/action.service';
import { describeError } from '../../core/errors/app-error';
import { language } from '../../core/i18n/i18n';
import { MenuApi } from '../../core/menu/menu-api';
import { MenuItemState, NativeMenuSpec } from '../../core/menu/menu.models';
import { MenuCloseReason, MenuItem } from '../../shared/context-menu';
import {
  MenuDef,
  nativeStates,
  nativeStructureKey,
  resolveMenu,
  resolveMenuBar,
  stateChanges,
  toNativeSpec,
} from './menu-model';
import { MENU_TEXTS } from './menu-texts';

/** How long the native menu waits for more changes before it is told (states change in bursts). */
export const NATIVE_DEBOUNCE_MS = 150;

interface OpenContext {
  readonly x: number;
  readonly y: number;
  readonly defs: readonly MenuDef[];
  readonly label: string | null;
  /** Gives the focus back to what opened the menu. */
  readonly back: () => void;
}

/**
 * The menus (prompt 018): the menu bar – native on macOS, drawn by the window elsewhere – and the context
 * menus, all made of the same definitions. A menu holds no logic: every entry runs its action, like its
 * shortcut and the command palette do.
 */
@Injectable({ providedIn: 'root' })
export class MenuService {
  private readonly actions = inject(ActionService);
  private readonly api = inject(MenuApi);
  private readonly injector = inject(Injector);

  private readonly open = signal<OpenContext | null>(null);
  /** `unknown` until the backend answered; `html` = the window draws the menu bar itself. */
  readonly mode = signal<'unknown' | 'native' | 'html'>('unknown');
  /** A modal dialog is open: keys and menus wait. */
  readonly dialogOpen = signal(false);

  /** The open context menu; its entries stay live (a state may change while it is open). */
  readonly context = computed(() => {
    const open = this.open();
    if (!open) return null;
    const items: MenuItem[] = resolveMenu(open.defs, this.actions, this.actions.platform());
    return { x: open.x, y: open.y, label: open.label, items };
  });

  /** The menus of the bar the window draws. */
  readonly menuBar = computed(() => resolveMenuBar(this.actions, this.actions.platform()));

  private started = false;

  /** Starts the menu bar and the way back from the native menu to the actions. */
  init(): void {
    if (this.started) return;
    this.started = true;
    this.watchDialogs();
    const failed = (e: unknown) => this.actions.reportError(MENU_TEXTS.failed(describeError(e)));
    void this.api.subscribe((event) => this.onNativeEvent(event.id)).catch(() => undefined);
    const spec = computed(() => {
      // names follow the language; the engine brings the shortcuts
      language();
      this.actions.engine();
      return toNativeSpec(this.actions, this.actions.platform(), {
        quiet: this.actions.recording(),
        blocked: this.dialogOpen(),
      });
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sentStructure = '';
    let sentStates: ReadonlyMap<string, MenuItemState> = new Map();
    let latest: NativeMenuSpec | null = null;
    const flush = () => {
      timer = null;
      const next = latest;
      if (!next || this.mode() === 'html') return;
      const structure = nativeStructureKey(next);
      const states = nativeStates(next);
      if (structure !== sentStructure) {
        sentStructure = structure;
        sentStates = states;
        void this.api.setAppMenu(next).then(
          (native) => this.mode.set(native ? 'native' : 'html'),
          (e) => {
            // no backend (browser) is no failure: the window draws the bar
            this.mode.set('html');
            if ((e as { code?: string })?.code !== 'backend_unavailable') failed(e);
          },
        );
        return;
      }
      // only states changed: the items are switched, the menu is not built again
      if (this.mode() !== 'native') {
        timer = setTimeout(flush, NATIVE_DEBOUNCE_MS); // the first menu is still on its way
        return;
      }
      const changes = stateChanges(sentStates, states);
      sentStates = states;
      if (changes.length > 0) void this.api.setMenuState(changes).catch(failed);
    };
    effect(
      () => {
        const next = spec();
        untracked(() => {
          if (this.mode() === 'html') return;
          latest = next;
          if (timer !== null) clearTimeout(timer);
          // the first spec goes out at once
          timer = setTimeout(flush, sentStructure === '' ? 0 : NATIVE_DEBOUNCE_MS);
        });
      },
      { injector: this.injector },
    );
  }

  /** A native menu item was chosen. A key and its accelerator for the same press act once (`run`). */
  onNativeEvent(id: string): void {
    if (this.dialogOpen() || !isActionId(id)) return;
    this.actions.run(id, 'menu');
  }

  /** Opens a context menu at a point of the window. */
  openContext(
    defs: readonly MenuDef[],
    x: number,
    y: number,
    back: () => void,
    label: string | null = null,
  ): void {
    this.open.set({ defs, x, y, back, label });
  }

  /** An entry of the context menu: the focus goes back to the opener, then the action runs. */
  choose(id: string): void {
    const open = this.open();
    this.open.set(null);
    open?.back();
    if (isActionId(id)) setTimeout(() => this.actions.run(id));
  }

  /** An entry of the menu bar of the window. */
  run(id: string): void {
    if (isActionId(id)) this.actions.run(id as ActionId);
  }

  close(reason: MenuCloseReason): void {
    const open = this.open();
    this.open.set(null);
    if (open && reason !== 'outside') open.back();
  }

  /** Follows `<dialog open>`: the dialogs of the app are modal elements, there is no list of them. */
  private watchDialogs(): void {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const check = () => this.dialogOpen.set(document.querySelector('dialog[open]') !== null);
    new MutationObserver(check).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    check();
  }
}
