import { StructPlan, TableDef } from '../../core/structure/structure-api';
import {
  addCheck,
  addColumn,
  addIndex,
  addKey,
  editableSource,
  emptyTable,
  fromTable,
  hasDanger,
  joinNames,
  moveColumn,
  operations,
  problemOf,
  removeRow,
  renamesOf,
  requestOf,
  scriptOf,
  setColumn,
  splitNames,
  statementsOf,
  toTable,
  typeSuggestions,
} from './structure-logic';

const ORDERS: TableDef = {
  name: 'orders',
  columns: [
    { name: 'id', typeName: 'integer', nullable: false, default: null },
    { name: 'customer_id', typeName: 'integer', nullable: false, default: null },
    { name: 'note', typeName: 'varchar(40)', nullable: true, default: "'none'" },
  ],
  pk: ['id'],
  indexes: [
    {
      name: 'orders_note',
      unique: false,
      columns: ['note'],
      definition: 'CREATE INDEX orders_note ON shop.orders USING btree (note)',
    },
    {
      name: 'orders_lower',
      unique: false,
      columns: [],
      definition: 'CREATE INDEX orders_lower ON shop.orders USING btree (lower(note))',
    },
  ],
  keys: [
    {
      name: 'orders_customer',
      columns: ['customer_id'],
      refSchema: '',
      refTable: 'customers',
      refColumns: ['id'],
    },
  ],
  checks: [{ name: 'orders_note_len', text: 'CHECK ((length(note) > 0))' }],
  comment: null,
  definition: null,
};

