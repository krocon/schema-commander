import { ImportItem, ImportPick, ImportSource } from '../../core/connections/connection.models';

/** The sources in the order of the dialog; `file`: the user picks the file. */
export const IMPORT_SOURCES: readonly {
  id: ImportSource;
  label: string;
  /** `pick`: always chosen by the user; `usual`: a usual place exists, another file can be chosen. */
  file: 'none' | 'usual' | 'pick';
  hint: string;
}[] = [
  {
    id: 'pgpass',
    label: '~/.pgpass (PostgreSQL)',
    file: 'usual',
    hint: 'Passwörter stehen dort im Klartext und lassen sich mitnehmen.',
  },
  { id: 'pg-service', label: '~/.pg_service.conf (PostgreSQL)', file: 'usual', hint: '' },
  { id: 'my-cnf', label: '~/.my.cnf (MySQL, MariaDB)', file: 'usual', hint: '' },
  {
    id: 'dbeaver',
    label: 'DBeaver (data-sources.json)',
    file: 'usual',
    hint: 'Benutzer und Passwörter verschlüsselt DBeaver getrennt; sie werden nicht gelesen.',
  },
  {
    id: 'datagrip',
    label: 'DataGrip / JetBrains (dataSources.xml)',
    file: 'pick',
    hint: 'Liegt im Ordner .idea eines Projekts; Passwörter hält die IDE im Schlüsselbund.',
  },
  {
    id: 'environment',
    label: 'Umgebungsvariablen (PG*, MYSQL_*)',
    file: 'none',
    hint: 'So, wie die App gestartet wurde.',
  },
  {
    id: 'own',
    label: 'Export von Schema Commander',
    file: 'pick',
    hint: 'Enthält nie Passwörter.',
  },
];

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
  if (items.length === 0) return 'Dort steht keine Verbindung, die sich übernehmen lässt.';
  const picks = picksOf(items, ticks);
  const broken = items.filter((i) => i.problem !== null).length;
  const parts = [`${picks.length} von ${items.length} ausgewählt`];
  const withPassword = picks.filter((p) => p.withPassword).length;
  if (withPassword > 0) parts.push(`${withPassword} mit Passwort (in den Schlüsselbund)`);
  if (broken > 0) parts.push(`${broken} unvollständig`);
  return parts.join(' · ');
}

/** A German sentence for what is missing in a found connection. */
export function problemText(problem: string): string {
  if (problem.includes('user')) return 'Der Benutzer fehlt – nach dem Anlegen im Dialog ergänzen.';
  if (problem.includes('host')) return 'Der Host fehlt.';
  if (problem.includes('path')) return 'Der Pfad der Datei fehlt.';
  return problem;
}

/** Whether a dropped file is a database file (SQLite) rather than an SQL script. */
export function isDatabaseFile(path: string): boolean {
  return /\.(db|db3|sqlite|sqlite3)$/i.test(path);
}
