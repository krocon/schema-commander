import { Injectable } from '@angular/core';
import { call } from '../backend/call';
import { Theme } from './theme.models';

/** Mirrors `LoadedThemes` in src-tauri/src/themes.rs. */
export interface LoadedThemes {
  readonly themes: readonly Theme[];
  /** The file was broken or entries were ignored (English, from the backend). */
  readonly notice: string | null;
}

/** Version of `themes.json` (`VERSION` in themes.rs). */
export const THEMES_FILE_VERSION = 1;

/** The user's own colour schemes: `themes.json` in the app's config folder (design 001). */
export abstract class ThemeApi {
  abstract load(): Promise<LoadedThemes>;
  /** Replaces all stored schemes; rejects with `invalid_theme` / `too_large`. */
  abstract save(themes: readonly Theme[]): Promise<void>;
  /** The JSON of a file chosen in the native dialog, unchecked. */
  abstract importFile(path: string): Promise<unknown>;
  abstract exportFile(path: string, theme: Theme): Promise<void>;
}

@Injectable()
export class TauriThemeApi extends ThemeApi {
  load(): Promise<LoadedThemes> {
    return call('load_themes');
  }

  save(themes: readonly Theme[]): Promise<void> {
    return call('save_themes', { file: { version: THEMES_FILE_VERSION, themes } });
  }

  importFile(path: string): Promise<unknown> {
    return call('import_theme', { path });
  }

  exportFile(path: string, theme: Theme): Promise<void> {
    return call('export_theme', { path, theme });
  }
}
