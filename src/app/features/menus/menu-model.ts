import { ActionId } from '../../core/actions/action-catalog';
import { actionLabel } from '../../core/actions/action-texts';
import { Platform } from '../../core/actions/platform';
import {
  MenuItemState,
  NativeMenuNode,
  NativeMenuSpec,
  PredefinedItem,
} from '../../core/menu/menu.models';
import { MenuItem } from '../../shared/context-menu';
import { MENU_TEXTS } from './menu-texts';

/**
 * The menus of the app (prompt 018, after files-and-folders-tauri): every entry is the id of an action –
 * a menu only arranges them. `'-'` is a line, `sub` a submenu (its name is asked when the menu is built, so
 * it follows the language), `native` an item the OS provides (only in the native menu bar), `when` a part
 * for macOS or for the others. The same definitions make the native menu bar, the one in the window and
 * the context menus.
 */
export type MenuDef =
  | ActionId
  | '-'
  | { readonly sub: () => string; readonly items: readonly MenuDef[] }
  | { readonly native: PredefinedItem }
  | { readonly when: 'macos' | 'notMacos'; readonly items: readonly MenuDef[] };

export interface TopMenu {
  readonly id: string;
  readonly label: () => string;
  readonly items: readonly MenuDef[];
  /** Only in the native menu bar of macOS (the application menu, the window menu). */
  readonly macosOnly?: boolean;
}

/** What a menu needs of the `ActionService` (keeps the model testable). */
export interface MenuSource {
  canRun(id: ActionId): boolean;
  /** `undefined` = no switch. */
  isChecked(id: ActionId): boolean | undefined;
  shortcuts(id: ActionId): readonly string[];
  /** The first shortcut as the user reads it; `''` = none. */
  shortcutLabel(id: ActionId): string;
}

const T = MENU_TEXTS;

const COPY_AS: MenuDef = {
  sub: () => T.copyAs,
  items: [
    'COPY_AS',
    '-',
    'COPY_AS_CSV',
    'COPY_AS_JSON',
    'COPY_AS_MARKDOWN',
    'COPY_AS_HTML',
    'COPY_AS_INSERT',
    'COPY_AS_INLIST',
    'COPY_AS_WHERE',
    'COPY_AS_VALUES',
    '-',
    'TOGGLE_COPY_HEADER',
  ],
};

/** Editing the cells of a table (prompt 031). */
const EDIT_CELLS: MenuDef = {
  sub: () => T.editCells,
  items: [
    'EDIT_CELL',
    'EDIT_SET_NULL',
    'EDIT_SET_DEFAULT',
    'EDIT_FILL_DOWN',
    'EDIT_PASTE',
    '-',
    'EDIT_ADD_ROW',
    'EDIT_DUPLICATE_ROW',
    'EDIT_DELETE_ROW',
    '-',
    'EDIT_UNDO',
    'EDIT_REDO',
    'EDIT_RESET_CELL',
    'EDIT_RESET_ROW',
    'EDIT_DISCARD',
    '-',
    'EDIT_PREVIEW',
    'EDIT_SAVE',
  ],
};

/** From a row to its relatives (prompt 030). */
const RELATIONS: MenuDef = {
  sub: () => T.relations,
  items: [
    'FK_FOLLOW',
    'FK_FOLLOW_TAB',
    'FK_PEEK',
    'FK_REFERENCED_BY',
    '-',
    'NAV_BACK',
    'NAV_FORWARD',
    '-',
    'FK_DEFINE',
  ],
};

/** The columns of a result (prompt 029). */
const RESULT_COLUMNS: MenuDef = {
  sub: () => T.resultColumns,
  items: [
    'RESULT_COLUMNS',
    '-',
    'COLUMN_HIDE',
    'COLUMN_PIN',
    'COLUMN_LEFT',
    'COLUMN_RIGHT',
    '-',
    'COLUMNS_FIT',
    'COLUMNS_RESET',
  ],
};

