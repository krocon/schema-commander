import { describe, expect, it } from 'vitest';
import { ForeignKey, TableRelations } from '../../core/schema/schema.models';
import { QueryColumn, RowWindow } from '../../core/sql/query.models';
import {
  EMPTY_NAV,
  MAX_KEY_ROWS,
  canBack,
  canForward,
  keyLabel,
  keyValues,
  keysOfColumn,
  linkColumns,
  navGo,
  navPush,
  navReplace,
  readVirtual,
  relatedView,
  singleKeyText,
  suggestTargets,
  withVirtual,
} from './relation-logic';

const col = (name: string, kind: QueryColumn['kind'] = 'int', typeName = 'int4'): QueryColumn => ({
  name,
  kind,
  typeName,
});
const fk = (
  table: string,
  columns: string[],
  refTable: string,
  refColumns: string[],
  more: Partial<ForeignKey> = {},
): ForeignKey => ({
  name: `${table}_${columns.join('_')}`,
  schema: 'shop',
  table,
  columns,
  refSchema: 'shop',
  refTable,
  refColumns,
  ...more,
});

const ORDERS = [col('id'), col('customer_id'), col('warehouse'), col('item', 'text', 'varchar')];
const CUSTOMER = fk('orders', ['customer_id'], 'customer', ['id']);
const STOCK = fk('orders', ['warehouse', 'item'], 'stock', ['wh', 'code']);
const RELATIONS: TableRelations = { outgoing: [STOCK, CUSTOMER], incoming: [] };

