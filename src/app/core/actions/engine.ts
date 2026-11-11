/**
 * The keymap engine (prompt 002): catalogue, default keymaps, notation and dispatcher. Loaded as its own chunk at
 * the start (`ActionService.load`), so the initial bundle stays within its budget; until then keys do nothing.
 */
import { ACTIONS } from './action-catalog';
import type { MenuAccelerator } from './action.service';
import { ResolvedKeymap } from './keymap';

export { actionDef, isActionId } from './action-catalog';
export { DEFAULT_KEYMAPS, resolveKeymap } from './keymap';
export { KeyboardDispatcher } from './keyboard-dispatcher';
export { formatShortcut } from './shortcut';

/** What a native menu shows: the first shortcut of each action, none while recording. */
export function menuAccelerators(keymap: ResolvedKeymap, off: boolean): MenuAccelerator[] {
  return ACTIONS.map((a) => ({
    id: a.id,
    shortcut: off ? null : (keymap.bindings[a.id][0] ?? null),
  }));
}
