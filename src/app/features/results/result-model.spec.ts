import { QueryResult } from '../../core/sql/query.models';
import { cellText, columnWidths, isNumeric, resultModel } from './result-model';

const RESULT: QueryResult = {
  columns: [
    { name: 'id', declType: 'INTEGER' },
    { name: 'name', declType: 'TEXT' },
    { name: 'n', declType: null },
  ],
  rows: [
    [1, 'Ada Lovelace', null],
    [2, null, 2.5],
    [3, 'x'.repeat(500), { blob: 12 }],
  ],
  truncated: false,
  rowsAffected: null,
  elapsedMs: 1,
};

describe('result model', () => {
  it('turns cells into text and keeps NULL apart', () => {
    expect(cellText(null)).toBeNull();
    expect(cellText(2.5)).toBe('2.5');
    expect(cellText({ blob: 12 })).toBe('<blob 12 B>');
  });

  it('sizes columns within limits', () => {
    const [id, name] = columnWidths(RESULT);
    expect(id).toBe(60);
    expect(name).toBe(420);
  });

  it('knows numeric columns by declared type or first value', () => {
    expect(isNumeric(RESULT, 0)).toBe(true);
    expect(isNumeric(RESULT, 1)).toBe(false);
    expect(isNumeric(RESULT, 2)).toBe(true);
  });

  it('builds a table model with one column per result column', () => {
    const model = resultModel(RESULT);
    expect(model.getColumnCount()).toBe(3);
    expect(model.getBodyModel().getRowCount()).toBe(3);
    expect(model.getBodyModel().getValueAt(0, 1)).toBe('Ada Lovelace');
  });
});
