/**
 * Places in the editor and offsets in a JavaScript string. They count differently: `<editlicious-editor>`
 * counts the columns of a line in **code points** (an emoji is one column), a string counts UTF-16 units (an
 * emoji is two). Everything that turns one into the other goes through these two functions. Pure.
 */

/** A position as the editor counts: line and column from 1, the column in code points (an emoji is one). */
export interface EdPlace {
  readonly line: number;
  readonly ch: number;
}

/** Characters as the editor counts them: a surrogate pair is one. No array – a line can be megabytes. */
export function codePoints(text: string): number {
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
