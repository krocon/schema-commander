import { FormatStyle } from '../../core/format/format-api';
import { Settings } from '../../core/settings/settings.models';

export { type EdPlace, offsetAt, placeIn } from '../../core/text/places';

/**
 * What formatting needs around the formatter itself (prompt 023; the formatter is `src-tauri/src/format.rs`):
 * the style from the settings, and where the caret stands after formatting. Pure.
 */

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
