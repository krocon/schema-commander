import { translatable } from '../../core/i18n/i18n';
import { THEME_EDITOR_DE } from './theme-editor-texts.de';

/** Texts of the scheme editor (design 001) and of its pure logic. */
export const THEME_EDITOR_EN = {
  title: 'Edit scheme',
  brightness: 'Brightness',
  dark: 'dark',
  light: 'light',
  filter: 'Filter',
  filterPlaceholder: 'Name of a token',
  dropped: (n: number, names: string) =>
    n === 1
      ? `1 entry of the file was dropped: ${names}`
      : `${n} entries of the file were dropped: ${names}`,
  chooseColor: (token: string) => `${token}, choose colour`,
  valueOf: (token: string) => `${token}, value`,
  resetToken: (token: string) => `Reset ${token}`,
  resetHint: 'Reset to the value of the base',
  noToken: 'No token matches the filter.',
  allPairsOk: 'All contrast pairs meet WCAG AA.',
  failingPairs: (n: number) =>
    n === 1 ? '⚠ 1 contrast pair is below WCAG AA.' : `⚠ ${n} contrast pairs are below WCAG AA.`,
  export: 'Export …',
  reallyDelete: 'Really delete?',
  nameTaken: 'This name already exists.',
  exportTitle: 'Export colour scheme',
  fileKind: 'Colour scheme',
  /** File name of an export without a name. */
  unnamed: 'Scheme',
  contrast: (ratio: string, against: string, min: number) =>
    `Contrast ${ratio}:1 against ${against} (required ${min}:1)`,
  // theme-editor-logic.ts
  copyOf: (name: string, n: number) => (n < 2 ? `${name} (copy)` : `${name} (copy ${n})`),
  nameMissing: 'Please enter a name.',
  nameTooLong: (max: number) => `At most ${max} characters.`,
  nameControl: 'The name contains control characters.',
  imported: 'Imported scheme',
};

export const THEME_EDITOR_TEXTS = translatable('themeEditor', THEME_EDITOR_EN, {
  de: THEME_EDITOR_DE,
});
