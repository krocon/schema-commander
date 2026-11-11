import { translatable } from '../i18n/i18n';
import { KEYMAP_DE } from './keymap-texts.de';

/** Texts of the keymap (prompt 002): names of keys, why a shortcut is reserved, notices of the merge. */
export const KEYMAP_EN = {
  /** Modifiers outside macOS (macOS shows symbols). */
  mods: { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' },
  /** Keys by their name in the notation; a key without an entry shows its name or a symbol. */
  keys: {
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Del',
    Insert: 'Ins',
    Escape: 'Esc',
    Tab: 'Tab',
    Home: 'Home',
    End: 'End',
    PageUp: 'PgUp',
    PageDown: 'PgDn',
    Space: 'Space',
    ContextMenu: 'Menu key',
    NumpadDecimal: 'Num.',
  },
  macQuit: 'Quit in the macOS menu',
  macHide: 'Hide in the macOS menu',
  macHideOthers: 'Hide Others in the macOS menu',
  macMinimize: 'Minimize in the macOS menu',
  macFullScreen: 'Full screen in the macOS menu',
  macAppSwitch: 'the application switcher of macOS',
  macSpotlight: 'Spotlight of macOS',
  closeWindow: 'closes the window',
  appSwitch: 'the application switcher',
  textEditing: 'editing in text fields and in the editor',
  ownBindings: 'own bindings',
  defaults: 'defaults',
  notAList: (action: string, where: string) =>
    `“${action}” (${where}): not a list of shortcuts, skipped.`,
  invalidShortcut: (raw: string, action: string, where: string) =>
    `“${raw}” is not a valid shortcut (${action}, ${where}).`,
  reserved: (shortcut: string, action: string, why: string) =>
    `${shortcut} for “${action}” is reserved: ${why}.`,
  unknownInDefaults: (id: string) => `Unknown action “${id}” in the defaults.`,
  unknownInOwn: (id: string) => `Unknown action “${id}” in your own bindings, skipped.`,
  conflict: (shortcut: string, owner: string, loser: string) =>
    `${shortcut} belongs to “${owner}”, “${loser}” loses it.`,
  hidesChord: (first: string, chord: string) => `${first} alone hides the chord ${chord}.`,
  startNotice: (n: number) =>
    `Keyboard shortcuts: ${n === 1 ? '1 notice' : `${n} notices`}, see “Edit keyboard shortcuts”.`,
};

export const KEYMAP_TEXTS = translatable('keymap', KEYMAP_EN, { de: KEYMAP_DE });
