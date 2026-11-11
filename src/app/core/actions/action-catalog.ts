/**
 * All actions of the app (prompt 002, after log-commander). The ids are stored in user settings: stable, never
 * rename. This file has no imports on purpose, so scripts can read it with Node.
 *
 * Scope (where a shortcut acts, see `KeyboardDispatcher`):
 * - `global`: everywhere outside dialogs – in the SQL editor and in text fields too, when the shortcut has
 *   Mod/Ctrl/Alt or is an F-key; a plain key of a global action acts like `view`.
 * - `view`: only while no text field, editor, dialog, menu or own widget (tree, splitter, grid) has the focus.
 */
export type ActionScope = 'global' | 'view';

export const ACTION_GROUPS = [
  'Abfrage',
  'Tabs',
  'Datei',
  'Verbindung',
  'Schema',
  'Ansicht',
  'Navigation',
  'Hilfe',
] as const;
export type ActionGroup = (typeof ACTION_GROUPS)[number];

export interface ActionDef {
  readonly id: string;
  /** German name in the palette and the shortcut editor. */
  readonly label: string;
  readonly group: ActionGroup;
  readonly scope: ActionScope;
  /** Runs again while the key is held (auto-repeat). */
  readonly repeat?: boolean;
  /** Not offered in the command palette (the palette itself). */
  readonly hidden?: boolean;
}

