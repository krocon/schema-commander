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

export const ACTION_GROUPS = ['Abfrage', 'Ansicht', 'Navigation', 'Hilfe'] as const;
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
    label: 'Anweisung unter dem Cursor ausführen',
    group: 'Abfrage',
    scope: 'global',
  },
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
