import { translatable } from '../../core/i18n/i18n';
import { EDITOR_DE } from './editor-texts.de';

/** Texts of the SQL editor. English is the source. */
export const EDITOR_EN = {
  label: 'SQL editor',
  loadFailed: 'The editor could not be loaded.',
  loading: 'Loading the editor …',
};

export const EDITOR_TEXTS = translatable('editor', EDITOR_EN, { de: EDITOR_DE });
