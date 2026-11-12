/** The server monitor (prompt 046): order, filter, who blocks whom, figures. Pure. */
import { ServerActivity, ServerFigures, ServerSession } from '../../core/monitor/monitor-api';

/** The columns the sessions can be ordered by. */
export type SortKey = 'id' | 'user' | 'database' | 'application' | 'state' | 'queryMs' | 'txMs';

export interface Sort {
  readonly key: SortKey;
  readonly desc: boolean;
}

/** A statement that runs this long, a transaction that is open this long, is marked. */
export const LONG_QUERY_MS = 60_000;
export const LONG_TX_MS = 5 * 60_000;

const numeric = (key: SortKey) => key === 'queryMs' || key === 'txMs' || key === 'id';

/** The sessions in an order; what has no value (no statement, no transaction) comes last. */
export function sorted(sessions: readonly ServerSession[], sort: Sort): ServerSession[] {
  const value = (s: ServerSession): number | string | null => {
    if (sort.key === 'id') {
      const n = Number(s.id);
      return Number.isFinite(n) ? n : s.id;
    }
    return s[sort.key];
  };
  return [...sessions].sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const order =
      numeric(sort.key) && typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y), undefined, { sensitivity: 'base' });
    return sort.desc ? -order : order;
  });
}

/** A click on a column head: that column, the other way round when it is the order already. */
export function toggled(sort: Sort, key: SortKey): Sort {
  if (sort.key !== key) return { key, desc: numeric(key) && key !== 'id' };
  return { key, desc: !sort.desc };
}

/** The sessions that hold `text` anywhere (case does not matter); with `activeOnly` only those that do something. */
export function filtered(
  sessions: readonly ServerSession[],
  text: string,
  activeOnly: boolean,
): ServerSession[] {
  const needle = text.trim().toLowerCase();
  return sessions.filter((s) => {
    if (activeOnly && s.queryMs === null && s.txMs === null && s.blockedBy.length === 0) {
      return false;
    }
    if (needle === '') return true;
    return [s.id, s.user, s.database, s.application, s.client, s.state, s.wait, s.statement].some(
      (v) => v.toLowerCase().includes(needle),
    );
  });
}

/** A session in the tree of who blocks whom. */
export interface BlockNode {
  readonly session: ServerSession;
  /** The sessions that wait for it. */
  readonly waiting: readonly BlockNode[];
}

/**
 * Who blocks whom: at the top the sessions that hold others up and wait for nobody, below each the ones
 * that wait for it. A circle of waiting (a deadlock the server has not broken yet) is cut where it closes.
 */
export function blockTree(sessions: readonly ServerSession[]): BlockNode[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const waiting = new Map<string, ServerSession[]>();
  for (const s of sessions) {
    for (const blocker of s.blockedBy) {
      if (!byId.has(blocker)) continue;
      waiting.set(blocker, [...(waiting.get(blocker) ?? []), s]);
    }
  }
  const node = (s: ServerSession, path: ReadonlySet<string>): BlockNode => ({
    session: s,
    waiting: (waiting.get(s.id) ?? [])
      .filter((w) => !path.has(w.id))
      .map((w) => node(w, new Set([...path, w.id]))),
  });
  const blockers = sessions.filter((s) => waiting.has(s.id));
  // roots wait for nobody we know; if every blocker waits (a circle), the first one stands for it
  const roots = blockers.filter((s) => !s.blockedBy.some((b) => byId.has(b)));
  const tops = roots.length > 0 || blockers.length === 0 ? roots : [blockers[0]];
  return tops.map((s) => node(s, new Set([s.id])));
}

/** How many sessions wait for another one. */
export const blockedCount = (sessions: readonly ServerSession[]) =>
  sessions.filter((s) => s.blockedBy.length > 0).length;

/** Whether a session is marked: it waits, its statement runs long, or its transaction is open long. */
export function mark(s: ServerSession): 'blocked' | 'long' | null {
  if (s.blockedBy.length > 0) return 'blocked';
  if ((s.queryMs ?? 0) >= LONG_QUERY_MS || (s.txMs ?? 0) >= LONG_TX_MS) return 'long';
  return null;
}

/** `850 ms`, `12 s`, `3 min 4 s`, `2 h 5 min`. */
export function durationText(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`;
}

/** `1.5 MB`. */
export function bytesText(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unit]}`;
}

/** A reading with the time it was taken. */
export interface Reading {
  readonly at: number;
  readonly figures: ServerFigures;
}

/** Transactions per second between two readings; `null` when there is no telling (one reading, a restart). */
export function transactionRate(before: Reading | null, now: Reading): number | null {
  const a = before?.figures.transactions ?? null;
  const b = now.figures.transactions;
  if (!before || a === null || b === null) return null;
  const seconds = (now.at - before.at) / 1000;
  if (seconds <= 0 || b < a) return null;
  return (b - a) / seconds;
}

/** The first line of a statement, short, for a row of the table. */
export function firstLine(statement: string, chars = 120): string {
  const line = statement.replace(/\s+/g, ' ').trim();
  return line.length > chars ? `${line.slice(0, chars)}…` : line;
}

/** The session that is selected, as far as it is still there. */
export function stillThere(
  activity: ServerActivity | null,
  id: string | null,
): ServerSession | null {
  return (id !== null && activity?.sessions.find((s) => s.id === id)) || null;
}

/** The refresh intervals offered, in seconds; 0 = by hand. */
export const INTERVALS = [0, 1, 2, 5, 10, 30] as const;
