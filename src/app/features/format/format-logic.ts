import { FormatDialect, FormatStyle } from '../../core/format/format-api';
import { Settings } from '../../core/settings/settings.models';

/**
 * What formatting needs around the formatter itself (prompt 023; the formatter is `src-tauri/src/format.rs`):
 * the style from the settings, places in the editor's way of counting, and the line comment. Pure.
 */

/** A position as the editor counts: line and column from 1, the column in code points (an emoji is one). */
export interface EdPlace {
  readonly line: number;
  readonly ch: number;
}

export function styleOf(settings: Settings): FormatStyle {
  return {
    keywordCase: settings.formatKeywordCase,
    indent: settings.formatIndent,
    comma: settings.formatComma,
    width: settings.formatWidth,
    andOr: settings.formatAndOr,
    blankLines: settings.formatBlankLines,
  };
}

/** From this many characters on, formatting shows itself in the status line (with a way to stop it). */
export const BIG_TEXT = 200_000;

/** Characters as the editor counts them: a surrogate pair is one. No array – a line can be megabytes. */
function codePoints(text: string): number {
  let n = text.length;
  for (let i = 0; i + 1 < text.length; i++) {
    const high = text.charCodeAt(i);
    if (high < 0xd800 || high > 0xdbff) continue;
    const low = text.charCodeAt(i + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      n--;
      i++;
    }
  }
  return n;
}

/**
 * The place of `offset` (UTF-16, as JavaScript counts) of a text that starts at `start` in the editor.
 * A `\r` before a line break belongs to the break.
 */
export function placeIn(
  text: string,
  offset: number,
  start: EdPlace = { line: 1, ch: 1 },
): EdPlace {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lastBreak = before.lastIndexOf('\n');
  if (lastBreak < 0) return { line: start.line, ch: start.ch + codePoints(before) };
  let line = start.line;
  for (let i = before.indexOf('\n'); i >= 0; i = before.indexOf('\n', i + 1)) line++;
  return { line, ch: codePoints(before.slice(lastBreak + 1)) + 1 };
}

/** The offset (UTF-16) of a place of the editor in the whole text; behind the end = the end. */
export function offsetAt(text: string, place: EdPlace): number {
  let offset = 0;
  for (let l = 1; l < place.line; l++) {
    const eol = text.indexOf('\n', offset);
    if (eol < 0) return text.length;
    offset = eol + 1;
  }
  let left = Math.max(0, place.ch - 1);
  while (left > 0 && offset < text.length && text[offset] !== '\n') {
    offset += String.fromCodePoint(text.codePointAt(offset)!).length;
    left--;
  }
  return offset;
}

/** The part of a text without the blanks around it: where it starts and ends (UTF-16). */
export function trimmedSpan(text: string): { from: number; to: number } {
  const from = text.length - text.trimStart().length;
  return { from, to: Math.max(from, text.trimEnd().length) };
}

const isBlank = (text: string, i: number) => /\s/.test(text[i]);

/**
 * Where a caret at `offset` of a text stands in the formatted text: behind the same number of characters
 * that are no blanks (formatting moves only blanks; the case of a keyword does not count). A caret before
 * a word stays before that word.
 */
export function mapOffset(before: string, after: string, offset: number): number {
  const end = Math.max(0, Math.min(offset, before.length));
  let seen = 0;
  for (let i = 0; i < end; i++) if (!isBlank(before, i)) seen++;
  let at = 0;
  while (at < after.length && seen > 0) {
    if (!isBlank(after, at)) seen--;
    at++;
  }
  const beforeWord =
    end < before.length && !isBlank(before, end) && (end === 0 || isBlank(before, end - 1));
  if (beforeWord) while (at < after.length && isBlank(after, at)) at++;
  return at;
}

/** What starts a line comment. MySQL wants a blank behind `--`; it gets one everywhere. */
const MARK = '--';

/**
 * Comments whole lines out, or in again when every line with text is a comment already. The mark goes
 * where the least indented line starts, so the block keeps its shape. Empty lines stay empty; line breaks
 * stay what they are.
 */
export function toggleComment(text: string, dialect: FormatDialect): string {
  const lines = text.split('\n');
  const body = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);
  const filled = lines.filter((line) => body(line).trim() !== '');
  if (filled.length === 0) return text;
  const hash = dialect === 'mysql';
  const marked = (line: string) => {
    const t = body(line).trimStart();
    return t.startsWith(MARK) || (hash && t.startsWith('#'));
  };
  if (filled.every(marked)) {
    return lines
      .map((line) => {
        if (body(line).trim() === '') return line;
        const indent = line.length - line.trimStart().length;
        const rest = line.slice(indent);
        const mark = rest.startsWith(MARK) ? MARK.length : 1;
        // the one blank that was put behind the mark goes with it
        const cut = rest[mark] === ' ' ? mark + 1 : mark;
        return line.slice(0, indent) + rest.slice(cut);
      })
      .join('\n');
  }
  const indent = Math.min(...filled.map((line) => line.length - line.trimStart().length));
  return lines
    .map((line) =>
      body(line).trim() === '' ? line : `${line.slice(0, indent)}${MARK} ${line.slice(indent)}`,
    )
    .join('\n');
}

/** What the settings dialog formats to show the style. */
export const PREVIEW_SQL =
  "select c.id, c.name, count(o.id) as orders, sum(o.total) as total from customers c left join orders o on o.customer_id = c.id where c.country = 'DE' and o.created_at >= '2026-01-01' and (o.state = 'paid' or o.state = 'shipped') group by c.id, c.name order by total desc; update customers set active = false where last_order < '2020-01-01';";

/** How formatting ended, when it did not fail. */
export type FormatOutcome =
  /** The text was replaced. */
  | 'done'
  /** It is laid out like this already. */
  | 'unchanged'
  /** No editor, no text or nothing under the caret. */
  | 'nothing'
  /** The text was edited while the formatter worked: the result was thrown away. */
  | 'stale'
  /** Another formatting is running. */
  | 'busy';
