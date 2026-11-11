import { PaletteEntry, fuzzyMatch, markedParts, paletteHits, pushRecent } from './palette-logic';

const entry = (id: string, label: string, enabled = true, group = 'Ansicht'): PaletteEntry => ({
  id,
  label,
  group,
  keys: '',
  enabled,
});
const ENTRIES = [
  entry('RUN_STATEMENT', 'Anweisung unter dem Cursor ausführen', true, 'Abfrage'),
  entry('TOGGLE_SIDEBAR', 'Seitenleiste ein-/ausblenden'),
  entry('COLOR_SCHEME', 'Farbschema wählen …'),
  entry('OPEN_SHORTCUTS', 'Tastenkürzel bearbeiten …', true, 'Hilfe'),
  entry('FOCUS_RESULT', 'In das Ergebnis', false, 'Navigation'),
];
const ids = (query: string, recent: string[] = []) =>
  paletteHits(ENTRIES, query, recent).map((h) => h.entry.id);

describe('command palette logic', () => {
  it('matches words, subsequences and ignores case and accents', () => {
    expect(fuzzyMatch('farb', 'Farbschema wählen')?.marks).toEqual([0, 1, 2, 3]);
    expect(fuzzyMatch('fsw', 'Farbschema wählen')).not.toBeNull();
    expect(fuzzyMatch('WAHLEN', 'Farbschema wählen')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'Farbschema wählen')).toBeNull();
    expect(fuzzyMatch('wählen farb', 'Farbschema wählen')).not.toBeNull();
  });

  it('prefers a match at the start and at the start of a word', () => {
    const start = fuzzyMatch('sei', 'Seitenleiste')!.score;
    const word = fuzzyMatch('lei', 'Seiten Leiste')!.score;
    const inside = fuzzyMatch('eit', 'Seitenleiste')!.score;
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
  });

  it('lists recently used actions first when nothing is typed', () => {
    expect(ids('')).toEqual(ENTRIES.map((e) => e.id));
    expect(ids('', ['COLOR_SCHEME', 'OPEN_SHORTCUTS']).slice(0, 3)).toEqual([
      'COLOR_SCHEME',
      'OPEN_SHORTCUTS',
      'RUN_STATEMENT',
    ]);
  });

  it('orders hits by score and finds an action by group or id', () => {
    expect(ids('farb')).toEqual(['COLOR_SCHEME']);
    expect(ids('seite')[0]).toBe('TOGGLE_SIDEBAR');
    expect(ids('hilfe')).toEqual(['OPEN_SHORTCUTS']);
    expect(ids('toggle')).toEqual(['TOGGLE_SIDEBAR']);
    expect(ids('zzz')).toEqual([]);
  });

  it('breaks ties by recency', () => {
    const two = [entry('A', 'Tab links'), entry('B', 'Tab rechts')];
    expect(paletteHits(two, 'tab', ['B']).map((h) => h.entry.id)).toEqual(['B', 'A']);
  });

  it('splits a label at the marks', () => {
    expect(markedParts('Farbschema', [0, 1, 4])).toEqual([
      ['Fa', true],
      ['rb', false],
      ['s', true],
      ['chema', false],
    ]);
    expect(markedParts('Farbschema', [])).toEqual([['Farbschema', false]]);
  });

  it('keeps the recently used ids short and unique', () => {
    expect(pushRecent(['A', 'B', 'C'], 'B', 3)).toEqual(['B', 'A', 'C']);
    expect(pushRecent(['A', 'B', 'C'], 'D', 3)).toEqual(['D', 'A', 'B']);
  });
});
