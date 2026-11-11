import {
  DEFAULT_SETTINGS,
  NULL_TEXTS,
  Settings,
  mergeSettings,
} from '../../core/settings/settings.models';
import { SETTINGS_TEXTS } from './settings-texts';

/** The groups of the settings dialog (prompt 017), in their order. */
export const GROUPS = [
  'general',
  'editor',
  'format',
  'result',
  'run',
  'history',
  'security',
] as const;
export type GroupId = (typeof GROUPS)[number];

/** The settings the dialog shows; everything else of `Settings` is state (sizes, last choices). */
export type SettingKey =
  | 'language'
  | 'editorFontFamily'
  | 'editorFontSize'
  | 'editorTabWidth'
  | 'editorWordWrap'
  | 'editorLineNumbers'
  | 'editorSuggest'
  | 'completionKeywordCase'
  | 'formatKeywordCase'
  | 'formatIndent'
  | 'formatWidth'
  | 'formatComma'
  | 'formatAndOr'
  | 'formatBlankLines'
  | 'resultFontSize'
  | 'resultRowHeight'
  | 'nullText'
  | 'groupDigits'
  | 'resultPlacement'
  | 'copyHeader'
  | 'copyNullAs'
  | 'csvDelimiter'
  | 'stopOnError'
  | 'statementTimeoutSec'
  | 'autoCommit'
  | 'txWarnMinutes'
  | 'historyEnabled'
  | 'historyMaxEntries'
  | 'historyMaxDays'
  | 'confirmDangerous'
  | 'showSystemSchemas';

export type SettingDef = { readonly key: SettingKey; readonly group: GroupId } & (
  | { readonly kind: 'bool' }
  | { readonly kind: 'text'; readonly maxLength: number }
  | { readonly kind: 'number'; readonly min: number; readonly max: number; readonly step: number }
  /** The values; what the user reads for each comes from the catalog (`choices[key][value]`). */
  | { readonly kind: 'choice'; readonly values: readonly string[] }
);

/** The schema of the dialog: which setting, where, and what it may be. Bounds as in `mergeSettings`. */
export const SETTING_DEFS: readonly SettingDef[] = [
  { key: 'language', group: 'general', kind: 'choice', values: ['system', 'en', 'de'] },
  { key: 'editorFontFamily', group: 'editor', kind: 'text', maxLength: 120 },
  { key: 'editorFontSize', group: 'editor', kind: 'number', min: 8, max: 40, step: 1 },
  { key: 'editorTabWidth', group: 'editor', kind: 'number', min: 1, max: 16, step: 1 },
  { key: 'editorWordWrap', group: 'editor', kind: 'bool' },
  {
    key: 'editorLineNumbers',
    group: 'editor',
    kind: 'choice',
    values: ['absolute', 'relative', 'off'],
  },
  { key: 'editorSuggest', group: 'editor', kind: 'bool' },
  { key: 'completionKeywordCase', group: 'editor', kind: 'choice', values: ['upper', 'lower'] },
  {
    key: 'formatKeywordCase',
    group: 'format',
    kind: 'choice',
    values: ['upper', 'lower', 'preserve'],
  },
  { key: 'formatIndent', group: 'format', kind: 'number', min: 1, max: 8, step: 1 },
  { key: 'formatWidth', group: 'format', kind: 'number', min: 40, max: 400, step: 10 },
  { key: 'formatComma', group: 'format', kind: 'choice', values: ['trailing', 'leading'] },
  { key: 'formatAndOr', group: 'format', kind: 'choice', values: ['leading', 'trailing'] },
  { key: 'formatBlankLines', group: 'format', kind: 'number', min: 0, max: 3, step: 1 },
  { key: 'resultFontSize', group: 'result', kind: 'number', min: 9, max: 24, step: 1 },
  { key: 'resultRowHeight', group: 'result', kind: 'number', min: 16, max: 60, step: 1 },
  { key: 'nullText', group: 'result', kind: 'choice', values: NULL_TEXTS },
  { key: 'groupDigits', group: 'result', kind: 'bool' },
  { key: 'resultPlacement', group: 'result', kind: 'choice', values: ['bottom', 'right'] },
  { key: 'copyHeader', group: 'result', kind: 'bool' },
  { key: 'copyNullAs', group: 'result', kind: 'choice', values: ['', 'NULL', '\\N'] },
  { key: 'csvDelimiter', group: 'result', kind: 'choice', values: [',', ';', '\t'] },
  { key: 'stopOnError', group: 'run', kind: 'bool' },
  { key: 'statementTimeoutSec', group: 'run', kind: 'number', min: 0, max: 86_400, step: 1 },
  { key: 'autoCommit', group: 'run', kind: 'bool' },
  { key: 'txWarnMinutes', group: 'run', kind: 'number', min: 0, max: 1440, step: 1 },
  { key: 'historyEnabled', group: 'history', kind: 'bool' },
  {
    key: 'historyMaxEntries',
    group: 'history',
    kind: 'number',
    min: 100,
    max: 1_000_000,
    step: 100,
  },
  { key: 'historyMaxDays', group: 'history', kind: 'number', min: 0, max: 36_500, step: 1 },
  { key: 'confirmDangerous', group: 'security', kind: 'bool' },
  { key: 'showSystemSchemas', group: 'security', kind: 'bool' },
];

