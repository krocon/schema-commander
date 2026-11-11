import { QueryColumn } from '../../core/sql/query.models';
import {
  EMPTY_SPEC,
  conditionOf,
  draftOf,
  isFiltered,
  isLocal,
  queryOf,
  quickCondition,
  readSpec,
  remember,
  sortMarks,
  tableKey,
  toggleLocalSort,
  toggleServerOrder,
  withCondition,
} from './filter-logic';

const columns: QueryColumn[] = [
  { name: 'id', kind: 'int', typeName: 'INT4' },
  { name: 'name', kind: 'text', typeName: 'VARCHAR' },
  { name: 'paid', kind: 'bool', typeName: 'BOOL' },
  { name: 'at', kind: 'timestampTz', typeName: 'TIMESTAMPTZ' },
];
const draft = (column: string, op: string, text = '', upper = '') =>
  ({ column, op, text, upper }) as Parameters<typeof conditionOf>[0];

describe('conditions of a table view', () => {
  it('turns a row of the filter bar into a condition with the kind and type of its column', () => {
    expect(conditionOf(draft('id', 'eq', '42'), columns)).toEqual({
      column: 'id',
      op: 'eq',
      values: ['42'],
      kind: 'number',
      typeName: 'INT4',
    });
    expect(conditionOf(draft('name', 'in', 'a, b,,c '), columns)?.values).toEqual(['a', 'b', 'c']);
    expect(
      conditionOf(draft('at', 'between', '2026-01-01', '2026-12-31'), columns)?.values,
    ).toEqual(['2026-01-01', '2026-12-31']);
    expect(conditionOf(draft('paid', 'isNull', 'ignored'), columns)).toMatchObject({
      values: [],
      kind: 'bool',
    });
    // a value as typed – also one that looks like SQL: the backend binds it
    expect(conditionOf(draft('name', 'eq', "'; DROP TABLE x; --"), columns)?.values).toEqual([
      "'; DROP TABLE x; --",
    ]);
  });

  it('leaves out a row that is not complete, without calling it an error', () => {
    expect(conditionOf(draft('', 'eq', '1'), columns)).toBeNull();
    expect(conditionOf(draft('gone', 'eq', '1'), columns)).toBeNull();
    expect(conditionOf(draft('id', 'eq', ''), columns)).toBeNull();
    expect(conditionOf(draft('name', 'like', ''), columns)).toBeNull();
    expect(conditionOf(draft('id', 'between', '1', ''), columns)).toBeNull();
    expect(conditionOf(draft('name', 'in', ' , '), columns)).toBeNull();
    // an empty text is a value of a text column
    expect(conditionOf(draft('name', 'eq', ''), columns)?.values).toEqual(['']);
    expect(conditionOf(draft('name', 'ne', ''), columns)?.values).toEqual(['']);
  });

  it('shows a condition as it was typed', () => {
    const typed = [
      draft('name', 'in', 'a, b'),
      draft('at', 'between', '1', '2'),
      draft('id', 'gt', '5'),
    ];
    for (const d of typed) expect(draftOf(conditionOf(d, columns)!)).toEqual(d);
  });

  it('makes a condition of the cell under the cursor', () => {
    expect(quickCondition('eq', columns[0], '7')).toMatchObject({
      column: 'id',
      op: 'eq',
      values: ['7'],
    });
    expect(quickCondition('ne', columns[1], 'x')).toMatchObject({ op: 'ne', values: ['x'] });
    expect(quickCondition('gt', columns[0], '7')?.op).toBe('gt');
    expect(quickCondition('null', columns[0], '7')).toMatchObject({ op: 'isNull', values: [] });
    // a NULL cell: only this = IS NULL, without = IS NOT NULL, greater than nothing is nothing
    expect(quickCondition('eq', columns[0], null)?.op).toBe('isNull');
    expect(quickCondition('ne', columns[0], null)?.op).toBe('isNotNull');
    expect(quickCondition('lt', columns[0], null)).toBeNull();
  });

  it('adds a condition once and knows whether a view is filtered', () => {
    const c = quickCondition('eq', columns[0], '7')!;
    const once = withCondition(EMPTY_SPEC, c);
    expect(withCondition(once, c)).toBe(once);
    expect(once.conditions.length).toBe(1);
    expect(isFiltered(EMPTY_SPEC)).toBe(false);
    expect(isFiltered({ ...EMPTY_SPEC, limit: 200 })).toBe(false);
    expect(isFiltered(once)).toBe(true);
    expect(isFiltered({ ...EMPTY_SPEC, whereSql: ' a > 1 ' })).toBe(true);
    expect(queryOf({ schema: 'shop', table: 'orders', spec: { ...once, whereSql: '  ' } })).toEqual(
      {
        schema: 'shop',
        table: 'orders',
        conditions: [c],
        any: false,
        whereSql: null,
        order: [],
        limit: 1000,
      },
    );
  });
});

