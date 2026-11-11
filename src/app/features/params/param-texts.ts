import { translatable } from '../../core/i18n/i18n';
import { PARAM_DE } from './param-texts.de';

/** Texts of the parameters of statements (prompt 025). English is the source. */
export const PARAM_EN = {
  title: 'Parameters',
  intro:
    'The values are sent to the database apart from the statement; they never become part of its text.',
  value: (name: string) => `Value of ${name}`,
  type: (name: string) => `Type of ${name}`,
  listHint: 'One entry per line, or separated by commas.',
  run: 'Run',
  types: {
    auto: 'Automatic',
    text: 'Text',
    number: 'Number',
    date: 'Date',
    bool: 'Yes / no',
    list: 'List',
    null: 'NULL',
  },
  /** What `Automatic` takes the text for. */
  reads: {
    text: 'text',
    int: 'whole number',
    decimal: 'number',
    bool: 'yes / no',
    date: 'date',
    datetime: 'date and time',
    null: 'NULL',
    list: (n: number) => (n === 1 ? '1 entry' : `${n} entries`),
  },
  problems: {
    missing: (name: string) => `${name} has no value.`,
    number: (name: string) => `${name} is not a number (like 42 or 3.14).`,
    date: (name: string) =>
      `${name} is not a date (like 2026-11-11 or 11.11.2026, with a time 12:30).`,
    bool: (name: string) => `${name} is neither yes nor no (true, false, 1, 0).`,
  },
  forms: 'What counts as a parameter on this connection',
  formsReset: 'Defaults',
  none: 'With these forms the statement has no parameters. “Run” runs it as it is written.',
  noValues: 'There are no values yet to run again with.',
  notBound: (name: string) => `Not run: ${name} has no usable value.`,
  with: (values: string) => `with ${values}`,
};

export const PARAM_TEXTS = translatable('params', PARAM_EN, { de: PARAM_DE });
