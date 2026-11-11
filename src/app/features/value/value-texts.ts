import { translatable } from '../../core/i18n/i18n';
import { VALUE_DE } from './value-texts.de';

/** Texts of the value panel (prompt 026). English is the source. */
export const VALUE_EN = {
  panel: 'Value of the cell',
  none: 'Choose a cell: its whole value is shown here.',
  reading: 'Reading …',
  nullValue: 'NULL – the cell has no value.',
  unreadable: (type: string) => `The driver cannot read values of the type ${type}.`,
  view: 'View',
  views: {
    text: 'Text',
    json: 'JSON',
    xml: 'XML',
    hex: 'Hex',
    image: 'Picture',
    number: 'Number',
    date: 'Date',
  },
  wrap: 'Wrap lines',
  copy: 'Copy',
  save: 'Save …',
  saveTitle: 'Save the value',
  loadWhole: (size: string) => `Read the whole value (${size})`,
  loading: (percent: number) => `Reading the value … ${percent} %`,
  layingOut: (percent: number) => `Laying out … ${percent} %`,
  partial: (shown: string, total: string) => `The first ${shown} of ${total} are shown.`,
  hexPartial: (shown: string, total: string) =>
    `The first ${shown} of ${total} are shown; “Save …” writes all of them.`,
  tooLarge: (total: string) =>
    `${total} are too much to show; “Save …” writes the value into a file.`,
  bytes: (size: string) => `${size}, binary`,
  textSize: (chars: string, size: string) => `${chars} characters, ${size} (UTF-8)`,
  textSizeOpen: (size: string) => `${size} (UTF-8)`,
  image: (mime: string, width: number, height: number) => `${mime}, ${width} × ${height}`,
  imageAlt: (column: string) => `Picture in the column ${column}`,
  imageBroken: 'The data says it is a picture, but it cannot be drawn. It is shown as bytes.',
  copied: 'The value was copied.',
  saved: (size: string) => `The value was saved (${size}).`,
  decimal: 'Decimal',
  hex: 'Hexadecimal',
  binary: 'Binary',
  utc: 'UTC',
  local: 'Here',
  epoch: 'Seconds since 1970',
  weekday: 'Day of the week',
  days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  noZone: 'The value has no time zone: it is a time on the clock, not an instant.',
  width: 'Width of the value panel',
};

export const VALUE_TEXTS = translatable('value', VALUE_EN, { de: VALUE_DE });
