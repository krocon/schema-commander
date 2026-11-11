import { Injectable } from '@angular/core';
import { call } from './call';

/** The native window. Tests provide a fake. */
export abstract class WindowApi {
  /**
   * Background (`#rrggbb`) and appearance of the window frame; `dark = null` leaves the appearance to
   * the system. The first call shows the window (it starts hidden).
   */
  abstract setWindowChrome(color: string, dark: boolean | null): Promise<void>;
  /** The language of the native parts (the menu bar of macOS): `en` or `de`. */
  abstract setLanguage(language: string): Promise<void>;
}

@Injectable()
export class TauriWindowApi extends WindowApi {
  setWindowChrome(color: string, dark: boolean | null): Promise<void> {
    return call('set_window_chrome', { color, dark });
  }
  setLanguage(language: string): Promise<void> {
    return call('set_language', { language });
  }
}