describe('structure logic', () => {
  it('splits and joins lists of names', () => {
    expect(splitNames('a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(splitNames('a, "b, c", d')).toEqual(['a', 'b, c', 'd']);
    expect(splitNames(' , ')).toEqual([]);
    expect(joinNames(['a', 'b, c', ' d'])).toBe('a, "b, c", " d"');
    expect(splitNames(joinNames(['x y', 'a,b']))).toEqual(['x y', 'a,b']);
  });

  it('a table that was read and not touched goes back as it was read', () => {
    const edited = fromTable(ORDERS);
    expect(toTable(edited, ORDERS)).toEqual(ORDERS);
    // the same objects: an index of PostgreSQL keeps its statement
    expect(toTable(edited, ORDERS).indexes[0]).toBe(ORDERS.indexes[0]);
    expect(operations(ORDERS, edited)).toEqual([]);
    expect(renamesOf(edited)).toEqual([]);
    expect(problemOf(edited)).toBeNull();
  });

  it('lists what changed', () => {
    let t = fromTable(ORDERS);
    const note = t.columns[2].id;
    t = setColumn(t, note, {
      name: 'remark',
      typeName: 'varchar(10)',
      nullable: false,
      default: '',
    });
    t = addColumn(t);
    t = setColumn(t, t.columns.at(-1)!.id, { name: 'placed', typeName: 'date' });
    t = removeRow(t, t.columns[1].id);
    t = removeRow(t, t.keys[0].id);
    t = { ...t, name: 'bestellungen' };
    const ops = operations(ORDERS, t).map((o) => [o.kind, o.name, o.detail]);
    expect(ops).toEqual([
      ['renameTable', 'orders', 'bestellungen'],
      ['renameColumn', 'note', 'remark'],
      ['changeColumn', 'remark', 'varchar(40) → varchar(10), NOT NULL, DROP DEFAULT'],
      ['addColumn', 'placed', 'date'],
      ['dropColumn', 'customer_id', ''],
      // the index names the column: it follows the new name, and is the same index
      ['dropForeignKey', 'orders_customer', ''],
    ]);
    expect(renamesOf(t)).toEqual([{ from: 'note', to: 'remark' }]);
    // an index on a renamed column stays the index it was (its statement goes with it)
    expect(t.indexes[0].columns).toBe('remark');
    expect(toTable(t, ORDERS).indexes[0]).toEqual({ ...ORDERS.indexes[0], columns: ['remark'] });
  });

  it('a renamed column is followed by the indexes and keys that name it', () => {
    let t = fromTable(ORDERS);
    t = setColumn(t, t.columns[1].id, { name: 'kunde' });
    expect(t.keys[0].columns).toBe('kunde');
    const after = toTable(t, ORDERS);
    expect(after.keys[0].columns).toEqual(['kunde']);
    // typing a name letter by letter does not lose the reference
    t = setColumn(t, t.columns[1].id, { name: 'kunden_id' });
    expect(t.keys[0].columns).toBe('kunden_id');
  });

  it('an index that was edited has no statement of the database any more', () => {
    let t = fromTable(ORDERS);
    t = { ...t, indexes: t.indexes.map((i, n) => (n === 0 ? { ...i, unique: true } : i)) };
    const after = toTable(t, ORDERS);
    expect(after.indexes[0]).toEqual({
      name: 'orders_note',
      unique: true,
      columns: ['note'],
      definition: null,
    });
    // the one that is only a statement goes back untouched
    expect(after.indexes[1]).toBe(ORDERS.indexes[1]);
    expect(operations(ORDERS, t).map((o) => [o.kind, o.name, o.detail])).toEqual([
      ['changeIndex', 'orders_note', 'UNIQUE (note)'],
    ]);
  });

  it('adds indexes, keys and checks', () => {
    let t = fromTable(ORDERS);
    t = addIndex(t);
    t = {
      ...t,
      indexes: t.indexes.map((i) => (i.was ? i : { ...i, name: 'ix', columns: 'id, note' })),
    };
    t = addKey(t);
    t = {
      ...t,
      keys: t.keys.map((k) =>
        k.was ? k : { ...k, name: 'fk', columns: 'id', refTable: 'crm.people', refColumns: 'pid' },
      ),
    };
    t = addCheck(t);
    t = { ...t, checks: t.checks.map((c) => (c.was ? c : { ...c, name: 'ck', text: 'id > 0' })) };
    const after = toTable(t, ORDERS);
    expect(after.indexes.at(-1)).toEqual({
      name: 'ix',
      unique: false,
      columns: ['id', 'note'],
      definition: null,
    });
    expect(after.keys.at(-1)).toEqual({
      name: 'fk',
      columns: ['id'],
      refSchema: 'crm',
      refTable: 'people',
      refColumns: ['pid'],
    });
    expect(operations(ORDERS, t).map((o) => o.kind)).toEqual([
      'addIndex',
      'addForeignKey',
      'addCheck',
    ]);
    expect(problemOf(t)).toBeNull();
  });

  it('a key column is never nullable, and the key is told as a change', () => {
    let t = fromTable(ORDERS);
    t = setColumn(t, t.columns[2].id, { pk: true });
    const after = toTable(t, ORDERS);
    expect(after.pk).toEqual(['id', 'note']);
    expect(after.columns[2].nullable).toBe(false);
    expect(operations(ORDERS, t).map((o) => o.kind)).toEqual(['changeColumn', 'changeKey']);
  });

  it('leaves a key column as it was read (review 043, L12)', () => {
    // SQLite reads `id INTEGER PRIMARY KEY` as nullable
    const lite: TableDef = {
      ...ORDERS,
      columns: [{ ...ORDERS.columns[0], nullable: true }, ...ORDERS.columns.slice(1)],
    };
    expect(toTable(fromTable(lite), lite)).toEqual(lite);
    expect(operations(lite, fromTable(lite))).toEqual([]);
  });

  it('starts a new table with a key column and asks to create it', () => {
    const t = { ...emptyTable('postgres'), name: 'neu' };
    expect(toTable(t, null)).toMatchObject({
      name: 'neu',
      columns: [{ name: 'id', typeName: 'integer', nullable: false, default: null }],
      pk: ['id'],
    });
    expect(operations(null, t)).toEqual([{ kind: 'createTable', name: 'neu', detail: '' }]);
    expect(requestOf('shop', null, t)).toMatchObject({
      kind: 'change',
      schema: 'shop',
      before: null,
      renames: [],
    });
    expect(emptyTable('sqlite').columns[0].typeName).toBe('INTEGER');
    expect(emptyTable('mysql').columns[0].typeName).toBe('int');
  });

  it('moves the columns of a new table', () => {
    let t = addColumn(addColumn(emptyTable('postgres')));
    const [a, b, c] = t.columns.map((x) => x.id);
    t = moveColumn(t, c, -1);
    expect(t.columns.map((x) => x.id)).toEqual([a, c, b]);
    expect(moveColumn(t, a, -1)).toBe(t);
    expect(moveColumn(t, b, 1)).toBe(t);
  });

  it('says what keeps a table from being written', () => {
    const base = fromTable(ORDERS);
    const cases: [string, (t: typeof base) => typeof base][] = [
      ['noName', (t) => ({ ...t, name: '  ' })],
      ['noColumns', (t) => ({ ...t, columns: [] })],
      ['columnNoName', (t) => setColumn(t, t.columns[0].id, { name: ' ' })],
      ['columnNoType', (t) => setColumn(t, t.columns[0].id, { typeName: '' })],
      [
        'duplicateColumn',
        (t) => setColumn(addColumn(t), t.nextId, { name: 'ID', typeName: 'int' }),
      ],
      [
        'indexNoColumns',
        (t) => {
          const added = addIndex(t);
          return {
            ...added,
            indexes: added.indexes.map((i) => (i.was ? i : { ...i, name: 'ix' })),
          };
        },
      ],
      ['unknownColumn', (t) => ({ ...t, indexes: [{ ...t.indexes[0], columns: 'gone' }] })],
      ['keyIncomplete', (t) => addKey(t)],
      ['keyIncomplete', (t) => ({ ...t, keys: [{ ...t.keys[0], refColumns: 'a, b' }] })],
      ['checkEmpty', (t) => addCheck(t)],
      ['partNoName', (t) => ({ ...t, indexes: [{ ...t.indexes[0], name: ' ' }] })],
      [
        'partNoName',
        (t) => {
          const added = addCheck(t);
          return { ...added, checks: added.checks.map((c) => ({ ...c, text: 'id > 0' })) };
        },
      ],
      ['lineBreak', (t) => setColumn(t, t.columns[0].id, { default: '1;\nDROP TABLE x' })],
    ];
    for (const [want, change] of cases) expect(problemOf(change(base)), want).toBe(want);
    // the index that is only a statement is no index without columns
    expect(problemOf(base)).toBeNull();
  });

  it('asks the backend with the table before and after, and the renames', () => {
    let t = fromTable(ORDERS);
    t = setColumn(t, t.columns[2].id, { name: 'remark' });
    const request = requestOf('shop', ORDERS, t);
    expect(request).toMatchObject({
      kind: 'change',
      schema: 'shop',
      before: ORDERS,
      renames: [{ from: 'note', to: 'remark' }],
    });
    if (request.kind !== 'change') throw new Error('kind');
    expect(request.after.columns[2].name).toBe('remark');
  });

  const PLAN: StructPlan = {
    steps: [
      { sql: 'ALTER TABLE t ADD COLUMN a int;', danger: null, note: null },
      { sql: 'ALTER TABLE t DROP COLUMN b;', danger: 'the column and its values go', note: null },
      { sql: '', danger: null, note: 'SQLite cannot change the type of a column' },
    ],
    transactional: true,
    incomplete: false,
  };

  it('reads a plan', () => {
    expect(statementsOf(PLAN)).toEqual([
      'ALTER TABLE t ADD COLUMN a int;',
      'ALTER TABLE t DROP COLUMN b;',
    ]);
    expect(hasDanger(PLAN)).toBe(true);
    expect(hasDanger({ ...PLAN, steps: PLAN.steps.slice(0, 1) })).toBe(false);
  });

  it('writes a plan as a script with the dangerous steps as comments', () => {
    expect(scriptOf(PLAN, 'Struktur von t\n– Vorschlag')).toBe(
      [
        '-- Struktur von t – Vorschlag',
        '',
        'ALTER TABLE t ADD COLUMN a int;',
        '-- the column and its values go:',
        '-- DANGER: ALTER TABLE t DROP COLUMN b;',
        '-- SQLite cannot change the type of a column',
        '',
      ].join('\n'),
    );
  });

  it('proposes types by dialect', () => {
    expect(typeSuggestions('postgres')).toContain('timestamptz');
    expect(typeSuggestions('mysql')).toContain('datetime');
    expect(typeSuggestions('sqlserver')).toContain('nvarchar(max)');
    expect(typeSuggestions('sqlite')).toEqual(['INTEGER', 'REAL', 'NUMERIC', 'TEXT', 'BLOB']);
  });

  it('makes the definition of a view or routine a statement that replaces it', () => {
    expect(editableSource('postgres', 'CREATE VIEW v AS SELECT 1')).toEqual({
      text: 'CREATE OR REPLACE VIEW v AS SELECT 1',
      replaces: true,
    });
    expect(editableSource('postgres', 'CREATE OR REPLACE FUNCTION f() …').replaces).toBe(true);
    expect(editableSource('postgres', 'CREATE OR REPLACE FUNCTION f() …').text).toBe(
      'CREATE OR REPLACE FUNCTION f() …',
    );
    expect(editableSource('sqlserver', '-- note\nCREATE PROCEDURE p AS SELECT 1').text).toBe(
      '-- note\nCREATE OR ALTER PROCEDURE p AS SELECT 1',
    );
    expect(editableSource('mysql', 'CREATE VIEW v AS SELECT 1').text).toBe(
      'CREATE OR REPLACE VIEW v AS SELECT 1',
    );
    // what the dialect cannot replace stays as it is
    expect(editableSource('mysql', 'CREATE PROCEDURE p() SELECT 1')).toEqual({
      text: 'CREATE PROCEDURE p() SELECT 1',
      replaces: false,
    });
    expect(editableSource('sqlite', 'CREATE VIEW v AS SELECT 1').replaces).toBe(false);
    expect(editableSource('postgres', 'CREATE MATERIALIZED VIEW m AS SELECT 1').replaces).toBe(
      false,
    );
  });
});
