import { describe, expect, it } from 'vitest';
import { NameHit } from '../../core/schema/schema.models';
import {
  GotoHit,
  allowsVariant,
  gotoScope,
  localHits,
  markedChars,
  mergeHits,
  objectHit,
  variantOf,
} from './goto-logic';

const name = (kind: NameHit['kind'], n: string, over: Partial<NameHit> = {}): NameHit => ({
  kind,
  schema: 'shop',
  name: n,
  parent: null,
  detail: '',
  quoted: `shop.${n}`,
  quotedName: n,
  marks: [],
  ...over,
});

describe('go to anything', () => {
  it('reads what a query asks for', () => {
    expect(gotoScope('ord')).toMatchObject({
      objects: true,
      tabs: true,
      connections: true,
      text: 'ord',
    });
    expect(gotoScope(' @ prod ')).toMatchObject({
      objects: false,
      tabs: false,
      connections: true,
      text: 'prod',
    });
    for (const prefix of ['t:', 'V:', 'c:', 'f:', 's:']) {
      expect(gotoScope(`${prefix}x`), prefix).toMatchObject({
        objects: true,
        tabs: false,
        connections: false,
      });
    }
    expect(gotoScope('q:monthly')).toMatchObject({ objects: false, saved: true, text: 'monthly' });
    // an unknown prefix is text
    expect(gotoScope('x:y')).toMatchObject({ objects: true, tabs: true, text: 'x:y' });
  });

  it('finds tabs and connections, the best first, all of them without a text', () => {
    const items = [
      { id: '1', name: 'Kunden', where: 'Shop' },
      { id: '2', name: 'Offene Bestellungen', where: 'Shop' },
      { id: '3', name: 'Bestellungen 2026', where: 'Archiv' },
    ];
    expect(localHits('tab', items, '').map((h) => h.id)).toEqual(['1', '2', '3']);
    const hits = localHits('tab', items, 'best');
    expect(hits.map((h) => h.id)).toEqual(['3', '2']);
    expect(hits[0]).toMatchObject({
      key: 'tab-3',
      kind: 'tab',
      where: 'Archiv',
      marks: [0, 1, 2, 3],
    });
    expect(localHits('connection', items, 'zzz')).toEqual([]);
  });

  it('describes a name of the database', () => {
    expect(objectHit(name('table', 'orders'), 0)).toMatchObject({ key: 'name-0', where: 'shop' });
    expect(objectHit(name('routine', 'twice', { detail: 'n integer' }), 1).where).toBe(
      'shop · (n integer)',
    );
    expect(objectHit(name('column', 'id', { parent: 'orders', detail: 'integer' }), 2).where).toBe(
      'shop.orders · integer',
    );
  });

  it('puts what the window knows first, a few of each', () => {
    const hit = (key: string): GotoHit => ({ key, kind: 'tab', name: key, where: '', marks: [] });
    const tabs = Array.from({ length: 9 }, (_, i) => hit(`t${i}`));
    const names = [hit('n1'), hit('n2')];
    expect(mergeHits(tabs, [hit('c1')], names).map((h) => h.key)).toEqual([
      't0',
      't1',
      't2',
      't3',
      't4',
      'c1',
      'n1',
      'n2',
    ]);
    // without names of the database nothing is held back
    expect(mergeHits(tabs, [], []).length).toBe(9);
  });

  it('knows what the keys mean and where a variant makes sense', () => {
    const key = (over: Partial<KeyboardEventInit> & { key?: string }) =>
      variantOf({
        key: 'Enter',
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        ...over,
      });
    expect(key({})).toBe('default');
    expect(key({ shiftKey: true })).toBe('details');
    expect(key({ altKey: true })).toBe('insert');
    expect(key({ ctrlKey: true })).toBe('select');
    expect(key({ metaKey: true, shiftKey: true })).toBe('tree');
    expect(key({ key: 'a' })).toBeNull();
    const table = objectHit(name('table', 'orders'), 0);
    const routine = objectHit(name('routine', 'twice'), 1);
    const column = objectHit(name('column', 'id', { parent: 'orders' }), 2);
    const tab: GotoHit = { key: 'tab-1', kind: 'tab', name: 'x', where: '', marks: [], id: '1' };
    expect(allowsVariant(table, 'select')).toBe(true);
    expect(allowsVariant(routine, 'select')).toBe(false);
    expect(allowsVariant(routine, 'details')).toBe(true);
    expect(allowsVariant(column, 'details')).toBe(false);
    expect(allowsVariant(column, 'insert')).toBe(true);
    expect(allowsVariant(column, 'tree')).toBe(true);
    expect(allowsVariant(tab, 'details')).toBe(false);
    expect(allowsVariant(tab, 'default')).toBe(true);
  });

  it('marks characters, not UTF-16 units', () => {
    expect(markedChars('orders', [])).toEqual([['orders', false]]);
    expect(markedChars('order_items', [0, 1, 2, 6, 7])).toEqual([
      ['ord', true],
      ['er_', false],
      ['it', true],
      ['ems', false],
    ]);
    // a character outside the BMP is one character for the backend
    expect(markedChars('a😀b', [2])).toEqual([
      ['a😀', false],
      ['b', true],
    ]);
  });
});
