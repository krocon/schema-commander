/* eslint-disable no-control-regex -- control characters are what this file is about */
import { locale } from '../../core/i18n/i18n';
import { Cell, ColKind } from '../../core/sql/query.models';

/** How cells are shown; nothing of it reaches the clipboard or an export. */
export interface CellFormat {
  /** Group the digits of numbers in threes. */
  readonly groupDigits: boolean;
}

export const PLAIN_FORMAT: CellFormat = { groupDigits: false };

/** Characters of a text shown in a cell; the full value is the business of the value view (prompt 026). */
export const SHOWN_CHARS = 300;

/** The classes a cell can have (`ge-table-theme.css`); `''` is plain text. */
export type CellClass = '' | 'sc-null' | 'sc-empty' | 'sc-num' | 'sc-bool' | 'sc-bin';

/** A cell as the grid shows it. */
export interface ShownCell {
  readonly text: string;
  readonly cls: CellClass;
}

const NULL: ShownCell = { text: 'NULL', cls: 'sc-null' };
const EMPTY: ShownCell = { text: '∅', cls: 'sc-empty' };
const GROUP = '\u202f';

/*
 * What must not reach the screen as it is: control characters, line and paragraph separators, and the
 * invisible characters that reorder or hide text (bidirectional controls, zero width, BOM).
 */
const UNSAFE =
  /\r\n|[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

function visible(found: string): string {
  if (found === '\r\n' || found === '\n' || found === '\u2028' || found === '\u2029') return '↵';
  if (found === '\t') return '→';
  const code = found.charCodeAt(0);
  if (code < 0x20) return String.fromCharCode(0x2400 + code);
  if (code === 0x7f) return '␡';
  return `‹U+${code.toString(16).toUpperCase().padStart(4, '0')}›`;
}

/** Text on one line with nothing invisible in it: line breaks, tabs and control characters become signs. */
export function defuse(text: string): string {
  UNSAFE.lastIndex = 0;
  return UNSAFE.test(text) ? text.replace(UNSAFE, visible) : text;
}

/** The first `max` characters of a text, cut between characters, with `…` when something is missing. */
export function cut(text: string, max = SHOWN_CHARS): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  // never half a character
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

/** The digits before the decimal point in groups of three; anything that is not a plain number stays. */
export function groupDigits(number: string): string {
  const parts = /^(-?)(\d{4,})(\.\d+)?$/.exec(number);
  if (!parts) return number;
  return `${parts[1]}${parts[2].replace(/\B(?=(\d{3})+$)/g, GROUP)}${parts[3] ?? ''}`;
}

/** A size in bytes, short. */
export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown =
    value < 10
      ? value.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : Math.round(value);
  return `${shown} ${units[unit]}`;
}

const isNumberKind = (kind: ColKind) => kind === 'int' || kind === 'float' || kind === 'decimal';

/**
 * A cell as the grid shows it. The value is never changed, only made readable: `NULL` and the empty text
 * have signs of their own, numbers keep every digit, text is one line without invisible characters.
 */
export function showCell(cell: Cell, kind: ColKind, format: CellFormat = PLAIN_FORMAT): ShownCell {
  if (cell === null) return NULL;
  if (typeof cell === 'boolean') return { text: cell ? 'true' : 'false', cls: 'sc-bool' };
  if (typeof cell === 'number') {
    const text = String(cell);
    return { text: format.groupDigits ? groupDigits(text) : text, cls: 'sc-num' };
  }
  if (typeof cell === 'string') {
    if (cell === '') return EMPTY;
    if (isNumberKind(kind)) {
      // integers beyond 2^53 and decimals come as text, digit for digit
      const text = defuse(cut(cell));
      return { text: format.groupDigits ? groupDigits(text) : text, cls: 'sc-num' };
    }
    return { text: defuse(cut(cell)), cls: '' };
  }
  if ('unreadable' in cell) return { text: `‹${defuse(cut(cell.unreadable, 60))}›`, cls: 'sc-bin' };
  const more = cell.bytes * 2 > cell.hex.length ? '…' : '';
  return { text: `0x${cell.hex}${more} (${byteSize(cell.bytes)})`, cls: 'sc-bin' };
}

/** The type of a column as the header shows it: lower case, short. */
export function typeLabel(typeName: string): string {
  return defuse(cut(typeName.trim().toLowerCase(), 24));
}