/** Finding things in a result (prompt 029). */
/** The results of a tab: their tabs, pinning, comparing (prompt 041). */
const RESULT_TABS: MenuDef = {
  sub: () => T.resultTabs,
  items: [
    'RESULT_NEXT_TAB',
    'RESULT_PREVIOUS_TAB',
    '-',
    'RESULT_PIN',
    'RESULT_DETACH',
    'RESULT_DETACH_BESIDE',
    'RESULT_CLOSE_KEPT',
    '-',
    'COMPARE_RESULTS',
    'RUN_AND_COMPARE',
    'COMPARE_NEXT',
    'COMPARE_PREVIOUS',
    'COMPARE_ONLY_DIFFERENCES',
  ],
};

const RESULT_FIND: MenuDef = {
  sub: () => T.resultFind,
  items: [
    'FIND_IN_RESULT',
    'FIND_NEXT',
    'FIND_PREV',
    '-',
    'GOTO_ROW',
    'RESULT_FIRST_ROW',
    'RESULT_LAST_ROW',
    'NEXT_CHANGE',
    'NEXT_NULL',
  ],
};

/** Conditions from the cell under the cursor (prompt 027). */
const FILTER_CELL: MenuDef = {
  sub: () => T.filterCell,
  items: [
    'FILTER_CELL_EQ',
    'FILTER_CELL_NE',
    'FILTER_CELL_GT',
    'FILTER_CELL_LT',
    'FILTER_CELL_NULL',
    '-',
    'FILTER_RESET',
  ],
};

