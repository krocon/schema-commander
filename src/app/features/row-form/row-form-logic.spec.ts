import { QueryColumn } from '../../core/sql/query.models';
import {
  NO_FILTER,
  filterFields,
  formFields,
  rowAsJson,
  rowAsList,
  rowFromText,
  selectedRows,
  stepRow,
  transposed,
} from './row-form-logic';

const COLUMNS: QueryColumn[] = [
  { name: 'id', kind: 'int', typeName: 'INT4' },
  { name: 'Customer_Name', kind: 'text', typeName: 'TEXT' },
  { name: 'note', kind: 'text', typeName: 'TEXT' },
  { name: 'total', kind: 'decimal', typeName: 'NUMERIC' },
];

describe('row form logic', () => {
  it('turns a row into fields, with what waits in the edit buffer', () => {
    const fields = formFields(COLUMNS, [7, 'Ada', null, '12.50'], (c) =>
      c === 1 ? { kind: 'value', text: 'Ada L.' } : c === 3 ? { kind: 'null' } : null,
    );
    expect(
      fields.map(
        (f) => `${f.name}=${f.shown.text}${f.changed ? '*' : ''}${f.isNull ? ' null' : ''}`,
      ),
    ).toEqual(['id=7', 'Customer_Name=Ada L.*', 'note=NULL null', 'total=NULL* null']);
    expect(formFields(COLUMNS, null)).toEqual([]);
    // a long value is marked: the form shows its start
    const long = formFields(COLUMNS, [1, 'x'.repeat(400), null, null]);
    expect(long.map((f) => f.long)).toEqual([false, true, false, false]);
  });

  it('filters fields by name, by having a value, by being changed', () => {
    const fields = formFields(COLUMNS, [7, 'Ada', null, '12.50'], (c) =>
      c === 3 ? { kind: 'value', text: '13' } : null,
    );
    const is = (f: (typeof fields)[number]) => f;
    const names = (filter: Parameters<typeof filterFields>[1]) =>
      filterFields(fields, filter, is).map((f) => f.name);
    expect(names(NO_FILTER).length).toBe(4);
    expect(names({ ...NO_FILTER, text: 'NAME' })).toEqual(['Customer_Name']);
    expect(names({ ...NO_FILTER, nonNull: true })).toEqual(['id', 'Customer_Name', 'total']);
    expect(names({ ...NO_FILTER, changed: true })).toEqual(['total']);
    // 300 columns: one of them by a part of its name
    const many: QueryColumn[] = Array.from({ length: 300 }, (_, i) => ({
      name: `col_${i}_${i === 217 ? 'iban' : 'x'}`,
      kind: 'text',
      typeName: 'TEXT',
    }));
    const wide = formFields(
      many,
      many.map((_, i) => `v${i}`),
    );
    expect(
      filterFields(wide, { ...NO_FILTER, text: 'iban' }, (f) => f).map((f) => f.index),
    ).toEqual([217]);
  });

  it('lays rows side by side and says where they differ', () => {
    const lines = transposed(COLUMNS, [
      [1, 'Ada', null, '12.50'],
      [2, 'Ada', null, '12.50'],
      [3, 'Ada', 'late', '12.5'],
    ]);
    expect(lines.map((l) => `${l.name}${l.differs ? ' ≠' : ''}`)).toEqual([
      'id ≠',
      'Customer_Name',
      'note ≠',
      'total ≠',
    ]);
    expect(lines[2].values.map((v) => v.text)).toEqual(['NULL', 'NULL', 'late']);
    expect(lines[1].isNull).toBe(false);
    // binary values are compared by what they hold
    const bin: QueryColumn[] = [{ name: 'b', kind: 'bytes', typeName: 'BYTEA' }];
    expect(transposed(bin, [[{ bytes: 1, hex: '00' }], [{ bytes: 1, hex: '00' }]])[0].differs).toBe(
      false,
    );
    expect(transposed(bin, [[{ bytes: 1, hex: '00' }], [{ bytes: 1, hex: '01' }]])[0].differs).toBe(
      true,
    );
    // the rows of a selection, at most eight
    expect(
      selectedRows([
        [5, 6],
        [2, 2],
        [6, 7],
      ]),
    ).toEqual([2, 5, 6, 7]);
    expect(selectedRows([[0, 99]]).length).toBe(8);
    expect(selectedRows([])).toEqual([]);
  });

  it('writes a row as a list and as JSON', () => {
    const row = [7, 'Ada "the first"', null, '12345678901234567890.50'];
    expect(rowAsList(COLUMNS, row)).toBe(
      'id: 7\nCustomer_Name: Ada "the first"\nnote: NULL\ntotal: 12345678901234567890.50\n',
    );
    expect(JSON.parse(rowAsJson(COLUMNS, row))).toEqual({
      id: 7,
      Customer_Name: 'Ada "the first"',
      note: null,
      // a decimal stays the text it is: no digit is lost
      total: '12345678901234567890.50',
    });
    const twice: QueryColumn[] = [
      COLUMNS[0],
      COLUMNS[0],
      { name: 'b', kind: 'bytes', typeName: 'BYTEA' },
    ];
    expect(JSON.parse(rowAsJson(twice, [1, 2, { bytes: 2, hex: 'cafe' }]))).toEqual({
      id: 1,
      id_2: 2,
      b: '0xcafe',
    });
  });

  it('steps through the rows and reads a row number', () => {
    expect(stepRow(5, 'next', 10)).toBe(6);
    expect(stepRow(9, 'next', 10)).toBe(9);
    expect(stepRow(0, 'prev', 10)).toBe(0);
    expect(stepRow(5, 'first', 10)).toBe(0);
    expect(stepRow(5, 'last', 10)).toBe(9);
    expect(stepRow(3, 'next', 0)).toBe(0);
    expect(rowFromText(' 1.000 ', 5000)).toBe(999);
    expect(rowFromText('1', 5)).toBe(0);
    for (const bad of ['0', '6', 'x', '', '1.5e2x', '-3'])
      expect(rowFromText(bad, 5), bad).toBeNull();
  });
});
