import { COMMON_TEXTS } from '../i18n/common-texts';
import { DEFAULT_SELECTION, ThemeSelection, sanitizeSelection } from '../theme/theme.models';

/** What the app remembers over a restart (`settings.json` in the app's config folder). */
export interface Settings {
  /** The language of the window (prompt 017): the system's, English or German. */
  readonly language: LanguageSetting;
  /** The editor: font (`''` = the editor's own), size in px, width of a tab, wrapping, line numbers. */
  readonly editorFontFamily: string;
  readonly editorFontSize: number;
  readonly editorTabWidth: number;
  readonly editorWordWrap: boolean;
  readonly editorLineNumbers: LineNumbers;
  /** Suggest while typing (prompt 021: what fits at the caret; without a connection keywords and words). */
  readonly editorSuggest: boolean;
  /** Keywords the completion writes: `SELECT` or `select`. */
  readonly completionKeywordCase: 'upper' | 'lower';
  /** How SQL is formatted (prompt 023): the case of keywords, blanks per level, the width of a line … */
  readonly formatKeywordCase: 'upper' | 'lower' | 'preserve';
  readonly formatIndent: number;
  /** Where the comma stands when a list is broken into lines. */
  readonly formatComma: 'trailing' | 'leading';
  /** Characters a line may have before lists and brackets are broken. */
  readonly formatWidth: number;
  readonly formatAndOr: 'leading' | 'trailing';
  /** Empty lines between two statements. */
  readonly formatBlankLines: number;
  /** The result grid: font size and row height in px. */
  readonly resultFontSize: number;
  readonly resultRowHeight: number;
  /** How the grid shows NULL. */
  readonly nullText: string;
  /** New tabs commit every statement at once (prompt 013); off = they start with manual commit. */
  readonly autoCommit: boolean;
  readonly themeSelection: ThemeSelection;
  readonly sidebarVisible: boolean;
  /** px */
  readonly sidebarWidth: number;
  /** Height of the result area, px. */
  readonly resultHeight: number;
  /** Where the result of a tab lies (prompt 016): under the editor or beside it. For all tabs. */
  readonly resultPlacement: ResultPlacement;
  /** Width of the result area when it lies beside the editor, px. */
  readonly resultWidth: number;
  readonly resultVisible: boolean;
  /** What the sidebar shows. */
  readonly sidebarView: SidebarView;
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
  /** Writing changed cells checks that nobody else changed them in the meantime (prompt 031). */
  readonly editLock: boolean;
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
  /** Minutes after which an open transaction is said to hold locks; 0 = never (prompt 013). */
  readonly txWarnMinutes: number;
  /** Ids of the actions run from the command palette, the latest first. */
  readonly recentActions: readonly string[];
  /** `schema.name` of the objects jumped to (prompt 020), the latest first. */
  readonly recentObjects: readonly string[];
  /** The folder of the saved queries (prompt 024), from the folder dialog; `''` = the app's own. */
  readonly savedQueriesDir: string;
  /** Ids of the saved queries used lately, the latest first. */
  readonly recentSaved: readonly string[];
  /** Own snippets (prompt 024); they win over built-in ones with the same prefix. */
  readonly snippets: readonly OwnSnippet[];
  /** The value panel beside the result (prompt 026): shown, its width in px, lines wrapped. */
  readonly valuePanelVisible: boolean;
  readonly valuePanelWidth: number;
  readonly valueWrap: boolean;
  /**
   * The filter and order used last per table (prompt 027), by `connection|schema.table`, the latest
   * first. Read forgivingly by `readSpec` of the filter logic.
   */
  readonly tableFilters: Readonly<Record<string, TableSpecStored>>;
  /** The row for filtering a result locally is shown. */
  readonly filterBarVisible: boolean;
  /**
   * Where the user moved the tables of an ER diagram (prompt 037), per diagram (connection, schema,
   * table): the id of a table → `[x, y]`.
   */
  readonly diagramPlaces: Readonly<
    Record<string, Readonly<Record<string, readonly [number, number]>>>
  >;
  /** Relations the user defined where the database has no foreign key (prompt 030), per connection. */
  readonly virtualRelations: Readonly<Record<string, readonly unknown[]>>;
  /** The column layout per table of a table view (prompt 029), by `tableKey`; read with `mergeLayout`. */
  readonly columnLayouts: Readonly<Record<string, ColumnLayoutStored>>;
  /** The figures of a selection the status line shows (prompt 028): keys of `MEASURES`. */
  readonly statsMeasures: readonly string[];
  /** Look for parameters in statements and ask for their values (prompt 025). */
  readonly paramsEnabled: boolean;
  /**
   * Which ways of writing a parameter count, per connection id (`colon`, `brace`, `question` …); a
   * connection that is not listed has the defaults of its database.
   */
  readonly paramForms: Readonly<Record<string, readonly string[]>>;
}

