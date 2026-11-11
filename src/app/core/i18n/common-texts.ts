import { translatable } from './i18n';
import { COMMON_DE } from './common-texts.de';

/** Words many dialogs share. A text that belongs to one feature goes into the catalog of that feature. */
export const COMMON_EN = {
  ok: 'OK',
  cancel: 'Cancel',
  close: 'Close',
  save: 'Save',
  delete: 'Delete',
  remove: 'Remove',
  yes: 'Yes',
  no: 'No',
  back: 'Back',
  next: 'Next',
  search: 'Search',
  reset: 'Reset',
  loading: 'Loading …',
  none: 'None',
  all: 'All',
  name: 'Name',
  closeMenu: 'Close menu',
  closeMessage: 'Close message',
  keymapUnreadable: 'Your own shortcuts could not be read; the defaults apply.',
};

export const COMMON_TEXTS = translatable('common', COMMON_EN, { de: COMMON_DE });
