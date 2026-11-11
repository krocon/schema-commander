import { Injectable } from '@angular/core';
import { Channel, isTauri } from '@tauri-apps/api/core';
import { call } from '../backend/call';
import { MenuItemState, NativeMenuEvent, NativeMenuSpec } from './menu.models';

/**
 * The native menu bar (prompt 018, `app_menu.rs`). The default is the Tauri one, so every component that
 * opens a context menu works without a provider; without a backend (browser, tests) the calls reject and
 * the window draws the bar itself. Tests that look at the native menu provide a fake.
 */
@Injectable({ providedIn: 'root', useFactory: () => new TauriMenuApi() })
export abstract class MenuApi {
  /**
   * Installs the menu bar; `false` = this platform has no native one and the window draws its own.
   * Rejects when the backend refuses the spec.
   */
  abstract setAppMenu(spec: NativeMenuSpec): Promise<boolean>;
  /** Enables, disables and ticks items of the installed menu without building it again. */
  abstract setMenuState(items: readonly MenuItemState[]): Promise<void>;
  /** The ids of chosen menu items. */
  abstract subscribe(onEvent: (event: NativeMenuEvent) => void): Promise<void>;
}

@Injectable()
export class TauriMenuApi extends MenuApi {
  setAppMenu(spec: NativeMenuSpec): Promise<boolean> {
    return call('set_app_menu', { spec });
  }
  setMenuState(items: readonly MenuItemState[]): Promise<void> {
    return call('set_menu_state', { items });
  }
  async subscribe(onEvent: (event: NativeMenuEvent) => void): Promise<void> {
    // without Tauri not even a channel can be made: `call` says so as a rejection
    if (!isTauri()) return call('subscribe_menu');
    const channel = new Channel<NativeMenuEvent>();
    channel.onmessage = onEvent;
    return call('subscribe_menu', { onEvent: channel });
  }
}
