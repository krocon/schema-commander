import { translatable } from '../../core/i18n/i18n';
import { COMPARE_DE } from './compare-texts.de';

/** Texts of comparing two results (prompt 041). English is the source. */
export const COMPARE_EN = {
  title: 'Compare results',
  left: 'Left',
  right: 'Right',
  rowsOf: (rows: string) => `${rows} rows`,
  match: 'Rows belong together by',
  byKey: 'key columns',
  byPosition: 'their position',
  keys: 'Key',
  ignore: 'Ignore',
  column: 'Column',
  columns: 'Columns',
  tolerances: 'Count as equal',
  trim: 'Text that differs only in leading or trailing white space',
  ignoreCase: 'Text that differs only in upper and lower case',
  round: 'Numbers that are equal after rounding to',
  decimals: 'decimals',
  decimalsLabel: 'Decimals',
  leftColumnsOnly: (names: string) => `Only in the left result, not compared: ${names}`,
  rightColumnsOnly: (names: string) => `Only in the right result, not compared: ${names}`,
  pairedByPosition:
    'No column name occurs in both results: the columns are paired by their position.',
  problems: {
    same: 'Choose two different results.',
    noColumns: 'The results have no column in common.',
    noKey: 'Choose at least one key column, or compare by position.',
  },
  tooFew: 'A tab needs two results to compare: pin one and run again, or run a script.',
  compare: 'Compare',
  cancel: 'Cancel',
  close: 'Close',
  stop: 'Stop',
  progress: (percent: number) => `Comparing … ${percent} %`,
  // the bar above the outcome
  bar: 'Comparison',
  figures: {
    same: 'same',
    changed: 'changed',
    leftOnly: 'only left',
    rightOnly: 'only right',
    duplicates: 'key not unique',
  },
  identical: 'The results are the same.',
  onlyDifferences: 'Only differences',
  next: 'Next difference',
  previous: 'Previous difference',
  export: 'Export differences …',
  noMore: 'No further difference in this direction.',
  legend:
    '≡ same · ← only left · → only right · ≠← / ≠→ changed (left / right values) · ‼ key not unique',
  duplicates: (keys: string, more: boolean) =>
    `Keys that occur more than once were matched to nothing: ${keys}${more ? ' …' : ''}`,
  changedColumns: (list: string) => `Differences by column: ${list}`,
  cut: 'The outcome has more rows than can be kept: the numbers are right, rows are missing.',
  sides: (left: string, right: string) => `${left} ↔ ${right}`,
};

export type CompareTexts = typeof COMPARE_EN;
export const COMPARE_TEXTS = translatable('result-compare', COMPARE_EN, { de: COMPARE_DE });
