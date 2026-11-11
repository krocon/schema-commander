import {
  Shown,
  Slot,
  activate,
  afterClose,
  collapse,
  focusOther,
  isSplit,
  moveToOther,
  repair,
  restoreDirection,
  restoreGroup,
  shownIn,
  unsplit,
} from './layout-logic';

const slots = (text: string): Slot[] =>
  // "a b | c d": a, b in the first group, c, d in the second
  text.split('|').flatMap((part, group) =>
    part
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => ({ id, group: group as 0 | 1 })),
  );
const show = (active: string | null, other: string | null = null): Shown => ({ active, other });
const text = (list: readonly Slot[]) =>
  [0, 1]
    .map((g) =>
      list
        .filter((s) => s.group === g)
        .map((s) => s.id)
        .join(' '),
    )
    .join(' | ')
    .replace(/ \| $/, '');

describe('split view', () => {
  it('is split only while both groups have tabs', () => {
    expect(isSplit(slots('a b'))).toBe(false);
    expect(isSplit(slots('a | b'))).toBe(true);
    // a second group alone is no split: its tabs are the first group
    expect(text(collapse(slots('| a b')))).toBe('a b');
    expect(text(collapse(slots('a | b')))).toBe('a | b');
  });

  it('splits by moving the tab in front to the other group, with the focus', () => {
    const r = moveToOther(slots('a b c'), show('b'), 'b')!;
    expect(text(r.slots)).toBe('a c | b');
    expect(r.shown).toEqual(show('b', 'c'));
    expect(shownIn(r.slots, r.shown, 0)).toBe('c');
    expect(shownIn(r.slots, r.shown, 1)).toBe('b');
  });

  it('cannot split a view of one tab', () => {
    expect(moveToOther(slots('a'), show('a'), 'a')).toBeNull();
    expect(moveToOther(slots('a b'), show('a'), 'x')).toBeNull();
  });

  it('ends the split when the last tab of a group moves over', () => {
    const r = moveToOther(slots('a b | c'), show('c', 'a'), 'c')!;
    expect(text(r.slots)).toBe('a b c');
    expect(r.shown).toEqual(show('c'));
    // from the first group: what is left is the first group again
    const back = moveToOther(slots('a | b c'), show('a', 'b'), 'a')!;
    expect(text(back.slots)).toBe('a b c');
    expect(back.shown).toEqual(show('a'));
  });

  it('gives the focus to the group of the tab that is activated', () => {
    const s = slots('a b | c d');
    expect(activate(s, show('a', 'c'), 'b')).toEqual(show('b', 'c'));
    // into the other group: what was in front stays visible in its own
    expect(activate(s, show('b', 'c'), 'd')).toEqual(show('d', 'b'));
    expect(activate(s, show('a', 'c'), 'zzz')).toEqual(show('a', 'c'));
    expect(focusOther(s, show('a', 'c'))).toEqual(show('c', 'a'));
    expect(focusOther(slots('a b'), show('a'))).toEqual(show('a'));
  });

  it('shows the neighbour after a close, and the other group when the group is empty', () => {
    const s = slots('a b c | d');
    expect(afterClose(s, show('b', 'd'), 'b').shown).toEqual(show('c', 'd'));
    expect(afterClose(s, show('c', 'd'), 'c').shown).toEqual(show('b', 'd'));
    // the last tab of the second group: the split ends, the first group has the focus
    const end = afterClose(s, show('d', 'a'), 'd');
    expect(text(end.slots)).toBe('a b c');
    expect(end.shown).toEqual(show('a'));
    // closing what the other group shows: it shows another of its tabs
    const other = afterClose(slots('a | c d'), show('a', 'c'), 'c');
    expect(other.shown).toEqual(show('a', 'd'));
    // a tab that is not in front
    expect(afterClose(s, show('a', 'd'), 'c').shown).toEqual(show('a', 'd'));
    expect(afterClose(slots('a'), show('a'), 'a')).toEqual({ slots: [], shown: show(null) });
  });

  it('ends the split on request and keeps what was in front', () => {
    const r = unsplit(slots('a | b c'), show('c', 'a'));
    expect(text(r.slots)).toBe('a b c');
    expect(r.shown).toEqual(show('c'));
  });

  it('repairs a stored state that names what is not there', () => {
    const s = slots('a b | c');
    expect(repair(s, show('gone', 'gone'))).toEqual(show('a', 'c'));
    // the other tab must be in the other group
    expect(repair(s, show('a', 'b'))).toEqual(show('a', 'c'));
    expect(repair(s, show('c', 'c'))).toEqual(show('c', 'a'));
    expect(repair(slots('a b'), show('b', 'a'))).toEqual(show('b'));
    expect(repair([], show('a', 'b'))).toEqual(show(null));
    expect(restoreDirection('column')).toBe('column');
    expect(restoreDirection('diagonal')).toBe('row');
    expect(restoreGroup(1)).toBe(1);
    expect(restoreGroup(7)).toBe(0);
    expect(restoreGroup(undefined)).toBe(0);
  });
});
