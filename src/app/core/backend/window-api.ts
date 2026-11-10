import { Injectable } from '@angular/core';
import { call } from './call';

/** The native window. Tests provide a fake. */
export abstract class WindowApi {
  /**
   * Background (`#rrggbb`) and appearance of the window frame; `dark = null` leaves the appearance to
   * the system. The first call shows the window (it starts hidden).
   */
  abstract setWindowChrome(color: string, dark: boolean | null): Promise<void>;
}

@Injectable()
export class TauriWindowApi extends WindowApi {
  setWindowChrome(color: string, dark: boolean | null): Promise<void> {
    return call('set_window_chrome', { color, dark });
  }
}
