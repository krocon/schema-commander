import { placeIn } from '../text/places';
import { ErrorDetails } from './app-error';

/**
 * Where a failed statement is marked in the editor (prompt 022): from what the database said – a position
 * in characters (PostgreSQL, SQLite), a line and the text it stumbled over (MySQL), a line and a quoted
 * name (SQL Server) – to lines and columns of the editor. Pure; the cases are in `error-position.cases.json`.
 *
 * Two ways of counting meet here: the databases and the editor count characters (an emoji is one),
 * JavaScript counts UTF-16 units (an emoji is two) – and a statement starts somewhere in the middle of a
 * script.
 */
export interface Place {
  /** From 1. */
  readonly line: number;
  /** From 1, in characters (code points) – as the editor counts. */
  readonly ch: number;
}

export interface Span {
  /** Offsets into the statement, in UTF-16 units; `to` is behind the last one. */
  readonly from: number;
  readonly to: number;
  /** The database named the place; `false` = the whole statement is meant. */
  readonly exact: boolean;
}

const WORD = /[\p{L}\p{N}_$@#]/u;

/** The offset (UTF-16) of the `n`-th character (from 1); the end of the text when there are fewer. */
export function offsetOfCharacter(text: string, n: number): number {
  let offset = 0;
  let seen = 1;
  for (const ch of text) {
    if (seen >= n) break;
    offset += ch.length;
    seen++;
  }
  return Math.min(offset, text.length);
}

/** The token that starts at `from`: a word, a quoted name or string, else one character. */
function tokenEnd(text: string, from: number): number {
  const first = String.fromCodePoint(text.codePointAt(from) ?? 32);
  if (WORD.test(first)) {
    let to = from;
    while (to < text.length) {
      const ch = String.fromCodePoint(text.codePointAt(to)!);
      if (!WORD.test(ch)) break;
      to += ch.length;
    }
    return to;
  }
  const close = { '"': '"', "'": "'", '`': '`', '[': ']' }[first];
  if (close) {
    const end = text.indexOf(close, from + 1);
    if (end > from && !text.slice(from, end).includes('\n')) return end + 1;
  }
  return Math.min(text.length, from + first.length);
}

/** Where line `n` (from 1) of a text starts and ends (without its line break). */
function lineSpan(text: string, n: number): { from: number; to: number } | null {
  let from = 0;
  for (let line = 1; line < n; line++) {
    const eol = text.indexOf('\n', from);
    if (eol < 0) return null;
    from = eol + 1;
  }
  const eol = text.indexOf('\n', from);
  let to = eol < 0 ? text.length : eol;
  if (text[to - 1] === '\r') to--;
  return { from, to };
}

/** A span without the blanks around it; `null` when nothing is left. */
function trimmed(text: string, from: number, to: number): { from: number; to: number } | null {
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return to > from ? { from, to } : null;
}

/** The part of a statement an error means. */
export function errorSpan(statement: string, details: ErrorDetails | null | undefined): Span {
  const whole = (): Span => {
    const all = trimmed(statement, 0, statement.length) ?? { from: 0, to: statement.length };
    return { ...all, exact: false };
  };
  if (!details) return whole();
  // a position in characters: the token that starts there
  if (details.position && details.position > 0) {
    const from = offsetOfCharacter(statement, details.position);
    if (from >= statement.length) {
      // behind the end (an unfinished statement): its last token
      const all = trimmed(statement, 0, statement.length);
      if (!all) return whole();
      let start = all.to;
      while (start > all.from && !/\s/.test(statement[start - 1])) start--;
      return { from: start, to: all.to, exact: true };
    }
    return { from, to: tokenEnd(statement, from), exact: true };
  }
  const line = details.line && details.line > 0 ? lineSpan(statement, details.line) : null;
  const near = details.near?.trim();
  if (near) {
    // the text the database quoted: on its line first, then behind it, then anywhere – as it is written,
    // then without regard to case (SQL Server quotes names as it knows them)
    const hay = statement.toLowerCase();
    const needles = [near, near.split(/\s+/)[0]].filter((n) => n.length > 0);
    for (const needle of needles) {
      const starts = [line?.from ?? 0, 0];
      for (const start of starts) {
        let at = statement.indexOf(needle, start);
        if (at < 0) at = hay.indexOf(needle.toLowerCase(), start);
        if (at >= 0 && (!line || start === 0 || at <= line.to)) {
          // of a longer quote (MySQL: up to 80 characters) the first token is the culprit
          const to = needle.includes(' ') ? tokenEnd(statement, at) : at + needle.length;
          return { from: at, to: Math.max(to, at + 1), exact: true };
        }
      }
    }
  }
  if (line) {
    const span = trimmed(statement, line.from, line.to);
    if (span) return { ...span, exact: true };
  }
  return whole();
}

/** An offset of a statement as a place of the editor; `start` is where the statement begins there. */
export function placeOf(statement: string, start: Place, offset: number): Place {
  return placeIn(statement, offset, start);
}

/** The range of the editor to mark for a failed statement that starts at `start`. */
export function errorRange(
  statement: string,
  start: Place,
  details: ErrorDetails | null | undefined,
): { start: Place; end: Place; exact: boolean } {
  const span = errorSpan(statement, details);
  return {
    start: placeOf(statement, start, span.from),
    end: placeOf(statement, start, span.to),
    exact: span.exact,
  };
}