export const isDefault = (settings: Settings, key: SettingKey): boolean =>
  settings[key] === DEFAULT_SETTINGS[key];

/** The settings back at their defaults: one, or all the dialog shows. State (sizes …) stays. */
export function resetOf(keys: readonly SettingKey[]): Partial<Settings> {
  return Object.fromEntries(keys.map((k) => [k, DEFAULT_SETTINGS[k]])) as Partial<Settings>;
}

/** What the user reads for a value of a choice. */
export function choiceLabel(key: SettingKey, value: string): string {
  const labels = (SETTINGS_TEXTS.choices as Record<string, Record<string, string> | undefined>)[
    key
  ];
  return labels?.[value] ?? value;
}

const fold = (text: string) => text.toLocaleLowerCase().normalize('NFKD');

/**
 * The settings a search finds: every word must be in the label, the help, the name of the group or a
 * choice – in the language on screen. An empty search finds nothing (the groups are shown then).
 */
export function searchSettings(query: string): SettingDef[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const t = SETTINGS_TEXTS;
  return SETTING_DEFS.filter((def) => {
    const choices = def.kind === 'choice' ? def.values.map((v) => choiceLabel(def.key, v)) : [];
    const hay = fold(
      [t.labels[def.key], t.help[def.key], t.groups[def.group], ...choices].join('\n'),
    );
    return words.every((w) => hay.includes(w));
  });
}

/** What names things of this machine and stays out of an exported file. */
const LOCAL_KEYS: readonly string[] = [
  'activeConnection',
  'historyOff',
  'recentActions',
  'recentObjects',
];

export const EXPORT_FORMAT = 'schema-commander-settings';
export const EXPORT_VERSION = 1;
/** A settings file is small; anything larger is not one. */
export const MAX_IMPORT_CHARS = 1_000_000;

/**
 * The settings as a file. Nothing secret is in the settings (passwords live in the keychain); what names
 * this machine's connections (`activeConnection`, `historyOff`) stays here.
 */
export function exportSettings(settings: Settings): string {
  const portable = Object.fromEntries(
    Object.entries(settings).filter(([key]) => !LOCAL_KEYS.includes(key)),
  );
  return JSON.stringify(
    { format: EXPORT_FORMAT, version: EXPORT_VERSION, settings: portable },
    null,
    2,
  );
}

/**
 * Reads an exported file: `null` when it is not one. Every value goes through `mergeSettings`, so a broken
 * or unknown one becomes what is set now; what the file does not carry stays as it is.
 */
export function importSettings(text: string, current: Settings): Settings | null {
  if (text.length > MAX_IMPORT_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const file = parsed as Record<string, unknown>;
  const incoming = file['settings'];
  if (file['format'] !== EXPORT_FORMAT || !incoming || typeof incoming !== 'object') return null;
  if (Array.isArray(incoming)) return null;
  const known = Object.keys(DEFAULT_SETTINGS);
  const wanted = Object.fromEntries(
    Object.entries(incoming as Record<string, unknown>).filter(
      ([key]) => known.includes(key) && !LOCAL_KEYS.includes(key),
    ),
  );
  // `mergeSettings` turns a value it refuses into the default; here such a value keeps what is set now
  const merged = mergeSettings(wanted) as unknown as Record<string, unknown>;
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>) };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const key of Object.keys(wanted)) {
    const refused = same(merged[key], defaults[key]) && !same(wanted[key], defaults[key]);
    if (!refused) result[key] = merged[key];
  }
  return result as unknown as Settings;
}