describe('sorting by a click on a head', () => {
  it('goes up, down and off; with the modifier the column joins the others', () => {
    let order = toggleServerOrder([], 'name', false);
    expect(order).toEqual([{ column: 'name', desc: false, nulls: null }]);
    order = toggleServerOrder(order, 'name', false);
    expect(order[0].desc).toBe(true);
    expect(toggleServerOrder(order, 'name', false)).toEqual([]);
    // another column alone replaces, with the modifier it is added
    expect(toggleServerOrder(order, 'id', false).map((o) => o.column)).toEqual(['id']);
    const both = toggleServerOrder(order, 'id', true);
    expect(both.map((o) => [o.column, o.desc])).toEqual([
      ['name', true],
      ['id', false],
    ]);
    expect(toggleServerOrder(both, 'name', true).map((o) => o.column)).toEqual(['id']);
    expect(toggleLocalSort(toggleLocalSort([], 2, false), 2, false)).toEqual([
      { column: 2, desc: true },
    ]);
  });

  it('marks the heads: the keys of the server by name, the local ones by index', () => {
    const server = [
      { column: 'at', desc: true, nulls: null },
      { column: 'gone', desc: false, nulls: null },
      { column: 'id', desc: false, nulls: null },
    ];
    expect(sortMarks(columns, server, [])).toEqual([
      { column: 3, desc: true, rank: 1 },
      { column: 0, desc: false, rank: 2 },
    ]);
    expect(sortMarks(columns, null, [{ column: 1, desc: false }])).toEqual([
      { column: 1, desc: false, rank: 0 },
    ]);
    expect(isLocal({ text: ' ', column: null, sort: [] })).toBe(false);
    expect(isLocal({ text: 'x', column: null, sort: [] })).toBe(true);
  });
});

describe('remembering the filter of a table', () => {
  const c = quickCondition('eq', columns[0], '7')!;
  const spec = withCondition(EMPTY_SPEC, c);

  it('keeps the latest in front and forgets a filter that filters nothing', () => {
    const key = tableKey('c1', { schema: 'shop', table: 'orders' });
    expect(key).toBe('c1|shop.orders');
    let all = remember({}, key, spec);
    all = remember(all, 'c1|.other', spec);
    expect(Object.keys(all)).toEqual(['c1|.other', key]);
    expect(Object.keys(remember(all, key, EMPTY_SPEC))).toEqual(['c1|.other']);
  });

  it('reads what was stored and drops what is none', () => {
    expect(readSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
    expect(readSpec(null)).toEqual(EMPTY_SPEC);
    expect(
      readSpec({
        conditions: [
          { column: 'a', op: 'drop table' },
          { column: 'b', op: 'in', values: ['x', 5] },
          7,
        ],
        order: [{ column: 'a', desc: 'yes', nulls: 'middle' }, {}],
        limit: -5,
        any: 'true',
        whereSql: 9,
      }),
    ).toEqual({
      conditions: [{ column: 'b', op: 'in', values: ['x'], kind: 'text', typeName: '' }],
      order: [{ column: 'a', desc: false, nulls: null }],
      limit: 1000,
      any: false,
      whereSql: '',
    });
    expect(readSpec({ limit: null }).limit).toBeNull();
  });
});
