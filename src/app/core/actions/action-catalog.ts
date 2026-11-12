/**
 * All actions of the app (prompt 002, after log-commander). The ids are stored in user settings: stable, never
 * rename. This file has no imports on purpose, so scripts can read it with Node.
 *
 * Scope (where a shortcut acts, see `KeyboardDispatcher`):
 * - `global`: everywhere outside dialogs – in the SQL editor and in text fields too, when the shortcut has
 *   Mod/Ctrl/Alt or is an F-key; a plain key of a global action acts like `view`.
 * - `view`: only while no text field, editor, dialog, menu or own widget (tree, splitter, grid) has the focus.
 */
/**
 * Where an action acts on a shortcut: everywhere (`global`), where no widget has the keyboard (`view`), or
 * only while a result grid has it (`result`, prompt 029 – there `Mod+F` is the search in the result, not
 * the editor's).
 */
export type ActionScope = 'global' | 'view' | 'result';

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
  // Execution plan (prompt 039)
  { id: 'EXPLAIN_PLAN', label: 'Show the plan of the statement', group: 'Query', scope: 'global' },
  {
    id: 'EXPLAIN_ANALYZE',
    label: 'Plan with execution (runs the statement) …',
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
    id: 'RUN_AGAIN',
    label: 'Run again with the same parameter values',
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
  // Sorting and filtering (prompt 027)
  { id: 'TOGGLE_FILTER_BAR', label: 'Result: show the filter row', group: 'View', scope: 'global' },
  {
    id: 'FILTER_CELL_EQ',
    label: 'Table: filter by the value of the cell',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'FILTER_CELL_NE',
    label: 'Table: filter out the value of the cell',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'FILTER_CELL_GT',
    label: 'Table: filter greater than the cell',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'FILTER_CELL_LT',
    label: 'Table: filter smaller than the cell',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'FILTER_CELL_NULL',
    label: 'Table: filter where the column is NULL',
    group: 'Query',
    scope: 'global',
  },
  { id: 'FILTER_RESET', label: 'Result: reset filter and order', group: 'Query', scope: 'global' },
  // The value panel (prompt 026)
  {
    id: 'TOGGLE_VALUE_PANEL',
    label: 'Result: show the value panel',
    group: 'View',
    scope: 'global',
  },
  {
    id: 'COPY_CELL_VALUE',
    label: 'Result: copy the whole value of the cell',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'SAVE_CELL_VALUE',
    label: 'Result: save the value of the cell …',
    group: 'File',
    scope: 'global',
  },
  // Columns of a result and searching in it (prompt 029)
  { id: 'FIND_IN_RESULT', label: 'Result: search …', group: 'Query', scope: 'result' },
  { id: 'FIND_NEXT', label: 'Result: next hit', group: 'Query', scope: 'result', repeat: true },
  { id: 'FIND_PREV', label: 'Result: previous hit', group: 'Query', scope: 'result', repeat: true },
  { id: 'GOTO_ROW', label: 'Result: go to row …', group: 'Navigation', scope: 'result' },
  { id: 'RESULT_FIRST_ROW', label: 'Result: first row', group: 'Navigation', scope: 'global' },
  { id: 'RESULT_LAST_ROW', label: 'Result: last row', group: 'Navigation', scope: 'global' },
  {
    id: 'NEXT_CHANGE',
    label: 'Result: next other value in the column',
    group: 'Navigation',
    scope: 'result',
    repeat: true,
  },
  {
    id: 'NEXT_NULL',
    label: 'Result: next NULL in the column',
    group: 'Navigation',
    scope: 'result',
    repeat: true,
  },
  { id: 'RESULT_COLUMNS', label: 'Result: columns …', group: 'View', scope: 'global' },
  { id: 'COLUMN_HIDE', label: 'Result: hide the column', group: 'View', scope: 'global' },
  {
    id: 'COLUMN_PIN',
    label: 'Result: keep the column at the left',
    group: 'View',
    scope: 'global',
  },
  {
    id: 'COLUMN_LEFT',
    label: 'Result: move the column left',
    group: 'View',
    scope: 'result',
    repeat: true,
  },
  {
    id: 'COLUMN_RIGHT',
    label: 'Result: move the column right',
    group: 'View',
    scope: 'result',
    repeat: true,
  },
  { id: 'COLUMNS_FIT', label: 'Result: fit all column widths', group: 'View', scope: 'global' },
  { id: 'COLUMNS_RESET', label: 'Result: reset the columns', group: 'View', scope: 'global' },
  // Editing cells (prompt 031)
  { id: 'EDIT_CELL', label: 'Edit: edit the cell', group: 'Query', scope: 'result' },
  { id: 'EDIT_SET_NULL', label: 'Edit: set the cell to NULL', group: 'Query', scope: 'global' },
  {
    id: 'EDIT_SET_DEFAULT',
    label: 'Edit: set the cell to its default',
    group: 'Query',
    scope: 'global',
  },
  // Whole rows (prompt 032)
  { id: 'EDIT_ADD_ROW', label: 'Edit: new row', group: 'Query', scope: 'result' },
  { id: 'EDIT_DUPLICATE_ROW', label: 'Edit: duplicate the rows', group: 'Query', scope: 'result' },
  {
    id: 'EDIT_DELETE_ROW',
    label: 'Edit: delete the rows (or keep them)',
    group: 'Query',
    scope: 'result',
  },
  {
    id: 'EDIT_PASTE',
    label: 'Edit: paste cells from the clipboard',
    group: 'Query',
    scope: 'global',
  },
  { id: 'EDIT_FILL_DOWN', label: 'Edit: fill down', group: 'Query', scope: 'result' },
  {
    id: 'EDIT_UNDO',
    label: 'Edit: undo the change',
    group: 'Query',
    scope: 'result',
    repeat: true,
  },
  {
    id: 'EDIT_REDO',
    label: 'Edit: redo the change',
    group: 'Query',
    scope: 'result',
    repeat: true,
  },
  { id: 'EDIT_RESET_CELL', label: 'Edit: reset the cell', group: 'Query', scope: 'global' },
  { id: 'EDIT_RESET_ROW', label: 'Edit: reset the row', group: 'Query', scope: 'global' },
  { id: 'EDIT_DISCARD', label: 'Edit: discard all changes', group: 'Query', scope: 'global' },
  { id: 'EDIT_PREVIEW', label: 'Edit: preview the changes …', group: 'Query', scope: 'global' },
  { id: 'EDIT_SAVE', label: 'Edit: write the changes', group: 'Query', scope: 'global' },
  // Following foreign keys (prompt 030)
  {
    id: 'FK_FOLLOW',
    label: 'Relations: go to the referenced row',
    group: 'Navigation',
    scope: 'result',
  },
  {
    id: 'FK_FOLLOW_TAB',
    label: 'Relations: referenced row in a new tab',
    group: 'Navigation',
    scope: 'global',
  },
  {
    id: 'FK_PEEK',
    label: 'Relations: look at the referenced row',
    group: 'Navigation',
    scope: 'result',
  },
  {
    id: 'FK_REFERENCED_BY',
    label: 'Relations: referenced by …',
    group: 'Navigation',
    scope: 'result',
  },
  { id: 'NAV_BACK', label: 'Relations: back', group: 'Navigation', scope: 'result' },
  { id: 'NAV_FORWARD', label: 'Relations: forward', group: 'Navigation', scope: 'result' },
  {
    id: 'FK_DEFINE',
    label: 'Relations: define a relation …',
    group: 'Navigation',
    scope: 'global',
  },
  // The figures of a selection (prompt 028)
  {
    id: 'SUMMARIZE_COLUMN',
    label: 'Result: summarize the column',
    group: 'Query',
    scope: 'global',
  },
  {
    id: 'COPY_SELECTION_SUM',
    label: 'Result: copy the sum of the selection',
    group: 'Query',
    scope: 'global',
  },
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
  // Import of a file into a table (prompt 033)
  { id: 'IMPORT_DATA', label: 'Import data from a file …', group: 'File', scope: 'global' },
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
  // Schema comparison (prompt 038)
  { id: 'COMPARE_SCHEMAS', label: 'Compare schemas …', group: 'Schema', scope: 'global' },
  // ER diagram (prompt 037)
  {
    id: 'SCHEMA_DIAGRAM',
    label: 'Diagram of the schema or around the table …',
    group: 'Schema',
    scope: 'global',
  },
  // Search on the server (prompt 036)
  { id: 'SEARCH_SERVER', label: 'Search on the server …', group: 'Schema', scope: 'global' },
  {
    id: 'SCHEMA_SEARCH',
    label: 'Search in this schema or table …',
    group: 'Schema',
    scope: 'global',
  },
  {
    id: 'SCHEMA_IMPORT_TABLE',
    label: 'Import a file into the table …',
    group: 'Schema',
    scope: 'global',
  },
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
  // About (prompt 034)
  { id: 'SHOW_ABOUT', label: 'About Schema Commander', group: 'Help', scope: 'global' },
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
