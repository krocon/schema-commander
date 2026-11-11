import type { Translation } from '../../core/i18n/i18n';
import type { THEME_EDITOR_EN } from './theme-editor-texts';

export const THEME_EDITOR_DE: Translation<typeof THEME_EDITOR_EN> = {
  title: 'Schema bearbeiten',
  brightness: 'Helligkeit',
  dark: 'dunkel',
  light: 'hell',
  filter: 'Filter',
  filterPlaceholder: 'Name eines Tokens',
  dropped: (n, names) => `${n} Einträge der Datei wurden verworfen: ${names}`,
  chooseColor: (token) => `${token}, Farbe wählen`,
  valueOf: (token) => `${token}, Wert`,
  resetToken: (token) => `${token} zurücksetzen`,
  resetHint: 'Auf den Wert der Basis zurücksetzen',
  noToken: 'Kein Token passt zum Filter.',
  allPairsOk: 'Alle Kontrastpaare erfüllen WCAG AA.',
  failingPairs: (n) =>
    n === 1
      ? '⚠ 1 Kontrastpaar liegt unter WCAG AA.'
      : `⚠ ${n} Kontrastpaare liegen unter WCAG AA.`,
  export: 'Exportieren …',
  reallyDelete: 'Wirklich löschen?',
  nameTaken: 'Diesen Namen gibt es schon.',
  exportTitle: 'Farbschema exportieren',
  fileKind: 'Farbschema',
  unnamed: 'Schema',
  contrast: (ratio, against, min) => `Kontrast ${ratio}:1 gegen ${against} (Soll ${min}:1)`,
  copyOf: (name, n) => (n < 2 ? `${name} (Kopie)` : `${name} (Kopie ${n})`),
  nameMissing: 'Bitte einen Namen eingeben.',
  nameTooLong: (max) => `Höchstens ${max} Zeichen.`,
  nameControl: 'Der Name enthält Steuerzeichen.',
  imported: 'Importiertes Schema',
};
