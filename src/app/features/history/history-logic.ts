import { HistoryEntry } from '../../core/history/history-api';
import { locale } from '../../core/i18n/i18n';
import { HISTORY_TEXTS } from './history-texts';

/** Entries a page of the list has. */
export const HISTORY_PAGE = 200;

const two = (n: number) => String(n).padStart(2, '0');

/** A moment as the list shows it: the time today, the date and time before. `now` for tests. */
export function whenLabel(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay ? time : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${time}`;
}

/** A duration, short. */
export function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) {
    const digits = ms < 10_000 ? 2 : 1;
    const value = (ms / 1000).toLocaleString(locale(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    return `${value} s`;
  }
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** The start of a statement on one line. */
export function oneLine(text: string, max = 160): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** What the list says about how an entry ended. */
export function outcomeLabel(entry: Pick<HistoryEntry, 'outcome' | 'rows'>): string {
  if (entry.outcome === 'failed') return HISTORY_TEXTS.failed;
  if (entry.outcome === 'cancelled') return HISTORY_TEXTS.cancelled;
  return entry.rows === null ? 'ok' : HISTORY_TEXTS.rows(entry.rows);
}

/**
 * Walking back and forth through earlier statements from the editor (prompt 010). `at` is the place in the
 * list (`-1` = before the first step, the editor as it was); the list is the latest first.
 */
export function recallStep(at: number, step: 1 | -1, count: number): number {
  // back in time is a higher index
  return Math.max(-1, Math.min(count - 1, at + step));
}

/**
 * Whether a recalled statement may replace the text of the editor: only when the editor is empty or still
 * holds what the last recall put there. Typed text is never overwritten.
 */
export function mayRecall(editorText: string, lastRecalled: string | null): boolean {
  const text = editorText.trim();
  return text === '' || (lastRecalled !== null && text === lastRecalled.trim());
}
