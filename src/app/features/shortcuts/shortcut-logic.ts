import { ACTIONS, ACTION_GROUPS, ActionGroup, ActionId } from '../../core/actions/action-catalog';
import { actionLabel } from '../../core/actions/action-texts';
import { ResolvedKeymap } from '../../core/actions/keymap';
import { Platform } from '../../core/actions/platform';
import { formatShortcut } from '../../core/actions/shortcut';

/** A recorded shortcut that needs an answer: taken by another action, or reserved. */
export type Pending =
  | {
      kind: 'conflict';
      id: ActionId;
      shortcut: string;
      owner: ActionId;
      mode: 'replace' | 'add';
    }
  | { kind: 'reserved'; id: ActionId; shortcut: string; reason: string; mode: 'replace' | 'add' };

export interface ShortcutRow {
  id: ActionId;
  /** The name of the action in the language at the time the rows were made. */
  label: string;
  keys: { value: string; text: string }[];
  /** Differs from the default (has an entry in the override). */
  changed: boolean;
}

export interface ShortcutGroup {
  /** The key of the group (`groupLabel` gives what the user reads). */
  name: ActionGroup;
  rows: ShortcutRow[];
}

/** The rows of the editor by group, filtered by name, id and shortcut (as written and as shown). */
export function shortcutGroups(
  keymap: ResolvedKeymap,
  override: Readonly<Record<string, unknown>>,
  query: string,
  platform: Platform,
): ShortcutGroup[] {
  const q = query.trim().toLowerCase();
  const rows = ACTIONS.map((a) => {
    const keys = keymap.bindings[a.id].map((value) => ({
      value,
      text: formatShortcut(value, platform),
    }));
    return {
      group: a.group as ActionGroup,
      row: {
        id: a.id,
        label: actionLabel(a.id),
        keys,
        changed: Object.prototype.hasOwnProperty.call(override, a.id),
      } satisfies ShortcutRow,
    };
  }).filter(
    ({ row }) =>
      !q ||
      row.label.toLowerCase().includes(q) ||
      row.id.toLowerCase().includes(q) ||
      row.keys.some((k) => k.value.toLowerCase().includes(q) || k.text.toLowerCase().includes(q)),
  );
  return ACTION_GROUPS.map((name) => ({
    name,
    rows: rows.filter((r) => r.group === name).map((r) => r.row),
  })).filter((g) => g.rows.length > 0);
}
