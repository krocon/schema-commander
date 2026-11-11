import type { Translation } from '../../core/i18n/i18n';
import type { PALETTE_EN } from './palette-texts';

export const PALETTE_DE: Translation<typeof PALETTE_EN> = {
  title: 'Befehlspalette',
  search: 'Befehl suchen',
  placeholder: 'Befehl suchen …',
  commands: 'Befehle',
  none: 'Kein Befehl passt.',
  count: (n) => (n === 1 ? '1 Befehl' : `${n} Befehle`),
  gotoTitle: 'Springen zu allem',
  gotoSearch: 'Tabellen, Views, Routinen, Tabs und Verbindungen suchen',
  gotoPlaceholder:
    'Springen zu … (t: Tabellen, c: Spalten, f: Routinen, @ Verbindungen, > Befehle)',
  gotoList: 'Treffer',
  gotoNone: 'Nichts passt.',
  gotoReading: 'Die Namen der Datenbank werden gelesen …',
  gotoNoSaved: 'Gespeicherte Abfragen gibt es noch nicht.',
  gotoCount: (n) => (n === 1 ? '1 Treffer' : `${n} Treffer`),
  gotoCountOf: (shown, all) => `${shown} von ${all} Treffern – mehr tippen grenzt ein`,
  gotoKeys:
    'Enter: öffnen · Umschalt+Enter: Details · Alt+Enter: Name einfügen · Strg/⌘+Enter: SELECT · Strg/⌘+Umschalt+Enter: im Baum zeigen',
  kinds: {
    table: 'Tabelle',
    view: 'View',
    matview: 'Materialisierte View',
    routine: 'Routine',
    sequence: 'Sequenz',
    column: 'Spalte',
    tab: 'Offener Tab',
    connection: 'Verbindung',
  },
  icons: {
    table: 'T',
    view: 'V',
    matview: 'M',
    routine: 'ƒ',
    sequence: '#',
    column: 'c',
    tab: '▭',
    connection: '@',
  },
};