export const ACTIONS = [
  // Abfrage
  {
    id: 'RUN_STATEMENT',
    label: 'Auswahl oder Anweisung unter dem Cursor ausführen',
    group: 'Abfrage',
    scope: 'global',
  },
  {
    id: 'RUN_SCRIPT',
    label: 'Ganzes Skript ausführen',
    group: 'Abfrage',
    scope: 'global',
  },
  { id: 'SHOW_MESSAGES', label: 'Meldungen zeigen', group: 'Abfrage', scope: 'global' },
  {
    id: 'TOGGLE_DIGIT_GROUPING',
    label: 'Ergebnis: Tausendertrennung ein/aus',
    group: 'Abfrage',
    scope: 'global',
  },
  {
    id: 'TOGGLE_CONFIRM_DANGEROUS',
    label: 'Rückfrage bei zerstörenden Anweisungen ein/aus',
    group: 'Verbindung',
    scope: 'global',
  },
  // Export (prompt 011)
  { id: 'EXPORT_RESULT', label: 'Ergebnis exportieren …', group: 'Datei', scope: 'global' },
  { id: 'CANCEL_EXPORT', label: 'Export abbrechen', group: 'Datei', scope: 'global' },
  {
    id: 'REVEAL_EXPORT',
    label: 'Exportierte Datei im Dateimanager zeigen',
    group: 'Datei',
    scope: 'global',
  },
  // History (prompt 010)
  { id: 'OPEN_HISTORY', label: 'Verlauf öffnen', group: 'Abfrage', scope: 'global' },
  {
    id: 'HISTORY_PREV',
    label: 'Vorige Anweisung aus dem Verlauf',
    group: 'Abfrage',
    scope: 'global',
  },
  {
    id: 'HISTORY_NEXT',
    label: 'Nächste Anweisung aus dem Verlauf',
    group: 'Abfrage',
    scope: 'global',
  },
  {
    id: 'TOGGLE_HISTORY_CONNECTION',
    label: 'Verlauf für diese Verbindung ein/aus',
    group: 'Abfrage',
    scope: 'global',
  },
  { id: 'TOGGLE_HISTORY', label: 'Verlauf ein/aus', group: 'Abfrage', scope: 'global' },
  // Copying from the result (prompt 009)
  { id: 'COPY_RESULT', label: 'Ergebnis: Auswahl kopieren', group: 'Abfrage', scope: 'global' },
  { id: 'COPY_AS', label: 'Ergebnis: Kopieren als …', group: 'Abfrage', scope: 'global' },
  { id: 'COPY_AS_CSV', label: 'Ergebnis: als CSV kopieren', group: 'Abfrage', scope: 'global' },
  { id: 'COPY_AS_JSON', label: 'Ergebnis: als JSON kopieren', group: 'Abfrage', scope: 'global' },
  {
    id: 'COPY_AS_MARKDOWN',
    label: 'Ergebnis: als Markdown-Tabelle kopieren',
    group: 'Abfrage',
    scope: 'global',
  },
  {
    id: 'COPY_AS_HTML',
    label: 'Ergebnis: als HTML-Tabelle kopieren',
    group: 'Abfrage',
    scope: 'global',
  },
  {
    id: 'COPY_AS_INSERT',
    label: 'Ergebnis: als INSERT-Anweisungen kopieren',
    group: 'Abfrage',
    scope: 'global',
  },
  {
    id: 'COPY_AS_INLIST',
    label: 'Ergebnis: als IN (…)-Liste kopieren',
    group: 'Abfrage',
    scope: 'global',
  },
  {
    id: 'COPY_AS_WHERE',
    label: 'Ergebnis: als WHERE-Bedingung kopieren',
    group: 'Abfrage',
    scope: 'global',
  },
  {
    id: 'COPY_AS_VALUES',
    label: 'Ergebnis: Werte der ersten Spalte kopieren',
    group: 'Abfrage',
    scope: 'global',
  },
  {
    id: 'TOGGLE_COPY_HEADER',
    label: 'Kopieren: Kopfzeile ein/aus',
    group: 'Abfrage',
    scope: 'global',
  },
  { id: 'CANCEL_COPY', label: 'Kopieren abbrechen', group: 'Abfrage', scope: 'global' },
  { id: 'CANCEL_QUERY', label: 'Laufende Anweisung abbrechen', group: 'Abfrage', scope: 'global' },
  // Tabs
  { id: 'NEW_TAB', label: 'Neuer Tab', group: 'Tabs', scope: 'global' },
  { id: 'CLOSE_TAB', label: 'Tab schließen', group: 'Tabs', scope: 'global' },
  {
    id: 'REOPEN_TAB',
    label: 'Geschlossenen Tab wiederherstellen',
    group: 'Tabs',
    scope: 'global',
  },
  { id: 'NEXT_TAB', label: 'Nächster Tab', group: 'Tabs', scope: 'global', repeat: true },
  { id: 'PREV_TAB', label: 'Voriger Tab', group: 'Tabs', scope: 'global', repeat: true },
  { id: 'DUPLICATE_TAB', label: 'Tab duplizieren', group: 'Tabs', scope: 'global' },
  // Datei
  { id: 'OPEN_FILE', label: 'SQL-Datei öffnen …', group: 'Datei', scope: 'global' },
  { id: 'SAVE_FILE', label: 'Tab als Datei speichern', group: 'Datei', scope: 'global' },
  { id: 'SAVE_FILE_AS', label: 'Tab speichern unter …', group: 'Datei', scope: 'global' },
  // Verbindung
  { id: 'NEW_CONNECTION', label: 'Neue Verbindung …', group: 'Verbindung', scope: 'global' },
  {
    id: 'EDIT_CONNECTION',
    label: 'Aktive Verbindung bearbeiten …',
    group: 'Verbindung',
    scope: 'global',
  },
  { id: 'CONNECT', label: 'Aktive Verbindung öffnen', group: 'Verbindung', scope: 'global' },
  { id: 'DISCONNECT', label: 'Aktive Verbindung trennen', group: 'Verbindung', scope: 'global' },
  // Ansicht
  {
    id: 'TOGGLE_SIDEBAR',
    label: 'Seitenleiste ein-/ausblenden',
    group: 'Ansicht',
    scope: 'global',
  },
  { id: 'COLOR_SCHEME', label: 'Farbschema wählen …', group: 'Ansicht', scope: 'global' },
  {
    id: 'EDIT_COLOR_SCHEME',
    label: 'Neues Farbschema aus dem aktuellen …',
    group: 'Ansicht',
    scope: 'global',
  },
  // Schema tree (prompt 008): they act on the node the tree is on
  { id: 'SCHEMA_REFRESH', label: 'Schema aktualisieren', group: 'Schema', scope: 'global' },
  { id: 'SCHEMA_FILTER', label: 'Im Schema filtern', group: 'Schema', scope: 'global' },
  {
    id: 'TOGGLE_SYSTEM_SCHEMAS',
    label: 'Systemschemata ein-/ausblenden',
    group: 'Schema',
    scope: 'global',
  },
  { id: 'SCHEMA_EXPORT_TABLE', label: 'Tabelle exportieren …', group: 'Schema', scope: 'global' },
  { id: 'SCHEMA_OPEN_DATA', label: 'Daten der Tabelle öffnen', group: 'Schema', scope: 'global' },
  {
    id: 'SCHEMA_INSERT_NAME',
    label: 'Name in den Editor einfügen',
    group: 'Schema',
    scope: 'global',
  },
  { id: 'SCHEMA_COPY_NAME', label: 'Name kopieren', group: 'Schema', scope: 'global' },
  {
    id: 'SCHEMA_COPY_QUALIFIED',
    label: 'Qualifizierten Namen kopieren',
    group: 'Schema',
    scope: 'global',
  },
  {
    id: 'SCHEMA_SELECT_TEMPLATE',
    label: 'SELECT-Vorlage einfügen',
    group: 'Schema',
    scope: 'global',
  },
  {
    id: 'SCHEMA_INSERT_TEMPLATE',
    label: 'INSERT-Vorlage einfügen',
    group: 'Schema',
    scope: 'global',
  },
  {
    id: 'SCHEMA_UPDATE_TEMPLATE',
    label: 'UPDATE-Vorlage einfügen',
    group: 'Schema',
    scope: 'global',
  },
  // Navigation
  {
    id: 'OPEN_PALETTE',
    label: 'Befehlspalette',
    group: 'Navigation',
    scope: 'global',
    hidden: true,
  },
  { id: 'FOCUS_EDITOR', label: 'In den Editor', group: 'Navigation', scope: 'global' },
  { id: 'FOCUS_RESULT', label: 'In das Ergebnis', group: 'Navigation', scope: 'global' },
  { id: 'FOCUS_SIDEBAR', label: 'In die Seitenleiste', group: 'Navigation', scope: 'global' },
  {
    id: 'FOCUS_NEXT_AREA',
    label: 'Nächster Bereich',
    group: 'Navigation',
    scope: 'global',
    repeat: true,
  },
  {
    id: 'FOCUS_PREV_AREA',
    label: 'Voriger Bereich',
    group: 'Navigation',
    scope: 'global',
    repeat: true,
  },
  // Hilfe
  { id: 'OPEN_SHORTCUTS', label: 'Tastenkürzel bearbeiten …', group: 'Hilfe', scope: 'global' },
  { id: 'SHOW_SHORTCUTS', label: 'Tastenkürzel anzeigen', group: 'Hilfe', scope: 'view' },
] as const satisfies readonly ActionDef[];

export type ActionId = (typeof ACTIONS)[number]['id'];

export const ACTION_IDS: readonly ActionId[] = ACTIONS.map((a) => a.id);

const BY_ID = new Map<string, ActionDef>(ACTIONS.map((a) => [a.id, a]));

export function isActionId(id: string): id is ActionId {
  return BY_ID.has(id);
}

export function actionDef(id: ActionId): ActionDef {
  return BY_ID.get(id)!;
}
