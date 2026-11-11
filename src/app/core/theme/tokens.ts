/**
 * The catalog of scheme tokens: every token a scheme may set, with group, name and kind. The colour
 * tokens are exactly those of the `@theme` blocks in `src/styles.css` (test). Only catalog tokens ever reach
 * `<html>`.
 *
 * The names are English here (the source, prompt 017, after files-and-folders); `label` and `groupLabel`
 * are getters that translate through the phrase book `theme-labels.de.ts` at the time they are read.
 */
import { phrasebook } from '../i18n/i18n';
import { THEME_LABELS_DE } from './theme-labels.de';

export type TokenKind = 'color' | 'font';

export interface TokenDef {
  readonly name: string;
  /** The English name of the group: the stable key for grouping. */
  readonly group: string;
  /** The name of the group in the current language. */
  readonly groupLabel: string;
  /** The name of the token in the current language. */
  readonly label: string;
  readonly kind: TokenKind;
}

/** Token and group names by their English text (reactive). */
export const themeLabel = phrasebook('themeLabels', { de: THEME_LABELS_DE });

const EIGHT = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** English names of all tokens and groups (completeness test of the phrase book). */
const SOURCES = new Set<string>();

function token(name: string, group: string, label: string, kind: TokenKind): TokenDef {
  SOURCES.add(group).add(label);
  return {
    name,
    group,
    get groupLabel() {
      return themeLabel(group);
    },
    get label() {
      return themeLabel(label);
    },
    kind,
  };
}

function group(name: string, entries: readonly (readonly [string, string])[]): TokenDef[] {
  return entries.map(([id, label]) => token(`--${id}`, name, label, 'color'));
}

export const TOKENS: readonly TokenDef[] = [
  ...group('Surfaces', [
    ['bg-app', 'Background (editor, result)'],
    ['bg-panel', 'Bars and dialogs'],
    ['bg-raised', 'Inputs and menus'],
    ['bg-hover', 'Hover'],
    ['bg-gutter', 'Line numbers'],
    ['border', 'Lines'],
  ]),
  ...group('Text', [
    ['text', 'Text'],
    ['text-dim', 'Muted text'],
  ]),
  ...group('Accent and status', [
    ['accent', 'Accent'],
    ['accent-text', 'Text on accent'],
    ['danger', 'Error'],
    ['ok', 'Success'],
    ['warn-fg', 'Warning text'],
    ['warn-bg', 'Warning background'],
    ['error-fg', 'Error message text'],
    ['error-bg', 'Error message background'],
    ['error-edge', 'Error message border'],
    ['badge-danger-fg', 'Warning badge text (e.g. production)'],
    ['badge-danger-bg', 'Warning badge background'],
  ]),
  ...group('Selection and hits', [
    ['row-selected', 'Selected row'],
    ['hit-bg', 'Hit'],
    ['hit-text', 'Text in the hit'],
    ['hit-current-bg', 'Current hit'],
    ['hit-current-text', 'Text in the current hit'],
  ]),
  ...group('SQL', [
    ['sql-keyword', 'Keyword'],
    ['sql-string', 'String'],
    ['sql-number', 'Number'],
    ['sql-comment', 'Comment'],
    ['sql-ident', 'Identifier'],
    ['sql-function', 'Function'],
  ]),
  ...group('Result', [['cell-null', 'NULL']]),
  ...group('Splitter', [
    ['splitter-bg', 'Bar'],
    ['splitter-grip', 'Grip'],
    ['splitter-hover-bg', 'Bar while dragging'],
  ]),
  ...group(
    'Connections',
    EIGHT.map((i) => [`conn-${i}`, `Connection colour ${i}`] as const),
  ),
  ...group('Charts', [
    ...EIGHT.map((i) => [`chart-${i}`, `Series ${i}`] as const),
    ['chart-grid', 'Grid lines'],
  ]),
  token('--font-ui', 'Font', 'User interface', 'font'),
  token('--font-mono', 'Font', 'Editor and result (monospace)', 'font'),
];

/** Every English text the phrase book must translate. */
export const THEME_LABEL_SOURCES: readonly string[] = [...SOURCES];

export const TOKEN_NAMES: ReadonlySet<string> = new Set(TOKENS.map((t) => t.name));

const BY_NAME = new Map(TOKENS.map((t) => [t.name, t]));

export function tokenDef(name: string): TokenDef | undefined {
  return BY_NAME.get(name);
}
