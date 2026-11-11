import { translatable } from '../../core/i18n/i18n';
import { FORMAT_DE } from './format-texts.de';

/** Texts of formatting (prompt 023). English is the source. */
export const FORMAT_EN = {
  running: 'Formatting …',
  cancel: 'Cancel',
  unchanged: 'Nothing to change: the text is laid out like this already.',
  nothing: 'There is nothing to format here.',
  stale: 'The text was edited while it was being formatted; it was left as it is.',
  busy: 'Formatting is still running.',
  cancelled: 'Formatting was stopped; the text is unchanged.',
};

export const FORMAT_TEXTS = translatable('format', FORMAT_EN, { de: FORMAT_DE });
