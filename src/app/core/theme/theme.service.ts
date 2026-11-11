import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { WindowApi } from '../backend/window-api';
import { ThemeApi } from './theme-api';
import { SettingsService } from '../settings/settings.service';
import { THEME_TEXTS } from './theme-texts';
import {
  BUILT_IN_DARK,
  Theme,
  ThemeEditRequest,
  ThemeSelection,
  isBaseTheme,
  isUserTheme,
  sanitizeSelection,
  selectedId,
} from './theme.models';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** What the lazy chunk of the schemes provides. */
export interface ThemeCatalog {
  readonly themes: readonly Theme[];
  /** Whether a token may be put on `<html>` with this value (catalog token, value of its kind). */
  readonly applicable: (name: string, value: string) => boolean;
}

/** The name of a base scheme in the current language (the scheme files hold one fixed name). */
function baseName(id: 'dark' | 'light'): string {
  return id === 'dark' ? THEME_TEXTS.dark : THEME_TEXTS.light;
}

/** A built-in scheme as the user reads it: dark and light are named in the current language. */
function localized(theme: Theme): Theme {
  return theme.id === 'dark' || theme.id === 'light'
    ? { ...theme, name: baseName(theme.id) }
    : theme;
}

/** dark and light before the schemes are loaded: their tokens are `styles.css` itself. */
const BASE_STUB: Readonly<Record<'dark' | 'light', Theme>> = {
  dark: {
    id: 'dark',
    get name() {
      return baseName('dark');
    },
    dark: true,
    tokens: {},
  },
  light: {
    id: 'light',
    get name() {
      return baseName('light');
    },
    dark: false,
    tokens: {},
  },
};

