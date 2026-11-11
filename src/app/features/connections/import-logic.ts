import { ImportItem, ImportPick, ImportSource } from '../../core/connections/connection.models';
import { IMPORT_TEXTS } from './import-texts';

/** `pick`: always chosen by the user; `usual`: a usual place exists, another file can be chosen. */
type SourceFile = 'none' | 'usual' | 'pick';

const SOURCE_FILES: readonly (readonly [ImportSource, SourceFile])[] = [
  ['pgpass', 'usual'],
  ['pg-service', 'usual'],
  ['my-cnf', 'usual'],
  ['dbeaver', 'usual'],
  ['datagrip', 'pick'],
  ['environment', 'none'],
  ['own', 'pick'],
];

/**
 * The sources in the order of the dialog. `label` and `hint` are read from the catalog whenever they are
 * asked for, so they follow the language.
 */
export const IMPORT_SOURCES: readonly {
  readonly id: ImportSource;
  readonly label: string;
  readonly file: SourceFile;
  readonly hint: string;
}[] = SOURCE_FILES.map(([id, file]) => ({
  id,
  file,
  get label() {
    return IMPORT_TEXTS.sources[id].label;
  },
  get hint() {
    return IMPORT_TEXTS.sources[id].hint;
  },
}));

/** What the user ticked for one found connection. */
export interface Tick {
  readonly take: boolean;
  readonly withPassword: boolean;
}

/** The ticks a fresh preview starts with: everything that can be stored, no password. */
export function initialTicks(items: readonly ImportItem[]): Tick[] {
  return items.map((item) => ({ take: item.problem === null, withPassword: false }));
}

/** The picks the backend gets: what is ticked and can be stored. */
export function picksOf(items: readonly ImportItem[], ticks: readonly Tick[]): ImportPick[] {
  return items
    .filter((item, i) => item.problem === null && ticks[i]?.take)
    .map((item) => ({
      index: item.index,
      withPassword: item.hasPassword && (ticks[items.indexOf(item)]?.withPassword ?? false),
    }));
}

/** What the preview says below the list. */
export function importSummary(items: readonly ImportItem[], ticks: readonly Tick[]): string {
  if (items.length === 0) return IMPORT_TEXTS.nothingThere;
  const picks = picksOf(items, ticks);
  const broken = items.filter((i) => i.problem !== null).length;
  const parts = [IMPORT_TEXTS.selected(picks.length, items.length)];
  const withPassword = picks.filter((p) => p.withPassword).length;
  if (withPassword > 0) parts.push(IMPORT_TEXTS.withPassword(withPassword));
  if (broken > 0) parts.push(IMPORT_TEXTS.incomplete(broken));
  return parts.join(' · ');
}

/** A sentence for what is missing in a found connection. */
export function problemText(problem: string): string {
  if (problem.includes('user')) return IMPORT_TEXTS.userMissing;
  if (problem.includes('host')) return IMPORT_TEXTS.hostMissing;
  if (problem.includes('path')) return IMPORT_TEXTS.pathMissing;
  return problem;
}

/** Whether a dropped file is a database file (SQLite) rather than an SQL script. */
export function isDatabaseFile(path: string): boolean {
  return /\.(db|db3|sqlite|sqlite3)$/i.test(path);
}
