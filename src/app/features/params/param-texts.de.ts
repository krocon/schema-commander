import type { Translation } from '../../core/i18n/i18n';
import type { PARAM_EN } from './param-texts';

export const PARAM_DE: Translation<typeof PARAM_EN> = {
  title: 'Parameter',
  intro:
    'Die Werte gehen getrennt von der Anweisung an die Datenbank; sie werden nie Teil ihres Textes.',
  value: (name) => `Wert von ${name}`,
  type: (name) => `Typ von ${name}`,
  listHint: 'Ein Eintrag je Zeile oder durch Kommas getrennt.',
  run: 'Ausführen',
  types: {
    auto: 'Automatisch',
    text: 'Text',
    number: 'Zahl',
    date: 'Datum',
    bool: 'Ja / nein',
    list: 'Liste',
    null: 'NULL',
  },
  reads: {
    text: 'Text',
    int: 'ganze Zahl',
    decimal: 'Zahl',
    bool: 'ja / nein',
    date: 'Datum',
    datetime: 'Datum und Zeit',
    null: 'NULL',
    list: (n) => (n === 1 ? '1 Eintrag' : `${n} Einträge`),
  },
  problems: {
    missing: (name) => `${name} hat keinen Wert.`,
    number: (name) => `${name} ist keine Zahl (wie 42 oder 3.14).`,
    date: (name) => `${name} ist kein Datum (wie 2026-11-11 oder 11.11.2026, mit Zeit 12:30).`,
    bool: (name) => `${name} ist weder ja noch nein (true, false, 1, 0).`,
  },
  forms: 'Was auf dieser Verbindung als Parameter gilt',
  formsReset: 'Vorgaben',
  none: 'Mit diesen Formen hat die Anweisung keine Parameter. „Ausführen“ führt sie aus, wie sie dasteht.',
  noValues: 'Es gibt noch keine Werte, mit denen erneut ausgeführt werden könnte.',
  notBound: (name) => `Nicht ausgeführt: ${name} hat keinen brauchbaren Wert.`,
  with: (values) => `mit ${values}`,
};
