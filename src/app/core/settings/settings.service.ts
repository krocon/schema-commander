import { Injectable, effect, signal } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { LazyStore } from '@tauri-apps/plugin-store';
import { setLanguage, systemLanguage } from '../i18n/i18n';
import { DEFAULT_SETTINGS, Settings, mergeKeymap, mergeSettings } from './settings.models';

const STORE_KEY = 'settings';
const SAVE_DELAY_MS = 300;

/** Settings as a signal, persisted with tauri-plugin-store. The colour scheme puts the `ThemeService` on screen. */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly store = isTauri() ? new LazyStore('settings.json', { autoSave: false }) : null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  readonly settings = signal<Settings>(DEFAULT_SETTINGS);
  /** The stored settings are read (or could not be): the colour scheme is the user's from here on. */
  readonly loaded = signal(false);
  /** The stored shortcuts were unreadable (prompt 002); shown at the start. */
  readonly keymapNotice = signal<string | null>(null);

  constructor() {
    // the language of every text follows the setting, at once (prompt 017)
    effect(() => {
      const wanted = this.settings().language;
      setLanguage(wanted === 'system' ? systemLanguage() : wanted);
    });
    effect(() => {
      const settings = this.settings();
      if (this.loaded()) this.scheduleSave(settings);
    });
  }

  async load(): Promise<void> {
    try {
      const saved = await this.store?.get<unknown>(STORE_KEY);
      const keymap =
        saved && typeof saved === 'object'
          ? (saved as Record<string, unknown>)['keymap']
          : undefined;
      this.keymapNotice.set(mergeKeymap(keymap).notice);
      this.settings.set(mergeSettings(saved));
    } catch (e) {
      console.warn('settings could not be loaded, using defaults', e);
    }
    this.loaded.set(true);
  }

  update(change: Partial<Settings>): void {
    this.settings.update((s) => mergeSettings({ ...s, ...change }));
  }

  private scheduleSave(settings: Settings): void {
    if (!this.store) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const store = this.store;
    this.saveTimer = setTimeout(() => {
      void store
        .set(STORE_KEY, settings)
        .then(() => store.save())
        .catch((e) => console.warn('settings could not be saved', e));
    }, SAVE_DELAY_MS);
  }
}
