import { describe, expect, it } from 'vitest';
import { ColumnInfo } from '../../core/schema/schema.models';
import { Cell, QueryColumn } from '../../core/sql/query.models';
import {
  EMPTY_BUFFER,
  NewValue,
  addRows,
  editCount,
  editability,
  invalidCells,
  marksOf,
  maxLength,
  pasteBlock,
  planOf,
  redoEdit,
  removeNewRows,
  resetRow,
  rowKey,
  setCell,
  setNewCell,
  startText,
  toggleDeleted,
  undoEdit,
  validate,
} from './edit-buffer';

const col = (name: string, kind: QueryColumn['kind'], typeName: string): QueryColumn => ({
  name,
  kind,
  typeName,
});
const COLUMNS = [
  col('id', 'int', 'int4'),
  col('name', 'text', 'varchar(10)'),
  col('price', 'float', 'float8'),
  col('note', 'text', 'text'),
];
const PK = [0];
const ROWS: Cell[][] = [
  [1, 'Ada', 1.5, null],
  [2, 'Bob', 2.5, 'x'],
];
const v = (text: string): NewValue => ({ kind: 'value', text });
const key = (row: number) => rowKey(ROWS[row], PK)!;
const edit = (b = EMPTY_BUFFER, row: number, column: number, value: NewValue | null) =>
  setCell(b, key(row), row, ROWS[row], column, value);

