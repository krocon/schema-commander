import type { Translation } from '../../core/i18n/i18n';
import type { THEME_PICKER_EN } from './theme-picker-texts';

export const THEME_PICKER_DE: Translation<typeof THEME_PICKER_EN> = {
  title: 'Farbschema',
  filter: 'Filter',
  filterPlaceholder: 'Name, „hell“ oder „dunkel“',
  count: (shown, total) => `${shown} von ${total} Schemata`,
  schemes: 'Farbschemata',
  followSystem: 'System folgen',
  own: 'Eigene',
  dark: 'Dunkel',
  light: 'Hell',
  darkKind: 'dunkel',
  lightKind: 'hell',
  none: 'Kein Schema passt zum Filter.',
  ownNotice: (notice) => `Eigene Schemata: ${notice}`,
  newFromChosen: 'Neu aus gewähltem …',
  newFromChosenHint: 'Legt eine Kopie des gewählten Schemas an und öffnet sie zum Bearbeiten',
  edit: 'Bearbeiten …',
  editHint: 'Nur eigene Schemata lassen sich bearbeiten',
  import: 'Importieren …',
  hint: 'Pfeiltasten zeigen ein Schema sofort, Enter behält es, Esc kehrt zurück.',
  importTitle: 'Farbschema importieren',
  fileKind: 'Farbschema',
  notAScheme: 'Die Datei ist kein Farbschema.',
};
