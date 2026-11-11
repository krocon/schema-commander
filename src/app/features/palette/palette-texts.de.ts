import type { Translation } from '../../core/i18n/i18n';
import type { PALETTE_EN } from './palette-texts';

export const PALETTE_DE: Translation<typeof PALETTE_EN> = {
  title: 'Befehlspalette',
  search: 'Befehl suchen',
  placeholder: 'Befehl suchen …',
  commands: 'Befehle',
  none: 'Kein Befehl passt.',
  count: (n) => (n === 1 ? '1 Befehl' : `${n} Befehle`),
};