describe('relation-logic', () => {
  it('knows which cells are links and which key a column belongs to', () => {
    expect([...linkColumns(RELATIONS, ORDERS)].sort()).toEqual([1, 2, 3]);
    // a key whose columns are not all in the result is none to follow
    expect([...linkColumns(RELATIONS, ORDERS.slice(0, 3))]).toEqual([1]);
    expect(linkColumns(undefined, ORDERS).size).toBe(0);
    expect(keysOfColumn(RELATIONS, 'CUSTOMER_ID')).toEqual([CUSTOMER]);
    expect(keysOfColumn(RELATIONS, 'item')).toEqual([STOCK]);
    expect(keysOfColumn(RELATIONS, 'id')).toEqual([]);
  });

  it('takes the key of the marked rows: each once, none with NULL, typed like its column', () => {
    const rows: RowWindow = [
      [1, 42, 1, 'A'],
      [2, 42, 1, 'A'],
      [3, null, 2, 'B'],
      [4, 7, 2, null],
      [5, '9007199254740993', 3, 'C'],
    ];
    const single = keyValues(rows, ORDERS, ['customer_id'], ['id']);
    expect(single.keys).toEqual({
      columns: [{ column: 'id', kind: 'number', typeName: 'int4' }],
      rows: [['42'], ['7'], ['9007199254740993']],
    });
    expect(single).toMatchObject({ nulls: 1, cut: false });
    // a composite key: a row with NULL in any part references nothing
    const pair = keyValues(rows, ORDERS, ['warehouse', 'item'], ['wh', 'code']);
    expect(pair.keys?.rows).toEqual([
      ['1', 'A'],
      ['2', 'B'],
      ['3', 'C'],
    ]);
    expect(pair.keys?.columns[1]).toEqual({ column: 'code', kind: 'text', typeName: 'varchar' });
    expect(pair.nulls).toBe(1);
    // a column that is not in the result: no key
    expect(keyValues(rows, ORDERS, ['nope'], ['id']).keys).toBeNull();
    // binary data is no key value
    expect(keyValues([[{ bytes: 2, hex: 'ff00' }]], [col('id')], ['id'], ['id'])).toMatchObject({
      nulls: 1,
      keys: { rows: [] },
    });
  });

  it('takes no text as a key that the window may have cut (review 030)', () => {
    // rows of a result carry long texts cut: such a value is not the key, so it is not followed
    const long = `${'x'.repeat(1000)}…`;
    const values = keyValues(
      [[long], ['short'], ['y'.repeat(999)]],
      [col('code', 'text', 'text')],
      ['code'],
      ['code'],
    );
    expect(values.keys?.rows.map((r) => r[0].length)).toEqual([5, 999]);
    expect(values).toMatchObject({ long: 1, nulls: 0 });
  });

  it('cuts a key at what a statement takes and says so', () => {
    const rows = Array.from({ length: MAX_KEY_ROWS + 5 }, (_, i) => [i]);
    const many = keyValues(rows, [col('id')], ['id'], ['id']);
    expect(many.keys?.rows).toHaveLength(MAX_KEY_ROWS);
    expect(many.cut).toBe(true);
    // three columns: 2000 values are 666 rows
    const wide = Array.from({ length: 700 }, (_, i) => [i, i, i]);
    const three = [col('a'), col('b'), col('c')];
    expect(keyValues(wide, three, ['a', 'b', 'c'], ['x', 'y', 'z']).keys?.rows).toHaveLength(666);
  });

  it('builds the view of the relatives, forward and backward, also to the table itself', () => {
    const forward = relatedView(CUSTOMER, 'forward', [[1, 42, 1, 'A']], ORDERS);
    expect(forward.view).toMatchObject({
      schema: 'shop',
      table: 'customer',
      spec: { conditions: [], limit: 1000, keys: { rows: [['42']] } },
    });
    // backward: the rows of orders that point to customer 42
    const customers = [col('id'), col('name', 'text', 'text')];
    const backward = relatedView(CUSTOMER, 'backward', [[42, 'Ada']], customers);
    expect(backward.view).toMatchObject({
      table: 'orders',
      spec: { keys: { columns: [{ column: 'customer_id' }], rows: [['42']] } },
    });
    // a tree: the boss of a person, and the people of a boss – the same table both ways
    const boss = fk('person', ['boss_id'], 'person', ['id']);
    const people = [col('id'), col('boss_id')];
    expect(relatedView(boss, 'forward', [[3, 1]], people).view?.spec.keys).toMatchObject({
      columns: [{ column: 'id' }],
      rows: [['1']],
    });
    expect(relatedView(boss, 'backward', [[3, 1]], people).view?.spec.keys).toMatchObject({
      columns: [{ column: 'boss_id' }],
      rows: [['3']],
    });
    // the top of the tree has no boss: nothing to follow
    expect(relatedView(boss, 'forward', [[1, null]], people)).toMatchObject({
      view: null,
      values: { nulls: 1 },
    });
  });

  it('names a key for a list and a single key for the filter row', () => {
    expect(keyLabel(CUSTOMER, 'forward', 'shop')).toBe('customer (id)');
    expect(keyLabel(CUSTOMER, 'backward', 'shop')).toBe('orders (customer_id)');
    expect(
      keyLabel(fk('orders', ['c'], 'country', ['code'], { refSchema: 'geo' }), 'forward', 'shop'),
    ).toBe('geo.country (code)');
    expect(
      singleKeyText({ columns: [{ column: 'id', kind: 'number', typeName: '' }], rows: [['42']] }),
    ).toBe('id = 42');
    expect(
      singleKeyText({
        columns: [{ column: 'id', kind: 'number', typeName: '' }],
        rows: [['1'], ['2']],
      }),
    ).toBeNull();
  });

  it('adds the relations of the user to those of the catalog, each once', () => {
    const own = [
      fk('orders', ['note_id'], 'note', ['id'], { name: '' }),
      fk('orders', ['customer_id'], 'customer', ['id'], { name: '' }),
      fk('audit', ['order_id'], 'orders', ['id'], { name: '' }),
      fk('other', ['x'], 'y', ['id'], { name: '' }),
    ];
    const merged = withVirtual(RELATIONS, own, 'shop', 'ORDERS');
    expect(merged.outgoing.map((k) => k.refTable)).toEqual(['stock', 'customer', 'note']);
    expect(merged.incoming.map((k) => k.table)).toEqual(['audit']);
  });

  it('keeps the path like a browser: on, back, forward, and on again drops what lay ahead', () => {
    const view = (table: string) => ({
      schema: 'shop',
      table,
      spec: { conditions: [], any: false, whereSql: '', order: [], limit: 1000 },
    });
    const entry = (table: string) => ({ view: view(table), title: table });
    let nav = navPush(EMPTY_NAV, entry('orders'));
    expect(canBack(nav) || canForward(nav)).toBe(false);
    nav = navPush(navPush(nav, entry('customer')), entry('country'));
    expect(nav.entries.map((e) => e.title)).toEqual(['orders', 'customer', 'country']);
    nav = navGo(nav, 0);
    expect([canBack(nav), canForward(nav)]).toEqual([false, true]);
    nav = navPush(nav, entry('stock'));
    expect(nav.entries.map((e) => e.title)).toEqual(['orders', 'stock']);
    expect(navGo(nav, 7)).toBe(nav);
    // the filter of the place changes: the path remembers it; another table ends the walk
    const filtered = { ...view('stock'), spec: { ...view('stock').spec, whereSql: 'qty > 0' } };
    expect(navReplace(nav, filtered).entries[1].view.spec.whereSql).toBe('qty > 0');
    expect(navReplace(nav, view('elsewhere'))).toEqual(EMPTY_NAV);
    let long = EMPTY_NAV;
    for (let i = 0; i < 60; i++) long = navPush(long, entry(`t${i}`));
    expect(long.entries).toHaveLength(50);
    expect(long.index).toBe(49);
  });

  it('reads stored relations and leaves out what is none', () => {
    expect(readVirtual('x')).toEqual([]);
    expect(
      readVirtual([
        {
          schema: 'shop',
          table: 'orders',
          columns: ['a'],
          refSchema: 'shop',
          refTable: 'x',
          refColumns: ['id'],
        },
        { table: 'orders', columns: ['a', 'b'], refTable: 'x', refColumns: ['id'] },
        { table: 'orders', columns: [], refTable: 'x', refColumns: [] },
        { table: 'orders', columns: [1], refTable: 'x', refColumns: ['id'] },
        null,
      ]),
    ).toEqual([
      {
        name: '',
        schema: 'shop',
        table: 'orders',
        columns: ['a'],
        refSchema: 'shop',
        refTable: 'x',
        refColumns: ['id'],
      },
    ]);
  });

  it('offers targets from the name of a column', () => {
    expect(suggestTargets('customer_id')).toEqual([
      { table: 'customer', column: 'id' },
      { table: 'customers', column: 'id' },
    ]);
    expect(suggestTargets('countryCode')).toEqual([
      { table: 'country', column: 'code' },
      { table: 'countries', column: 'code' },
    ]);
    expect(suggestTargets('id')).toEqual([]);
    expect(suggestTargets('name')).toEqual([]);
  });
});
