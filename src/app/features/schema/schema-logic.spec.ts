import { ColumnInfo, ObjectInfo, SchemaInfo, TableInfo } from '../../core/schema/schema.models';
import {
  EMPTY_STATE,
  SchemaState,
  TreeRow,
  changesSchema,
  flatten,
  groupId,
  insertSnippet,
  keyMove,
  matches,
  objectId,
  qualifiedName,
  rowEstimate,
  schemaId,
  selectTemplate,
  snippetText,
  tableKey,
  updateSnippet,
} from './schema-logic';

const PUBLIC: SchemaInfo = { name: 'public', quoted: 'public', system: false, current: true };
const ARCHIVE: SchemaInfo = { name: 'archive', quoted: 'archive', system: false, current: false };
const CATALOG: SchemaInfo = {
  name: 'pg_catalog',
  quoted: 'pg_catalog',
  system: true,
  current: false,
};

const table = (name: string, rows: number | null = null): ObjectInfo => ({
  kind: 'table',
  name,
  quoted: /^[a-z_]+$/.test(name) ? name : `"${name}"`,
  detail: '',
  rows,
});
const OBJECTS: ObjectInfo[] = [
  table('customer', 1200),
  table('orders', 2_500_000),
  { kind: 'view', name: 'big_orders', quoted: 'big_orders', detail: '', rows: null },
  { kind: 'routine', name: 'twice', quoted: 'twice', detail: 'n integer', rows: null },
];
const col = (name: string, key = '', nullable = true): ColumnInfo => ({
  name,
  quoted: /^[a-z_]+$/.test(name) ? name : `"${name}"`,
  typeName: 'integer',
  nullable,
  default: null,
  key,
});
const ORDERS: TableInfo = {
  columns: [col('id', 'pk', false), col('customer_id', 'fk', false), col('note')],
  indexes: [{ name: 'orders_pkey', detail: 'primary btree (id)' }],
  keys: [],
  triggers: [],
};

function state(over: Partial<SchemaState> = {}): SchemaState {
  return {
    ...EMPTY_STATE,
    schemas: { state: 'ready', value: [ARCHIVE, CATALOG, PUBLIC] },
    ...over,
  };
}

const labels = (rows: readonly TreeRow[]) =>
  rows.map((r) => `${'  '.repeat(r.level - 1)}${r.label}`);

