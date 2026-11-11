import type { Translation } from '../../core/i18n/i18n';
import type { FORMAT_EN } from './format-texts';

export const FORMAT_DE: Translation<typeof FORMAT_EN> = {
  running: 'Formatiere …',
  cancel: 'Abbrechen',
  unchanged: 'Nichts zu ändern: Der Text ist schon so gesetzt.',
  nothing: 'Hier gibt es nichts zu formatieren.',
  stale: 'Der Text wurde während des Formatierens bearbeitet; er blieb, wie er ist.',
  busy: 'Das Formatieren läuft noch.',
  cancelled: 'Das Formatieren wurde abgebrochen; der Text ist unverändert.',
};