/**
 * Colour schemes (after log-commander and files-and-folders): the selection (fixed, or following the system with a light and a dark scheme),
 * the live preview of the picker, and putting the scheme on screen: tokens inline on `<html>` (only what
 * differs from `styles.css`), `data-theme`, `color-scheme`, `meta theme-color` and the native window frame. The schemes themselves load on demand; dark and
 * light need nothing loaded. Parts that paint themselves (canvas, the
 * embedded editor) follow through a MutationObserver on `data-theme` and `style` of `<html>`, which every
 * change here touches.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly settingsService = inject(SettingsService);
  private readonly api = inject(WindowApi);
  private readonly themeApi = inject(ThemeApi);

  readonly selection = computed<ThemeSelection>(() =>
    sanitizeSelection(this.settingsService.settings().themeSelection),
  );
  /** `prefers-color-scheme: dark`, live. */
  readonly systemDark = signal(false);
  /** A scheme tried in the picker, shown instead of the active one. */
  readonly preview = signal<Theme | null>(null);
  /** The built-in schemes, once loaded (`loadCatalog`). */
  readonly catalog = signal<ThemeCatalog | null>(null);
  /** The picker dialog (toolbar). */
  readonly pickerOpen = signal(false);
  /** The scheme editor is open with this scheme (design 001). */
  readonly editing = signal<ThemeEditRequest | null>(null);
  /** The user's own schemes (design 001), stored in `themes.json`. */
  readonly userThemes = signal<readonly Theme[]>([]);
  /** The own schemes are read (or could not be). */
  readonly userLoaded = signal(false);
  /** What reading the own schemes had to say (broken file, ignored entries). */
  readonly notice = signal<string | null>(null);
  /** Built-in and own schemes, once the built-in ones are loaded. */
  readonly themes = computed<readonly Theme[]>(() => [...this.builtIn(), ...this.userThemes()]);
  /** The built-in schemes with the names of the current language. */
  private readonly builtIn = computed<readonly Theme[]>(() =>
    (this.catalog()?.themes ?? []).map(localized),
  );

  readonly activeId = computed(() => selectedId(this.selection(), this.systemDark()));

  /** The active scheme; an unknown id falls back to the base of its brightness. `null` = still loading. */
  readonly active = computed<Theme | null>(() => {
    const id = this.activeId();
    const catalog = this.catalog();
    const own = isUserTheme(id) ? this.userThemes().find((t) => t.id === id) : undefined;
    const dark = BUILT_IN_DARK[id] ?? own?.dark ?? this.systemDark();
    // an own scheme that is not read yet: wait, do not flash the base
    if (isUserTheme(id) && !own && !this.userLoaded()) return null;
    if (catalog) {
      return own ?? this.builtIn().find((t) => t.id === id) ?? this.base(dark);
    }
    return isBaseTheme(id) || this.failed() ? this.base(dark) : null;
  });

  /** What is on screen: the preview or the active scheme (`null` while its colours load). */
  readonly applied = computed<Theme | null>(() => this.preview() ?? this.active());

  private readonly failed = signal(false);
  private loading: Promise<ThemeCatalog | null> | null = null;
  private appliedNames = new Set<string>();
  /** Last frame sent to Rust (`color|dark`). */
  private chrome = '';

  constructor() {
    const media = typeof matchMedia === 'function' ? matchMedia(DARK_QUERY) : null;
    if (media) {
      this.systemDark.set(media.matches);
      const onChange = (e: MediaQueryListEvent) => this.systemDark.set(e.matches);
      media.addEventListener?.('change', onChange);
      inject(DestroyRef).onDestroy(() => media.removeEventListener?.('change', onChange));
    }
    effect(() => {
      const theme = this.applied();
      if (!theme) {
        void this.loadCatalog();
        return;
      }
      this.apply(theme);
      // The window stays hidden until the stored scheme is on (no flash of the default scheme).
      if (this.settingsService.loaded() && this.userLoaded()) this.applyWindowChrome(theme);
    });
  }

  /** Loads the built-in schemes (once); resolves with them, `null` if the chunk failed. */
  loadCatalog(): Promise<ThemeCatalog | null> {
    this.loading ??= Promise.all([import('./builtin-themes'), import('./theme-logic')])
      .then(([themes, logic]) => {
        const catalog: ThemeCatalog = {
          themes: themes.BUILT_IN_THEMES,
          applicable: logic.applicableToken,
        };
        this.catalog.set(catalog);
        return catalog;
      })
      .catch((e) => {
        console.warn('colour schemes could not be loaded', e);
        this.failed.set(true);
        return null;
      });
    return this.loading;
  }

  find(id: string): Theme | undefined {
    return this.themes().find((t) => t.id === id);
  }

  /** Reads the own schemes (once, at start). Never rejects: without them the built-in ones remain. */
  async loadUserThemes(): Promise<void> {
    try {
      const loaded = await this.themeApi.load();
      this.userThemes.set(loaded.themes.filter((t) => isUserTheme(t.id)));
      this.notice.set(loaded.notice);
    } catch (e) {
      // no backend (browser, tests without a fake): no own schemes
      console.warn('own colour schemes could not be loaded', e);
    }
    this.userLoaded.set(true);
  }

  /** Stores an own scheme (new or changed) and returns when it is on disk; rejects with an `AppError`. */
  async saveUserTheme(theme: Theme): Promise<void> {
    const others = this.userThemes().filter((t) => t.id !== theme.id);
    const next = [...others, theme].sort((a, b) => a.name.localeCompare(b.name));
    await this.themeApi.save(next);
    this.userThemes.set(next);
  }

  /** Writes one scheme to a file the user chose; rejects with an `AppError`. */
  exportTheme(path: string, theme: Theme): Promise<void> {
    return this.themeApi.exportFile(path, theme);
  }

  /** The JSON of a file the user chose, unchecked; rejects with an `AppError`. */
  importFile(path: string): Promise<unknown> {
    return this.themeApi.importFile(path);
  }

  /** Removes an own scheme; a selection that used it goes back to the base of its brightness. */
  async deleteUserTheme(id: string): Promise<void> {
    const gone = this.userThemes().find((t) => t.id === id);
    if (!gone) return;
    const next = this.userThemes().filter((t) => t.id !== id);
    await this.themeApi.save(next);
    this.userThemes.set(next);
    const s = this.selection();
    const base = gone.dark ? 'dark' : 'light';
    this.setSelection({
      mode: s.mode,
      theme: s.theme === id ? base : s.theme,
      light: s.light === id ? 'light' : s.light,
      dark: s.dark === id ? 'dark' : s.dark,
    });
  }

  /** A fixed scheme. */
  select(id: string): void {
    this.setSelection({ ...this.selection(), mode: 'fixed', theme: id });
  }

  /** Follow `prefers-color-scheme`, optionally with another light or dark scheme. */
  followSystem(pair: { light?: string; dark?: string } = {}): void {
    const s = this.selection();
    this.setSelection({
      ...s,
      mode: 'system',
      light: pair.light ?? s.light,
      dark: pair.dark ?? s.dark,
    });
  }

  private setSelection(selection: ThemeSelection): void {
    this.settingsService.update({ themeSelection: sanitizeSelection(selection) });
  }

  private base(dark: boolean): Theme {
    const id = dark ? 'dark' : 'light';
    return this.builtIn().find((t) => t.id === id) ?? BASE_STUB[id];
  }

  private apply(theme: Theme): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const catalog = this.catalog();
    const values = new Map<string, string>();
    // dark and light are styles.css itself; other schemes only differ from it, and only catalog tokens
    // with a value of their kind get through
    if (!isBaseTheme(theme.id) && catalog) {
      for (const [name, value] of Object.entries(theme.tokens)) {
        if (catalog.applicable(name, value)) values.set(name, value.trim());
      }
    }
    for (const name of this.appliedNames) {
      if (!values.has(name)) root.style.removeProperty(name);
    }
    for (const [name, value] of values) root.style.setProperty(name, value);
    this.appliedNames = new Set(values.keys());
    root.dataset['theme'] = theme.dark ? 'dark' : 'light';
    root.style.colorScheme = theme.dark ? 'dark' : 'light';
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = this.backgroundHex() ?? (theme.dark ? '#14171c' : '#fbfbfc');
  }

  /** `--bg-app` as painted now (schemes and styles.css hold it as `#rrggbb`). */
  private backgroundHex(): string | null {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
  }

  /**
   * The native frame: background `--bg-app`, appearance of the scheme. Following the system, the appearance is
   * left to the system: it also sets the webview's `prefers-color-scheme`, and a forced one would no longer
   * follow the system (the scheme follows the same system, so frame and scheme still match).
   */
  private applyWindowChrome(theme: Theme): void {
    const color = this.backgroundHex();
    if (!color) return;
    const dark = this.selection().mode === 'system' ? null : theme.dark;
    const key = `${color}|${dark}`;
    if (key === this.chrome) return;
    this.chrome = key;
    // no backend (browser, tests): the frame keeps the system colours
    this.api.setWindowChrome(color, dark).catch(() => undefined);
  }
}
