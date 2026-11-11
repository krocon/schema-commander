import type { Translation } from '../../core/i18n/i18n';
import type { EDITOR_EN } from './editor-texts';

export const EDITOR_DE: Translation<typeof EDITOR_EN> = {
  label: 'SQL-Editor',
  loadFailed: 'Der Editor konnte nicht geladen werden.',
  loading: 'Editor wird geladen …',
};
