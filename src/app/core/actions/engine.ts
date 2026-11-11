/**
 * The keymap engine (prompt 002): catalogue, default keymaps, notation and dispatcher. Loaded as its own chunk at
 * the start (`ActionService.load`), so the initial bundle stays within its budget; until then keys do nothing.
 */

export { actionDef, isActionId } from './action-catalog';
export { DEFAULT_KEYMAPS, resolveKeymap } from './keymap';
export { KeyboardDispatcher } from './keyboard-dispatcher';
export { formatShortcut } from './shortcut';