/** Datei, Bearbeiten, Ansicht, Abfrage, Verbindung, Werkzeuge, Fenster, Hilfe – as the prompt asks. */
export const MENU_BAR: readonly TopMenu[] = [
  {
    id: 'app',
    label: () => T.appName,
    macosOnly: true,
    items: [
      'SHOW_ABOUT',
      '-',
      'OPEN_SETTINGS',
      '-',
      { native: 'services' },
      '-',
      { native: 'hide' },
      { native: 'hideOthers' },
      { native: 'showAll' },
      '-',
      { native: 'quit' },
    ],
  },
  {
    id: 'file',
    label: () => T.file,
    items: [
      'NEW_TAB',
      'DUPLICATE_TAB',
      'OPEN_FILE',
      '-',
      'SAVE_FILE',
      'SAVE_FILE_AS',
      '-',
      'SAVE_QUERY',
      'SAVE_CELL_VALUE',
      'GOTO_SAVED',
      { sub: () => T.saved, items: ['SAVED_FOLDER', 'SAVED_DEFAULT_FOLDER'] },
      '-',
      'EXPORT_RESULT',
      'CANCEL_EXPORT',
      'REVEAL_EXPORT',
      'IMPORT_DATA',
      '-',
      'RENAME_TAB',
      'CLOSE_TAB',
      'CLOSE_OTHER_TABS',
      'REOPEN_TAB',
      { when: 'notMacos', items: ['-', 'QUIT_APP'] },
    ],
  },
  {
    id: 'edit',
    label: () => T.edit,
    items: [
      // macOS needs these items for ⌘C, ⌘V, ⌘X, ⌘A, ⌘Z to reach the editor, text fields and the grid
      { native: 'undo' },
      { native: 'redo' },
      '-',
      { native: 'cut' },
      { native: 'copy' },
      { native: 'paste' },
      { native: 'selectAll' },
      '-',
      'COPY_RESULT',
      'COPY_CELL_VALUE',
      COPY_AS,
      'CANCEL_COPY',
      '-',
      'EXPAND_STAR',
      'TOGGLE_COMMENT',
      '-',
      'FORMAT_SQL',
      'FORMAT_SCRIPT',
      {
        sub: () => T.format,
        items: ['SQL_ONE_LINE', 'KEYWORDS_UPPER', 'KEYWORDS_LOWER', '-', 'CANCEL_FORMAT'],
      },
      '-',
      'HISTORY_PREV',
      'HISTORY_NEXT',
    ],
  },
  {
    id: 'view',
    label: () => T.view,
    items: [
      'TOGGLE_SIDEBAR',
      'SIDEBAR_DATABASE',
      'SIDEBAR_HISTORY',
      'SIDEBAR_SAVED',
      'TOGGLE_VALUE_PANEL',
      'TOGGLE_ROW_FORM',
      'TOGGLE_FILTER_BAR',
      '-',
      {
        sub: () => T.layout,
        items: [
          'SPLIT_RIGHT',
          'SPLIT_DOWN',
          'MOVE_TAB_TO_OTHER_GROUP',
          'FOCUS_OTHER_GROUP',
          'UNSPLIT',
        ],
      },
      '-',
      'TOGGLE_RESULT',
      'TOGGLE_RESULT_PLACEMENT',
      'MAXIMIZE_RESULT',
      'TOGGLE_DIGIT_GROUPING',
      '-',
      'TOGGLE_ZEN',
      '-',
      'COLOR_SCHEME',
      'EDIT_COLOR_SCHEME',
      '-',
      {
        sub: () => T.navigation,
        items: [
          'FOCUS_SIDEBAR',
          'FOCUS_EDITOR',
          'FOCUS_RESULT',
          '-',
          'FOCUS_NEXT_AREA',
          'FOCUS_PREV_AREA',
          '-',
          'NEXT_TAB',
          'PREV_TAB',
        ],
      },
    ],
  },
  {
    id: 'query',
    label: () => T.query,
    items: [
      'RUN_STATEMENT',
      'RUN_SCRIPT',
      'EXPLAIN_PLAN',
      'EXPLAIN_ANALYZE',
      'RUN_AGAIN',
      'CANCEL_QUERY',
      '-',
      'TOGGLE_AUTOCOMMIT',
      'TX_COMMIT',
      'TX_ROLLBACK',
      '-',
      'SHOW_MESSAGES',
      RESULT_TABS,
      '-',
      FILTER_CELL,
      EDIT_CELLS,
      RELATIONS,
      RESULT_FIND,
      RESULT_COLUMNS,
      'SUMMARIZE_COLUMN',
      'COPY_SELECTION_SUM',
      '-',
      'OPEN_HISTORY',
      'TOGGLE_HISTORY',
      'TOGGLE_HISTORY_CONNECTION',
    ],
  },
  {
    id: 'connection',
    label: () => T.connection,
    items: [
      'NEW_CONNECTION',
      'EDIT_CONNECTION',
      'IMPORT_CONNECTIONS',
      '-',
      'CONNECT',
      'DISCONNECT',
      '-',
      'TOGGLE_CONFIRM_DANGEROUS',
      '-',
      {
        sub: () => T.schema,
        items: [
          'SCHEMA_REFRESH',
          'SCHEMA_FILTER',
          'SEARCH_SERVER',
          'COMPARE_SCHEMAS',
          'TOGGLE_SYSTEM_SCHEMAS',
          '-',
          'SCHEMA_DETAILS',
          'SCHEMA_OPEN_DATA',
          'SCHEMA_EXPORT_TABLE',
          'SCHEMA_IMPORT_TABLE',
          'SCHEMA_SEARCH',
          'SCHEMA_DIAGRAM',
          '-',
          'SCHEMA_INSERT_NAME',
          'SCHEMA_COPY_NAME',
          'SCHEMA_COPY_QUALIFIED',
          '-',
          'SCHEMA_SELECT_TEMPLATE',
          'SCHEMA_INSERT_TEMPLATE',
          'SCHEMA_UPDATE_TEMPLATE',
        ],
      },
    ],
  },
  {
    id: 'tools',
    label: () => T.tools,
    items: [
      'GOTO_ANYTHING',
      'OPEN_PALETTE',
      '-',
      { when: 'notMacos', items: ['OPEN_SETTINGS'] },
      'OPEN_SNIPPETS',
      'OPEN_SHORTCUTS',
    ],
  },
  {
    id: 'window',
    label: () => T.window,
    macosOnly: true,
    items: [{ native: 'minimize' }, { native: 'maximize' }, { native: 'fullscreen' }],
  },
  { id: 'help', label: () => T.help, items: ['SHOW_SHORTCUTS', '-', 'SHOW_ABOUT'] },
];

