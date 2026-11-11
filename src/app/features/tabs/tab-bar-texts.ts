import { translatable } from '../../core/i18n/i18n';
import { TAB_BAR_DE } from './tab-bar-texts.de';

/** Texts of the tab strip (prompts 004, 016). English is the source. */
export const TAB_BAR_EN = {
  queries: 'Queries',
  queriesOfGroup: (n: number) => `Queries, group ${n}`,
  tabName: 'Name of the tab',
  openTransaction: 'Open transaction',
  changedSinceSave: 'Changed since it was saved',
  changed: 'changed',
  closeTab: (title: string) => `Close ${title}`,
  newTab: 'New tab',
  menu: 'Tab',
  rename: 'Rename',
  duplicate: 'Duplicate',
  saveAsFile: 'Save as file …',
  toOtherGroup: 'To the other group',
  splitRight: 'Split to the right',
  unsplit: 'Join the groups',
  closeOthers: 'Close others',
  reopen: 'Reopen closed tab',
};

export const TAB_BAR_TEXTS = translatable('tabBar', TAB_BAR_EN, { de: TAB_BAR_DE });