describe('flatten', () => {
  it('shows nothing before the schemas are asked for, then a note, then the schemas', () => {
    expect(flatten(EMPTY_STATE, false)).toEqual([]);
    expect(labels(flatten({ ...EMPTY_STATE, schemas: { state: 'loading' } }, false))).toEqual([
      'Lädt …',
    ]);
    const failed = flatten(
      { ...EMPTY_STATE, schemas: { state: 'error', message: 'kein Recht' } },
      false,
    );
    expect(failed[0].error).toBe(true);
    expect(labels(flatten(state(), false))).toEqual(['archive', 'public']);
  });

  it('hides the schemas of the database unless asked for', () => {
    expect(labels(flatten(state(), true))).toEqual(['archive', 'pg_catalog', 'public']);
  });

  it('opens a schema into its sorts and a sort into its objects', () => {
    const open = state({
      objects: { public: { state: 'ready', value: OBJECTS } },
      expanded: new Set([schemaId('public'), groupId('public', 'table')]),
    });
    const rows = flatten(open, false);
    expect(labels(rows)).toEqual([
      'archive',
      'public',
      '  Tabellen',
      '    customer',
      '    orders',
      '  Views',
      '  Routinen',
    ]);
    const tables = rows[2];
    expect(tables.detail).toBe('2');
    expect(tables.expanded).toBe(true);
    expect(rows[3].detail).toBe('~1,2k');
    expect(rows[3].expandable).toBe(true);
    expect(rows[5].expanded).toBe(false);
  });

  it('says so while a schema loads, when it fails and when it is empty', () => {
    const base = { expanded: new Set([schemaId('public')]) };
    expect(labels(flatten(state(base), false))[2]).toBe('  Lädt …');
    const failed = flatten(
      state({ ...base, objects: { public: { state: 'error', message: 'Zugriff verweigert' } } }),
      false,
    );
    expect(failed[2].label).toBe('Zugriff verweigert');
    expect(failed[2].error).toBe(true);
    // the rest of the tree stays
    expect(failed[0].label).toBe('archive');
    expect(
      labels(
        flatten(state({ ...base, objects: { public: { state: 'ready', value: [] } } }), false),
      )[2],
    ).toBe('  leer');
  });

  it('opens a table into columns and the parts it has', () => {
    const open = state({
      objects: { public: { state: 'ready', value: OBJECTS } },
      tables: { [tableKey('public', 'orders')]: { state: 'ready', value: ORDERS } },
      expanded: new Set([
        schemaId('public'),
        groupId('public', 'table'),
        objectId('public', OBJECTS[1]),
      ]),
    });
    const rows = flatten(open, false);
    const from = rows.findIndex((r) => r.label === 'orders');
    expect(labels(rows.slice(from, from + 6))).toEqual([
      '    orders',
      '      id',
      '      customer_id',
      '      note',
      '      Indizes',
      '        orders_pkey',
    ]);
    expect(rows[from + 1].detail).toBe('integer not null');
    expect(rows[from + 1].tone).toBe('st-pk');
    expect(rows[from + 3].detail).toBe('integer');
    // no keys, no triggers: no heading for them
    expect(rows.some((r) => r.label === 'Trigger')).toBe(false);
  });

  it('gives every row an id of its own', () => {
    const open = state({
      objects: {
        public: {
          state: 'ready',
          value: [
            ...OBJECTS,
            { kind: 'routine', name: 'twice', quoted: 'twice', detail: 'n bigint', rows: null },
          ],
        },
      },
      tables: { [tableKey('public', 'orders')]: { state: 'ready', value: ORDERS } },
      expanded: new Set([
        schemaId('public'),
        groupId('public', 'table'),
        groupId('public', 'routine'),
        objectId('public', OBJECTS[1]),
      ]),
    });
    const ids = flatten(open, false).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('filters what is loaded, with its parents, whatever is open', () => {
    const loaded = state({ objects: { public: { state: 'ready', value: OBJECTS } } });
    expect(labels(flatten(loaded, false, 'ORD'))).toEqual([
      'public',
      '  Tabellen',
      '    orders',
      '  Views',
      '    big_orders',
    ]);
    expect(labels(flatten(loaded, false, 'zzz'))).toEqual(['Nichts gefunden.']);
  });

  it('shows the hits of the server for schemas that were never opened', () => {
    const found = state({
      objects: { public: { state: 'ready', value: OBJECTS } },
      found: [{ schema: 'archive', kind: 'table', name: 'Old Orders', quoted: '"Old Orders"' }],
      foundFor: 'ord',
    });
    expect(labels(flatten(found, false, 'ord'))).toEqual([
      'archive',
      '  Tabellen',
      '    Old Orders',
      'public',
      '  Tabellen',
      '    orders',
      '  Views',
      '    big_orders',
    ]);
    // hits for another text are not shown
    expect(labels(flatten(found, false, 'orde'))[0]).toBe('public');
  });

  it('flattens 50 000 tables fast', () => {
    const many = Array.from({ length: 50_000 }, (_, i) => table(`t_${i}`));
    const big = state({
      objects: { public: { state: 'ready', value: many } },
      expanded: new Set([schemaId('public'), groupId('public', 'table')]),
    });
    const started = performance.now();
    expect(flatten(big, false)).toHaveLength(50_003);
    // the name itself, the names that hold it, and the ones with its letters in this order
    const hits = flatten(big, false, 't_4999');
    expect(hits.some((r) => r.label === 't_4999')).toBe(true);
    expect(hits.length).toBeLessThan(100);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('matches', () => {
  it('finds a part and letters in their order', () => {
    expect(matches('ord', 'big_orders')).toBe(true);
    expect(matches('bgo', 'big_orders')).toBe(true);
    expect(matches('gb', 'big_orders')).toBe(false);
    expect(matches('', 'x')).toBe(true);
  });
});

describe('rowEstimate', () => {
  it('rounds for the eye', () => {
    expect(rowEstimate(null)).toBe('');
    expect(rowEstimate(0)).toBe('~0');
    expect(rowEstimate(999)).toBe('~999');
    expect(rowEstimate(1234)).toBe('~1,2k');
    expect(rowEstimate(2_540_000)).toBe('~2,5 Mio.');
  });
});

describe('keyMove', () => {
  const rows = flatten(
    state({
      objects: { public: { state: 'ready', value: OBJECTS } },
      expanded: new Set([schemaId('public'), groupId('public', 'table')]),
    }),
    false,
  );
  // archive, public, Tabellen, customer, orders, Views, Routinen

  it('moves up and down and stops at the ends', () => {
    expect(keyMove(rows, 0, 'ArrowDown')).toEqual({ to: 1 });
    expect(keyMove(rows, 0, 'ArrowUp')).toEqual({ to: 0 });
    expect(keyMove(rows, 6, 'ArrowDown')).toEqual({ to: 6 });
    expect(keyMove(rows, 3, 'Home')).toEqual({ to: 0 });
    expect(keyMove(rows, 3, 'End')).toEqual({ to: 6 });
  });

  it('opens with the right arrow, then goes to the first child', () => {
    expect(keyMove(rows, 0, 'ArrowRight')).toEqual({ toggle: schemaId('archive') });
    expect(keyMove(rows, 1, 'ArrowRight')).toEqual({ to: 2 });
    expect(keyMove(rows, 6, 'ArrowRight')).toEqual({ toggle: groupId('public', 'routine') });
  });

  it('closes with the left arrow, or goes to the parent', () => {
    expect(keyMove(rows, 2, 'ArrowLeft')).toEqual({ toggle: groupId('public', 'table') });
    expect(keyMove(rows, 4, 'ArrowLeft')).toEqual({ to: 2 });
    expect(keyMove(rows, 5, 'ArrowLeft')).toEqual({ to: 1 });
    expect(keyMove(rows, 0, 'ArrowLeft')).toBeNull();
  });

  it('opens the row with Enter and leaves other keys alone', () => {
    expect(keyMove(rows, 3, 'Enter')).toEqual({ open: 3 });
    expect(keyMove(rows, 3, 'a')).toBeNull();
    expect(keyMove([], 0, 'ArrowDown')).toBeNull();
  });
});

describe('names and templates', () => {
  it('leaves the schema out where it is the current one', () => {
    expect(qualifiedName(PUBLIC, table('orders'))).toBe('orders');
    expect(qualifiedName(ARCHIVE, table('Old Orders'))).toBe('archive."Old Orders"');
  });

  it('selects the first rows in the dialect', () => {
    expect(selectTemplate('postgres', 'orders')).toBe('SELECT *\nFROM orders\nLIMIT 200;');
    expect(selectTemplate('sqlserver', '[my table]')).toBe('SELECT TOP 200 *\nFROM [my table];');
    expect(selectTemplate('mysql', 'orders', [col('id'), col('Größe')], 10)).toBe(
      'SELECT id, "Größe"\nFROM orders\nLIMIT 10;',
    );
  });

  it('writes INSERT and UPDATE with a placeholder per column', () => {
    expect(insertSnippet('orders', ORDERS.columns)).toBe(
      'INSERT INTO orders (id, customer_id, note)\nVALUES (${1:id}, ${2:customer_id}, ${3:note});$0',
    );
    expect(updateSnippet('orders', ORDERS.columns)).toBe(
      'UPDATE orders\nSET customer_id = ${1:customer_id},\n    note = ${2:note}\nWHERE id = ${3:id};$0',
    );
    expect(updateSnippet('t', [col('a')])).toBe(
      'UPDATE t\nSET a = ${1:a}\nWHERE ${2:bedingung};$0',
    );
  });

  it('keeps the signs of a snippet out of names', () => {
    expect(snippetText('a$b}c\\d')).toBe('a\\$b\\}c\\\\d');
    expect(insertSnippet('"pri$e"', [col('a}b')])).toBe(
      'INSERT INTO "pri\\$e" ("a\\}b")\nVALUES (${1:a\\}b});$0',
    );
  });
});

describe('changesSchema', () => {
  it('knows the statements after which the tree is read again', () => {
    for (const sql of [
      'CREATE TABLE t (a int)',
      '  drop view v',
      '-- note\nALTER TABLE t ADD b int',
      '/* x */ Rename TABLE a TO b',
      'USE shop',
    ]) {
      expect(changesSchema(sql), sql).toBe(true);
    }
    for (const sql of ['SELECT 1', 'INSERT INTO created VALUES (1)', 'update t set a = 1', '']) {
      expect(changesSchema(sql), sql).toBe(false);
    }
  });
});