/** The context menu of a tab (the tab is brought to the front first, so the actions mean it). */
export const TAB_MENU: readonly MenuDef[] = [
  'RENAME_TAB',
  'DUPLICATE_TAB',
  'SAVE_FILE_AS',
  '-',
  'MOVE_TAB_TO_OTHER_GROUP',
  'SPLIT_RIGHT',
  'SPLIT_DOWN',
  'UNSPLIT',
  '-',
  'CLOSE_TAB',
  'CLOSE_OTHER_TABS',
  'REOPEN_TAB',
];

/** The context menu of a result: what can be done with the selection and the result. */
export const RESULT_MENU: readonly MenuDef[] = [
  'COPY_RESULT',
  'COPY_CELL_VALUE',
  'SAVE_CELL_VALUE',
  'TOGGLE_VALUE_PANEL',
  'TOGGLE_ROW_FORM',
  EDIT_CELLS,
  FILTER_CELL,
  RELATIONS,
  RESULT_FIND,
  RESULT_TABS,
  RESULT_COLUMNS,
  'SUMMARIZE_COLUMN',
  'COPY_SELECTION_SUM',
  COPY_AS,
  '-',
  'EXPORT_RESULT',
  '-',
  'TOGGLE_DIGIT_GROUPING',
  'MAXIMIZE_RESULT',
];

/** The context menu of the list of connections (the connection is made the active one first). */
export const CONNECTION_MENU: readonly MenuDef[] = [
  'CONNECT',
  'DISCONNECT',
  '-',
  'EDIT_CONNECTION',
  'NEW_CONNECTION',
  'IMPORT_CONNECTIONS',
  '-',
  'TOGGLE_HISTORY_CONNECTION',
];

function expand(defs: readonly MenuDef[], platform: Platform): MenuDef[] {
  const out: MenuDef[] = [];
  for (const d of defs) {
    if (typeof d === 'object' && 'when' in d) {
      if ((d.when === 'macos') === (platform === 'macos')) out.push(...expand(d.items, platform));
    } else {
      out.push(d);
    }
  }
  return out;
}

/** No line at the start, at the end or after another line. */
function tidy<T>(items: T[], isSeparator: (t: T) => boolean): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (isSeparator(item) && (out.length === 0 || isSeparator(out[out.length - 1]))) continue;
    out.push(item);
  }
  while (out.length > 0 && isSeparator(out[out.length - 1])) out.pop();
  return out;
}

/**
 * A menu as the window draws it: names in the current language, the shortcut of the keymap, grey when
 * the action would not run, ticked when it is a switch that is on. Native items are left out (the keys of
 * the OS work without them); a submenu whose entries are all grey is grey.
 */
export function resolveMenu(
  defs: readonly MenuDef[],
  source: MenuSource,
  platform: Platform,
): MenuItem[] {
  const items: MenuItem[] = [];
  let lines = 0;
  for (const d of expand(defs, platform)) {
    if (d === '-') {
      items.push({ id: `-${++lines}`, label: '', separator: true });
    } else if (typeof d === 'string') {
      const shortcut = source.shortcutLabel(d);
      items.push({
        id: d,
        label: actionLabel(d),
        disabled: !source.canRun(d),
        ...(shortcut ? { shortcut } : {}),
        ...(source.isChecked(d) === undefined ? {} : { checked: source.isChecked(d) }),
      });
    } else if ('sub' in d) {
      const children = resolveMenu(d.items, source, platform);
      if (children.length === 0) continue;
      const label = d.sub();
      items.push({
        id: `sub:${label}`,
        label,
        children,
        disabled: children.every((c) => c.disabled || c.separator),
      });
    }
  }
  return tidy(items, (i) => i.separator === true);
}

