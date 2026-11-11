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
  'Query',
  'Tabs',
  'File',
  'Connection',
  'Schema',
  'View',
  'Navigation',
  'Help',
] as const;
export type ActionGroup = (typeof ACTION_GROUPS)[number];

export interface ActionDef {
  readonly id: string;
  /** English name (the source); what the user reads comes from `actionLabel` in `action-texts.ts`. */
  readonly label: string;
  readonly group: ActionGroup;
  readonly scope: ActionScope;
  /** Runs again while the key is held (auto-repeat). */
  readonly repeat?: boolean;
  /** Not offered in the command palette (the palette itself). */
  readonly hidden?: boolean;
}

export const ACTIONS = [
  // Query
  {
    id: 'RUN_STATEMENT',
    label: 'Run the selection or the statement under the cursor',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'RUN_SCRIPT',
    label: 'Run the whole script',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'EXPAND_STAR',
    label: 'Expand * to the list of columns',
    group: 'Query',
    scope: 'global',
  },
  // Formatting (prompt 023)
  {
    id: 'FORMAT_SQL',
    label: 'Format the selection or the statement under the cursor',
    group: 'Query',
    scope: 'global',
  },
  { id: 'FORMAT_SCRIPT', label: 'Format the whole script', group: 'Query', scope: 'global' },
  {
    id: 'SQL_ONE_LINE',
    label: 'Join the selection or the statement into one line',
    group: 'Query',
    scope: 'global',
  },
  { id: 'KEYWORDS_UPPER', label: 'Keywords to upper case', group: 'Query', scope: 'global' },
  { id: 'KEYWORDS_LOWER', label: 'Keywords to lower case', group: 'Query', scope: 'global' },
  { id: 'TOGGLE_COMMENT', label: 'Toggle line comment', group: 'Query', scope: 'global' },
  { id: 'CANCEL_FORMAT', label: 'Cancel formatting', group: 'Query', scope: 'global' },
  { id: 'SHOW_MESSAGES', label: 'Show messages', group: 'Query', scope: 'global' },
  {
    id: 'TOGGLE_DIGIT_GROUPING',
    label: 'Result: toggle digit grouping',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'TOGGLE_CONFIRM_DANGEROUS',
    label: 'Toggle the confirmation of destructive statements',
    group: 'Connection',
    scope: 'global',
  },
  // Export (prompt 011)
  { id: 'EXPORT_RESULT', label: 'Export result …', group: 'File', scope: 'global' },
  { id: 'CANCEL_EXPORT', label: 'Cancel export', group: 'File', scope: 'global' },
  {
    id: 'REVEAL_EXPORT',
    label: 'Show the exported file in the file manager',
    group: 'File',
    scope: 'global',
  },
  // Transactions (prompt 013)
  { id: 'TX_COMMIT', label: 'Commit transaction', group: 'Query', scope: 'global' },
  {
    id: 'TX_ROLLBACK',
    label: 'Roll back transaction',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'TOGGLE_AUTOCOMMIT',
    label: 'Toggle auto-commit for this tab',
    group: 'Query',
    scope: 'global',
  },
  // History (prompt 010)
  { id: 'OPEN_HISTORY', label: 'Open history', group: 'Query', scope: 'global' },
  {
    id: 'HISTORY_PREV',
    label: 'Previous statement from the history',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'HISTORY_NEXT',
    label: 'Next statement from the history',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'TOGGLE_HISTORY_CONNECTION',
    label: 'Toggle the history for this connection',
    group: 'Query',
    scope: 'global',
  },
  { id: 'TOGGLE_HISTORY', label: 'Toggle the history', group: 'Query', scope: 'global' },
  // Copying from the result (prompt 009)
  { id: 'COPY_RESULT', label: 'Result: copy selection', group: 'Query', scope: 'global' },
  { id: 'COPY_AS', label: 'Result: copy as …', group: 'Query', scope: 'global' },
  { id: 'COPY_AS_CSV', label: 'Result: copy as CSV', group: 'Query', scope: 'global' },
  { id: 'COPY_AS_JSON', label: 'Result: copy as JSON', group: 'Query', scope: 'global' },
  {
    id: 'COPY_AS_MARKDOWN',
    label: 'Result: copy as Markdown table',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'COPY_AS_HTML',
    label: 'Result: copy as HTML table',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'COPY_AS_INSERT',
    label: 'Result: copy as INSERT statements',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'COPY_AS_INLIST',
    label: 'Result: copy as IN (…) list',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'COPY_AS_WHERE',
    label: 'Result: copy as WHERE condition',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'COPY_AS_VALUES',
    label: 'Result: copy the values of the first column',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'TOGGLE_COPY_HEADER',
    label: 'Copy: toggle header row',
    group: 'Query',
    scope: 'global',
  },
  { id: 'CANCEL_COPY', label: 'Cancel copying', group: 'Query', scope: 'global' },
  { id: 'CANCEL_QUERY', label: 'Cancel the running statement', group: 'Query', scope: 'global' },
  // Tabs
  { id: 'NEW_TAB', label: 'New tab', group: 'Tabs', scope: 'global' },
  { id: 'CLOSE_TAB', label: 'Close tab', group: 'Tabs', scope: 'global' },
  {
    id: 'REOPEN_TAB',
    label: 'Reopen closed tab',
    group: 'Tabs',
    scope: 'global',
  },
  { id: 'RENAME_TAB', label: 'Rename tab', group: 'Tabs', scope: 'global' },
  { id: 'CLOSE_OTHER_TABS', label: 'Close other tabs', group: 'Tabs', scope: 'global' },
  { id: 'NEXT_TAB', label: 'Next tab', group: 'Tabs', scope: 'global', repeat: true },
  { id: 'PREV_TAB', label: 'Previous tab', group: 'Tabs', scope: 'global', repeat: true },
  { id: 'DUPLICATE_TAB', label: 'Duplicate tab', group: 'Tabs', scope: 'global' },
  // File
  { id: 'OPEN_FILE', label: 'Open SQL file …', group: 'File', scope: 'global' },
  { id: 'SAVE_FILE', label: 'Save tab as file', group: 'File', scope: 'global' },
  { id: 'SAVE_FILE_AS', label: 'Save tab as …', group: 'File', scope: 'global' },
  // Saved queries and snippets (prompt 024)
  { id: 'SAVE_QUERY', label: 'Save as query …', group: 'File', scope: 'global' },
  { id: 'GOTO_SAVED', label: 'Go to saved query …', group: 'Navigation', scope: 'global' },
  {
    id: 'SAVED_FOLDER',
    label: 'Choose the folder of the saved queries …',
    group: 'File',
    scope: 'global',
  },
  {
    id: 'SAVED_DEFAULT_FOLDER',
    label: 'Saved queries: use the default folder',
    group: 'File',
    scope: 'global',
  },
  { id: 'OPEN_SNIPPETS', label: 'Edit snippets …', group: 'Query', scope: 'global' },
  // Connection
  { id: 'NEW_CONNECTION', label: 'New connection …', group: 'Connection', scope: 'global' },
  {
    id: 'IMPORT_CONNECTIONS',
    label: 'Import or export connections …',
    group: 'Connection',
    scope: 'global',
  },
  {
    id: 'EDIT_CONNECTION',
    label: 'Edit the active connection …',
    group: 'Connection',
    scope: 'global',
  },
  { id: 'CONNECT', label: 'Open the active connection', group: 'Connection', scope: 'global' },
  { id: 'DISCONNECT', label: 'Close the active connection', group: 'Connection', scope: 'global' },
  // View
  {
    id: 'TOGGLE_SIDEBAR',
    label: 'Show or hide the sidebar',
    group: 'View',
    scope: 'global',
  },
  { id: 'SPLIT_RIGHT', label: 'Split view: side by side', group: 'View', scope: 'global' },
  { id: 'SPLIT_DOWN', label: 'Split view: one above the other', group: 'View', scope: 'global' },
  {
    id: 'MOVE_TAB_TO_OTHER_GROUP',
    label: 'Move tab to the other group',
    group: 'View',
    scope: 'global',
  },
  {
    id: 'FOCUS_OTHER_GROUP',
    label: 'Switch to the other group',
    group: 'View',
    scope: 'global',
  },
  { id: 'UNSPLIT', label: 'Join the groups', group: 'View', scope: 'global' },
  {
    id: 'TOGGLE_RESULT',
    label: 'Show or hide the result area',
    group: 'View',
    scope: 'global',
  },
  {
    id: 'TOGGLE_RESULT_PLACEMENT',
    label: 'Result area at the bottom / on the right',
    group: 'View',
    scope: 'global',
  },
  {
    id: 'MAXIMIZE_RESULT',
    label: 'Maximize or restore the result area',
    group: 'View',
    scope: 'global',
  },
  {
    id: 'SIDEBAR_DATABASE',
    label: 'Sidebar: connections and schema',
    group: 'View',
    scope: 'global',
  },
  { id: 'SIDEBAR_HISTORY', label: 'Sidebar: history', group: 'View', scope: 'global' },
  { id: 'SIDEBAR_SAVED', label: 'Sidebar: saved queries', group: 'View', scope: 'global' },
  { id: 'TOGGLE_ZEN', label: 'Zen mode (only the queries)', group: 'View', scope: 'global' },
  { id: 'COLOR_SCHEME', label: 'Choose colour scheme …', group: 'View', scope: 'global' },
  {
    id: 'EDIT_COLOR_SCHEME',
    label: 'New colour scheme from the current one …',
    group: 'View',
    scope: 'global',
  },
  // Schema tree (prompt 008): they act on the node the tree is on
  { id: 'SCHEMA_REFRESH', label: 'Refresh schema', group: 'Schema', scope: 'global' },
  { id: 'SCHEMA_FILTER', label: 'Filter the schema', group: 'Schema', scope: 'global' },
  {
    id: 'TOGGLE_SYSTEM_SCHEMAS',
    label: 'Show or hide system schemas',
    group: 'Schema',
    scope: 'global',
  },
  { id: 'SCHEMA_EXPORT_TABLE', label: 'Export table …', group: 'Schema', scope: 'global' },
  { id: 'SCHEMA_DETAILS', label: 'Object details and DDL …', group: 'Schema', scope: 'global' },
  { id: 'SCHEMA_OPEN_DATA', label: 'Open the data of the table', group: 'Schema', scope: 'global' },
  {
    id: 'SCHEMA_INSERT_NAME',
    label: 'Insert name into the editor',
    group: 'Schema',
    scope: 'global',
  },
  { id: 'SCHEMA_COPY_NAME', label: 'Copy name', group: 'Schema', scope: 'global' },
  {
    id: 'SCHEMA_COPY_QUALIFIED',
    label: 'Copy qualified name',
    group: 'Schema',
    scope: 'global',
  },
  {
    id: 'SCHEMA_SELECT_TEMPLATE',
    label: 'Insert SELECT template',
    group: 'Schema',
    scope: 'global',
  },
  {
    id: 'SCHEMA_INSERT_TEMPLATE',
    label: 'Insert INSERT template',
    group: 'Schema',
    scope: 'global',
  },
  {
    id: 'SCHEMA_UPDATE_TEMPLATE',
    label: 'Insert UPDATE template',
    group: 'Schema',
    scope: 'global',
  },
  // Navigation
  {
    id: 'OPEN_PALETTE',
    label: 'Command palette',
    group: 'Navigation',
    scope: 'global',
    hidden: true,
  },
  { id: 'FOCUS_EDITOR', label: 'Go to the editor', group: 'Navigation', scope: 'global' },
  { id: 'FOCUS_RESULT', label: 'Go to the result', group: 'Navigation', scope: 'global' },
  { id: 'FOCUS_SIDEBAR', label: 'Go to the sidebar', group: 'Navigation', scope: 'global' },
  {
    id: 'FOCUS_NEXT_AREA',
    label: 'Next area',
    group: 'Navigation',
    scope: 'global',
    repeat: true,
  },
  {
    id: 'FOCUS_PREV_AREA',
    label: 'Previous area',
    group: 'Navigation',
    scope: 'global',
    repeat: true,
  },
  { id: 'GOTO_ANYTHING', label: 'Go to table, view, tab …', group: 'Navigation', scope: 'global' },
  { id: 'OPEN_SETTINGS', label: 'Settings …', group: 'View', scope: 'global' },
  { id: 'QUIT_APP', label: 'Quit', group: 'File', scope: 'global' },
  // Help
  { id: 'OPEN_SHORTCUTS', label: 'Edit keyboard shortcuts …', group: 'Help', scope: 'global' },
  { id: 'SHOW_SHORTCUTS', label: 'Show keyboard shortcuts', group: 'Help', scope: 'view' },
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
