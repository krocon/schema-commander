import { DEFAULT_SELECTION, ThemeSelection, sanitizeSelection } from '../theme/theme.models';

/** What the app remembers over a restart (`settings.json` in the app's config folder). */
export interface Settings {
  readonly themeSelection: ThemeSelection;
  readonly sidebarVisible: boolean;
  /** px */
  readonly sidebarWidth: number;
  /** Height of the result area, px. */
  readonly resultHeight: number;
}

export const DEFAULT_SETTINGS: Settings = {
  themeSelection: DEFAULT_SELECTION,
  sidebarVisible: true,
  sidebarWidth: 240,
  resultHeight: 300,
};

function size(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000
    ? Math.round(value)
    : fallback;
}

/** Stored settings, forgiving: every broken or missing value falls back to its default. */
export function mergeSettings(saved: unknown): Settings {
  const s = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {};
  return {
    themeSelection: sanitizeSelection(s['themeSelection']),
    sidebarVisible:
      typeof s['sidebarVisible'] === 'boolean'
        ? s['sidebarVisible']
        : DEFAULT_SETTINGS.sidebarVisible,
    sidebarWidth: size(s['sidebarWidth'], DEFAULT_SETTINGS.sidebarWidth),
    resultHeight: size(s['resultHeight'], DEFAULT_SETTINGS.resultHeight),
  };
}
