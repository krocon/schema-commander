import { translatable } from '../../core/i18n/i18n';
import { SHORTCUT_DIALOG_DE } from './shortcut-dialog-texts.de';

/** Texts of the shortcut editor and overview (prompt 002). */
export const SHORTCUT_DIALOG_EN = {
  title: 'Keyboard shortcuts',
  searchActions: 'Search actions',
  searchPlaceholder: 'Search: name, id or shortcut',
  resetAll: 'Reset all',
  edit: 'Edit',
  confirmResetAll: (n: number) =>
    n === 1
      ? 'Discard 1 own binding and take the default?'
      : `Discard ${n} own bindings and take the defaults?`,
  takenBy: (shortcut: string, action: string) => `${shortcut} is taken by “${action}”.`,
  replace: 'Replace',
  reserved: (shortcut: string, reason: string) => `${shortcut} is reserved: ${reason}.`,
  pressKeys: 'Press the keys … (Esc cancels)',
  removeKey: (key: string) => `Remove ${key}`,
  record: 'Record',
  rebind: (action: string) => `Rebind: ${action}`,
  another: 'Another shortcut',
  anotherFor: (action: string) => `Another shortcut: ${action}`,
  resetFor: (action: string) => `Reset: ${action}`,
  noAction: 'No action matches.',
  note:
    'Dimmed: has no effect here right now. While recording, the shortcuts of the menu bar are off ' +
    'too. Keys in dialogs, menus and in the editor (find, copy …) are fixed.',
};

export const SHORTCUT_DIALOG_TEXTS = translatable('shortcutDialog', SHORTCUT_DIALOG_EN, {
  de: SHORTCUT_DIALOG_DE,
});
