import { translatable } from '../../core/i18n/i18n';
import { PALETTE_DE } from './palette-texts.de';

/** Texts of the command palette (prompt 002). */
export const PALETTE_EN = {
  title: 'Command palette',
  search: 'Search for a command',
  placeholder: 'Search for a command …',
  commands: 'Commands',
  none: 'No command matches.',
  count: (n: number) => (n === 1 ? '1 command' : `${n} commands`),
};

export const PALETTE_TEXTS = translatable('palette', PALETTE_EN, { de: PALETTE_DE });
