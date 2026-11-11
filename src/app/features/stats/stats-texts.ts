import { translatable } from '../../core/i18n/i18n';
import { STATS_DE } from './stats-texts.de';

/** Texts of the figures of a selection (prompt 028). English is the source. */
export const STATS_EN = {
  labels: {
    cells: 'Count',
    nonNull: 'Not NULL',
    distinct: 'Distinct',
    sum: 'Sum',
    mean: 'Mean',
    min: 'Min',
    max: 'Max',
    first: 'First',
    last: 'Last',
    span: 'Span',
    shortest: 'Shortest',
    longest: 'Longest',
  },
  working: '…',
  region: 'Figures of the selection',
  copyHint: (label: string) => `Copy: ${label}`,
  copied: (label: string) => `${label} copied.`,
  ignored: (n: number) => (n === 1 ? '1 cell is no number' : `${n} cells are no numbers`),
  moreThan: (n: string) => `more than ${n}`,
  days: (n: string) => (n === '1' ? '1 day' : `${n} days`),
  chars: (n: string) => (n === '1' ? '1 character' : `${n} characters`),
  noSum: 'The selection has no sum: no numbers in it.',
  noCell: 'Choose a cell first: its column is summarized.',
  summaryTitle: (column: string) => `Column ${column}`,
  summaryWorking: 'Reading the column …',
  summaryFailed: (why: string) => `The column could not be summarized: ${why}`,
  figure: 'Figure',
  value: 'Value',
  inStatus: 'Status line',
  inStatusHint: (label: string) => `Show “${label}” in the status line`,
  copy: 'Copy',
  top: 'Most frequent values',
  topPartial: 'The column has very many different values: the list may miss some.',
  times: 'Count',
  share: 'Share',
  nullValue: 'NULL',
  emptyText: '(empty)',
  close: 'Close',
};

export const STATS_TEXTS = translatable('stats', STATS_EN, { de: STATS_DE });
