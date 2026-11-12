import { ColumnPairing, CompareReport, QueryColumn } from '../../core/sql/query.models';
import {
  CompareChoice,
  choiceProblem,
  compareTint,
  figures,
  identical,
  namesIn,
  specOf,
  suggestKeys,
} from './compare-view-logic';

const col = (name: string): QueryColumn => ({ name, kind: 'text', typeName: '' });
const pairing = (pairs: [number, number][]): ColumnPairing => ({
  pairs,
  leftOnly: [],
  rightOnly: [],
  byPosition: false,
});
const choice: CompareChoice = {
  byKey: true,
  keys: [0],
  ignore: [],
  trim: false,
  ignoreCase: false,
  round: false,
  decimals: 2,
};

describe('the view of a comparison', () => {
  const tint = compareTint(['Δ', '≠', 'id', 'name', 'first, last']);
  const at = (row: unknown[], column: number) => tint((c) => row[c] as never, column);

  it('leaves rows that are the same alone', () => {
    expect(at(['≡', null, 1, 'a'], 2)).toBeNull();
    expect(at(['≡', null, 1, 'a'], -1)).toBeNull();
  });

  it('colours rows of one side as a whole', () => {
    expect(at(['←', null, 1, 'a'], 3)).toBe('sc-diff-left');
    expect(at(['→', null, 1, 'a'], -1)).toBe('sc-diff-right');
    expect(at(['‼←', null, 1, 'a'], 2)).toBe('sc-diff-duplicate');
    expect(at(['‼→', null, 1, 'a'], 0)).toBe('sc-diff-duplicate');
  });

  it('marks of a changed row the cells that differ, and the state by its side', () => {
    const left = ['≠←', 'name', 1, 'a', 'x'];
    expect(at(left, 3)).toBe('sc-diff-changed');
    expect(at(left, 2)).toBeNull();
    expect(at(left, 4)).toBeNull();
    expect(at(left, 0)).toBe('sc-diff-left');
    expect(at(['≠→', 'name', 1, 'b', 'x'], 0)).toBe('sc-diff-right');
    expect(at(left, -1)).toBeNull();
  });

  it('is not confused by a page that is not there or a cell that is no state', () => {
    expect(tint(() => undefined, 2)).toBeNull();
    expect(at([42, null], 0)).toBeNull();
    expect(at(['<b>', null], 0)).toBeNull();
  });

  it('finds a name in the list of changed columns', () => {
    expect(namesIn('a, b, c', 'b')).toBe(true);
    expect(namesIn('a, b, c', 'a')).toBe(true);
    expect(namesIn('a, b, c', 'c')).toBe(true);
    expect(namesIn('ab, bc', 'b')).toBe(false);
    expect(namesIn('name', 'name')).toBe(true);
    expect(namesIn('', 'name')).toBe(false);
  });

  it('proposes the keys of the last time, else a column that looks like one', () => {
    const left = [col('name'), col('kunde_id'), col('ort')];
    const p = pairing([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(suggestKeys(p, left, [])).toEqual([1]);
    expect(suggestKeys(p, left, ['ort', 'name'])).toEqual([0, 2]);
    // a key of the last time is gone: start over
    expect(suggestKeys(p, left, ['weg'])).toEqual([1]);
    expect(suggestKeys(pairing([[2, 0]]), left, [])).toEqual([2]);
    expect(suggestKeys(pairing([]), left, [])).toEqual([]);
  });

  it('turns the choice into what the backend wants', () => {
    expect(specOf(1, 2, { ...choice, keys: [0, 1], ignore: [1, 2] })).toEqual({
      left: 1,
      right: 2,
      keys: [0, 1],
      ignore: [2],
      trim: false,
      ignoreCase: false,
      decimals: null,
    });
    expect(specOf(1, 2, { ...choice, byKey: false, round: true, decimals: 99 })).toMatchObject({
      keys: [],
      decimals: 15,
    });
    expect(specOf(1, 2, { ...choice, round: true, decimals: NaN }).decimals).toBe(0);
    expect(specOf(1, 2, { ...choice, round: true, decimals: -3 }).decimals).toBe(0);
  });

  it('says why a choice cannot be compared', () => {
    const p = pairing([[0, 0]]);
    expect(choiceProblem(choice, p, false)).toBeNull();
    expect(choiceProblem(choice, p, true)).toBe('same');
    expect(choiceProblem(choice, null, false)).toBe('noColumns');
    expect(choiceProblem(choice, pairing([]), false)).toBe('noColumns');
    expect(choiceProblem({ ...choice, keys: [] }, p, false)).toBe('noKey');
    expect(choiceProblem({ ...choice, keys: [], byKey: false }, p, false)).toBeNull();
  });

  it('sums a report up', () => {
    const report = {
      same: 5,
      changed: 0,
      leftOnly: 1,
      rightOnly: 0,
      duplicateLeft: 2,
      duplicateRight: 1,
      diffRows: 4,
      cut: false,
    } as CompareReport;
    expect(figures(report).map((f) => [f.key, f.count])).toEqual([
      ['same', 5],
      ['changed', 0],
      ['leftOnly', 1],
      ['rightOnly', 0],
      ['duplicates', 3],
    ]);
    expect(figures({ ...report, duplicateLeft: 0, duplicateRight: 0 }).length).toBe(4);
    expect(identical(report)).toBe(false);
    expect(identical({ ...report, diffRows: 0 })).toBe(true);
    expect(identical({ ...report, diffRows: 0, cut: true })).toBe(false);
  });
});
