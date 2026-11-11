import { translatable } from '../../core/i18n/i18n';
import { FILTER_DE } from './filter-texts.de';

/** Texts of sorting and filtering (prompt 027). English is the source. */
export const FILTER_EN = {
  // the table view
  tableBar: 'Filter of the table',
  filtered: 'filtered',
  column: (n: number) => `Column of condition ${n}`,
  operator: (n: number) => `Operator of condition ${n}`,
  value: (n: number) => `Value of condition ${n}`,
  upper: (n: number) => `Upper bound of condition ${n}`,
  remove: (n: number) => `Remove condition ${n}`,
  chooseColumn: 'Column …',
  add: 'Add condition',
  join: 'How the conditions are joined',
  all: 'all (AND)',
  any: 'any (OR)',
  where: 'Free condition (SQL)',
  wherePlaceholder: 'and … (SQL: total > 100)',
  limit: 'Rows at most',
  allRows: 'all rows',
  rows: (n: string) => `${n} rows`,
  apply: 'Apply',
  reset: 'Reset',
  listHint: 'separated by commas',
  ops: {
    eq: '=',
    ne: '≠',
    lt: '<',
    le: '≤',
    gt: '>',
    ge: '≥',
    contains: 'contains',
    like: 'LIKE',
    notLike: 'NOT LIKE',
    in: 'IN',
    between: 'between',
    isNull: 'IS NULL',
    isNotNull: 'IS NOT NULL',
  },
  and: 'and',
  // the local filter
  localBar: 'Filter of this result',
  localColumn: 'Column to search in',
  allColumns: 'All columns',
  localText: 'Filter this result …',
  localCount: (shown: string, total: string) => `${shown} of ${total}`,
  localWorking: 'Working …',
  localHint:
    'Filtered and sorted here, not by the database: text by its characters without regard to case (no collation), NULLs last. The query is not run again.',
  sortedLocally: 'sorted here',
  // quick filters
  noTable: 'This works in the view of a table (open one from the schema tree).',
  noCell: 'Choose a cell of the table first.',
  notAValue: 'The value of this cell is too long or binary: it cannot be filtered by.',
};

export const FILTER_TEXTS = translatable('filter', FILTER_EN, { de: FILTER_DE });