/** The menus of the bar the window draws (Windows, Linux). */
export function resolveMenuBar(
  source: MenuSource,
  platform: Platform,
): { id: string; label: string; items: MenuItem[] }[] {
  return MENU_BAR.filter((m) => !m.macosOnly || platform === 'macos')
    .map((m) => ({ id: m.id, label: m.label(), items: resolveMenu(m.items, source, platform) }))
    .filter((m) => m.items.length > 0);
}

export const NATIVE_MAX_LABEL = 120;

/** A label the backend accepts: one line, no control characters, bounded. */
export function nativeLabel(label: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what is removed here
  const clean = label.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
  const chars = [...clean];
  return (
    (chars.length > NATIVE_MAX_LABEL
      ? chars.slice(0, NATIVE_MAX_LABEL - 1).join('') + '…'
      : clean) || '?'
  );
}

/**
 * The menu bar for the backend. `quiet` (a shortcut is being recorded): no accelerators, so the menu
 * takes no key away. `blocked` (a dialog is open): every action is grey.
 */
export function toNativeSpec(
  source: MenuSource,
  platform: Platform,
  options: { readonly quiet?: boolean; readonly blocked?: boolean } = {},
): NativeMenuSpec {
  const nodes = (defs: readonly MenuDef[]): NativeMenuNode[] => {
    const out: NativeMenuNode[] = [];
    for (const d of expand(defs, platform)) {
      if (d === '-') {
        out.push({ kind: 'separator' });
      } else if (typeof d === 'string') {
        const checked = source.isChecked(d);
        out.push({
          kind: 'item',
          id: d,
          label: nativeLabel(actionLabel(d)),
          accelerator: options.quiet ? null : (source.shortcuts(d)[0] ?? null),
          enabled: !options.blocked && source.canRun(d),
          ...(checked === undefined ? {} : { checked }),
        });
      } else if ('sub' in d) {
        out.push({ kind: 'submenu', label: nativeLabel(d.sub()), items: nodes(d.items) });
      } else if ('native' in d) {
        out.push({ kind: 'predefined', name: d.native, label: nativeLabel(T.native[d.native]) });
      }
    }
    return tidy(out, (n) => n.kind === 'separator');
  };
  return {
    menus: MENU_BAR.filter((m) => !m.macosOnly || platform === 'macos').map((m) => ({
      kind: 'submenu',
      label: nativeLabel(m.label()),
      items: nodes(m.items),
    })),
  };
}

/** What makes two specs the same menu: everything but the states (they change without a rebuild). */
export function nativeStructureKey(spec: NativeMenuSpec): string {
  return JSON.stringify(spec, (key, value: unknown) =>
    key === 'enabled' || key === 'checked'
      ? key === 'checked'
        ? value !== undefined
        : undefined
      : value,
  );
}

/** The state of every item of a spec. */
export function nativeStates(spec: NativeMenuSpec): ReadonlyMap<string, MenuItemState> {
  const out = new Map<string, MenuItemState>();
  const walk = (nodes: readonly NativeMenuNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'submenu') walk(n.items);
      else if (n.kind === 'item') {
        out.set(n.id, { id: n.id, enabled: n.enabled, checked: n.checked ?? null });
      }
    }
  };
  walk(spec.menus);
  return out;
}

/** The items whose state differs. */
export function stateChanges(
  before: ReadonlyMap<string, MenuItemState>,
  after: ReadonlyMap<string, MenuItemState>,
): MenuItemState[] {
  const out: MenuItemState[] = [];
  for (const [id, state] of after) {
    const old = before.get(id);
    if (!old || old.enabled !== state.enabled || old.checked !== state.checked) out.push(state);
  }
  return out;
}

/** Every action a menu names, submenus included. */
export function actionsOf(defs: readonly MenuDef[]): ActionId[] {
  return defs.flatMap((d) =>
    typeof d === 'string' ? (d === '-' ? [] : [d]) : 'items' in d ? actionsOf(d.items) : [],
  );
}
