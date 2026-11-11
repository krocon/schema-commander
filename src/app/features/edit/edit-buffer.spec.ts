import { describe, expect, it } from 'vitest';
import { ColumnInfo } from '../../core/schema/schema.models';
import { Cell, QueryColumn } from '../../core/sql/query.models';
import {
  EMPTY_BUFFER,
  NewValue,
  editCount,
  editability,
  marksOf,
  maxLength,
  planOf,
  redoEdit,
  resetRow,
  rowKey,
  setCell,
  startText,
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
    expect(editCount(b)).toEqual({ cells: 3, rows: 2 });
    const marks = marksOf(b)!;
    expect(marks.at(0, 1)).toEqual(v('Eve'));
    expect(marks.at(1, 3)).toEqual({ kind: 'null' });
    expect(marks.at(1, 1)).toBeNull();
    expect(marksOf(EMPTY_BUFFER)).toBeNull();
  });

  it('takes a change away when the cell gets the value it had', () => {
    let b = edit(EMPTY_BUFFER, 0, 1, v('Eve'));
    b = edit(b, 0, 1, v('Ada'));
    expect(editCount(b)).toEqual({ cells: 0, rows: 0 });
    // NULL on a cell that is NULL, the same number as text
    expect(edit(EMPTY_BUFFER, 0, 3, { kind: 'null' })).toBe(EMPTY_BUFFER);
    expect(edit(EMPTY_BUFFER, 0, 0, v('1'))).toBe(EMPTY_BUFFER);
    // an empty text is not NULL, and DEFAULT is always a change
    expect(editCount(edit(EMPTY_BUFFER, 0, 3, v('')))).toEqual({ cells: 1, rows: 1 });
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

  it('resets a row as steps that can be undone', () => {
    let b = edit(EMPTY_BUFFER, 0, 1, v('Eve'));
    b = edit(b, 0, 3, v('n'));
    b = edit(b, 1, 1, v('Bo'));
    b = resetRow(b, key(0));
    expect(editCount(b)).toEqual({ cells: 1, rows: 1 });
    b = undoEdit(undoEdit(b));
    expect(editCount(b)).toEqual({ cells: 3, rows: 2 });
    expect(resetRow(b, 'nope')).toBe(b);
  });

  it('plans one update per row: found by the key, locked on what the cells were', () => {
    let b = edit(EMPTY_BUFFER, 1, 3, { kind: 'null' });
    b = edit(b, 0, 1, v("it's"));
    b = edit(b, 0, 2, v('9.5'));
    b = edit(b, 0, 3, { kind: 'default' });
    const { plan, keys } = planOf(b, COLUMNS, PK, true, 'shop', 'people');
    expect(keys).toEqual([key(0), key(1)]);
    expect(plan).toEqual({
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
