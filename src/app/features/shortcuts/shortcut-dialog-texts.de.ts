import type { Translation } from '../../core/i18n/i18n';
import type { SHORTCUT_DIALOG_EN } from './shortcut-dialog-texts';

export const SHORTCUT_DIALOG_DE: Translation<typeof SHORTCUT_DIALOG_EN> = {
  title: 'Tastenkürzel',
  searchActions: 'Aktionen suchen',
  searchPlaceholder: 'Suchen: Name, Id oder Kürzel',
  resetAll: 'Alle zurücksetzen',
  edit: 'Bearbeiten',
  confirmResetAll: (n) => `${n} eigene Belegung(en) verwerfen und die Vorgaben nehmen?`,
  takenBy: (shortcut, action) => `${shortcut} ist belegt durch „${action}“.`,
  replace: 'Ersetzen',
  reserved: (shortcut, reason) => `${shortcut} ist reserviert: ${reason}.`,
  pressKeys: 'Tasten drücken … (Esc bricht ab)',
  removeKey: (key) => `${key} entfernen`,
  record: 'Aufnehmen',
  rebind: (action) => `Neu belegen: ${action}`,
  another: 'Weiteres Kürzel',
  anotherFor: (action) => `Weiteres Kürzel: ${action}`,
  resetFor: (action) => `Zurücksetzen: ${action}`,
  noAction: 'Keine Aktion passt.',
  note:
    'Gedimmt: hier gerade ohne Wirkung. Während der Aufnahme sind auch die Kürzel der Menüleiste ' +
    'aus. Tasten in Dialogen, Menüs und im Editor (Suchen, Kopieren …) sind fest.',
};
