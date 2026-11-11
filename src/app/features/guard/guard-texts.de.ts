import type { Translation } from '../../core/i18n/i18n';
import type { GUARD_EN } from './guard-texts';

export const GUARD_DE: Translation<typeof GUARD_EN> = {
  classes: {
    read: 'liest',
    write: 'ändert Daten',
    ddl: 'ändert das Schema',
    dangerous: 'zerstört oder vergibt Rechte',
  },
  protections: {
    free: 'frei',
    ask: 'nachfragen',
    readonly: 'nur lesen',
  },
  titleDangerous: (n) =>
    n === 1
      ? 'Diese Anweisung zerstört Daten oder ändert Rechte'
      : `${n} Anweisungen zerstören Daten oder ändern Rechte`,
  titleChanging: (n) =>
    n === 1 ? 'Diese Anweisung ändert die Datenbank' : `${n} Anweisungen ändern die Datenbank`,
  badgeReadonly: 'nur lesen',
  badgeProtected: 'geschützt',
  others: (total) => `Der Lauf hat ${total} Anweisungen; die übrigen laufen ohne Rückfrage.`,
  typeName: 'Zum Bestätigen den Namen der Verbindung eingeben:',
  run: 'Ausführen',
};
