import { describe, expect, it } from 'vitest';
import { FakeQueryApi } from '../../../testing/fake-apis';
import { EMPTY_SEARCH, FIRST_STRETCH_ROWS, ResultFind, STRETCH_ROWS } from './result-find';

describe('ResultFind', () => {
  const spec = (text: string, more: Partial<typeof EMPTY_SEARCH> = {}) => ({
    ...EMPTY_SEARCH,
    text,
    ...more,
  });

  function setup(rows: (string | number | null)[][]) {
    const api = new FakeQueryApi();
    api.results.set(7, rows);
    return { api, find: new ResultFind(api) };
  }

  const small = [
    ['Köln', 1042, 'paid'],
    ['Bonn', 42, null],
    ['köln-süd', 7, 'Paid in full'],
  ];

  it('finds cells, marks them for the grid and counts', async () => {
    const { find } = setup(small);
    await find.search(7, spec('köln'));
    expect(find.count()).toBe(2);
    expect(find.searching()).toBe(false);
    expect(find.marks.at(0, 0)).toBe('hit');
    expect(find.marks.at(2, 0)).toBe('hit');
    expect(find.marks.at(1, 0)).toBeNull();
    await find.search(7, spec('paid', { wholeWord: true, columns: [2] }));
    expect(find.count()).toBe(2);
    await find.search(7, spec('Paid', { caseSensitive: true }));
    expect(find.count()).toBe(1);
    await find.search(7, spec(''));
    expect(find.count()).toBe(0);
    expect(find.marks.at(2, 2)).toBeNull();
  });

  it('goes from hit to hit from where the cursor is, around the ends', async () => {
    const { find } = setup(small);
    await find.search(7, spec('4'));
    // hits: [0,1] and [1,1]
    expect(find.step(null, 1)).toEqual([0, 1]);
    expect(find.position()).toBe(1);
    expect(find.marks.at(0, 1)).toBe('current');
    expect(find.step([0, 1], 1)).toEqual([1, 1]);
    expect(find.step([1, 1], 1)).toEqual([0, 1]);
    expect(find.step([0, 1], -1)).toEqual([1, 1]);
    // from a cell between the hits
    expect(find.step([0, 2], 1)).toEqual([1, 1]);
    expect(find.step([0, 2], -1)).toEqual([0, 1]);
    expect(find.position()).toBe(1);
    await find.search(7, spec('nothing like it'));
    expect(find.step(null, 1)).toBeNull();
    expect(find.position()).toBe(0);
  });

  it('asks stretch by stretch: a small one first, then on to the end', async () => {
    const rows = Array.from({ length: FIRST_STRETCH_ROWS + STRETCH_ROWS + 10 }, (_, i) => [
      i % 1000 === 3 ? 'needle' : 'hay',
    ]);
    const { api, find } = setup(rows);
    await find.search(7, spec('needle'));
    expect(api.searches.map((s) => [s.from, s.maxRows])).toEqual([
      [0, FIRST_STRETCH_ROWS],
      [FIRST_STRETCH_ROWS, STRETCH_ROWS],
      [FIRST_STRETCH_ROWS + STRETCH_ROWS, STRETCH_ROWS],
    ]);
    expect(find.count()).toBe(rows.filter((r) => r[0] === 'needle').length);
    expect(find.searching()).toBe(false);
  });

  it('drops an overtaken search and stops its job', async () => {
    const { api, find } = setup(small);
    let open!: () => void;
    api.searchGate = new Promise<void>((r) => (open = r));
    const first = find.search(7, spec('köln'));
    expect(find.searching()).toBe(true);
    const job = api.searches[0].jobId;
    const second = find.search(7, spec('bonn'));
    expect(api.cancelledSearches).toContain(job);
    open();
    await Promise.all([first, second]);
    expect(find.spec().text).toBe('bonn');
    expect(find.count()).toBe(1);
    expect(find.marks.at(0, 0)).toBeNull();
    // closing stops and forgets, the text stays for the next time
    api.searchGate = new Promise<void>((r) => (open = r));
    const third = find.search(7, spec('paid'));
    find.close();
    open();
    await third;
    expect(find.open()).toBe(false);
    expect(find.count()).toBe(0);
    expect(find.spec().text).toBe('paid');
  });

  it('says at the field what is wrong about a pattern', async () => {
    const { api, find } = setup(small);
    api.searchError = { code: 'invalid_query', message: 'unclosed group' };
    await find.search(7, spec('a(b', { regex: true }));
    expect(find.problem()).toBe('Kein regulärer Ausdruck: unclosed group');
    expect(find.searching()).toBe(false);
    api.searchError = null;
    await find.search(7, spec('a'));
    expect(find.problem()).toBeNull();
  });

  it('seeks the next other value and the next NULL of a column', async () => {
    const { find } = setup([
      ['a', 1],
      ['a', null],
      ['b', 1],
      [null, 2],
    ]);
    expect(await find.seek(7, 0, 0, 'change')).toBe(2);
    expect(await find.seek(7, 0, 0, 'null')).toBe(3);
    expect(await find.seek(7, 1, 1, 'null')).toBeNull();
  });

  it('asks for the keyboard in one of its fields', () => {
    const { find } = setup(small);
    find.show();
    expect(find.open()).toBe(true);
    expect(find.focus()).toEqual({ field: 'text', n: 1 });
    find.show('row');
    expect(find.focus()).toEqual({ field: 'row', n: 2 });
  });
});