describe('edit-buffer', () => {
  it('knows a row by its key, and none without one', () => {
    expect(rowKey([7, 'x'], [0])).toBe('["7"]');
    expect(rowKey([1, 'A'], [0, 1])).toBe('["1","A"]');
    expect(rowKey([null, 'x'], [0])).toBeNull();
    expect(rowKey([{ bytes: 1, hex: 'ff' }], [0])).toBeNull();
    expect(rowKey([1], [])).toBeNull();
    // a text so long that the row may hold it cut is no key (review 031)
    expect(rowKey(['x'.repeat(1000)], [0])).toBeNull();
    expect(rowKey(['x'.repeat(999)], [0])).not.toBeNull();
  });

  it('collects changes per row and counts them', () => {
    let b = edit(EMPTY_BUFFER, 0, 1, v('Eve'));
    b = edit(b, 0, 3, v('hello'));
    b = edit(b, 1, 3, { kind: 'null' });
    expect(editCount(b)).toMatchObject({ cells: 3, rows: 2 });
    const marks = marksOf(b)!;
    expect(marks.at(0, 1)).toEqual(v('Eve'));
    expect(marks.at(1, 3)).toEqual({ kind: 'null' });
    expect(marks.at(1, 1)).toBeNull();
    expect(marksOf(EMPTY_BUFFER)).toBeNull();
  });

  it('takes a change away when the cell gets the value it had', () => {
    let b = edit(EMPTY_BUFFER, 0, 1, v('Eve'));
    b = edit(b, 0, 1, v('Ada'));
    expect(editCount(b)).toMatchObject({ cells: 0, rows: 0 });
    // NULL on a cell that is NULL, the same number as text
    expect(edit(EMPTY_BUFFER, 0, 3, { kind: 'null' })).toBe(EMPTY_BUFFER);
    expect(edit(EMPTY_BUFFER, 0, 0, v('1'))).toBe(EMPTY_BUFFER);
    // an empty text is not NULL, and DEFAULT is always a change
    expect(editCount(edit(EMPTY_BUFFER, 0, 3, v('')))).toMatchObject({ cells: 1, rows: 1 });
    expect(editCount(edit(EMPTY_BUFFER, 0, 1, { kind: 'default' })).cells).toBe(1);
  });

  it('undoes and redoes step by step, and a new change ends what could be redone', () => {
    let b = edit(EMPTY_BUFFER, 0, 1, v('Eve'));
    b = edit(b, 0, 1, v('Eva'));
    b = edit(b, 1, 3, { kind: 'null' });
    b = undoEdit(b);
    expect(marksOf(b)!.at(1, 3)).toBeNull();
    b = undoEdit(b);
    expect(marksOf(b)!.at(0, 1)).toEqual(v('Eve'));
    b = redoEdit(b);
    expect(marksOf(b)!.at(0, 1)).toEqual(v('Eva'));
    b = undoEdit(undoEdit(b));
    // discarding everything restores the start exactly
    expect(b.rows).toEqual({});
    expect(undoEdit(b)).toBe(b);
    b = redoEdit(b);
    b = edit(b, 0, 3, v('new'));
    expect(b.redo).toEqual([]);
    expect(redoEdit(b)).toBe(b);
  });

  it('resets a row as one step that can be undone', () => {
    let b = edit(EMPTY_BUFFER, 0, 1, v('Eve'));
    b = edit(b, 0, 3, v('n'));
    b = edit(b, 1, 1, v('Bo'));
    b = resetRow(b, key(0));
    expect(editCount(b)).toMatchObject({ cells: 1, rows: 1 });
    b = undoEdit(b);
    expect(editCount(b)).toMatchObject({ cells: 3, rows: 2 });
    expect(resetRow(b, 'nope')).toBe(b);
  });

  it('plans one update per row: found by the key, locked on what the cells were', () => {
    let b = edit(EMPTY_BUFFER, 1, 3, { kind: 'null' });
    b = edit(b, 0, 1, v("it's"));
    b = edit(b, 0, 2, v('9.5'));
    b = edit(b, 0, 3, { kind: 'default' });
    const { plan, keys } = planOf(b, COLUMNS, PK, true, 'shop', 'people');
    expect(keys).toEqual([key(0), key(1)]);
    expect(plan).toMatchObject({
      schema: 'shop',
      table: 'people',
      rows: [
        {
          key: [{ column: 'id', kind: 'number', typeName: 'int4', value: '1' }],
          set: [
            {
              column: 'name',
              kind: 'text',
              typeName: 'varchar(10)',
              value: "it's",
              default: false,
            },
            { column: 'price', kind: 'number', typeName: 'float8', value: '9.5', default: false },
            { column: 'note', kind: 'text', typeName: 'text', value: null, default: true },
          ],
          // a floating point number is no value to compare for equality; NULL is expected as NULL
          expect: [
            { column: 'name', kind: 'text', typeName: 'varchar(10)', value: 'Ada' },
            { column: 'note', kind: 'text', typeName: 'text', value: null },
          ],
        },
        {
          key: [{ column: 'id', kind: 'number', typeName: 'int4', value: '2' }],
          set: [{ column: 'note', kind: 'text', typeName: 'text', value: null, default: false }],
          expect: [{ column: 'note', kind: 'text', typeName: 'text', value: 'x' }],
        },
      ],
    });
    expect(
      planOf(b, COLUMNS, PK, false, null, 't').plan.rows.every((r) => r.expect.length === 0),
    ).toBe(true);
  });

  it('does not lock on a text that may be cut, nor on binary data', () => {
    const long: Cell[] = [1, `${'x'.repeat(1000)}…`, 1, { bytes: 3, hex: 'ffffff' }];
    let b = setCell(EMPTY_BUFFER, '["1"]', 0, long, 1, v('short'));
    b = setCell(b, '["1"]', 0, long, 3, { kind: 'null' });
    expect(planOf(b, COLUMNS, PK, true, null, 't').plan.rows[0].expect).toEqual([]);
    // and typing the cut text again is a change, not „the same“
    expect(editCount(setCell(EMPTY_BUFFER, '["1"]', 0, long, 1, v(long[1] as string))).cells).toBe(
      1,
    );
  });

  it('does not lock on types the database cannot compare (review 031)', () => {
    const cols = [
      col('id', 'int', 'int4'),
      col('doc', 'other', 'JSON'),
      col('body', 'text', 'Text'),
    ];
    const row: Cell[] = [1, '{"a":1}', 'long text'];
    let b = setCell(EMPTY_BUFFER, '["1"]', 0, row, 1, v('{}'));
    b = setCell(b, '["1"]', 0, row, 2, v('new'));
    const expectOn = (dialect: 'postgres' | 'mysql' | 'sqlserver' | 'sqlite') =>
      planOf(b, cols, PK, true, null, 't', dialect).plan.rows[0].expect.map((c) => c.column);
    expect(expectOn('postgres')).toEqual(['body']);
    expect(expectOn('mysql')).toEqual(['body']);
    // SQL Server's `text` is the old type without `=`
    expect(expectOn('sqlserver')).toEqual(['doc']);
    expect(expectOn('sqlite')).toEqual(['doc', 'body']);
  });

  // --- whole rows (prompt 032) ----------------------------------------------------------------------

  it('adds new rows below the table, with cells or left to the database', () => {
    const { buffer: one, ids } = addRows(EMPTY_BUFFER, [
      {},
      { 1: v('Zoe'), 3: { kind: 'default' } },
    ]);
    expect(ids).toEqual([1, 2]);
    expect(editCount(one)).toMatchObject({ inserts: 2, cells: 0, total: 2 });
    const marks = marksOf(one)!;
    expect(marks.extra).toBe(2);
    expect(marks.newAt(1, 1)).toEqual(v('Zoe'));
    // a default is no cell: the database fills it
    expect(marks.newAt(1, 3)).toBeNull();
    let b = setNewCell(one, 1, 2, v('7'));
    b = setNewCell(b, 1, 2, { kind: 'default' });
    expect(marksOf(b)!.newAt(0, 2)).toBeNull();
    expect(setNewCell(b, 99, 0, v('x'))).toBe(b);
    // adding the two rows was one step
    expect(editCount(undoEdit(one)).inserts).toBe(0);
    expect(editCount(removeNewRows(one, [1])).inserts).toBe(1);
    expect(addRows(one, []).buffer).toBe(one);
  });

  it('marks rows to delete, takes the mark away again, and undoes both', () => {
    const rows = [0, 1].map((r) => ({ key: key(r), row: r, original: ROWS[r] }));
    let b = toggleDeleted(EMPTY_BUFFER, rows);
    expect(editCount(b)).toMatchObject({ deletes: 2, total: 2 });
    expect(marksOf(b)!.deleted(1)).toBe(true);
    // one of them again: not all are marked yet, so all get the mark (it stays)
    b = toggleDeleted(b, [rows[0]]);
    expect(editCount(b).deletes).toBe(1);
    b = undoEdit(b);
    expect(editCount(b).deletes).toBe(2);
    expect(editCount(resetRow(b, key(0))).deletes).toBe(1);
    expect(toggleDeleted(b, [])).toBe(b);
  });

  it('plans deletes, updates and inserts apart; a row changed and deleted is deleted', () => {
    let b = edit(EMPTY_BUFFER, 0, 1, v('Eve'));
    b = edit(b, 1, 1, v('Bo'));
    b = toggleDeleted(b, [{ key: key(1), row: 1, original: ROWS[1] }]);
    b = addRows(b, [{ 1: v('Zoe'), 3: { kind: 'null' } }, {}]).buffer;
    const planned = planOf(b, COLUMNS, PK, true, 'shop', 'people');
    expect(planned.keys).toEqual([key(0)]);
    expect(planned.deleteKeys).toEqual([key(1)]);
    expect(planned.insertIds).toEqual([1, 2]);
    expect(planned.plan.rows).toHaveLength(1);
    expect(planned.plan.deletes).toEqual([
      {
        key: [{ column: 'id', kind: 'number', typeName: 'int4', value: '2' }],
        // the lock of a delete: every cell that can be compared (not the float)
        expect: [
          { column: 'name', kind: 'text', typeName: 'varchar(10)', value: 'Bob' },
          { column: 'note', kind: 'text', typeName: 'text', value: 'x' },
        ],
      },
    ]);
    expect(planned.plan.inserts).toEqual([
      {
        set: [
          { column: 'name', kind: 'text', typeName: 'varchar(10)', value: 'Zoe', default: false },
          { column: 'note', kind: 'text', typeName: 'text', value: null, default: false },
        ],
      },
      { set: [] },
    ]);
    // the key the database gives the new rows is asked back
    expect(planned.plan.returning).toBe('id');
    expect(planOf(b, COLUMNS, PK, false, null, 't').plan.deletes?.[0].expect).toEqual([]);
  });

  it('pastes a block over rows of the table and on into new rows, as one step', () => {
    const target = {
      existing: [1].map((r) => ({ key: key(r), row: r, original: ROWS[r] })),
      firstNew: 0,
      columns: [1, 2, 3],
    };
    const block = [
      ['Bobby', '', 'n1'],
      ['Cy', '3.5', ''],
      ['Di', 'abc', 'n3', 'one cell too many'],
    ];
    const pasted = pasteBlock(EMPTY_BUFFER, block, target, COLUMNS);
    expect(pasted).toMatchObject({ cells: 9, added: 2, skipped: 0 });
    const b = pasted.buffer;
    expect(editCount(b)).toMatchObject({ cells: 3, rows: 1, inserts: 2 });
    const marks = marksOf(b)!;
    expect(marks.at(1, 1)).toEqual(v('Bobby'));
    // an empty cell: NULL in a number column, an empty text in a text column
    expect(marks.at(1, 2)).toEqual({ kind: 'null' });
    expect(marks.newAt(0, 3)).toEqual(v(''));
    expect(marks.newAt(1, 2)).toEqual(v('abc'));
    // one undo takes the whole block back
    expect(editCount(undoEdit(b)).total).toBe(0);
    // a value a column cannot take is in the buffer and marked – writing waits for it
    const info = COLUMNS.map(() => undefined);
    const invalid = invalidCells(b, COLUMNS, info);
    expect([...invalid.entries()]).toEqual([['new:2|2', 'number']]);
    expect(marksOf(b, invalid)!.newInvalid(1, 2)).toBe(true);
    expect(marksOf(b, invalid)!.newInvalid(0, 2)).toBe(false);
    // a second block from the first new row on overwrites it and adds none
    const again = pasteBlock(b, [['Zed']], { existing: [], firstNew: 0, columns: [1] }, COLUMNS);
    expect(again).toMatchObject({ cells: 1, added: 0 });
    expect(marksOf(again.buffer)!.newAt(0, 1)).toEqual(v('Zed'));
    // a row without a key is left alone and counted
    const noKey = pasteBlock(
      EMPTY_BUFFER,
      [['x']],
      { existing: [{ key: null, row: 0, original: ROWS[0] }], firstNew: 0, columns: [1] },
      COLUMNS,
    );
    expect(noKey).toMatchObject({ cells: 0, skipped: 1 });
    expect(noKey.buffer).toBe(EMPTY_BUFFER);
  });

  it('remembers which row failed until it is changed again', () => {
    let b = edit(EMPTY_BUFFER, 0, 1, v('Eve'));
    b = { ...b, failed: key(0) };
    expect(marksOf(b)!.failed(0)).toBe(true);
    expect(marksOf(b)!.failed(1)).toBe(false);
    expect(edit(b, 0, 1, v('Eva')).failed).toBeNull();
  });

  it('says whether a result can be edited, and why not', () => {
    const info = (key: string[]): ColumnInfo[] =>
      COLUMNS.map((c) => ({
        name: c.name,
        quoted: c.name,
        typeName: c.typeName,
        nullable: true,
        default: null,
        key: key.includes(c.name) ? 'pk' : '',
      }));
    expect(editability(true, true, info(['id']), COLUMNS, false)).toEqual({ pk: [0] });
    expect(editability(true, true, info(['name', 'id']), COLUMNS, false)).toEqual({ pk: [0, 1] });
    expect(editability(false, true, info(['id']), COLUMNS, false)).toEqual({ reason: 'noTable' });
    expect(editability(true, true, info(['id']), COLUMNS, true)).toEqual({ reason: 'readonly' });
    expect(editability(true, false, info(['id']), COLUMNS, false)).toEqual({ reason: 'noSchema' });
    expect(editability(true, true, undefined, COLUMNS, false)).toEqual({ reason: 'unknown' });
    expect(editability(true, true, info([]), COLUMNS, false)).toEqual({ reason: 'noKey' });
    expect(editability(true, true, info(['id']), COLUMNS.slice(1), false)).toEqual({
      reason: 'keyMissing',
    });
  });

  it('checks a value before it is taken: kind, length, NULL', () => {
    const strict: ColumnInfo = {
      name: 'x',
      quoted: 'x',
      typeName: '',
      nullable: false,
      default: null,
      key: '',
    };
    expect(validate(v('42'), COLUMNS[0], undefined)).toBeNull();
    expect(validate(v('4.2'), COLUMNS[0], undefined)).toBe('integer');
    expect(validate(v(' -1.5e3 '), COLUMNS[2], undefined)).toBeNull();
    expect(validate(v('NaN'), COLUMNS[2], undefined)).toBeNull();
    expect(validate(v('1,5'), col('p', 'decimal', 'numeric'), undefined)).toBe('number');
    expect(validate(v('NaN'), col('p', 'decimal', 'numeric'), undefined)).toBe('number');
    expect(validate(v('yes'), col('b', 'bool', 'bool'), undefined)).toBeNull();
    expect(validate(v('maybe'), col('b', 'bool', 'bool'), undefined)).toBe('bool');
    expect(validate(v('2026-11-11'), col('d', 'date', 'date'), undefined)).toBeNull();
    expect(validate(v('11.11.2026'), col('d', 'date', 'date'), undefined)).toBe('date');
    expect(validate(v('{"a":1}'), col('j', 'other', 'jsonb'), undefined)).toBeNull();
    expect(validate(v('{a:1}'), col('j', 'other', 'json'), undefined)).toBe('json');
    expect(validate(v('12345678901'), COLUMNS[1], undefined)).toBe('tooLong');
    expect(validate(v('äöü😀567890'), COLUMNS[1], undefined)).toBeNull();
    expect(validate({ kind: 'null' }, COLUMNS[1], strict)).toBe('notNull');
    expect(validate({ kind: 'null' }, COLUMNS[1], undefined)).toBeNull();
    expect(validate({ kind: 'default' }, COLUMNS[0], strict)).toBeNull();
    expect(maxLength('character varying(200)')).toBe(200);
    expect(maxLength('nvarchar(max)')).toBeNull();
    expect(maxLength('text')).toBeNull();
  });

  it('starts an editor with what the cell shows now', () => {
    expect(startText(42, null)).toBe('42');
    expect(startText(null, null)).toBe('');
    expect(startText('old', v('new'))).toBe('new');
    expect(startText('old', { kind: 'null' })).toBe('');
  });
});
