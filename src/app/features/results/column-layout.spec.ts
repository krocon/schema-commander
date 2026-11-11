import { describe, expect, it } from 'vitest';
import {
  EMPTY_LAYOUT,
  columnKeys,
  columnRows,
  isPlainLayout,
  mergeLayout,
  moveColumn,
  rememberLayout,
  reorder,
  resolveLayout,
  setHidden,
  setPinned,
  setWidth,
  showAll,
  withoutWidths,
} from './column-layout';

const cols = (...names: string[]) =>
  names.map((name) => ({ name, kind: 'text' as const, typeName: 'text' }));
const ABCD = cols('a', 'b', 'c', 'd');

describe('column-layout', () => {
  it('names columns by their name, a repeated name by its count', () => {
    expect(columnKeys(cols('id', 'name', 'id', 'id'))).toEqual(['id', 'name', 'id#2', 'id#3']);
  });

  it('changes nothing while it is empty', () => {
    expect(resolveLayout(EMPTY_LAYOUT, ABCD)).toEqual({
      shown: [0, 1, 2, 3],
      pinned: 0,
      widths: [undefined, undefined, undefined, undefined],
    });
    expect(isPlainLayout(EMPTY_LAYOUT, ABCD)).toBe(true);
    expect(isPlainLayout(setWidth(EMPTY_LAYOUT, 'a', 90), ABCD)).toBe(false);
  });

  it('hides and shows columns, but never the last one', () => {
    let l = setHidden(EMPTY_LAYOUT, ABCD, 'b', true);
    expect(resolveLayout(l, ABCD).shown).toEqual([0, 2, 3]);
    l = setHidden(setHidden(setHidden(l, ABCD, 'a', true), ABCD, 'c', true), ABCD, 'd', true);
    expect(resolveLayout(l, ABCD).shown).toEqual([3]);
    expect(resolveLayout(setHidden(l, ABCD, 'c', false), ABCD).shown).toEqual([2, 3]);
    expect(resolveLayout(showAll(l, ABCD), ABCD).shown).toEqual([0, 1, 2, 3]);
    // a stored layout that hides everything shows everything
    expect(resolveLayout({ ...EMPTY_LAYOUT, hidden: ['a', 'b', 'c', 'd'] }, ABCD).shown).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it('pins columns to the left in the order they were pinned, one column always scrolls', () => {
    let l = setPinned(EMPTY_LAYOUT, ABCD, 'c', true);
    l = setPinned(l, ABCD, 'a', true);
    expect(resolveLayout(l, ABCD)).toMatchObject({ shown: [2, 0, 1, 3], pinned: 2 });
    expect(resolveLayout(setPinned(l, ABCD, 'c', false), ABCD)).toMatchObject({
      shown: [0, 1, 2, 3],
      pinned: 1,
    });
    const all = ['a', 'b', 'c', 'd'].reduce((x, k) => setPinned(x, ABCD, k, true), EMPTY_LAYOUT);
    expect(resolveLayout(all, ABCD).pinned).toBe(3);
  });

  it('moves a column among its neighbours, over hidden ones, and stops at the ends', () => {
    let l = moveColumn(EMPTY_LAYOUT, ABCD, 'a', 1);
    expect(resolveLayout(l, ABCD).shown).toEqual([1, 0, 2, 3]);
    l = moveColumn(l, ABCD, 'a', -1);
    expect(resolveLayout(l, ABCD).shown).toEqual([0, 1, 2, 3]);
    expect(resolveLayout(moveColumn(l, ABCD, 'a', -1), ABCD).shown).toEqual([0, 1, 2, 3]);
    expect(resolveLayout(moveColumn(l, ABCD, 'd', 1), ABCD).shown).toEqual([0, 1, 2, 3]);
    const hidden = setHidden(EMPTY_LAYOUT, ABCD, 'b', true);
    expect(resolveLayout(moveColumn(hidden, ABCD, 'a', 1), ABCD).shown).toEqual([2, 0, 3]);
    // pinned ones move among the pinned
    let p = setPinned(setPinned(EMPTY_LAYOUT, ABCD, 'a', true), ABCD, 'b', true);
    p = moveColumn(p, ABCD, 'b', -1);
    expect(resolveLayout(p, ABCD)).toMatchObject({ shown: [1, 0, 2, 3], pinned: 2 });
    expect(resolveLayout(moveColumn(p, ABCD, 'a', 1), ABCD).shown).toEqual([1, 0, 2, 3]);
    // and the others never in front of them
    expect(resolveLayout(moveColumn(p, ABCD, 'c', -1), ABCD).shown).toEqual([1, 0, 2, 3]);
  });

  it('takes the order the user dragged and keeps hidden columns where they were', () => {
    const hidden = setHidden(EMPTY_LAYOUT, ABCD, 'b', true);
    const l = reorder(hidden, ABCD, ['d', 'a', 'c']);
    expect(resolveLayout(l, ABCD).shown).toEqual([3, 0, 2]);
    expect(resolveLayout(showAll(l, ABCD), ABCD).shown).toEqual([3, 0, 1, 2]);
  });

  it('survives a changed column list: new columns stand where the result has them', () => {
    let l = setHidden(EMPTY_LAYOUT, ABCD, 'b', true);
    l = moveColumn(l, ABCD, 'd', -1);
    l = setPinned(l, ABCD, 'c', true);
    l = setWidth(l, 'd', 120);
    // b and c are gone, x came behind a, y at the end
    const now = cols('a', 'x', 'd', 'y');
    expect(resolveLayout(l, now)).toEqual({
      shown: [0, 1, 2, 3],
      pinned: 0,
      widths: [undefined, undefined, 120, undefined],
    });
    // back with the old list the layout is as it was
    expect(resolveLayout(l, ABCD)).toMatchObject({ shown: [2, 0, 3], pinned: 1 });
  });

  it('keeps widths within bounds and forgets them on request', () => {
    const l = setWidth(setWidth(EMPTY_LAYOUT, 'a', 5), 'b', 99_999);
    expect(l.widths).toEqual({ a: 30, b: 4000 });
    expect(resolveLayout(l, ABCD).widths).toEqual([30, 4000, undefined, undefined]);
    expect(withoutWidths(l).widths).toEqual({});
  });

  it('reads a stored layout and leaves out what is none', () => {
    expect(mergeLayout(null)).toEqual(EMPTY_LAYOUT);
    expect(mergeLayout('x')).toEqual(EMPTY_LAYOUT);
    expect(
      mergeLayout({
        order: ['a', 3, 'a', 'b'],
        hidden: 'no',
        pinned: ['a'],
        widths: { a: 100.4, b: 'wide', c: 1e9, d: Number.NaN },
      }),
    ).toEqual({ order: ['a', 'b'], hidden: [], pinned: ['a'], widths: { a: 100, c: 4000 } });
  });

  it('remembers layouts per table, forgets an empty one and the oldest beyond the limit', () => {
    const one = setWidth(EMPTY_LAYOUT, 'a', 100);
    let all = rememberLayout({}, 't1', one);
    all = rememberLayout(all, 't2', one);
    all = rememberLayout(all, 't1', setWidth(one, 'b', 50));
    expect(Object.keys(all)).toEqual(['t2', 't1']);
    expect(Object.keys(rememberLayout(all, 't2', EMPTY_LAYOUT))).toEqual(['t1']);
    let many: Record<string, typeof one> = {};
    for (let i = 0; i < 205; i++) many = rememberLayout(many, `t${i}`, one);
    expect(Object.keys(many)).toHaveLength(200);
    expect(Object.keys(many)[0]).toBe('t5');
  });

  it('lists all columns for the column list, pinned first, filtered by name', () => {
    let l = setHidden(EMPTY_LAYOUT, ABCD, 'b', true);
    l = setPinned(l, ABCD, 'd', true);
    expect(
      columnRows(l, ABCD).map((r) => `${r.name}${r.pinned ? '*' : ''}${r.hidden ? '-' : ''}`),
    ).toEqual(['d*', 'a', 'b-', 'c']);
    expect(columnRows(l, cols('Id', 'customer_id', 'name'), ' ID ').map((r) => r.index)).toEqual([
      0, 1,
    ]);
  });
});
