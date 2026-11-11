import { translatable } from '../../core/i18n/i18n';
import { THEME_PICKER_DE } from './theme-picker-texts.de';

/** Texts of the colour scheme picker (prompt 020). */
export const THEME_PICKER_EN = {
  title: 'Colour scheme',
  filter: 'Filter',
  filterPlaceholder: 'Name, “light” or “dark”',
  count: (shown: number, total: number) => `${shown} of ${total} schemes`,
  schemes: 'Colour schemes',
  followSystem: 'Follow the system',
  own: 'Own',
  dark: 'Dark',
  light: 'Light',
  /** The kind of a scheme on its card, and a word the filter finds it by. */
  darkKind: 'dark',
  lightKind: 'light',
  none: 'No scheme matches the filter.',
  ownNotice: (notice: string) => `Own schemes: ${notice}`,
  newFromChosen: 'New from the chosen one …',
  newFromChosenHint: 'Creates a copy of the chosen scheme and opens it for editing',
  edit: 'Edit …',
  editHint: 'Only your own schemes can be edited',
  import: 'Import …',
  hint: 'The arrow keys show a scheme at once, Enter keeps it, Esc goes back.',
  importTitle: 'Import colour scheme',
  fileKind: 'Colour scheme',
  notAScheme: 'The file is not a colour scheme.',
};

export const THEME_PICKER_TEXTS = translatable('themePicker', THEME_PICKER_EN, {
  de: THEME_PICKER_DE,
});
