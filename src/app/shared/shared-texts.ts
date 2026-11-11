import { translatable } from '../core/i18n/i18n';
import { SHARED_DE } from './shared-texts.de';

/** Texts of the shared widgets (splitter, context menu). */
export const SHARED_EN = {
  resize: 'Resize',
  contextMenu: 'Context menu',
};

export const SHARED_TEXTS = translatable('shared', SHARED_EN, { de: SHARED_DE });
