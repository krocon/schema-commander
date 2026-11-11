/** Pure logic of the query tabs (prompt 004): titles, ids, order. */

export const MAX_TITLE = 40;
const UNTITLED = 'Abfrage';

/** `tab-<n>`: the smallest number not taken. */
export function newTabId(taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const id = `tab-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** `Abfrage`, `Abfrage 2` …: the first one no open tab has. */
export function untitled(taken: ReadonlySet<string>): string {
  if (!taken.has(UNTITLED)) return UNTITLED;
  for (let n = 2; ; n++) {
    const title = `${UNTITLED} ${n}`;
    if (!taken.has(title)) return title;
  }
}

/** Looked at for a title: more would only cost time in a huge script. */
const HEAD_CHARS = 4000;

/**
 * A title from the text of a tab: the table of its first statement (`SELECT … FROM orders` → `orders`),
 * else the beginning of the first line that is no comment; `null` for an empty text.
 */
export function autoTitle(text: string): string | null {
  const head = text
    .slice(0, HEAD_CHARS)
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ')
    .replace(/--[^\n]*/g, ' ');
  const first = head.split(';')[0].trim();
  if (!first) return null;
  const table =
    /\b(?:from|into|update|table(?:\s+if\s+(?:not\s+)?exists)?|join)\s+((?:[`"[]?[\p{L}_][\p{L}\p{N}_$]*[`"\]]?\.)*[`"[]?[\p{L}_][\p{L}\p{N}_$]*[`"\]]?)/iu.exec(
      first,
    );
  if (table && !/^(select|set|values|only)$/i.test(table[1])) {
    return cut(table[1].replace(/[`"[\]]/g, ''));
  }
  return cut(first.split('\n')[0].replace(/\s+/g, ' '));
}

function cut(text: string): string {
  const chars = [...text];
  return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE - 1).join('')}…` : text;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/** A title typed by the user: one line, bounded; `null` when nothing is left. */
export function cleanTitle(raw: string): string | null {
  const one = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return [...one].slice(0, 100).join('');
}

/** The name of a file from its path (paths are opaque otherwise: both separators are tried). */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** `list` with the item at `from` moved to `to`. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

/** The index to activate after the tab at `index` of `count` tabs is closed: its right neighbour, else its left. */
export function neighbour(index: number, count: number): number {
  if (count <= 1) return -1;
  return index < count - 1 ? index + 1 : index - 1;
}

/** The tab `step` away, around the ends. */
export function cycled(index: number, count: number, step: 1 | -1): number {
  return count === 0 ? -1 : (index + step + count) % count;
}

/** How long to wait after the last change before the text is backed up: longer for huge texts. */
export function backupDelay(chars: number): number {
  if (chars > 50_000_000) return 30_000;
  if (chars > 5_000_000) return 8_000;
  return 1_200;
}

const ENCODINGS: Readonly<Record<string, string>> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 mit BOM',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'windows-1252': 'Windows-1252',
};

export function encodingLabel(encoding: string | null): string {
  return encoding ? (ENCODINGS[encoding] ?? encoding) : '';
}
