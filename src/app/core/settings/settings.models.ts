import { DEFAULT_SELECTION, ThemeSelection, sanitizeSelection } from '../theme/theme.models';

/** What the app remembers over a restart (`settings.json` in the app's config folder). */
export interface Settings {
  readonly themeSelection: ThemeSelection;
  readonly sidebarVisible: boolean;
  /** px */
  readonly sidebarWidth: number;
  /** Height of the result area, px. */
  readonly resultHeight: number;
  /** Own shortcuts (prompt 002): only the actions that differ from the default keymap, `[]` = none. */
  readonly keymap: KeymapSetting;
  /** The connection statements run on (prompt 003); unknown ids fall back to the demo database. */
  readonly activeConnection: string;
  /** Leave out the rest of a script after a statement failed (prompt 005). */
  readonly stopOnError: boolean;
  /** Time at most per statement in seconds; 0 = as long as it takes. */
  readonly statementTimeoutSec: number;
  /** Show numbers in the result with their digits in groups of three (prompt 007); never when copying. */
  readonly groupDigits: boolean;
  /** Show the schemas of the database itself in the tree (prompt 008). */
  readonly showSystemSchemas: boolean;
  /** Copying from a result (prompt 009): a first line with the column names. */
  readonly copyHeader: boolean;
  /** NULL in copied text: `''`, `NULL` or `\\N`. */
  readonly copyNullAs: string;
  /** The separator of CSV: `,`, `;` or a tab. */
  readonly csvDelimiter: string;
  /** The format "copy as" used last (on top of its menu); `null` = none yet. */
  readonly lastCopyFormat: string | null;
  /** Note statements in the history (prompt 010). */
  readonly historyEnabled: boolean;
  /** Ids of the connections whose statements are not noted. */
  readonly historyOff: readonly string[];
  /** Entries the history keeps at most. */
  readonly historyMaxEntries: number;
  /** Days an entry is kept; 0 = any age. */
  readonly historyMaxDays: number;
  /** The format the export dialog used last (prompt 011); `null` = none yet. */
  readonly lastExportFormat: string | null;
  /** The choices of the export dialog per format, as stored (read forgivingly by `mergeChoices`). */
  readonly exportChoices: Readonly<Record<string, unknown>>;
  /** Ask before `UPDATE`/`DELETE` without `WHERE`, `DROP`, `TRUNCATE` … on unprotected connections too. */
  readonly confirmDangerous: boolean;
  /** Ids of the actions run from the command palette, the latest first. */
  readonly recentActions: readonly string[];
}

export const KEYMAP_VERSION = 1;
export const MAX_RECENT_ACTIONS = 12;

export interface KeymapSetting {
  readonly version: number;
  readonly bindings: Readonly<Record<string, readonly string[]>>;
}

export const DEFAULT_SETTINGS: Settings = {
  themeSelection: DEFAULT_SELECTION,
  sidebarVisible: true,
  sidebarWidth: 240,
  resultHeight: 300,
  keymap: { version: KEYMAP_VERSION, bindings: {} },
  recentActions: [],
  activeConnection: 'demo',
  stopOnError: true,
  statementTimeoutSec: 0,
  groupDigits: false,
  showSystemSchemas: false,
  copyHeader: true,
  copyNullAs: '',
  csvDelimiter: ',',
  lastCopyFormat: null,
  confirmDangerous: true,
  lastExportFormat: null,
  exportChoices: {},
  historyEnabled: true,
  historyOff: [],
  historyMaxEntries: 100_000,
  historyMaxDays: 365,
};

