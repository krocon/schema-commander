import { translatable } from '../../core/i18n/i18n';
import { PLAN_DE } from './plan-texts.de';

/** Texts of the execution plan (prompt 039). English is the source. */
export const PLAN_EN = {
  /** For numbers. */
  locale: 'en',
  title: 'Execution plan',
  estimated: 'estimated – nothing ran',
  analyzed: 'with execution – the statement ran and was rolled back',
  loading: 'Asking the database …',
  failed: (why: string) => `No plan: ${why}`,
  noStatement: 'There is no statement at the caret.',
  unknown: 'This plan is in a form the app does not know. It is shown as the database gave it.',
  cut: 'The plan has more operations than are shown.',
  operation: 'Operation',
  object: 'Object',
  estRows: 'Rows est.',
  actRows: 'Rows',
  factor: 'Off by',
  self: 'Own time',
  total: 'Total time',
  cost: 'Cost',
  buffers: 'Pages',
  loops: 'Loops',
  expand: (op: string) => `Show what is below ${op}`,
  collapse: (op: string) => `Hide what is below ${op}`,
  details: 'Details',
  noNode: 'Choose an operation to see what the database says about it.',
  hintsHeading: 'Worth a look',
  hintNote: 'Hints, not verdicts: rules of thumb that do not know your data.',
  hints: {
    scanFilter:
      'A whole table is read and most of its rows are thrown away: an index on the condition may help.',
    sortOnDisk: 'A sort did not fit into memory and went to disk.',
    misestimate:
      'The rows that came differ from the estimate by a factor of ten or more: statistics may be old.',
    manyLoops: 'This ran a thousand times or more (the inner side of a loop).',
  },
  raw: 'Plan as the database gave it',
  showRaw: 'Show raw plan',
  hideRaw: 'Hide raw plan',
  runAnalyze: 'Plan with execution …',
  runEstimate: 'Estimate again',
  copy: 'Copy as text',
  copied: 'Copied.',
  save: 'Save raw plan …',
  saved: (file: string) => `Saved as ${file}.`,
  saveFailed: 'The file could not be written.',
  close: 'Close',
  analyzeTitle: 'Run the statement for its plan?',
  analyzeQuestion:
    'To measure, the database runs the statement. The app rolls it back afterwards – but it runs, with its locks, its triggers and what it does outside of the database.',
  analyzeYes: 'Run and roll back',
};

export const PLAN_TEXTS = translatable('plan', PLAN_EN, { de: PLAN_DE });
