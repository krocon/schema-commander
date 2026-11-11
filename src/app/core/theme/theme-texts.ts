import { translatable } from '../i18n/i18n';
import { THEME_DE } from './theme-texts.de';

/** Names of the two base schemes; every other built-in scheme carries the name of its original. */
export const THEME_EN = {
  dark: 'Dark',
  light: 'Light',
};

export const THEME_TEXTS = translatable('theme', THEME_EN, { de: THEME_DE });
