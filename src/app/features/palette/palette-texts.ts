import { translatable } from '../../core/i18n/i18n';
import { PALETTE_DE } from './palette-texts.de';

/** Texts of the command palette (prompt 002). */
export const PALETTE_EN = {
  title: 'Command palette',
  search: 'Search for a command',
  placeholder: 'Search for a command …',
  commands: 'Commands',
  none: 'No command matches.',
  count: (n: number) => (n === 1 ? '1 command' : `${n} commands`),
  gotoTitle: 'Go to anything',
  gotoSearch: 'Search tables, views, routines, tabs and connections',
  gotoPlaceholder: 'Go to … (t: tables, c: columns, f: routines, @ connections, > commands)',
  gotoList: 'Hits',
  gotoNone: 'Nothing matches.',
  gotoReading: 'Reading the names of the database …',
  gotoNoSaved: 'There are no saved queries yet.',
  gotoCount: (n: number) => (n === 1 ? '1 hit' : `${n} hits`),
  gotoCountOf: (shown: number, all: number) => `${shown} of ${all} hits – type more to narrow them`,
  gotoKeys:
    'Enter: open · Shift+Enter: details · Alt+Enter: insert name · Ctrl/⌘+Enter: SELECT · Ctrl/⌘+Shift+Enter: show in the tree',
  kinds: {
    table: 'Table',
    view: 'View',
    matview: 'Materialized view',
    routine: 'Routine',
    sequence: 'Sequence',
    column: 'Column',
    tab: 'Open tab',
    connection: 'Connection',
  },
  /** The sign in front of a hit. */
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

export const PALETTE_TEXTS = translatable('palette', PALETTE_EN, { de: PALETTE_DE });