/** A stored filter of a table: the shape of `TableSpec` of the filter logic, checked when it is read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TableSpecStored = any;

/** A snippet: typed as `prefix`, it becomes `body` (placeholders `${1:name}`, `$0`). */
export interface OwnSnippet {
  readonly prefix: string;
  readonly description: string;
  readonly body: string;
}

export const MAX_SNIPPETS = 300;
export const MAX_SNIPPET_BODY = 8000;

export type LanguageSetting = 'system' | 'en' | 'de';
export type LineNumbers = 'absolute' | 'relative' | 'off';
export const NULL_TEXTS = ['NULL', '∅', '(null)', ''] as const;
/** Fonts are names for CSS: letters, digits, blanks, commas, quotes, hyphens. */
const FONT = /^[\p{L}\p{N} ,'"_-]{0,120}$/u;
export type ResultPlacement = 'bottom' | 'right';
export type SidebarView = 'database' | 'history' | 'saved';
export const SIDEBAR_VIEWS: readonly SidebarView[] = ['database', 'history', 'saved'];

export const KEYMAP_VERSION = 1;
export const MAX_RECENT_ACTIONS = 12;
export const MAX_RECENT_OBJECTS = 50;

export interface KeymapSetting {
  readonly version: number;
  readonly bindings: Readonly<Record<string, readonly string[]>>;
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'system',
  editorFontFamily: '',
  editorFontSize: 14,
  editorTabWidth: 4,
  editorWordWrap: false,
  editorLineNumbers: 'absolute',
  editorSuggest: true,
  completionKeywordCase: 'upper',
  formatKeywordCase: 'upper',
  formatIndent: 4,
  formatComma: 'trailing',
  formatWidth: 100,
  formatAndOr: 'leading',
  formatBlankLines: 1,
  resultFontSize: 12,
  resultRowHeight: 22,
  nullText: 'NULL',
  autoCommit: true,
  themeSelection: DEFAULT_SELECTION,
  sidebarVisible: true,
  sidebarWidth: 240,
  resultHeight: 300,
  resultPlacement: 'bottom',
  resultWidth: 480,
  resultVisible: true,
  sidebarView: 'database',
  keymap: { version: KEYMAP_VERSION, bindings: {} },
  recentActions: [],
  recentObjects: [],
  savedQueriesDir: '',
  recentSaved: [],
  snippets: [],
  valuePanelVisible: false,
  valuePanelWidth: 380,
  valueWrap: true,
  tableFilters: {},
  filterBarVisible: false,
  columnLayouts: {},
  virtualRelations: {},
  diagramPlaces: {},
  statsMeasures: ['cells', 'sum', 'mean', 'min', 'max'],
  paramsEnabled: true,
  paramForms: {},
  activeConnection: 'demo',
  stopOnError: true,
  statementTimeoutSec: 0,
  groupDigits: false,
  showSystemSchemas: false,
  copyHeader: true,
  editLock: true,
  copyNullAs: '',
  csvDelimiter: ',',
  lastCopyFormat: null,
  confirmDangerous: true,
  txWarnMinutes: 5,
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

/** The places of the tables of diagrams as stored: only what has the shape, and not without end. */
export function readDiagramPlaces(raw: unknown): Settings['diagramPlaces'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, readonly [number, number]>> = {};
  for (const [key, places] of Object.entries(raw as Record<string, unknown>).slice(-50)) {
    if (key.length > 600 || !places || typeof places !== 'object' || Array.isArray(places))
      continue;
    const kept: Record<string, readonly [number, number]> = {};
    for (const [id, at] of Object.entries(places as Record<string, unknown>).slice(0, 2000)) {
      if (
        id.length <= 600 &&
        Array.isArray(at) &&
        at.length === 2 &&
        at.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7)
      ) {
        kept[id] = [Math.round(at[0] as number), Math.round(at[1] as number)];
      }
    }
    out[key] = kept;
  }
  return out;
}

/** Stored settings, forgiving: every broken or missing value falls back to its default. */
export function mergeSettings(saved: unknown): Settings {
  const s = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  const bool = (key: keyof Settings) =>
    typeof s[key] === 'boolean' ? (s[key] as boolean) : (d[key] as boolean);
  const within = (key: keyof Settings, min: number, max: number) => {
    const v = s[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
      ? Math.round(v)
      : (d[key] as number);
  };
  return {
    language: s['language'] === 'en' || s['language'] === 'de' ? s['language'] : 'system',
    editorFontFamily:
      typeof s['editorFontFamily'] === 'string' && FONT.test(s['editorFontFamily'])
        ? s['editorFontFamily'].trim()
        : d.editorFontFamily,
    editorFontSize: within('editorFontSize', 8, 40),
    editorTabWidth: within('editorTabWidth', 1, 16),
    editorWordWrap: bool('editorWordWrap'),
    editorLineNumbers:
      s['editorLineNumbers'] === 'relative' || s['editorLineNumbers'] === 'off'
        ? s['editorLineNumbers']
        : 'absolute',
    editorSuggest: bool('editorSuggest'),
    completionKeywordCase: s['completionKeywordCase'] === 'lower' ? 'lower' : 'upper',
    formatKeywordCase:
      s['formatKeywordCase'] === 'lower' || s['formatKeywordCase'] === 'preserve'
        ? s['formatKeywordCase']
        : 'upper',
    formatIndent: within('formatIndent', 1, 8),
    formatComma: s['formatComma'] === 'leading' ? 'leading' : 'trailing',
    formatWidth: within('formatWidth', 40, 400),
    formatAndOr: s['formatAndOr'] === 'trailing' ? 'trailing' : 'leading',
    formatBlankLines: within('formatBlankLines', 0, 3),
    resultFontSize: within('resultFontSize', 9, 24),
    resultRowHeight: within('resultRowHeight', 16, 60),
    nullText: (NULL_TEXTS as readonly unknown[]).includes(s['nullText'])
      ? (s['nullText'] as string)
      : d.nullText,
    autoCommit: bool('autoCommit'),
    themeSelection: sanitizeSelection(s['themeSelection']),
    sidebarVisible:
      typeof s['sidebarVisible'] === 'boolean'
        ? s['sidebarVisible']
        : DEFAULT_SETTINGS.sidebarVisible,
    sidebarWidth: size(s['sidebarWidth'], DEFAULT_SETTINGS.sidebarWidth),
    resultHeight: size(s['resultHeight'], DEFAULT_SETTINGS.resultHeight),
    resultPlacement: s['resultPlacement'] === 'right' ? 'right' : 'bottom',
    resultWidth: size(s['resultWidth'], DEFAULT_SETTINGS.resultWidth),
    resultVisible:
      typeof s['resultVisible'] === 'boolean' ? s['resultVisible'] : DEFAULT_SETTINGS.resultVisible,
    sidebarView:
      s['sidebarView'] === 'history' || s['sidebarView'] === 'saved'
        ? s['sidebarView']
        : 'database',
    keymap: mergeKeymap(s['keymap']).keymap,
    recentActions: recent(s['recentActions']),
    recentObjects: Array.isArray(s['recentObjects'])
      ? s['recentObjects']
          .filter((n): n is string => typeof n === 'string' && n.length > 0 && n.length <= 600)
          .slice(0, MAX_RECENT_OBJECTS)
      : [],
    savedQueriesDir:
      typeof s['savedQueriesDir'] === 'string' && s['savedQueriesDir'].length <= 2000
        ? s['savedQueriesDir']
        : '',
    recentSaved: Array.isArray(s['recentSaved'])
      ? s['recentSaved']
          .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 600)
          .slice(0, 20)
      : [],
    snippets: mergeSnippets(s['snippets']),
    valuePanelVisible: bool('valuePanelVisible'),
    valuePanelWidth: within('valuePanelWidth', 200, 4000),
    valueWrap: bool('valueWrap'),
    tableFilters:
      s['tableFilters'] &&
      typeof s['tableFilters'] === 'object' &&
      !Array.isArray(s['tableFilters'])
        ? (Object.fromEntries(
            Object.entries(s['tableFilters'] as Record<string, unknown>)
              .filter(([key, spec]) => key.length <= 600 && !!spec && typeof spec === 'object')
              .slice(0, 200),
          ) as Record<string, TableSpecStored>)
        : {},
    filterBarVisible: bool('filterBarVisible'),
    diagramPlaces: readDiagramPlaces(s['diagramPlaces']),
    virtualRelations:
      s['virtualRelations'] &&
      typeof s['virtualRelations'] === 'object' &&
      !Array.isArray(s['virtualRelations'])
        ? (Object.fromEntries(
            Object.entries(s['virtualRelations'] as Record<string, unknown>)
              .filter(([key, list]) => key.length <= 200 && Array.isArray(list))
              .slice(0, 500),
          ) as Record<string, readonly unknown[]>)
        : {},
    columnLayouts:
      s['columnLayouts'] &&
      typeof s['columnLayouts'] === 'object' &&
      !Array.isArray(s['columnLayouts'])
        ? (Object.fromEntries(
            Object.entries(s['columnLayouts'] as Record<string, unknown>)
              .filter(
                ([key, layout]) => key.length <= 600 && !!layout && typeof layout === 'object',
              )
              .slice(-200),
          ) as Record<string, ColumnLayoutStored>)
        : {},
    statsMeasures: Array.isArray(s['statsMeasures'])
      ? [
          ...new Set(
            s['statsMeasures'].filter(
              (m): m is string => typeof m === 'string' && /^[a-zA-Z]{1,20}$/.test(m),
            ),
          ),
        ].slice(0, 20)
      : DEFAULT_SETTINGS.statsMeasures,
    paramsEnabled: bool('paramsEnabled'),
    paramForms:
      s['paramForms'] && typeof s['paramForms'] === 'object' && !Array.isArray(s['paramForms'])
        ? Object.fromEntries(
            Object.entries(s['paramForms'] as Record<string, unknown>)
              .filter(
                ([id, forms]) =>
                  /^[a-z0-9-]{1,64}$/.test(id) &&
                  Array.isArray(forms) &&
                  forms.every((f) => typeof f === 'string' && /^[a-zA-Z]{1,16}$/.test(f)),
              )
              .slice(0, 500)
              .map(([id, forms]) => [id, (forms as string[]).slice(0, 8)]),
          )
        : {},
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
    editLock: typeof s['editLock'] === 'boolean' ? s['editLock'] : DEFAULT_SETTINGS.editLock,
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
    txWarnMinutes: Math.min(1440, numberOr(s['txWarnMinutes'], DEFAULT_SETTINGS.txWarnMinutes)),
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
    statementTimeoutSec: Math.min(86_400, numberOr(s['statementTimeoutSec'], 0)),
    activeConnection:
      typeof s['activeConnection'] === 'string' && /^[a-z0-9-]{1,64}$/.test(s['activeConnection'])
        ? s['activeConnection']
        : DEFAULT_SETTINGS.activeConnection,
  };
}

/** Stored snippets, forgiving: what is no snippet is left out, a prefix counts once. */
export function mergeSnippets(raw: unknown): OwnSnippet[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: OwnSnippet[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const prefix = o['prefix'];
    const body = o['body'];
    if (typeof prefix !== 'string' || !/^[\p{L}\p{N}_-]{1,32}$/u.test(prefix)) continue;
    if (typeof body !== 'string' || body.trim() === '' || body.length > MAX_SNIPPET_BODY) continue;
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    const description = typeof o['description'] === 'string' ? o['description'].slice(0, 200) : '';
    out.push({ prefix, description, body });
    if (out.length >= MAX_SNIPPETS) break;
  }
  return out;
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
    notice: COMMON_TEXTS.keymapUnreadable,
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

/** A column layout as it is stored (`ColumnLayout` in features/results/column-layout.ts). */
export interface ColumnLayoutStored {
  readonly order: readonly string[];
  readonly hidden: readonly string[];
  readonly pinned: readonly string[];
  readonly widths: Readonly<Record<string, number>>;
}
