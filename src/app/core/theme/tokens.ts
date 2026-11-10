/**
 * The catalog of scheme tokens: every token a scheme may set, with group, German name and kind. The colour
 * tokens are exactly those of the `@theme` blocks in `src/styles.css` (test). Only catalog tokens ever reach
 * `<html>`.
 */
export type TokenKind = 'color' | 'font';

export interface TokenDef {
  readonly name: string;
  readonly group: string;
  readonly label: string;
  readonly kind: TokenKind;
}

const EIGHT = [1, 2, 3, 4, 5, 6, 7, 8] as const;

function group(name: string, entries: readonly (readonly [string, string])[]): TokenDef[] {
  return entries.map(([token, label]) => ({
    name: `--${token}`,
    group: name,
    label,
    kind: 'color',
  }));
}

export const TOKENS: readonly TokenDef[] = [
  ...group('Flächen', [
    ['bg-app', 'Hintergrund (Editor, Ergebnis)'],
    ['bg-panel', 'Leisten und Dialoge'],
    ['bg-raised', 'Eingaben und Menüs'],
    ['bg-hover', 'Hover'],
    ['bg-gutter', 'Zeilennummern'],
    ['border', 'Linien'],
  ]),
  ...group('Text', [
    ['text', 'Text'],
    ['text-dim', 'Gedämpfter Text'],
  ]),
  ...group('Akzent und Status', [
    ['accent', 'Akzent'],
    ['accent-text', 'Text auf Akzent'],
    ['danger', 'Fehler'],
    ['ok', 'Erfolg'],
    ['warn-fg', 'Warnung Text'],
    ['warn-bg', 'Warnung Hintergrund'],
    ['error-fg', 'Fehlermeldung Text'],
    ['error-bg', 'Fehlermeldung Hintergrund'],
    ['error-edge', 'Fehlermeldung Rand'],
    ['badge-danger-fg', 'Warn-Badge Text (z. B. Produktion)'],
    ['badge-danger-bg', 'Warn-Badge Hintergrund'],
  ]),
  ...group('Auswahl und Treffer', [
    ['row-selected', 'Gewählte Zeile'],
    ['hit-bg', 'Treffer'],
    ['hit-text', 'Text im Treffer'],
    ['hit-current-bg', 'Aktueller Treffer'],
    ['hit-current-text', 'Text im aktuellen Treffer'],
  ]),
  ...group('SQL', [
    ['sql-keyword', 'Schlüsselwort'],
    ['sql-string', 'String'],
    ['sql-number', 'Zahl'],
    ['sql-comment', 'Kommentar'],
    ['sql-ident', 'Bezeichner'],
    ['sql-function', 'Funktion'],
  ]),
  ...group('Ergebnis', [['cell-null', 'NULL']]),
  ...group('Splitter', [
    ['splitter-bg', 'Leiste'],
    ['splitter-grip', 'Griff'],
    ['splitter-hover-bg', 'Leiste beim Ziehen'],
  ]),
  ...group(
    'Verbindungen',
    EIGHT.map((i) => [`conn-${i}`, `Verbindungsfarbe ${i}`] as const),
  ),
  ...group('Diagramme', [
    ...EIGHT.map((i) => [`chart-${i}`, `Reihe ${i}`] as const),
    ['chart-grid', 'Gitterlinien'],
  ]),
  { name: '--font-ui', group: 'Schrift', label: 'Oberfläche', kind: 'font' },
  { name: '--font-mono', group: 'Schrift', label: 'Editor und Ergebnis (Monospace)', kind: 'font' },
];

export const TOKEN_NAMES: ReadonlySet<string> = new Set(TOKENS.map((t) => t.name));

const BY_NAME = new Map(TOKENS.map((t) => [t.name, t]));

export function tokenDef(name: string): TokenDef | undefined {
  return BY_NAME.get(name);
}
