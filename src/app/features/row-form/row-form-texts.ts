import { translatable } from '../../core/i18n/i18n';
import { ROW_FORM_DE } from './row-form-texts.de';

/** Texts of the row form (prompt 040). English is the source. */
export const ROW_FORM_EN = {
  title: 'Row as a form',
  width: 'Width of the row form',
  noRow: 'Put the cursor on a row of the result.',
  rowOf: (row: number, rows: number) =>
    `Row ${row.toLocaleString('en')} of ${rows.toLocaleString('en')}`,
  comparing: (count: number) => `${count} rows side by side`,
  first: 'First row',
  previous: 'Previous row',
  next: 'Next row',
  last: 'Last row',
  goTo: 'Go to row',
  filter: 'Find a column',
  nonNull: 'Only with a value',
  changed: 'Only changed',
  compare: 'Marked rows side by side',
  column: 'Column',
  type: 'Type',
  value: 'Value',
  rowN: (row: number) => `Row ${row.toLocaleString('en')}`,
  more: 'more',
  moreOf: (name: string) => `Show all of ${name} in the value panel`,
  edit: 'Edit',
  editOf: (name: string) => `Edit ${name}`,
  copyField: 'Copy',
  copyFieldOf: (name: string) => `Copy the value of ${name}`,
  copyList: 'Copy as „name: value“',
  copyJson: 'Copy as JSON',
  copied: 'Copied.',
  shown: (shown: number, all: number) => `${shown} of ${all} columns`,
  failed: (why: string) => `The row could not be read: ${why}`,
};

export const ROW_FORM_TEXTS = translatable('row-form', ROW_FORM_EN, { de: ROW_FORM_DE });
