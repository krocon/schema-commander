import { QueryResult } from '../../core/sql/query.models';
import { cellText, columnWidths, displayRows, isNumeric, resultModel } from './result-model';

const RESULT: QueryResult = {
  columns: [
    { name: 'id', kind: 'int', typeName: 'INT4' },
    { name: 'name', kind: 'text', typeName: 'TEXT' },
    { name: 'n', kind: 'other', typeName: '' },
    { name: 'big', kind: 'int', typeName: 'INT8' },
  ],
  rows: [
    [1, 'Ada Lovelace', null, '9223372036854775807'],
    [2, null, 2.5, 7],
    [3, 'x'.repeat(500), { bytes: 40, hex: '00ff' }, 8],
  ],
  truncated: false,
  rowsAffected: null,
  elapsedMs: 1,
};

describe('result model', () => {
  it('turns cells into text and keeps NULL apart', () => {
    expect(cellText(null)).toBeNull();
    expect(cellText(2.5)).toBe('2.5');
    expect(cellText(true)).toBe('true');
    expect(cellText({ bytes: 40, hex: '00ff' })).toBe('0x00ff… (40 B)');
    expect(cellText({ bytes: 2, hex: '00ff' })).toBe('0x00ff (2 B)');
    expect(cellText({ unreadable: 'GEOMETRY' })).toBe('‹GEOMETRY›');
  });

  it('copies rows only when a cell needs another form', () => {
    const plain = { ...RESULT, rows: RESULT.rows.slice(0, 2) };
    expect(displayRows(plain)).toBe(plain.rows);
    const shown = displayRows(RESULT);
    expect(shown[2][2]).toBe('0x00ff… (40 B)');
    expect(shown[0][3]).toBe('9223372036854775807');
    expect(displayRows({ ...RESULT, rows: [[true, null, false, 1]] })[0]).toEqual([
      'true',
      null,
      'false',
      1,
    ]);
  });

  it('sizes columns within limits', () => {
    const [id, name] = columnWidths(RESULT);
    expect(id).toBe(60);
    expect(name).toBe(420);
  });

  it('knows numeric columns by kind, and by the first value when the kind is unknown', () => {
    expect(isNumeric(RESULT, 0)).toBe(true);
    expect(isNumeric(RESULT, 1)).toBe(false);
    expect(isNumeric(RESULT, 2)).toBe(true);
    expect(isNumeric(RESULT, 3)).toBe(true);
  });

  it('builds a table model with one column per result column', () => {
    const model = resultModel(RESULT);
    // one more for the row numbers
    expect(model.getColumnCount()).toBe(5);
    expect(model.getBodyModel().getRowCount()).toBe(3);
    expect(model.getBodyModel().getValueAt(0, 2)).toBe('Ada Lovelace');
    expect(model.getBodyModel().getRowHeight(0)).toBe(22);
  });
});
