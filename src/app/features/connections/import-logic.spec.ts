import { emptyProfile, ImportItem } from '../../core/connections/connection.models';
import {
  IMPORT_SOURCES,
  importSummary,
  initialTicks,
  isDatabaseFile,
  picksOf,
  problemText,
} from './import-logic';

const item = (index: number, over: Partial<ImportItem> = {}): ImportItem => ({
  index,
  profile: { ...emptyProfile('postgres'), name: `p${index}`, host: 'h', user: 'u' },
  hasPassword: false,
  problem: null,
  nameTaken: false,
  ...over,
});

describe('import preview', () => {
  const items = [
    item(0, { hasPassword: true }),
    item(1, { problem: 'the user is missing' }),
    item(2),
    item(5, { hasPassword: true }),
  ];

  it('starts with everything that can be stored ticked, and no password', () => {
    const ticks = initialTicks(items);
    expect(ticks.map((t) => t.take)).toEqual([true, false, true, true]);
    expect(ticks.every((t) => !t.withPassword)).toBe(true);
    expect(picksOf(items, ticks)).toEqual([
      { index: 0, withPassword: false },
      { index: 2, withPassword: false },
      { index: 5, withPassword: false },
    ]);
  });

  it('takes a password only where one stands and it is asked for', () => {
    const ticks = initialTicks(items).map((t) => ({ ...t, withPassword: true }));
    expect(picksOf(items, ticks)).toEqual([
      { index: 0, withPassword: true },
      { index: 2, withPassword: false },
      { index: 5, withPassword: true },
    ]);
  });

  it('never picks what cannot be stored, whatever is ticked', () => {
    const ticks = items.map(() => ({ take: true, withPassword: true }));
    expect(picksOf(items, ticks).map((p) => p.index)).toEqual([0, 2, 5]);
    expect(picksOf(items, [])).toEqual([]);
  });

  it('sums up', () => {
    expect(importSummary([], [])).toContain('keine Verbindung');
    const ticks = initialTicks(items);
    expect(importSummary(items, ticks)).toBe('3 von 4 ausgewählt · 1 unvollständig');
    ticks[0] = { take: true, withPassword: true };
    expect(importSummary(items, ticks)).toBe(
      '3 von 4 ausgewählt · 1 mit Passwort (in den Schlüsselbund) · 1 unvollständig',
    );
  });

  it('says in German what is missing', () => {
    expect(problemText('the user is missing')).toContain('Benutzer fehlt');
    expect(problemText('the host is missing or not a host name')).toBe('Der Host fehlt.');
    expect(problemText('something else')).toBe('something else');
  });

  it('knows its sources and database files', () => {
    expect(IMPORT_SOURCES).toHaveLength(7);
    expect(new Set(IMPORT_SOURCES.map((s) => s.id)).size).toBe(7);
    expect(isDatabaseFile('/data/Shop.SQLite3')).toBe(true);
    expect(isDatabaseFile('C:\\x\\y.db')).toBe(true);
    expect(isDatabaseFile('/data/query.sql')).toBe(false);
    expect(isDatabaseFile('/data/db')).toBe(false);
  });
});
