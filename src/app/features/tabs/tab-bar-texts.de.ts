import type { Translation } from '../../core/i18n/i18n';
import type { TAB_BAR_EN } from './tab-bar-texts';

export const TAB_BAR_DE: Translation<typeof TAB_BAR_EN> = {
  queries: 'Abfragen',
  queriesOfGroup: (n) => `Abfragen, Gruppe ${n}`,
  tabName: 'Name des Tabs',
  openTransaction: 'Offene Transaktion',
  changedSinceSave: 'Geändert seit dem Speichern',
  changed: 'geändert',
  closeTab: (title) => `${title} schließen`,
  newTab: 'Neuer Tab',
  menu: 'Tab',
};