function size(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000
    ? Math.round(value)
    : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
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
    keymap: mergeKeymap(s['keymap']).keymap,
    recentActions: recent(s['recentActions']),
    stopOnError:
      typeof s['stopOnError'] === 'boolean' ? s['stopOnError'] : DEFAULT_SETTINGS.stopOnError,
    groupDigits:
      typeof s['groupDigits'] === 'boolean' ? s['groupDigits'] : DEFAULT_SETTINGS.groupDigits,
    showSystemSchemas:
      typeof s['showSystemSchemas'] === 'boolean'
        ? s['showSystemSchemas']
        : DEFAULT_SETTINGS.showSystemSchemas,
    copyHeader:
      typeof s['copyHeader'] === 'boolean' ? s['copyHeader'] : DEFAULT_SETTINGS.copyHeader,
    copyNullAs: ['', 'NULL', '\\N'].includes(s['copyNullAs'] as string)
      ? (s['copyNullAs'] as string)
      : DEFAULT_SETTINGS.copyNullAs,
    csvDelimiter: [',', ';', '\t'].includes(s['csvDelimiter'] as string)
      ? (s['csvDelimiter'] as string)
      : DEFAULT_SETTINGS.csvDelimiter,
    lastCopyFormat:
      typeof s['lastCopyFormat'] === 'string' && /^[a-z]{1,16}$/.test(s['lastCopyFormat'])
        ? s['lastCopyFormat']
        : null,
    lastExportFormat:
      typeof s['lastExportFormat'] === 'string' && /^[a-z]{1,16}$/.test(s['lastExportFormat'])
        ? s['lastExportFormat']
        : null,
    exportChoices:
      s['exportChoices'] &&
      typeof s['exportChoices'] === 'object' &&
      !Array.isArray(s['exportChoices'])
        ? Object.fromEntries(
            Object.entries(s['exportChoices'] as Record<string, unknown>)
              .filter(([key]) => /^[a-z]{1,16}$/.test(key))
              .slice(0, 16),
          )
        : {},
    confirmDangerous:
      typeof s['confirmDangerous'] === 'boolean'
        ? s['confirmDangerous']
        : DEFAULT_SETTINGS.confirmDangerous,
    historyEnabled:
      typeof s['historyEnabled'] === 'boolean'
        ? s['historyEnabled']
        : DEFAULT_SETTINGS.historyEnabled,
    historyOff: Array.isArray(s['historyOff'])
      ? s['historyOff']
          .filter((id): id is string => typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id))
          .slice(0, 500)
      : [],
    historyMaxEntries: Math.max(
      100,
      Math.min(1_000_000, numberOr(s['historyMaxEntries'], DEFAULT_SETTINGS.historyMaxEntries)),
    ),
    historyMaxDays: Math.min(
      36_500,
      numberOr(s['historyMaxDays'], DEFAULT_SETTINGS.historyMaxDays),
    ),
    statementTimeoutSec: Math.min(86_400, size(s['statementTimeoutSec'], 0)),
    activeConnection:
      typeof s['activeConnection'] === 'string' && /^[a-z0-9-]{1,64}$/.test(s['activeConnection'])
        ? s['activeConnection']
        : DEFAULT_SETTINGS.activeConnection,
  };
}

function recent(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((id): id is string => typeof id === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(id))
    .slice(0, MAX_RECENT_ACTIONS);
}

/**
 * The stored shortcuts, forgiving about the shape only: whether an id or a shortcut exists is checked by
 * `resolveKeymap`, which reports it. A broken value falls back to the defaults with a notice.
 */
export function mergeKeymap(raw: unknown): { keymap: KeymapSetting; notice: string | null } {
  const empty = (): KeymapSetting => ({ version: KEYMAP_VERSION, bindings: {} });
  if (raw === undefined || raw === null) return { keymap: empty(), notice: null };
  const broken = {
    keymap: empty(),
    notice: 'Die eigenen Tastenkürzel waren nicht lesbar; es gelten die Vorgaben.',
  };
  if (typeof raw !== 'object' || Array.isArray(raw)) return broken;
  const o = raw as Record<string, unknown>;
  const b = o['bindings'];
  if (o['version'] !== KEYMAP_VERSION || !b || typeof b !== 'object' || Array.isArray(b)) {
    return broken;
  }
  const bindings: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(b as Record<string, unknown>).slice(0, 500)) {
    if (!Array.isArray(list)) continue;
    bindings[id.slice(0, 64)] = list
      .filter((s): s is string => typeof s === 'string')
      .slice(0, 8)
      .map((s) => s.slice(0, 60));
  }
  return { keymap: { version: KEYMAP_VERSION, bindings }, notice: null };
}
